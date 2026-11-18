import { NextResponse } from "next/server";
import {
  LllError,
  awakenCard,
  dismantleCards,
  exchangeLumen,
  growCard,
  limitBreakCard,
  parseGrowBody,
  setCustomTacticDeck,
  setFavoriteCard,
  setPlayerName,
  toggleLockCard,
} from "@/lib/lll/lll-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 強化・限界突破・覚醒・分解・ロック・お気に入り・カスタムデッキ・両替。 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "リクエストの形式が正しくありません" }, { status: 400 });
  }
  try {
    const input = parseGrowBody(body);
    switch (input.action) {
      case "exchange":
        return NextResponse.json(await exchangeLumen(input.token));
      case "limitBreak":
        return NextResponse.json(await limitBreakCard(input.token, input.cardId));
      case "awaken":
        return NextResponse.json(await awakenCard(input.token, input.cardId));
      case "dismantle":
        return NextResponse.json(await dismantleCards(input.token, input.cardIds));
      case "lock":
        return NextResponse.json(await toggleLockCard(input.token, input.cardId));
      case "favorite":
        return NextResponse.json({ profile: await setFavoriteCard(input.token, input.cardId) });
      case "customDeck":
        return NextResponse.json({ profile: await setCustomTacticDeck(input.token, input.counts) });
      case "playerName":
        return NextResponse.json({ profile: await setPlayerName(input.token, input.name) });
      case "levelup":
      default:
        return NextResponse.json(await growCard(input.token, input.cardId));
    }
  } catch (error) {
    if (error instanceof LllError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: "強化できませんでした" }, { status: 500 });
  }
}
