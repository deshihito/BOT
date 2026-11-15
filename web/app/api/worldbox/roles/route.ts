import { NextResponse } from "next/server";
import { getRequestSession, publicOrigin, sessionOwnerKey } from "@/lib/auth";
import { MAP_SEED } from "@/lib/worldbox/mapgen";
import { isProfileEnabled, loadProfile, storeProfile } from "@/lib/worldbox/profile-online";
import { addItem, type PlayerProfile } from "@/lib/worldbox/profile";
import { playerAttack } from "@/lib/worldbox/arena";
import { mobById, type PlacedMob } from "@/lib/worldbox/mobs";
import {
  applyMobAttack, mobKeyOf, resolveMobPosition, visibleMobs,
  MOB_REPORT_LEASH, type MobState,
} from "@/lib/worldbox/combat";
import { isMobsEnabled, loadMobState, storeMobState } from "@/lib/worldbox/mobs-online";
import { listPresence, listPresenceWithOwners } from "@/lib/worldbox/presence-online";
import { presenceIdFor } from "@/lib/worldbox/presence";
import { parseSave } from "@/lib/worldbox/save";
import { loadWorldBoxSave } from "@/lib/worldbox/save-online";
import { loadMyLobbyStation } from "@/lib/worldbox/station-online";
import {
  activeSkillFor, addMasteryXp, isAdventureRoleId, masteryRankOf,
  roleById, skillCooldownLeft, SKILLS, type SkillId,
} from "@/lib/worldbox/roles";
import { maxHpFor } from "@/lib/worldbox/profile";
import {
  buildCaveLayer, buildDungeonFloor, dungeonHpScale, makeInstanceSpace, parseInstanceSpace,
} from "@/lib/worldbox/instances";
import {
  loadDungeonSession, loadRuinsPersonal, storeDungeonSession, storeRuinsPersonal,
} from "@/lib/worldbox/instances-online";
import { partyKeyOf } from "@/lib/worldbox/party";
import { loadPartyOf } from "@/lib/worldbox/party-online";
import { weekKeyOf } from "@/lib/worldbox/instances";
import { clearDeath, listDeaths } from "@/lib/worldbox/roles-online";

export const runtime = "nodejs";

// AGO WORLD BOX の冒険役職。
// POST { action: "set_role", role }: ギルドボード前でのみ変更可（インスタンス内は不可）。
// POST { action: "skill", skill, tx, ty, space, px, py }: ダブルタップ技。
//   役職・ランク・クールタイム・対象はすべてサーバーが再計算して検証する。
// POST { action: "revive", space, px, py }: 薬師の蘇生（死亡地点の近く、1遠征1回）。
// GET ?space=&x=&y=: 自分の役職情報と、近くの死亡地点（薬師用）。

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return !origin || origin === publicOrigin(request);
}

function err(error: string, status = 409) {
  return NextResponse.json({ error }, { status, headers: NO_STORE });
}

async function actorPos(ownerKey: string, space: string, reported: { x: number; y: number } | null) {
  const selfId = presenceIdFor(ownerKey);
  const entries = await listPresence();
  const now = Date.now();
  const entry = entries.find((e) => e.id === selfId && e.space === space && now - e.ts <= 15_000);
  if (entry) return { x: entry.x, y: entry.y };
  if (reported) return reported;
  const saved = parseSave(await loadWorldBoxSave(ownerKey));
  if (saved && saved.space === space) return { x: saved.x, y: saved.y };
  return null;
}

/** その空間のモブ配置（地表/洞窟/遺跡召喚/ダンジョン）を返す。 */
async function mobsInSpace(ownerKey: string, space: string, cx: number, cy: number, radius: number): Promise<PlacedMob[]> {
  const inst = parseInstanceSpace(space);
  if (inst?.kind === "dungeon") {
    const floor = buildDungeonFloor(MAP_SEED, inst.entranceX, inst.entranceY, inst.layer);
    return floor.mobs.filter((m) => Math.hypot(m.x + 0.5 - cx, m.y + 0.5 - cy) <= radius + m.size);
  }
  if (inst?.kind === "cave") {
    const cave = buildCaveLayer(MAP_SEED, inst.entranceX, inst.entranceY, inst.layer);
    return cave.mobs.filter((m) => Math.hypot(m.x + 0.5 - cx, m.y + 0.5 - cy) <= radius + m.size);
  }
  if (inst?.kind === "ruins") {
    const personal = await loadRuinsPersonal(space, ownerKey, weekKeyOf(Date.now()));
    return personal.summons
      .map((sm) => ({ mobId: sm.mobId, x: sm.x, y: sm.y, biome: "plains" as const, size: mobById(sm.mobId)?.size ?? 1 }))
      .filter((m) => Math.hypot(m.x + 0.5 - cx, m.y + 0.5 - cy) <= radius + m.size);
  }
  const x0 = Math.floor(cx - radius - 4);
  const y0 = Math.floor(cy - radius - 4);
  const x1 = Math.ceil(cx + radius + 4);
  const y1 = Math.ceil(cy + radius + 4);
  return visibleMobs(MAP_SEED, x0, y0, x1, y1, false)
    .concat(visibleMobs(MAP_SEED, x0, y0, x1, y1, true))
    .filter((m, i, arr) => arr.findIndex((o) => o.mobId === m.mobId && o.x === m.x && o.y === m.y) === i)
    .filter((m) => Math.hypot(m.x + 0.5 - cx, m.y + 0.5 - cy) <= radius + m.size);
}

async function keyFor(ownerKey: string, space: string, placed: PlacedMob): Promise<string> {
  const inst = parseInstanceSpace(space);
  if (inst?.kind === "dungeon") {
    const party = await loadPartyOf(ownerKey);
    return `${space}#${partyKeyOf(party, ownerKey)}|${mobKeyOf(placed)}`;
  }
  return inst ? `${space}|${mobKeyOf(placed)}` : mobKeyOf(placed);
}

/** ダンジョンではモブ HP がパーティ人数で倍率される（mobs ルートと同じ式）。 */
async function effectiveDef(ownerKey: string, space: string, def: NonNullable<ReturnType<typeof mobById>>) {
  const inst = parseInstanceSpace(space);
  if (inst?.kind !== "dungeon") return def;
  const party = await loadPartyOf(ownerKey);
  const floor1 = makeInstanceSpace("dungeon", inst.entranceX, inst.entranceY, 0);
  const ds = await loadDungeonSession(floor1, partyKeyOf(party, ownerKey));
  return { ...def, hp: Math.max(1, Math.round(def.hp * dungeonHpScale(ds?.size ?? 1))) };
}

export async function GET(request: Request) {
  const session = getRequestSession(request);
  if (!session) return err("unauthorized", 401);
  if (!isProfileEnabled()) return err("roles_unavailable", 503);
  const ownerKey = sessionOwnerKey(session);
  const profile = await loadProfile(ownerKey);
  if (!profile) return err("roles_unavailable", 503);
  const url = new URL(request.url);
  const space = url.searchParams.get("space") ?? "world";
  const x = Number(url.searchParams.get("x"));
  const y = Number(url.searchParams.get("y"));
  let deaths: { name: string; x: number; y: number; at: number }[] = [];
  if (profile.role === "medic" && Number.isFinite(x) && Number.isFinite(y)) {
    const all = await listDeaths(Date.now());
    deaths = all
      .filter((d) => d.space === space && d.ownerKey !== ownerKey && Math.hypot(d.x - x, d.y - y) <= 6)
      .map((d) => ({ name: d.name, x: d.x, y: d.y, at: d.at }));
  }
  const skill = activeSkillFor(profile);
  return NextResponse.json(
    {
      role: profile.role,
      rank: masteryRankOf(profile, profile.role),
      mastery: profile.mastery,
      skill: skill ? { ...skill, cooldownLeftMs: skillCooldownLeft(profile, skill.id, Date.now()) } : null,
      deaths,
    },
    { headers: NO_STORE },
  );
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return err("forbidden", 403);
  const session = getRequestSession(request);
  if (!session) return err("unauthorized", 401);
  if (!isProfileEnabled()) return err("roles_unavailable", 503);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return err("invalid_request", 400);
  }
  const fields = (body ?? {}) as {
    action?: unknown; role?: unknown; skill?: unknown;
    tx?: unknown; ty?: unknown; space?: unknown; px?: unknown; py?: unknown;
    mobs?: unknown;
  };
  const ownerKey = sessionOwnerKey(session);
  const now = Date.now();
  const profile = await loadProfile(ownerKey);
  if (!profile) return err("roles_unavailable", 503);

  if (fields.action === "set_role") {
    if (!isAdventureRoleId(fields.role)) return err("invalid_request", 400);
    const saved = parseSave(await loadWorldBoxSave(ownerKey));
    if (saved && parseInstanceSpace(saved.space)) return err("in_instance", 409);
    if ((await loadMyLobbyStation(ownerKey)) !== "guild") return err("not_at_guild_board", 409);
    const next = { ...profile, role: fields.role };
    if (!(await storeProfile(ownerKey, next))) return err("store_failed", 503);
    return NextResponse.json({ ok: true, profile: next }, { headers: NO_STORE });
  }

  const space = typeof fields.space === "string" ? fields.space : "world";
  const reported =
    typeof fields.px === "number" && typeof fields.py === "number" && Number.isFinite(fields.px) && Number.isFinite(fields.py)
      ? { x: fields.px, y: fields.py }
      : null;
  const pos = await actorPos(ownerKey, space, reported);
  if (!pos) return err("position_unknown", 409);

  if (fields.action === "revive") {
    if (profile.role !== "medic") return err("not_medic", 409);
    if (profile.reviveMark && profile.reviveMark.space === space && now - profile.reviveMark.at < 30 * 60 * 1000) {
      return err("revive_used", 409);
    }
    const deaths = await listDeaths(now);
    const target = deaths.find(
      (d) => d.space === space && d.ownerKey !== ownerKey && Math.hypot(d.x - pos.x, d.y - pos.y) <= 2.5,
    );
    if (!target) return err("no_fallen", 409);
    const targetProfile = await loadProfile(target.ownerKey);
    if (!targetProfile) return err("no_fallen", 409);
    const healed: PlayerProfile = {
      ...targetProfile,
      hp: Math.max(targetProfile.hp, Math.floor(maxHpFor(targetProfile) * 0.3)),
      pendingTeleport: { space, x: target.x, y: target.y },
    };
    if (!(await storeProfile(target.ownerKey, healed))) return err("store_failed", 503);
    await clearDeath(target.ownerKey);
    // ダンジョン内蘇生: セッションの dead から外す。残っていると蘇生後も
    // 攻撃不可（mobs ルートが dead を弾く）・全滅判定が誤って閉じてしまう（S5）。
    // セッション保存の失敗は蘇生自体を壊さないため best-effort とする。
    {
      const inst = parseInstanceSpace(space);
      if (inst?.kind === "dungeon") {
        const targetParty = await loadPartyOf(target.ownerKey);
        const floor1 = makeInstanceSpace("dungeon", inst.entranceX, inst.entranceY, 0);
        const ds = await loadDungeonSession(floor1, partyKeyOf(targetParty, target.ownerKey));
        if (ds && ds.dead.includes(target.ownerKey)) {
          await storeDungeonSession(floor1, {
            ...ds, dead: ds.dead.filter((m) => m !== target.ownerKey),
          }).catch(() => false);
        }
      }
    }
    const { profile: medicNext } = addMasteryXp(
      { ...profile, reviveMark: { space, at: now } },
      "medic",
      10,
    );
    if (!(await storeProfile(ownerKey, medicNext))) return err("store_failed", 503);
    return NextResponse.json({ ok: true, profile: medicNext, revivedName: target.name }, { headers: NO_STORE });
  }

  if (fields.action === "skill") {
    if (!isMobsEnabled()) return err("roles_unavailable", 503);
    const skillId = typeof fields.skill === "string" ? (fields.skill as SkillId) : null;
    if (!skillId || !(skillId in SKILLS)) return err("invalid_request", 400);
    const skill = SKILLS[skillId];
    const rank = masteryRankOf(profile, profile.role);
    // 技の所有検証: その役職の技であり、ランクを満たし、現在の発動技と一致する
    // （守護の挑発だけは自分のタイル専用として別に許可する）。
    const active = activeSkillFor(profile);
    const isTaunt = skillId === "taunt" && profile.role === "guard";
    if (!isTaunt && (!active || active.id !== skillId)) return err("skill_locked", 409);
    if (isTaunt && rank < SKILLS.taunt.minRank) return err("skill_locked", 409);
    if (skillCooldownLeft(profile, skillId, now) > 0) return err("cooldown", 409);

    const tx = typeof fields.tx === "number" && Number.isFinite(fields.tx) ? fields.tx : pos.x;
    const ty = typeof fields.ty === "number" && Number.isFinite(fields.ty) ? fields.ty : pos.y;

    // クライアントが見ているモブの現在タイル（キー=アンカー、値=現在位置）。
    // 対象解決はアンカーでなく実位置で行う（通常攻撃と同じ理由: 見た目が
    // アンカーから離れて追跡してくるため、アンカー基準だと画面で目の前に
    // いるモブに技が当たらず no_target になっていた）。
    const reportedByKey = new Map<string, { x: number; y: number }>();
    if (Array.isArray(fields.mobs)) {
      for (const entry of fields.mobs.slice(0, 32)) {
        const e = (entry ?? {}) as { mobId?: unknown; x?: unknown; y?: unknown; mx?: unknown; my?: unknown };
        if (typeof e.mobId !== "string" || !mobById(e.mobId)) continue;
        if (typeof e.x !== "number" || typeof e.y !== "number" || typeof e.mx !== "number" || typeof e.my !== "number") continue;
        if (![e.x, e.y, e.mx, e.my].every((v) => Number.isFinite(v) && Math.abs(v) <= 1_000_000)) continue;
        reportedByKey.set(
          mobKeyOf({ mobId: e.mobId, x: Math.floor(e.x), y: Math.floor(e.y) }),
          { x: e.mx, y: e.my },
        );
      }
    }
    /** 対象解決に使う実位置の中心（申告がリーシュ内なら申告、なければアンカー）。 */
    const effCenter = (m: PlacedMob): { x: number; y: number } => {
      const eff = resolveMobPosition(m, reportedByKey.get(mobKeyOf(m)));
      return { x: eff.x + 0.5, y: eff.y + 0.5 };
    };

    let next: PlayerProfile = {
      ...profile,
      skillAt: { ...profile.skillAt, [skillId]: now },
    };

    if (skillId === "taunt") {
      next = { ...next, tauntUntil: now + 5000 };
      if (!(await storeProfile(ownerKey, next))) return err("store_failed", 503);
      return NextResponse.json(
        { ok: true, skill: skillId, profile: next, results: [] },
        { headers: NO_STORE },
      );
    }

    if (skillId === "heal_zone") {
      // 自分と半径内の味方を回復（味方はプレゼンスの所有者解決で特定する）
      const owners = await listPresenceWithOwners();
      let healedCount = 0;
      const selfEntry = owners.find((o) => o.ownerKey === ownerKey);
      void selfEntry;
      next = { ...next, hp: Math.min(maxHpFor(next), next.hp + skill.power) };
      healedCount++;
      for (const o of owners) {
        if (o.ownerKey === ownerKey) continue;
        if (o.entry.space !== space) continue;
        if (Math.hypot(o.entry.x - pos.x, o.entry.y - pos.y) > skill.radius) continue;
        const ally = await loadProfile(o.ownerKey);
        if (!ally || ally.hp <= 0) continue;
        const healedAlly = { ...ally, hp: Math.min(maxHpFor(ally), ally.hp + skill.power) };
        if (await storeProfile(o.ownerKey, healedAlly)) healedCount++;
      }
      if (!(await storeProfile(ownerKey, next))) return err("store_failed", 503);
      return NextResponse.json(
        { ok: true, skill: skillId, profile: next, results: [], healedCount },
        { headers: NO_STORE },
      );
    }

    // 攻撃系: 中心と対象を決める
    let cx = pos.x;
    let cy = pos.y;
    let targets: PlacedMob[] = [];
    const baseAttack = playerAttack(profile.items, profile.enhance) * (profile.role === "blade" ? 1.25 : 1);
    if (skillId === "sweep" || skillId === "whirlwind") {
      targets = await mobsInSpace(ownerKey, space, pos.x, pos.y, skill.radius + 2 + MOB_REPORT_LEASH);
      targets = targets.filter((m) => {
        const c = effCenter(m);
        return Math.hypot(c.x - pos.x, c.y - pos.y) <= skill.radius + m.size * 0.5;
      });
    } else if (skillId === "ice_lance" || skillId === "thunder_strike" || skillId === "fireball") {
      const range = skillId === "ice_lance" ? 4.5 : 5.5;
      if (Math.hypot(tx - pos.x, ty - pos.y) > range + 1.5) return err("too_far", 409);
      const near = await mobsInSpace(ownerKey, space, tx, ty, 3 + MOB_REPORT_LEASH);
      near.sort((a, b) => {
        const ca = effCenter(a);
        const cb = effCenter(b);
        return Math.hypot(ca.x - tx, ca.y - ty) - Math.hypot(cb.x - tx, cb.y - ty);
      });
      const primary = near[0];
      if (!primary) return err("no_target", 409);
      const pc = effCenter(primary);
      if (Math.hypot(pc.x - tx, pc.y - ty) > 3.5) return err("no_target", 409);
      cx = pc.x;
      cy = pc.y;
      targets = [primary];
      if (skillId === "fireball") {
        const splash = await mobsInSpace(ownerKey, space, cx, cy, skill.radius + 1.5 + MOB_REPORT_LEASH);
        for (const m of splash) {
          if (m === primary) continue;
          const c = effCenter(m);
          if (Math.hypot(c.x - cx, c.y - cy) <= skill.radius + m.size * 0.5) targets.push(m);
        }
      }
    } else {
      // meteor / arrow_rain / poison_field: タップ地点が中心
      if (Math.hypot(tx - pos.x, ty - pos.y) > 6.5) return err("too_far", 409);
      cx = tx;
      cy = ty;
      targets = await mobsInSpace(ownerKey, space, tx, ty, skill.radius + 2 + MOB_REPORT_LEASH);
      targets = targets.filter((m) => {
        const c = effCenter(m);
        return Math.hypot(c.x - tx, c.y - ty) <= skill.radius + m.size * 0.5;
      });
      if (targets.length === 0) return err("no_target", 409);
    }

    // ダンジョンのフロアボスは技の対象にしない（進行登録は通常攻撃の経路に一本化）
    {
      const instD = parseInstanceSpace(space);
      if (instD?.kind === "dungeon") {
        const floorD = buildDungeonFloor(MAP_SEED, instD.entranceX, instD.entranceY, instD.layer);
        targets = targets.filter((m) => !(m.mobId === floorD.boss.mobId && m.x === floorD.boss.x && m.y === floorD.boss.y));
        if (targets.length === 0) return err("no_target", 409);
      }
    }

    const results: { key: string; hp: number; dead: boolean }[] = [];
    let gainedAll: Record<string, number> = {};
    let anyDead = false;
    for (const placed of targets) {
      const def = mobById(placed.mobId);
      if (!def) continue;
      const key = await keyFor(ownerKey, space, placed);
      const state = await loadMobState(key);
      // 凍結中は追加ダメージを受けない（氷の上書き防止ではなく、状態の保護）
      const effDef = await effectiveDef(ownerKey, space, def);
      const result = applyMobAttack(effDef, state, baseAttack * skill.power, now, Math.random, key);
      if ("error" in result) continue;
      let st: MobState = result.state;
      if (skillId === "ice_lance" && !result.dead) st = { ...st, frozenUntil: now + 3000 };
      if (!(await storeMobState(key, st))) return err("store_failed", 503);
      if (result.dead && parseInstanceSpace(space)?.kind === "ruins") {
        const personal = await loadRuinsPersonal(space, ownerKey, weekKeyOf(now));
        personal.summons = personal.summons.filter((m) => !(m.mobId === placed.mobId && m.x === placed.x && m.y === placed.y));
        await storeRuinsPersonal(space, ownerKey, personal);
      }
      results.push({ key, hp: result.hp, dead: result.dead });
      if (result.dead) {
        anyDead = true;
        for (const [id, n] of Object.entries(result.gained)) gainedAll[id] = (gainedAll[id] ?? 0) + n;
      }
    }
    if (results.length === 0) return err("no_target", 409);
    for (const [id, n] of Object.entries(gainedAll)) next = addItem(next, id, n);
    if (anyDead && profile.role === "blade") {
      next = addMasteryXp(next, "blade", 3).profile;
    }
    if (!(await storeProfile(ownerKey, next))) return err("store_failed", 503);
    return NextResponse.json(
      { ok: true, skill: skillId, fx: skill.fx, cx, cy, results, gained: gainedAll, profile: next },
      { headers: NO_STORE },
    );
  }

  return err("invalid_request", 400);
}
