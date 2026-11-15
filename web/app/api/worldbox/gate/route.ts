import { NextResponse } from "next/server";
import { getRequestSession } from "@/lib/auth";

export const runtime = "nodejs";

// AGO WORLD BOX の入場ゲート。WORLD BOX は Discord ログイン必須（ゲスト不可）。
// GET: { allowed } — Discord ユーザーIDが取れるセッションのときだけ true。
// Google ログイン等のセッションでは入場できない（Discord ログインが必要）。
// Bot API には依存しない（セッションだけで判定できる）。

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

export async function GET(request: Request) {
  const session = getRequestSession(request);
  const allowed =
    session !== null &&
    session.provider === "discord" &&
    typeof session.id === "string" &&
    session.id.length > 0;
  return NextResponse.json({ allowed }, { headers: NO_STORE });
}
