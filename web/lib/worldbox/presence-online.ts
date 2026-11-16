// AGO WORLD BOX のプレゼンス保存（サーバー専用）。
// 保存先は bot_kv（名前空間 "worldbox_presence"、キー = 所有者キー）。
// kvList で名前空間を列挙できるため、プレイヤーごとのキーで保存し、
// 読取側は鮮度でふるう（古いキーは読取時に無視され、次回 PUT で上書きされる）。
import { isBotApiConfigured, kvDelete, kvGet, kvList, kvSet } from "../bot-api";
import {
  PRESENCE_FRESH_MS, isFreshPresence, parsePresenceEntry, presenceIdFor, tabVerdict,
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

/**
 * タブ世代ガードつきの保存（presence ルート専用）。
 * 保存済みエントリと世代を比べ、旧タブからの書き込みは "rejected" を返して保存しない。
 * 世代交代（新しいタブの初回）は "stored" で、以後は旧タブが "rejected" になる。
 */
export async function putPresenceTabGuarded(
  ownerKey: string,
  heartbeat: Heartbeat,
  ts: number,
): Promise<"stored" | "rejected" | "failed"> {
  if (!isBotApiConfigured()) return "failed";
  try {
    const raw = await kvGet(WORLDBOX_PRESENCE_NAMESPACE, ownerKey);
    const stored = raw === null ? null : parsePresenceEntry(presenceIdFor(ownerKey), raw);
    if (tabVerdict(stored, heartbeat, ts) === "reject") return "rejected";
    await kvSet(WORLDBOX_PRESENCE_NAMESPACE, ownerKey, JSON.stringify({ ...heartbeat, ts }));
    return "stored";
  } catch {
    return "failed";
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

/**
 * 保存済みプレゼンス（鮮度フィルタなし。移動連続性の基準用）。
 * 鮮度切れでも保管時刻（ts）が残るため、RESET_MS までは基準として使える。
 * 読み取り失敗・未送信は null。
 */
export async function loadStoredPresence(ownerKey: string): Promise<PresenceEntry | null> {
  if (!isBotApiConfigured()) return null;
  try {
    const raw = await kvGet(WORLDBOX_PRESENCE_NAMESPACE, ownerKey);
    if (raw === null) return null;
    return parsePresenceEntry(presenceIdFor(ownerKey), raw);
  } catch {
    return null;
  }
}

/**
 * 自分のプレゼンス（サーバー側の位置検証用）。
 * 鮮度切れ・未送信・読み取り失敗はすべて null（＝いないものとして扱う）。
 */
export async function loadMyPresence(ownerKey: string): Promise<PresenceEntry | null> {
  if (!isBotApiConfigured()) return null;
  try {
    const raw = await kvGet(WORLDBOX_PRESENCE_NAMESPACE, ownerKey);
    if (raw === null) return null;
    const entry = parsePresenceEntry(presenceIdFor(ownerKey), raw);
    if (!entry || !isFreshPresence(entry, Date.now())) return null;
    return entry;
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

/** 所有者キーつきで新鮮なプレゼンスを列挙する（味方への効果の解決用）。 */
export async function listPresenceWithOwners(): Promise<{ ownerKey: string; entry: PresenceEntry }[]> {
  if (!isBotApiConfigured()) return [];
  try {
    const rows = await kvList(WORLDBOX_PRESENCE_NAMESPACE);
    const now = Date.now();
    const out: { ownerKey: string; entry: PresenceEntry }[] = [];
    for (const [key, raw] of rows) {
      const entry = parsePresenceEntry(presenceIdFor(key), raw);
      if (entry && isFreshPresence(entry, now)) out.push({ ownerKey: key, entry });
    }
    return out;
  } catch {
    return [];
  }
}
