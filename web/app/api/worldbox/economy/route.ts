import { NextResponse } from "next/server";
import { getRequestSession, publicOrigin, sessionOwnerKey } from "@/lib/auth";
import { buildEconomyOp } from "@/lib/worldbox/economy-bridge";
import { isEconomyEnabled, loadMyEconomyOps, readUserBalance, submitEconomyOp, waitForOpDone } from "@/lib/worldbox/economy-bridge-online";
import { loadMyLobbyStation } from "@/lib/worldbox/station-online";

export const runtime = "nodejs";

// AGO WORLD BOX の経済ブリッジ（Web 側の入口）。
// 残高の読み取りは users への select。送金は「オプ」を
// submitEconomyOp へ渡し、bot-api の transfer_coins RPC でその場で
// 適用する（直接適用できない環境では bot_kv のキュー経由で Bot
// 本体のワーカーが適用する）。
// GET: { balance, ops }（Discord ログイン中のみ。ops は自分の直近20件）
// POST { action: "transfer", toDiscordId, amount }: 送金オプを積む。
//   場所制約: ロビーの銀行の前にいること（サーバー側でプレゼンス検証）。
//   spend / earn はサーバー側ライブラリ専用で、この API からは積めない（400）。
// Bot API 未設定なら 503。

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return !origin || origin === publicOrigin(request);
}

function errorResponse(error: string, status: number) {
  return NextResponse.json({ error }, { status, headers: NO_STORE });
}

/** 経済の本人キーは Discord ユーザーID。Discord セッション以外は対象外。 */
function economySession(request: Request) {
  const session = getRequestSession(request);
  if (!session) return { session: null, status: 401 as const };
  if (session.provider !== "discord") return { session: null, status: 403 as const };
  return { session, status: 200 as const };
}

export async function GET(request: Request) {
  const { session, status } = economySession(request);
  if (!session) return errorResponse(status === 401 ? "unauthorized" : "discord_required", status);
  if (!isEconomyEnabled()) return errorResponse("economy_unavailable", 503);
  const userKey = sessionOwnerKey(session);
  const [balance, ops] = await Promise.all([readUserBalance(session.id), loadMyEconomyOps(userKey)]);
  if (balance === null) return errorResponse("economy_unavailable", 503);
  return NextResponse.json({ balance, ops }, { headers: NO_STORE });
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return errorResponse("forbidden", 403);
  const { session, status } = economySession(request);
  if (!session) return errorResponse(status === 401 ? "unauthorized" : "discord_required", status);
  if (!isEconomyEnabled()) return errorResponse("economy_unavailable", 503);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("invalid_request", 400);
  }
  const fields = (body ?? {}) as { action?: unknown; toDiscordId?: unknown; amount?: unknown };
  // クライアントから積めるのは送金だけ。spend / earn はサーバー側専用。
  if (fields.action !== "transfer") return errorResponse("invalid_action", 400);
  const op = buildEconomyOp(
    {
      kind: "transfer",
      userKey: sessionOwnerKey(session),
      discordId: session.id,
      amount: fields.amount,
      reason: "transfer",
      toDiscordId: fields.toDiscordId,
    },
    crypto.randomUUID(),
    Date.now(),
  );
  if (!op) {
    // 受け手の形・自分宛て・金額のどれが壊れているかでコードを分ける
    if (typeof fields.toDiscordId !== "string" || !/^\d{5,25}$/.test(fields.toDiscordId)) {
      return errorResponse("invalid_recipient", 400);
    }
    if (fields.toDiscordId === session.id) return errorResponse("self_transfer", 400);
    return errorResponse("invalid_amount", 400);
  }
  // 場所制約: 送金は銀行の前でのみ（入力検証を通った後に位置を確かめる）
  if ((await loadMyLobbyStation(sessionOwnerKey(session))) !== "bank") {
    return errorResponse("not_at_bank", 409);
  }
  // 提出は直接適用が正（submitEconomyOp）: 送金は transfer_coins RPC
  // でその場で終端する。直接適用できずキューへ寄せた（pending）とき
  // だけ従来どおり server-side wait で待ち、終端していれば最終残高も
  // 同一レスポンスで返す。pending のままなら積んだオプを返し、状態は
  // クライアントの次の取得で反映される。
  const userKey = sessionOwnerKey(session);
  const submitted = await submitEconomyOp(op);
  if (submitted.state === "unavailable") return errorResponse("economy_failed", 500);
  const finalOp = submitted.state === "pending" ? (await waitForOpDone(userKey, op.id)) ?? submitted.op : submitted.op;
  if (finalOp.status !== "pending") {
    const balance = await readUserBalance(session.id);
    return NextResponse.json(
      { ok: true, op: finalOp, ...(balance !== null ? { balance } : {}) },
      { headers: NO_STORE },
    );
  }
  return NextResponse.json({ ok: true, op: finalOp }, { headers: NO_STORE });
}
