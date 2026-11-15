// 闘技場セッションの永続化（bot_kv `worldbox_arena`）。
// セッションは1人1つ。内部状態はサーバーだけが持ち、クライアントには
// publicArenaView の形でだけ出す。
import { kvDelete, kvGet, kvSet } from "../bot-api";
import { ARENA_SESSION_TTL_MS, type ArenaSession } from "./arena";

export const WORLDBOX_ARENA_NAMESPACE = "worldbox_arena";

function sessionKey(ownerKey: string): string {
  return `session:${ownerKey}`;
}

export async function loadArenaSession(ownerKey: string): Promise<ArenaSession | null> {
  const raw = await kvGet(WORLDBOX_ARENA_NAMESPACE, sessionKey(ownerKey));
  if (typeof raw !== "string" || !raw) return null;
  try {
    const s = JSON.parse(raw) as ArenaSession;
    if (s.kind !== "arena" || typeof s.startedAt !== "number") return null;
    if (Date.now() - s.startedAt > ARENA_SESSION_TTL_MS) {
      await kvDelete(WORLDBOX_ARENA_NAMESPACE, sessionKey(ownerKey));
      return null;
    }
    return s;
  } catch {
    return null;
  }
}

export async function saveArenaSession(ownerKey: string, session: ArenaSession): Promise<void> {
  await kvSet(WORLDBOX_ARENA_NAMESPACE, sessionKey(ownerKey), JSON.stringify(session));
}

export async function clearArenaSession(ownerKey: string): Promise<void> {
  await kvDelete(WORLDBOX_ARENA_NAMESPACE, sessionKey(ownerKey));
}
