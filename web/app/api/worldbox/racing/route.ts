import { NextResponse } from "next/server";
import { getRequestSession, publicOrigin, sessionOwnerKey } from "@/lib/auth";
import { buildEconomyOp, GAMBLE_PAYOUT_MAX } from "@/lib/worldbox/economy-bridge";
import {
  enqueueEconomyOpOnce, findEconomyOp, isEconomyEnabled, readUserBalance, submitEconomyOp,
} from "@/lib/worldbox/economy-bridge-online";
import {
  BET_CLOSE_BEFORE_MS, RACE_DURATION_MS, generateRaceCore, isBettingOpen,
  recentForm, scheduleAt, validateBetAmount,
} from "@/lib/worldbox/racing";
import { horseById } from "@/lib/worldbox/racing/horses";
import {
  appendPopularity, loadMyBets, loadOrEstimateOdds, loadPopularity, popularityCounts,
  saveMyBets, settleMyBets, type RaceBet, type RaceBetType,
} from "@/lib/worldbox/racing-online";
import { loadMyLobbyStation } from "@/lib/worldbox/station-online";

export const runtime = "nodejs";

// AGO WORLD BOX の競馬（ロビー競馬場、LHA 統合 Phase 1）。
// 通常レースは30分間隔で自動開催され、出走表・着順・オッズは
// racing.ts の決定的ロジックからいつでも再計算できる（保存しない）。
// 馬券の購入は馬券カウンター（station "race"）の前にいるときだけ。
// お金は経済ブリッジ経由のみ: 購入 = spend 先払い（race-bet-<betId>）、
// 的中 = prepaid gamble（race-settle-<betId>、理由 horse_racing）。
// GET: { balance, next, running, last, myBets }
// POST: { action: "bet", postMs, horseId, type, amount, clientBetId }

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

const userLocks = new Map<string, Promise<void>>();

async function withUserLock<T>(userKey: string, fn: () => Promise<T>): Promise<T> {
  const prev = userLocks.get(userKey) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = prev.then(() => gate);
  userLocks.set(userKey, tail);
  await prev.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    if (userLocks.get(userKey) === tail) userLocks.delete(userKey);
  }
}

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return !origin || origin === publicOrigin(request);
}

function errorResponse(error: string, status: number) {
  return NextResponse.json({ error }, { status, headers: NO_STORE });
}

function racingSession(request: Request) {
  const session = getRequestSession(request);
  if (!session) return { session: null, status: 401 as const };
  if (session.provider !== "discord") return { session: null, status: 403 as const };
  return { session, status: 200 as const };
}

type AuthedSession = NonNullable<ReturnType<typeof racingSession>["session"]>;
type Ctx = { userKey: string; discordId: string };

const BET_ID_RE = /^[A-Za-z0-9-]{8,64}$/;

function publicBet(bet: RaceBet) {
  const horse = horseById(bet.horseId);
  return {
    betId: bet.betId,
    postMs: bet.postMs,
    horseId: bet.horseId,
    horseName: horse?.name ?? "",
    type: bet.type,
    amount: bet.amount,
    odds: bet.type === "win" ? bet.oddsWin : bet.oddsPlace,
    settle: bet.settle,
    payout: bet.payout,
  };
}

/** 終了した自分の馬券を精算し、保存まで済ませた最新の馬券一覧を返す。 */
async function settleAndLoad(ctx: Ctx): Promise<RaceBet[]> {
  const bets = await loadMyBets(ctx.userKey);
  const { bets: settled, changed } = await settleMyBets(ctx.userKey, bets, Date.now(), async (bet, payout) => {
    const op = buildEconomyOp(
      {
        kind: "gamble", userKey: ctx.userKey, discordId: ctx.discordId,
        amount: bet.amount, reason: "horse_racing",
        payout: Math.min(payout, GAMBLE_PAYOUT_MAX), prepaid: true,
      },
      `race-settle-${bet.betId}`,
      Date.now(),
    );
    if (!op) return false;
    return enqueueEconomyOpOnce(op);
  });
  if (changed) await saveMyBets(ctx.userKey, settled);
  return settled;
}

export async function GET(request: Request) {
  const { session, status } = racingSession(request);
  if (!session) return errorResponse(status === 401 ? "unauthorized" : "discord_required", status);
  return withUserLock(sessionOwnerKey(session), () => handleGet(session));
}

async function handleGet(session: AuthedSession) {
  if (!isEconomyEnabled()) return errorResponse("economy_unavailable", 503);
  const ctx: Ctx = { userKey: sessionOwnerKey(session), discordId: session.id };
  const now = Date.now();
  const balance = await readUserBalance(session.id);
  if (balance === null) return errorResponse("economy_unavailable", 503);
  const myBets = await settleAndLoad(ctx);
  const sched = scheduleAt(now);

  // 次走（出走表 + オッズ + 人気 + 近走）
  const nextCore = generateRaceCore(sched.nextPostMs);
  const [nextOdds, popularity] = await Promise.all([
    loadOrEstimateOdds(sched.nextPostMs),
    loadPopularity(sched.nextPostMs),
  ]);
  const popCounts = popularityCounts(popularity);
  const next = {
    postMs: sched.nextPostMs,
    closesAtMs: sched.nextPostMs - BET_CLOSE_BEFORE_MS,
    bettingOpen: isBettingOpen(sched.nextPostMs, now),
    track: nextCore.track.name,
    surface: nextCore.surface,
    distanceM: nextCore.distanceM,
    going: nextCore.going,
    entries: nextCore.entries.map((e) => ({
      gate: e.gate,
      horseId: e.horse.id,
      name: e.horse.name,
      sex: e.horse.sex,
      age: e.horse.age,
      coat: e.horse.coat,
      style: e.horse.style,
      form: recentForm(e.horse.id, sched.nextPostMs, 3).map((f) => [f.placing, f.fieldSize]),
      popularity: popCounts.get(e.horse.id) ?? { win: 0, place: 0 },
      odds: nextOdds[e.horse.id] ?? { win: 0, place: 0 },
    })),
  };

  // 演出中のレース（観戦アニメ用: 出走表だけ渡し、位置はクライアントが pose で作る）
  const runningCore = sched.runningPostMs !== null ? generateRaceCore(sched.runningPostMs) : null;
  const running = runningCore !== null && sched.runningPostMs !== null
    ? {
        postMs: sched.runningPostMs,
        endsAtMs: sched.runningPostMs + RACE_DURATION_MS,
        track: runningCore.track.name,
        entries: runningCore.entries.map((e) => ({
          gate: e.gate, horseId: e.horse.id, name: e.horse.name, coat: e.horse.coat,
        })),
      }
    : null;

  // 直近の結果
  const lastCore = generateRaceCore(sched.lastPostMs);
  const last = {
    postMs: sched.lastPostMs,
    track: lastCore.track.name,
    surface: lastCore.surface,
    distanceM: lastCore.distanceM,
    going: lastCore.going,
    placings: lastCore.placings.map((horseId, i) => ({
      place: i + 1,
      horseId,
      name: horseById(horseId)?.name ?? "",
      margin: i === 0 ? "" : (lastCore.margins[horseId] ?? ""),
    })),
  };

  return NextResponse.json(
    {
      balance,
      serverNow: now,
      next,
      running,
      last,
      myBets: myBets.slice(0, 20).map(publicBet),
    },
    { headers: NO_STORE },
  );
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return errorResponse("forbidden", 403);
  const { session, status } = racingSession(request);
  if (!session) return errorResponse(status === 401 ? "unauthorized" : "discord_required", status);
  return withUserLock(sessionOwnerKey(session), () => handlePost(request, session));
}

async function handlePost(request: Request, session: AuthedSession) {
  if (!isEconomyEnabled()) return errorResponse("economy_unavailable", 503);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("invalid_request", 400);
  }
  const fields = (body ?? {}) as Record<string, unknown>;
  if (fields.action !== "bet") return errorResponse("invalid_action", 400);
  const ctx: Ctx = { userKey: sessionOwnerKey(session), discordId: session.id };

  const station = await loadMyLobbyStation(ctx.userKey);
  if (station !== "race") return errorResponse("not_at_racecourse", 409);

  const postMs = typeof fields.postMs === "number" ? fields.postMs : NaN;
  const horseId = typeof fields.horseId === "number" ? fields.horseId : NaN;
  const type: RaceBetType | null = fields.type === "win" || fields.type === "place" ? fields.type : null;
  const amount = validateBetAmount(fields.amount);
  const clientBetId = typeof fields.clientBetId === "string" ? fields.clientBetId : "";
  if (!Number.isFinite(postMs) || !Number.isFinite(horseId) || type === null || amount === null || !BET_ID_RE.test(clientBetId)) {
    return errorResponse("invalid_bet", 400);
  }
  const betId = clientBetId;

  const now = Date.now();
  const sched = scheduleAt(now);
  if (postMs !== sched.nextPostMs || !isBettingOpen(postMs, now)) {
    return errorResponse("betting_closed", 409);
  }
  const core = generateRaceCore(postMs);
  if (!core.entries.some((e) => e.horse.id === horseId)) {
    return errorResponse("invalid_bet", 400);
  }

  const bets = await loadMyBets(ctx.userKey);
  const existing = bets.find((b) => b.betId === betId);
  if (existing) {
    // 同じ購入意図のリトライ: 二重に買わず既存を返す。
    return NextResponse.json({ ok: true, bet: publicBet(existing), duplicated: true }, { headers: NO_STORE });
  }

  const odds = await loadOrEstimateOdds(postMs);
  const horseOdds = odds[horseId];
  if (!horseOdds) return errorResponse("invalid_bet", 400);

  const spendOpId = `race-bet-${betId}`;
  const already = await findEconomyOp(ctx.userKey, spendOpId);
  if (!already) {
    const op = buildEconomyOp(
      { kind: "spend", userKey: ctx.userKey, discordId: ctx.discordId, amount, reason: "horse_racing_bet" },
      spendOpId,
      now,
    );
    if (!op) return errorResponse("invalid_bet", 400);
    const submitted = await submitEconomyOp(op);
    if (submitted.state === "unavailable") return errorResponse("economy_unavailable", 503);
    if (submitted.state === "failed" || submitted.op.status === "failed") {
      return errorResponse("bet_failed", 409);
    }
  }

  const bet: RaceBet = {
    betId,
    postMs,
    horseId,
    type,
    amount,
    oddsWin: horseOdds.win,
    oddsPlace: horseOdds.place,
    spendOpId,
    settle: "open",
    payout: null,
    createdAt: now,
  };
  bets.push(bet);
  await saveMyBets(ctx.userKey, bets);
  await appendPopularity(postMs, { horseId, type, amount });
  return NextResponse.json({ ok: true, bet: publicBet(bet) }, { headers: NO_STORE });
}
