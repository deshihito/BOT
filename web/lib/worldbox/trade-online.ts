// AGO WORLD BOX の P2P 取引保存（サーバー専用）。
// 保存先は bot_kv（名前空間 "worldbox_trade"）:
//   キー = tradeId → TradeSession 本体
//   キー = "active:<ownerKey>" → 現在関与中の tradeId（索引）
import { isBotApiConfigured, kvDelete, kvGet, kvSet } from "../bot-api";
import { parseTradeSession, serializeTradeSession, WORLDBOX_TRADE_NAMESPACE, type TradeSession } from "./trade";

function activeKey(ownerKey: string): string {
  return `active:${ownerKey}`;
}

async function kvGetString(key: string): Promise<string | null> {
  const raw = await kvGet(WORLDBOX_TRADE_NAMESPACE, key);
  if (raw === null || raw === undefined) return null;
  return typeof raw === "string" ? raw : JSON.stringify(raw);
}

export function isTradeEnabled(): boolean {
  return isBotApiConfigured();
}

export async function loadTradeSession(tradeId: string): Promise<TradeSession | null> {
  if (!isBotApiConfigured() || !tradeId) return null;
  try {
    return parseTradeSession(await kvGetString(tradeId));
  } catch {
    return null;
  }
}

export async function storeTradeSession(session: TradeSession): Promise<boolean> {
  if (!isBotApiConfigured()) return false;
  try {
    await kvSet(WORLDBOX_TRADE_NAMESPACE, session.id, serializeTradeSession(session));
    return true;
  } catch {
    return false;
  }
}

export async function setActiveTradeIndex(ownerKey: string, tradeId: string): Promise<boolean> {
  if (!isBotApiConfigured()) return false;
  try {
    await kvSet(WORLDBOX_TRADE_NAMESPACE, activeKey(ownerKey), tradeId);
    return true;
  } catch {
    return false;
  }
}

export async function clearActiveTradeIndex(ownerKey: string): Promise<void> {
  if (!isBotApiConfigured()) return;
  try {
    await kvDelete(WORLDBOX_TRADE_NAMESPACE, activeKey(ownerKey));
  } catch { /* ベストエフォート */ }
}

/** 自分が現在関与している進行中/招待中取引を引く。腐った索引は掃除する。 */
export async function loadActiveTradeFor(ownerKey: string): Promise<TradeSession | null> {
  if (!isBotApiConfigured()) return null;
  try {
    const id = await kvGetString(activeKey(ownerKey));
    if (!id) return null;
    const session = await loadTradeSession(id);
    if (!session || (session.status !== "pending" && session.status !== "open")) {
      await clearActiveTradeIndex(ownerKey);
      return null;
    }
    if (session.a.ownerKey !== ownerKey && session.b.ownerKey !== ownerKey) {
      await clearActiveTradeIndex(ownerKey);
      return null;
    }
    return session;
  } catch {
    return null;
  }
}
