import { NextResponse } from "next/server";
import { getRequestSession, publicOrigin, sessionOwnerKey } from "@/lib/auth";
import { MAP_SEED } from "@/lib/worldbox/mapgen";
import { CHUNK_SIZE, structuresForChunk } from "@/lib/worldbox/maplogic";
import { isProfileEnabled, loadProfile } from "@/lib/worldbox/profile-online";
import { masteryRankOf } from "@/lib/worldbox/roles";
import { listPresenceWithOwners } from "@/lib/worldbox/presence-online";
import { presenceIdFor } from "@/lib/worldbox/presence";
import {
  addInvite, createParty, inviteFor, isPartyLeader, isPartyMember, joinParty,
  leaveParty, makePartyId, partyKeyOf, type Party, type PartyMember,
} from "@/lib/worldbox/party";
import {
  clearInviteIndex, clearMemberIndex, deleteParty, loadInvitedParty, loadParty,
  loadPartyOf, storeParty,
} from "@/lib/worldbox/party-online";
import {
  deleteDungeonSession, dungeonSessionClosed, loadDungeonSession, storeDungeonSession,
  type DungeonSession,
} from "@/lib/worldbox/instances-online";
import { makeInstanceSpace } from "@/lib/worldbox/instances";

export const runtime = "nodejs";

// AGO WORLD BOX のパーティ編成とダンジョン入場。
// GET: 自分のパーティと自分宛ての招待。
// POST create: ダンジョン入口の前で編成を開始する（リーダーになる）。
// POST invite { targetId }: 近くのプレイヤーへ招待（リーダーのみ、プレゼンス検証）。
// POST accept / decline: 招待への応答（入口の近くにいることを検証）。
// POST leave: 退出（リーダーは解散）。
// POST enter: ダンジョン入場。セッションを作り（リーダー/ソロ）、空間 ID を返す。

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };
const ENTRANCE_RANGE = 5;
const INVITE_RANGE = 7;

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return !origin || origin === publicOrigin(request);
}

function err(error: string, status = 409) {
  return NextResponse.json({ error }, { status, headers: NO_STORE });
}

/** ワールド座標の近くにあるダンジョン入口を探す。 */
function dungeonEntranceNear(x: number, y: number, range: number): { x: number; y: number } | null {
  const ccx = Math.floor(x / CHUNK_SIZE);
  const ccy = Math.floor(y / CHUNK_SIZE);
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      for (const st of structuresForChunk(MAP_SEED, ccx + dx, ccy + dy)) {
        if (st.structureId !== "dungeon_entrance") continue;
        if (Math.hypot(st.x + 0.5 - x, st.y + 0.5 - y) <= range) return { x: st.x, y: st.y };
      }
    }
  }
  return null;
}

async function myPresence(ownerKey: string): Promise<{ x: number; y: number; space: string } | null> {
  const owners = await listPresenceWithOwners();
  const selfId = presenceIdFor(ownerKey);
  const now = Date.now();
  const mine = owners.find((o) => o.ownerKey === ownerKey && o.entry.id === selfId && now - o.entry.ts <= 15_000);
  return mine ? { x: mine.entry.x, y: mine.entry.y, space: mine.entry.space } : null;
}

async function memberOf(ownerKey: string, name: string): Promise<PartyMember> {
  const profile = await loadProfile(ownerKey);
  return {
    ownerKey,
    name,
    role: profile?.role ?? "free",
    rank: profile ? masteryRankOf(profile, profile.role) : 1,
  };
}

function partyView(party: Party | null) {
  if (!party) return null;
  return {
    id: party.id,
    leaderKey: party.leaderKey,
    entrance: party.entrance,
    members: party.members.map((m) => ({ name: m.name, role: m.role, rank: m.rank, leader: m.ownerKey === party.leaderKey })),
  };
}

export async function GET(request: Request) {
  const session = getRequestSession(request);
  if (!session) return err("unauthorized", 401);
  const ownerKey = sessionOwnerKey(session);
  const now = Date.now();
  const party = await loadPartyOf(ownerKey);
  let invite: { partyId: string; leaderName: string; entrance: { x: number; y: number } } | null = null;
  if (!party) {
    const invited = await loadInvitedParty(ownerKey);
    if (invited && inviteFor(invited, ownerKey, now)) {
      const leader = invited.members.find((m) => m.ownerKey === invited.leaderKey);
      invite = { partyId: invited.id, leaderName: leader?.name ?? "", entrance: invited.entrance };
    }
  }
  // ダンジョン内ならセッションの要約も返す（階段ゲート・倍率表示用）
  let dungeon: { size: number; floorBossDead: Record<string, boolean>; bossDead: boolean } | null = null;
  const url = new URL(request.url);
  const space = url.searchParams.get("space");
  if (space && space.startsWith("dungeon:")) {
    const floor1 = space.replace(/:\d+$/, ":0");
    const ds = await loadDungeonSession(floor1, partyKeyOf(party && isPartyMember(party, ownerKey) ? party : null, ownerKey));
    if (ds) dungeon = { size: ds.size, floorBossDead: ds.floorBossDead, bossDead: ds.bossDead };
  }
  return NextResponse.json({ party: partyView(party), partyKey: partyKeyOf(party, ownerKey), isLeader: party?.leaderKey === ownerKey, invite, dungeon }, { headers: NO_STORE });
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return err("forbidden", 403);
  const session = getRequestSession(request);
  if (!session) return err("unauthorized", 401);
  if (!isProfileEnabled()) return err("party_unavailable", 503);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return err("invalid_request", 400);
  }
  const fields = (body ?? {}) as { action?: unknown; targetId?: unknown };
  const ownerKey = sessionOwnerKey(session);
  const now = Date.now();
  const name = session.username ?? "";
  const pos = await myPresence(ownerKey);

  if (fields.action === "create") {
    if (!pos || pos.space !== "world") return err("not_at_entrance", 409);
    const entrance = dungeonEntranceNear(pos.x, pos.y, ENTRANCE_RANGE);
    if (!entrance) return err("not_at_entrance", 409);
    const existing = await loadPartyOf(ownerKey);
    if (existing) return NextResponse.json({ ok: true, party: partyView(existing) }, { headers: NO_STORE });
    const me = await memberOf(ownerKey, name);
    const party = createParty(makePartyId(ownerKey, now), me, entrance, now);
    if (!(await storeParty(party))) return err("store_failed", 503);
    return NextResponse.json({ ok: true, party: partyView(party) }, { headers: NO_STORE });
  }

  if (fields.action === "invite") {
    const party = await loadPartyOf(ownerKey);
    if (!party) return err("no_party", 409);
    if (!isPartyLeader(party, ownerKey)) return err("not_leader", 409);
    if (party.members.length >= 4) return err("party_full", 409);
    if (!pos || pos.space !== "world") return err("not_at_entrance", 409);
    const targetId = typeof fields.targetId === "string" ? fields.targetId : "";
    const owners = await listPresenceWithOwners();
    const target = owners.find((o) => o.entry.id === targetId && o.entry.space === "world" && now - o.entry.ts <= 15_000);
    if (!target) return err("target_not_near", 409);
    if (Math.hypot(target.entry.x - pos.x, target.entry.y - pos.y) > INVITE_RANGE) return err("target_not_near", 409);
    if (target.ownerKey === ownerKey) return err("invalid_request", 400);
    const next = addInvite(party, { toKey: target.ownerKey, name: target.entry.name ?? "", at: now });
    if (!(await storeParty(next))) return err("store_failed", 503);
    return NextResponse.json({ ok: true, party: partyView(next) }, { headers: NO_STORE });
  }

  if (fields.action === "accept") {
    const invited = await loadInvitedParty(ownerKey);
    if (!invited || !inviteFor(invited, ownerKey, now)) return err("no_invite", 409);
    if (!pos || pos.space !== "world") return err("not_at_entrance", 409);
    if (Math.hypot(invited.entrance.x + 0.5 - pos.x, invited.entrance.y + 0.5 - pos.y) > ENTRANCE_RANGE + 2) {
      return err("not_at_entrance", 409);
    }
    const me = await memberOf(ownerKey, name);
    const joined = joinParty(invited, me);
    if ("error" in joined) return err(joined.error === "full" ? "party_full" : "already_member", 409);
    if (!(await storeParty(joined.party))) return err("store_failed", 503);
    await clearInviteIndex(ownerKey);
    return NextResponse.json({ ok: true, party: partyView(joined.party) }, { headers: NO_STORE });
  }

  if (fields.action === "decline") {
    const invited = await loadInvitedParty(ownerKey);
    if (invited) {
      const next = { ...invited, invites: invited.invites.filter((i) => i.toKey !== ownerKey) };
      await storeParty(next);
    }
    await clearInviteIndex(ownerKey);
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  }

  if (fields.action === "leave") {
    const party = await loadPartyOf(ownerKey);
    if (!party) return NextResponse.json({ ok: true }, { headers: NO_STORE });
    const next = leaveParty(party, ownerKey);
    if (!next) {
      await deleteParty(party);
    } else {
      await storeParty(next);
      await clearMemberIndex(ownerKey);
    }
    return NextResponse.json({ ok: true, party: partyView(next) }, { headers: NO_STORE });
  }

  if (fields.action === "enter") {
    if (!pos || pos.space !== "world") return err("not_at_entrance", 409);
    const entrance = dungeonEntranceNear(pos.x, pos.y, ENTRANCE_RANGE);
    if (!entrance) return err("not_at_entrance", 409);
    const party = await loadPartyOf(ownerKey);
    const inParty = party && isPartyMember(party, ownerKey) ? party : null;
    if (inParty && (inParty.entrance.x !== entrance.x || inParty.entrance.y !== entrance.y)) {
      return err("wrong_entrance", 409);
    }
    const partyKey = partyKeyOf(inParty, ownerKey);
    const floor1 = makeInstanceSpace("dungeon", entrance.x, entrance.y, 0);
    let ds = await loadDungeonSession(floor1, partyKey);
    if (!ds) {
      // セッション作成はリーダー（またはソロ）だけ。メンバーはリーダーの入場を待つ。
      if (inParty && !isPartyLeader(inParty, ownerKey)) return err("leader_not_entered", 409);
      const members = inParty ? inParty.members.map((m) => m.ownerKey) : [ownerKey];
      ds = {
        partyKey,
        entrance,
        size: members.length,
        members,
        departed: [],
        dead: [],
        floorBossDead: {},
        bossDead: false,
        doors: {},
        chests: {},
        startedAt: now,
      } satisfies DungeonSession;
      if (!(await storeDungeonSession(floor1, ds))) return err("store_failed", 503);
    }
    if (!ds.members.includes(ownerKey)) return err("not_member", 409);
    if (ds.departed.includes(ownerKey) || ds.dead.includes(ownerKey)) return err("already_left", 409);
    return NextResponse.json(
      { ok: true, space: floor1, partyKey, size: ds.size },
      { headers: NO_STORE },
    );
  }

  return err("invalid_request", 400);
}
