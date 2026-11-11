// オンライン対戦ゲーム共通のサーバー側ルーム基盤（サーバー専用）。
// lib/balku-server.ts の流儀をゲーム非依存に一般化したもの。
// 状態の正本は Bot API 経由の bot_kv（namespace "online_rooms"、キーは
// ルームコード、レコードに gameId を持つ）に保持する。読み込みは初回に
// kvList で一括して行い、以後の処理はメモリ上の状態で完結させる。
// 変更系の操作は promise chain で直列化し、revision を単調増加させる。
// 変更のたびに直列チェーンの中で kvSet を await してから応答し、
// SSE 購読者へ閲覧者別のビュー（module.viewFor 適用済み）を publish する。
// BOT API が未設定の環境ではメモリのみで動作する。
import { randomBytes } from "node:crypto";
import { isBotApiConfigured, kvDelete, kvList, kvSet } from "../bot-api";
import { getOnlineGame } from "./registry";
import type { OnlineGameModule, SeatInfo } from "./types";

// registry の参照を server 経由でも引けるようにしておく（利用側の利便用）。
export { getOnlineGame, ONLINE_GAMES } from "./registry";

export class OnlineRoomError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type OnlinePlayerRecord = { token: string; seat: number; name: string; isHost: boolean; isCpu?: boolean };

/** ルーム内チャットの1件。playerId は発言時点の seat。 */
export type OnlineChatMessage = { id: string; playerId: number; name: string; text: string; at: number };

export type OnlineRoomRecord = {
  code: string;
  gameId: string;
  maxPlayers: number;
  isPublic: boolean;
  revision: number;
  createdAt: number;
  updatedAt: number;
  players: OnlinePlayerRecord[];
  gameState: unknown | null;
  options: Record<string, unknown>;
  chat: OnlineChatMessage[];
  /** 次に CPU が1手進めてよい時刻（未予約は null）。 */
  cpuDueAt: number | null;
};

export type OnlineRoomView = {
  code: string;
  gameId: string;
  status: string;
  revision: number;
  maxPlayers: number;
  minPlayers: number;
  cpuSupported: boolean;
  chatEnabled: boolean;
  player: { seat: number; displayName: string; isHost: boolean };
  players: { seat: number; name: string; isHost: boolean; isCpu: boolean }[];
  state: unknown;
  chat: OnlineChatMessage[];
  cpuSeats: number[];
};

const NAMESPACE = "online_rooms";
const ROOM_TTL_MS = 24 * 60 * 60 * 1000;
const CHAT_KEEP = 100;
const CHAT_VIEW = 50;
const CHAT_MAX_LENGTH = 200;
/** CPU が1手進める間隔（約0.9〜1.5秒）。人間に動きが見える速さにする。 */
const CPU_DELAY_MIN_MS = 900;
const CPU_DELAY_SPREAD_MS = 600;
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

// --- メモリ上の状態と非同期の永続化 ---

let rooms: Map<string, OnlineRoomRecord> | null = null;
let loadPromise: Promise<void> | null = null;
let chain: Promise<unknown> = Promise.resolve();

function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function isRoomRecord(value: unknown): value is OnlineRoomRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<OnlineRoomRecord>;
  return (
    typeof record.code === "string" &&
    typeof record.gameId === "string" &&
    typeof record.revision === "number" &&
    typeof record.updatedAt === "number" &&
    Array.isArray(record.players) &&
    (record.gameState === null || (typeof record.gameState === "object" && record.gameState !== null))
  );
}

async function ensureLoaded(): Promise<void> {
  if (rooms) return;
  if (!loadPromise) {
    loadPromise = (async () => {
      const map = new Map<string, OnlineRoomRecord>();
      if (isBotApiConfigured()) {
        try {
          const stored = await kvList(NAMESPACE);
          const now = Date.now();
          for (const [key, value] of stored) {
            if (isRoomRecord(value) && now - value.updatedAt <= ROOM_TTL_MS) {
              if (!Array.isArray(value.chat)) value.chat = [];
              if (typeof value.cpuDueAt !== "number") value.cpuDueAt = null;
              if (!value.options || typeof value.options !== "object" || Array.isArray(value.options)) value.options = {};
              if (typeof value.isPublic !== "boolean") value.isPublic = false;
              if (typeof value.createdAt !== "number") value.createdAt = value.updatedAt;
              if (typeof value.maxPlayers !== "number") value.maxPlayers = value.players.length;
              map.set(key, value);
            }
          }
        } catch {
          // 読めなければメモリのみで続行する（ルームはこのプロセス内だけ有効）
        }
      }
      rooms = map;
    })();
  }
  await loadPromise;
}

/** 変更を即座に永続化する。失敗してもメモリ上の状態が正として処理は続ける。 */
async function persistRecord(record: OnlineRoomRecord): Promise<void> {
  if (!isBotApiConfigured()) return;
  try {
    await kvSet(NAMESPACE, record.code, JSON.parse(JSON.stringify(record)) as OnlineRoomRecord);
  } catch {
    // 書けなくても対戦は止めない（メモリ上の状態が正）
  }
}

async function persistDelete(code: string): Promise<void> {
  if (!isBotApiConfigured()) return;
  try {
    await kvDelete(NAMESPACE, code);
  } catch {
    // 削除に失敗してもメモリ上の状態が正
  }
}

// --- SSE 購読管理（ルーム単位。revision 上昇時に publish する） ---

type OnlineSubscriber = { token: string; send: (view: OnlineRoomView) => void };
const subscribers = new Map<string, Set<OnlineSubscriber>>();

function publishRoom(record: OnlineRoomRecord): void {
  const set = subscribers.get(record.code);
  if (!set || set.size === 0) return;
  for (const sub of [...set]) {
    const player = record.players.find((p) => p.token === sub.token);
    if (!player) {
      set.delete(sub);
      continue;
    }
    try {
      sub.send(toView(record, player));
    } catch {
      set.delete(sub);
    }
  }
  if (set.size === 0) subscribers.delete(record.code);
}

/** テスト・診断用: そのルームの現在の購読者数。 */
export function onlineSubscriberCount(code: string): number {
  return subscribers.get(code)?.size ?? 0;
}

// --- ルーム内部の共通処理 ---

async function sweepExpired(): Promise<void> {
  if (!rooms) return;
  const now = Date.now();
  for (const [code, record] of rooms) {
    if (now - record.updatedAt > ROOM_TTL_MS) {
      rooms.delete(code);
      await persistDelete(code);
    }
  }
}

function requireGame(gameId: string): OnlineGameModule {
  const game = getOnlineGame(gameId);
  if (!game) throw new OnlineRoomError(404, "ゲームが見つかりません。");
  return game;
}

function requireRoom(gameId: string, code: string): OnlineRoomRecord {
  if (!rooms) throw new OnlineRoomError(404, "ルームが見つかりません。");
  const record = rooms.get(code);
  if (!record || record.gameId !== gameId || Date.now() - record.updatedAt > ROOM_TTL_MS) {
    if (record && Date.now() - record.updatedAt > ROOM_TTL_MS) {
      rooms.delete(code);
      void persistDelete(code);
    }
    throw new OnlineRoomError(404, "ルームが見つかりません。");
  }
  return record;
}

function requirePlayer(record: OnlineRoomRecord, token: string): OnlinePlayerRecord {
  const player = record.players.find((p) => p.token === token);
  if (!player) throw new OnlineRoomError(403, "このルームの参加権限がありません。");
  return player;
}

/** 状態を差し替え、revision を上げ、永続化してから購読者へ publish する。 */
async function applyChange(record: OnlineRoomRecord, nextState: unknown | null): Promise<void> {
  record.gameState = nextState;
  record.revision += 1;
  record.updatedAt = Date.now();
  await persistRecord(record);
  publishRoom(record);
}

function newPlayerToken(): string {
  return randomBytes(24).toString("base64url");
}

function newRoomCode(): string {
  const bytes = randomBytes(6);
  let code = "";
  for (let i = 0; i < 6; i += 1) code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return code;
}

function nextCpuName(usedNames: readonly string[]): string {
  let n = 1;
  while (usedNames.includes(`CPU ${n}`)) n += 1;
  return `CPU ${n}`;
}

function toView(record: OnlineRoomRecord, player: OnlinePlayerRecord): OnlineRoomView {
  const game = getOnlineGame(record.gameId);
  const isLobby = record.gameState === null;
  return {
    code: record.code,
    gameId: record.gameId,
    status: isLobby ? "lobby" : game ? game.phaseOf(record.gameState) : "unknown",
    revision: record.revision,
    maxPlayers: record.maxPlayers,
    minPlayers: game ? game.minPlayers : record.players.length,
    cpuSupported: game ? game.cpuSupported : false,
    chatEnabled: game ? game.chatEnabled : false,
    player: { seat: player.seat, displayName: player.name, isHost: player.isHost },
    players: [...record.players]
      .sort((a, b) => a.seat - b.seat)
      .map((p) => ({ seat: p.seat, name: p.name, isHost: p.isHost, isCpu: !!p.isCpu })),
    state: isLobby ? null : game ? game.viewFor(record.gameState, player.seat) : null,
    chat: Array.isArray(record.chat) ? record.chat.slice(-CHAT_VIEW) : [],
    cpuSeats: record.players
      .filter((p) => p.isCpu)
      .map((p) => p.seat)
      .sort((a, b) => a - b),
  };
}

// --- 進行処理（tick＋CPU） ---

function hasHumanSeated(record: OnlineRoomRecord): boolean {
  return record.players.some((p) => !p.isCpu);
}

function cpuDelayMs(): number {
  return CPU_DELAY_MIN_MS + Math.floor(Math.random() * CPU_DELAY_SPREAD_MS);
}

type CpuStep = { seat: number; next: unknown };

/**
 * CPU が今すぐ適用できる1手を探す。cpuAction が返した手を
 * applyAction で試行し、成功するものだけを本当の手とみなす
 * （手番でない seat への問い合わせで module が手を返してしまっても、
 * 試行が失敗すればその seat は「手なし」として扱い、誤動作しない）。
 * module の関数は純粋関数前提なので試行に副作用はない。
 */
function findCpuStep(record: OnlineRoomRecord, game: OnlineGameModule): CpuStep | null {
  if (!game.cpuSupported || !game.cpuAction || record.gameState === null) return null;
  if (game.isFinished(record.gameState)) return null;
  const cpuSeats = record.players
    .filter((p) => p.isCpu)
    .map((p) => p.seat)
    .sort((a, b) => a - b);
  for (const seat of cpuSeats) {
    let action: unknown;
    try {
      action = game.cpuAction(record.gameState, seat, Math.random);
    } catch {
      continue;
    }
    if (action === null || action === undefined) continue;
    try {
      const next = game.applyAction(record.gameState, seat, action, Math.random);
      return { seat, next };
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * CPU の手を進める。手が要る状況なら cpuDueAt を予約し、予約時刻を
 * 過ぎていたら（または force なら）1手だけ適用して revision を上げ
 * publish する。まだ CPU の手が残れば再予約する。
 * 人間の着席者が0人のルームでは進めない（掃除は24時間 TTL に任せる）。
 */
async function progressCpu(record: OnlineRoomRecord, force: boolean): Promise<void> {
  const game = getOnlineGame(record.gameId);
  if (!game || record.gameState === null || !hasHumanSeated(record)) {
    record.cpuDueAt = null;
    return;
  }
  const step = findCpuStep(record, game);
  if (!step) {
    record.cpuDueAt = null;
    return;
  }
  if (record.cpuDueAt == null) {
    record.cpuDueAt = Date.now() + cpuDelayMs();
    if (!force) return;
  }
  if (!force && Date.now() < record.cpuDueAt) return;
  record.cpuDueAt = null;
  await applyChange(record, step.next);
  // 適用後にまだ CPU の手が残っていれば次の1手を予約する
  if (record.gameState !== null && hasHumanSeated(record) && findCpuStep(record, game)) {
    record.cpuDueAt = Date.now() + cpuDelayMs();
  }
}

/**
 * ルーム読み取り/変更のたびに呼ばれる進行処理。tick（時間進行）を
 * 適用し、続けて CPU の手も進める。tick が同一参照を返したら変化なし。
 */
async function progressRoom(record: OnlineRoomRecord, forceCpu: boolean): Promise<void> {
  const game = getOnlineGame(record.gameId);
  if (game && record.gameState !== null && game.tick) {
    let next: unknown;
    try {
      next = game.tick(record.gameState, Date.now());
    } catch {
      next = record.gameState;
    }
    if (next !== record.gameState) await applyChange(record, next);
  }
  await progressCpu(record, forceCpu);
}

// --- ルーム操作（すべて直列化される） ---

export async function createOnlineRoom(
  gameId: string,
  input: { displayName: string; maxPlayers?: number; isPublic?: boolean; options?: Record<string, unknown> },
): Promise<{ code: string; playerToken: string }> {
  const game = requireGame(gameId);
  return serialize(async () => {
    await ensureLoaded();
    await sweepExpired();
    const maxPlayers = input.maxPlayers ?? game.maxPlayers;
    if (!Number.isInteger(maxPlayers) || maxPlayers < game.minPlayers || maxPlayers > game.maxPlayers) {
      throw new OnlineRoomError(400, `人数は${game.minPlayers}〜${game.maxPlayers}人です。`);
    }
    let options: Record<string, unknown> = {};
    if (input.options && typeof input.options === "object" && !Array.isArray(input.options)) {
      if (game.parseOptions) {
        try {
          options = game.parseOptions(input.options);
        } catch (error) {
          throw new OnlineRoomError(400, error instanceof Error ? error.message : "オプションが正しくありません。");
        }
        if (!options || typeof options !== "object" || Array.isArray(options)) options = {};
      } else {
        options = { ...input.options };
      }
    }
    let code = newRoomCode();
    for (let attempt = 0; attempt < 20 && rooms!.has(code); attempt += 1) code = newRoomCode();
    if (rooms!.has(code)) throw new OnlineRoomError(503, "ルームを作成できませんでした。もう一度お試しください。");
    const playerToken = newPlayerToken();
    const now = Date.now();
    const record: OnlineRoomRecord = {
      code,
      gameId,
      maxPlayers,
      isPublic: input.isPublic ?? true,
      revision: 1,
      createdAt: now,
      updatedAt: now,
      players: [{ token: playerToken, seat: 0, name: input.displayName, isHost: true }],
      gameState: null,
      options,
      chat: [],
      cpuDueAt: null,
    };
    rooms!.set(code, record);
    await persistRecord(record);
    return { code, playerToken };
  });
}

export async function joinOnlineRoom(
  gameId: string,
  input: { code: string; displayName: string },
): Promise<{ code: string; playerToken: string }> {
  requireGame(gameId);
  return serialize(async () => {
    await ensureLoaded();
    const record = requireRoom(gameId, input.code);
    if (record.gameState !== null) throw new OnlineRoomError(400, "すでに開始されています。");
    if (record.players.length >= record.maxPlayers) throw new OnlineRoomError(400, "満席です。");
    const playerToken = newPlayerToken();
    const seat = record.players.length;
    record.players.push({ token: playerToken, seat, name: input.displayName, isHost: false });
    await applyChange(record, record.gameState);
    return { code: record.code, playerToken };
  });
}

export async function listPublicOnlineRooms(
  gameId: string,
): Promise<{ code: string; gameId: string; maxPlayers: number; playerCount: number; createdAt: number }[]> {
  requireGame(gameId);
  return serialize(async () => {
    await ensureLoaded();
    await sweepExpired();
    if (!rooms) return [];
    return [...rooms.values()]
      .filter((record) => record.gameId === gameId && record.isPublic && record.gameState === null)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((record) => ({
        code: record.code,
        gameId: record.gameId,
        maxPlayers: record.maxPlayers,
        playerCount: record.players.length,
        createdAt: record.createdAt,
      }));
  });
}

/** 取得時に進行処理（tick・CPU）を適用し、変わっていたら保存する。 */
export async function getOnlineRoom(gameId: string, code: string, playerToken: string): Promise<OnlineRoomView> {
  requireGame(gameId);
  return serialize(async () => {
    await ensureLoaded();
    const record = requireRoom(gameId, code);
    const player = requirePlayer(record, playerToken);
    await progressRoom(record, false);
    return toView(record, player);
  });
}

/** SSE ハートビート等からの軽い「触る」操作。進行処理だけを回す。 */
export async function touchOnlineRoom(gameId: string, code: string, playerToken: string): Promise<void> {
  requireGame(gameId);
  return serialize(async () => {
    await ensureLoaded();
    const record = requireRoom(gameId, code);
    requirePlayer(record, playerToken);
    await progressRoom(record, false);
  });
}

/** テスト用: CPU の1手を予約時刻を待たずに即時進める。 */
export async function forceOnlineCpuStep(gameId: string, code: string, playerToken: string): Promise<void> {
  requireGame(gameId);
  return serialize(async () => {
    await ensureLoaded();
    const record = requireRoom(gameId, code);
    requirePlayer(record, playerToken);
    await progressRoom(record, true);
  });
}

/**
 * SSE 用の購読登録。進行処理を適用したうえで現在のビューを返し、
 * 以後の revision 上昇は send へ publish される。切断時は必ず
 * 返り値の unsubscribe を呼ぶこと。
 */
export async function subscribeOnlineRoom(
  gameId: string,
  code: string,
  playerToken: string,
  send: (view: OnlineRoomView) => void,
): Promise<{ view: OnlineRoomView; unsubscribe: () => void }> {
  requireGame(gameId);
  return serialize(async () => {
    await ensureLoaded();
    const record = requireRoom(gameId, code);
    const player = requirePlayer(record, playerToken);
    await progressRoom(record, false);
    const subscriber: OnlineSubscriber = { token: playerToken, send };
    let set = subscribers.get(code);
    if (!set) {
      set = new Set();
      subscribers.set(code, set);
    }
    set.add(subscriber);
    const unsubscribe = () => {
      const current = subscribers.get(code);
      if (current) {
        current.delete(subscriber);
        if (current.size === 0) subscribers.delete(code);
      }
    };
    return { view: toView(record, player), unsubscribe };
  });
}

export async function startOnlineGame(
  gameId: string,
  code: string,
  playerToken: string,
  expectedRevision: number,
): Promise<{ success: true; revision: number }> {
  const game = requireGame(gameId);
  return serialize(async () => {
    await ensureLoaded();
    const record = requireRoom(gameId, code);
    const player = requirePlayer(record, playerToken);
    if (!player.isHost) throw new OnlineRoomError(403, "対戦を開始できるのはルーム作成者だけです。");
    if (record.revision !== expectedRevision) throw new OnlineRoomError(409, "最新の参加状況を確認してください。");
    if (record.gameState !== null) throw new OnlineRoomError(400, "すでに開始されています。");
    if (record.players.length < game.minPlayers) {
      throw new OnlineRoomError(400, `対戦開始には${game.minPlayers}人以上が必要です。`);
    }
    const seatInfos: SeatInfo[] = [...record.players]
      .sort((a, b) => a.seat - b.seat)
      .map((p) => ({ seat: p.seat, name: p.name }));
    let next: unknown;
    try {
      next = game.createState(seatInfos, Math.random, record.options ?? {});
    } catch (error) {
      throw new OnlineRoomError(400, error instanceof Error ? error.message : "対戦開始に失敗しました。");
    }
    await applyChange(record, next);
    await progressCpu(record, false);
    return { success: true as const, revision: record.revision };
  });
}

export async function restartOnlineGame(
  gameId: string,
  code: string,
  playerToken: string,
  expectedRevision: number,
): Promise<{ success: true; revision: number }> {
  const game = requireGame(gameId);
  return serialize(async () => {
    await ensureLoaded();
    const record = requireRoom(gameId, code);
    const player = requirePlayer(record, playerToken);
    if (!player.isHost) throw new OnlineRoomError(403, "再戦を準備できるのはルーム作成者だけです。");
    if (record.revision !== expectedRevision) throw new OnlineRoomError(409, "盤面が更新されました。もう一度お試しください。");
    if (record.gameState === null || !game.isFinished(record.gameState)) {
      throw new OnlineRoomError(400, "対戦終了後に再戦を準備できます。");
    }
    record.cpuDueAt = null;
    await applyChange(record, null);
    return { success: true as const, revision: record.revision };
  });
}

export async function leaveOnlineRoom(
  gameId: string,
  code: string,
  playerToken: string,
  expectedRevision: number,
): Promise<{ success: true }> {
  const game = requireGame(gameId);
  return serialize(async () => {
    await ensureLoaded();
    const record = requireRoom(gameId, code);
    const player = requirePlayer(record, playerToken);
    if (record.revision !== expectedRevision) {
      throw new OnlineRoomError(409, "退出処理中に盤面が更新されました。もう一度お試しください。");
    }
    const wasLobby = record.gameState === null;
    const wasFinished = !wasLobby && game.isFinished(record.gameState as unknown);
    let nextState: unknown | null = record.gameState;
    if (!wasLobby && !wasFinished) {
      if (!game.onPlayerLeft) throw new OnlineRoomError(400, "このゲームでは対戦中の退出はできません。");
      try {
        nextState = game.onPlayerLeft(record.gameState as unknown, player.seat);
      } catch (error) {
        throw new OnlineRoomError(400, error instanceof Error ? error.message : "退出できませんでした。");
      }
    }
    const wasHost = player.isHost;
    record.players = record.players.filter((p) => p.token !== playerToken);
    if (record.players.length === 0) {
      rooms!.delete(code);
      subscribers.delete(code);
      await persistDelete(code);
      return { success: true as const };
    }
    if (wasLobby) {
      // ロビー退出では seat を振り直して残りのプレイヤーと同期させる。
      // 対戦中・終了後の退出ではゲーム状態側の seat を壊さないよう振り直さない。
      record.players.sort((a, b) => a.seat - b.seat);
      record.players.forEach((p, i) => {
        p.seat = i;
      });
    }
    if (wasHost && !record.players.some((p) => p.isHost)) {
      const candidates = [...record.players].sort((a, b) => a.seat - b.seat);
      const promoted = candidates.find((p) => !p.isCpu) ?? candidates[0];
      if (promoted) promoted.isHost = true;
    }
    await applyChange(record, nextState);
    await progressCpu(record, false);
    return { success: true as const };
  });
}

export async function applyOnlineMove(
  gameId: string,
  code: string,
  playerToken: string,
  expectedRevision: number,
  rawAction: unknown,
): Promise<{ success: true; revision: number }> {
  const game = requireGame(gameId);
  return serialize(async () => {
    await ensureLoaded();
    const record = requireRoom(gameId, code);
    const player = requirePlayer(record, playerToken);
    if (record.gameState === null) throw new OnlineRoomError(400, "対戦が開始されていません。");
    if (game.isFinished(record.gameState)) throw new OnlineRoomError(400, "対戦は終了しています。");
    const action = game.parseAction(rawAction);
    if (action === null || action === undefined) throw new OnlineRoomError(400, "操作の形式が正しくありません。");
    if (record.revision !== expectedRevision) {
      throw new OnlineRoomError(409, "誰かが先に操作しました。盤面を同期しました。");
    }
    let next: unknown;
    try {
      next = game.applyAction(record.gameState, player.seat, action, Math.random);
    } catch (error) {
      throw new OnlineRoomError(400, error instanceof Error ? error.message : "操作を処理できませんでした。");
    }
    await applyChange(record, next);
    // 次の手が CPU なら予約だけ入れる（実行は進行処理に任せる）
    await progressCpu(record, false);
    return { success: true as const, revision: record.revision };
  });
}

/**
 * ルーム内チャットへ投稿する。chatEnabled が false のゲームでは 400。
 * ゲーム状態は変えないが、revision を上げて永続化＋SSE publish の経路に乗せる。
 * 保持は最新 CHAT_KEEP 件まで（古いものは捨てる）。
 */
export async function postOnlineChat(
  gameId: string,
  code: string,
  playerToken: string,
  rawText: unknown,
): Promise<{ success: true; revision: number; message: OnlineChatMessage }> {
  const game = requireGame(gameId);
  return serialize(async () => {
    await ensureLoaded();
    const record = requireRoom(gameId, code);
    const player = requirePlayer(record, playerToken);
    if (!game.chatEnabled) throw new OnlineRoomError(400, "このゲームではチャットは使えません。");
    if (typeof rawText !== "string") throw new OnlineRoomError(400, "メッセージの形式が正しくありません。");
    const text = rawText.trim();
    if (text.length === 0) throw new OnlineRoomError(400, "メッセージを入力してください。");
    if (text.length > CHAT_MAX_LENGTH) throw new OnlineRoomError(400, `メッセージは${CHAT_MAX_LENGTH}文字以内で入力してください。`);
    const message: OnlineChatMessage = {
      id: `chat-${randomBytes(6).toString("hex")}`,
      playerId: player.seat,
      name: player.name,
      text,
      at: Date.now(),
    };
    record.chat = [...(Array.isArray(record.chat) ? record.chat : []), message].slice(-CHAT_KEEP);
    await applyChange(record, record.gameState);
    return { success: true as const, revision: record.revision, message };
  });
}

/**
 * CPU の追加/削除（ホストのみ・ロビーのみ・cpuSupported のときだけ）。
 * CPU は通常プレイヤーとして players に追加する。トークンは内部専用で
 * 外部へ返さない。
 */
export async function setOnlineCpu(
  gameId: string,
  code: string,
  playerToken: string,
  action: "add" | "remove",
  seat?: number,
): Promise<{ success: true; revision: number }> {
  const game = requireGame(gameId);
  return serialize(async () => {
    await ensureLoaded();
    const record = requireRoom(gameId, code);
    const player = requirePlayer(record, playerToken);
    if (!player.isHost) throw new OnlineRoomError(403, "CPUを操作できるのはルーム作成者だけです。");
    if (!game.cpuSupported) throw new OnlineRoomError(400, "このゲームではCPUは使えません。");
    if (record.gameState !== null) throw new OnlineRoomError(400, "CPUの追加・削除は待機中のみ可能です。");
    if (action === "add") {
      if (record.players.length >= record.maxPlayers) throw new OnlineRoomError(400, "満席です。");
      const name = nextCpuName(record.players.map((p) => p.name));
      const cpuSeat = record.players.length;
      record.players.push({ token: newPlayerToken(), seat: cpuSeat, name, isHost: false, isCpu: true });
      await applyChange(record, record.gameState);
      return { success: true as const, revision: record.revision };
    }
    if (action === "remove") {
      if (seat === undefined) throw new OnlineRoomError(400, "外すCPUの席を指定してください。");
      const target = record.players.find((p) => p.seat === seat);
      if (!target || !target.isCpu) throw new OnlineRoomError(400, "指定された席のCPUが見つかりません。");
      record.players = record.players.filter((p) => p.token !== target.token);
      record.players.sort((a, b) => a.seat - b.seat);
      record.players.forEach((p, i) => {
        p.seat = i;
      });
      await applyChange(record, record.gameState);
      return { success: true as const, revision: record.revision };
    }
    throw new OnlineRoomError(400, "操作の形式が正しくありません。");
  });
}

// --- 入力検証（元の zod スキーマ相当を手書きで。balku-server から同等に移植） ---

function asBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new OnlineRoomError(400, "リクエストの形式が正しくありません。");
  }
  return value as Record<string, unknown>;
}

export function parseDisplayName(value: unknown): string {
  if (typeof value !== "string" || value.trim().length < 2) {
    throw new OnlineRoomError(400, "ユーザー名は2文字以上で入力してください。");
  }
  const name = value.trim();
  if (name.length > 24) throw new OnlineRoomError(400, "ユーザー名は24文字以内です。");
  return name;
}

export function parseRoomCode(value: unknown): string {
  if (typeof value !== "string") throw new OnlineRoomError(400, "ルームコードは6文字です。");
  const code = value.trim().toUpperCase();
  if (!/^[A-Z2-9]{6}$/.test(code)) throw new OnlineRoomError(400, "ルームコードは6文字です。");
  return code;
}

export function parsePlayerToken(value: unknown): string {
  if (typeof value !== "string" || value.length < 16 || value.length > 64) {
    throw new OnlineRoomError(400, "トークンが正しくありません。");
  }
  return value;
}

export function parseExpectedRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new OnlineRoomError(400, "リビジョンが正しくありません。");
  }
  return value;
}

export function parseCreateRoomBody(body: unknown): {
  displayName: string;
  maxPlayers?: number;
  isPublic: boolean;
  options?: Record<string, unknown>;
} {
  const data = asBody(body);
  const displayName = parseDisplayName(data.displayName);
  let maxPlayers: number | undefined;
  if (data.maxPlayers !== undefined) {
    if (typeof data.maxPlayers !== "number" || !Number.isInteger(data.maxPlayers) || data.maxPlayers < 1 || data.maxPlayers > 32) {
      throw new OnlineRoomError(400, "人数が正しくありません。");
    }
    maxPlayers = data.maxPlayers;
  }
  let isPublic = true;
  if (data.isPublic !== undefined) {
    if (typeof data.isPublic !== "boolean") throw new OnlineRoomError(400, "公開設定が正しくありません。");
    isPublic = data.isPublic;
  }
  // options は object のときだけ通す（それ以外は無視する）。範囲検証は
  // ゲームごとの min/max を知る createOnlineRoom / parseOptions 側で行う。
  const options =
    data.options && typeof data.options === "object" && !Array.isArray(data.options)
      ? (data.options as Record<string, unknown>)
      : undefined;
  return {
    displayName,
    ...(maxPlayers !== undefined ? { maxPlayers } : {}),
    isPublic,
    ...(options !== undefined ? { options } : {}),
  };
}

export function parseJoinRoomBody(body: unknown): { code: string; displayName: string } {
  const data = asBody(body);
  return { code: parseRoomCode(data.code), displayName: parseDisplayName(data.displayName) };
}

export function parseTokenRevisionBody(body: unknown): { playerToken: string; expectedRevision: number } {
  const data = asBody(body);
  return { playerToken: parsePlayerToken(data.playerToken), expectedRevision: parseExpectedRevision(data.expectedRevision) };
}

export function parseChatBody(body: unknown): { playerToken: string; text: string } {
  const data = asBody(body);
  if (typeof data.text !== "string") throw new OnlineRoomError(400, "メッセージの形式が正しくありません。");
  return { playerToken: parsePlayerToken(data.playerToken), text: data.text };
}

export function parseCpuBody(body: unknown): { playerToken: string; action: "add" | "remove"; seat?: number } {
  const data = asBody(body);
  if (data.action !== "add" && data.action !== "remove") {
    throw new OnlineRoomError(400, "操作の形式が正しくありません。");
  }
  let seat: number | undefined;
  if (data.seat !== undefined) {
    if (typeof data.seat !== "number" || !Number.isInteger(data.seat) || data.seat < 0 || data.seat > 63) {
      throw new OnlineRoomError(400, "席の指定が正しくありません。");
    }
    seat = data.seat;
  }
  return { playerToken: parsePlayerToken(data.playerToken), action: data.action, ...(seat !== undefined ? { seat } : {}) };
}

export function parseMoveBody(body: unknown): { playerToken: string; expectedRevision: number; action: unknown } {
  const data = asBody(body);
  // action の中身の検証はモジュール側 parseAction に委ねる（raw のまま返す）。
  return {
    playerToken: parsePlayerToken(data.playerToken),
    expectedRevision: parseExpectedRevision(data.expectedRevision),
    action: data.action,
  };
}
