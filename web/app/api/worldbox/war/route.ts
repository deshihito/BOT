import { NextResponse } from "next/server";
import { getRequestSession, publicOrigin, sessionOwnerKey } from "@/lib/auth";
import { loadNationsState, storeNationsState } from "@/lib/worldbox/nations-online";
import { nationViews, type NationsState } from "@/lib/worldbox/nations";
import { loadMyLobbyStation } from "@/lib/worldbox/station-online";
import { listPresence } from "@/lib/worldbox/presence-online";
import { presenceIdFor } from "@/lib/worldbox/presence";
import { parseSave } from "@/lib/worldbox/save";
import { loadWorldBoxSave } from "@/lib/worldbox/save-online";
import { loadWarState, storeWarState, isWarsEnabled } from "@/lib/worldbox/war-online";
import {
  activeWarFor, attackMark, declareWar, expireWars, prosperityRanking, repairMark,
  warView, WAR_MARK_RANGE, type WarState,
} from "@/lib/worldbox/war";

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

async function loadExpired(now: number): Promise<WarState> {
  const state = await loadWarState();
  const expired = expireWars(state, now);
  if (expired !== state) await storeWarState(expired);
  return expired;
}

export async function GET(request: Request) {
  const session = getRequestSession(request);
  if (!session) return err("unauthorized", 401);
  if (!isWarsEnabled()) return err("wars_unavailable", 503);
  const ownerKey = sessionOwnerKey(session);
  const now = Date.now();
  const [warState, nationsState] = await Promise.all([loadExpired(now), loadNationsState()]);
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
      ranking: prosperityRanking(views.map((n) => ({
        id: n.guildId, name: n.name, color: n.color,
        members: n.members, prosperity: n.prosperity, createdAt: n.createdAt,
      }))),
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
  const warState = await loadExpired(now);
  const nationsState = await loadNationsState();
  const mine = nationsState.members[ownerKey];
  if (!mine) return err("not_in_nation");

  if (fields.action === "declare") {
    if (mine.role !== "king" && mine.role !== "minister") return err("forbidden_role", 403);
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
