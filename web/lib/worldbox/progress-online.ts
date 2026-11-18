// AGO WORLD BOX の実績速報・進行連動ヘルパー（サーバー専用・ベストエフォート）。
// レア実績初達成時の Discord 連携チャンネル通知とユニオン週間目標の加算をまとめる。
import { newlyUnlockedAnnouncements, type AchievementInput } from "./achievements";
import { enqueueUnionDiscordEvent } from "./chat-online";
import { loadNationsState } from "./nations-online";
import { recordUnionGoalProgress } from "./union-goals-online";
import type { UnionGoalKind } from "./union-goals";

/** before → after で新たにレア実績（announce=true）を解除したら Discord へ通知する。 */
export async function notifyAchievementDiscord(
  ownerKey: string,
  actorName: string,
  before: AchievementInput,
  after: AchievementInput,
): Promise<void> {
  const unlocked = newlyUnlockedAnnouncements(before, after);
  if (unlocked.length === 0) return;
  try {
    const nations = await loadNationsState();
    const guildId = nations.members?.[ownerKey]?.nationId;
    if (!guildId) return;
    const who = actorName.trim() || "冒険者";
    for (const ach of unlocked) {
      await enqueueUnionDiscordEvent(
        guildId,
        "実績達成",
        `${who} が実績「${ach.name}」（称号: ${ach.title}）を達成しました`,
        `ach-${ach.id}-${ownerKey.slice(-8)}-${Date.now()}`,
      );
    }
  } catch {
    /* 通知失敗でゲーム操作を止めない */
  }
}

/** 実績通知 + ユニオン共闘目標の加算をベストエフォートで並列起動する。 */
export function dispatchProgressEffects(params: {
  ownerKey: string;
  actorName: string;
  before: AchievementInput;
  after: AchievementInput;
  goalKind?: UnionGoalKind;
  goalDelta?: number;
  now?: number;
}): void {
  const { ownerKey, actorName, before, after, goalKind, goalDelta = 1, now = Date.now() } = params;
  void notifyAchievementDiscord(ownerKey, actorName, before, after);
  if (goalKind && goalDelta > 0) {
    void recordUnionGoalProgress(ownerKey, actorName, goalKind, goalDelta, now);
  }
}
