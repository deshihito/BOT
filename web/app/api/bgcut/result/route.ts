import { getBgcutSession, saveBgcutResult } from "@/lib/bgcut";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 背景透過ページからの結果受け取り。署名付きトークンで認可し、
// 結果画像を bot_kv（bgcut_results）へ渡す。Bot がポーリングで拾って
// 発行元チャンネルへ公開投稿する。1トークン（1ジョブ）につき1回まで。
const MAX_RESULT_BYTES = 512 * 1024;

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function hasExpectedMagic(data: Uint8Array, format: string): boolean {
  if (format === "PNG") {
    return (
      data.length >= 8 &&
      data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47 &&
      data[4] === 0x0d && data[5] === 0x0a && data[6] === 0x1a && data[7] === 0x0a
    );
  }
  // GIF8
  return (
    data.length >= 4 &&
    data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x38
  );
}

export async function POST(request: Request) {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json({ error: "リクエストの形式が正しくありません。" }, 400);
  }
  const token = form.get("token");
  const metaText = form.get("meta");
  const file = form.get("file");
  if (typeof token !== "string" || typeof metaText !== "string" || !(file instanceof Blob)) {
    return json({ error: "リクエストの形式が正しくありません。" }, 400);
  }
  const session = getBgcutSession(token);
  if (session.status === "unconfigured") {
    return json({ error: "この環境では利用できません。" }, 503);
  }
  if (session.status === "invalid") {
    return json({ error: "リンクが正しくありません。" }, 401);
  }
  if (session.status === "expired") {
    return json({ error: "リンクの有効期限が切れています。" }, 410);
  }
  if (file.size === 0 || file.size > MAX_RESULT_BYTES) {
    return json({ error: "結果ファイルのサイズが上限を超えています。" }, 413);
  }
  let meta: unknown;
  try {
    meta = JSON.parse(metaText);
  } catch {
    return json({ error: "結果情報の形式が正しくありません。" }, 400);
  }
  const data = new Uint8Array(await file.arrayBuffer());
  const format =
    typeof meta === "object" && meta !== null
      ? (meta as { format?: unknown }).format
      : undefined;
  if (typeof format !== "string" || !hasExpectedMagic(data, format)) {
    return json({ error: "結果ファイルの形式が申告と一致しません。" }, 400);
  }
  let result: Awaited<ReturnType<typeof saveBgcutResult>>;
  try {
    result = await saveBgcutResult(session.payload, meta, data);
  } catch {
    return json({ error: "保存基盤へ接続できませんでした。時間をおいてお試しください。" }, 503);
  }
  if (!result.saved) {
    if (result.reason === "duplicate") {
      return json({ error: "このリンクでは既に投稿済みです。" }, 409);
    }
    if (result.reason === "too_large") {
      return json({ error: "結果ファイルのサイズが上限を超えています。" }, 413);
    }
    return json({ error: "結果情報の形式が正しくありません。" }, 400);
  }
  return json({ ok: true }, 200);
}
