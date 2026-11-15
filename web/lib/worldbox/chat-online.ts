// AGO WORLD BOX の近距離チャットの保存（サーバー専用）。
// 保存先は bot_kv（名前空間 "worldbox_chat"、キー = 空間 world|lobby）。
// 値は発言ログ（古い順の配列）の JSON。保持期間と件数の切り詰めは chat.ts。
import { isBotApiConfigured, kvGet, kvSet } from "../bot-api";
import { parseChatLog, pruneChatLog, type ChatMessage } from "./chat";
import type { PresenceSpace } from "./presence";

export const WORLDBOX_CHAT_NAMESPACE = "worldbox_chat";

export function isChatEnabled(): boolean {
  return isBotApiConfigured();
}

/** 空間の発言ログを読む。読めなければ空配列。 */
export async function loadChatLog(space: PresenceSpace): Promise<ChatMessage[]> {
  if (!isBotApiConfigured()) return [];
  try {
    const raw = await kvGet(WORLDBOX_CHAT_NAMESPACE, space);
    if (raw === null) return [];
    return parseChatLog(raw);
  } catch {
    return [];
  }
}

/** 発言を1件追加して保存する。保存後のログを返し、失敗したら null。 */
export async function appendChatMessage(
  space: PresenceSpace,
  msg: ChatMessage,
  now: number,
): Promise<ChatMessage[] | null> {
  if (!isBotApiConfigured()) return null;
  const log = pruneChatLog([...(await loadChatLog(space)), msg], now);
  try {
    await kvSet(WORLDBOX_CHAT_NAMESPACE, space, JSON.stringify(log));
    return log;
  } catch {
    return null;
  }
}
