import { NextResponse } from "next/server";
import { getRequestSession, publicOrigin, sessionOwnerKey } from "@/lib/auth";
import {
  ARENA_PLAYER_HP, ARENA_TIERS, arenaStep, arenaTier, playerAttack, publicArenaView,
  type ArenaActionKind, type ArenaSession,
} from "@/lib/worldbox/arena";
import { clearArenaSession, loadArenaSession, saveArenaSession } from "@/lib/worldbox/arena-online";
import { buildEconomyOp, type EconomyOp } from "@/lib/worldbox/economy-bridge";
import {
  enqueueEconomyOp, enqueueEconomyOpOnce, findEconomyOp, isEconomyEnabled, loadMyEconomyOps, readUserBalance,
  waitForOpDone,
} from "@/lib/worldbox/economy-bridge-online";
import { loadProfile } from "@/lib/worldbox/profile-online";
import { loadMyLobbyStation } from "@/lib/worldbox/station-online";
import { withUserLock } from "@/lib/worldbox/user-lock";

export const runtime = "nodejs";

// AGO WORLD BOX の闘技場（ロビー北の半円アリーナ）。
// 遊べるのはプレゼンスがロビーの闘技場にいるときだけ（サーバー検証）。
// お金は経済ブリッジ経由のみ: 参加費は spend（arena_entry）、
// 賞金は earn（arena_prize、Plan A の原資ルール内）。
// 試合開始時に参加費のオプを積み、適用が done になるまで対戦は始まらない
// （先払い失敗の試合では賞金が発生しない）。
// GET: { balance, effectiveBalance, attack, tiers, session }
// POST: { action: "start", tier } / { action: "act", move } / { action: "forfeit" }

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return !origin || origin === publicOrigin(request);
}

function errorResponse(error: string, status: number) {
  return NextResponse.json({ error }, { status, headers: NO_STORE });
}

function arenaSession(request: Request) {
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
  const stored = input.id ? await enqueueEconomyOpOnce(op) : await enqueueEconomyOp(op);
  return stored ? op : null;
}

async function stateResponse(ownerKey: string, discordId: string) {
  const [balance, ops, session, profile] = await Promise.all([
    readUserBalance(discordId),
    loadMyEconomyOps(ownerKey),
    loadArenaSession(ownerKey),
    loadProfile(ownerKey),
  ]);
  const pending = ops
    .filter((op) => op.status === "pending" && op.kind === "spend")
    .reduce((sum, op) => sum + op.amount, 0);
  return NextResponse.json(
    {
      balance,
      effectiveBalance: balance === null ? null : balance - pending,
      attack: playerAttack(profile.items, profile.enhance),
      tiers: ARENA_TIERS,
      session: session ? publicArenaView(session) : null,
    },
    { headers: NO_STORE },
  );
}

export async function GET(request: Request) {
  const { session, status } = arenaSession(request);
  if (!session) return errorResponse("unauthorized", status);
  if (!isEconomyEnabled()) return errorResponse("economy_unavailable", 503);
  return stateResponse(sessionOwnerKey(session), session.id);
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return errorResponse("bad_origin", 403);
  const { session, status } = arenaSession(request);
  if (!session) return errorResponse("unauthorized", status);
  if (!isEconomyEnabled()) return errorResponse("economy_unavailable", 503);
  // 同一ユーザーのリクエストを直列化する（カジノ #943 と同型の対策）。
  // セッションの read-modify-write と参加費/賞金のオプ登録が並行すると、
  // 二重開始（参加費2件）や勝利の二重判定（賞金2件）が起きうる。
  // 賞金オプの決定的 ID（prize-<参加費オプID>）と合わせて
  // 「1試合 = 参加費1件・賞金最大1件」を保証する。
  return withUserLock(sessionOwnerKey(session), () => handlePost(request, session));
}

type AuthedSession = NonNullable<ReturnType<typeof arenaSession>["session"]>;

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

  // 場所検証: 開始も対戦中の1手も、闘技場にいなければ進めない
  const station = await loadMyLobbyStation(ownerKey);
  if (station !== "arena") return errorResponse("not_at_arena", 409);

  if (action === "start") {
    const tier = typeof body.tier === "string" ? arenaTier(body.tier) : null;
    if (!tier) return errorResponse("bad_tier", 400);
    const existing = await loadArenaSession(ownerKey);
    if (existing) return errorResponse("session_active", 409);
    const balance = await readUserBalance(discordId);
    const ops = await loadMyEconomyOps(ownerKey);
    const pendingSpend = ops
      .filter((op) => op.status === "pending" && op.kind === "spend")
      .reduce((sum, op) => sum + op.amount, 0);
    if (balance === null || balance - pendingSpend < tier.fee) {
      return errorResponse("insufficient_balance", 409);
    }
    const feeOp = await enqueue(ownerKey, discordId, { kind: "spend", amount: tier.fee, reason: "arena_entry" });
    if (!feeOp) return errorResponse("economy_unavailable", 503);
    const s: ArenaSession = {
      kind: "arena", state: "paying", tierId: tier.id, fee: tier.fee, prize: tier.prize,
      feeOpId: feeOp.id, playerHp: ARENA_PLAYER_HP, enemyHp: tier.enemyHp,
      guarding: false, turn: 0, startedAt: Date.now(), log: [],
    };
    await saveArenaSession(ownerKey, s);
    return stateResponse(ownerKey, discordId);
  }

  if (action === "forfeit") {
    await clearArenaSession(ownerKey);
    return stateResponse(ownerKey, discordId);
  }

  if (action === "act") {
    const move = body.move;
    if (move !== "attack" && move !== "heavy" && move !== "guard") {
      return errorResponse("bad_move", 400);
    }
    const s = await loadArenaSession(ownerKey);
    if (!s) return errorResponse("no_session", 409);
    if (s.state === "paying") {
      // 参加費の done を server-side wait でその場で待つ（従来は
      // payment_pending を返してクライアントの再ポーリング頼みだった）。
      // 予算を超えたら従来どおり payment_pending にフォールバックする。
      let feeOp = await findEconomyOp(ownerKey, s.feeOpId);
      if (feeOp?.status === "pending") {
        feeOp = await waitForOpDone(ownerKey, s.feeOpId);
      }
      if (!feeOp) {
        await clearArenaSession(ownerKey);
        return errorResponse("payment_failed", 409);
      }
      if (feeOp.status === "failed") {
        await clearArenaSession(ownerKey);
        return errorResponse("payment_failed", 409);
      }
      if (feeOp.status !== "done") return errorResponse("payment_pending", 409);
      s.state = "fighting";
    }
    const profile = await loadProfile(ownerKey);
    const result = arenaStep(s, move as ArenaActionKind, playerAttack(profile.items, profile.enhance), rng);
    const next: ArenaSession = {
      ...result.session,
      log: [...result.events, ...s.log].slice(0, 6),
    };
    if (result.outcome === "win") {
      // 賞金は決定的 ID で冪等に積む（再試行・再処理でも1試合1件だけ）
      await enqueue(ownerKey, discordId, {
        kind: "earn", amount: next.prize, reason: "arena_prize", id: `prize-${s.feeOpId}`,
      });
      await clearArenaSession(ownerKey);
      const base = await stateResponse(ownerKey, discordId);
      const data = (await base.json()) as Record<string, unknown>;
      return NextResponse.json(
        { ...data, session: publicArenaView(next), outcome: "win", events: result.events },
        { headers: NO_STORE },
      );
    }
    if (result.outcome === "lose") {
      await clearArenaSession(ownerKey);
      const base = await stateResponse(ownerKey, discordId);
      const data = (await base.json()) as Record<string, unknown>;
      return NextResponse.json(
        { ...data, session: publicArenaView(next), outcome: "lose", events: result.events },
        { headers: NO_STORE },
      );
    }
    await saveArenaSession(ownerKey, next);
    const base = await stateResponse(ownerKey, discordId);
    const data = (await base.json()) as Record<string, unknown>;
    return NextResponse.json({ ...data, events: result.events }, { headers: NO_STORE });
  }

  return errorResponse("bad_action", 400);
}
