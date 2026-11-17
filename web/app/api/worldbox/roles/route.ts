import { NextResponse } from "next/server";
import { getRequestSession, publicOrigin, sessionOwnerKey } from "@/lib/auth";
import { MAP_SEED, tileAt } from "@/lib/worldbox/mapgen";
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
  activeSkillFor, addMasteryXp, applyRoleChange, isAdventureRoleId, masteryRankOf,
  roleById, ROLE_CHANGE_REASON, skillCooldownLeft, SKILLS, type SkillId,
} from "@/lib/worldbox/roles";
import { isNationsEnabled, loadNationsState } from "@/lib/worldbox/nations-online";
import { porterInRange, porterTileError } from "@/lib/worldbox/warp";
import { storePorter } from "@/lib/worldbox/warp-online";
import { isOverrideActive } from "@/lib/worldbox/tiles";
import { loadTileOverride } from "@/lib/worldbox/tiles-online";
import { buildEconomyOp } from "@/lib/worldbox/economy-bridge";
import {
  isEconomyEnabled, readUserBalance, submitEconomyOp, waitForOpDone,
} from "@/lib/worldbox/economy-bridge-online";
import { withUserLock } from "@/lib/worldbox/user-lock";
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
//   初めての選択は無料、それ以降の変更は 100,000 コイン（spend role_change、
//   残高不足は 409 not_enough_coins で役職は変わらない）。
// POST { action: "skill", skill, tx, ty, space, px, py }: ダブルタップ技。
//   役職・ランク・クールタイム・対象はすべてサーバーが再計算して検証する。
//   テレポーターの porter は戦闘技ではなく、ダブルタップ地点への
//   ユニオンポーター設置として分岐する（利用は /api/worldbox/warp）。
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
  // テレポーターの発動技はポーター設置（activeSkillFor は戦闘技として返さない）
  const skill = profile.role === "teleporter" ? SKILLS.porter : activeSkillFor(profile);
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
    const targetRole = fields.role;
    // 転職は課金を伴うため、プロフィールの RMW とオプ登録をユーザー単位
    // ロックで直列化し、ロック内で読み直してから判定する。
    return withUserLock(ownerKey, async () => {
      const current = await loadProfile(ownerKey);
      if (!current) return err("roles_unavailable", 503);
      const { profile: next, cost } = applyRoleChange(current, targetRole);
      if (cost <= 0) {
        if (!(await storeProfile(ownerKey, next))) return err("store_failed", 503);
        return NextResponse.json({ ok: true, profile: next, cost: 0 }, { headers: NO_STORE });
      }
      // 課金: 残高を確認し、プロフィールを先に保存してから spend オプを積む。
      // オプを積めなければプロフィールを戻す（購入フローと同じ原子性）。
      const discordId = session.provider === "discord" ? session.id : null;
      if (!discordId) return err("discord_required", 403);
      if (!isEconomyEnabled()) return err("economy_unavailable", 503);
      const balance = await readUserBalance(discordId);
      if (balance === null) return err("economy_unavailable", 503);
      if (balance < cost) return err("not_enough_coins", 409);
      const op = buildEconomyOp(
        { kind: "spend", userKey: ownerKey, discordId, amount: cost, reason: ROLE_CHANGE_REASON },
        crypto.randomUUID(),
        Date.now(),
      );
      if (!op) return err("economy_failed", 503);
      if (!(await storeProfile(ownerKey, next))) return err("store_failed", 503);
      // 提出は直接適用が正（submitEconomyOp）: spend はその場で終端する。
      // 直接適用できずキューへ寄せた（pending）ときだけ従来どおり待つ。
      const submitted = await submitEconomyOp(op);
      if (submitted.state === "unavailable") {
        await storeProfile(ownerKey, current);
        return err("economy_failed", 503);
      }
      // 決済が failed になったら役職を元へ戻す（構造問題#4「即時 spend
      // の無担保交付」の是正: 役職だけ変わって課金されない状態を
      // 作らない）。pending のままなら従来どおり返し、クライアントの
      // ポーリングに引き継ぐ。
      const settled = submitted.state === "pending" ? await waitForOpDone(ownerKey, op.id) : submitted.op;
      if (settled && settled.status === "failed") {
        await storeProfile(ownerKey, current);
        return err("economy_failed", 409);
      }
      return NextResponse.json({ ok: true, profile: next, cost }, { headers: NO_STORE });
    });
  }

  const space = typeof fields.space === "string" ? fields.space : "world";
  const reported =
    typeof fields.px === "number" && typeof fields.py === "number" && Number.isFinite(fields.px) && Number.isFinite(fields.py)
      ? { x: fields.px, y: fields.py }
      : null;
  const pos = await actorPos(ownerKey, space, reported);
  if (!pos) return err("position_unknown", 409);

  if (fields.action === "revive") {
    // 蘇生は2人のプロフィールを書き換える（対象の HP・pendingTeleport と
    // 薬師の reviveMark・熟練）。どちらも本人のユーザー単位ロックで
    // 直列化し、ロック内で読み直す。ロックの入れ子は相互蘇生で循環待ちに
    // なるため、薬師側（使用権の確保）→ 対象側（回復の適用）の順に別々に
    // 取り、対象側が失敗したら薬師側の確保を取り消す。
    // Phase 1: 薬師のロックで使用権を確保する（reviveMark + 熟練）。
    const claimed = await withUserLock(ownerKey, async () => {
      const medic = await loadProfile(ownerKey);
      if (!medic) return { error: err("roles_unavailable", 503) } as const;
      if (medic.role !== "medic") return { error: err("not_medic", 409) } as const;
      if (medic.reviveMark && medic.reviveMark.space === space && now - medic.reviveMark.at < 30 * 60 * 1000) {
        return { error: err("revive_used", 409) } as const;
      }
      const deaths = await listDeaths(now);
      const target = deaths.find(
        (d) => d.space === space && d.ownerKey !== ownerKey && Math.hypot(d.x - pos.x, d.y - pos.y) <= 2.5,
      );
      if (!target) return { error: err("no_fallen", 409) } as const;
      const medicNext = addMasteryXp(
        { ...medic, reviveMark: { space, at: now } },
        "medic",
        10,
      ).profile;
      if (!(await storeProfile(ownerKey, medicNext))) return { error: err("store_failed", 503) } as const;
      return { target, medicNext, prevMark: medic.reviveMark } as const;
    });
    if ("error" in claimed) return claimed.error;
    const { target, medicNext, prevMark } = claimed;
    // Phase 2: 対象のロックで回復を適用する。死亡記録が消えていたら
    // （他の薬師が先に蘇生した等）適用しない。
    const applied = await withUserLock(target.ownerKey, async () => {
      const deaths = await listDeaths(now);
      if (!deaths.some((d) => d.ownerKey === target.ownerKey && d.space === space)) return false;
      const targetProfile = await loadProfile(target.ownerKey);
      if (!targetProfile) return false;
      const healed: PlayerProfile = {
        ...targetProfile,
        hp: Math.max(targetProfile.hp, Math.floor(maxHpFor(targetProfile) * 0.3)),
        pendingTeleport: { space, x: target.x, y: target.y },
      };
      if (!(await storeProfile(target.ownerKey, healed))) return false;
      await clearDeath(target.ownerKey);
      // ダンジョン内蘇生: セッションの dead から外す。残っていると蘇生後も
      // 攻撃不可（mobs ルートが dead を弾く）・全滅判定が誤って閉じてしまう（S5）。
      // セッション保存の失敗は蘇生自体を壊さないため best-effort とする。
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
      return true;
    });
    if (!applied) {
      // 適用できなかった: 薬師の使用権を取り消す（足した熟練を引き、
      // reviveMark は自分が立てたままなら元へ戻す）。取り消しの失敗は
      // 蘇生可否の応答に影響しない。
      await withUserLock(ownerKey, async () => {
        const medic = await loadProfile(ownerKey);
        if (!medic) return;
        const xp = Math.max(0, (medic.mastery.medic?.xp ?? 0) - 10);
        const markIsMine = medic.reviveMark && medic.reviveMark.space === space && medic.reviveMark.at === now;
        await storeProfile(ownerKey, {
          ...medic,
          ...(markIsMine ? { reviveMark: prevMark } : {}),
          mastery: { ...medic.mastery, medic: { xp } },
        }).catch(() => false);
      }).catch(() => undefined);
      return err("no_fallen", 409);
    }
    return NextResponse.json({ ok: true, profile: medicNext, revivedName: target.name }, { headers: NO_STORE });
  }

  if (fields.action === "skill") {
    // 技は自分のプロフィール（skillAt・熟練・ドロップ）とモブ状態を
    // 書き換えるため、ユーザー単位ロックで直列化し、ロック内で読み直した
    // プロフィールで検証・適用する（set_role と同じ型）。ヒーリングゾーンの
    // 味方回復だけは、相手のロックを取る後段に分けて適用する。
    const outcome = await withUserLock(ownerKey, async () => {
      const profile = await loadProfile(ownerKey);
      if (!profile) return err("roles_unavailable", 503);
      if (!isMobsEnabled()) return err("roles_unavailable", 503);
      const skillId = typeof fields.skill === "string" ? (fields.skill as SkillId) : null;
      if (!skillId || !(skillId in SKILLS)) return err("invalid_request", 400);
      const skill = SKILLS[skillId];
      const rank = masteryRankOf(profile, profile.role);
      // 技の所有検証: その役職の技であり、ランクを満たし、現在の発動技と一致する
      // （守護の挑発だけは自分のタイル専用として別に許可する）。
      // テレポーターのポーター設置も activeSkillFor では返さない設置専用の技。
      const active = activeSkillFor(profile);
      const isTaunt = skillId === "taunt" && profile.role === "guard";
      const isPorter = skillId === "porter" && profile.role === "teleporter";
      if (!isTaunt && !isPorter && (!active || active.id !== skillId)) return err("skill_locked", 409);
      if (isTaunt && rank < SKILLS.taunt.minRank) return err("skill_locked", 409);
      if (isPorter && rank < SKILLS.porter.minRank) return err("skill_locked", 409);
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
        // 挑発の使用そのものが守護の専門行為: 熟練を付ける（オーラ軽減の +2 と同水準）
        next = addMasteryXp(next, "guard", 2).profile;
        if (!(await storeProfile(ownerKey, next))) return err("store_failed", 503);
        return NextResponse.json(
          { ok: true, skill: skillId, profile: next, results: [] },
          { headers: NO_STORE },
        );
      }

      if (skillId === "porter") {
        // ポーター設置: ワールド空間・ユニオン所属が前提。設置先は自分の
        // タイルから PORTER_PLACE_RANGE 以内で、通行できるタイルのみ。
        // 保存はギルド ID キーで1件だけ（置き直し = 移動）。
        if (space !== "world") return err("not_in_world", 409);
        if (!isNationsEnabled()) return err("warp_unavailable", 503);
        const nationsState = await loadNationsState();
        const mine = nationsState.members[ownerKey];
        const nation = mine ? nationsState.nations[mine.nationId] : undefined;
        if (!mine || !nation) return err("not_in_union", 409);
        const gx = Math.floor(tx);
        const gy = Math.floor(ty);
        if (!porterInRange(Math.floor(pos.x), Math.floor(pos.y), gx, gy)) {
          return err("too_far", 409);
        }
        const override = await loadTileOverride(gx, gy);
        const hasBlock = !!(override && isOverrideActive(override, now) && override.block);
        const tileError = porterTileError(tileAt(gx, gy, MAP_SEED), hasBlock);
        if (tileError) return err(tileError, 409);
        const porter = { x: gx, y: gy, by: ownerKey, at: now };
        if (!(await storePorter(nation.guildId, porter))) return err("store_failed", 503);
        next = addMasteryXp(next, "teleporter", 2).profile;
        if (!(await storeProfile(ownerKey, next))) return err("store_failed", 503);
        return NextResponse.json(
          { ok: true, skill: skillId, fx: skill.fx, cx: gx + 0.5, cy: gy + 0.5, profile: next, results: [], porter },
          { headers: NO_STORE },
        );
      }

      if (skillId === "heal_zone") {
        // 自分と半径内の味方を回復（味方はプレゼンスの所有者解決で特定する）。
        // 味方のプロフィールは相手のロックで適用する必要があるため、ここでは
        // 自分の回復と熟練だけを確定し、味方は対象キーだけを集めてロックの
        // 外側（skill 分岐の後段）へ返す（ロックの入れ子回避）。
        const owners = await listPresenceWithOwners();
        next = { ...next, hp: Math.min(maxHpFor(next), next.hp + skill.power) };
        // ヒーリングゾーンの使用が薬師の専門行為: 熟練を付ける（食事の +2 と同水準）
        next = addMasteryXp(next, "medic", 2).profile;
        if (!(await storeProfile(ownerKey, next))) return err("store_failed", 503);
        const allyKeys = owners
          .filter((o) => o.ownerKey !== ownerKey && o.entry.space === space &&
            Math.hypot(o.entry.x - pos.x, o.entry.y - pos.y) <= skill.radius)
          .map((o) => o.ownerKey);
        return { healZone: { profile: next, allyKeys, power: skill.power } };
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

      // ダンジョンのフロアボスは技の対象にしない（進行登録は通常攻撃の経路に一本化）。
      // 番人（鍵持ち）は対象のままだが、倒した場合は通常攻撃と同じく鍵を落とす
      // （鍵の付与だけは技経路にも必要。落とさないと再出現まで扉が開けられない）。
      let dungeonKeyHolder: { mobId: string; x: number; y: number } | null = null;
      {
        const instD = parseInstanceSpace(space);
        if (instD?.kind === "dungeon") {
          const floorD = buildDungeonFloor(MAP_SEED, instD.entranceX, instD.entranceY, instD.layer);
          dungeonKeyHolder = floorD.keyHolder;
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
          // 番人を技で倒した場合も通常攻撃と同じくダンジョンの鍵を落とす
          if (dungeonKeyHolder && dungeonKeyHolder.mobId === placed.mobId && dungeonKeyHolder.x === placed.x && dungeonKeyHolder.y === placed.y) {
            gainedAll.dungeon_key = (gainedAll.dungeon_key ?? 0) + 1;
          }
        }
      }
      if (results.length === 0) return err("no_target", 409);
      for (const [id, n] of Object.entries(gainedAll)) next = addItem(next, id, n);
      if (anyDead && profile.role !== "free") {
        // 技での撃破は全役職の熟練になる（従来は剣士だけだった）
        next = addMasteryXp(next, profile.role, 3).profile;
      }
      if (!(await storeProfile(ownerKey, next))) return err("store_failed", 503);
      return NextResponse.json(
        { ok: true, skill: skillId, fx: skill.fx, cx, cy, results, gained: gainedAll, profile: next },
        { headers: NO_STORE },
      );
    });
    if (typeof outcome === "object" && outcome !== null && "healZone" in outcome) {
      // ヒーリングゾーンの味方回復: 相手のロックで1人ずつ読み直して適用する
      const zone = outcome.healZone;
      let healedCount = 1;
      for (const allyKey of zone.allyKeys) {
        const healed = await withUserLock(allyKey, async () => {
          const ally = await loadProfile(allyKey);
          if (!ally || ally.hp <= 0) return false;
          return storeProfile(allyKey, {
            ...ally, hp: Math.min(maxHpFor(ally), ally.hp + zone.power),
          });
        }).catch(() => false);
        if (healed) healedCount++;
      }
      return NextResponse.json(
        { ok: true, skill: "heal_zone", profile: zone.profile, results: [], healedCount },
        { headers: NO_STORE },
      );
    }
    return outcome;
  }

  return err("invalid_request", 400);
}
