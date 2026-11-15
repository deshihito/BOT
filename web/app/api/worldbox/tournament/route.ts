import { NextResponse } from "next/server";
import { getRequestSession, publicOrigin, sessionOwnerKey } from "@/lib/auth";
import { buildEconomyOp, type EconomyOp } from "@/lib/worldbox/economy-bridge";
import {
  enqueueEconomyOpOnce, isEconomyEnabled, loadMyEconomyOps, readUserBalance,
} from "@/lib/worldbox/economy-bridge-online";
import { loadMyPvpDuel } from "@/lib/worldbox/pvp-online";
import { loadMyLobbyStation } from "@/lib/worldbox/station-online";
import {
  closeEntryInner, loadCurrentTournament, saveTournament,
} from "@/lib/worldbox/tournament-online";
import {
  TOURNAMENT_ENTRY_MS, TOURNAMENT_FEE, TOURNAMENT_MAX_ENTRANTS,
  publicTournamentView, tournamentFeeOpId, tournamentId, type Tournament,
} from "@/lib/worldbox/tournament";
import { withUserLock } from "@/lib/worldbox/user-lock";

export const runtime = "nodejs";

// AGO WORLD BOX の闘技場大会（バッチ7c）。
// 参加費 200 のトーナメント（最大8人、シングルエリミネーション）。
// 募集は最初の参加から 30 分。対戦は既存の PvP 決闘エンジンで戦い、
// 大会の対戦に試合ごとの参加費・賞金は無い。優勝者が参加費の総額を
// earn（arena_tournament_prize）で受け取る。2人未満で締め切られた
// 大会は不成立で参加費を earn（arena_tournament_refund）で返す。
// 遊べるのはプレゼンスがロビーの闘技場にいるときだけ（サーバー検証）。
// 大会は1件だけのため、全 POST を固定キー "tournament" のロックで直列化する。
// GET: { balance, effectiveBalance, tournament }
// POST: { action: "enter" }

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return !origin || origin === publicOrigin(request);
}

function errorResponse(error: string, status: number) {
  return NextResponse.json({ error }, { status, headers: NO_STORE });
}

function tournamentSession(request: Request) {
  const session = getRequestSession(request);
  if (!session) return { session: null, status: 401 as const };
  if (session.provider !== "discord") return { session: null, status: 403 as const };
  return { session, status: 200 as const };
}

async function effectiveBalanceOf(ownerKey: string, discordId: string): Promise<number | null> {
  const balance = await readUserBalance(discordId);
  if (balance === null) return null;
  const ops = await loadMyEconomyOps(ownerKey);
  const pending = ops
    .filter((op) => op.status === "pending" && op.kind === "spend")
    .reduce((sum, op) => sum + op.amount, 0);
  return balance - pending;
}

async function stateResponse(ownerKey: string, discordId: string, t: Tournament | null) {
  const [balance, ops] = await Promise.all([
    readUserBalance(discordId),
    loadMyEconomyOps(ownerKey),
  ]);
  const pending = ops
    .filter((op) => op.status === "pending" && op.kind === "spend")
    .reduce((sum, op) => sum + op.amount, 0);
  return NextResponse.json(
    {
      balance,
      effectiveBalance: balance === null ? null : balance - pending,
      tournament: publicTournamentView(t, discordId),
    },
    { headers: NO_STORE },
  );
}

export async function GET(request: Request) {
  const { session, status } = tournamentSession(request);
  if (!session) return errorResponse("unauthorized", status);
  if (!isEconomyEnabled()) return errorResponse("economy_unavailable", 503);
  const t = await withUserLock("tournament", () => loadCurrentTournament(Date.now()));
  return stateResponse(sessionOwnerKey(session), session.id, t);
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return errorResponse("bad_origin", 403);
  const { session, status } = tournamentSession(request);
  if (!session) return errorResponse("unauthorized", status);
  if (!isEconomyEnabled()) return errorResponse("economy_unavailable", 503);
  return withUserLock("tournament", () => handlePost(request, session));
}

type AuthedSession = NonNullable<ReturnType<typeof tournamentSession>["session"]>;

async function enqueueFee(ownerKey: string, discordId: string, id: string): Promise<EconomyOp | null> {
  const op = buildEconomyOp(
    { kind: "spend", userKey: ownerKey, discordId, amount: TOURNAMENT_FEE, reason: "arena_tournament_entry" },
    id,
    Date.now(),
  );
  if (!op) return null;
  return (await enqueueEconomyOpOnce(op)) ? op : null;
}

async function handlePost(request: Request, session: AuthedSession) {
  const ownerKey = sessionOwnerKey(session);
  const discordId = session.id;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return errorResponse("bad_json", 400);
  }
  if (body.action !== "enter") return errorResponse("bad_action", 400);

  // 場所検証: 参加は闘技場にいなければ進めない
  const station = await loadMyLobbyStation(ownerKey);
  if (station !== "arena") return errorResponse("not_at_arena", 409);

  // 決闘中の参加はできない（大会の対戦が始まったときに重ならないため）
  if (await loadMyPvpDuel(ownerKey)) return errorResponse("session_active", 409);

  const now = Date.now();
  let t = await loadCurrentTournament(now);
  if (t && t.status !== "entry") return errorResponse("tournament_closed", 409);
  if (t && t.entrants.includes(discordId)) return stateResponse(ownerKey, discordId, t);
  if (t && t.entrants.length >= TOURNAMENT_MAX_ENTRANTS) return errorResponse("tournament_full", 409);

  const mine = await effectiveBalanceOf(ownerKey, discordId);
  if (mine === null || mine < TOURNAMENT_FEE) return errorResponse("insufficient_balance", 409);

  if (!t) {
    t = {
      id: tournamentId(now), status: "entry", createdAt: now,
      entryEndsAt: now + TOURNAMENT_ENTRY_MS,
      entrants: [], matches: [], champion: null,
      prizePaid: false, refundPaid: false, closedAt: null,
    };
  }
  const fee = await enqueueFee(ownerKey, discordId, tournamentFeeOpId(t.id, discordId));
  if (!fee) return errorResponse("economy_unavailable", 503);
  t = { ...t, entrants: [...t.entrants, discordId] };
  // 満員になったらその場で締め切って表を作る
  t = await closeEntryInner(t, now);
  await saveTournament(t);
  return stateResponse(ownerKey, discordId, t);
}
