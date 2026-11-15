// AGO WORLD BOX のパーティ編成（純粋ロジック）。
// 編成はダンジョン入口の前だけ（場面単位で、永続化しない）。
// リーダー + 最大3人 = 4人まで。ユニオンが違っても組める。ルートは全て個人別。
import type { AdventureRoleId } from "./profile";

export const MAX_PARTY_MEMBERS = 4;
/** 招待の有効期限。 */
export const PARTY_INVITE_TTL_MS = 60_000;

export type PartyMember = {
  ownerKey: string;
  name: string;
  role: AdventureRoleId;
  rank: number;
};

export type PartyInvite = {
  toKey: string;
  name: string;
  at: number;
};

export type Party = {
  id: string;
  leaderKey: string;
  /** 編成したダンジョン入口（ワールド座標）。 */
  entrance: { x: number; y: number };
  members: PartyMember[];
  invites: PartyInvite[];
  createdAt: number;
};

export function makePartyId(leaderKey: string, now: number): string {
  let h = 0;
  const s = `${leaderKey}:${now}`;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return `p${(h >>> 0).toString(36)}${(now % 1296).toString(36)}`;
}

/** ダンジョンのセッションキー（パーティ ID、ソロは solo:<ownerKey>）。 */
export function partyKeyOf(party: Party | null, ownerKey: string): string {
  return party ? party.id : `solo:${ownerKey}`;
}

export function createParty(id: string, leader: PartyMember, entrance: { x: number; y: number }, now: number): Party {
  return { id, leaderKey: leader.ownerKey, entrance, members: [leader], invites: [], createdAt: now };
}

export function isPartyMember(party: Party, ownerKey: string): boolean {
  return party.members.some((m) => m.ownerKey === ownerKey);
}

export function isPartyLeader(party: Party, ownerKey: string): boolean {
  return party.leaderKey === ownerKey;
}

export type PartyJoinError = "full" | "already_member";

/** 参加する。成功したら新しい Party、失敗したら理由を返す。 */
export function joinParty(party: Party, member: PartyMember): { party: Party } | { error: PartyJoinError } {
  if (isPartyMember(party, member.ownerKey)) return { error: "already_member" };
  if (party.members.length >= MAX_PARTY_MEMBERS) return { error: "full" };
  return {
    party: {
      ...party,
      members: [...party.members, member],
      invites: party.invites.filter((i) => i.toKey !== member.ownerKey),
    },
  };
}

/** 退出する。リーダーが抜けたら解散（null）。 */
export function leaveParty(party: Party, ownerKey: string): Party | null {
  if (party.leaderKey === ownerKey) return null;
  return { ...party, members: party.members.filter((m) => m.ownerKey !== ownerKey) };
}

/** 招待を出す（同じ相手への再送は時刻を更新する）。 */
export function addInvite(party: Party, invite: PartyInvite): Party {
  return {
    ...party,
    invites: [...party.invites.filter((i) => i.toKey !== invite.toKey), invite],
  };
}

/** 自分宛ての有効な招待。 */
export function inviteFor(party: Party, ownerKey: string, now: number): PartyInvite | null {
  const inv = party.invites.find((i) => i.toKey === ownerKey);
  if (!inv) return null;
  return now - inv.at <= PARTY_INVITE_TTL_MS ? inv : null;
}

/** 保存値の検証つきパース。壊れていたら null。 */
export function parseParty(raw: unknown): Party | null {
  let data: Record<string, unknown> | null = null;
  if (typeof raw === "string") {
    try {
      data = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
  } else if (raw && typeof raw === "object") {
    data = raw as Record<string, unknown>;
  }
  if (!data) return null;
  if (typeof data.id !== "string" || typeof data.leaderKey !== "string") return null;
  const entrance = data.entrance as { x?: unknown; y?: unknown } | null;
  if (!entrance || typeof entrance.x !== "number" || typeof entrance.y !== "number") return null;
  if (!Array.isArray(data.members) || data.members.length === 0) return null;
  const members: PartyMember[] = [];
  for (const m of data.members) {
    const mm = m as Partial<PartyMember>;
    if (typeof mm.ownerKey !== "string" || typeof mm.name !== "string") return null;
    members.push({
      ownerKey: mm.ownerKey,
      name: mm.name.slice(0, 40),
      role: (typeof mm.role === "string" ? mm.role : "free") as AdventureRoleId,
      rank: typeof mm.rank === "number" ? Math.max(1, Math.min(5, Math.floor(mm.rank))) : 1,
    });
  }
  const invites: PartyInvite[] = [];
  if (Array.isArray(data.invites)) {
    for (const i of data.invites) {
      const ii = i as Partial<PartyInvite>;
      if (typeof ii.toKey === "string" && typeof ii.at === "number") {
        invites.push({ toKey: ii.toKey, name: typeof ii.name === "string" ? ii.name.slice(0, 40) : "", at: ii.at });
      }
    }
  }
  return {
    id: data.id,
    leaderKey: data.leaderKey,
    entrance: { x: entrance.x, y: entrance.y },
    members: members.slice(0, MAX_PARTY_MEMBERS),
    invites,
    createdAt: typeof data.createdAt === "number" ? data.createdAt : 0,
  };
}
