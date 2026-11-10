// LLL のサーバー側ストア（サーバー専用）。
// プロフィールと対戦状態の正本は Bot API 経由の bot_kv に保持する
// （namespace "lll_profiles" キー=プレイヤートークン、"lll_battles"
// キー=バトルID）。プロフィールはトークン単位でオンデマンドに読み込み
// （kvGet）、以後はメモリ上のコピーを正として、変更のたびに直列
// チェーンの中で kvSet してから応答する（BALKU 流儀）。
// BOT API が未設定の環境ではメモリのみで動作する。
// 対戦は単独プレイヤー対 CPU で秘匿情報がないため、BattleState は
// そのままクライアントへ返す（snapshotFor 相当の秘匿は不要）。
import { createHash, randomBytes } from "node:crypto";
import { isBotApiConfigured, kvGet, kvSet } from "./bot-api";
import { logfareApiKeys } from "./one-prompter-server";
import {
  COLLECTION_CAP,
  DUPLICATE_SHARDS,
  LADDER_TIERS,
  MAX_LEVEL,
  STARTER_CARDS,
  appraiseDeterministic,
  fallbackWords,
  ladderDeck,
  levelUpCost,
  validateAiWords,
  type AiWords,
  type ImageFeatures,
  type LllCard,
  type LllTier,
} from "./lll-game";
import { applyAction, createBattle, type BattleState, type PlayerAction } from "./lll-battle";

export class LllError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type LllProfile = {
  token: string;
  cards: LllCard[];
  teamIds: string[];
  shards: number;
  lumen: number;
  clearedTiers: number[];
  wins: number;
  losses: number;
  draws: number;
  createdAt: number;
};

type LllBattleRecord = {
  battleId: string;
  token: string;
  tierIndex: number;
  state: BattleState;
  rewarded: boolean;
  createdAt: number;
  updatedAt: number;
};

const PROFILES_NAMESPACE = "lll_profiles";
const BATTLES_NAMESPACE = "lll_battles";
const LUMEN_EXCHANGE_COST = 50;
const LUMEN_EXCHANGE_SHARDS = 5;
const MAX_IMAGE_DATA_URL_LENGTH = 400_000;
const LOGFARE_TIMEOUT_MS = 30_000;
const DEFAULT_LLL_MODEL = "claude-haiku-5-5";

// 仕様書（lll-spec-2026-11-10 §4.1）の報酬表。LADDER_TIERS の項目から
// 報酬フィールドが読み取れない場合のフォールバックとしてだけ使う。
const SPEC_TIER_REWARDS: { winShards: number; winLumen: number; loseShards: number }[] = [
  { winShards: 10, winLumen: 30, loseShards: 2 },
  { winShards: 14, winLumen: 45, loseShards: 3 },
  { winShards: 20, winLumen: 65, loseShards: 4 },
  { winShards: 28, winLumen: 90, loseShards: 5 },
  { winShards: 38, winLumen: 120, loseShards: 6 },
  { winShards: 50, winLumen: 160, loseShards: 8 },
  { winShards: 65, winLumen: 210, loseShards: 10 },
  { winShards: 85, winLumen: 280, loseShards: 12 },
];

// --- メモリ上の状態と非同期の永続化（BALKU の serialize 流儀） ---

const profiles = new Map<string, LllProfile>();
const battles = new Map<string, LllBattleRecord>();
let chain: Promise<unknown> = Promise.resolve();

function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function newPlayerToken(): string {
  return randomBytes(24).toString("base64url");
}

function newBattleId(): string {
  return randomBytes(16).toString("base64url");
}

function randomSeed(): number {
  return randomBytes(4).readUInt32LE(0);
}

function isProfile(value: unknown): value is LllProfile {
  if (!value || typeof value !== "object") return false;
  const p = value as Partial<LllProfile>;
  return typeof p.token === "string" && Array.isArray(p.cards) && Array.isArray(p.teamIds);
}

/** kv から読んだ旧形式プロフィールに不足フィールドの既定値を補う。 */
function normalizeProfile(value: LllProfile): LllProfile {
  return {
    token: value.token,
    cards: Array.isArray(value.cards) ? value.cards : [],
    teamIds: Array.isArray(value.teamIds) ? value.teamIds : [],
    shards: typeof value.shards === "number" ? value.shards : 0,
    lumen: typeof value.lumen === "number" ? value.lumen : 0,
    clearedTiers: Array.isArray(value.clearedTiers) ? value.clearedTiers : [],
    wins: typeof value.wins === "number" ? value.wins : 0,
    losses: typeof value.losses === "number" ? value.losses : 0,
    draws: typeof value.draws === "number" ? value.draws : 0,
    createdAt: typeof value.createdAt === "number" ? value.createdAt : Date.now(),
  };
}

function isBattleRecord(value: unknown): value is LllBattleRecord {
  if (!value || typeof value !== "object") return false;
  const r = value as Partial<LllBattleRecord>;
  return (
    typeof r.battleId === "string" &&
    typeof r.token === "string" &&
    !!r.state &&
    typeof r.state === "object" &&
    typeof (r.state as BattleState).phase === "string"
  );
}

async function persistProfile(profile: LllProfile): Promise<void> {
  if (!isBotApiConfigured()) return;
  try {
    await kvSet(PROFILES_NAMESPACE, profile.token, deepClone(profile));
  } catch {
    // 書けなくてもメモリ上の状態が正として処理は続ける
  }
}

async function persistBattle(record: LllBattleRecord): Promise<void> {
  if (!isBotApiConfigured()) return;
  try {
    await kvSet(BATTLES_NAMESPACE, record.battleId, deepClone(record));
  } catch {
    // 同上
  }
}

/** メモリに無いプロフィールを kv からオンデマンドで読み込む。 */
async function loadProfile(token: string): Promise<LllProfile | null> {
  const cached = profiles.get(token);
  if (cached) return cached;
  if (isBotApiConfigured()) {
    try {
      const stored = await kvGet(PROFILES_NAMESPACE, token);
      if (isProfile(stored)) {
        const profile = normalizeProfile(stored);
        profiles.set(token, profile);
        return profile;
      }
    } catch {
      // 読めなければ「存在しない」として扱う
    }
  }
  return null;
}

async function loadBattle(battleId: string): Promise<LllBattleRecord | null> {
  const cached = battles.get(battleId);
  if (cached) return cached;
  if (isBotApiConfigured()) {
    try {
      const stored = await kvGet(BATTLES_NAMESPACE, battleId);
      if (isBattleRecord(stored)) {
        const record: LllBattleRecord = {
          battleId: stored.battleId,
          token: stored.token,
          tierIndex: typeof stored.tierIndex === "number" ? stored.tierIndex : 0,
          state: stored.state,
          rewarded: stored.rewarded === true,
          createdAt: typeof stored.createdAt === "number" ? stored.createdAt : Date.now(),
          updatedAt: typeof stored.updatedAt === "number" ? stored.updatedAt : Date.now(),
        };
        battles.set(battleId, record);
        return record;
      }
    } catch {
      // 読めなければ「存在しない」として扱う
    }
  }
  return null;
}

async function requireProfile(token: string): Promise<LllProfile> {
  const profile = await loadProfile(token);
  if (!profile) throw new LllError(403, "プレイヤー情報が見つかりません。最初からやり直してください。");
  return profile;
}

async function requireBattle(token: string, battleId: string): Promise<LllBattleRecord> {
  const record = await loadBattle(battleId);
  if (!record) throw new LllError(404, "対戦が見つかりません。");
  if (record.token !== token) throw new LllError(403, "この対戦の参加権限がありません。");
  return record;
}

// --- プロフィール ---

export async function getOrCreateProfile(
  token?: string | null,
): Promise<{ token: string; profile: LllProfile }> {
  return serialize(async () => {
    if (typeof token === "string" && token.length >= 16 && token.length <= 64) {
      const existing = await loadProfile(token);
      if (existing) return { token: existing.token, profile: existing };
    }
    const newToken = newPlayerToken();
    const cards = deepClone(STARTER_CARDS) as LllCard[];
    const profile: LllProfile = {
      token: newToken,
      cards,
      teamIds: cards.map((card) => card.id),
      shards: 0,
      lumen: 0,
      clearedTiers: [],
      wins: 0,
      losses: 0,
      draws: 0,
      createdAt: Date.now(),
    };
    profiles.set(newToken, profile);
    await persistProfile(profile);
    return { token: newToken, profile };
  });
}

export async function getProfile(token: string): Promise<LllProfile | null> {
  return serialize(async () => loadProfile(token));
}

// --- スカウト（鑑定） ---

function logfareBaseUrl(): string {
  return (process.env.LOGFARE_BASE_URL?.trim() || "https://logfare.ai/v1").replace(/\/+$/, "");
}

function extractChatContent(data: unknown): string {
  const choices = (data as { choices?: unknown })?.choices;
  if (!Array.isArray(choices) || choices.length === 0) return "";
  const content = (choices[0] as { message?: { content?: unknown } })?.message?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
          ? (part as { text: string }).text
          : "",
      )
      .join("\n")
      .trim();
  }
  return "";
}

const APPRAISE_WORDS_PROMPT = [
  "あなたは画像からトレーディングカードの「言葉」だけを作るアシスタントです。",
  "添付画像を見て、そのモチーフ・色・質感からカードの名前と文章を考えてください。",
  "数値（ステータス・威力など）はサーバーが決めるので、絶対に出力しないでください。",
  '出力は次の JSON だけにしてください。説明文やコードフェンスは付けないでください。',
  '{"name":"カード名（20文字以内）","flavor":"フレーバー文（60文字以内）","skillNames":["技の名前1","技の名前2"],"traitName":"特性の名前"}',
].join("\n");

/**
 * Logfare（OpenAI 互換 chat/completions、画像入力）でカードの言葉だけを
 * 生成する。キーが無い・失敗・検証 NG のときは null を返し、呼び出し側が
 * 決定的フォールバック生成に倒す。キー切替は HTTP 429 のときだけ。
 */
export async function appraiseWordsWithLogfare(imageDataUrl: string): Promise<AiWords | null> {
  const keys = logfareApiKeys();
  if (keys.length === 0) return null;
  const payload = {
    model: process.env.LLL_MODEL?.trim() || DEFAULT_LLL_MODEL,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: APPRAISE_WORDS_PROMPT },
          { type: "image_url", image_url: { url: imageDataUrl } },
        ],
      },
    ],
    max_tokens: 500,
  };
  for (let i = 0; i < keys.length; i++) {
    let response: Response;
    try {
      response = await fetch(`${logfareBaseUrl()}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${keys[i]}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(LOGFARE_TIMEOUT_MS),
      });
    } catch {
      // ネットワークエラー・タイムアウトはキーを替えても直らないので諦める
      return null;
    }
    if (response.status === 429) {
      console.warn(`lll: Logfare key #${i + 1} returned 429, failing over to next key`);
      continue;
    }
    if (!response.ok) return null;
    let content: string;
    try {
      content = extractChatContent(await response.json());
    } catch {
      return null;
    }
    if (!content) return null;
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch {
      return null;
    }
    return validateAiWords(parsed);
  }
  return null;
}

function duplicateShardsFor(tier: LllTier): number {
  const table = DUPLICATE_SHARDS as unknown;
  if (Array.isArray(table)) {
    const index = { normal: 0, elite: 1, legend: 2 }[tier as string] ?? -1;
    const value = index >= 0 ? table[index] : undefined;
    return typeof value === "number" ? value : 0;
  }
  if (table && typeof table === "object") {
    const record = table as Record<string, unknown>;
    const jaKey = { normal: "ノーマル", elite: "エリート", legend: "レジェンド" }[tier as string];
    for (const key of [tier as string, jaKey]) {
      const value = key ? record[key] : undefined;
      if (typeof value === "number") return value;
    }
  }
  return { normal: 5, elite: 15, legend: 40 }[tier as string] ?? 0;
}

export type AppraiseResult = {
  profile: LllProfile;
  card: LllCard | null;
  duplicated: boolean;
  shardsGained: number;
  aiUsed: boolean;
};

export async function appraise(
  token: string,
  features: ImageFeatures,
  imageDataUrl: string,
): Promise<AppraiseResult> {
  return serialize(async () => {
    const profile = await requireProfile(token);
    const payloadBase64 = validateImageDataUrl(imageDataUrl);
    const imageBytes = Buffer.from(payloadBase64, "base64");
    if (imageBytes.length === 0) throw new LllError(400, "画像データを読み取れませんでした。");
    const imageSha = createHash("sha256").update(imageBytes).digest("hex");

    // 同一画像の再スカウトはカードを増やさず欠片に変換する（既存カードのティア基準）
    const existing = profile.cards.find((card) => card.imageHash === imageSha);
    if (existing) {
      const shardsGained = duplicateShardsFor(existing.tier);
      profile.shards += shardsGained;
      await persistProfile(profile);
      return { profile, card: null, duplicated: true, shardsGained, aiUsed: false };
    }
    if (profile.cards.length >= COLLECTION_CAP) {
      throw new LllError(400, "バインダーがいっぱいです");
    }

    let aiUsed = false;
    let words: AiWords;
    const aiWords = await appraiseWordsWithLogfare(imageDataUrl);
    if (aiWords) {
      words = aiWords;
      aiUsed = true;
    } else {
      words = fallbackWords(features, imageSha);
    }
    const card = appraiseDeterministic(features, imageSha, words, Date.now());
    card.imageDataUrl = imageDataUrl;
    profile.cards.push(card);
    await persistProfile(profile);
    return { profile, card, duplicated: false, shardsGained: 0, aiUsed };
  });
}

// --- チーム編成・強化 ---

export async function setTeam(token: string, teamIds: string[]): Promise<LllProfile> {
  return serialize(async () => {
    const profile = await requireProfile(token);
    if (teamIds.length !== 3 || new Set(teamIds).size !== 3) {
      throw new LllError(400, "チームは3枚の異なるカードで編成してください。");
    }
    for (const id of teamIds) {
      if (!profile.cards.some((card) => card.id === id)) {
        throw new LllError(400, "所持していないカードがチームに含まれています。");
      }
    }
    profile.teamIds = [...teamIds];
    await persistProfile(profile);
    return profile;
  });
}

export async function growCard(
  token: string,
  cardId: string,
): Promise<{ profile: LllProfile; card: LllCard }> {
  return serialize(async () => {
    const profile = await requireProfile(token);
    const card = profile.cards.find((c) => c.id === cardId);
    if (!card) throw new LllError(404, "カードが見つかりません。");
    if (card.level >= MAX_LEVEL) throw new LllError(400, "このカードは最大レベルです。");
    const cost = levelUpCost(card.level);
    if (profile.shards < cost) throw new LllError(400, "欠片が足りません。");
    profile.shards -= cost;
    card.level += 1;
    await persistProfile(profile);
    return { profile, card };
  });
}

export async function exchangeLumen(
  token: string,
): Promise<{ profile: LllProfile; shardsGained: number; lumenSpent: number }> {
  return serialize(async () => {
    const profile = await requireProfile(token);
    if (profile.lumen < LUMEN_EXCHANGE_COST) throw new LllError(400, "ルーメンが足りません。");
    profile.lumen -= LUMEN_EXCHANGE_COST;
    profile.shards += LUMEN_EXCHANGE_SHARDS;
    await persistProfile(profile);
    return { profile, shardsGained: LUMEN_EXCHANGE_SHARDS, lumenSpent: LUMEN_EXCHANGE_COST };
  });
}

// --- バトル（アリーナ） ---

function tierRewards(tierIndex: number): { winShards: number; winLumen: number; loseShards: number } {
  const fallback = SPEC_TIER_REWARDS[tierIndex] ?? { winShards: 0, winLumen: 0, loseShards: 0 };
  const tier = LADDER_TIERS[tierIndex] as unknown as Record<string, unknown> | undefined;
  if (!tier) return fallback;
  const pick = (...keys: string[]): number | undefined => {
    for (const key of keys) {
      const value = tier[key];
      if (typeof value === "number" && Number.isFinite(value)) return value;
    }
    return undefined;
  };
  const winShards = pick("winShards", "shards", "rewardShards", "win_shards");
  const winLumen = pick("winLumen", "lumen", "rewardLumen", "win_lumen");
  const loseShards = pick("loseShards", "lose_shards");
  if (winShards === undefined && winLumen === undefined && loseShards === undefined) return fallback;
  return {
    winShards: winShards ?? fallback.winShards,
    winLumen: winLumen ?? fallback.winLumen,
    loseShards: loseShards ?? fallback.loseShards,
  };
}

type BattleOutcome = "win" | "lose" | "draw";

/** 終了状態から勝敗を取り出す。エンジンの表現ゆれをここで吸収する。 */
function battleOutcome(state: BattleState): BattleOutcome {
  const s = state as unknown as Record<string, unknown>;
  const raw = s.result ?? s.outcome ?? s.winner ?? s.winnerSide ?? s.victor;
  if (typeof raw === "string") {
    if (raw === "player" || raw === "win" || raw === "victory" || raw === "player_win") return "win";
    if (raw === "enemy" || raw === "cpu" || raw === "lose" || raw === "loss" || raw === "defeat") return "lose";
    if (raw === "draw" || raw === "tie") return "draw";
  }
  if (typeof raw === "number") {
    if (raw === 0) return "win";
    if (raw === 1) return "lose";
  }
  if (s.playerWon === true) return "win";
  if (s.playerWon === false) return "lose";
  return "draw";
}

export async function startBattle(
  token: string,
  tierIndex: number,
): Promise<{ battleId: string; battle: BattleState }> {
  return serialize(async () => {
    const profile = await requireProfile(token);
    if (!Number.isInteger(tierIndex) || tierIndex < 0 || tierIndex >= LADDER_TIERS.length) {
      throw new LllError(400, "ティアの指定が正しくありません。");
    }
    const highestUnlocked = (profile.clearedTiers.length > 0 ? Math.max(...profile.clearedTiers) : -1) + 1;
    if (tierIndex > highestUnlocked) {
      throw new LllError(400, "このティアはまだ解放されていません。");
    }
    const teamCards: LllCard[] = [];
    for (const id of profile.teamIds) {
      const card = profile.cards.find((c) => c.id === id);
      if (card) teamCards.push(card);
    }
    if (teamCards.length !== 3) throw new LllError(400, "チームは3枚で編成してください。");
    const battleId = newBattleId();
    let state: BattleState;
    try {
      state = createBattle(battleId, deepClone(teamCards), ladderDeck(tierIndex), tierIndex, randomSeed());
    } catch (error) {
      throw new LllError(400, error instanceof Error ? error.message : "対戦を開始できませんでした。");
    }
    const now = Date.now();
    const record: LllBattleRecord = {
      battleId,
      token,
      tierIndex,
      state,
      rewarded: false,
      createdAt: now,
      updatedAt: now,
    };
    battles.set(battleId, record);
    await persistBattle(record);
    return { battleId, battle: state };
  });
}

export async function battleAction(
  token: string,
  battleId: string,
  action: PlayerAction,
): Promise<{ battle: BattleState; profile: LllProfile }> {
  return serialize(async () => {
    const profile = await requireProfile(token);
    const record = await requireBattle(token, battleId);
    if (record.state.phase === "finished" && record.rewarded) {
      return { battle: record.state, profile };
    }
    let next: BattleState;
    try {
      next = applyAction(record.state, action);
    } catch (error) {
      throw new LllError(400, error instanceof Error ? error.message : "操作を処理できませんでした。");
    }
    record.state = next;
    record.updatedAt = Date.now();

    // 終了時の報酬は1回だけ付与する
    if (next.phase === "finished" && !record.rewarded) {
      record.rewarded = true;
      const rewards = tierRewards(record.tierIndex);
      const outcome = battleOutcome(next);
      if (outcome === "win") {
        const firstClear = !profile.clearedTiers.includes(record.tierIndex);
        const multiplier = firstClear ? 2 : 1;
        profile.shards += rewards.winShards * multiplier;
        profile.lumen += rewards.winLumen * multiplier;
        if (firstClear) profile.clearedTiers = [...profile.clearedTiers, record.tierIndex].sort((a, b) => a - b);
        profile.wins += 1;
      } else if (outcome === "lose") {
        profile.shards += rewards.loseShards;
        profile.losses += 1;
      } else {
        profile.shards += Math.floor(rewards.loseShards / 2);
        profile.draws += 1;
      }
      await persistProfile(profile);
    }
    await persistBattle(record);
    return { battle: record.state, profile };
  });
}

export async function getBattle(token: string, battleId: string): Promise<BattleState> {
  return serialize(async () => {
    const record = await requireBattle(token, battleId);
    return record.state;
  });
}

// --- 入力検証（BALKU の手書き parse 流儀） ---

function asBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new LllError(400, "リクエストの形式が正しくありません。");
  }
  return value as Record<string, unknown>;
}

export function parseToken(value: unknown): string {
  if (typeof value !== "string" || value.length < 16 || value.length > 64) {
    throw new LllError(400, "トークンが正しくありません。");
  }
  return value;
}

export function parseSessionBody(body: unknown): { token: string | null } {
  if (body === undefined || body === null) return { token: null };
  const data = asBody(body);
  const token = data.token;
  if (token === undefined || token === null) return { token: null };
  if (typeof token === "string" && token.length >= 16 && token.length <= 64) return { token };
  return { token: null };
}

const FEATURE_RANGES: Record<string, { min: number; max: number }> = {
  saturation: { min: 0, max: 1 },
  brightness: { min: 0, max: 1 },
  colorVariance: { min: 0, max: 1 },
  edgeComplexity: { min: 0, max: 1 },
  warmth: { min: 0, max: 1 },
  coolness: { min: 0, max: 1 },
  hue: { min: 0, max: 360 },
};
const REQUIRED_FEATURES = ["saturation", "brightness", "colorVariance", "edgeComplexity"] as const;

/** 画像特徴量の検証。未知の数値フィールドはそのまま通す（エンジン側の拡張に追随）。 */
export function parseFeatures(value: unknown): ImageFeatures {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new LllError(400, "画像の特徴量が正しくありません。");
  }
  const data = value as Record<string, unknown>;
  for (const [key, fieldValue] of Object.entries(data)) {
    if (typeof fieldValue !== "number" || !Number.isFinite(fieldValue)) {
      throw new LllError(400, "画像の特徴量が正しくありません。");
    }
    const range = FEATURE_RANGES[key];
    if (range && (fieldValue < range.min || fieldValue > range.max)) {
      throw new LllError(400, "画像の特徴量が範囲外です。");
    }
  }
  for (const key of REQUIRED_FEATURES) {
    if (typeof data[key] !== "number") throw new LllError(400, "画像の特徴量が不足しています。");
  }
  return data as unknown as ImageFeatures;
}

/** data URL の形式検証。検証済みの base64 ペイロード部を返す。 */
export function validateImageDataUrl(value: unknown): string {
  if (typeof value !== "string") throw new LllError(400, "画像データが正しくありません。");
  if (value.length > MAX_IMAGE_DATA_URL_LENGTH) throw new LllError(413, "画像が大きすぎます。");
  const match = /^data:image\/(?:jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(value);
  if (!match) throw new LllError(400, "画像データの形式が正しくありません。");
  return match[1];
}

export function parseAppraiseBody(body: unknown): { token: string; features: ImageFeatures; imageDataUrl: string } {
  const data = asBody(body);
  const token = parseToken(data.token);
  const features = parseFeatures(data.features);
  if (typeof data.imageDataUrl !== "string") throw new LllError(400, "画像データが正しくありません。");
  // 形式・サイズの本検証は appraise() 内（validateImageDataUrl）で行う
  return { token, features, imageDataUrl: data.imageDataUrl };
}

export function parseTeamBody(body: unknown): { token: string; teamIds: string[] } {
  const data = asBody(body);
  const token = parseToken(data.token);
  if (
    !Array.isArray(data.teamIds) ||
    data.teamIds.length !== 3 ||
    !data.teamIds.every((id) => typeof id === "string" && id.length > 0)
  ) {
    throw new LllError(400, "チームの形式が正しくありません。");
  }
  return { token, teamIds: data.teamIds as string[] };
}

export type GrowRequest =
  | { token: string; action: "levelup"; cardId: string }
  | { token: string; action: "exchange" };

export function parseGrowBody(body: unknown): GrowRequest {
  const data = asBody(body);
  const token = parseToken(data.token);
  if (data.action === "exchange") return { token, action: "exchange" };
  if (typeof data.cardId !== "string" || data.cardId.length === 0) {
    throw new LllError(400, "カードの指定が正しくありません。");
  }
  return { token, action: "levelup", cardId: data.cardId };
}

export function parseBattleStartBody(body: unknown): { token: string; tierIndex: number } {
  const data = asBody(body);
  const token = parseToken(data.token);
  if (typeof data.tierIndex !== "number" || !Number.isInteger(data.tierIndex)) {
    throw new LllError(400, "ティアの指定が正しくありません。");
  }
  return { token, tierIndex: data.tierIndex };
}

export function parsePlayerAction(value: unknown): PlayerAction {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new LllError(400, "操作の形式が正しくありません。");
  }
  const data = value as Record<string, unknown>;
  // 契約は lll-battle の PlayerAction { skill, targetKey? }。
  // クライアントが併記する type は無視し、skill を正として検証する。
  const skill = data.skill;
  if (skill !== 0 && skill !== 1 && skill !== "basic" && skill !== "defend") {
    throw new LllError(400, "操作の形式が正しくありません。");
  }
  const targetKey = typeof data.targetKey === "string" ? data.targetKey : undefined;
  return { skill, targetKey } as PlayerAction;
}

export function parseBattleActionBody(body: unknown): { token: string; battleId: string; action: PlayerAction } {
  const data = asBody(body);
  const token = parseToken(data.token);
  if (typeof data.battleId !== "string" || data.battleId.length === 0 || data.battleId.length > 128) {
    throw new LllError(400, "対戦IDが正しくありません。");
  }
  return { token, battleId: data.battleId, action: parsePlayerAction(data.action) };
}

export function parseBattleId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    throw new LllError(400, "対戦IDが正しくありません。");
  }
  return value;
}
