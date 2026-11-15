// AGO WORLD BOX チャットの保存（bot_kv）。
// 近距離/全体は worldbox_chat 名前空間にチャンネル+空間ごとの配列で持ち、
// 保持期間を過ぎたものは読み書きのついでに落とす（揮発）。
// ユニオンはギルドごとの掲示として worldbox_union_board に保持し、
// Discord チャンネル連携が設定されていれば worldbox_chat_outbox へ積む
// （Bot 側ワーカーがチャンネルへ投稿する）。
import { isBotApiConfigured, kvGet, kvSet } from "../bot-api";
import {
  parseChatMessage, pruneChatMessages, type ChatChannel, type ChatMessage,
} from "./chat";

export const WORLDBOX_CHAT_NAMESPACE = "worldbox_chat";
export const WORLDBOX_UNION_BOARD_NAMESPACE = "worldbox_union_board";
export const WORLDBOX_UNION_SETTINGS_NAMESPACE = "worldbox_union_settings";
export const WORLDBOX_CHAT_OUTBOX_NAMESPACE = "worldbox_chat_outbox";

export function isChatEnabled(): boolean {
  return isBotApiConfigured();
}

function listKey(channel: ChatChannel, space: string, guildId?: string): string {
  if (channel === "union") return `union:${guildId ?? ""}`;
  return `${channel}:${space}`;
}

function namespaceFor(channel: ChatChannel): string {
  return channel === "union" ? WORLDBOX_UNION_BOARD_NAMESPACE : WORLDBOX_CHAT_NAMESPACE;
}

async function loadList(channel: ChatChannel, key: string): Promise<ChatMessage[]> {
  try {
    const raw = await kvGet(namespaceFor(channel), key);
    if (raw === null) return [];
    const parsed: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!Array.isArray(parsed)) return [];
    return parsed.map((m) => parseChatMessage(m)).filter((m): m is ChatMessage => m !== null);
  } catch {
    return [];
  }
}

async function storeList(channel: ChatChannel, key: string, messages: ChatMessage[]): Promise<boolean> {
  try {
    await kvSet(namespaceFor(channel), key, JSON.stringify(messages));
    return true;
  } catch {
    return false;
  }
}

/** チャンネルのメッセージ一覧（保持期間で間引いた新しい順）。 */
export async function loadChatMessages(
  channel: ChatChannel,
  space: string,
  guildId?: string,
): Promise<ChatMessage[]> {
  const key = listKey(channel, space, guildId);
  const all = await loadList(channel, key);
  return pruneChatMessages(all, channel, Date.now());
}

/** 投稿を追記し、間引き後の配列で保存する。保存できたら true。 */
export async function appendChatMessage(message: ChatMessage): Promise<boolean> {
  const key = listKey(message.channel, message.space, message.guildId);
  const all = await loadList(message.channel, key);
  const next = pruneChatMessages([...all, message], message.channel, message.at);
  // prune は新しい順。保存もその順でよい（読み側で再整形する）
  return storeList(message.channel, key, next);
}

/** ユニオンの Discord 連携設定。 */
export type UnionChatSettings = { chatChannelId: string };

export async function loadUnionChatSettings(guildId: string): Promise<UnionChatSettings> {
  try {
    const raw = await kvGet(WORLDBOX_UNION_SETTINGS_NAMESPACE, guildId);
    if (raw === null) return { chatChannelId: "" };
    const parsed = (typeof raw === "string" ? JSON.parse(raw) : raw) as { chatChannelId?: unknown };
    return {
      chatChannelId: typeof parsed.chatChannelId === "string" ? parsed.chatChannelId.slice(0, 32) : "",
    };
  } catch {
    return { chatChannelId: "" };
  }
}

export async function storeUnionChatSettings(
  guildId: string,
  settings: UnionChatSettings,
): Promise<boolean> {
  try {
    await kvSet(WORLDBOX_UNION_SETTINGS_NAMESPACE, guildId, JSON.stringify(settings));
    return true;
  } catch {
    return false;
  }
}

/** Discord 連携の送信箱（Bot ワーカーが読んで投稿し、status を sent にする）。 */
export type ChatOutboxEntry = {
  id: string;
  guildId: string;
  channelId: string;
  name: string;
  text: string;
  at: number;
  status: "pending" | "sent";
};

export async function enqueueChatOutbox(entry: ChatOutboxEntry): Promise<boolean> {
  try {
    await kvSet(WORLDBOX_CHAT_OUTBOX_NAMESPACE, entry.id, JSON.stringify(entry));
    return true;
  } catch {
    return false;
  }
}

