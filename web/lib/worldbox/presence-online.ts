// AGO WORLD BOX のプレゼンス保存（サーバー専用）。
// 保存先は bot_kv（名前空間 "worldbox_presence"、キー = 所有者キー）。
// kvList で名前空間を列挙できるため、プレイヤーごとのキーで保存し、
// 読取側は鮮度でふるう（古いキーは読取時に無視され、次回 PUT で上書きされる）。
import { isBotApiConfigured, kvDelete, kvList, kvSet } from "../bot-api";
import {
  PRESENCE_FRESH_MS, parsePresenceEntry, presenceIdFor,
  type Heartbeat, type PresenceEntry,
} from "./presence";

export const WORLDBOX_PRESENCE_NAMESPACE = "worldbox_presence";

export function isPresenceEnabled(): boolean {
  return isBotApiConfigured();
}

/** 自分のハートビートを保存する。成功したら true。 */
export async function putPresence(ownerKey: string, heartbeat: Heartbeat, ts: number): Promise<boolean> {
  if (!isBotApiConfigured()) return false;
  try {
    await kvSet(WORLDBOX_PRESENCE_NAMESPACE, ownerKey, JSON.stringify({ ...heartbeat, ts }));
    return true;
  } catch {
    return false;
  }
}

/** 退室時に自分のキーを消す（ベストエフォート）。 */
export async function removePresence(ownerKey: string): Promise<void> {
  if (!isBotApiConfigured()) return;
  try {
    await kvDelete(WORLDBOX_PRESENCE_NAMESPACE, ownerKey);
  } catch {
    // 消えなくても鮮度切れで自然に消える
  }
}

/**
 * プレゼンス ID から所有者キーを引く（steal の対象解決用）。
 * 鮮度切れのエントリは「いない」ものとして null。
 */
export async function findPresenceOwnerKey(presenceId: string): Promise<string | null> {
  if (!isBotApiConfigured()) return null;
  try {
    const rows = await kvList(WORLDBOX_PRESENCE_NAMESPACE);
    for (const [key, raw] of rows) {
      if (presenceIdFor(key) !== presenceId) continue;
      const entry = parsePresenceEntry(presenceId, raw);
      if (entry && Date.now() - entry.ts <= PRESENCE_FRESH_MS) return key;
      return null;
    }
    return null;
  } catch {
    return null;
  }
}

/** 全プレイヤーの保存済みエントリ（鮮度フィルタ前）。読めなければ空配列。 */
export async function listPresence(): Promise<PresenceEntry[]> {
  if (!isBotApiConfigured()) return [];
  try {
    const rows = await kvList(WORLDBOX_PRESENCE_NAMESPACE);
    const entries: PresenceEntry[] = [];
    for (const [key, raw] of rows) {
      const entry = parsePresenceEntry(presenceIdFor(key), raw);
      if (entry) entries.push(entry);
    }
    return entries;
  } catch {
    return [];
  }
}
