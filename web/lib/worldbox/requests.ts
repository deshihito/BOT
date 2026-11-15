// AGO WORLD BOX のギルド依頼（純粋ロジック、DOM 非依存）。
// 依頼はユニオン（国 = Discord サーバー）単位の掲示板（ロビーのギルドボード）に載る:
//   投稿: メンバーが「アイテム × 個数」と「報酬コイン」を出す。報酬は投稿時に
//         spend オプで預かる（エスクロー。材料は coin として返す）。
//   納品: 同じユニオンの他メンバーが所持アイテムを渡すと、アイテムは投稿者へ、
//         報酬は earn オプで納品者へ。
//   取消: 投稿者だけ。預かり金は earn オプで投稿者へ戻る。
// コインの正は AGO コイン本体（案B ブリッジ）: ここは残高を直接触らず、動かす
// べき額を CoinMovement（economy.ts と同じ形）として返す。保存は呼び出し側
// （API ルート）が bot_kv へ read-modify-write する。
import { itemById } from "./items";
import {
  addItem, removeItem, type PlayerProfile,
} from "./profile";
import type { CoinMovement } from "./economy";

/** 保存形式の版。 */
export const REQUESTS_STATE_VERSION = 1;
/** 1ユニオンあたりの未完了依頼の上限。 */
export const MAX_OPEN_PER_GUILD = 20;
/** 1人あたりの未完了依頼の上限。 */
export const MAX_OPEN_PER_POSTER = 5;

export type GuildRequest = {
  id: string;
  /** 掲示先ユニオン（国 = ギルド ID）。 */
  guildId: string;
  /** 投稿者の所有者キー。 */
  posterKey: string;
  /** 投稿者の表示名（投稿時点のスナップショット）。 */
  posterName: string;
  itemId: string;
  count: number;
  /** 報酬コイン総額（預かり済み）。金額の範囲はブリッジ側の検証に一致。 */
  reward: number;
  createdAt: number;
};

export type RequestsState = {
  /** 依頼 ID → 依頼。完了・取消したものは残さない。 */
  requests: Record<string, GuildRequest>;
};

export function emptyRequestsState(): RequestsState {
  return { requests: {} };
}

export type RequestError =
  | "unknown_item" | "invalid_count" | "invalid_reward"
  | "not_enough_coins" | "not_enough_items"
  | "too_many_guild" | "too_many_poster"
  | "not_found" | "not_poster" | "self_fulfill" | "wrong_guild";

export type PostResult =
  | { ok: true; state: RequestsState; request: GuildRequest; coin: CoinMovement }
  | { ok: false; error: RequestError };

/** 依頼を投稿する。残高は実残高（引数）を検証する。 */
export function postRequest(
  state: RequestsState,
  input: {
    id: string; guildId: string; posterKey: string; posterName: string;
    itemId: unknown; count: unknown; reward: unknown; now: number;
  },
  balance: number,
): PostResult {
  const item = itemById(input.itemId);
  if (!item) return { ok: false, error: "unknown_item" };
  if (typeof input.count !== "number" || !Number.isInteger(input.count)
    || input.count < 1 || input.count > 99) {
    return { ok: false, error: "invalid_count" };
  }
  if (typeof input.reward !== "number" || !Number.isInteger(input.reward)
    || input.reward < 1 || input.reward > 1_000_000) {
    return { ok: false, error: "invalid_reward" };
  }
  if (balance < input.reward) return { ok: false, error: "not_enough_coins" };
  const open = Object.values(state.requests).filter((r) => r.guildId === input.guildId);
  if (open.length >= MAX_OPEN_PER_GUILD) return { ok: false, error: "too_many_guild" };
  if (open.filter((r) => r.posterKey === input.posterKey).length >= MAX_OPEN_PER_POSTER) {
    return { ok: false, error: "too_many_poster" };
  }
  const request: GuildRequest = {
    id: input.id,
    guildId: input.guildId,
    posterKey: input.posterKey,
    posterName: input.posterName,
    itemId: item.id,
    count: input.count,
    reward: input.reward,
    createdAt: input.now,
  };
  return {
    ok: true,
    state: { requests: { ...state.requests, [request.id]: request } },
    request,
    coin: { kind: "spend", amount: request.reward, reason: "guild_request_escrow" },
  };
}

export type FulfillResult =
  | {
    ok: true; state: RequestsState; request: GuildRequest;
    fulfillerProfile: PlayerProfile; posterProfile: PlayerProfile;
    coin: CoinMovement;
  }
  | { ok: false; error: RequestError };

/** 納品する。納品者の所持からアイテムを減らし、投稿者へ足す（全量のみ）。 */
export function fulfillRequest(
  state: RequestsState,
  requestId: string,
  guildId: string,
  fulfillerKey: string,
  fulfillerProfile: PlayerProfile,
  posterProfile: PlayerProfile,
): FulfillResult {
  const request = state.requests[requestId];
  if (!request) return { ok: false, error: "not_found" };
  if (request.guildId !== guildId) return { ok: false, error: "wrong_guild" };
  if (request.posterKey === fulfillerKey) return { ok: false, error: "self_fulfill" };
  const removed = removeItem(fulfillerProfile, request.itemId, request.count);
  if (!removed) return { ok: false, error: "not_enough_items" };
  const requests = { ...state.requests };
  delete requests[requestId];
  return {
    ok: true,
    state: { requests },
    request,
    fulfillerProfile: removed,
    posterProfile: addItem(posterProfile, request.itemId, request.count),
    coin: { kind: "earn", amount: request.reward, reason: "guild_request_reward" },
  };
}

export type CancelResult =
  | { ok: true; state: RequestsState; request: GuildRequest; coin: CoinMovement }
  | { ok: false; error: RequestError };

/** 依頼を取り消す（投稿者だけ）。預かり金は earn で戻る。 */
export function cancelRequest(
  state: RequestsState,
  requestId: string,
  posterKey: string,
): CancelResult {
  const request = state.requests[requestId];
  if (!request) return { ok: false, error: "not_found" };
  if (request.posterKey !== posterKey) return { ok: false, error: "not_poster" };
  const requests = { ...state.requests };
  delete requests[requestId];
  return {
    ok: true,
    state: { requests },
    request,
    coin: { kind: "earn", amount: request.reward, reason: "guild_request_refund" },
  };
}

/** そのユニオンの未完了依頼（新しい順）。 */
export function requestsForGuild(state: RequestsState, guildId: string): GuildRequest[] {
  return Object.values(state.requests)
    .filter((r) => r.guildId === guildId)
    .sort((a, b) => b.createdAt - a.createdAt);
}

const REQUEST_ID_RE = /^[A-Za-z0-9-]{8,64}$/;

function isValidRequest(value: unknown): value is GuildRequest {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return typeof r.id === "string" && REQUEST_ID_RE.test(r.id)
    && typeof r.guildId === "string" && r.guildId.length > 0
    && typeof r.posterKey === "string" && r.posterKey.length > 0
    && typeof r.posterName === "string"
    && itemById(r.itemId) !== null
    && typeof r.count === "number" && Number.isInteger(r.count) && r.count >= 1 && r.count <= 99
    && typeof r.reward === "number" && Number.isInteger(r.reward) && r.reward >= 1 && r.reward <= 1_000_000
    && typeof r.createdAt === "number" && Number.isFinite(r.createdAt);
}

/** 保存済みの値（オブジェクト、または JSON 文字列）を依頼の状態として解釈する。壊れた要素は捨てる。 */
export function parseRequestsState(raw: unknown): RequestsState {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return emptyRequestsState();
    }
  }
  if (typeof value !== "object" || value === null) return emptyRequestsState();
  const doc = value as { v?: unknown; requests?: unknown };
  if (doc.v !== REQUESTS_STATE_VERSION) return emptyRequestsState();
  if (typeof doc.requests !== "object" || doc.requests === null) return emptyRequestsState();
  const requests: Record<string, GuildRequest> = {};
  for (const entry of Object.values(doc.requests as Record<string, unknown>)) {
    if (isValidRequest(entry)) requests[entry.id] = entry;
  }
  return { requests };
}

/** 保存用に版の包みを付けたオブジェクトへ。 */
export function serializeRequestsState(state: RequestsState): string {
  return JSON.stringify({ v: REQUESTS_STATE_VERSION, requests: state.requests });
}
