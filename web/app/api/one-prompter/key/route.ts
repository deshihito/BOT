import { NextResponse } from "next/server";
import { getRequestSession, sessionOwnerKey } from "@/lib/auth";
import {
  deleteUserApiKey,
  isUserKeyEnabled,
  loadUserApiKeyMeta,
  maskFromTail,
  maskUserApiKey,
  saveUserApiKey,
  validateUserApiKey,
} from "@/lib/one-prompter-user-key";

export const runtime = "nodejs";

// ログイン中ユーザーだけが使える、自前 API キーの登録・確認・削除。
// GET: { enabled, registered, masked }（masked は末尾4文字のみ。平文は返さない）
// POST { apiKey }: 登録（形式チェックのみで、実際に API を叩く検証はしない）
// DELETE: 削除
// セッションが無ければ 401。キーの平文はレスポンスにもログにも出さない。

function publicOrigin(request: Request) {
  const url = new URL(request.url);
  const protocol = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || url.protocol.slice(0, -1);
  const host = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() || request.headers.get("host") || url.host;
  return `${protocol}://${host}`;
}

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return !origin || origin === publicOrigin(request);
}

export async function GET(request: Request) {
  const session = getRequestSession(request);
  if (!session) {
    return NextResponse.json({ error: "ログインが必要です。" }, { status: 401 });
  }
  if (!isUserKeyEnabled()) {
    return NextResponse.json({ enabled: false, registered: false, masked: null });
  }
  const meta = await loadUserApiKeyMeta(sessionOwnerKey(session));
  return NextResponse.json({
    enabled: true,
    registered: Boolean(meta),
    masked: meta ? maskFromTail(meta.tail) : null,
  });
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) {
    return NextResponse.json({ error: "リクエストを確認できません。" }, { status: 403 });
  }
  const session = getRequestSession(request);
  if (!session) {
    return NextResponse.json({ error: "ログインが必要です。" }, { status: 401 });
  }
  if (!isUserKeyEnabled()) {
    return NextResponse.json({ error: "この機能は現在使えません。" }, { status: 400 });
  }
  let body: { apiKey?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "入力を確認できません。" }, { status: 400 });
  }
  const apiKey = validateUserApiKey(body.apiKey);
  if (!apiKey) {
    return NextResponse.json({ error: "APIキーの形式を確認してください。" }, { status: 400 });
  }
  const saved = await saveUserApiKey(sessionOwnerKey(session), apiKey);
  if (!saved) {
    return NextResponse.json({ error: "保存できませんでした。" }, { status: 500 });
  }
  return NextResponse.json({ registered: true, masked: maskUserApiKey(apiKey) });
}

export async function DELETE(request: Request) {
  if (!sameOrigin(request)) {
    return NextResponse.json({ error: "リクエストを確認できません。" }, { status: 403 });
  }
  const session = getRequestSession(request);
  if (!session) {
    return NextResponse.json({ error: "ログインが必要です。" }, { status: 401 });
  }
  await deleteUserApiKey(sessionOwnerKey(session));
  return NextResponse.json({ registered: false, masked: null });
}
