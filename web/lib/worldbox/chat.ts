// AGO WORLD BOX のチャット（純粋ロジック）。
// チャンネルは3つ: 近距離（proximity、その場限り・揮発）、全体（global、揮発）、
// ユニオン（union、ギルドボードへ流れる掲示として保持）。
// 保存（bot_kv）は chat-online.ts、API は app/api/worldbox/chat/route.ts。

export type ChatChannel = "proximity" | "global" | "union";

/** 本文の上限文字数（掲示板と同じ）。 */
export const CHAT_TEXT_MAX = 120;
/** 表示名の上限文字数。 */
export const CHAT_NAME_MAX = 24;
/** 近距離チャットの届く半径（タイル）。 */
export const CHAT_PROXIMITY_RANGE = 12;
/** 近距離メッセージの保持時間（揮発）。 */
export const CHAT_PROXIMITY_TTL_MS = 60_000;
/** 全体メッセージの保持時間（揮発）。 */
export const CHAT_GLOBAL_TTL_MS = 300_000;
/** ユニオンメッセージの保持時間（掲示として長く残す）。 */
export const CHAT_UNION_TTL_MS = 24 * 60 * 60_000;
/** チャンネルごとの保持件数。 */
export const CHAT_MAX_MESSAGES = 50;
/** 連続投稿の最小間隔（ミリ秒）。 */
export const CHAT_MIN_INTERVAL_MS = 1_500;

export type ChatMessage = {
  id: string;
  channel: ChatChannel;
  name: string;
  text: string;
  at: number;
  /** 送信者の位置（近距離の距離判定用。ユニオンでは使わない）。 */
  x: number;
  y: number;
  /** 送信者のいる空間（近距離/全体の混線防止）。 */
  space: string;
  /** ユニオンチャンネルの宛先ギルド ID。 */
  guildId?: string;
  /** Discord 側の投稿を取り込んだもの（Bot リレー）。 */
  source?: "discord";
};

/** ユニオン掲示の Discord 連携モード。 */
export type UnionChatMode = "global" | "channel" | "none";

export type UnionChatSettings = {
  mode: UnionChatMode;
  /** mode = "channel" のときの専用チャンネル ID。 */
  channelId: string | null;
  updatedAt: number;
};

const CHANNEL_ID_RE = /^\d{17,20}$/;

/**
 * 連携設定を解釈する。旧形式 { chatChannelId } は mode "channel"
 * （空なら "none"）として移行読込する。
 */
export function parseUnionChatSettings(raw: unknown): UnionChatSettings {
  const fallback: UnionChatSettings = { mode: "none", channelId: null, updatedAt: 0 };
  if (!raw || typeof raw !== "object") return fallback;
  const v = raw as Record<string, unknown>;
  const updatedAt = typeof v.updatedAt === "number" && Number.isFinite(v.updatedAt) ? v.updatedAt : 0;
  if (v.mode === "global" || v.mode === "none") {
    return { mode: v.mode, channelId: null, updatedAt };
  }
  if (v.mode === "channel") {
    return typeof v.channelId === "string" && CHANNEL_ID_RE.test(v.channelId)
      ? { mode: "channel", channelId: v.channelId, updatedAt }
      : fallback;
  }
  // 旧形式: chatChannelId の手入力
  if (typeof v.chatChannelId === "string" && CHANNEL_ID_RE.test(v.chatChannelId)) {
    return { mode: "channel", channelId: v.chatChannelId, updatedAt };
  }
  return fallback;
}

export function isChatChannel(raw: unknown): raw is ChatChannel {
  return raw === "proximity" || raw === "global" || raw === "union";
}

/** 本文を検証・整形する。空・長すぎ・文字列でなければ null。 */
export function sanitizeChatText(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.replace(/[\u0000-\u001f\u007f]/g, " ").trim().replace(/\s+/g, " ");
  if (text.length === 0 || text.length > CHAT_TEXT_MAX) return null;
  return text;
}

export function sanitizeChatName(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, CHAT_NAME_MAX);
}

/** 1件のメッセージとして解釈できれば整形して返す。 */
export function parseChatMessage(raw: unknown): ChatMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Record<string, unknown>;
  if (!isChatChannel(v.channel)) return null;
  const text = sanitizeChatText(v.text);
  if (text === null) return null;
  if (typeof v.id !== "string" || v.id.length === 0 || v.id.length > 64) return null;
  if (typeof v.at !== "number" || !Number.isFinite(v.at) || v.at <= 0) return null;
  const num = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? n : 0);
  return {
    id: v.id,
    channel: v.channel,
    name: sanitizeChatName(v.name),
    text,
    at: v.at,
    x: num(v.x),
    y: num(v.y),
    space: typeof v.space === "string" ? v.space.slice(0, 64) : "world",
    guildId: typeof v.guildId === "string" ? v.guildId.slice(0, 32) : undefined,
    source: v.source === "discord" ? "discord" : undefined,
  };
}

export function chatTtlMs(channel: ChatChannel): number {
  return channel === "proximity"
    ? CHAT_PROXIMITY_TTL_MS
    : channel === "global"
      ? CHAT_GLOBAL_TTL_MS
      : CHAT_UNION_TTL_MS;
}

/** 保持期間を過ぎたものを落とし、新しい順に上限まで残す。 */
export function pruneChatMessages(
  messages: readonly ChatMessage[],
  channel: ChatChannel,
  now: number,
): ChatMessage[] {
  const ttl = chatTtlMs(channel);
  return messages
    .filter((m) => m.channel === channel && now - m.at <= ttl)
    .sort((a, b) => b.at - a.at)
    .slice(0, CHAT_MAX_MESSAGES);
}

/**
 * 読み手に見えるメッセージを返す。
 * 近距離は同じ空間で CHAT_PROXIMITY_RANGE 以内だけ。全体は同じ空間だけ
 * （ロビーとワールドで混ざらない）。ユニオンは同じギルドだけ。
 */
export function visibleChatMessages(
  messages: readonly ChatMessage[],
  viewer: { x: number; y: number; space: string; guildId?: string | null },
  channel: ChatChannel,
  now: number,
): ChatMessage[] {
  const pruned = pruneChatMessages(messages, channel, now);
  if (channel === "proximity") {
    return pruned.filter(
      (m) => m.space === viewer.space && Math.hypot(m.x - viewer.x, m.y - viewer.y) <= CHAT_PROXIMITY_RANGE,
    );
  }
  if (channel === "global") {
    return pruned.filter((m) => m.space === viewer.space);
  }
  return pruned.filter((m) => !!viewer.guildId && m.guildId === viewer.guildId);
}
