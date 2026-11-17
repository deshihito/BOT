import { NextResponse } from "next/server";
import { getRequestSession, publicOrigin, sessionOwnerKey } from "@/lib/auth";
import { MAP_SEED, WORLD_COORD_LIMIT } from "@/lib/worldbox/mapgen";
import { loadProfile, storeProfile } from "@/lib/worldbox/profile-online";
import { listPresence } from "@/lib/worldbox/presence-online";
import { presenceIdFor } from "@/lib/worldbox/presence";
import { parseSave } from "@/lib/worldbox/save";
import { loadWorldBoxSave } from "@/lib/worldbox/save-online";
import { addItem, bestToolItem, wearTool } from "@/lib/worldbox/profile";
import { playerAttack } from "@/lib/worldbox/arena";
import { mobById } from "@/lib/worldbox/mobs";
import { isNightPhase, phaseAtTime } from "@/lib/worldbox/daynight";
import {
  applyMobAttack, mobDistance, mobExistsAt, mobKeyOf, resolveMobPosition, visibleMobs,
  MOB_ATTACK_MAX_DISTANCE, type MobState,
} from "@/lib/worldbox/combat";
import { isMobsEnabled, loadMobState, loadMobStates, storeMobState } from "@/lib/worldbox/mobs-online";
import {
  buildCaveLayer, buildDungeonFloor, dungeonHpScale, makeInstanceSpace, parseInstanceSpace, weekKeyOf,
} from "@/lib/worldbox/instances";
import { addMasteryXp } from "@/lib/worldbox/roles";
import {
  dungeonGateSatisfied, loadDungeonClearWeek, loadDungeonSession, loadRuinsPersonal, storeDungeonClearWeek,
  storeDungeonSession, storeRuinsPersonal,
} from "@/lib/worldbox/instances-online";
import { partyKeyOf } from "@/lib/worldbox/party";
import { loadPartyOf } from "@/lib/worldbox/party-online";
import { DUNGEON_CLEAR_EARN } from "@/lib/worldbox/instances";
import { buildEconomyOp } from "@/lib/worldbox/economy-bridge";
import { enqueueEconomyOpOnce, isEconomyEnabled } from "@/lib/worldbox/economy-bridge-online";
import { withUserLock } from "@/lib/worldbox/user-lock";

export const runtime = "nodejs";

// AGO WORLD BOX のフィールド戦闘（モブへの攻撃）。
// モブの配置は mobs.ts の決定的配置が正で、個体は "mobId@x,y" で識別する。
// サーバーは攻撃のたびに配置を再計算して実在を検証し、HP と死亡
// （再出現待ち）だけを bot_kv（名前空間 worldbox_mobs）に持つ。
// ダメージは闘技場と同じ式（素手8 + 所持する最良の剣 tier×4）。
// GET ?x0&y0&x1&y1: 範囲内の個体のうち状態がある（傷/死亡）ものだけ返す。
// POST { action: "attack", mobId, x, y }: 攻撃を適用し、HP と戦利品を返す。
// Bot API 未設定なら 503（クライアントはモブなしで遊び続ける）。

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

/** GET で返す範囲の上限（1辺のタイル数）。 */
const MAX_RECT_SPAN = 128;

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return !origin || origin === publicOrigin(request);
}

function clampIntParam(raw: string | null, min: number, max: number, fallback: number): number {
  const n = raw === null ? NaN : Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

/**
 * 距離検証に使う本人のワールド位置。新鮮なプレゼンス → クライアント申告 →
 * セーブの順。プレゼンスは WS 中継中 bot_kv に届かず凍結するため、申告位置を
 * フォールバックに使う（ハートビート自体が元々クライアント申告制）。
 * どれも無ければ null（検証スキップ）。
 */
async function actorWorldPosition(
  ownerKey: string,
  reported?: { x: number; y: number } | null,
): Promise<{ x: number; y: number } | null> {
  const selfId = presenceIdFor(ownerKey);
  const entries = await listPresence();
  const now = Date.now();
  const entry = entries.find((e) => e.id === selfId && e.space === "world" && now - e.ts <= 15_000);
  if (entry) return { x: entry.x, y: entry.y };
  if (reported) return reported;
  const saved = parseSave(await loadWorldBoxSave(ownerKey));
  if (saved && saved.space === "world") return { x: saved.x, y: saved.y };
  return null;
}

export async function GET(request: Request) {
  const session = getRequestSession(request);
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  }
  if (!isMobsEnabled()) {
    return NextResponse.json({ error: "mobs_unavailable" }, { status: 503, headers: NO_STORE });
  }
  const url = new URL(request.url);
  const x0 = clampIntParam(url.searchParams.get("x0"), -WORLD_COORD_LIMIT, WORLD_COORD_LIMIT, 0);
  const y0 = clampIntParam(url.searchParams.get("y0"), -WORLD_COORD_LIMIT, WORLD_COORD_LIMIT, 0);
  const x1 = clampIntParam(url.searchParams.get("x1"), x0, Math.min(WORLD_COORD_LIMIT, x0 + MAX_RECT_SPAN - 1), x0);
  const y1 = clampIntParam(url.searchParams.get("y1"), y0, Math.min(WORLD_COORD_LIMIT, y0 + MAX_RECT_SPAN - 1), y0);
  const now = Date.now();
  const spaceParam = url.searchParams.get("space");
  const instGet = spaceParam ? parseInstanceSpace(spaceParam) : null;
  if (instGet?.kind === "ruins" && spaceParam) {
    // 警報罠の召喚モブはプレイヤー専用。配置は個人状態が正。
    const personal = await loadRuinsPersonal(spaceParam, sessionOwnerKey(session), weekKeyOf(now));
    const allR = await loadMobStates();
    const statesR: Record<string, MobState> = {};
    const summons = personal.summons.map((sm) => {
      const def = mobById(sm.mobId);
      return { mobId: sm.mobId, x: sm.x, y: sm.y, biome: "plains" as const, size: def?.size ?? 1 };
    });
    for (const placed of summons) {
      const key = `${spaceParam}|${mobKeyOf(placed)}`;
      const st = allR[key];
      if (st && !(st.deadUntil !== undefined && now >= st.deadUntil)) statesR[key] = st;
    }
    return NextResponse.json(
      { states: statesR, summons, selfId: presenceIdFor(sessionOwnerKey(session)) },
      { headers: NO_STORE },
    );
  }
  if (instGet?.kind === "dungeon") {
    const ownerKey = sessionOwnerKey(session);
    const party = await loadPartyOf(ownerKey);
    const partyKey = partyKeyOf(party, ownerKey);
    const floor1 = makeInstanceSpace("dungeon", instGet.entranceX, instGet.entranceY, 0);
    const ds = await loadDungeonSession(floor1, partyKey);
    const floor = buildDungeonFloor(MAP_SEED, instGet.entranceX, instGet.entranceY, instGet.layer);
    const allD = await loadMobStates();
    const statesD: Record<string, MobState> = {};
    for (const placed of floor.mobs) {
      const key = `${spaceParam}#${partyKey}|${mobKeyOf(placed)}`;
      const st = allD[key];
      if (!st) continue;
      if (st.deadUntil !== undefined && now >= st.deadUntil) continue;
      statesD[key] = st;
    }
    return NextResponse.json(
      { states: statesD, hpScale: dungeonHpScale(ds?.size ?? 1), selfId: presenceIdFor(ownerKey) },
      { headers: NO_STORE },
    );
  }
  if (instGet?.kind === "cave") {
    const cave = buildCaveLayer(MAP_SEED, instGet.entranceX, instGet.entranceY, instGet.layer);
    const allC = await loadMobStates();
    const statesC: Record<string, MobState> = {};
    for (const placed of cave.mobs) {
      const key = `${spaceParam}|${mobKeyOf(placed)}`;
      const st = allC[key];
      if (!st) continue;
      if (st.deadUntil !== undefined && now >= st.deadUntil) continue;
      statesC[key] = st;
    }
    return NextResponse.json(
      { states: statesC, selfId: presenceIdFor(sessionOwnerKey(session)) },
      { headers: NO_STORE },
    );
  }
  const isNight = isNightPhase(phaseAtTime(now / 1000));
  const all = await loadMobStates();
  const states: Record<string, MobState> = {};
  for (const placed of visibleMobs(MAP_SEED, x0, y0, x1, y1, isNight)) {
    const key = mobKeyOf(placed);
    const st = all[key];
    if (!st) continue;
    if (st.deadUntil !== undefined && now >= st.deadUntil) continue; // 復活済みは満タン扱い
    states[key] = st;
  }
  return NextResponse.json(
    { states, selfId: presenceIdFor(sessionOwnerKey(session)) },
    { headers: NO_STORE },
  );
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403, headers: NO_STORE });
  }
  const session = getRequestSession(request);
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  }
  if (!isMobsEnabled()) {
    return NextResponse.json({ error: "mobs_unavailable" }, { status: 503, headers: NO_STORE });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400, headers: NO_STORE });
  }
  const fields = (body ?? {}) as { action?: unknown; mobId?: unknown; x?: unknown; y?: unknown; px?: unknown; py?: unknown; mx?: unknown; my?: unknown; space?: unknown };
  if (fields.action !== "attack" || typeof fields.x !== "number" || typeof fields.y !== "number") {
    return NextResponse.json({ error: "invalid_request" }, { status: 400, headers: NO_STORE });
  }
  const reported =
    typeof fields.px === "number" && typeof fields.py === "number" &&
    Number.isFinite(fields.px) && Number.isFinite(fields.py) &&
    fields.px >= -WORLD_COORD_LIMIT && fields.py >= -WORLD_COORD_LIMIT && fields.px <= WORLD_COORD_LIMIT && fields.py <= WORLD_COORD_LIMIT
      ? { x: fields.px, y: fields.py }
      : null;
  const def = mobById(fields.mobId);
  const x = Math.floor(fields.x);
  const y = Math.floor(fields.y);
  const instPost = typeof fields.space === "string" ? parseInstanceSpace(fields.space) : null;
  const caveSpace = instPost?.kind === "cave" || instPost?.kind === "ruins" ? (fields.space as string) : null;
  const dungeonSpace = instPost?.kind === "dungeon" ? (fields.space as string) : null;
  if (!def || x < -WORLD_COORD_LIMIT || y < -WORLD_COORD_LIMIT || x > WORLD_COORD_LIMIT || y > WORLD_COORD_LIMIT) {
    return NextResponse.json({ error: "unknown_mob" }, { status: 400, headers: NO_STORE });
  }
  const now = Date.now();
  const ownerKey = sessionOwnerKey(session);
  const placed = { mobId: def.id, x, y, size: def.size, biome: "plains" as const };
  let keyPrefix = "";
  let effDef = def;
  let dungeonCtx: {
    floor1: string; partyKey: string;
    session: NonNullable<Awaited<ReturnType<typeof loadDungeonSession>>>;
    floor: ReturnType<typeof buildDungeonFloor>;
  } | null = null;
  if (dungeonSpace && instPost) {
    const party = await loadPartyOf(ownerKey);
    const partyKey = partyKeyOf(party, ownerKey);
    const floor1 = makeInstanceSpace("dungeon", instPost.entranceX, instPost.entranceY, 0);
    const ds = await loadDungeonSession(floor1, partyKey);
    if (!ds || !ds.members.includes(ownerKey) || ds.departed.includes(ownerKey) || ds.dead.includes(ownerKey)) {
      return NextResponse.json({ error: "no_session" }, { status: 409, headers: NO_STORE });
    }
    if (!(await dungeonGateSatisfied(ds.members, instPost.layer + 1))) {
      return NextResponse.json({ error: "gate_locked" }, { status: 409, headers: NO_STORE });
    }
    const floor = buildDungeonFloor(MAP_SEED, instPost.entranceX, instPost.entranceY, instPost.layer);
    if (!floor.mobs.some((m) => m.mobId === def.id && m.x === x && m.y === y)) {
      return NextResponse.json({ error: "unknown_mob" }, { status: 400, headers: NO_STORE });
    }
    const isBossAnchor = floor.boss.mobId === def.id && floor.boss.x === x && floor.boss.y === y;
    if (isBossAnchor) {
      if (instPost.layer >= 1 && !ds.floorBossDead[String(instPost.layer)]) {
        return NextResponse.json({ error: "gate_locked" }, { status: 409, headers: NO_STORE });
      }
      if (floor.doors.length > 0 && !ds.doors[`${instPost.layer}:0`]) {
        return NextResponse.json({ error: "door_locked" }, { status: 409, headers: NO_STORE });
      }
    }
    effDef = { ...def, hp: Math.max(1, Math.round(def.hp * dungeonHpScale(ds.size))) };
    keyPrefix = `${dungeonSpace}#${partyKey}|`;
    dungeonCtx = { floor1, partyKey, session: ds, floor };
  }
  if (caveSpace && instPost) {
    // インスタンス内モブ: 配置は生成/個人状態が正。地表配置の検証は使わない。
    if (instPost.kind === "ruins") {
      const personal = await loadRuinsPersonal(caveSpace, ownerKey, weekKeyOf(now));
      if (!personal.summons.some((m) => m.mobId === def.id && m.x === x && m.y === y)) {
        return NextResponse.json({ error: "unknown_mob" }, { status: 400, headers: NO_STORE });
      }
    } else {
      if (def.instanceOnly && def.instanceOnly !== "cave") {
        return NextResponse.json({ error: "unknown_mob" }, { status: 400, headers: NO_STORE });
      }
      const cave = buildCaveLayer(MAP_SEED, instPost.entranceX, instPost.entranceY, instPost.layer);
      if (!cave.mobs.some((m) => m.mobId === def.id && m.x === x && m.y === y)) {
        return NextResponse.json({ error: "unknown_mob" }, { status: 400, headers: NO_STORE });
      }
    }
    keyPrefix = `${caveSpace}|`;
  } else {
    if (def.instanceOnly) {
      return NextResponse.json({ error: "unknown_mob" }, { status: 400, headers: NO_STORE });
    }
    const isNight = isNightPhase(phaseAtTime(now / 1000));
    if (!mobExistsAt(MAP_SEED, def.id, x, y, isNight)) {
      return NextResponse.json({ error: "unknown_mob" }, { status: 400, headers: NO_STORE });
    }
  }

  // 隣接検証（本人の位置が分かる場合だけ、占有範囲までの距離）
  const pos = caveSpace || dungeonSpace
    ? await (async () => {
        const selfId = presenceIdFor(ownerKey);
        const entries = await listPresence();
        const entry = entries.find((e) => e.id === selfId && e.space === (caveSpace ?? dungeonSpace) && now - e.ts <= 15_000);
        if (entry) return { x: entry.x, y: entry.y };
        return reported;
      })()
    : await actorWorldPosition(ownerKey, reported);
  if (!pos) {
    return NextResponse.json({ error: "position_unknown" }, { status: 409, headers: NO_STORE });
  }
  {
    // 距離はアンカーでなく「画面で見えている現在タイル」で測る。モブの
    // 見た目はアンカーから最大で LEASH_DISTANCE ほど離れて追跡してくる
    // ため、アンカー基準だと足元のモブにも too_far になってしまう。
    // 申告タイルはリーシュ内でのみ採用する（resolveMobPosition）。
    const reportedMob =
      typeof fields.mx === "number" && typeof fields.my === "number" &&
      Number.isFinite(fields.mx) && Number.isFinite(fields.my) &&
      fields.mx >= -WORLD_COORD_LIMIT && fields.my >= -WORLD_COORD_LIMIT &&
      fields.mx <= WORLD_COORD_LIMIT && fields.my <= WORLD_COORD_LIMIT
        ? { x: fields.mx, y: fields.my }
        : null;
    const effPlaced = resolveMobPosition(placed, reportedMob);
    const dist = mobDistance(Math.floor(pos.x), Math.floor(pos.y), effPlaced);
    if (dist > MOB_ATTACK_MAX_DISTANCE) {
      return NextResponse.json({ error: "too_far" }, { status: 409, headers: NO_STORE });
    }
  }

  const key = keyPrefix + mobKeyOf(placed);
  // 同一個体への並行攻撃を直列化する（S4）: ロック無しだと二重タップで
  // 同じ個体を2回倒してドロップと熟練 XP を二重に得られる。
  return withUserLock(`mob:${key}`, async () => {
        const state = await loadMobState(key);
        const profile = await loadProfile(ownerKey);
        const attackPower = playerAttack(profile.items, profile.enhance) * (profile.role === "blade" ? 1.25 : 1);
        const result = applyMobAttack(effDef, state, attackPower, now, Math.random, key);
        if ("error" in result) {
          return NextResponse.json({ error: result.error }, { status: 409, headers: NO_STORE });
        }
        if (!(await storeMobState(key, result.state))) {
          return NextResponse.json({ error: "mobs_failed" }, { status: 500, headers: NO_STORE });
        }
        if (result.dead && dungeonCtx && instPost) {
          // 番人はダンジョンの鍵を落とす
          if (dungeonCtx.floor.keyHolder.mobId === def.id && dungeonCtx.floor.keyHolder.x === x && dungeonCtx.floor.keyHolder.y === y) {
            result.gained.dungeon_key = (result.gained.dungeon_key ?? 0) + 1;
          }
          // フロアボス撃破で階段が開く。最終ボスはクリア処理（週1 earn を全員へ）
          const isBossAnchor = dungeonCtx.floor.boss.mobId === def.id && dungeonCtx.floor.boss.x === x && dungeonCtx.floor.boss.y === y;
          if (isBossAnchor) {
            const floorNo = instPost.layer + 1;
            const nextSession = {
              ...dungeonCtx.session,
              floorBossDead: { ...dungeonCtx.session.floorBossDead, [String(floorNo)]: true },
              bossDead: dungeonCtx.session.bossDead || floorNo >= 4,
            };
            await storeDungeonSession(dungeonCtx.floor1, nextSession);
            if (floorNo >= 4 && isEconomyEnabled()) {
              const week = weekKeyOf(now);
              for (const memberKey of nextSession.members) {
                if (nextSession.departed.includes(memberKey) || nextSession.dead.includes(memberKey)) continue;
                if (!memberKey.startsWith("discord:")) continue;
                if ((await loadDungeonClearWeek(memberKey)) === week) continue;
                // 週1回の報酬は決定的 ID で冪等化する（#953 の規則: 同時撃破でも二重に払わない）
                const op = buildEconomyOp(
                  { kind: "earn", userKey: memberKey, discordId: memberKey.slice("discord:".length), amount: DUNGEON_CLEAR_EARN, reason: "dungeon_clear" },
                  `dungeon-clear-${week}-${memberKey.slice("discord:".length)}`,
                  now,
                );
                if (op && (await enqueueEconomyOpOnce(op))) {
                  await storeDungeonClearWeek(memberKey, week);
                }
              }
            }
          }
        }
        if (result.dead && caveSpace && instPost?.kind === "ruins") {
          // 倒した召喚モブは個人状態から消す（再出現しない）
          const personal = await loadRuinsPersonal(caveSpace, ownerKey, weekKeyOf(now));
          personal.summons = personal.summons.filter((m) => !(m.mobId === def.id && m.x === x && m.y === y));
          await storeRuinsPersonal(caveSpace, ownerKey, personal);
        }
        let updatedProfile = null;
        let next = profile;
        let broke: string | null = null;
        // 道具の耐久: 剣を持っていれば振るたびに最良の剣が摩耗する
        // （素手の攻撃は摩耗なし）。従来は死亡時しかプロフィールを保存
        // しなかったが、摩耗を積算するため剣がある場合は毎回保存する。
        if (bestToolItem(profile, "sword")) {
          const worn = wearTool(next, "sword");
          next = worn.profile;
          broke = worn.brokeItemId;
        }
        if (result.dead && (Object.keys(result.gained).length > 0 || profile.role === "blade")) {
          for (const [itemId, count] of Object.entries(result.gained)) {
            next = addItem(next, itemId, count);
          }
          if (profile.role === "blade") next = addMasteryXp(next, "blade", 3).profile;
        }
        if (next !== profile) {
          if (!(await storeProfile(ownerKey, next))) {
            return NextResponse.json({ error: "mobs_failed" }, { status: 500, headers: NO_STORE });
          }
          updatedProfile = next;
        }
        return NextResponse.json(
          {
            ok: true,
            key,
            hp: result.hp,
            maxHp: def.hp,
            dead: result.dead,
            // 復活時刻はサーバーの正を返す。クライアントが自時計で捏造すると
            // 時計ズレで復活がずれる（S4）。dead でない場合は含めない。
            ...(result.state.deadUntil !== undefined ? { deadUntil: result.state.deadUntil } : {}),
            gained: result.gained,
            ...(updatedProfile ? { profile: updatedProfile } : {}),
            ...(broke ? { broke } : {}),
          },
          { headers: NO_STORE },
        );
  });
}
