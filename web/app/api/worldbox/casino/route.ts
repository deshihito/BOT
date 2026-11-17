import { NextResponse } from "next/server";
import { getRequestSession, publicOrigin, sessionOwnerKey } from "@/lib/auth";
import {
  canDouble, createBlackjackGame, doubleDown, handValue, hit, stand, startRound,
} from "@/lib/games/blackjack";
import {
  CASINO_REASON, CASINO_SESSION_REASONS, casinoMachineNear, isCasinoSpendReason, type CasinoMachine,
  playRoulette, playSlot, validateCasinoBet, type CasinoGame, type RoulettePick,
} from "@/lib/worldbox/casino";
import {
  doubleCashout, doubleGo, rollDice, spinSlot7,
  validateDice,
} from "@/lib/worldbox/casino-games";
import {
  CASINO_SESSION_TTL_MS, publicSessionView, publicUserStateView, type CasinoSession,
} from "@/lib/worldbox/casino-session";
import {
  clearCasinoSession, loadCasinoSession, loadCasinoUserState, saveCasinoSession,
  saveCasinoUserState,
} from "@/lib/worldbox/casino-session-online";
import { reconcileCasinoTournamentScores } from "@/lib/worldbox/casino-tournament-online";
import { buildEconomyOp, ECONOMY_AMOUNT_MAX, GAMBLE_PAYOUT_MAX, type EconomyOp } from "@/lib/worldbox/economy-bridge";
import {
  enqueueEconomyOp, findEconomyOp, isEconomyEnabled, loadMyEconomyOps, readUserBalance,
  submitEconomyOp, waitForOpDone, waitForOpsDone,
} from "@/lib/worldbox/economy-bridge-online";
import { buildLobby } from "@/lib/worldbox/lobby";
import { isPresenceEnabled, loadMyPresence } from "@/lib/worldbox/presence-online";

export const runtime = "nodejs";

// AGO WORLD BOX のカジノ（ロビー右翼のカジノルーム）。
// 遊べるのは、プレゼンス（サーバーが持つ現在位置）がロビーの
// カジノ機器（スロットマシン / カジノテーブル）に隣接しているときだけ。
// 位置はクライアントの自己申告ではなくプレゼンスで検証する。
// 抽選はこのサーバー側で行い、お金の移動はすべて経済ブリッジの
// オプ経由（Web が残高を直接動かすことはない。案B / Plan A）:
// - 単発ゲーム（スロット/ルーレット/ダイス）: 1プレイ = gamble オプ1件。
// - セッション型（セブンスロット/ダブルアップ/ブラックジャック）:
//   開始時に spend オプでベットを先払いし、終了時に prepaid の
//   gamble オプ1件で精算する。精算オプは先払いが done になってから
//   作る（先払い失敗のセッションは無効化され、配当も発生しない）。
// GET: { balance, effectiveBalance, machine, ops, session, userState }
// POST: { action: "play", game, bet, pick?, maxValue?, number? }
//       { action: "slot7_start", bet } / { action: "slot7_spin" }
//       { action: "double_start", bet } / { action: "double_go" } /
//       { action: "double_cashout" }
//       { action: "bj_start", bet } / { action: "bj_hit" } /
//       { action: "bj_stand" } / { action: "bj_double" }
// Bot API 未設定なら 503。

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

// 同一ユーザーのカジノリクエストを直列化する（プロセス内ロック）。
// パネルは GET を3秒間隔でポーリングし、各 GET/POST がセッションの
// 精算（tryFinishSession）を走らせるため、並行リクエストが同じ
// セッションを二重に精算しうる（精算オプが2件積まれて二重に払われる）。
// 精算オプの決定的 ID（settle-<先払いオプID>）と合わせて
// 「1セッション = 精算オプ1件」を保証する。
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

type AuthedSession = NonNullable<ReturnType<typeof casinoSession>["session"]>;

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return !origin || origin === publicOrigin(request);
}

function errorResponse(error: string, status: number) {
  return NextResponse.json({ error }, { status, headers: NO_STORE });
}

function casinoSession(request: Request) {
  const session = getRequestSession(request);
  if (!session) return { session: null, status: 401 as const };
  if (session.provider !== "discord") return { session: null, status: 403 as const };
  return { session, status: 200 as const };
}

function rng(): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0] / 4294967296;
}

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

/** 処理中のカジノ関係オプ（gamble のベット + カジノ spend）の合計。 */
function pendingCasinoTotal(ops: readonly EconomyOp[]): number {
  return ops
    .filter((op) => op.status === "pending" && (op.kind === "gamble" || (op.kind === "spend" && isCasinoSpendReason(op.reason))))
    .reduce((sum, op) => sum + op.amount, 0);
}

type OpStatus = "pending" | "done" | "failed" | "missing";

async function spendStatus(userKey: string, opId: string): Promise<OpStatus> {
  const op = await findEconomyOp(userKey, opId);
  if (!op) return "missing";
  return op.status;
}

/** GET（パネルが3秒ごとに叩く）の server-side wait 予算。POST より短くする。 */
const GET_WAIT_MS = 1_000;

/**
 * 先払いオプ群の状態を読む。pending があれば server-side wait で
 * done をその場で待ち（予算 waitMs、未指定は共通既定）、最終状態を
 * 返す。予算を超えても pending なら従来どおり「次回に回す」。
 */
async function spendStatuses(userKey: string, ids: readonly string[], waitMs?: number): Promise<OpStatus[]> {
  let statuses: OpStatus[] = [];
  for (const id of ids) statuses.push(await spendStatus(userKey, id));
  if (statuses.some((s) => s === "pending")) {
    await waitForOpsDone(ids.map((opId) => ({ userKey, opId })), { timeoutMs: waitMs });
    statuses = [];
    for (const id of ids) statuses.push(await spendStatus(userKey, id));
  }
  return statuses;
}

/** 単一の先払い状態を、pending なら done を待ってから返す。 */
async function spendStatusWaited(userKey: string, opId: string): Promise<OpStatus> {
  const first = await spendStatus(userKey, opId);
  if (first !== "pending") return first;
  const op = await waitForOpDone(userKey, opId);
  return op ? op.status : "missing";
}

/**
 * 先払いが done と確定するまで遊ばせない（double_cashout / bj_double と
 * 同じ規約）。pending は待っても確定しなければ bet_pending、失敗・喪失は
 * セッションを破棄して bet_failed。null は「進めてよい」。
 */
async function prepayGateError(userKey: string, opId: string) {
  const status = await spendStatusWaited(userKey, opId);
  if (status === "pending") return errorResponse("bet_pending", 409);
  if (status !== "done") {
    await clearCasinoSession(userKey);
    return errorResponse("bet_failed", 409);
  }
  return null;
}

async function enqueue(userKey: string, discordId: string, input: {
  kind: "spend" | "gamble";
  amount: number;
  reason: string;
  payout?: number;
  prepaid?: boolean;
  id?: string;
}): Promise<EconomyOp | null> {
  const op = buildEconomyOp(
    {
      kind: input.kind, userKey, discordId, amount: input.amount, reason: input.reason,
      payout: input.payout, prepaid: input.prepaid,
    },
    input.id ?? crypto.randomUUID(),
    Date.now(),
  );
  if (!op) return null;
  const stored = await enqueueEconomyOp(op);
  // カジノ大会のスコアはここでは加えない。gamble オプは登録時点では
  // pending で、ワーカー側で後から failed になりうるため、スコアは
  // done 確定後の照合（reconcileCasinoTournamentScores）でだけ加える。
  return stored ? op : null;
}

/**
 * セッションの先払い spend の提出（直接適用が正、キューは
 * フォールバック）。spend は常時直接適用の対象なので通常は
 * done / failed がその場で確定し、failed なら開始自体を止められる。
 * pending は直接適用が使えなかった場合のみで、その間は従来どおり
 * 各プレイのゲート（prepayGateError 等）が done を待つ。
 * null は直接もキューも使えなかった（economy_failed）。
 */
async function submitSpend(userKey: string, discordId: string, input: {
  amount: number;
  reason: string;
}): Promise<{ op: EconomyOp; state: "done" | "failed" | "pending" } | null> {
  const op = buildEconomyOp(
    { kind: "spend", userKey, discordId, amount: input.amount, reason: input.reason },
    crypto.randomUUID(),
    Date.now(),
  );
  if (!op) return null;
  const submitted = await submitEconomyOp(op);
  if (submitted.state === "unavailable") return null;
  return { op: submitted.op, state: submitted.state };
}

/**
 * 精算オプの冪等な登録。決定的 ID で積み、同 ID のオプが既にあれば
 * （pending / done / failed を問わず）作り直さない。セッションの
 * 後片付けが再試行されても精算は1回だけになる。
 */
async function enqueueSettleOnce(ctx: Ctx, id: string, input: {
  kind: "spend" | "gamble";
  amount: number;
  reason: string;
  payout?: number;
  prepaid?: boolean;
}): Promise<boolean> {
  const existing = await findEconomyOp(ctx.userKey, id);
  if (existing) return true;
  const op = await enqueue(ctx.userKey, ctx.discordId, { ...input, id });
  return op !== null;
}

type Ctx = { userKey: string; discordId: string };

/** セブンスロットの精算（集計払い戻し + 未使用スピン返金 + ペナルティ）。 */
async function settleSlot7(ctx: Ctx, session: Extract<CasinoSession, { kind: "slot7" }>): Promise<boolean> {
  const prepayTotal = session.bet * session.total;
  const netReturn = session.pendingReward - session.pendingPenalty + session.remaining * session.bet;
  const settle = await enqueueSettleOnce(ctx, `settle-${session.prepayOpId}`, {
    kind: "gamble",
    amount: prepayTotal,
    reason: CASINO_SESSION_REASONS.slot7Settle,
    // 超JACKPOT（ベット×100000）では配当が GAMBLE_PAYOUT_MAX を超えて
    // オプが作れず、精算が永遠に失敗してセッションが固着する。
    // 上限で丸めてでも精算を通し、セッションを必ず終わらせる。
    payout: Math.min(Math.max(0, netReturn), GAMBLE_PAYOUT_MAX),
    prepaid: true,
  });
  if (!settle) return false;
  if (netReturn < 0) {
    await enqueueSettleOnce(ctx, `penalty-${session.prepayOpId}`, {
      kind: "spend", amount: Math.min(-netReturn, ECONOMY_AMOUNT_MAX), reason: CASINO_SESSION_REASONS.slot7Penalty,
    });
  }
  await clearCasinoSession(ctx.userKey);
  return true;
}

/** ダブルアップの精算（バーストは 0、キャッシュアウトは確定額、期限切れは返金）。 */
async function settleDouble(
  ctx: Ctx,
  session: Extract<CasinoSession, { kind: "double" }>,
  payout: number,
): Promise<boolean> {
  const ok = await enqueueSettleOnce(ctx, `settle-${session.prepayOpId}`, {
    kind: "gamble",
    amount: session.bet,
    reason: CASINO_SESSION_REASONS.doubleSettle,
    // 連勝で配当が上限を超えても精算オプが作れるよう丸める（slot7 と同じ）。
    payout: Math.min(payout, GAMBLE_PAYOUT_MAX),
    prepaid: true,
  });
  if (!ok) return false;
  await clearCasinoSession(ctx.userKey);
  return true;
}

/** ブラックジャックの精算（bj.bet はダブル込みの総ベット）。 */
async function settleBlackjack(ctx: Ctx, session: Extract<CasinoSession, { kind: "blackjack" }>): Promise<boolean> {
  const bj = session.bj;
  if (bj.phase !== "settled" || !bj.result) return false;
  const payout = bj.bet + bj.result.delta;
  const ok = await enqueueSettleOnce(ctx, `settle-${session.spendOpIds[0]}`, {
    kind: "gamble",
    amount: bj.bet,
    reason: CASINO_SESSION_REASONS.blackjackSettle,
    payout,
    prepaid: true,
  });
  if (!ok) return false;
  await clearCasinoSession(ctx.userKey);
  return true;
}

/**
 * 終了済みセッションの精算を試みる。先払いが全て done のときだけ精算し、
 * failed があれば無効化（配当なしで閉じる）。pending は server-side
 * wait の予算内ではその場で done を待ち、超えた分だけ次回に回す。
 * 戻り値: 精算/無効化したら null、それ以外はセッションそのまま。
 */
async function tryFinishSession(ctx: Ctx, session: CasinoSession, waitMs?: number): Promise<CasinoSession | null> {
  const spendIds = session.kind === "blackjack" ? session.spendOpIds : [session.prepayOpId];
  const statuses = await spendStatuses(ctx.userKey, spendIds, waitMs);
  if (statuses.some((s) => s === "failed" || s === "missing")) {
    await clearCasinoSession(ctx.userKey);
    return null;
  }
  if (statuses.some((s) => s === "pending")) return session;
  if (session.kind === "slot7") {
    if (session.remaining > 0) return session;
    return (await settleSlot7(ctx, session)) ? null : session;
  }
  if (session.kind === "double") {
    if (!session.busted) return session;
    return (await settleDouble(ctx, session, 0)) ? null : session;
  }
  return (await settleBlackjack(ctx, session)) ? null : session;
}

/** 期限切れセッションの後片付け（未使用分の返金つき）。 */
async function expireSessionIfNeeded(ctx: Ctx, session: CasinoSession | null, waitMs?: number): Promise<CasinoSession | null> {
  if (!session) return null;
  if (Date.now() - session.createdAt <= CASINO_SESSION_TTL_MS) {
    return tryFinishSession(ctx, session, waitMs);
  }
  const spendIds = session.kind === "blackjack" ? session.spendOpIds : [session.prepayOpId];
  const statuses = await spendStatuses(ctx.userKey, spendIds, waitMs);
  if (statuses.some((s) => s === "pending")) return session;
  if (statuses.some((s) => s === "failed" || s === "missing")) {
    await clearCasinoSession(ctx.userKey);
    return null;
  }
  if (session.kind === "slot7") {
    return (await settleSlot7(ctx, session)) ? null : session;
  }
  if (session.kind === "double") {
    return (await settleDouble(ctx, session, session.busted ? 0 : session.bet)) ? null : session;
  }
  if (session.bj.phase === "settled") {
    return (await settleBlackjack(ctx, session)) ? null : session;
  }
  // プレイ中のブラックジャックは払った分だけ返金する。
  const paid = session.bet * session.spendOpIds.length;
  const ok = await enqueueSettleOnce(ctx, `refund-${session.spendOpIds[0]}`, {
    kind: "gamble", amount: paid, reason: CASINO_SESSION_REASONS.blackjackSettle, payout: paid, prepaid: true,
  });
  if (ok) await clearCasinoSession(ctx.userKey);
  return ok ? null : session;
}

async function loadSessionFor(ctx: Ctx, waitMs?: number): Promise<CasinoSession | null> {
  const session = await loadCasinoSession(ctx.userKey);
  return expireSessionIfNeeded(ctx, session, waitMs);
}

function sessionJson(session: CasinoSession | null) {
  return session ? publicSessionView(session) : null;
}

export async function GET(request: Request) {
  const { session, status } = casinoSession(request);
  if (!session) return errorResponse(status === 401 ? "unauthorized" : "discord_required", status);
  return withUserLock(sessionOwnerKey(session), () => handleGet(session));
}

async function handleGet(session: AuthedSession) {
  if (!isEconomyEnabled()) return errorResponse("economy_unavailable", 503);
  const ctx: Ctx = { userKey: sessionOwnerKey(session), discordId: session.id };
  const [balance, ops, machine, activeSession, userState] = await Promise.all([
    readUserBalance(session.id),
    loadMyEconomyOps(ctx.userKey),
    currentMachine(ctx.userKey),
    loadSessionFor(ctx, GET_WAIT_MS),
    loadCasinoUserState(ctx.userKey),
  ]);
  // カジノ大会のスコア照合（確定した gamble オプだけが数えられる）
  await reconcileCasinoTournamentScores(ctx.userKey, ctx.discordId, ops);
  if (balance === null) return errorResponse("economy_unavailable", 503);
  const gambleOps = ops.filter((op) => op.kind === "gamble");
  return NextResponse.json(
    {
      balance,
      effectiveBalance: balance - pendingCasinoTotal(ops),
      machine,
      ops: gambleOps,
      session: sessionJson(activeSession),
      userState: publicUserStateView(userState),
    },
    { headers: NO_STORE },
  );
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return errorResponse("forbidden", 403);
  const { session, status } = casinoSession(request);
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
  const action = typeof fields.action === "string" ? fields.action : "play";
  const ctx: Ctx = { userKey: sessionOwnerKey(session), discordId: session.id };

  const machine = await currentMachine(ctx.userKey);
  if (machine === null) return errorResponse("not_at_casino", 409);

  const [balance, ops] = await Promise.all([
    readUserBalance(session.id),
    loadMyEconomyOps(ctx.userKey),
  ]);
  if (balance === null) return errorResponse("economy_unavailable", 503);
  // カジノ大会のスコア照合（前回までのプレイの確定分を反映する）
  await reconcileCasinoTournamentScores(ctx.userKey, ctx.discordId, ops);
  const effectiveBalance = balance - pendingCasinoTotal(ops);
  const activeSession = await loadSessionFor(ctx);

  const requireMachine = (want: CasinoMachine) =>
    machine === want ? null : errorResponse("wrong_machine", 409);
  const requireNoSession = () =>
    activeSession ? errorResponse("session_active", 409) : null;
  const requireSession = <K extends CasinoSession["kind"]>(
    kind: K,
  ): { session: Extract<CasinoSession, { kind: K }> | null; error: NextResponse | null } => {
    if (!activeSession) return { session: null, error: errorResponse("no_session", 409) };
    if (activeSession.kind !== kind) return { session: null, error: errorResponse("wrong_session", 409) };
    return { session: activeSession as Extract<CasinoSession, { kind: K }>, error: null };
  };

  // ------------------------------------------------------------ 単発プレイ
  if (action === "play") {
    const game: CasinoGame | null =
      fields.game === "slot" || fields.game === "roulette" || fields.game === "dice"
        ? fields.game
        : null;
    if (game === null) return errorResponse("invalid_game", 400);
    const bet = validateCasinoBet(fields.bet);
    if (bet === null) return errorResponse("invalid_bet", 400);
    const machineError = requireMachine(game);
    if (machineError) return machineError;
    if (bet > effectiveBalance) return errorResponse("not_enough_coins", 409);

    if (game === "dice") {
      const maxValue = typeof fields.maxValue === "number" ? fields.maxValue : NaN;
      const number = typeof fields.number === "number" ? fields.number : NaN;
      const invalid = validateDice(maxValue, number);
      if (invalid) return errorResponse(invalid, 400);
      if (bet * maxValue > GAMBLE_PAYOUT_MAX) return errorResponse("invalid_bet", 400);
      const rolled = rollDice(maxValue, rng);
      const hitDice = rolled === number;
      const payout = hitDice ? bet * maxValue : 0;
      const op = await enqueue(ctx.userKey, ctx.discordId, {
        kind: "gamble", amount: bet, reason: CASINO_REASON.dice, payout,
      });
      if (!op) return errorResponse("economy_failed", 503);
      return NextResponse.json(
        { ok: true, game, bet, payout, result: { rolled, hit: hitDice, maxValue, number }, opId: op.id },
        { headers: NO_STORE },
      );
    }

    const pick: RoulettePick | null =
      fields.pick === "red" || fields.pick === "black" ? fields.pick : null;
    if (game === "roulette" && pick === null) return errorResponse("invalid_pick", 400);
    const result = game === "slot" ? playSlot(bet, rng) : playRoulette(bet, pick as RoulettePick, rng);
    const op = await enqueue(ctx.userKey, ctx.discordId, {
      kind: "gamble", amount: bet, reason: CASINO_REASON[game], payout: result.payout,
    });
    if (!op) return errorResponse("economy_failed", 503);
    return NextResponse.json(
      { ok: true, game, bet, payout: result.payout, result, opId: op.id },
      { headers: NO_STORE },
    );
  }

  // ------------------------------------------------------------ セブンスロット
  if (action === "slot7_start") {
    const machineError = requireMachine("slot7");
    if (machineError) return machineError;
    const noSession = requireNoSession();
    if (noSession) return noSession;
    const bet = validateCasinoBet(fields.bet);
    if (bet === null) return errorResponse("invalid_bet", 400);
    // 回数指定は廃止（2026-11-17 ユーザー指示）: 開始は常に1回分だけ先払いする。
    const total = bet;
    if (total > ECONOMY_AMOUNT_MAX) return errorResponse("invalid_bet", 400);
    if (total > effectiveBalance) return errorResponse("not_enough_coins", 409);
    const prepay = await submitSpend(ctx.userKey, ctx.discordId, {
      amount: total, reason: CASINO_SESSION_REASONS.slot7Prepay,
    });
    if (!prepay) return errorResponse("economy_failed", 503);
    if (prepay.state === "failed") return errorResponse("bet_failed", 409);
    const next: CasinoSession = {
      kind: "slot7", bet, total: 1, remaining: 1, prepayOpId: prepay.op.id,
      pendingReward: 0, pendingPenalty: 0, lastReels: null, lastEvents: [], createdAt: Date.now(),
    };
    await saveCasinoSession(ctx.userKey, next);
    return NextResponse.json({ ok: true, session: sessionJson(next) }, { headers: NO_STORE });
  }

  if (action === "slot7_spin") {
    const machineError = requireMachine("slot7");
    if (machineError) return machineError;
    const { session: s7, error } = requireSession("slot7");
    if (error || !s7) return error ?? errorResponse("no_session", 409);
    if (s7.remaining <= 0) return errorResponse("no_spins_left", 409);
    // 先払い（全スピン分）が確定してから回す。未確定のまま遊べると
    // 後から failed になった場合に無料で回せてしまう。
    const prepayError = await prepayGateError(ctx.userKey, s7.prepayOpId);
    if (prepayError) return prepayError;
    const userState = await loadCasinoUserState(ctx.userKey);
    const spin = spinSlot7(userState, s7.bet, rng);
    await saveCasinoUserState(ctx.userKey, userState);
    const next: CasinoSession = {
      ...s7,
      remaining: s7.remaining - 1,
      pendingReward: s7.pendingReward + spin.reward,
      pendingPenalty: s7.pendingPenalty + spin.penalty,
      lastReels: spin.reels,
      lastEvents: spin.events,
    };
    let settled = false;
    if (next.remaining <= 0) {
      const after = await tryFinishSession(ctx, next);
      settled = after === null;
      if (!settled) await saveCasinoSession(ctx.userKey, next);
      return NextResponse.json(
        { ok: true, spin, session: sessionJson(settled ? null : next), settled },
        { headers: NO_STORE },
      );
    }
    await saveCasinoSession(ctx.userKey, next);
    return NextResponse.json({ ok: true, spin, session: sessionJson(next) }, { headers: NO_STORE });
  }

  // ------------------------------------------------------------ ダブルアップ
  if (action === "double_start") {
    const machineError = requireMachine("double");
    if (machineError) return machineError;
    const noSession = requireNoSession();
    if (noSession) return noSession;
    const bet = validateCasinoBet(fields.bet);
    if (bet === null) return errorResponse("invalid_bet", 400);
    if (bet > effectiveBalance) return errorResponse("not_enough_coins", 409);
    const prepay = await submitSpend(ctx.userKey, ctx.discordId, {
      amount: bet, reason: CASINO_SESSION_REASONS.doubleBet,
    });
    if (!prepay) return errorResponse("economy_failed", 503);
    if (prepay.state === "failed") return errorResponse("bet_failed", 409);
    const next: CasinoSession = {
      kind: "double", bet, multiplier: 1, streak: 0, prepayOpId: prepay.op.id, createdAt: Date.now(),
    };
    await saveCasinoSession(ctx.userKey, next);
    return NextResponse.json({ ok: true, session: sessionJson(next) }, { headers: NO_STORE });
  }

  if (action === "double_go") {
    const machineError = requireMachine("double");
    if (machineError) return machineError;
    const { session: dbl, error } = requireSession("double");
    if (error || !dbl) return error ?? errorResponse("no_session", 409);
    if (dbl.busted) return errorResponse("session_finished", 409);
    // 先払いが確定してから進める（double_cashout と同じ確認を開始側にも）。
    const prepayError = await prepayGateError(ctx.userKey, dbl.prepayOpId);
    if (prepayError) return prepayError;
    const userState = await loadCasinoUserState(ctx.userKey);
    const sessionState = { bet: dbl.bet, multiplier: dbl.multiplier, streak: dbl.streak };
    const go = doubleGo(sessionState, userState, rng);
    await saveCasinoUserState(ctx.userKey, userState);
    const next: CasinoSession = {
      ...dbl, multiplier: sessionState.multiplier, streak: sessionState.streak,
      ...(go.finished ? { busted: true } : {}),
    };
    if (go.finished) {
      const after = await tryFinishSession(ctx, next);
      if (after !== null) await saveCasinoSession(ctx.userKey, next);
      return NextResponse.json(
        { ok: true, go, session: sessionJson(after) },
        { headers: NO_STORE },
      );
    }
    await saveCasinoSession(ctx.userKey, next);
    return NextResponse.json({ ok: true, go, session: sessionJson(next) }, { headers: NO_STORE });
  }

  if (action === "double_cashout") {
    const machineError = requireMachine("double");
    if (machineError) return machineError;
    const { session: dbl, error } = requireSession("double");
    if (error || !dbl) return error ?? errorResponse("no_session", 409);
    if (dbl.busted) return errorResponse("session_finished", 409);
    const prepayStatus = await spendStatusWaited(ctx.userKey, dbl.prepayOpId);
    if (prepayStatus === "pending") return errorResponse("bet_pending", 409);
    if (prepayStatus !== "done") {
      await clearCasinoSession(ctx.userKey);
      return errorResponse("bet_failed", 409);
    }
    const userState = await loadCasinoUserState(ctx.userKey);
    const payout = doubleCashout({ bet: dbl.bet, multiplier: dbl.multiplier, streak: dbl.streak }, userState);
    await saveCasinoUserState(ctx.userKey, userState);
    const settled = await settleDouble(ctx, dbl, payout);
    if (!settled) return errorResponse("economy_failed", 503);
    return NextResponse.json({ ok: true, payout, session: null }, { headers: NO_STORE });
  }

  // ------------------------------------------------------------ ブラックジャック
  if (action === "bj_start") {
    const machineError = requireMachine("blackjack");
    if (machineError) return machineError;
    const noSession = requireNoSession();
    if (noSession) return noSession;
    const bet = validateCasinoBet(fields.bet);
    if (bet === null) return errorResponse("invalid_bet", 400);
    if (bet > effectiveBalance) return errorResponse("not_enough_coins", 409);
    const prepay = await submitSpend(ctx.userKey, ctx.discordId, {
      amount: bet, reason: CASINO_SESSION_REASONS.blackjackBet,
    });
    if (!prepay) return errorResponse("economy_failed", 503);
    if (prepay.state === "failed") return errorResponse("bet_failed", 409);
    const seed = Math.floor(rng() * 0x7fffffff);
    const bj = startRound(createBlackjackGame(seed, effectiveBalance), bet);
    const next: CasinoSession = {
      kind: "blackjack", bet, spendOpIds: [prepay.op.id], bj, createdAt: Date.now(),
    };
    await saveCasinoSession(ctx.userKey, next);
    const finalView = bj.phase === "settled" ? publicSessionView(next) : null;
    const after = await tryFinishSession(ctx, next);
    if (after !== null && after !== next) await saveCasinoSession(ctx.userKey, after);
    return NextResponse.json(
      { ok: true, session: sessionJson(after), final: finalView },
      { headers: NO_STORE },
    );
  }

  if (action === "bj_hit" || action === "bj_stand") {
    const machineError = requireMachine("blackjack");
    if (machineError) return machineError;
    const { session: bjs, error } = requireSession("blackjack");
    if (error || !bjs) return error ?? errorResponse("no_session", 409);
    if (bjs.bj.phase !== "player") return errorResponse("not_in_play", 409);
    // 先払いが done と確定してから手を進める（slot7/double と同じ
    // 規約）。未確定のまま打てると、後から failed になった場合に
    // ベットの無い勝負が成立してしまう。pending は予算内で待ち、
    // 失敗・喪失はセッションを破棄する。
    const bjStatuses = await spendStatuses(ctx.userKey, bjs.spendOpIds);
    if (bjStatuses.some((s) => s === "pending")) return errorResponse("bet_pending", 409);
    if (bjStatuses.some((s) => s !== "done")) {
      await clearCasinoSession(ctx.userKey);
      return errorResponse("bet_failed", 409);
    }
    const bj = action === "bj_hit" ? hit(bjs.bj) : stand(bjs.bj);
    const next: CasinoSession = { ...bjs, bj };
    const finalView = bj.phase === "settled" ? publicSessionView(next) : null;
    const after = await tryFinishSession(ctx, next);
    if (after !== null) await saveCasinoSession(ctx.userKey, after);
    return NextResponse.json(
      { ok: true, session: sessionJson(after), final: finalView, playerTotal: handValue(bj.playerHand).total },
      { headers: NO_STORE },
    );
  }

  if (action === "bj_double") {
    const machineError = requireMachine("blackjack");
    if (machineError) return machineError;
    const { session: bjs, error } = requireSession("blackjack");
    if (error || !bjs) return error ?? errorResponse("no_session", 409);
    if (bjs.bj.phase !== "player" || !canDouble(bjs.bj)) return errorResponse("cannot_double", 409);
    const firstStatus = await spendStatusWaited(ctx.userKey, bjs.spendOpIds[0]);
    if (firstStatus === "pending") return errorResponse("bet_pending", 409);
    if (firstStatus !== "done") {
      await clearCasinoSession(ctx.userKey);
      return errorResponse("bet_failed", 409);
    }
    if (bjs.bet > effectiveBalance) return errorResponse("not_enough_coins", 409);
    // ダブル後の総ベットが ECONOMY_AMOUNT_MAX を超えると精算オプも
    // 返金オプも作れずセッションが固着する。総ベットが上限に収まる
    // ときだけダブルを許可する。
    if (bjs.bet * 2 > ECONOMY_AMOUNT_MAX) return errorResponse("bet_too_large_to_double", 409);
    const second = await submitSpend(ctx.userKey, ctx.discordId, {
      amount: bjs.bet, reason: CASINO_SESSION_REASONS.blackjackBet,
    });
    if (!second) return errorResponse("economy_failed", 503);
    if (second.state === "failed") return errorResponse("bet_failed", 409);
    const bj = doubleDown(bjs.bj);
    const next: CasinoSession = { ...bjs, bj, spendOpIds: [...bjs.spendOpIds, second.op.id] };
    await saveCasinoSession(ctx.userKey, next);
    return NextResponse.json(
      { ok: true, session: sessionJson(next), final: publicSessionView(next) },
      { headers: NO_STORE },
    );
  }

  return errorResponse("invalid_action", 400);
}
