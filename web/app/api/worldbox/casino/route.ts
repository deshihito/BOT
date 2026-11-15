import { NextResponse } from "next/server";
import { getRequestSession, publicOrigin, sessionOwnerKey } from "@/lib/auth";
import {
  CASINO_REASON, casinoMachineNear, playRoulette, playSlot, validateCasinoBet,
  type CasinoGame, type RoulettePick,
} from "@/lib/worldbox/casino";
import { buildEconomyOp } from "@/lib/worldbox/economy-bridge";
import {
  enqueueEconomyOp, isEconomyEnabled, loadMyEconomyOps, readUserBalance,
} from "@/lib/worldbox/economy-bridge-online";
import { buildLobby } from "@/lib/worldbox/lobby";
import { isPresenceEnabled, loadMyPresence } from "@/lib/worldbox/presence-online";

export const runtime = "nodejs";

// AGO WORLD BOX のカジノ（ロビー右翼のカジノルーム）。
// 遊べるのは、プレゼンス（サーバーが持つ現在位置）がロビーの
// カジノ機器（スロットマシン / カジノテーブル）に隣接しているときだけ。
// 位置はクライアントの自己申告ではなくプレゼンスで検証する。
// 抽選はこのサーバー側で行い、1プレイは「ベット＋確定配当」の
// gamble オプ1件として経済ブリッジへ積む。残高の適用（ベットの
// 引き落とし→配当の支払い、負けの還流）は Bot 側ワーカーが
// 原子的に行うため、Web が残高を直接動かすことはない（案B / Plan A）。
// GET: { balance, effectiveBalance, machine, ops }
//   effectiveBalance は処理中ベットを差し引いた実質残高、
//   machine は今隣接している機器（"slot" | "roulette" | null）、
//   ops は自分の gamble オプ直近分（処理中表示と精算確認用）。
// POST { game: "slot", bet } / { game: "roulette", bet, pick: "red" | "black" }
// Bot API 未設定なら 503。

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return !origin || origin === publicOrigin(request);
}

function errorResponse(error: string, status: number) {
  return NextResponse.json({ error }, { status, headers: NO_STORE });
}

/** カジノの本人キーは Discord ユーザーID。Discord セッション以外は対象外。 */
function casinoSession(request: Request) {
  const session = getRequestSession(request);
  if (!session) return { session: null, status: 401 as const };
  if (session.provider !== "discord") return { session: null, status: 403 as const };
  return { session, status: 200 as const };
}

/** 暗号論的 RNG（抽選はサーバー側のこれでのみ行う）。 */
function rng(): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0] / 4294967296;
}

/** 今隣接しているカジノ機器。ロビー外・鮮度切れ・未送信は null。 */
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

export async function GET(request: Request) {
  const { session, status } = casinoSession(request);
  if (!session) return errorResponse(status === 401 ? "unauthorized" : "discord_required", status);
  if (!isEconomyEnabled()) return errorResponse("economy_unavailable", 503);
  const userKey = sessionOwnerKey(session);
  const [balance, ops, machine] = await Promise.all([
    readUserBalance(session.id),
    loadMyEconomyOps(userKey),
    currentMachine(userKey),
  ]);
  if (balance === null) return errorResponse("economy_unavailable", 503);
  const gambleOps = ops.filter((op) => op.kind === "gamble");
  const pendingBets = gambleOps
    .filter((op) => op.status === "pending")
    .reduce((sum, op) => sum + op.amount, 0);
  return NextResponse.json(
    { balance, effectiveBalance: balance - pendingBets, machine, ops: gambleOps },
    { headers: NO_STORE },
  );
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return errorResponse("forbidden", 403);
  const { session, status } = casinoSession(request);
  if (!session) return errorResponse(status === 401 ? "unauthorized" : "discord_required", status);
  if (!isEconomyEnabled()) return errorResponse("economy_unavailable", 503);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("invalid_request", 400);
  }
  const fields = (body ?? {}) as { game?: unknown; bet?: unknown; pick?: unknown };
  const game: CasinoGame | null =
    fields.game === "slot" || fields.game === "roulette" ? fields.game : null;
  if (game === null) return errorResponse("invalid_game", 400);
  const bet = validateCasinoBet(fields.bet);
  if (bet === null) return errorResponse("invalid_bet", 400);
  const pick: RoulettePick | null =
    fields.pick === "red" || fields.pick === "black" ? fields.pick : null;
  if (game === "roulette" && pick === null) return errorResponse("invalid_pick", 400);

  const userKey = sessionOwnerKey(session);
  const machine = await currentMachine(userKey);
  if (machine === null) return errorResponse("not_at_casino", 409);
  if (machine !== game) return errorResponse("wrong_machine", 409);

  const [balance, ops] = await Promise.all([
    readUserBalance(session.id),
    loadMyEconomyOps(userKey),
  ]);
  if (balance === null) return errorResponse("economy_unavailable", 503);
  const pendingBets = ops
    .filter((op) => op.kind === "gamble" && op.status === "pending")
    .reduce((sum, op) => sum + op.amount, 0);
  if (bet > balance - pendingBets) return errorResponse("not_enough_coins", 409);

  const result = game === "slot" ? playSlot(bet, rng) : playRoulette(bet, pick as RoulettePick, rng);
  const op = buildEconomyOp(
    {
      kind: "gamble",
      userKey,
      discordId: session.id,
      amount: bet,
      reason: CASINO_REASON[game],
      payout: result.payout,
    },
    crypto.randomUUID(),
    Date.now(),
  );
  if (!op) return errorResponse("economy_failed", 500);
  const stored = await enqueueEconomyOp(op);
  if (!stored) return errorResponse("economy_failed", 503);
  return NextResponse.json(
    { ok: true, game, bet, payout: result.payout, result, opId: op.id },
    { headers: NO_STORE },
  );
}
