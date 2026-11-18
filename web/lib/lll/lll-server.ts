// LLL のサーバー側ストア（サーバー専用）。
// プロフィールと対戦状態の正本は Bot API 経由の専用テーブルに保持する
// （lll_profiles キー=プレイヤートークン、lll_battles キー=バトルID、
// docs/sql/lll_tables.sql）。プロフィールはトークン単位でオンデマンドに
// 読み込み、以後はメモリ上のコピーを正として、変更のたびに直列
// チェーンの中で upsert してから応答する（BALKU 流儀）。
// 読み込みは専用テーブルに無い場合のみ、移行前の bot_kv（同名
// namespace）へフォールバックする。
// BOT API が未設定の環境ではメモリのみで動作する。
// 対戦は単独プレイヤー対 CPU で秘匿情報がないため、BattleState は
// そのままクライアントへ返す（snapshotFor 相当の秘匿は不要）。
import { createHash, randomBytes } from "node:crypto";
import { isBotApiConfigured, kvGet, tableSelect, tableUpsert } from "../bot-api";
import { logfareApiKeys } from "../one-prompter/one-prompter-server";
import {
  ACHIEVEMENTS,
  COLLECTION_CAP,
  DAILY_MISSIONS,
  DUPLICATE_SHARDS,
  LADDER_TIERS,
  LOGIN_BONUS_REWARDS,
  MAX_LEVEL,
  MAX_LIMIT_BREAK,
  RIVAL_GHOST_PRESETS,
  STARTER_CARDS,
  abyssEnemyDeck,
  abyssRewards,
  appraiseDeterministic,
  awakenCost,
  cardPowerScore,
  dismantleShards,
  fallbackWords,
  ladderDeck,
  levelUpCost,
  limitBreakCost,
  nextTier,
  validateAiWords,
  type AiWords,
  type ImageFeatures,
  type LllCard,
  type LllTier,
  type RewardBundle,
} from "./lll-game";
import {
  applyAction,
  applyTacticPlay,
  autoPlayerTurn,
  createBattle,
  type BattleState,
  type PlayerAction,
} from "./lll-battle";
import {
  ENEMY_TACTIC_DECK_BY_TIER,
  TACTIC_CARD_BY_ID,
  TACTIC_DECKS,
  tacticDeckList,
} from "./lll-tactics";

export class LllError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type DailyProgress = {
  scout: number;
  wins: number;
  tactics: number;
  weakHits: number;
};

export type LllProfile = {
  token: string;
  cards: LllCard[];
  teamIds: string[];
  shards: number;
  lumen: number;
  tickets: number;
  clearedTiers: number[];
  wins: number;
  losses: number;
  draws: number;
  createdAt: number;
  /** 高密度化: 選択中の戦術プリセットデッキID（"custom" なら customTacticDeck を使用）。 */
  tacticDeckId: string;
  customTacticDeck: Record<string, number> | null;
  playerName: string;
  favoriteCardId: string | null;
  lockedCardIds: string[];
  loginStreak: number;
  lastLoginDate: string | null;
  dailyDate: string;
  dailyProgress: DailyProgress;
  dailyClaimed: string[];
  achievementsClaimed: string[];
  abyssBestFloor: number;
  pvpRating: number;
};

type LllBattleRecord = {
  battleId: string;
  token: string;
  tierIndex: number;
  mode: "ladder" | "abyss" | "pvp";
  floor?: number;
  rivalId?: string;
  rivalRating?: number;
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

function jstDateString(offsetDays = 0): string {
  return new Date(Date.now() + 9 * 3600_000 + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

function isProfile(value: unknown): value is LllProfile {
  if (!value || typeof value !== "object") return false;
  const p = value as Partial<LllProfile>;
  return typeof p.token === "string" && Array.isArray(p.cards) && Array.isArray(p.teamIds);
}

/** kv から読んだ旧形式プロフィールに不足フィールドの既定値を補う。 */
function normalizeProfile(value: LllProfile): LllProfile {
  const today = jstDateString();
  const dp = (value as Partial<LllProfile>).dailyProgress;
  const customDeck = (value as Partial<LllProfile>).customTacticDeck;
  const validTactic =
    typeof value.tacticDeckId === "string" &&
    (value.tacticDeckId in TACTIC_DECKS || (value.tacticDeckId === "custom" && customDeck != null))
      ? value.tacticDeckId
      : "chain";
  return {
    token: value.token,
    cards: Array.isArray(value.cards) ? value.cards : [],
    teamIds: Array.isArray(value.teamIds) ? value.teamIds : [],
    shards: typeof value.shards === "number" ? value.shards : 0,
    lumen: typeof value.lumen === "number" ? value.lumen : 0,
    tickets: typeof (value as Partial<LllProfile>).tickets === "number" ? (value as Partial<LllProfile>).tickets! : 3,
    clearedTiers: Array.isArray(value.clearedTiers) ? value.clearedTiers : [],
    wins: typeof value.wins === "number" ? value.wins : 0,
    losses: typeof value.losses === "number" ? value.losses : 0,
    draws: typeof value.draws === "number" ? value.draws : 0,
    createdAt: typeof value.createdAt === "number" ? value.createdAt : Date.now(),
    tacticDeckId: validTactic,
    customTacticDeck: customDeck && typeof customDeck === "object" ? customDeck : null,
    playerName:
      typeof (value as Partial<LllProfile>).playerName === "string" && (value as Partial<LllProfile>).playerName!.trim()
        ? (value as Partial<LllProfile>).playerName!.trim().slice(0, 16)
        : "調律者",
    favoriteCardId:
      typeof (value as Partial<LllProfile>).favoriteCardId === "string"
        ? (value as Partial<LllProfile>).favoriteCardId!
        : null,
    lockedCardIds: Array.isArray((value as Partial<LllProfile>).lockedCardIds)
      ? (value as Partial<LllProfile>).lockedCardIds!
      : [],
    loginStreak:
      typeof (value as Partial<LllProfile>).loginStreak === "number" ? (value as Partial<LllProfile>).loginStreak! : 0,
    lastLoginDate:
      typeof (value as Partial<LllProfile>).lastLoginDate === "string"
        ? (value as Partial<LllProfile>).lastLoginDate!
        : null,
    dailyDate:
      typeof (value as Partial<LllProfile>).dailyDate === "string" ? (value as Partial<LllProfile>).dailyDate! : today,
    dailyProgress: {
      scout: typeof dp?.scout === "number" ? dp.scout : 0,
      wins: typeof dp?.wins === "number" ? dp.wins : 0,
      tactics: typeof dp?.tactics === "number" ? dp.tactics : 0,
      weakHits: typeof dp?.weakHits === "number" ? dp.weakHits : 0,
    },
    dailyClaimed: Array.isArray((value as Partial<LllProfile>).dailyClaimed)
      ? (value as Partial<LllProfile>).dailyClaimed!
      : [],
    achievementsClaimed: Array.isArray((value as Partial<LllProfile>).achievementsClaimed)
      ? (value as Partial<LllProfile>).achievementsClaimed!
      : [],
    abyssBestFloor:
      typeof (value as Partial<LllProfile>).abyssBestFloor === "number"
        ? (value as Partial<LllProfile>).abyssBestFloor!
        : 0,
    pvpRating:
      typeof (value as Partial<LllProfile>).pvpRating === "number" ? (value as Partial<LllProfile>).pvpRating! : 1000,
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
    await tableUpsert(
      PROFILES_NAMESPACE,
      { token: profile.token, data: deepClone(profile), updated_at: new Date().toISOString() },
      "token",
    );
  } catch {
    // 書けなくてもメモリ上の状態が正として処理は続ける
  }
}

async function persistBattle(record: LllBattleRecord): Promise<void> {
  if (!isBotApiConfigured()) return;
  try {
    await tableUpsert(
      BATTLES_NAMESPACE,
      { id: record.battleId, data: deepClone(record), updated_at: new Date().toISOString() },
      "id",
    );
  } catch {
    // 同上
  }
}

/** 専用テーブルから1行読み、無ければ移行前の bot_kv へフォールバックする。 */
async function readStoredRow(
  table: string,
  keyColumn: "token" | "id",
  key: string,
): Promise<unknown | null> {
  const rows = await tableSelect<{ data: unknown }>(
    table,
    "data",
    [{ column: keyColumn, op: "eq", value: key }],
    1,
  );
  if (rows.length > 0) return rows[0].data ?? null;
  return kvGet(table, key);
}

/** メモリに無いプロフィールを DB からオンデマンドで読み込む。 */
async function loadProfile(token: string): Promise<LllProfile | null> {
  const cached = profiles.get(token);
  if (cached) return cached;
  if (isBotApiConfigured()) {
    try {
      const stored = await readStoredRow(PROFILES_NAMESPACE, "token", token);
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
      const stored = await readStoredRow(BATTLES_NAMESPACE, "id", battleId);
      if (isBattleRecord(stored)) {
        const record: LllBattleRecord = {
          battleId: stored.battleId,
          token: stored.token,
          tierIndex: typeof stored.tierIndex === "number" ? stored.tierIndex : 0,
          mode: stored.mode === "abyss" || stored.mode === "pvp" ? stored.mode : "ladder",
          floor: typeof stored.floor === "number" ? stored.floor : undefined,
          rivalId: typeof stored.rivalId === "string" ? stored.rivalId : undefined,
          rivalRating: typeof stored.rivalRating === "number" ? stored.rivalRating : undefined,
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

function grantRewards(profile: LllProfile, reward: RewardBundle): void {
  profile.shards += reward.shards;
  profile.lumen += reward.lumen;
  profile.tickets += reward.tickets;
}

function syncDailyAndLogin(profile: LllProfile): { day: number; reward: RewardBundle } | null {
  const today = jstDateString();
  if (profile.dailyDate !== today) {
    profile.dailyDate = today;
    profile.dailyProgress = { scout: 0, wins: 0, tactics: 0, weakHits: 0 };
    profile.dailyClaimed = [];
  }
  if (profile.lastLoginDate !== today) {
    const yesterday = jstDateString(-1);
    const nextStreak =
      profile.lastLoginDate === yesterday ? ((profile.loginStreak || 0) % LOGIN_BONUS_REWARDS.length) + 1 : 1;
    profile.loginStreak = nextStreak;
    profile.lastLoginDate = today;
    const reward = LOGIN_BONUS_REWARDS[(nextStreak - 1) % LOGIN_BONUS_REWARDS.length];
    grantRewards(profile, reward);
    return { day: nextStreak, reward };
  }
  return null;
}

// --- プロフィール ---

export async function getOrCreateProfile(
  token?: string | null,
): Promise<{ token: string; profile: LllProfile; loginBonus: { day: number; reward: RewardBundle } | null }> {
  return serialize(async () => {
    if (typeof token === "string" && token.length >= 16 && token.length <= 64) {
      const existing = await loadProfile(token);
      if (existing) {
        const loginBonus = syncDailyAndLogin(existing);
        if (loginBonus) await persistProfile(existing);
        return { token: existing.token, profile: existing, loginBonus };
      }
    }
    const newToken = newPlayerToken();
    const cards = deepClone(STARTER_CARDS) as LllCard[];
    const today = jstDateString();
    const profile: LllProfile = {
      token: newToken,
      cards,
      teamIds: cards.map((card) => card.id),
      shards: 0,
      lumen: 0,
      tickets: 3,
      clearedTiers: [],
      wins: 0,
      losses: 0,
      draws: 0,
      createdAt: Date.now(),
      tacticDeckId: "chain",
      customTacticDeck: null,
      playerName: "調律者",
      favoriteCardId: cards[0]?.id ?? null,
      lockedCardIds: [],
      loginStreak: 0,
      lastLoginDate: null,
      dailyDate: today,
      dailyProgress: { scout: 0, wins: 0, tactics: 0, weakHits: 0 },
      dailyClaimed: [],
      achievementsClaimed: [],
      abyssBestFloor: 0,
      pvpRating: 1000,
    };
    const loginBonus = syncDailyAndLogin(profile);
    profiles.set(newToken, profile);
    await persistProfile(profile);
    return { token: newToken, profile, loginBonus };
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
/**
 * 鑑定モデルの優先順。既定モデルの次に、Logfare の公開カタログで画像入力
 * 対応（chat_vision）が確認できるモデルを並べ、最後に自動ルーティング。
 * 既定モデルはカタログ未掲載で、自動ルーティングはテキスト専用のため、
 * どちらかが画像入力で失敗しても AI の言葉生成を諦めないための並び
 * （2026-11-10 に GET /v1/models で実測して選定）。
 */
const APPRAISE_MODEL_CHAIN: string[] = [
  DEFAULT_LLL_MODEL,
  "gemma-4-26b",
  "gemma-4-31b-it",
  "qwen-3.8-27b",
  "logfare/auto",
];

export async function appraiseWordsWithLogfare(imageDataUrl: string): Promise<AiWords | null> {
  const keys = logfareApiKeys();
  if (keys.length === 0) return null;
  // 失敗理由は必ずログに残す（キーや応答本文は出さない）。
  const override = process.env.LLL_MODEL?.trim();
  const models = [...new Set([...(override ? [override] : []), ...APPRAISE_MODEL_CHAIN])];
  for (let index = 0; index < models.length; index++) {
    const model = models[index];
    const words = await appraiseWordsWithModel(imageDataUrl, keys, model, APPRAISE_WORDS_PROMPT);
    if (words) return words;
    // 形式崩れの可能性があるため、短い上限を再強調したプロンプトでもう一度だけ試す。
    // 再試行は先頭候補だけに絞り、候補全体を回る場合の待ち時間を抑える。
    if (index === 0) {
      const retry = await appraiseWordsWithModel(
        imageDataUrl,
        keys,
        model,
        APPRAISE_WORDS_PROMPT + "\n重要: name は12文字以内、flavor は40文字以内、技名と特性名は10文字以内に短くしてください。",
      );
      if (retry) return retry;
    }
  }
  return null;
}

async function appraiseWordsWithModel(
  imageDataUrl: string,
  keys: string[],
  model: string,
  prompt: string,
): Promise<AiWords | null> {
  const payload = {
    model,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
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
    } catch (error) {
      // ネットワークエラー・タイムアウトはキーを替えても直らないので諦める
      console.warn(`lll: Logfare appraise request failed (model=${model}): ${error instanceof Error ? error.message : "unknown"}`);
      return null;
    }
    if (response.status === 429) {
      console.warn(`lll: Logfare key #${i + 1} returned 429, failing over to next key`);
      continue;
    }
    if (!response.ok) {
      console.warn(`lll: Logfare appraise failed (model=${model}, status=${response.status})`);
      return null;
    }
    let content: string;
    try {
      content = extractChatContent(await response.json());
    } catch {
      console.warn(`lll: Logfare appraise response was not JSON (model=${model})`);
      return null;
    }
    if (!content) {
      console.warn(`lll: Logfare appraise returned empty content (model=${model})`);
      return null;
    }
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn(`lll: Logfare appraise content had no JSON object (model=${model}, length=${content.length})`);
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch {
      console.warn(`lll: Logfare appraise JSON parse failed (model=${model})`);
      return null;
    }
    const words = validateAiWords(parsed);
    if (!words) {
      console.warn(`lll: Logfare appraise words failed validation (model=${model})`);
      return null;
    }
    return words;
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
  limitBroken?: boolean;
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
    profile.dailyProgress.scout += 1;

    // 同一画像の再スカウトはカードを増やさず欠片＋自動限界突破に変換する
    const existing = profile.cards.find((card) => card.imageHash === imageSha);
    if (existing) {
      const shardsGained = duplicateShardsFor(existing.tier);
      profile.shards += shardsGained;
      let limitBroken = false;
      if ((existing.limitBreak ?? 0) < MAX_LIMIT_BREAK) {
        existing.limitBreak = (existing.limitBreak ?? 0) + 1;
        limitBroken = true;
      }
      await persistProfile(profile);
      return { profile, card: null, duplicated: true, shardsGained, limitBroken, aiUsed: false };
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

const SUMMON_GLYPHS: Record<LllCard["element"], string[]> = {
  fire: ["炎", "焔", "龍"],
  water: ["星", "雫", "蒼"],
  wind: ["嵐", "翠", "羽"],
  earth: ["岩", "翠", "盾"],
  light: ["光", "剣", "聖"],
  dark: ["月", "影", "冠"],
};

/** スカウト券を1枚消費してエリート以上確定の英霊を召喚する（画像不要ガチャ）。 */
export async function ticketSummon(token: string): Promise<AppraiseResult> {
  return serialize(async () => {
    const profile = await requireProfile(token);
    if (profile.tickets < 1) throw new LllError(400, "スカウト券が足りません。");
    if (profile.cards.length >= COLLECTION_CAP) {
      throw new LllError(400, "バインダーがいっぱいです");
    }
    profile.tickets -= 1;
    profile.dailyProgress.scout += 1;

    const raw = randomBytes(16);
    const seedHex = raw.toString("hex");
    const u = (idx: number) => raw[idx] / 255;
    const isLegend = raw[0] < 52; // 約20%でレジェンド、残り80%エリート
    const features: ImageFeatures = {
      hue: Math.round((raw[1] / 255) * 360),
      saturation: isLegend ? 0.85 + u(2) * 0.14 : 0.65 + u(2) * 0.3,
      brightness: 0.35 + u(3) * 0.45,
      colorVariance: isLegend ? 0.5 + u(4) * 0.45 : 0.35 + u(4) * 0.5,
      edgeComplexity: isLegend ? 0.65 + u(5) * 0.3 : 0.45 + u(5) * 0.45,
      warmth: u(6),
      coolness: 1 - u(6),
      pixelHash: seedHex.slice(0, 8),
    };
    const words = fallbackWords(features, seedHex);
    const card = appraiseDeterministic(features, seedHex, words, Date.now());
    card.id = `summon_${seedHex.slice(0, 14)}`;
    card.tier = isLegend ? "legend" : "elite";
    // エリート以上確定の最低保証を担保
    const minTotal = isLegend ? 410 : 350;
    const currentTotal = card.stats.hp + card.stats.atk + card.stats.def + card.stats.spd;
    if (currentTotal < minTotal) {
      const bonus = Math.ceil((minTotal - currentTotal) / 4);
      card.stats.hp += bonus;
      card.stats.atk += bonus;
      card.stats.def += bonus;
      card.stats.spd += bonus;
    }
    const glyphs = SUMMON_GLYPHS[card.element];
    card.glyph = glyphs[raw[7] % glyphs.length];
    profile.cards.push(card);
    await persistProfile(profile);
    return { profile, card, duplicated: false, shardsGained: 0, aiUsed: false };
  });
}

// --- チーム編成・強化・コレクション管理 ---

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

export async function limitBreakCard(
  token: string,
  cardId: string,
): Promise<{ profile: LllProfile; card: LllCard }> {
  return serialize(async () => {
    const profile = await requireProfile(token);
    const card = profile.cards.find((c) => c.id === cardId);
    if (!card) throw new LllError(404, "カードが見つかりません。");
    const currentLb = card.limitBreak ?? 0;
    if (currentLb >= MAX_LIMIT_BREAK) throw new LllError(400, "限界突破は最大です。");
    const cost = limitBreakCost(currentLb);
    if (profile.shards < cost) throw new LllError(400, "欠片が足りません。");
    profile.shards -= cost;
    card.limitBreak = currentLb + 1;
    await persistProfile(profile);
    return { profile, card };
  });
}

export async function awakenCard(
  token: string,
  cardId: string,
): Promise<{ profile: LllProfile; card: LllCard }> {
  return serialize(async () => {
    const profile = await requireProfile(token);
    const card = profile.cards.find((c) => c.id === cardId);
    if (!card) throw new LllError(404, "カードが見つかりません。");
    const next = nextTier(card.tier);
    const cost = awakenCost(card.tier);
    if (!next || !cost) throw new LllError(400, "これ以上覚醒できません。");
    if (profile.shards < cost.shards) throw new LllError(400, "欠片が足りません。");
    if (profile.lumen < cost.lumen) throw new LllError(400, "ルーメンが足りません。");
    profile.shards -= cost.shards;
    profile.lumen -= cost.lumen;
    card.tier = next;
    card.awakened = true;
    // 覚醒ボーナスで基礎ステータスを底上げ（総量500上限内）
    const total = card.stats.hp + card.stats.atk + card.stats.def + card.stats.spd;
    const room = Math.max(0, 500 - total);
    const addEach = Math.min(14, Math.floor(room / 4));
    card.stats.hp += addEach;
    card.stats.atk += addEach;
    card.stats.def += addEach;
    card.stats.spd += addEach;
    await persistProfile(profile);
    return { profile, card };
  });
}

export async function dismantleCards(
  token: string,
  cardIds: string[],
): Promise<{ profile: LllProfile; shardsGained: number; removedIds: string[] }> {
  return serialize(async () => {
    const profile = await requireProfile(token);
    const uniqueIds = [...new Set(cardIds)];
    if (uniqueIds.length === 0) throw new LllError(400, "分解するカードを選択してください。");
    const lockedSet = new Set(profile.lockedCardIds);
    const teamSet = new Set(profile.teamIds);
    const toRemove: LllCard[] = [];
    for (const id of uniqueIds) {
      const card = profile.cards.find((c) => c.id === id);
      if (!card) throw new LllError(404, "分解対象のカードが見つかりません。");
      if (teamSet.has(id)) throw new LllError(400, "チーム編成中のカードは分解できません。");
      if (lockedSet.has(id)) throw new LllError(400, "保護中のカードは分解できません。");
      toRemove.push(card);
    }
    if (profile.cards.length - toRemove.length < 3) {
      throw new LllError(400, "手持ちが3枚未満になるため分解できません。");
    }
    let shardsGained = 0;
    const removeSet = new Set(uniqueIds);
    for (const card of toRemove) shardsGained += dismantleShards(card);
    profile.cards = profile.cards.filter((c) => !removeSet.has(c.id));
    if (profile.favoriteCardId && removeSet.has(profile.favoriteCardId)) {
      profile.favoriteCardId = profile.teamIds[0] ?? profile.cards[0]?.id ?? null;
    }
    profile.shards += shardsGained;
    await persistProfile(profile);
    return { profile, shardsGained, removedIds: uniqueIds };
  });
}

export async function toggleLockCard(
  token: string,
  cardId: string,
): Promise<{ profile: LllProfile; locked: boolean }> {
  return serialize(async () => {
    const profile = await requireProfile(token);
    if (!profile.cards.some((c) => c.id === cardId)) throw new LllError(404, "カードが見つかりません。");
    const exists = profile.lockedCardIds.includes(cardId);
    profile.lockedCardIds = exists
      ? profile.lockedCardIds.filter((id) => id !== cardId)
      : [...profile.lockedCardIds, cardId];
    await persistProfile(profile);
    return { profile, locked: !exists };
  });
}

export async function setFavoriteCard(token: string, cardId: string): Promise<LllProfile> {
  return serialize(async () => {
    const profile = await requireProfile(token);
    if (!profile.cards.some((c) => c.id === cardId)) throw new LllError(404, "カードが見つかりません。");
    profile.favoriteCardId = cardId;
    await persistProfile(profile);
    return profile;
  });
}

export async function setPlayerName(token: string, name: string): Promise<LllProfile> {
  return serialize(async () => {
    const profile = await requireProfile(token);
    const cleaned = name.trim().slice(0, 16);
    if (!cleaned) throw new LllError(400, "プレイヤー名を入力してください。");
    profile.playerName = cleaned;
    await persistProfile(profile);
    return profile;
  });
}

export async function setCustomTacticDeck(
  token: string,
  counts: Record<string, number>,
): Promise<LllProfile> {
  return serialize(async () => {
    const profile = await requireProfile(token);
    let total = 0;
    const normalized: Record<string, number> = {};
    for (const [cardId, rawCount] of Object.entries(counts)) {
      if (!TACTIC_CARD_BY_ID.has(cardId)) {
        throw new LllError(400, `不明な戦術カードIDです: ${cardId}`);
      }
      if (!Number.isInteger(rawCount) || rawCount < 0 || rawCount > 3) {
        throw new LllError(400, "同名カードは0〜3枚にしてください。");
      }
      if (rawCount > 0) {
        normalized[cardId] = rawCount;
        total += rawCount;
      }
    }
    if (total !== 30) throw new LllError(400, `戦術デッキはちょうど30枚にしてください（現在 ${total} 枚）。`);
    profile.customTacticDeck = normalized;
    profile.tacticDeckId = "custom";
    await persistProfile(profile);
    return profile;
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

// --- ミッション / 実績 ---

function isAchievementEligible(profile: LllProfile, id: string): boolean {
  switch (id) {
    case "ach_cards_5":
      return profile.cards.length >= 5;
    case "ach_cards_12":
      return profile.cards.length >= 12;
    case "ach_wins_5":
      return profile.wins >= 5;
    case "ach_legend_1":
      return profile.cards.some((c) => c.tier === "legend");
    case "ach_lv10_1":
      return profile.cards.some((c) => c.level >= MAX_LEVEL);
    case "ach_abyss_5":
      return profile.abyssBestFloor >= 5;
    default:
      return false;
  }
}

export async function claimMission(
  token: string,
  kind: "daily" | "achievement",
  id: string,
): Promise<{ profile: LllProfile; reward: RewardBundle }> {
  return serialize(async () => {
    const profile = await requireProfile(token);
    syncDailyAndLogin(profile);
    if (kind === "daily") {
      const def = DAILY_MISSIONS.find((m) => m.id === id);
      if (!def) throw new LllError(404, "デイリーミッションが見つかりません。");
      if (profile.dailyClaimed.includes(id)) throw new LllError(400, "この報酬は受け取り済みです。");
      if ((profile.dailyProgress[def.metric] ?? 0) < def.target) {
        throw new LllError(400, "まだ達成条件を満たしていません。");
      }
      profile.dailyClaimed = [...profile.dailyClaimed, id];
      grantRewards(profile, def.reward);
      await persistProfile(profile);
      return { profile, reward: def.reward };
    }
    const ach = ACHIEVEMENTS.find((a) => a.id === id);
    if (!ach) throw new LllError(404, "実績が見つかりません。");
    if (profile.achievementsClaimed.includes(id)) throw new LllError(400, "この実績報酬は受け取り済みです。");
    if (!isAchievementEligible(profile, id)) throw new LllError(400, "実績条件を満たしていません。");
    profile.achievementsClaimed = [...profile.achievementsClaimed, id];
    grantRewards(profile, ach.reward);
    await persistProfile(profile);
    return { profile, reward: ach.reward };
  });
}

// --- バトル（アリーナ / 深淵 / 模擬PvP） ---

function resolvePlayerTacticList(profile: LllProfile, tacticDeckId?: string): string[] | null {
  const chosen = tacticDeckId ?? profile.tacticDeckId;
  if (chosen === "custom") {
    if (!profile.customTacticDeck) return tacticDeckList("chain");
    const out: string[] = [];
    for (const [cardId, count] of Object.entries(profile.customTacticDeck)) {
      for (let i = 0; i < count; i++) out.push(cardId);
    }
    return out.length === 30 ? out : tacticDeckList("chain");
  }
  return tacticDeckList(chosen);
}

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

function publicBattle(state: BattleState): BattleState {
  const view = deepClone(state);
  if (view.tactics) {
    const t = view.tactics as unknown as Record<string, Record<string, unknown>>;
    const player = t.player;
    player.deckCount = (player.deck as string[]).length;
    player.deck = [];
    player.lastPlayedEffects = null;
    const cpu = t.cpu;
    cpu.handCount = (cpu.hand as string[]).length;
    cpu.hand = [];
    cpu.deckCount = (cpu.deck as string[]).length;
    cpu.deck = [];
    cpu.reserveCount = (cpu.reserves as string[]).length;
    cpu.reserves = [];
    cpu.lastPlayedEffects = null;
    (view.tactics as unknown as Record<string, unknown>).stack = [];
    (view.tactics as unknown as Record<string, unknown>).effectDepth = 0;
  }
  return view;
}

function trackEventsInProfile(profile: LllProfile, state: BattleState, fromLogIndex: number): void {
  const events = state.log.slice(fromLogIndex);
  for (const ev of events) {
    if (ev.type === "damage" && ev.actorKey?.startsWith("player_") && typeof ev.affinity === "number" && ev.affinity >= 1.25) {
      profile.dailyProgress.weakHits += 1;
    }
  }
}

/** 終局していたら報酬を1回だけ付与する（モード別・行動・戦術プレイ共通）。 */
async function settleIfFinished(profile: LllProfile, record: LllBattleRecord): Promise<void> {
  const next = record.state;
  if (next.phase !== "finished" || record.rewarded) return;
  record.rewarded = true;
  const outcome = battleOutcome(next);

  if (record.mode === "abyss") {
    const floor = record.floor ?? 1;
    const rew = abyssRewards(floor);
    if (outcome === "win") {
      const firstClear = floor > profile.abyssBestFloor;
      const mult = firstClear ? 1.5 : 1;
      profile.shards += Math.round(rew.shards * mult);
      profile.lumen += Math.round(rew.lumen * mult);
      if (firstClear) {
        profile.tickets += rew.tickets;
        profile.abyssBestFloor = floor;
      }
      profile.wins += 1;
      profile.dailyProgress.wins += 1;
    } else if (outcome === "lose") {
      profile.shards += Math.max(4, Math.floor(rew.shards * 0.25));
      profile.losses += 1;
    } else {
      profile.shards += Math.max(3, Math.floor(rew.shards * 0.2));
      profile.draws += 1;
    }
    await persistProfile(profile);
    return;
  }

  if (record.mode === "pvp") {
    const rivalRating = record.rivalRating ?? 1000;
    const expected = 1 / (1 + 10 ** ((rivalRating - profile.pvpRating) / 400));
    const score = outcome === "win" ? 1 : outcome === "draw" ? 0.5 : 0;
    const delta = Math.round(32 * (score - expected));
    profile.pvpRating = Math.max(800, profile.pvpRating + delta);
    if (outcome === "win") {
      profile.shards += 24;
      profile.lumen += 90;
      profile.wins += 1;
      profile.dailyProgress.wins += 1;
    } else if (outcome === "lose") {
      profile.shards += 8;
      profile.lumen += 20;
      profile.losses += 1;
    } else {
      profile.shards += 12;
      profile.draws += 1;
    }
    await persistProfile(profile);
    return;
  }

  const rewards = tierRewards(record.tierIndex);
  if (outcome === "win") {
    const firstClear = !profile.clearedTiers.includes(record.tierIndex);
    const multiplier = firstClear ? 2 : 1;
    profile.shards += rewards.winShards * multiplier;
    profile.lumen += rewards.winLumen * multiplier;
    if (firstClear) profile.clearedTiers = [...profile.clearedTiers, record.tierIndex].sort((a, b) => a - b);
    profile.wins += 1;
    profile.dailyProgress.wins += 1;
  } else if (outcome === "lose") {
    profile.shards += rewards.loseShards;
    profile.losses += 1;
  } else {
    profile.shards += Math.floor(rewards.loseShards / 2);
    profile.draws += 1;
  }
  await persistProfile(profile);
}

function getValidatedTeam(profile: LllProfile): LllCard[] {
  const teamCards: LllCard[] = [];
  for (const id of profile.teamIds) {
    const card = profile.cards.find((c) => c.id === id);
    if (card) teamCards.push(card);
  }
  if (teamCards.length !== 3) throw new LllError(400, "チームは3枚で編成してください。");
  return teamCards;
}

function applyTacticSelection(profile: LllProfile, tacticDeckId?: string): void {
  if (tacticDeckId === undefined) return;
  const valid =
    tacticDeckId in TACTIC_DECKS || (tacticDeckId === "custom" && profile.customTacticDeck !== null);
  if (!valid) throw new LllError(400, "戦術デッキの指定が正しくありません。");
  if (tacticDeckId !== profile.tacticDeckId) {
    profile.tacticDeckId = tacticDeckId;
  }
}

export async function startBattle(
  token: string,
  tierIndex: number,
  tacticDeckId?: string,
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
    const teamCards = getValidatedTeam(profile);
    applyTacticSelection(profile, tacticDeckId);
    await persistProfile(profile);
    const enemyDeckId = ENEMY_TACTIC_DECK_BY_TIER[tierIndex] ?? null;
    const battleId = newBattleId();
    let state: BattleState;
    try {
      state = createBattle(battleId, deepClone(teamCards), ladderDeck(tierIndex), tierIndex, randomSeed(), {
        mode: "ladder",
        title: LADDER_TIERS[tierIndex]?.name,
        tacticDecks: {
          player: resolvePlayerTacticList(profile),
          cpu: enemyDeckId ? tacticDeckList(enemyDeckId) : null,
        },
      });
    } catch (error) {
      throw new LllError(400, error instanceof Error ? error.message : "対戦を開始できませんでした。");
    }
    const now = Date.now();
    const record: LllBattleRecord = {
      battleId,
      token,
      tierIndex,
      mode: "ladder",
      state,
      rewarded: false,
      createdAt: now,
      updatedAt: now,
    };
    battles.set(battleId, record);
    await persistBattle(record);
    return { battleId, battle: publicBattle(state) };
  });
}

export async function startAbyssBattle(
  token: string,
  floor: number,
  tacticDeckId?: string,
): Promise<{ battleId: string; battle: BattleState }> {
  return serialize(async () => {
    const profile = await requireProfile(token);
    if (!Number.isInteger(floor) || floor < 1 || floor > profile.abyssBestFloor + 1) {
      throw new LllError(400, "この階層はまだ解放されていません。");
    }
    const teamCards = getValidatedTeam(profile);
    applyTacticSelection(profile, tacticDeckId);
    await persistProfile(profile);
    const enemyDeckId = floor >= 10 ? "pursuit" : floor >= 4 ? "chain" : null;
    const battleId = newBattleId();
    let state: BattleState;
    try {
      state = createBattle(battleId, deepClone(teamCards), abyssEnemyDeck(floor), Math.min(7, floor), randomSeed(), {
        mode: "abyss",
        floor,
        title: `深淵 第${floor}階層${floor % 5 === 0 ? "（BOSS）" : ""}`,
        tacticDecks: {
          player: resolvePlayerTacticList(profile),
          cpu: enemyDeckId ? tacticDeckList(enemyDeckId) : null,
        },
      });
    } catch (error) {
      throw new LllError(400, error instanceof Error ? error.message : "対戦を開始できませんでした。");
    }
    const now = Date.now();
    const record: LllBattleRecord = {
      battleId,
      token,
      tierIndex: Math.min(7, floor),
      mode: "abyss",
      floor,
      state,
      rewarded: false,
      createdAt: now,
      updatedAt: now,
    };
    battles.set(battleId, record);
    await persistBattle(record);
    return { battleId, battle: publicBattle(state) };
  });
}

export type PvpRivalSummary = {
  id: string;
  playerName: string;
  title: string;
  rating: number;
  tacticDeckId: string;
  powerScore: number;
  cards: LllCard[];
};

function resolveCachedRivalMap(excludeToken: string): Map<string, PvpRivalSummary> {
  const map = new Map<string, PvpRivalSummary>();
  for (const preset of RIVAL_GHOST_PRESETS) {
    const powerScore = preset.cards.reduce((sum, c) => sum + cardPowerScore(c), 0);
    map.set(preset.id, {
      id: preset.id,
      playerName: preset.playerName,
      title: preset.title,
      rating: preset.rating,
      tacticDeckId: preset.tacticDeckId,
      powerScore,
      cards: deepClone(preset.cards),
    });
  }
  let added = 0;
  for (const p of profiles.values()) {
    if (p.token === excludeToken || added >= 5) continue;
    const team: LllCard[] = [];
    for (const id of p.teamIds) {
      const c = p.cards.find((card) => card.id === id);
      if (c) team.push(c);
    }
    if (team.length !== 3) continue;
    const id = `player_${createHash("sha256").update(p.token).digest("hex").slice(0, 12)}`;
    const powerScore = team.reduce((sum, c) => sum + cardPowerScore(c), 0);
    map.set(id, {
      id,
      playerName: p.playerName || "調律者",
      title: `模擬対戦ユーザー (${p.wins}勝)`,
      rating: p.pvpRating || 1000,
      tacticDeckId: p.tacticDeckId in TACTIC_DECKS ? p.tacticDeckId : "chain",
      powerScore,
      cards: deepClone(team).map((c) => {
        const copy = { ...c };
        delete copy.imageDataUrl; // 帯域節約
        return copy;
      }),
    });
    added += 1;
  }
  return map;
}

export async function listPvpRivals(token: string): Promise<PvpRivalSummary[]> {
  return serialize(async () => {
    await requireProfile(token);
    return [...resolveCachedRivalMap(token).values()];
  });
}

export async function startPvpBattle(
  token: string,
  rivalId: string,
  tacticDeckId?: string,
): Promise<{ battleId: string; battle: BattleState }> {
  return serialize(async () => {
    const profile = await requireProfile(token);
    const rivals = resolveCachedRivalMap(token);
    const rival = rivals.get(rivalId);
    if (!rival) throw new LllError(404, "対戦相手が見つかりません。");
    const teamCards = getValidatedTeam(profile);
    applyTacticSelection(profile, tacticDeckId);
    await persistProfile(profile);
    const battleId = newBattleId();
    let state: BattleState;
    try {
      state = createBattle(battleId, deepClone(teamCards), deepClone(rival.cards), 7, randomSeed(), {
        mode: "pvp",
        rivalName: rival.playerName,
        title: `模擬PvP vs ${rival.playerName}`,
        tacticDecks: {
          player: resolvePlayerTacticList(profile),
          cpu: tacticDeckList(rival.tacticDeckId),
        },
      });
    } catch (error) {
      throw new LllError(400, error instanceof Error ? error.message : "対戦を開始できませんでした。");
    }
    const now = Date.now();
    const record: LllBattleRecord = {
      battleId,
      token,
      tierIndex: 7,
      mode: "pvp",
      rivalId,
      rivalRating: rival.rating,
      state,
      rewarded: false,
      createdAt: now,
      updatedAt: now,
    };
    battles.set(battleId, record);
    await persistBattle(record);
    return { battleId, battle: publicBattle(state) };
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
      return { battle: publicBattle(record.state), profile };
    }
    const prevLogLen = record.state.log.length;
    let next: BattleState;
    try {
      next = applyAction(record.state, action);
    } catch (error) {
      throw new LllError(400, error instanceof Error ? error.message : "操作を処理できませんでした。");
    }
    record.state = next;
    record.updatedAt = Date.now();
    trackEventsInProfile(profile, next, prevLogLen);
    await settleIfFinished(profile, record);
    await persistProfile(profile);
    await persistBattle(record);
    return { battle: publicBattle(record.state), profile };
  });
}

/** 戦術カードのプレイ。手番は進まず、同じアクターの戦術フェイズが続く。 */
export async function battleTactic(
  token: string,
  battleId: string,
  cardId: string,
): Promise<{ battle: BattleState; profile: LllProfile }> {
  return serialize(async () => {
    const profile = await requireProfile(token);
    const record = await requireBattle(token, battleId);
    if (record.state.phase === "finished" && record.rewarded) {
      return { battle: publicBattle(record.state), profile };
    }
    const prevLogLen = record.state.log.length;
    try {
      applyTacticPlay(record.state, cardId);
    } catch (error) {
      throw new LllError(400, error instanceof Error ? error.message : "戦術カードを使えませんでした。");
    }
    profile.dailyProgress.tactics += 1;
    record.updatedAt = Date.now();
    trackEventsInProfile(profile, record.state, prevLogLen);
    await settleIfFinished(profile, record);
    await persistProfile(profile);
    await persistBattle(record);
    return { battle: publicBattle(record.state), profile };
  });
}

/** オートバトル1手（サーバー権威で戦術＋最善手を実行）。 */
export async function battleAutoStep(
  token: string,
  battleId: string,
): Promise<{ battle: BattleState; profile: LllProfile }> {
  return serialize(async () => {
    const profile = await requireProfile(token);
    const record = await requireBattle(token, battleId);
    if (record.state.phase === "finished" && record.rewarded) {
      return { battle: publicBattle(record.state), profile };
    }
    const prevLogLen = record.state.log.length;
    let next: BattleState;
    try {
      next = autoPlayerTurn(record.state);
    } catch (error) {
      throw new LllError(400, error instanceof Error ? error.message : "オート進行に失敗しました。");
    }
    record.state = next;
    record.updatedAt = Date.now();
    trackEventsInProfile(profile, next, prevLogLen);
    await settleIfFinished(profile, record);
    await persistProfile(profile);
    await persistBattle(record);
    return { battle: publicBattle(record.state), profile };
  });
}

export async function getBattle(token: string, battleId: string): Promise<BattleState> {
  return serialize(async () => {
    const record = await requireBattle(token, battleId);
    return publicBattle(record.state);
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

export function parseAppraiseBody(body: unknown): {
  token: string;
  ticketSummon?: boolean;
  features?: ImageFeatures;
  imageDataUrl?: string;
} {
  const data = asBody(body);
  const token = parseToken(data.token);
  if (data.action === "ticket") return { token, ticketSummon: true };
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
  | { token: string; action: "limitBreak"; cardId: string }
  | { token: string; action: "awaken"; cardId: string }
  | { token: string; action: "dismantle"; cardIds: string[] }
  | { token: string; action: "lock"; cardId: string }
  | { token: string; action: "favorite"; cardId: string }
  | { token: string; action: "customDeck"; counts: Record<string, number> }
  | { token: string; action: "playerName"; name: string }
  | { token: string; action: "exchange" };

export function parseGrowBody(body: unknown): GrowRequest {
  const data = asBody(body);
  const token = parseToken(data.token);
  if (data.action === "exchange") return { token, action: "exchange" };
  if (data.action === "dismantle") {
    if (!Array.isArray(data.cardIds) || !data.cardIds.every((id) => typeof id === "string" && id.length > 0)) {
      throw new LllError(400, "分解するカードの指定が正しくありません。");
    }
    return { token, action: "dismantle", cardIds: data.cardIds as string[] };
  }
  if (data.action === "customDeck") {
    if (!data.counts || typeof data.counts !== "object" || Array.isArray(data.counts)) {
      throw new LllError(400, "戦術デッキの形式が正しくありません。");
    }
    return { token, action: "customDeck", counts: data.counts as Record<string, number> };
  }
  if (data.action === "playerName") {
    if (typeof data.name !== "string") throw new LllError(400, "プレイヤー名が正しくありません。");
    return { token, action: "playerName", name: data.name };
  }
  if (typeof data.cardId !== "string" || data.cardId.length === 0) {
    throw new LllError(400, "カードの指定が正しくありません。");
  }
  if (data.action === "limitBreak" || data.action === "awaken" || data.action === "lock" || data.action === "favorite") {
    return { token, action: data.action, cardId: data.cardId };
  }
  return { token, action: "levelup", cardId: data.cardId };
}

export function parseBattleStartBody(body: unknown): {
  token: string;
  mode?: "ladder" | "abyss" | "pvp";
  tierIndex: number;
  floor?: number;
  rivalId?: string;
  tacticDeckId?: string;
} {
  const data = asBody(body);
  const token = parseToken(data.token);
  let tacticDeckId: string | undefined;
  if (data.tacticDeckId !== undefined) {
    if (typeof data.tacticDeckId !== "string" || (!(data.tacticDeckId in TACTIC_DECKS) && data.tacticDeckId !== "custom")) {
      throw new LllError(400, "戦術デッキの指定が正しくありません。");
    }
    tacticDeckId = data.tacticDeckId;
  }
  if (data.mode === "abyss") {
    if (typeof data.floor !== "number" || !Number.isInteger(data.floor) || data.floor < 1) {
      throw new LllError(400, "階層の指定が正しくありません。");
    }
    return { token, mode: "abyss", tierIndex: 0, floor: data.floor, tacticDeckId };
  }
  if (data.mode === "pvp") {
    if (typeof data.rivalId !== "string" || data.rivalId.length === 0) {
      throw new LllError(400, "対戦相手の指定が正しくありません。");
    }
    return { token, mode: "pvp", tierIndex: 7, rivalId: data.rivalId, tacticDeckId };
  }
  if (typeof data.tierIndex !== "number" || !Number.isInteger(data.tierIndex)) {
    throw new LllError(400, "ティアの指定が正しくありません。");
  }
  return { token, tierIndex: data.tierIndex, tacticDeckId };
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

export type BattleRequestBody =
  | { token: string; battleId: string; kind: "action"; action: PlayerAction }
  | { token: string; battleId: string; kind: "tactic"; cardId: string }
  | { token: string; battleId: string; kind: "auto" };

export function parseBattleActionBody(body: unknown): BattleRequestBody {
  const data = asBody(body);
  const token = parseToken(data.token);
  if (typeof data.battleId !== "string" || data.battleId.length === 0 || data.battleId.length > 128) {
    throw new LllError(400, "対戦IDが正しくありません。");
  }
  const rawAction = data.action as Record<string, unknown> | undefined;
  if (rawAction && typeof rawAction === "object" && rawAction.type === "auto") {
    return { token, battleId: data.battleId, kind: "auto" };
  }
  if (rawAction && typeof rawAction === "object" && rawAction.type === "tactic") {
    const cardId = rawAction.cardId;
    if (typeof cardId !== "string" || !TACTIC_CARD_BY_ID.has(cardId)) {
      throw new LllError(400, "戦術カードの指定が正しくありません。");
    }
    return { token, battleId: data.battleId, kind: "tactic", cardId };
  }
  return { token, battleId: data.battleId, kind: "action", action: parsePlayerAction(data.action) };
}

export function parseBattleId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    throw new LllError(400, "対戦IDが正しくありません。");
  }
  return value;
}

export function parseMissionBody(body: unknown): { token: string; kind: "daily" | "achievement"; id: string } {
  const data = asBody(body);
  const token = parseToken(data.token);
  if (data.kind !== "daily" && data.kind !== "achievement") {
    throw new LllError(400, "ミッション種別が正しくありません。");
  }
  if (typeof data.id !== "string" || data.id.length === 0) {
    throw new LllError(400, "ミッションIDが正しくありません。");
  }
  return { token, kind: data.kind, id: data.id };
}

