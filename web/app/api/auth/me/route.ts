import { NextResponse } from "next/server";
import { getRequestSession } from "@/lib/auth";
import { userAvatarUrl } from "@/lib/dashboard-core";

export const runtime = "nodejs";

// ヘッダー用のログイン中ユーザー情報。セッション Cookie を読むだけで、
// 未ログインなら user: null を返す（エラーにはしない）。
// avatarUrl: Discord はアバターハッシュから CDN URL を組み立て（無ければ
// 既定アバター）、Google はプロフィール画像の完全な URL をそのまま使う。
// Google で画像が無い場合だけ null（クライアントが頭文字で代替表示する）。
const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

export async function GET(request: Request) {
  const session = getRequestSession(request);
  if (!session) {
    return NextResponse.json({ user: null }, { headers: NO_STORE });
  }
  const avatar = session.avatar ?? null;
  const avatarUrl = avatar && avatar.startsWith("http")
    ? avatar
    : session.provider === "google"
      ? null
      : userAvatarUrl(session.id, avatar);
  return NextResponse.json(
    { user: { name: session.username, avatarUrl } },
    { headers: NO_STORE },
  );
}
