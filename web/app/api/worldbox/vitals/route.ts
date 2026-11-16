import { NextResponse } from "next/server";
import { getRequestSession, publicOrigin, sessionOwnerKey } from "@/lib/auth";
import { MAP_SEED, WORLD_COORD_LIMIT } from "@/lib/worldbox/mapgen";
import { isNightPhase, phaseAtTime } from "@/lib/worldbox/daynight";
import { mobById } from "@/lib/worldbox/mobs";
import { mobDistance, mobExistsAt, MOB_ATTACK_MAX_DISTANCE } from "@/lib/worldbox/combat";
import { isProfileEnabled, loadProfile, storeProfile } from "@/lib/worldbox/profile-online";
import { listPresence } from "@/lib/worldbox/presence-online";
import { presenceIdFor } from "@/lib/worldbox/presence";
import { parseSave } from "@/lib/worldbox/save";
import { loadWorldBoxSave } from "@/lib/worldbox/save-online";
import { loadNationsState } from "@/lib/worldbox/nations-online";
import { loadTileOverride } from "@/lib/worldbox/tiles-online";
import { buildCaveLayer, buildDungeonFloor, makeInstanceSpace, parseInstanceSpace, weekKeyOf } from "@/lib/worldbox/instances";
import { loadRuinsPersonal } from "@/lib/worldbox/instances-online";
import { listPresenceWithOwners } from "@/lib/worldbox/presence-online";
import { addMasteryXp, GUARD_AURA_REDUCTION } from "@/lib/worldbox/roles";
import { recordDeath } from "@/lib/worldbox/roles-online";
import { loadMobState } from "@/lib/worldbox/mobs-online";
import {
  deleteDungeonSession, dungeonSessionClosed, loadDungeonSession, storeDungeonSession,
} from "@/lib/worldbox/instances-online";
import { partyKeyOf } from "@/lib/worldbox/party";
import { loadPartyOf } from "@/lib/worldbox/party-online";
import type { PlayerProfile, RespawnPoint } from "@/lib/worldbox/profile";
import {
  applyDeath, applyMobDamage, applyPlayerDamage, maxHpFor, resolveRespawnPoint, setBedRespawn, stepVitals,
} from "@/lib/worldbox/vitals";
import { playerAttack } from "@/lib/worldbox/arena";
import { withUserLock } from "@/lib/worldbox/user-lock";

export const runtime = "nodejs";

// AGO WORLD BOX のプレイヤーバイタル（HP・空腹・毒・死亡・リスポーン）。
// 状態の正は profile（bot_kv worldbox_profiles）で、遷移規則は vitals.ts。
// POST { action: "sync" }: 時間経過の精算（空腹・毒・飢え）。死亡したら死亡処理まで行う
// POST { action: "damage", mobId, x, y, px?, py? }: モブ接触ダメージ。
//   配置の再計算で実在を検証し、距離は mobs ルートと同じ方式（プレゼンス→申告→セーブ）
// POST { action: "pvp", targetId, px?, py?, space? }: 他プレイヤーへの攻撃（フィールド PvP）。
//   対象はプレゼンス（所有者つき一覧）で実在と距離を検証し、ダメージはモブ接触と
//   同じ規則（applyPlayerDamage）。対象が死んだら死亡処理まで適用し、リスポーン
//   移動だけ対象本人の次回 sync に委ねる（profile.pendingDeath）。
//   許可空間はワールドと洞窟・遺跡のみ（ロビー/テント/ダンジョンは不可）。
// POST { action: "set_bed", x, y }: そのタイルのベッドをリスポーン点にする（近接検証）
// 死亡時は { died: true, dropped, respawn: {x, y} } を返し、クライアントが移動する。
// REST ハートビートには触らない（サーバー検証の正はプレゼンス側）。

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return !origin || origin === publicOrigin(request);
}

function errorResponse(error: string, status = 409) {
  return NextResponse.json({ error }, { status, headers: NO_STORE });
}

/** 距離検証に使う本人のワールド位置（mobs ルートと同じ優先順）。 */
async function actorWorldPosition(
  ownerKey: string,
  reported?: { x: number; y: number } | null,
  space: string = "world",
): Promise<{ x: number; y: number } | null> {
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

/** 所属国のマーク（首都タイル中心）。未所属・未建国なら null。 */
async function unionMarkOf(ownerKey: string): Promise<RespawnPoint | null> {
  const state = await loadNationsState();
  const membership = state.members[ownerKey];
  if (!membership) return null;
  const nation = state.nations[membership.nationId];
  if (!nation) return null;
  return { x: nation.capital.x + 0.5, y: nation.capital.y + 0.5 };
}

/** 死亡処理まで行い、保存して返す。 */
async function settleDeath(
  ownerKey: string,
  profile: PlayerProfile,
  now: number,
  name: string = "",
): Promise<NextResponse> {
  // 蘇生用に死亡地点を記録する（セーブ位置が死亡時の空間・座標）
  const savedAtDeath = parseSave(await loadWorldBoxSave(ownerKey));
  if (savedAtDeath) {
    await recordDeath({
      ownerKey, name, space: savedAtDeath.space, x: savedAtDeath.x, y: savedAtDeath.y, at: now,
    });
  }
  const { profile: revived, dropped } = applyDeath(profile, now);
  // ダンジョン内死亡: セッションに死亡を記録し、全滅なら閉じる。
  // リスポーンは入口前（企画書 §1.4: 復活は帰還座標＝入口前）。
  const dungeonInst = savedAtDeath ? parseInstanceSpace(savedAtDeath.space) : null;
  if (dungeonInst?.kind === "dungeon") {
    const party = await loadPartyOf(ownerKey);
    const partyKey = partyKeyOf(party, ownerKey);
    const floor1 = makeInstanceSpace("dungeon", dungeonInst.entranceX, dungeonInst.entranceY, 0);
    const ds = await loadDungeonSession(floor1, partyKey);
    if (ds && ds.members.includes(ownerKey)) {
      const next = { ...ds, dead: ds.dead.includes(ownerKey) ? ds.dead : [...ds.dead, ownerKey] };
      if (dungeonSessionClosed(next)) await deleteDungeonSession(floor1, partyKey);
      else await storeDungeonSession(floor1, next);
    }
    const front = savedAtDeath?.worldReturn ?? { x: dungeonInst.entranceX + 0.5, y: dungeonInst.entranceY + 0.5 };
    if (!(await storeProfile(ownerKey, revived))) return errorResponse("store_failed", 503);
    return NextResponse.json(
      { profile: revived, died: true, dropped, respawn: { x: front.x, y: front.y, source: "entrance" } },
      { headers: NO_STORE },
    );
  }
  const mark = await unionMarkOf(ownerKey);
  const { point, source } = resolveRespawnPoint(
    revived, mark, { x: 0.5, y: 0.5 },
  );
  if (!(await storeProfile(ownerKey, revived))) return errorResponse("store_failed", 503);
  return NextResponse.json(
    { profile: revived, died: true, dropped, respawn: { x: point.x, y: point.y, source } },
    { headers: NO_STORE },
  );
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return errorResponse("forbidden", 403);
  const session = getRequestSession(request);
  if (!session) return errorResponse("unauthorized", 401);
  if (!isProfileEnabled()) return errorResponse("profile_unavailable", 503);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("invalid_request", 400);
  }
  const data = (body ?? {}) as {
    action?: unknown; mobId?: unknown; x?: unknown; y?: unknown; px?: unknown; py?: unknown; space?: unknown;
    targetId?: unknown;
  };
  const ownerKey = sessionOwnerKey(session);
  const now = Date.now();
  const current = await loadProfile(ownerKey);

  if (data.action === "sync") {
    const { profile, died } = stepVitals(current, now);
    if (died) return settleDeath(ownerKey, profile, now, session.username ?? "");
    if (profile.pendingDeath) {
      // 他プレイヤーに倒されていた: 死亡処理は適用済みで、リスポーン移動だけ
      // ここで行う（クライアントは died + respawn で通常の死亡フローに入る）。
      const respawn = profile.pendingDeath;
      const cleared = { ...profile, pendingDeath: null };
      if (!(await storeProfile(ownerKey, cleared))) return errorResponse("store_failed", 503);
      return NextResponse.json({ profile: cleared, died: true, respawn }, { headers: NO_STORE });
    }
    if (profile.pendingTeleport) {
      const teleport = profile.pendingTeleport;
      const cleared = { ...profile, pendingTeleport: null };
      if (!(await storeProfile(ownerKey, cleared))) return errorResponse("store_failed", 503);
      return NextResponse.json({ profile: cleared, died: false, teleport }, { headers: NO_STORE });
    }
    if (profile !== current && !(await storeProfile(ownerKey, profile))) {
      return errorResponse("store_failed", 503);
    }
    return NextResponse.json({ profile, died: false }, { headers: NO_STORE });
  }

  if (data.action === "damage") {
    const def = mobById(data.mobId);
    const instDmg = typeof data.space === "string" ? parseInstanceSpace(data.space) : null;
    const inCave = instDmg?.kind === "cave";
    const inRuins = instDmg?.kind === "ruins";
    const inDungeon = instDmg?.kind === "dungeon";
    if (!def || def.temperament === "passive" || def.attack <= 0 || (def.instanceOnly && !inCave && !inDungeon) || (inCave && def.instanceOnly && def.instanceOnly !== "cave")) {
      return errorResponse("unknown_mob", 400);
    }
    if (typeof data.x !== "number" || typeof data.y !== "number") {
      return errorResponse("invalid_request", 400);
    }
    const x = Math.floor(data.x);
    const y = Math.floor(data.y);
    if (Math.abs(x) > WORLD_COORD_LIMIT || Math.abs(y) > WORLD_COORD_LIMIT) return errorResponse("unknown_mob", 400);
    if (inCave && instDmg) {
      const cave = buildCaveLayer(MAP_SEED, instDmg.entranceX, instDmg.entranceY, instDmg.layer);
      if (!cave.mobs.some((m) => m.mobId === def.id && m.x === x && m.y === y)) {
        return errorResponse("unknown_mob", 400);
      }
    } else if (inDungeon && instDmg) {
      const dfloor = buildDungeonFloor(MAP_SEED, instDmg.entranceX, instDmg.entranceY, instDmg.layer);
      if (!dfloor.mobs.some((m) => m.mobId === def.id && m.x === x && m.y === y)) {
        return errorResponse("unknown_mob", 400);
      }
    } else if (inRuins && instDmg && typeof data.space === "string") {
      const personal = await loadRuinsPersonal(data.space, ownerKey, weekKeyOf(now));
      if (!personal.summons.some((m) => m.mobId === def.id && m.x === x && m.y === y)) {
        return errorResponse("unknown_mob", 400);
      }
    } else {
      const isNight = isNightPhase(phaseAtTime(now / 1000));
      if (!mobExistsAt(MAP_SEED, def.id, x, y, isNight) && !mobExistsAt(MAP_SEED, def.id, x, y, !isNight)) {
        return errorResponse("unknown_mob", 400);
      }
    }
    const reported =
      typeof data.px === "number" && typeof data.py === "number" &&
      Number.isFinite(data.px) && Number.isFinite(data.py) &&
      Math.abs(data.px) <= WORLD_COORD_LIMIT && Math.abs(data.py) <= WORLD_COORD_LIMIT
        ? { x: data.px, y: data.py }
        : null;
    const pos = await actorWorldPosition(ownerKey, reported, (inCave || inRuins || inDungeon) && typeof data.space === "string" ? data.space : "world");
    if (pos) {
      const dist = mobDistance(Math.floor(pos.x), Math.floor(pos.y), { x, y, size: def.size });
      if (dist > MOB_ATTACK_MAX_DISTANCE) return errorResponse("too_far", 409);
    }
    // 凍結中のモブは接触ダメージを与えない
    {
      let keyPrefix = (inCave || inRuins) && typeof data.space === "string" ? `${data.space}|` : "";
      if (inDungeon && typeof data.space === "string") {
        const party = await loadPartyOf(ownerKey);
        keyPrefix = `${data.space}#${partyKeyOf(party, ownerKey)}|`;
      }
      const mstate = await loadMobState(`${keyPrefix}${def.id}@${x},${y}`);
      if (mstate?.frozenUntil && mstate.frozenUntil > now) {
        return NextResponse.json(
          { profile: current, died: false, applied: false, poisoned: false },
          { headers: NO_STORE },
        );
      }
    }
    // 守護の挑発・オーラ（同じ空間の新鮮なプレゼンスから解決する）
    let attack = def.attack;
    {
      const spaceHere = (inCave || inRuins || inDungeon) && typeof data.space === "string" ? data.space : "world";
      const owners = await listPresenceWithOwners();
      const victimPos = pos ?? reported;
      const guards = owners.filter((o) =>
        o.ownerKey !== ownerKey && o.entry.space === spaceHere && o.entry.role === "guard" &&
        victimPos !== null && Math.hypot(o.entry.x - victimPos.x, o.entry.y - victimPos.y) <= 3.5);
      if (guards.length > 0 && victimPos) {
        // 挑発が生きていればモブは守護に向かい、被害は無い
        let taunted = false;
        for (const g of guards) {
          const gProfile = await loadProfile(g.ownerKey);
          if (gProfile && gProfile.tauntUntil > now) { taunted = true; break; }
        }
        if (taunted) {
          return NextResponse.json(
            { profile: current, died: false, applied: false, poisoned: false, taunted: true },
            { headers: NO_STORE },
          );
        }
        attack = Math.max(1, Math.floor(def.attack * (1 - GUARD_AURA_REDUCTION)));
        // 守った守護へ熟練（非同期で保存。失敗しても被害処理は続ける）
        const g0 = guards[0];
        const gProfile = await loadProfile(g0.ownerKey);
        if (gProfile) {
          await storeProfile(g0.ownerKey, addMasteryXp(gProfile, "guard", 2).profile).catch(() => false);
        }
      }
    }
    const result = applyMobDamage(current, def.id, attack, now, Math.random);
    if (result.died) return settleDeath(ownerKey, result.profile, now, session.username ?? "");
    if (!(await storeProfile(ownerKey, result.profile))) return errorResponse("store_failed", 503);
    return NextResponse.json(
      { profile: result.profile, died: false, applied: result.applied, poisoned: result.poisoned },
      { headers: NO_STORE },
    );
  }

  if (data.action === "pvp") {
    // フィールド PvP: ワールドと洞窟・遺跡（共有空間）でのみ許可する。
    const spaceRaw = typeof data.space === "string" ? data.space : "world";
    const instPvp = parseInstanceSpace(spaceRaw);
    const space = spaceRaw === "world"
      ? "world"
      : instPvp && (instPvp.kind === "cave" || instPvp.kind === "ruins") ? spaceRaw : null;
    if (!space) return errorResponse("pvp_not_allowed", 409);
    if (typeof data.targetId !== "string" || data.targetId.length === 0) {
      return errorResponse("invalid_request", 400);
    }
    const targetId = data.targetId;
    const owners = await listPresenceWithOwners();
    const target = owners.find((o) =>
      o.entry.id === targetId && o.entry.space === space && now - o.entry.ts <= 15_000);
    if (!target || target.ownerKey === ownerKey) return errorResponse("target_gone", 409);
    const reported =
      typeof data.px === "number" && typeof data.py === "number" &&
      Number.isFinite(data.px) && Number.isFinite(data.py) &&
      Math.abs(data.px) <= WORLD_COORD_LIMIT && Math.abs(data.py) <= WORLD_COORD_LIMIT
        ? { x: data.px, y: data.py }
        : null;
    const pos = await actorWorldPosition(ownerKey, reported, space);
    if (pos) {
      const dist = mobDistance(Math.floor(pos.x), Math.floor(pos.y), {
        x: Math.floor(target.entry.x), y: Math.floor(target.entry.y), size: 1,
      });
      if (dist > MOB_ATTACK_MAX_DISTANCE) return errorResponse("too_far", 409);
    }
    // ダメージ式はモブ攻撃と同じ（所持する最良の剣、剣士は 1.25 倍）
    const attackPower = playerAttack(current.items, current.enhance) * (current.role === "blade" ? 1.25 : 1);
    const targetKey = target.ownerKey;
    // 対象プロフィールの read-modify-write を対象単位で直列化する
    return withUserLock(`pvp:${targetKey}`, async () => {
      const targetProfile = await loadProfile(targetKey);
      const result = applyPlayerDamage(targetProfile, attackPower, now);
      if (!result.applied) {
        if (!(await storeProfile(targetKey, result.profile))) return errorResponse("store_failed", 503);
        return NextResponse.json(
          { ok: true, applied: false, hp: result.profile.hp, maxHp: maxHpFor(result.profile), dead: false },
          { headers: NO_STORE },
        );
      }
      if (result.died) {
        // 死亡処理（ドロップ・復活）はその場で適用する。攻撃者へは対象の
        // プロフィールを返さず、リスポーン移動は対象本人の次回 sync で行う。
        const savedAtDeath = parseSave(await loadWorldBoxSave(targetKey));
        if (savedAtDeath) {
          await recordDeath({
            ownerKey: targetKey, name: target.entry.name ?? "", space: savedAtDeath.space,
            x: savedAtDeath.x, y: savedAtDeath.y, at: now,
          });
        }
        const { profile: revived } = applyDeath(result.profile, now);
        const mark = await unionMarkOf(targetKey);
        const { point } = resolveRespawnPoint(revived, mark, { x: 0.5, y: 0.5 });
        const stored = { ...revived, pendingDeath: { x: point.x, y: point.y } };
        if (!(await storeProfile(targetKey, stored))) return errorResponse("store_failed", 503);
        return NextResponse.json(
          { ok: true, applied: true, hp: 0, maxHp: maxHpFor(targetProfile), dead: true },
          { headers: NO_STORE },
        );
      }
      if (!(await storeProfile(targetKey, result.profile))) return errorResponse("store_failed", 503);
      return NextResponse.json(
        { ok: true, applied: true, hp: result.profile.hp, maxHp: maxHpFor(result.profile), dead: false },
        { headers: NO_STORE },
      );
    });
  }

  if (data.action === "set_bed") {
    if (typeof data.x !== "number" || typeof data.y !== "number") {
      return errorResponse("invalid_request", 400);
    }
    const x = Math.floor(data.x);
    const y = Math.floor(data.y);
    if (Math.abs(x) > WORLD_COORD_LIMIT || Math.abs(y) > WORLD_COORD_LIMIT) return errorResponse("invalid_request", 400);
    const override = await loadTileOverride(x, y);
    if (!override?.block || override.block.itemId !== "bed") return errorResponse("not_a_bed", 409);
    const pos = await actorWorldPosition(ownerKey, null);
    if (pos && Math.max(Math.abs(Math.floor(pos.x) - x), Math.abs(Math.floor(pos.y) - y)) > 2) {
      return errorResponse("too_far", 409);
    }
    const next = setBedRespawn(current, x, y);
    if (!(await storeProfile(ownerKey, next))) return errorResponse("store_failed", 503);
    return NextResponse.json({ profile: next, respawn: next.respawn }, { headers: NO_STORE });
  }

  return errorResponse("invalid_action", 400);
}
