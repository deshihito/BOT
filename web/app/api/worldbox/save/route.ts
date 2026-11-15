import { NextResponse } from "next/server";
import { getRequestSession, publicOrigin, sessionOwnerKey } from "@/lib/auth";
import { parseSave } from "@/lib/worldbox/save";
import { MAX_SAVE_JSON_LENGTH, isOnlineSaveEnabled, loadWorldBoxSave, storeWorldBoxSave } from "@/lib/worldbox/save-online";

export const runtime = "nodejs";

// AGO WORLD BOX のオンラインセーブ（ログイン中ユーザーのみ）。
// GET: { save: string | null }（自分のセーブ JSON。無ければ null）
// PUT { save }: 保存（v5 として解釈できる JSON のみ受け付ける）
// 保存先は bot_kv（名前空間 worldbox_save、キー = 所有者キー）。
// セッションが無ければ 401。Bot API 未設定なら 503（クライアントは
// ローカル保存にフォールバックして遊び続ける）。

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return !origin || origin === publicOrigin(request);
}

export async function GET(request: Request) {
  const session = getRequestSession(request);
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  }
  if (!isOnlineSaveEnabled()) {
    return NextResponse.json({ error: "save_unavailable" }, { status: 503, headers: NO_STORE });
  }
  const save = await loadWorldBoxSave(sessionOwnerKey(session));
  return NextResponse.json({ save }, { headers: NO_STORE });
}

export async function PUT(request: Request) {
  if (!sameOrigin(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403, headers: NO_STORE });
  }
  const session = getRequestSession(request);
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  }
  if (!isOnlineSaveEnabled()) {
    return NextResponse.json({ error: "save_unavailable" }, { status: 503, headers: NO_STORE });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400, headers: NO_STORE });
  }
  const save = (body as { save?: unknown } | null)?.save;
  if (typeof save !== "string" || save.length === 0 || save.length > MAX_SAVE_JSON_LENGTH) {
    return NextResponse.json({ error: "invalid_save" }, { status: 400, headers: NO_STORE });
  }
  // 壊れたデータを保存して続きが壊れるのを防ぐ（解釈できるセーブだけ通す）
  if (!parseSave(save)) {
    return NextResponse.json({ error: "invalid_save" }, { status: 400, headers: NO_STORE });
  }
  const stored = await storeWorldBoxSave(sessionOwnerKey(session), save);
  if (!stored) {
    return NextResponse.json({ error: "save_failed" }, { status: 500, headers: NO_STORE });
  }
  return NextResponse.json({ saved: true }, { headers: NO_STORE });
}
