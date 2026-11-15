// AGO WORLD BOX のパーティ保存（サーバー専用）。
// 保存先は bot_kv（名前空間 "worldbox_party"）:
//   キー = パーティ ID → Party 本体
//   キー = "member:<ownerKey>" → パーティ ID（所属索引）
//   キー = "invite:<ownerKey>" → パーティ ID（招待索引）
import { isBotApiConfigured, kvDelete, kvGet, kvSet } from "../bot-api";
import { parseParty, type Party } from "./party";

export const WORLDBOX_PARTY_NAMESPACE = "worldbox_party";

function memberKey(ownerKey: string): string {
  return `member:${ownerKey}`;
}
function inviteKey(ownerKey: string): string {
  return `invite:${ownerKey}`;
}

async function kvGetString(namespace: string, key: string): Promise<string | null> {
  const raw = await kvGet(namespace, key);
  if (raw === null || raw === undefined) return null;
  return typeof raw === "string" ? raw : JSON.stringify(raw);
}

export async function loadParty(partyId: string): Promise<Party | null> {
  if (!isBotApiConfigured() || !partyId) return null;
  try {
    return parseParty(await kvGetString(WORLDBOX_PARTY_NAMESPACE, partyId));
  } catch {
    return null;
  }
}

export async function storeParty(party: Party): Promise<boolean> {
  if (!isBotApiConfigured()) return false;
  try {
    await kvSet(WORLDBOX_PARTY_NAMESPACE, party.id, JSON.stringify(party));
    for (const m of party.members) {
      await kvSet(WORLDBOX_PARTY_NAMESPACE, memberKey(m.ownerKey), party.id);
    }
    for (const inv of party.invites) {
      await kvSet(WORLDBOX_PARTY_NAMESPACE, inviteKey(inv.toKey), party.id);
    }
    return true;
  } catch {
    return false;
  }
}

export async function deleteParty(party: Party): Promise<void> {
  if (!isBotApiConfigured()) return;
  try {
    await kvDelete(WORLDBOX_PARTY_NAMESPACE, party.id);
    for (const m of party.members) {
      await kvDelete(WORLDBOX_PARTY_NAMESPACE, memberKey(m.ownerKey));
    }
    for (const inv of party.invites) {
      await kvDelete(WORLDBOX_PARTY_NAMESPACE, inviteKey(inv.toKey));
    }
  } catch { /* ベストエフォート */ }
}

export async function clearInviteIndex(ownerKey: string): Promise<void> {
  if (!isBotApiConfigured()) return;
  try {
    await kvDelete(WORLDBOX_PARTY_NAMESPACE, inviteKey(ownerKey));
  } catch { /* ベストエフォート */ }
}

export async function clearMemberIndex(ownerKey: string): Promise<void> {
  if (!isBotApiConfigured()) return;
  try {
    await kvDelete(WORLDBOX_PARTY_NAMESPACE, memberKey(ownerKey));
  } catch { /* ベストエフォート */ }
}

/** 自分が所属するパーティ（索引→本体）。索引が腐っていたら掃除する。 */
export async function loadPartyOf(ownerKey: string): Promise<Party | null> {
  if (!isBotApiConfigured()) return null;
  try {
    const id = await kvGetString(WORLDBOX_PARTY_NAMESPACE, memberKey(ownerKey));
    if (!id) return null;
    const party = await loadParty(id);
    if (!party || !party.members.some((m) => m.ownerKey === ownerKey)) {
      await clearMemberIndex(ownerKey);
      return null;
    }
    return party;
  } catch {
    return null;
  }
}

/** 自分宛てに招待が来ているパーティ。 */
export async function loadInvitedParty(ownerKey: string): Promise<Party | null> {
  if (!isBotApiConfigured()) return null;
  try {
    const id = await kvGetString(WORLDBOX_PARTY_NAMESPACE, inviteKey(ownerKey));
    if (!id) return null;
    const party = await loadParty(id);
    if (!party) {
      await clearInviteIndex(ownerKey);
      return null;
    }
    return party;
  } catch {
    return null;
  }
}
