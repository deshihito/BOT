import { NextResponse } from "next/server";
import { listPublicBalkuRooms } from "@/lib/balku-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** ロビー状態の公開ルーム一覧。 */
export async function GET() {
  try {
    const rooms = await listPublicBalkuRooms();
    return NextResponse.json({ rooms });
  } catch {
    return NextResponse.json({ error: "ルーム一覧を取得できませんでした" }, { status: 500 });
  }
}
