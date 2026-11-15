// AGO WORLD BOX 経済ブリッジの保存（サーバー専用）。
// オプは bot_kv（名前空間 "worldbox_economy"、キー = オプID）に
// オブジェクトのまま保存する（bg_cutout の結果レコードと同じ流儀。
// Bot 本体のワーカーが dict として読み、結果を同じキーへ書き戻す）。
// 残高の読み取りは Bot API の許可テーブル users への select のみで、
// Web から残高を書き換える経路はここにも存在しない。
import { isBotApiConfigured, kvGet, kvList, kvSet, tableSelect } from "../bot-api";
import {
  WORLDBOX_ECONOMY_NAMESPACE, parseEconomyOp, recentEconomyOps, type EconomyOp,
} from "./economy-bridge";

export function isEconomyEnabled(): boolean {
  return isBotApiConfigured();
}

/** オプをキューへ積む。成功したら true。 */
export async function enqueueEconomyOp(op: EconomyOp): Promise<boolean> {
  if (!isBotApiConfigured()) return false;
  try {
    await kvSet(WORLDBOX_ECONOMY_NAMESPACE, op.id, op);
    return true;
  } catch {
    return false;
  }
}

/**
 * 冪等なオプ登録（カジノの enqueueSettleOnce と同じ規則、PR #943）。
 * 決定的 ID のオプ専用: 同 ID のオプが既にあれば（pending / done /
 * failed を問わず）作り直さず true を返す。「1つの論理的な支払い =
 * オプ1件」を保証し、再試行や並行リクエストで二重に払われない。
 * done 済みオプを pending で上書きするとワーカーが再適用してしまう
 * ため、存在チェックなしに enqueueEconomyOp を決定的 ID で呼んでは
 * いけない。
 */
export async function enqueueEconomyOpOnce(op: EconomyOp): Promise<boolean> {
  if (!isBotApiConfigured()) return false;
  const existing = await findEconomyOp(op.userKey, op.id);
  if (existing) return true;
  return enqueueEconomyOp(op);
}

/** 自分のオプ（新しい順・最大20件）。読めなければ空配列。 */
export async function loadMyEconomyOps(userKey: string): Promise<EconomyOp[]> {
  if (!isBotApiConfigured()) return [];
  try {
    const all = await kvList(WORLDBOX_ECONOMY_NAMESPACE);
    const ops: EconomyOp[] = [];
    for (const raw of all.values()) {
      const op = parseEconomyOp(raw);
      if (op) ops.push(op);
    }
    return recentEconomyOps(ops, userKey);
  } catch {
    return [];
  }
}

/** 自分のオプを ID で1件引く（セッション先払いの状態確認用）。無ければ null。 */
export async function findEconomyOp(userKey: string, opId: string): Promise<EconomyOp | null> {
  if (!isBotApiConfigured()) return null;
  try {
    const raw = await kvGet(WORLDBOX_ECONOMY_NAMESPACE, opId);
    if (raw === null) return null;
    const op = parseEconomyOp(raw);
    return op && op.userKey === userKey ? op : null;
  } catch {
    return null;
  }
}

type UserBalanceRow = { balance?: unknown };

/**
 * 残高の読み取り（users テーブルへの select のみ）。
 * 行が無いユーザーは 0（行は作らない）。読めなければ null。
 */
export async function readUserBalance(discordId: string): Promise<number | null> {
  if (!isBotApiConfigured()) return null;
  try {
    const rows = await tableSelect<UserBalanceRow>(
      "users",
      "balance",
      [{ column: "user_id", op: "eq", value: discordId }],
      1,
    );
    if (rows.length === 0) return 0;
    const balance = Number(rows[0].balance ?? 0);
    return Number.isFinite(balance) ? Math.trunc(balance) : null;
  } catch {
    return null;
  }
}
