// 闘技場PvP の永続化（bot_kv `worldbox_pvp`）。
// 待ち行列は1件（キー "queue"）、決闘は1試合1キー（`duel:<id>`）、
// 決闘中の検索用に所有者キー→決闘ID の索引（`by-user:<ownerKey>`）を持つ。
// 内部状態はサーバーだけが持ち、クライアントには publicPvpView の形でだけ出す。
import { kvDelete, kvGet, kvSet } from "../bot-api";
import {
  PVP_DUEL_TTL_MS, PVP_QUEUE_TTL_MS, duelExpired, parsePvpDuel, parsePvpQueue, pruneQueue,
  type PvpDuel, type PvpQueueEntry,
} from "./pvp";

export const WORLDBOX_PVP_NAMESPACE = "worldbox_pvp";

const QUEUE_KEY = "queue";

function duelKey(duelId: string): string {
  return `duel:${duelId}`;
}

function byUserKey(ownerKey: string): string {
  return `by-user:${ownerKey}`;
}

export async function loadPvpQueue(): Promise<PvpQueueEntry[]> {
  const raw = await kvGet(WORLDBOX_PVP_NAMESPACE, QUEUE_KEY);
  if (typeof raw !== "string" || !raw) return [];
  try {
    return pruneQueue(parsePvpQueue(JSON.parse(raw)), Date.now());
  } catch {
    return [];
  }
}

export async function savePvpQueue(queue: readonly PvpQueueEntry[]): Promise<void> {
  await kvSet(WORLDBOX_PVP_NAMESPACE, QUEUE_KEY, JSON.stringify(queue));
}

export async function loadPvpDuel(duelId: string): Promise<PvpDuel | null> {
  const raw = await kvGet(WORLDBOX_PVP_NAMESPACE, duelKey(duelId));
  if (typeof raw !== "string" || !raw) return null;
  try {
    const duel = parsePvpDuel(JSON.parse(raw));
    if (!duel) return null;
    if (duelExpired(duel, Date.now())) {
      await clearPvpDuel(duel);
      return null;
    }
    return duel;
  } catch {
    return null;
  }
}

export async function savePvpDuel(duel: PvpDuel): Promise<void> {
  await kvSet(WORLDBOX_PVP_NAMESPACE, duelKey(duel.id), JSON.stringify(duel));
  await kvSet(WORLDBOX_PVP_NAMESPACE, byUserKey(duel.players[0].ownerKey), duel.id);
  await kvSet(WORLDBOX_PVP_NAMESPACE, byUserKey(duel.players[1].ownerKey), duel.id);
}

export async function clearPvpDuel(duel: PvpDuel): Promise<void> {
  await kvDelete(WORLDBOX_PVP_NAMESPACE, duelKey(duel.id));
  await kvDelete(WORLDBOX_PVP_NAMESPACE, byUserKey(duel.players[0].ownerKey));
  await kvDelete(WORLDBOX_PVP_NAMESPACE, byUserKey(duel.players[1].ownerKey));
}

/** 自分が参加中の決闘（無ければ null。期限切れは索引ごと消す）。 */
export async function loadMyPvpDuel(ownerKey: string): Promise<PvpDuel | null> {
  const duelId = await kvGet(WORLDBOX_PVP_NAMESPACE, byUserKey(ownerKey));
  if (typeof duelId !== "string" || !duelId) return null;
  return loadPvpDuel(duelId);
}

export { PVP_DUEL_TTL_MS, PVP_QUEUE_TTL_MS };
