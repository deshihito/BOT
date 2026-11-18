import { NextResponse } from "next/server";
import { getRequestSession, sessionOwnerKey } from "@/lib/auth";
import { loadNationsState } from "@/lib/worldbox/nations-online";
import { toUnionGoalViews } from "@/lib/worldbox/union-goals";
import { isUnionGoalsEnabled, loadUnionGoals } from "@/lib/worldbox/union-goals-online";

export const runtime = "nodejs";

// AGO WORLD BOX のユニオン週間共闘目標（GET のみ）。
// ギルドボード「目標」タブに今週の進捗と累計達成回数を返す。

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

export async function GET(request: Request) {
  const session = getRequestSession(request);
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  }
  if (!isUnionGoalsEnabled()) {
    return NextResponse.json({ error: "goals_unavailable" }, { status: 503, headers: NO_STORE });
  }
  const ownerKey = sessionOwnerKey(session);
  const nations = await loadNationsState();
  const membership = nations.members?.[ownerKey];
  if (!membership) {
    return NextResponse.json(
      { guildId: null, week: "", goals: [], totalCompleted: 0 },
      { headers: NO_STORE },
    );
  }
  const nation = nations.nations?.[membership.nationId];
  const now = Date.now();
  const state = await loadUnionGoals(membership.nationId, now);
  return NextResponse.json(
    {
      guildId: membership.nationId,
      guildName: nation?.name ?? "",
      week: state.week,
      goals: toUnionGoalViews(state),
      totalCompleted: state.totalCompleted,
    },
    { headers: NO_STORE },
  );
}
