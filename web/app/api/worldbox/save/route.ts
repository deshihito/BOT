import { NextResponse } from "next/server";
import { getRequestSession, publicOrigin, sessionOwnerKey } from "@/lib/auth";
import { parseSave, serializeSave } from "@/lib/worldbox/save";
import { MAX_SAVE_JSON_LENGTH, isOnlineSaveEnabled, loadWorldBoxSave, storeWorldBoxSave } from "@/lib/worldbox/save-online";
import { loadMyPresence } from "@/lib/worldbox/presence-online";
import { checkMovementContinuity, checkSaveFallbackContinuity } from "@/lib/worldbox/presence";
import { pickRandomSpawn } from "@/lib/worldbox/spawn";

export const runtime = "nodejs";

// AGO WORLD BOX のオンラインセーブ（ログイン中ユーザーのみ）。
// GET: { save: string | null }（自分のセーブ JSON）
//   セーブが無い（または旧版などで解釈できない）場合は初回作成として、
//   原点周辺からランダムに選んだスポーン地点で新規セーブを作って返す。
//   初期スポーンの決定はサーバー側のここが正。以後は通常のセーブ位置。
// PUT { save }: 保存（v6 として解釈できる JSON のみ受け付ける）
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
  const ownerKey = sessionOwnerKey(session);
  const save = await loadWorldBoxSave(ownerKey);
  if (save && parseSave(save)) {
    return NextResponse.json({ save }, { headers: NO_STORE });
  }
  // 初回作成: 初期スポーンはランダム（陸の歩行可能タイル）。作った
  // セーブを保存して返し、以後はその位置が続きになる。
  const spawn = pickRandomSpawn(Math.random);
  const fresh = serializeSave({ space: "world", x: spawn.x, y: spawn.y, worldReturn: null });
  await storeWorldBoxSave(ownerKey, fresh);
  return NextResponse.json({ save: fresh }, { headers: NO_STORE });
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
  const parsed = parseSave(save);
  if (!parsed) {
    return NextResponse.json({ error: "invalid_save" }, { status: 400, headers: NO_STORE });
  }
  // 移動連続性（B4）: セーブも申告位置なので、ハートビートと同じ規則で守る。
  // 基準は新鮮なプレゼンス（時刻基準）。プレゼンスが古い/無いときは
  // サーバー保存のセーブを固定距離で基準にする（初回作成・復帰時の
  // findFreeNear のずれは 12 タイル以内に収まる）。これが無いと、
  // プレゼンス消去→セーブ移転→ハートビートの順で即テレポートできてしまう。
  // 空間が変われば受け入れる（入退室・階段・階層移動の正当な不連続）。
  const ownerKey = sessionOwnerKey(session);
  const now = Date.now();
  const freshPresence = await loadMyPresence(ownerKey);
  if (freshPresence) {
    if (!checkMovementContinuity(freshPresence, parsed, now).ok) {
      return NextResponse.json(
        { error: "position_jump", x: freshPresence.x, y: freshPresence.y, space: freshPresence.space },
        { status: 409, headers: NO_STORE },
      );
    }
  } else {
    const storedSave = parseSave(await loadWorldBoxSave(ownerKey));
    if (storedSave && !checkSaveFallbackContinuity(storedSave, parsed).ok) {
      return NextResponse.json(
        { error: "position_jump", x: storedSave.x, y: storedSave.y, space: storedSave.space },
        { status: 409, headers: NO_STORE },
      );
    }
  }
  const stored = await storeWorldBoxSave(ownerKey, save);
  if (!stored) {
    return NextResponse.json({ error: "save_failed" }, { status: 500, headers: NO_STORE });
  }
  return NextResponse.json({ saved: true }, { headers: NO_STORE });
}
