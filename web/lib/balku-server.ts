// BALKU オンライン対戦のサーバー側ストア（サーバー専用）。
// 状態の正本は Bot API 経由の bot_kv（namespace "balku_rooms"、キーは
// ルームコード）に保持する。読み込みは初回に kvList で一括して行い、
// 以後の処理はメモリ上の状態で完結させる。永続化は、接続先がローカル
// SQL で高速なため、変更のたびに直列チェーンの中で kvSet を await
// してから応答する（プロセス再起動時の巻き戻しがほぼ消える）。
// 変更系の操作は promise chain で直列化し、revision を単調増加させる。
// 同期は SSE が主経路: revision が上がるたびに、そのルームの購読者へ
// 閲覧者別のスナップショットを publish する（購読管理はこのモジュール）。
// BOT API が未設定の環境ではメモリのみで動作する（ルームはプロセス内
// でのみ有効で、再起動で消える）。
import { randomBytes } from "node:crypto";
import { isBotApiConfigured, kvDelete, kvList, kvSet } from "./bot-api";
import {
  addLobbyPlayer,
  applyGameAction,
  createLobbyState,
  expireTimedOutTurn,
  removePlayerFromState,
  resetToLobby,
  snapshotFor,
  startGame,
  type BalkuSnapshot,
  type GameAction,
  type MaterialKind,
  type RoomGameState,
} from "./balku-game";

export class BalkuRoomError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type BalkuPlayerRecord = { token: string; seat: number; name: string; isHost: boolean };
export type BalkuRoomRecord = {
  code: string;
  maxPlayers: number;
  isPublic: boolean;
  revision: number;
  createdAt: number;
  updatedAt: number;
  players: BalkuPlayerRecord[];
  state: RoomGameState;
};

export type BalkuRoomView = {
  code: string;
  status: RoomGameState["phase"];
  revision: number;
  maxPlayers: number;
  player: { seat: number; displayName: string; isHost: boolean };
  state: BalkuSnapshot;
};

const NAMESPACE = "balku_rooms";
const ROOM_TTL_MS = 24 * 60 * 60 * 1000;
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const MATERIAL_ENUM: MaterialKind[] = ["木材", "鉄骨", "コンクリート", "ガラス", "銅線", "合金", "超伝導体", "ゴミ"];

// --- メモリ上の状態と非同期の永続化 ---

let rooms: Map<string, BalkuRoomRecord> | null = null;
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

function isRoomRecord(value: unknown): value is BalkuRoomRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<BalkuRoomRecord>;
  return (
    typeof record.code === "string" &&
    typeof record.revision === "number" &&
    typeof record.updatedAt === "number" &&
    Array.isArray(record.players) &&
    !!record.state &&
    typeof record.state === "object" &&
    Array.isArray((record.state as RoomGameState).players)
  );
}

async function ensureLoaded(): Promise<void> {
  if (rooms) return;
  if (!loadPromise) {
    loadPromise = (async () => {
      const map = new Map<string, BalkuRoomRecord>();
      if (isBotApiConfigured()) {
        try {
          const stored = await kvList(NAMESPACE);
          const now = Date.now();
          for (const [key, value] of stored) {
            if (isRoomRecord(value) && now - value.updatedAt <= ROOM_TTL_MS) {
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
async function persistRecord(record: BalkuRoomRecord): Promise<void> {
  if (!isBotApiConfigured()) return;
  try {
    await kvSet(NAMESPACE, record.code, JSON.parse(JSON.stringify(record)) as BalkuRoomRecord);
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

type BalkuSubscriber = { token: string; send: (view: BalkuRoomView) => void };
const subscribers = new Map<string, Set<BalkuSubscriber>>();

function publishRoom(record: BalkuRoomRecord): void {
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
export function balkuSubscriberCount(code: string): number {
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

function requireRoom(code: string): BalkuRoomRecord {
  if (!rooms) throw new BalkuRoomError(404, "ルームが見つかりません。");
  const record = rooms.get(code);
  if (!record || Date.now() - record.updatedAt > ROOM_TTL_MS) {
    if (record) {
      rooms.delete(code);
      void persistDelete(code);
    }
    throw new BalkuRoomError(404, "ルームが見つかりません。");
  }
  return record;
}

function requirePlayer(record: BalkuRoomRecord, token: string): BalkuPlayerRecord {
  const player = record.players.find((p) => p.token === token);
  if (!player) throw new BalkuRoomError(403, "このルームの参加権限がありません。");
  return player;
}

/** 状態を差し替え、revision を上げ、永続化してから購読者へ publish する。 */
async function applyChange(record: BalkuRoomRecord, nextState: RoomGameState): Promise<void> {
  record.state = nextState;
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

function toView(record: BalkuRoomRecord, player: BalkuPlayerRecord): BalkuRoomView {
  return {
    code: record.code,
    status: record.state.phase,
    revision: record.revision,
    maxPlayers: record.maxPlayers,
    player: { seat: player.seat, displayName: player.name, isHost: player.isHost },
    state: snapshotFor(record.state, player.seat),
  };
}

// --- ルーム操作（すべて直列化される） ---

export async function createBalkuRoom(input: { displayName: string; maxPlayers: number; isPublic: boolean }): Promise<{ code: string; playerToken: string }> {
  return serialize(async () => {
    await ensureLoaded();
    await sweepExpired();
    let code = newRoomCode();
    for (let attempt = 0; attempt < 20 && rooms!.has(code); attempt += 1) code = newRoomCode();
    if (rooms!.has(code)) throw new BalkuRoomError(503, "ルームを作成できませんでした。もう一度お試しください。");
    const playerToken = newPlayerToken();
    const now = Date.now();
    const record: BalkuRoomRecord = {
      code,
      maxPlayers: input.maxPlayers,
      isPublic: input.isPublic,
      revision: 1,
      createdAt: now,
      updatedAt: now,
      players: [{ token: playerToken, seat: 0, name: input.displayName, isHost: true }],
      state: createLobbyState(input.displayName),
    };
    rooms!.set(code, record);
    await persistRecord(record);
    return { code, playerToken };
  });
}

export async function joinBalkuRoom(input: { code: string; displayName: string }): Promise<{ code: string; playerToken: string }> {
  return serialize(async () => {
    await ensureLoaded();
    const record = requireRoom(input.code);
    if (record.state.phase !== "lobby") throw new BalkuRoomError(400, "この対戦はすでに開始されています。");
    if (record.players.length >= record.maxPlayers) throw new BalkuRoomError(400, "このルームは満席です。");
    let next: RoomGameState;
    try {
      next = addLobbyPlayer(record.state, input.displayName);
    } catch (error) {
      throw new BalkuRoomError(400, error instanceof Error ? error.message : "参加できませんでした。");
    }
    const playerToken = newPlayerToken();
    record.players.push({ token: playerToken, seat: next.players.length - 1, name: input.displayName, isHost: false });
    await applyChange(record, next);
    return { code: record.code, playerToken };
  });
}

export async function listPublicBalkuRooms(): Promise<{ code: string; maxPlayers: number; playerCount: number; createdAt: number }[]> {
  return serialize(async () => {
    await ensureLoaded();
    await sweepExpired();
    if (!rooms) return [];
    return [...rooms.values()]
      .filter((record) => record.isPublic && record.state.phase === "lobby")
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((record) => ({
        code: record.code,
        maxPlayers: record.maxPlayers,
        playerCount: record.state.players.length,
        createdAt: record.createdAt,
      }));
  });
}

/** 取得時に期限切れ処理（自動パス・オークション決済）を適用し、変わっていたら保存する。 */
export async function getBalkuRoom(code: string, playerToken: string): Promise<BalkuRoomView> {
  return serialize(async () => {
    await ensureLoaded();
    const record = requireRoom(code);
    const player = requirePlayer(record, playerToken);
    const expired = expireTimedOutTurn(record.state);
    if (expired !== record.state) await applyChange(record, expired);
    return toView(record, player);
  });
}

/**
 * SSE 用の購読登録。期限切れ処理を適用したうえで現在のビューを返し、
 * 以後の revision 上昇は send へ publish される。切断時は必ず
 * 返り値の unsubscribe を呼ぶこと。
 */
export async function subscribeBalkuRoom(
  code: string,
  playerToken: string,
  send: (view: BalkuRoomView) => void,
): Promise<{ view: BalkuRoomView; unsubscribe: () => void }> {
  return serialize(async () => {
    await ensureLoaded();
    const record = requireRoom(code);
    const player = requirePlayer(record, playerToken);
    const expired = expireTimedOutTurn(record.state);
    if (expired !== record.state) await applyChange(record, expired);
    const subscriber: BalkuSubscriber = { token: playerToken, send };
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

export async function startBalkuGame(code: string, playerToken: string, expectedRevision: number): Promise<{ success: true; revision: number }> {
  return serialize(async () => {
    await ensureLoaded();
    const record = requireRoom(code);
    const player = requirePlayer(record, playerToken);
    if (!player.isHost) throw new BalkuRoomError(403, "対戦を開始できるのはルーム作成者だけです。");
    if (record.revision !== expectedRevision) throw new BalkuRoomError(409, "最新の参加状況を確認してください。");
    let next: RoomGameState;
    try {
      next = startGame(record.state);
    } catch (error) {
      throw new BalkuRoomError(400, error instanceof Error ? error.message : "対戦開始に失敗しました。");
    }
    await applyChange(record, next);
    return { success: true as const, revision: record.revision };
  });
}

export async function restartBalkuGame(code: string, playerToken: string, expectedRevision: number): Promise<{ success: true; revision: number }> {
  return serialize(async () => {
    await ensureLoaded();
    const record = requireRoom(code);
    const player = requirePlayer(record, playerToken);
    if (!player.isHost) throw new BalkuRoomError(403, "再戦を準備できるのはルーム作成者だけです。");
    if (record.revision !== expectedRevision) throw new BalkuRoomError(409, "盤面が更新されました。もう一度お試しください。");
    if (record.state.phase !== "finished") throw new BalkuRoomError(400, "対戦終了後に再戦を準備できます。");
    await applyChange(record, resetToLobby(record.state));
    return { success: true as const, revision: record.revision };
  });
}

export async function leaveBalkuRoom(code: string, playerToken: string, expectedRevision: number): Promise<{ success: true }> {
  return serialize(async () => {
    await ensureLoaded();
    const record = requireRoom(code);
    const player = requirePlayer(record, playerToken);
    if (record.revision !== expectedRevision) {
      throw new BalkuRoomError(409, "退出処理中に盤面が更新されました。もう一度お試しください。");
    }
    let next: RoomGameState;
    try {
      next = removePlayerFromState(record.state, player.seat);
    } catch (error) {
      throw new BalkuRoomError(400, error instanceof Error ? error.message : "退出できませんでした。");
    }
    const wasLobby = record.state.phase === "lobby";
    const wasHost = player.isHost;
    record.players = record.players.filter((p) => p.token !== playerToken);
    if (record.players.length === 0) {
      rooms!.delete(code);
      subscribers.delete(code);
      await persistDelete(code);
      return { success: true as const };
    }
    if (wasLobby) {
      // ロビー退出ではエンジン側の seat が振り直されるため、残りの
      // プレイヤーレコードも同じ順序で seat を振り直して同期させる
      record.players.sort((a, b) => a.seat - b.seat);
      record.players.forEach((p, i) => {
        p.seat = i;
      });
    }
    if (wasHost && !record.players.some((p) => p.isHost)) {
      // ホストが抜けたら最若席のプレイヤーをホストにする（開始・再戦の担い手）
      const promoted = [...record.players].sort((a, b) => a.seat - b.seat)[0];
      if (promoted) promoted.isHost = true;
    }
    await applyChange(record, next);
    return { success: true as const };
  });
}

export async function applyBalkuMove(
  code: string,
  playerToken: string,
  expectedRevision: number,
  action: GameAction,
): Promise<{ success: true; revision: number }> {
  return serialize(async () => {
    await ensureLoaded();
    const record = requireRoom(code);
    const player = requirePlayer(record, playerToken);
    if (record.revision !== expectedRevision) {
      throw new BalkuRoomError(409, "誰かが先に操作しました。盤面を同期しました。");
    }
    const expired = expireTimedOutTurn(record.state);
    if (expired !== record.state) {
      const autoPassed = expired.activeSeat !== record.state.activeSeat || expired.turn !== record.state.turn;
      await applyChange(record, expired);
      throw new BalkuRoomError(409, autoPassed ? "施工時間が終了したため、自動パスしました。" : "手番状態が更新されました。盤面を同期しました。");
    }
    let next: RoomGameState;
    try {
      next = applyGameAction(record.state, player.seat, action);
    } catch (error) {
      throw new BalkuRoomError(400, error instanceof Error ? error.message : "操作を処理できませんでした。");
    }
    await applyChange(record, next);
    return { success: true as const, revision: record.revision };
  });
}

// --- 入力検証（元の zod スキーマ相当を手書きで） ---

function asBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BalkuRoomError(400, "リクエストの形式が正しくありません。");
  }
  return value as Record<string, unknown>;
}

export function parseDisplayName(value: unknown): string {
  if (typeof value !== "string" || value.trim().length < 2) {
    throw new BalkuRoomError(400, "ユーザー名は2文字以上で入力してください。");
  }
  const name = value.trim();
  if (name.length > 24) throw new BalkuRoomError(400, "ユーザー名は24文字以内です。");
  return name;
}

export function parseRoomCode(value: unknown): string {
  if (typeof value !== "string") throw new BalkuRoomError(400, "ルームコードは6文字です。");
  const code = value.trim().toUpperCase();
  if (!/^[A-Z2-9]{6}$/.test(code)) throw new BalkuRoomError(400, "ルームコードは6文字です。");
  return code;
}

export function parsePlayerToken(value: unknown): string {
  if (typeof value !== "string" || value.length < 16 || value.length > 64) {
    throw new BalkuRoomError(400, "トークンが正しくありません。");
  }
  return value;
}

export function parseExpectedRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new BalkuRoomError(400, "リビジョンが正しくありません。");
  }
  return value;
}

export function parseCreateRoomBody(body: unknown): { displayName: string; maxPlayers: number; isPublic: boolean } {
  const data = asBody(body);
  const displayName = parseDisplayName(data.displayName);
  const maxPlayers = data.maxPlayers;
  if (typeof maxPlayers !== "number" || !Number.isInteger(maxPlayers) || maxPlayers < 2 || maxPlayers > 4) {
    throw new BalkuRoomError(400, "人数は2〜4人です。");
  }
  let isPublic = true;
  if (data.isPublic !== undefined) {
    if (typeof data.isPublic !== "boolean") throw new BalkuRoomError(400, "公開設定が正しくありません。");
    isPublic = data.isPublic;
  }
  return { displayName, maxPlayers, isPublic };
}

export function parseJoinRoomBody(body: unknown): { code: string; displayName: string } {
  const data = asBody(body);
  return { code: parseRoomCode(data.code), displayName: parseDisplayName(data.displayName) };
}

export function parseTokenRevisionBody(body: unknown): { playerToken: string; expectedRevision: number } {
  const data = asBody(body);
  return { playerToken: parsePlayerToken(data.playerToken), expectedRevision: parseExpectedRevision(data.expectedRevision) };
}

function isIntIn(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

function isStringArray(value: unknown, min: number, max: number): value is string[] {
  return Array.isArray(value) && value.length >= min && value.length <= max && value.every((item) => typeof item === "string");
}

function isPlainString(value: unknown): value is string {
  return typeof value === "string" && value.length <= 256;
}

/** 元の actionSchema（discriminatedUnion）相当の検証。不正なら null。 */
export function parseGameAction(value: unknown): GameAction | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  switch (data.type) {
    case "submit": {
      if (!isPlainString(data.projectId) || !isStringArray(data.materialIds, 0, 9) || typeof data.faceUp !== "boolean") return null;
      if (data.targetSeat !== undefined && !isIntIn(data.targetSeat, 0, 3)) return null;
      return {
        type: "submit",
        projectId: data.projectId,
        materialIds: data.materialIds,
        faceUp: data.faceUp,
        ...(data.targetSeat !== undefined ? { targetSeat: data.targetSeat } : {}),
      };
    }
    case "buyMaterial": {
      if (typeof data.material !== "string" || !MATERIAL_ENUM.includes(data.material as MaterialKind)) return null;
      return { type: "buyMaterial", material: data.material as MaterialKind };
    }
    case "sellCards": {
      if (!isStringArray(data.cardIds, 1, 72)) return null;
      return { type: "sellCards", cardIds: data.cardIds };
    }
    case "bid": {
      if (!isIntIn(data.amount, 1, 99)) return null;
      return { type: "bid", amount: data.amount };
    }
    case "bulkCall": {
      if (!isIntIn(data.targetSeat, 0, 3) || !isPlainString(data.submissionId)) return null;
      return { type: "bulkCall", targetSeat: data.targetSeat, submissionId: data.submissionId };
    }
    case "forceBulk": {
      if (!isPlainString(data.chargeId) || !isIntIn(data.targetSeat, 0, 3) || !isPlainString(data.submissionId)) return null;
      return { type: "forceBulk", chargeId: data.chargeId, targetSeat: data.targetSeat, submissionId: data.submissionId };
    }
    case "endTurn":
      return { type: "endTurn" };
    default:
      return null;
  }
}

export function parseMoveBody(body: unknown): { playerToken: string; expectedRevision: number; action: GameAction } {
  const data = asBody(body);
  const action = parseGameAction(data.action);
  if (!action) throw new BalkuRoomError(400, "操作の形式が正しくありません。");
  return { playerToken: parsePlayerToken(data.playerToken), expectedRevision: parseExpectedRevision(data.expectedRevision), action };
}
