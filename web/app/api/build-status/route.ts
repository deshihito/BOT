import { NextResponse } from "next/server";
import { loadBuildStatus } from "@/lib/build-status-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ビルド状態の公開 API。共通バナー（BuildStatusBanner）がポーリングする。
// 状態ファイルはデプロイスクリプトが書くもので、秘密情報は含まない。
export async function GET() {
  const status = loadBuildStatus();
  return NextResponse.json(
    { status },
    { headers: { "Cache-Control": "no-store" } },
  );
}
