import { NextResponse } from "next/server";
import { getRequestSession, publicOrigin, sessionOwnerKey } from "@/lib/auth";
import { buildEconomyOp, type EconomyOp } from "@/lib/worldbox/economy-bridge";
import {
  enqueueEconomyOpOnce, isEconomyEnabled, loadMyEconomyOps, readUserBalance,
} from "@/lib/worldbox/economy-bridge-online";
import { casinoMachineNear } from "@/lib/worldbox/casino";
import {
  CASINO_TOURNAMENT_ENTRY_MS, CASINO_TOURNAMENT_FEE, CASINO_TOURNAMENT_MAX_ENTRANTS,
  CASINO_TOURNAMENT_PLAY_MS, casinoTournamentFeeOpId, casinoTournamentId,
  publicCasinoTournamentView, type CasinoTournament,
} from "@/lib/worldbox/casino-tournament";
import {
  advanceCasinoTournamentInner, loadCurrentCasinoTournament, saveCasinoTournament,
} from "@/lib/worldbox/casino-tournament-online";
import { buildLobby } from "@/lib/worldbox/lobby";
import { isPresenceEnabled, loadMyPresence } from "@/lib/worldbox/presence-online";
import { withUserLock } from "@/lib/worldbox/user-lock";

export const runtime = "nodejs";

// AGO WORLD BOX のカジノ大会（バッチ7c）。
// 参加費 200 のスコア制大会。募集 30 分のあと 60 分の対局時間があり、
// その間にカジノで遊んだ gamble オプの純益（配当 - ベット）の合計で
// 順位を競う。純益がプラスの上位 3 人が参加費の総額を 50% / 30% / 20%
// で分ける（earn casino_tournament_prize）。2人未満で締め切られた
// 大会は不成立で参加費を earn（casino_tournament_refund）で返す。
// 参加はカジノの機器の前でのみ（サーバーがプレゼンスで検証）。
// 大会は1件だけのため、全 POST を固定キー "casino-tournament" の
// ロックで直列化する。
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

function casinoTournamentSession(request: Request) {
  const session = getRequestSession(request);
  if (!session) return { session: null, status: 401 as const };
  if (session.provider !== "discord") return { session: null, status: 403 as const };
  return { session, status: 200 as const };
}

/** 今いるカジノ機器（無ければ null）。カジノルートと同じ検証。 */
async function currentMachine(ownerKey: string) {
  if (!isPresenceEnabled()) return null;
  const presence = await loadMyPresence(ownerKey);
  if (!presence || presence.space !== "lobby") return null;
  return casinoMachineNear(
    buildLobby().objects,
    Math.floor(presence.x),
    Math.floor(presence.y),
  );
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

async function stateResponse(ownerKey: string, discordId: string, t: CasinoTournament | null) {
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
      tournament: publicCasinoTournamentView(t, discordId),
    },
    { headers: NO_STORE },
  );
}

export async function GET(request: Request) {
  const { session, status } = casinoTournamentSession(request);
  if (!session) return errorResponse("unauthorized", status);
  if (!isEconomyEnabled()) return errorResponse("economy_unavailable", 503);
  const t = await withUserLock("casino-tournament", () => loadCurrentCasinoTournament(Date.now()));
  return stateResponse(sessionOwnerKey(session), session.id, t);
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return errorResponse("bad_origin", 403);
  const { session, status } = casinoTournamentSession(request);
  if (!session) return errorResponse("unauthorized", status);
  if (!isEconomyEnabled()) return errorResponse("economy_unavailable", 503);
  return withUserLock("casino-tournament", () => handlePost(request, session));
}

type AuthedSession = NonNullable<ReturnType<typeof casinoTournamentSession>["session"]>;

async function enqueueFee(ownerKey: string, discordId: string, id: string): Promise<EconomyOp | null> {
  const op = buildEconomyOp(
    { kind: "spend", userKey: ownerKey, discordId, amount: CASINO_TOURNAMENT_FEE, reason: "casino_tournament_entry" },
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

  // 場所検証: 参加はカジノの機器の前でのみ
  if (!(await currentMachine(ownerKey))) return errorResponse("not_at_casino", 409);

  const now = Date.now();
  let t = await loadCurrentCasinoTournament(now);
  if (t && t.status !== "entry") return errorResponse("tournament_closed", 409);
  if (t && t.entrants.includes(discordId)) return stateResponse(ownerKey, discordId, t);
  if (t && t.entrants.length >= CASINO_TOURNAMENT_MAX_ENTRANTS) return errorResponse("tournament_full", 409);

  const mine = await effectiveBalanceOf(ownerKey, discordId);
  if (mine === null || mine < CASINO_TOURNAMENT_FEE) return errorResponse("insufficient_balance", 409);

  if (!t) {
    t = {
      id: casinoTournamentId(now), status: "entry", createdAt: now,
      entryEndsAt: now + CASINO_TOURNAMENT_ENTRY_MS,
      playEndsAt: now + CASINO_TOURNAMENT_ENTRY_MS + CASINO_TOURNAMENT_PLAY_MS,
      playStartedAt: null,
      entrants: [], scores: {},
      prizesPaid: false, refundPaid: false, closedAt: null,
    };
  }
  const fee = await enqueueFee(ownerKey, discordId, casinoTournamentFeeOpId(t.id, discordId));
  if (!fee) return errorResponse("economy_unavailable", 503);
  t = { ...t, entrants: [...t.entrants, discordId] };
  // 満員になったらその場で募集を締め切って対局時間へ入る
  t = await advanceCasinoTournamentInner(t, now);
  await saveCasinoTournament(t);
  return stateResponse(ownerKey, discordId, t);
}
