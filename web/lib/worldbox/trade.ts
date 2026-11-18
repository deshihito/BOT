// AGO WORLD BOX の P2P リアルタイム直接取引（純粋ロジック、DOM 非依存）。
// 近くのプレイヤー同士が「アイテム＋AGOコイン」を同時に提示し合い、
// 両者が「準備完了 → 最終確認」を踏んだ瞬間に原子的へ交換する。
// 詐欺防止のため、どちらかが提示内容（アイテムまたはコイン）を変更した
// 瞬間に双方の ready / confirmed が自動でリセットされる。
import { itemById } from "./items";
import { addItem, removeItem, STACK_MAX, type PlayerProfile } from "./profile";

export const WORLDBOX_TRADE_NAMESPACE = "worldbox_trade";

/** 取引セッションの無操作期限（5分）。 */
export const TRADE_TTL_MS = 5 * 60 * 1000;
/** 取引を開始・完了できるプレイヤー間の最大距離（タイル）。 */
export const TRADE_RANGE = 7;
/** 1回の取引で片方が提示できる最大アイテム種類数。 */
export const TRADE_MAX_DISTINCT_ITEMS = 10;
/** 1回の取引で1種類のアイテムを提示できる最大個数。 */
export const TRADE_MAX_ITEM_COUNT = STACK_MAX;
/** 1回の取引で片方が提示できる最大コイン額。 */
export const TRADE_MAX_COINS = 1_000_000;

export const TRADE_ID_RE = /^[A-Za-z0-9-]{8,48}$/;

export type TradeOffer = {
  items: Record<string, number>;
  coins: number;
};

export type TradeParty = {
  ownerKey: string;
  id: string;
  name: string;
  offer: TradeOffer;
  ready: boolean;
  confirmed: boolean;
};

export type TradeStatus = "pending" | "open" | "completed" | "cancelled";

export type TradeSession = {
  id: string;
  status: TradeStatus;
  space: string;
  a: TradeParty;
  b: TradeParty;
  createdAt: number;
  updatedAt: number;
};

export type TradePartySummary = {
  id: string;
  name: string;
  offer: TradeOffer;
  ready: boolean;
  confirmed: boolean;
};

/** クライアント向けの安全な表示ビュー（相手の ownerKey は含めない）。 */
export type TradeClientView = {
  id: string;
  status: TradeStatus;
  space: string;
  selfSide: "a" | "b";
  self: TradePartySummary;
  partner: TradePartySummary;
  createdAt: number;
  updatedAt: number;
};

/** 経済オプ ID 規則（OP_ID_RE: [A-Za-z0-9-]{8,64}）に収まる一意 ID を作る。 */
export function makeTradeId(now: number, randSuffix?: string): string {
  const suffix =
    typeof randSuffix === "string" && /^[A-Za-z0-9]{4,16}$/.test(randSuffix)
      ? randSuffix
      : Math.floor(Math.random() * 0xffffffff).toString(36).padStart(4, "0");
  return `tr-${Math.max(0, Math.floor(now)).toString(36)}-${suffix}`;
}

export function emptyTradeOffer(): TradeOffer {
  return { items: {}, coins: 0 };
}

/** 提示内容を正規化する。不正値や不明アイテムは落とす（コインは 0..TRADE_MAX_COINS 整数）。 */
export function normalizeTradeOffer(raw: unknown): TradeOffer | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const v = raw as { items?: unknown; coins?: unknown };
  const coinsRaw = v.coins === undefined ? 0 : v.coins;
  if (typeof coinsRaw !== "number" || !Number.isInteger(coinsRaw) || coinsRaw < 0 || coinsRaw > TRADE_MAX_COINS) {
    return null;
  }
  const items: Record<string, number> = {};
  if (v.items !== undefined) {
    if (!v.items || typeof v.items !== "object" || Array.isArray(v.items)) return null;
    for (const [id, count] of Object.entries(v.items as Record<string, unknown>)) {
      if (!itemById(id)) return null;
      if (typeof count !== "number" || !Number.isInteger(count) || count < 0 || count > TRADE_MAX_ITEM_COUNT) {
        return null;
      }
      if (count > 0) {
        if (Object.keys(items).length >= TRADE_MAX_DISTINCT_ITEMS) return null;
        items[id] = count;
      }
    }
  }
  return { items, coins: coinsRaw };
}

export function createTradeSession(
  id: string,
  space: string,
  a: { ownerKey: string; id: string; name: string },
  b: { ownerKey: string; id: string; name: string },
  now: number,
): TradeSession {
  return {
    id,
    status: "pending",
    space,
    a: { ownerKey: a.ownerKey, id: a.id, name: a.name, offer: emptyTradeOffer(), ready: false, confirmed: false },
    b: { ownerKey: b.ownerKey, id: b.id, name: b.name, offer: emptyTradeOffer(), ready: false, confirmed: false },
    createdAt: now,
    updatedAt: now,
  };
}

export function isTradeExpired(session: TradeSession, now: number): boolean {
  if (session.status !== "pending" && session.status !== "open") return false;
  return now - session.updatedAt > TRADE_TTL_MS;
}

export function sideOfTrade(session: TradeSession, ownerKey: string): "a" | "b" | null {
  if (session.a.ownerKey === ownerKey) return "a";
  if (session.b.ownerKey === ownerKey) return "b";
  return null;
}

/** 提示内容を更新する。詐欺防止のため、どちらかが変更すると両者の ready / confirmed を解除する。 */
export function setTradeOffer(
  session: TradeSession,
  actorKey: string,
  offer: TradeOffer,
  now: number,
): TradeSession | { error: "not_open" | "not_participant" } {
  if (session.status !== "open") return { error: "not_open" };
  const side = sideOfTrade(session, actorKey);
  if (!side) return { error: "not_participant" };
  const nextA: TradeParty = {
    ...session.a,
    offer: side === "a" ? { items: { ...offer.items }, coins: offer.coins } : session.a.offer,
    ready: false,
    confirmed: false,
  };
  const nextB: TradeParty = {
    ...session.b,
    offer: side === "b" ? { items: { ...offer.items }, coins: offer.coins } : session.b.offer,
    ready: false,
    confirmed: false,
  };
  return { ...session, a: nextA, b: nextB, updatedAt: now };
}

/** 準備状態を切り替える。解除した場合は最終確認も両方リセットする。 */
export function setTradeReady(
  session: TradeSession,
  actorKey: string,
  ready: boolean,
  now: number,
): TradeSession | { error: "not_open" | "not_participant" } {
  if (session.status !== "open") return { error: "not_open" };
  const side = sideOfTrade(session, actorKey);
  if (!side) return { error: "not_participant" };
  const nextA: TradeParty = {
    ...session.a,
    ready: side === "a" ? ready : session.a.ready,
    confirmed: ready ? session.a.confirmed : false,
  };
  const nextB: TradeParty = {
    ...session.b,
    ready: side === "b" ? ready : session.b.ready,
    confirmed: ready ? session.b.confirmed : false,
  };
  return { ...session, a: nextA, b: nextB, updatedAt: now };
}

/** 最終確認を踏む。両者が ready でなければ進めない。 */
export function confirmTrade(
  session: TradeSession,
  actorKey: string,
  now: number,
): TradeSession | { error: "not_open" | "not_participant" | "not_ready" } {
  if (session.status !== "open") return { error: "not_open" };
  const side = sideOfTrade(session, actorKey);
  if (!side) return { error: "not_participant" };
  if (!session.a.ready || !session.b.ready) return { error: "not_ready" };
  return {
    ...session,
    a: side === "a" ? { ...session.a, confirmed: true } : session.a,
    b: side === "b" ? { ...session.b, confirmed: true } : session.b,
    updatedAt: now,
  };
}

/** 双方のコイン提示の差額（純送金額）を計算する。 */
export function netCoinTransfer(
  session: TradeSession,
): { from: TradeParty; to: TradeParty; amount: number } | null {
  const diff = session.a.offer.coins - session.b.offer.coins;
  if (diff > 0) return { from: session.a, to: session.b, amount: diff };
  if (diff < 0) return { from: session.b, to: session.a, amount: -diff };
  return null;
}

/** 両者のインベントリから提示アイテムを検証して交換する（片方不足なら一切変えない）。 */
export function swapTradeItems(
  aProfile: PlayerProfile,
  bProfile: PlayerProfile,
  aItems: Readonly<Record<string, number>>,
  bItems: Readonly<Record<string, number>>,
): { ok: true; aProfile: PlayerProfile; bProfile: PlayerProfile } | { ok: false; side: "a" | "b" } {
  let nextA: PlayerProfile | null = aProfile;
  for (const [id, count] of Object.entries(aItems)) {
    if (!itemById(id) || count <= 0) continue;
    nextA = removeItem(nextA, id, count);
    if (!nextA) return { ok: false, side: "a" };
  }
  let nextB: PlayerProfile | null = bProfile;
  for (const [id, count] of Object.entries(bItems)) {
    if (!itemById(id) || count <= 0) continue;
    nextB = removeItem(nextB, id, count);
    if (!nextB) return { ok: false, side: "b" };
  }
  for (const [id, count] of Object.entries(bItems)) {
    if (count > 0) nextA = addItem(nextA, id, count);
  }
  for (const [id, count] of Object.entries(aItems)) {
    if (count > 0) nextB = addItem(nextB, id, count);
  }
  return { ok: true, aProfile: nextA, bProfile: nextB };
}

export function toTradeClientView(session: TradeSession, ownerKey: string): TradeClientView | null {
  const selfSide = sideOfTrade(session, ownerKey);
  if (!selfSide) return null;
  const selfParty = selfSide === "a" ? session.a : session.b;
  const partnerParty = selfSide === "a" ? session.b : session.a;
  return {
    id: session.id,
    status: session.status,
    space: session.space,
    selfSide,
    self: {
      id: selfParty.id,
      name: selfParty.name,
      offer: selfParty.offer,
      ready: selfParty.ready,
      confirmed: selfParty.confirmed,
    },
    partner: {
      id: partnerParty.id,
      name: partnerParty.name,
      offer: partnerParty.offer,
      ready: partnerParty.ready,
      confirmed: partnerParty.confirmed,
    },
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

function parseTradeParty(raw: unknown): TradeParty | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const v = raw as { ownerKey?: unknown; id?: unknown; name?: unknown; offer?: unknown; ready?: unknown; confirmed?: unknown };
  if (typeof v.ownerKey !== "string" || v.ownerKey.length === 0) return null;
  if (typeof v.id !== "string" || v.id.length === 0) return null;
  const name = typeof v.name === "string" ? v.name.slice(0, 40) : "";
  const offer = normalizeTradeOffer(v.offer ?? emptyTradeOffer());
  if (!offer) return null;
  return {
    ownerKey: v.ownerKey.slice(0, 64),
    id: v.id.slice(0, 32),
    name,
    offer,
    ready: v.ready === true,
    confirmed: v.confirmed === true,
  };
}

export function parseTradeSession(raw: unknown): TradeSession | null {
  let v = raw;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return null;
    }
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as {
    id?: unknown; status?: unknown; space?: unknown; a?: unknown; b?: unknown; createdAt?: unknown; updatedAt?: unknown;
  };
  if (typeof o.id !== "string" || !TRADE_ID_RE.test(o.id)) return null;
  if (o.status !== "pending" && o.status !== "open" && o.status !== "completed" && o.status !== "cancelled") return null;
  if (typeof o.space !== "string" || o.space.length === 0) return null;
  const a = parseTradeParty(o.a);
  const b = parseTradeParty(o.b);
  if (!a || !b || a.ownerKey === b.ownerKey) return null;
  if (typeof o.createdAt !== "number" || !Number.isFinite(o.createdAt)) return null;
  if (typeof o.updatedAt !== "number" || !Number.isFinite(o.updatedAt)) return null;
  return {
    id: o.id,
    status: o.status,
    space: o.space.slice(0, 64),
    a,
    b,
    createdAt: Math.floor(o.createdAt),
    updatedAt: Math.floor(o.updatedAt),
  };
}

export function serializeTradeSession(session: TradeSession): string {
  return JSON.stringify(session);
}
