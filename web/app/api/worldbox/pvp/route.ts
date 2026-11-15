import { NextResponse } from "next/server";
import { getRequestSession, publicOrigin, sessionOwnerKey } from "@/lib/auth";
import { playerAttack } from "@/lib/worldbox/arena";
import { buildEconomyOp, type EconomyOp } from "@/lib/worldbox/economy-bridge";
import {
  enqueueEconomyOpOnce, findEconomyOp, isEconomyEnabled, loadMyEconomyOps, readUserBalance,
} from "@/lib/worldbox/economy-bridge-online";
import { loadProfile } from "@/lib/worldbox/profile-online";
import {
  PVP_FEE, PVP_PRIZE, createDuel, publicPvpView, pvpPrizeOpId, pvpStep, tryMatch,
  type PvpDuel, type PvpMove, type PvpQueueEntry,
} from "@/lib/worldbox/pvp";
import { clearPvpDuel, loadMyPvpDuel, loadPvpQueue, savePvpDuel, savePvpQueue } from "@/lib/worldbox/pvp-online";
import { loadMyLobbyStation } from "@/lib/worldbox/station-online";
import { advanceTournamentMatch } from "@/lib/worldbox/tournament-online";
import { withUserLock } from "@/lib/worldbox/user-lock";

export const runtime = "nodejs";

// AGO WORLD BOX の闘技場PvP（ロビー北の半円アリーナ、バッチ7c）。
// 遊べるのはプレゼンスがロビーの闘技場にいるときだけ（サーバー検証）。
// マッチング待ち行列で2人を組み合わせ、両者の参加費を spend（arena_pvp_entry）
// で先払いし、適用が done になるまで決闘は始まらない（PvE と同じ型）。
// 勝者は賞金 earn（arena_pvp_prize、Plan A の原資ルール内）を決定的 ID で1件だけ積む。
// 決闘は2人の共有状態のため、全 POST を固定キー "pvp" のロックで直列化する
// （片方のキュー参加と片方の1手が同時に走ると、同じ相手と2試合できてしまう）。
// GET: { balance, effectiveBalance, attack, queued, queuePosition, duel }
// POST: { action: "queue" } / { action: "leave" } / { action: "act", move } / { action: "forfeit" }

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return !origin || origin === publicOrigin(request);
}

function errorResponse(error: string, status: number) {
  return NextResponse.json({ error }, { status, headers: NO_STORE });
}

function pvpSession(request: Request) {
  const session = getRequestSession(request);
  if (!session) return { session: null, status: 401 as const };
  if (session.provider !== "discord") return { session: null, status: 403 as const };
  return { session, status: 200 as const };
}

async function enqueue(userKey: string, discordId: string, input: {
  kind: "spend" | "earn";
  amount: number;
  reason: string;
  /** 決定的 ID（指定時は冪等登録: 同 ID が既にあれば作り直さない）。 */
  id?: string;
}): Promise<EconomyOp | null> {
  const op = buildEconomyOp(
    { kind: input.kind, userKey, discordId, amount: input.amount, reason: input.reason },
    input.id ?? crypto.randomUUID(),
    Date.now(),
  );
  if (!op) return null;
  const stored = input.id ? await enqueueEconomyOpOnce(op) : false;
  return stored ? op : null;
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

async function stateResponse(ownerKey: string, discordId: string) {
  const [balance, ops, queue, duel, profile] = await Promise.all([
    readUserBalance(discordId),
    loadMyEconomyOps(ownerKey),
    loadPvpQueue(),
    loadMyPvpDuel(ownerKey),
    loadProfile(ownerKey),
  ]);
  const pending = ops
    .filter((op) => op.status === "pending" && op.kind === "spend")
    .reduce((sum, op) => sum + op.amount, 0);
  const myIndex = queue.findIndex((e) => e.discordId === discordId);
  return NextResponse.json(
    {
      balance,
      effectiveBalance: balance === null ? null : balance - pending,
      attack: playerAttack(profile.items, profile.enhance),
      queued: myIndex >= 0,
      queuePosition: myIndex >= 0 ? myIndex + 1 : null,
      duel: duel ? publicPvpView(duel, discordId) : null,
    },
    { headers: NO_STORE },
  );
}

export async function GET(request: Request) {
  const { session, status } = pvpSession(request);
  if (!session) return errorResponse("unauthorized", status);
  if (!isEconomyEnabled()) return errorResponse("economy_unavailable", 503);
  return stateResponse(sessionOwnerKey(session), session.id);
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return errorResponse("bad_origin", 403);
  const { session, status } = pvpSession(request);
  if (!session) return errorResponse("unauthorized", status);
  if (!isEconomyEnabled()) return errorResponse("economy_unavailable", 503);
  return withUserLock("pvp", () => handlePost(request, session));
}

type AuthedSession = NonNullable<ReturnType<typeof pvpSession>["session"]>;

async function handlePost(request: Request, session: AuthedSession) {
  const ownerKey = sessionOwnerKey(session);
  const discordId = session.id;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return errorResponse("bad_json", 400);
  }
  const action = body.action;

  // 場所検証: 待ち・決闘の全操作は闘技場にいなければ進めない
  const station = await loadMyLobbyStation(ownerKey);
  if (station !== "arena") return errorResponse("not_at_arena", 409);

  if (action === "queue") {
    const duel = await loadMyPvpDuel(ownerKey);
    if (duel) return errorResponse("session_active", 409);
    let queue = await loadPvpQueue();
    if (queue.some((e) => e.discordId === discordId)) return stateResponse(ownerKey, discordId);
    const mine = await effectiveBalanceOf(ownerKey, discordId);
    if (mine === null || mine < PVP_FEE) return errorResponse("insufficient_balance", 409);
    const profile = await loadProfile(ownerKey);
    queue = [...queue, { ownerKey, discordId, attack: playerAttack(profile.items, profile.enhance), queuedAt: Date.now() }];
    // 先頭2人で組める限り組む。片方が払えなくなっていたら待ちから外す。
    for (;;) {
      const matched = tryMatch(queue, Date.now());
      if (!matched) break;
      const [a, b] = matched.pair;
      const affordA = await effectiveBalanceOf(a.ownerKey, a.discordId);
      const affordB = await effectiveBalanceOf(b.ownerKey, b.discordId);
      const drop = affordA !== null && affordA < PVP_FEE ? a : affordB !== null && affordB < PVP_FEE ? b : null;
      if (drop) {
        queue = queue.filter((e) => e.discordId !== drop.discordId);
        continue;
      }
      const next: PvpDuel = createDuel(a, b, Date.now());
      const feeA = await enqueue(a.ownerKey, a.discordId, {
        kind: "spend", amount: PVP_FEE, reason: "arena_pvp_entry", id: next.feeOpIds[0],
      });
      const feeB = feeA
        ? await enqueue(b.ownerKey, b.discordId, {
            kind: "spend", amount: PVP_FEE, reason: "arena_pvp_entry", id: next.feeOpIds[1],
          })
        : null;
      if (!feeA || !feeB) break;
      await savePvpDuel(next);
      queue = matched.rest;
    }
    await savePvpQueue(queue);
    return stateResponse(ownerKey, discordId);
  }

  if (action === "leave") {
    const queue = await loadPvpQueue();
    await savePvpQueue(queue.filter((e) => e.discordId !== discordId));
    return stateResponse(ownerKey, discordId);
  }

  if (action === "forfeit") {
    let duel = await loadMyPvpDuel(ownerKey);
    if (!duel) return errorResponse("no_session", 409);
    if (duel.state === "paying") {
      // 参加費が両者とも done でなければ決着は付けない（act と同じ扱い）。
      const current = duel;
      const feeStates = await Promise.all(
        current.feeOpIds.map((id, i) => findEconomyOp(current.players[i].ownerKey, id)),
      );
      if (feeStates.some((op) => op === null || op.status === "failed")) {
        await clearPvpDuel(duel);
        return errorResponse("payment_failed", 409);
      }
      if (feeStates.some((op) => op?.status !== "done")) return errorResponse("payment_pending", 409);
      duel = { ...duel, state: "fighting" };
    }
    const loser = duel.players[0].discordId === discordId ? 0 : 1;
    const winner = (1 - loser) as 0 | 1;
    await finishDuel(duel, winner);
    await clearPvpDuel(duel);
    const base = await stateResponse(ownerKey, discordId);
    const data = (await base.json()) as Record<string, unknown>;
    return NextResponse.json(
      { ...data, duel: publicPvpView(duel, discordId), outcome: "lose" },
      { headers: NO_STORE },
    );
  }

  if (action === "act") {
    const move = body.move;
    if (move !== "attack" && move !== "heavy" && move !== "guard") {
      return errorResponse("bad_move", 400);
    }
    let duel = await loadMyPvpDuel(ownerKey);
    if (!duel) return errorResponse("no_session", 409);
    if (duel.state === "paying") {
      // 両者の参加費が done になるまで決闘は始まらない（PvE と同じ型）。
      // どちらかが失敗していたら決闘は無効（参加費は戻らない）。
      const current = duel;
      const feeStates = await Promise.all(
        current.feeOpIds.map((id, i) => findEconomyOp(current.players[i].ownerKey, id)),
      );
      if (feeStates.some((op) => op === null || op.status === "failed")) {
        await clearPvpDuel(duel);
        return errorResponse("payment_failed", 409);
      }
      if (feeStates.some((op) => op?.status !== "done")) return errorResponse("payment_pending", 409);
      duel = { ...duel, state: "fighting" };
    }
    const mover = (duel.players[0].discordId === discordId ? 0 : 1) as 0 | 1;
    const stepped = pvpStep(duel, mover, move as PvpMove, () => Math.random());
    if (!stepped.ok) return errorResponse(stepped.error, 409);
    const next: PvpDuel = {
      ...stepped.result.duel,
      log: [...stepped.result.events, ...duel.log].slice(0, 6),
    };
    if (stepped.result.winner !== null) {
      await finishDuel(next, stepped.result.winner);
      await clearPvpDuel(next);
      const base = await stateResponse(ownerKey, discordId);
      const data = (await base.json()) as Record<string, unknown>;
      return NextResponse.json(
        {
          ...data,
          duel: publicPvpView(next, discordId),
          outcome: stepped.result.winner === mover ? "win" : "lose",
          events: stepped.result.events,
        },
        { headers: NO_STORE },
      );
    }
    await savePvpDuel(next);
    const base = await stateResponse(ownerKey, discordId);
    const data = (await base.json()) as Record<string, unknown>;
    return NextResponse.json({ ...data, events: stepped.result.events }, { headers: NO_STORE });
  }

  return errorResponse("bad_action", 400);
}

/** 勝者に賞金を決定的 ID で積む（1試合1件。失敗しても決闘の決着は変えない）。 */
async function awardPrize(duel: PvpDuel, winner: 0 | 1): Promise<void> {
  const p = duel.players[winner];
  await enqueue(p.ownerKey, p.discordId, {
    kind: "earn", amount: PVP_PRIZE, reason: "arena_pvp_prize", id: pvpPrizeOpId(duel.code),
  });
}

/**
 * 決闘の決着。大会の対戦は賞金を払わず、勝者を大会へ返す（大会の
 * 進行が失敗しても決闘の決着は変えない。決着しなかった試合は
 * 大会側が期限切れでシード上位の進出として扱う）。
 */
async function finishDuel(duel: PvpDuel, winner: 0 | 1): Promise<void> {
  if (!duel.tournament) {
    await awardPrize(duel, winner);
    return;
  }
  try {
    await advanceTournamentMatch(
      duel.tournament.tournamentId, duel.tournament.matchId, duel.players[winner].discordId,
    );
  } catch {
    // 大会側の進行失敗は決闘の決着を壊さない
  }
}
