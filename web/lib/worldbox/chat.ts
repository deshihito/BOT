// AGO WORLD BOX の近距離チャット（純粋ロジック）。
// 現実の声のように、話者から CHAT_RANGE_TILES タイル以内にいる人にだけ届く。
// 位置はサーバー側のプレゼンス（現在位置）が正で、距離もサーバー側で測る
// （届かない相手にはサーバーが発言自体を返さない）。
// 保存（bot_kv）は chat-online.ts、API は app/api/worldbox/chat/route.ts。
import type { PresenceSpace } from "./presence";

/** 声が届く距離（タイル）。 */
export const CHAT_RANGE_TILES = 24;
/** 本文の上限文字数。 */
export const CHAT_TEXT_MAX = 200;
/** 表示名の上限文字数。 */
export const CHAT_NAME_MAX = 24;
/** 空間ごとに保持する発言数（古いものから捨てる）。 */
export const CHAT_KEEP = 60;
/** 発言の保持時間（ミリ秒）。過ぎた発言は保持も表示もしない。 */
export const CHAT_TTL_MS = 15 * 60 * 1000;
/** 同一ユーザーの連続投稿の最小間隔（ミリ秒）。 */
export const CHAT_MIN_INTERVAL_MS = 800;
/** 1回の取得で返す発言数（新しい側からこの件数まで）。 */
export const CHAT_PAGE = 30;

export type ChatMessage = {
  id: string;
  /** 話者のプレゼンス ID（所有者キーは出さない）。 */
  from: string;
  name: string;
  space: PresenceSpace;
  /** 発言時の話者の位置（タイル座標、プレゼンス由来）。 */
  x: number;
  y: number;
  text: string;
  /** 発言時刻（ミリ秒）。 */
  at: number;
};

/** 聞き手に届く発言（聞き手から見た距離つき）。 */
export type AudibleChatMessage = ChatMessage & { distanceTiles: number };

/** 本文を検証・整形する。空・長すぎ・文字列でなければ null。 */
export function sanitizeChatText(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.replace(/[\u0000-\u001f\u007f]/g, " ").trim().replace(/\s+/g, " ");
  if (text.length === 0 || text.length > CHAT_TEXT_MAX) return null;
  return text;
}

function sanitizeChatName(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, CHAT_NAME_MAX);
}

/** 1件の発言として解釈できれば整形して返す。できなければ null。 */
export function parseChatMessage(raw: unknown): ChatMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Record<string, unknown>;
  const text = sanitizeChatText(v.text);
  if (text === null) return null;
  if (typeof v.id !== "string" || v.id.length === 0) return null;
  if (typeof v.from !== "string" || v.from.length === 0) return null;
  if (v.space !== "world" && v.space !== "lobby") return null;
  if (typeof v.x !== "number" || !Number.isFinite(v.x)) return null;
  if (typeof v.y !== "number" || !Number.isFinite(v.y)) return null;
  if (typeof v.at !== "number" || !Number.isFinite(v.at) || v.at <= 0) return null;
  const name = sanitizeChatName(v.name);
  return {
    id: v.id,
    from: v.from,
    name: name || "プレイヤー",
    space: v.space,
    x: v.x,
    y: v.y,
    text,
    at: v.at,
  };
}

/** 保存値（配列）から発言ログを取り出す。壊れた要素は捨てる。 */
export function parseChatLog(raw: unknown): ChatMessage[] {
  if (!Array.isArray(raw)) return [];
  const out: ChatMessage[] = [];
  for (const item of raw) {
    const msg = parseChatMessage(item);
    if (msg) out.push(msg);
  }
  return out.sort((a, b) => a.at - b.at);
}

/** 保持期間を過ぎた発言を落とし、CHAT_KEEP 件に切り詰める（古い順のまま）。 */
export function pruneChatLog(log: ChatMessage[], now: number): ChatMessage[] {
  return log.filter((m) => now - m.at <= CHAT_TTL_MS).slice(-CHAT_KEEP);
}

/** 2点間の距離（タイル、ユークリッド距離）。 */
export function chatDistanceTiles(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(ax - bx, ay - by);
}

/**
 * 聞き手の位置から届く発言だけを、距離つきで古い順に返す。
 * 範囲外の発言は結果に含めない（＝聞こえない）。
 */
export function selectAudibleMessages(
  log: ChatMessage[],
  viewer: { x: number; y: number },
  now: number,
): AudibleChatMessage[] {
  const out: AudibleChatMessage[] = [];
  for (const m of pruneChatLog(log, now)) {
    const d = chatDistanceTiles(m.x, m.y, viewer.x, viewer.y);
    if (d <= CHAT_RANGE_TILES) out.push({ ...m, distanceTiles: Math.round(d) });
  }
  return out.slice(-CHAT_PAGE);
}

/** 連続投稿の間隔チェック（同じ話者の最後の発言からの経過で判定）。 */
export function canPostChat(log: ChatMessage[], fromId: string, now: number): boolean {
  for (let i = log.length - 1; i >= 0; i--) {
    if (log[i].from === fromId) return now - log[i].at >= CHAT_MIN_INTERVAL_MS;
  }
  return true;
}
