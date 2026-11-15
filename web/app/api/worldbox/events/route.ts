import { NextResponse } from "next/server";
import { getRequestSession } from "@/lib/auth";
import { activeEvents, eventDaysLeft, EVENT_DUNGEON_ENTRANCE } from "@/lib/worldbox/events";

export const runtime = "nodejs";

// AGO WORLD BOX の開催中イベント。
// GET: 開催中イベントの一覧（名前・種別・残り日数）と、期間ダンジョンの
// 予約入口座標を返す。定義と日程の正は events.ts。

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

export async function GET(request: Request) {
  const session = getRequestSession(request);
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  const now = Date.now();
  return NextResponse.json(
    {
      events: activeEvents(now).map((def) => ({
        id: def.id,
        name: def.name,
        kind: def.kind,
        daysLeft: eventDaysLeft(def, now),
      })),
      dungeonEntrance: EVENT_DUNGEON_ENTRANCE,
    },
    { headers: NO_STORE },
  );
}
