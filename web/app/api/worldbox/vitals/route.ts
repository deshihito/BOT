import { NextResponse } from "next/server";
import { getRequestSession, publicOrigin, sessionOwnerKey } from "@/lib/auth";
import { MAP_SEED, WORLD_COORD_LIMIT } from "@/lib/worldbox/mapgen";
import { isNightPhase, phaseAtTime } from "@/lib/worldbox/daynight";
import { mobById } from "@/lib/worldbox/mobs";
import { mobDistance, mobExistsAt, resolveMobPosition, MOB_ATTACK_MAX_DISTANCE } from "@/lib/worldbox/combat";
import { isProfileEnabled, loadProfile, storeProfile } from "@/lib/worldbox/profile-online";
import { listPresence } from "@/lib/worldbox/presence-online";
import { presenceIdFor } from "@/lib/worldbox/presence";
import { parseSave, serializeSave } from "@/lib/worldbox/save";
import { loadWorldBoxSave, storeWorldBoxSave } from "@/lib/worldbox/save-online";
import { loadNationsState } from "@/lib/worldbox/nations-online";
import { loadTileOverride } from "@/lib/worldbox/tiles-online";
import { buildCaveLayer, buildDungeonFloor, makeInstanceSpace, parseInstanceSpace, weekKeyOf } from "@/lib/worldbox/instances";
import { loadRuinsPersonal } from "@/lib/worldbox/instances-online";
import { listPresenceWithOwners, putPresence } from "@/lib/worldbox/presence-online";
import { addMasteryXp, BLADE_ATTACK_MULT, GUARD_AURA_REDUCTION } from "@/lib/worldbox/roles";
import { playerAttack } from "@/lib/worldbox/arena";
import { withUserLock } from "@/lib/worldbox/user-lock";
import { recordDeath } from "@/lib/worldbox/roles-online";
import { loadMobState } from "@/lib/worldbox/mobs-online";
import {
  deleteDungeonSession, dungeonSessionClosed, loadDungeonSession, storeDungeonSession,
} from "@/lib/worldbox/instances-online";
import { partyKeyOf } from "@/lib/worldbox/party";
import { loadPartyOf } from "@/lib/worldbox/party-online";
import type { PlayerProfile, RespawnPoint } from "@/lib/worldbox/profile";
import {
  activityForWindow, applyDeath, applyHazardDamage, applyMobDamage, applyPvpDamage, hazardDamageFor, pvpSpaceAllowed,
  PVP_ATTACK_MAX_DISTANCE, resolveRespawnPoint, setBedRespawn, stepVitals,
} from "@/lib/worldbox/vitals";

export const runtime = "nodejs";

// AGO WORLD BOX のプレイヤーバイタル（HP・空腹・毒・死亡・リスポーン）。
// 状態の正は profile（bot_kv worldbox_profiles）で、遷移規則は vitals.ts。
// POST { action: "sync", px?, py?, space? }: 時間経過の精算（空腹・毒・飢え）。
//   空腹の活動クラスは現在位置と前回精算位置の平均速度からサーバー側で判定する。
//   死亡したら死亡処理まで行う
// POST { action: "damage", mobId, x, y, px?, py?, mx?, my? }: モブ接触ダメージ。
//   配置の再計算で実在を検証し、距離は mobs ルートと同じ方式（プレゼンス→申告→セーブ）。
//   モブの位置も攻撃と同じ実位置ルール（mx/my の申告をリーシュ内でのみ採用）
// POST { action: "pvp", target, px?, py? }: プレイヤーへの攻撃。
//   相手はプレゼンス ID で解決し、空間（ワールド/洞窟/遺跡のみ）・距離を検証する。
//   被害者が死亡したら被害者側の死亡処理を行い、通知は被害者の次回 sync で配送する
// POST { action: "set_bed", x, y }: そのタイルのベッドをリスポーン点にする（近接検証）
// 死亡時は { died: true, dropped, respawn: {x, y} } を返し、クライアントが移動する。
// REST ハートビートには触らない（サーバー検証の正はプレゼンス側）。
// プロフィールの書き込みはユーザー単位ロック（素の ownerKey、他ルートと
// 同じ鍵）で直列化する（B3）: ロック外で読んだスナップショットで保存
// すると、並走する sync / damage / PvP 被弾と上書きし合い、死亡通知
// （lastDeath / pendingTeleport）が消えてドロップした所持品が復活する。

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
    // リスポーン先が新しい連続性の基準になる。更新に失敗しても
    // クライアントは応答で移動する（次回ハートビートで保管位置へ
    // 戻される場合があるが、30秒のリセットで復旧する）。
    if (!(await movePresenceAndSave(ownerKey, { space: "world", x: front.x, y: front.y }, now, name))) {
      console.warn("[worldbox] vitals: respawn position update failed", ownerKey);
    }
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
  if (!(await movePresenceAndSave(ownerKey, { space: "world", x: point.x, y: point.y }, now, name))) {
    console.warn("[worldbox] vitals: respawn position update failed", ownerKey);
  }
  return NextResponse.json(
    { profile: revived, died: true, dropped, respawn: { x: point.x, y: point.y, source } },
    { headers: NO_STORE },
  );
}

/**
 * PvP で倒された被害者側の死亡処理。死亡処理そのものは本人の settleDeath と
 * 同じ規則（死亡地点の記録→所持品の半分ドロップ→リスポーン先の解決）だが、
 * 被害者の画面への配送は被害者の次回 sync で行うため、復活後プロフィールに
 * pendingTeleport（リスポーン地点）と lastDeath（死亡通知）を対で残す。
 * ダンジョン内は PvP 不可なので、入口復活の分岐は無い。
 */
async function settleVictimDeath(
  victimKey: string,
  profile: PlayerProfile,
  now: number,
  name: string,
): Promise<{ dropped: Record<string, number> } | null> {
  const savedAtDeath = parseSave(await loadWorldBoxSave(victimKey));
  if (savedAtDeath) {
    await recordDeath({
      ownerKey: victimKey, name, space: savedAtDeath.space, x: savedAtDeath.x, y: savedAtDeath.y, at: now,
    });
  }
  const { profile: revived, dropped } = applyDeath(profile, now);
  const mark = await unionMarkOf(victimKey);
  const { point } = resolveRespawnPoint(revived, mark, { x: 0.5, y: 0.5 });
  const notified: PlayerProfile = {
    ...revived,
    pendingTeleport: { space: "world", x: point.x, y: point.y },
    lastDeath: { at: now, dropped },
  };
  if (!(await storeProfile(victimKey, notified))) return null;
  return { dropped };
}

/**
 * リスポーン・蘇生の移動先へプレゼンスとセーブをそろえる（B4）。
 * ワープと同じく、サーバー側の移動は両方を目的地へ更新する（移動先が
 * 新しい連続性の基準になる）。worldReturn は従来の値を維持する。
 * どちらかが失敗したら false を返し、呼び出し側が再送・再試行を決める。
 */
async function movePresenceAndSave(
  ownerKey: string,
  dest: { space: string; x: number; y: number },
  now: number,
  name: string,
): Promise<boolean> {
  const prev = parseSave(await loadWorldBoxSave(ownerKey));
  const saved = await storeWorldBoxSave(
    ownerKey,
    serializeSave({ space: dest.space, x: dest.x, y: dest.y, worldReturn: prev?.worldReturn ?? null }),
  );
  if (!saved) return false;
  return putPresence(
    ownerKey,
    { name: name.trim() || "プレイヤー", x: dest.x, y: dest.y, vx: 0, vy: 0, face: 1, space: dest.space },
    now,
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
    mx?: unknown; my?: unknown; target?: unknown;
  };
  const ownerKey = sessionOwnerKey(session);
  const now = Date.now();
  // pvp の攻撃力計算だけに使う読み取り専用スナップショット。sync /
  // damage / set_bed は各アクションのロック内で読み直す（B3）。
  const current = await loadProfile(ownerKey);

  if (data.action === "sync") {
    // プロフィールの読み書きはユーザー単位で直列化し、ロック内で読み直す。
    return withUserLock(ownerKey, async () => {
      const current = await loadProfile(ownerKey);
      // 空腹の活動クラスはサーバー側で判定する（クライアント申告の活動は使わない）。
      // 本人の現在位置（プレゼンス→申告→セーブ、damage と同じ優先順）と
      // profile に残した前回精算位置との平均速度で idle / move / dash に分類し、
      // 現在位置は次回の判定用に profile へ残す。
      const reported =
        typeof data.px === "number" && typeof data.py === "number" &&
        Number.isFinite(data.px) && Number.isFinite(data.py) &&
        Math.abs(data.px) <= WORLD_COORD_LIMIT && Math.abs(data.py) <= WORLD_COORD_LIMIT
          ? { x: data.px, y: data.py }
          : null;
      const space = typeof data.space === "string" && data.space.length > 0 ? data.space.slice(0, 64) : "world";
      const pos = await actorWorldPosition(ownerKey, reported, space);
      const prev = typeof current.vitalX === "number" && typeof current.vitalY === "number" &&
        typeof current.vitalSpace === "string"
        ? { x: current.vitalX, y: current.vitalY, space: current.vitalSpace }
        : null;
      const cur = pos ? { x: pos.x, y: pos.y, space } : null;
      const elapsedSec = current.vitalAt > 0 ? (now - current.vitalAt) / 1000 : 0;
      const activity = activityForWindow(prev, cur, elapsedSec);
      const settled = stepVitals(current, now, activity);
      const died = settled.died;
      const profile = cur
        ? { ...settled.profile, vitalX: cur.x, vitalY: cur.y, vitalSpace: cur.space }
        : settled.profile;
      if (died) return settleDeath(ownerKey, profile, now, session.username ?? "");
      if (profile.lastDeath) {
        // PvP で倒されていた: 死亡通知とリスポーン地点を対で配送し、両方消す
        // （モブ死と同じクライアント死亡フローに乗せる）。
        const death = profile.lastDeath;
        const teleport = profile.pendingTeleport;
        // 移動先へプレゼンスとセーブをそろえてから配送する。更新に失敗
        // したら配送せず、両方残して次回 sync で再送する（更新しないまま
        // 配送すると、次回ハートビートが保管位置への戻しを食らう）。
        if (teleport) {
          if (!(await movePresenceAndSave(ownerKey, teleport, now, session.username ?? ""))) {
            if (!(await storeProfile(ownerKey, profile))) return errorResponse("store_failed", 503);
            return NextResponse.json({ profile, died: false }, { headers: NO_STORE });
          }
        }
        const cleared = { ...profile, pendingTeleport: null, lastDeath: null };
        if (!(await storeProfile(ownerKey, cleared))) return errorResponse("store_failed", 503);
        return NextResponse.json(
          {
            profile: cleared, died: true, dropped: death.dropped,
            ...(teleport ? { respawn: { x: teleport.x, y: teleport.y } } : {}),
          },
          { headers: NO_STORE },
        );
      }
      if (profile.pendingTeleport) {
        const teleport = profile.pendingTeleport;
        // 蘇生の移動先も同じく、更新してから配送する。失敗したら残して次回再送。
        if (!(await movePresenceAndSave(ownerKey, teleport, now, session.username ?? ""))) {
          if (!(await storeProfile(ownerKey, profile))) return errorResponse("store_failed", 503);
          return NextResponse.json({ profile, died: false }, { headers: NO_STORE });
        }
        const cleared = { ...profile, pendingTeleport: null };
        if (!(await storeProfile(ownerKey, cleared))) return errorResponse("store_failed", 503);
        return NextResponse.json({ profile: cleared, died: false, teleport }, { headers: NO_STORE });
      }
      if (profile !== current && !(await storeProfile(ownerKey, profile))) {
        return errorResponse("store_failed", 503);
      }
      return NextResponse.json({ profile, died: false }, { headers: NO_STORE });
    });
  }

  if (data.action === "damage") {
    // sync と同じくユーザー単位ロックで直列化する。守護への熟練付与は
    // 別ユーザーの書き込みのためロックの外へ出し、守護本人のロックで
    // 直列化する（内側に入れると相互攻撃と循環待ちになる）。
    let grantGuard: string | null = null;
    const res = await withUserLock(ownerKey, async () => {
      const current = await loadProfile(ownerKey);
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
      if (!pos) return errorResponse("position_unknown", 409);
      {
        // 距離はアンカーでなく、クライアントが見ているモブの現在タイルで
        // 測る（攻撃と同じ実位置ルール: mx/my の申告はリーシュ内でのみ
        // 採用する）。アンカー基準だと、追跡してきたモブが画面では足元に
        // いても too_far になり接触ダメージが無効化されていた。申告の無い
        // 旧クライアントはアンカー検証のまま。
        const reportedMob =
          typeof data.mx === "number" && typeof data.my === "number" &&
          Number.isFinite(data.mx) && Number.isFinite(data.my) &&
          Math.abs(data.mx) <= WORLD_COORD_LIMIT && Math.abs(data.my) <= WORLD_COORD_LIMIT
            ? { x: data.mx, y: data.my }
            : null;
        const effPlaced = resolveMobPosition({ mobId: def.id, x, y, size: def.size }, reportedMob);
        const dist = mobDistance(Math.floor(pos.x), Math.floor(pos.y), effPlaced);
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
          // 守った守護への熟練はロックの外で付与する（上記コメント参照）。
          // ここでは対象だけを残す。
          grantGuard = guards[0].ownerKey;
        }
      }
      const result = applyMobDamage(current, def.id, attack, now, Math.random);
      if (result.died) return settleDeath(ownerKey, result.profile, now, session.username ?? "");
      if (!(await storeProfile(ownerKey, result.profile))) return errorResponse("store_failed", 503);
      return NextResponse.json(
        { profile: result.profile, died: false, applied: result.applied, poisoned: result.poisoned },
        { headers: NO_STORE },
      );
    });
    if (grantGuard) {
      // 失敗しても被害処理は変えない（従来どおり best-effort）。
      const guardKey = grantGuard;
      await withUserLock(guardKey, async () => {
        const gProfile = await loadProfile(guardKey);
        if (gProfile) await storeProfile(guardKey, addMasteryXp(gProfile, "guard", 2).profile).catch(() => false);
      }).catch(() => undefined);
    }
    return res;
  }

  if (data.action === "pvp") {
    const targetId = typeof data.target === "string" ? data.target : "";
    if (!targetId) return errorResponse("invalid_request", 400);
    // 相手はプレゼンス ID で解決する（所有者キーつき列挙は鮮度フィルタ済み）
    const owners = await listPresenceWithOwners();
    const target = owners.find((o) => o.entry.id === targetId);
    if (!target) return errorResponse("target_not_found", 409);
    if (target.ownerKey === ownerKey) return errorResponse("invalid_target", 409);
    const space = target.entry.space;
    // 許可空間はワールドと洞窟・遺跡のインスタンスだけ（ロビー系・テント・ダンジョンは不可）
    if (!pvpSpaceAllowed(space)) return errorResponse("pvp_not_allowed", 409);
    // 攻撃者も同じ空間にいること（自分のプレゼンスが別空間を指していたら拒否）
    const selfEntry = owners.find((o) => o.ownerKey === ownerKey);
    if (selfEntry && selfEntry.entry.space !== space) return errorResponse("pvp_not_allowed", 409);
    const reported =
      typeof data.px === "number" && typeof data.py === "number" &&
      Number.isFinite(data.px) && Number.isFinite(data.py) &&
      Math.abs(data.px) <= WORLD_COORD_LIMIT && Math.abs(data.py) <= WORLD_COORD_LIMIT
        ? { x: data.px, y: data.py }
        : null;
    const pos = await actorWorldPosition(ownerKey, reported, space);
    if (!pos) return errorResponse("too_far", 409);
    // 相手の位置は相手のプレゼンス実測。自分の位置は damage と同じ優先順で解決する
    const dist = Math.hypot(pos.x - target.entry.x, pos.y - target.entry.y);
    if (dist > PVP_ATTACK_MAX_DISTANCE) return errorResponse("too_far", 409);
    // ダメージ量はモブ戦と同じ式（playerAttack、剣士は倍率）
    const attackPower = playerAttack(current.items, current.enhance) * (current.role === "blade" ? BLADE_ATTACK_MULT : 1);
    // 被害者プロフィールの読み書きは被害者単位で直列化する（同時攻撃の競合防止）。
    // 鍵は被害者本人の sync / damage と同じ素の ownerKey にする（B3）:
    // 別鍵だと被害者の sync が古いスナップショットで死亡通知を上書きし、
    // ドロップした所持品が復活する。攻撃者側のロックは取らない（取ると
    // 相互攻撃で循環待ちになる。攻撃力の読み取りだけは上の current で足りる）。
    return withUserLock(target.ownerKey, async () => {
      const victim = await loadProfile(target.ownerKey);
      const result = applyPvpDamage(victim, attackPower, now);
      if (result.died) {
        const settled = await settleVictimDeath(target.ownerKey, result.profile, now, target.entry.name ?? "");
        if (!settled) return errorResponse("store_failed", 503);
        return NextResponse.json(
          { applied: result.applied, damage: result.damage, died: true },
          { headers: NO_STORE },
        );
      }
      if (!(await storeProfile(target.ownerKey, result.profile))) return errorResponse("store_failed", 503);
      return NextResponse.json(
        { applied: result.applied, damage: result.damage, died: false },
        { headers: NO_STORE },
      );
    });
  }

  if (data.action === "hazard") {
    // 環境ハザード（サボテン・マグマ）: 位置は申告させず、サーバー側の現在位置の
    // 当たり円が触れているタイルにハザードブロックがあるときだけダメージ。
    // ハザードは固体ブロックなので「足元」ではなく「接触」で判定する。
    // sync / damage と同じくユーザー単位ロックで直列化し、ロック内で
    // 読み直す（ロック外スナップショットの RMW は、並走する sync の
    // バイタル精算や被弾を巻き戻しうる）。
    return withUserLock(ownerKey, async () => {
      const current = await loadProfile(ownerKey);
      const pos = await actorWorldPosition(ownerKey, null);
      if (!pos) {
        return NextResponse.json({ profile: current, died: false, applied: false }, { headers: NO_STORE });
      }
      let dmg = 0;
      const r = 0.32;
      for (let ty = Math.floor(pos.y - r); ty <= Math.floor(pos.y + r); ty++) {
        for (let tx = Math.floor(pos.x - r); tx <= Math.floor(pos.x + r); tx++) {
          const override = await loadTileOverride(tx, ty);
          if (override?.block) dmg = Math.max(dmg, hazardDamageFor(override.block.itemId));
        }
      }
      if (dmg <= 0) {
        return NextResponse.json({ profile: current, died: false, applied: false }, { headers: NO_STORE });
      }
      const result = applyHazardDamage(current, dmg, now);
      if (result.died) return settleDeath(ownerKey, result.profile, now, session.username ?? "");
      if (result.profile !== current && !(await storeProfile(ownerKey, result.profile))) {
        return errorResponse("store_failed", 503);
      }
      return NextResponse.json(
        { profile: result.profile, died: false, applied: result.applied },
        { headers: NO_STORE },
      );
    });
  }

  if (data.action === "set_bed") {
    // sync / damage と同じくユーザー単位ロックで直列化する（B3）。
    return withUserLock(ownerKey, async () => {
      const current = await loadProfile(ownerKey);
      if (typeof data.x !== "number" || typeof data.y !== "number") {
        return errorResponse("invalid_request", 400);
      }
      const x = Math.floor(data.x);
      const y = Math.floor(data.y);
      if (Math.abs(x) > WORLD_COORD_LIMIT || Math.abs(y) > WORLD_COORD_LIMIT) return errorResponse("invalid_request", 400);
      const override = await loadTileOverride(x, y);
      if (!override?.block || override.block.itemId !== "bed") return errorResponse("not_a_bed", 409);
      const pos = await actorWorldPosition(ownerKey, null);
      if (!pos) return errorResponse("position_unknown", 409);
      if (Math.max(Math.abs(Math.floor(pos.x) - x), Math.abs(Math.floor(pos.y) - y)) > 2) {
        return errorResponse("too_far", 409);
      }
      const next = setBedRespawn(current, x, y);
      if (!(await storeProfile(ownerKey, next))) return errorResponse("store_failed", 503);
      return NextResponse.json({ profile: next, respawn: next.respawn }, { headers: NO_STORE });
    });
  }

  return errorResponse("invalid_action", 400);
}
