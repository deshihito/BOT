import { NextResponse } from "next/server";
import { getRequestSession, publicOrigin, sessionOwnerKey } from "@/lib/auth";
import { loadNationsState, storeNationsState } from "@/lib/worldbox/nations-online";
import { nationViews, type NationsState } from "@/lib/worldbox/nations";
import { loadMyLobbyStation } from "@/lib/worldbox/station-online";
import { listPresence } from "@/lib/worldbox/presence-online";
import { presenceIdFor } from "@/lib/worldbox/presence";
import { parseSave } from "@/lib/worldbox/save";
import { loadWorldBoxSave } from "@/lib/worldbox/save-online";
import { loadWarState, storeWarState, isWarsEnabled, withWarLock } from "@/lib/worldbox/war-online";
import {
  attackMark, declareWar, expireWars, prosperityRanking, repairMark,
  warView, WAR_MARK_RANGE, type WarState,
} from "@/lib/worldbox/war";
import {
  isNationHiddenFrom, memberKeysOf, resolveMemberRole,
} from "@/lib/worldbox/nation-settings";
import { loadNationSettings, loadNationSettingsMap } from "@/lib/worldbox/nation-settings-online";

export const runtime = "nodejs";

// AGO WORLD BOX のユニオン戦争（バッチ7a）。
// GET: 進行中・最近の戦争、戦争履歴、繁栄ランキング、自分の所属。
// POST { action: "declare", targetId }: ギルドボード前で王/大臣だけが
//   他国へレイド宣言する（即戦争状態、24時間）。
// POST { action: "attack_mark", warId }: 攻撃側の国民が防衛国の首都の
//   2タイル以内からマーク HP を削る。0 になると防衛国は解散する。
// POST { action: "repair_mark", warId }: 防衛側の国民が首都の2タイル以内
//   からマーク HP を回復する。
// コインの流れは無い（略奪は戦争中の他者ブロック採掘の現物のみ）。
// 位置・所属・役職・クールダウンはすべてサーバーが再検証する。

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return !origin || origin === publicOrigin(request);
}

function err(error: string, status = 409) {
  return NextResponse.json({ error }, { status, headers: NO_STORE });
}

/** サーバーが知る本人のワールド位置（プレゼンス → 報告位置 → セーブの順）。無ければ null。 */
async function actorWorldPosition(
  ownerKey: string,
  reported: { x: number; y: number } | null,
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

function nearCapital(pos: { x: number; y: number }, capital: { x: number; y: number }): boolean {
  return Math.max(Math.abs(Math.floor(pos.x) - capital.x), Math.abs(Math.floor(pos.y) - capital.y)) <= WAR_MARK_RANGE;
}

/** マーク破壊で防衛国を解散する（国とその所属を消す）。 */
function disbandNation(state: NationsState, nationId: string): NationsState {
  const nations = { ...state.nations };
  delete nations[nationId];
  const members = Object.fromEntries(
    Object.entries(state.members).filter(([, m]) => m.nationId !== nationId),
  );
  return { nations, members };
}

/** 期限切れの戦争を引き分けで閉じる。呼び出し側が withWarLock を取ること。 */
async function loadExpired(now: number): Promise<WarState> {
  const state = await loadWarState();
  const expired = expireWars(state, now);
  if (expired !== state) await storeWarState(expired);
  return expired;
}

/**
 * マーク破壊で終わった戦争のうち、防衛国がまだ残っているものを
 * 解散させる（冪等な後始末）。attack_mark は戦争の保存→解散の順で
 * 書くため、解散の保存が失敗すると戦争だけ閉じて国が残る窓がある。
 * ここで毎リクエスト精算することで、次の war リクエストが必ず
 * 回復する。戦争終了より後に建国された同 ID の国（再建国）は
 * 対象にしない。呼び出し側が withWarLock を取ること。
 */
async function settleDisbands(warState: WarState): Promise<void> {
  const targets = Object.values(warState.wars).filter(
    (w) => w.status === "closed" && w.outcome === "attacker_win",
  );
  if (targets.length === 0) return;
  let nationsState = await loadNationsState();
  let changed = false;
  for (const war of targets) {
    const nation = nationsState.nations[war.defenderId];
    if (!nation) continue;
    if (nation.createdAt > (war.endedAt ?? 0)) continue;
    nationsState = disbandNation(nationsState, war.defenderId);
    changed = true;
  }
  if (changed) await storeNationsState(nationsState);
}

/** 戦争状態の読み込み（期限精算＋解散の後始末つき）。RMW 全体を直列化する。 */
async function loadWarStateSettled(now: number): Promise<WarState> {
  return withWarLock(async () => {
    const warState = await loadExpired(now);
    await settleDisbands(warState);
    return warState;
  });
}

export async function GET(request: Request) {
  const session = getRequestSession(request);
  if (!session) return err("unauthorized", 401);
  if (!isWarsEnabled()) return err("wars_unavailable", 503);
  const ownerKey = sessionOwnerKey(session);
  const now = Date.now();
  const warState = await loadWarStateSettled(now);
  const [nationsState, settingsMap] = await Promise.all([
    loadNationsState(), loadNationSettingsMap(),
  ]);
  const views = nationViews(nationsState);
  const mine = nationsState.members[ownerKey];
  const wars = Object.values(warState.wars)
    .sort((a, b) => b.declaredAt - a.declaredAt)
    .slice(0, 10)
    .map(warView);
  return NextResponse.json(
    {
      wars,
      history: warState.history,
      // 非公開の国はランキングに載せない（自国民には自国分のみ見える）
      ranking: prosperityRanking(
        views
          .filter((n) => !isNationHiddenFrom(settingsMap.get(n.guildId), n.guildId, mine?.nationId ?? null))
          .map((n) => ({
            id: n.guildId, name: n.name, color: n.color,
            members: n.members, prosperity: n.prosperity, createdAt: n.createdAt,
          })),
      ),
      me: mine ? { nationId: mine.nationId, role: mine.role } : null,
      loggedIn: true,
    },
    { headers: NO_STORE },
  );
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403, headers: NO_STORE });
  }
  const session = getRequestSession(request);
  if (!session) return err("unauthorized", 401);
  if (!isWarsEnabled()) return err("wars_unavailable", 503);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return err("invalid_request", 400);
  }
  const fields = (body ?? {}) as { action?: unknown; targetId?: unknown; warId?: unknown; px?: unknown; py?: unknown };
  const ownerKey = sessionOwnerKey(session);
  const now = Date.now();
  const reported =
    typeof fields.px === "number" && typeof fields.py === "number" && Number.isFinite(fields.px) && Number.isFinite(fields.py)
      ? { x: fields.px, y: fields.py }
      : null;
  // 戦争状態は単一キーの RMW で複数ギルドが同時に触るため、期限精算・
  // 解散の後始末・各アクションの読み書き全体を state 単位で直列化する。
  return withWarLock(() => handlePost(fields, ownerKey, now, reported));
}

type WarFields = { action?: unknown; targetId?: unknown; warId?: unknown; px?: unknown; py?: unknown };

async function handlePost(
  fields: WarFields,
  ownerKey: string,
  now: number,
  reported: { x: number; y: number } | null,
) {
  const warState = await loadExpired(now);
  await settleDisbands(warState);
  const nationsState = await loadNationsState();
  const mine = nationsState.members[ownerKey];
  if (!mine) return err("not_in_nation");

  if (fields.action === "declare") {
    // 役職は国家設定込みで解決する（任命大臣も宣言できる）
    const myNation = nationsState.nations[mine.nationId];
    const mySettings = await loadNationSettings(mine.nationId);
    const resolved = myNation
      ? resolveMemberRole(myNation, mySettings, ownerKey, mine.role, memberKeysOf(nationsState, mine.nationId))
      : null;
    if (!resolved || (resolved.role !== "king" && resolved.role !== "minister")) {
      return err("forbidden_role", 403);
    }
    if ((await loadMyLobbyStation(ownerKey)) !== "guild") return err("not_at_guild_board");
    const targetId = typeof fields.targetId === "string" ? fields.targetId : "";
    const attacker = nationsState.nations[mine.nationId];
    const defender = nationsState.nations[targetId];
    if (!attacker || !defender) return err("nation_not_found");
    const result = declareWar(
      warState,
      { id: attacker.guildId, name: attacker.name },
      { id: defender.guildId, name: defender.name },
      now,
    );
    if (!result.ok) return err(result.error);
    if (!(await storeWarState(result.state))) return err("store_failed", 503);
    return NextResponse.json({ ok: true, war: warView(result.war) }, { headers: NO_STORE });
  }

  const warId = typeof fields.warId === "string" ? fields.warId : "";
  const war = warState.wars[warId];
  if (!war || war.status !== "active") return err("not_at_war");
  const selfId = presenceIdFor(ownerKey);

  if (fields.action === "attack_mark") {
    if (war.attackerId !== mine.nationId) return err("not_attacker");
    const defender = nationsState.nations[war.defenderId];
    if (!defender) return err("nation_not_found");
    const pos = await actorWorldPosition(ownerKey, reported);
    if (!pos) return err("position_unknown");
    if (!nearCapital(pos, defender.capital)) return err("too_far");
    const result = attackMark(warState, warId, selfId, now);
    if (!result.ok) return err(result.error);
    if (!(await storeWarState(result.state))) return err("store_failed", 503);
    if (result.destroyed) {
      // マーク破壊 = 防衛国の解散。戦争の記録は既に保存済み。
      // ここの保存が失敗しても、閉じた戦争と残った国は次回リクエストの
      // settleDisbands が冪等に解散させる（回復経路）。
      const nationsNext = disbandNation(nationsState, war.defenderId);
      if (!(await storeNationsState(nationsNext))) return err("store_failed", 503);
    }
    return NextResponse.json(
      { ok: true, war: warView(result.war), destroyed: result.destroyed },
      { headers: NO_STORE },
    );
  }

  if (fields.action === "repair_mark") {
    if (war.defenderId !== mine.nationId) return err("not_defender");
    const defender = nationsState.nations[war.defenderId];
    if (!defender) return err("nation_not_found");
    const pos = await actorWorldPosition(ownerKey, reported);
    if (!pos) return err("position_unknown");
    if (!nearCapital(pos, defender.capital)) return err("too_far");
    const result = repairMark(warState, warId, selfId, now);
    if (!result.ok) return err(result.error);
    if (!(await storeWarState(result.state))) return err("store_failed", 503);
    return NextResponse.json({ ok: true, war: warView(result.war) }, { headers: NO_STORE });
  }

  return err("invalid_action", 400);
}
