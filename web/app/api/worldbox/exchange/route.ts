import { NextResponse } from "next/server";
import { getRequestSession } from "@/lib/auth";
import { loadMarketSnapshot } from "@/lib/worldbox/market-online";
import { marketBalanceOf } from "@/lib/worldbox/market";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" } as const;

// AGO WORLD BOX の取引所の市場表示。
// 取引対象は /general のアゴトークン市場（Bot 本体）そのもの。レート・
// 履歴・保有量は Bot が bot_kv へ公開するスナップショットが正で、
// ここは本人の保有量だけを抜き出して返す。売買そのものは profile
// ルートの token_buy / token_sell / token_convert が取引所の前でのみ
// 受け付け、Bot 側の市場が適用する。
export async function GET(request: Request) {
  const session = getRequestSession(request);
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  }
  const snapshot = await loadMarketSnapshot();
  if (!snapshot) {
    return NextResponse.json({ available: false }, { headers: NO_STORE });
  }
  const history = snapshot.history;
  const prevRate = history.length >= 2 ? history[history.length - 2].rate : snapshot.rate;
  return NextResponse.json(
    {
      available: true,
      rate: snapshot.rate,
      prevRate,
      history,
      halted: snapshot.halted,
      haltReason: snapshot.haltReason,
      tradeCapAga: snapshot.tradeCapAga,
      balance: session.provider === "discord" ? marketBalanceOf(snapshot, session.id) : 0,
      updatedAt: snapshot.updatedAt,
    },
    { headers: NO_STORE },
  );
}
