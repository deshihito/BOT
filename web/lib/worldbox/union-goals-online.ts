// AGO WORLD BOX のユニオン週間共闘目標の保存（bot_kv、サーバー専用）。
// 名前空間: worldbox_union_goals（キー = guildId）。
import { isBotApiConfigured, kvGet, kvSet } from "../bot-api";
import { enqueueUnionDiscordEvent } from "./chat-online";
import { loadNationsState } from "./nations-online";
import {
  applyUnionGoalProgress, parseUnionGoalsState,
  type UnionGoalDef, type UnionGoalKind, type UnionGoalsState,
} from "./union-goals";
import { withUserLock } from "./user-lock";

export const WORLDBOX_UNION_GOALS_NAMESPACE = "worldbox_union_goals";

export function isUnionGoalsEnabled(): boolean {
  return isBotApiConfigured();
}

export async function loadUnionGoals(guildId: string, nowMs = Date.now()): Promise<UnionGoalsState> {
  if (!isUnionGoalsEnabled() || !guildId) {
    return parseUnionGoalsState(null, nowMs);
  }
  try {
    const raw = await kvGet(WORLDBOX_UNION_GOALS_NAMESPACE, guildId);
    return parseUnionGoalsState(raw, nowMs);
  } catch {
    return parseUnionGoalsState(null, nowMs);
  }
}

export async function storeUnionGoals(guildId: string, state: UnionGoalsState): Promise<boolean> {
  if (!isUnionGoalsEnabled() || !guildId) return false;
  try {
    await kvSet(WORLDBOX_UNION_GOALS_NAMESPACE, guildId, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

/**
 * ユーザーの所属ユニオンに対して週間共闘目標の進捗を加算し、
 * 初達成した目標があれば Discord 連携チャンネルへ速報を積む（ベストエフォート）。
 */
export async function recordUnionGoalProgress(
  ownerKey: string,
  actorName: string,
  kind: UnionGoalKind,
  delta = 1,
  nowMs = Date.now(),
): Promise<UnionGoalDef | null> {
  if (!isUnionGoalsEnabled() || !ownerKey || delta <= 0) return null;
  try {
    const nations = await loadNationsState();
    const guildId = nations.members?.[ownerKey]?.nationId;
    if (!guildId) return null;
    let newlyCompleted: UnionGoalDef | null = null;
    await withUserLock(`union-goals:${guildId}`, async () => {
      const current = await loadUnionGoals(guildId, nowMs);
      const next = applyUnionGoalProgress(current, nowMs, kind, delta);
      await storeUnionGoals(guildId, next.state);
      newlyCompleted = next.newlyCompleted;
    });
    if (newlyCompleted) {
      const who = actorName.trim() || "冒険者";
      void enqueueUnionDiscordEvent(
        guildId,
        "ユニオン目標",
        `${(newlyCompleted as UnionGoalDef).name} を達成しました（達成者: ${who}）`,
        `goal-${guildId}-${kind}-${nowMs}`,
      );
    }
    return newlyCompleted;
  } catch {
    return null;
  }
}
