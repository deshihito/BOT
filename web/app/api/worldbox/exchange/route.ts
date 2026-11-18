import { NextResponse } from "next/server";
import { getRequestSession } from "@/lib/auth";
import {
  TOKEN_TICK_MS, tokenNextTickAt, tokenPriceAt, tokenPriceAtTick, tokenPriceHistory, tokenTickOf,
} from "@/lib/worldbox/exchange";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" } as const;

// AGO WORLD BOX の取引所の価格表示。
// GET: 現在価格・前ティック価格・直近24ティック（2時間）の履歴。
// 価格は exchange.ts の決定的価格で、売買そのものは profile ルートの
// token_buy / token_sell が取引所の前でのみ受け付ける。
export async function GET(request: Request) {
  const session = getRequestSession(request);
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  }
  const now = Date.now();
  const tick = tokenTickOf(now);
  return NextResponse.json(
    {
      price: tokenPriceAt(now),
      prevPrice: tokenPriceAtTick(tick - 1),
      history: tokenPriceHistory(now, 24),
      tickMs: TOKEN_TICK_MS,
      nextTickAt: tokenNextTickAt(now),
    },
    { headers: NO_STORE },
  );
}
