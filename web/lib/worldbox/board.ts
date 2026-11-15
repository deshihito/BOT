// AGO WORLD BOX ロビーのグローバル掲示板（純粋ロジック）。
// 投稿の検証・整形と、最新 BOARD_MAX_POSTS 件への切り詰めだけを担う。
// 保存（bot_kv）は board-online.ts、API は app/api/worldbox/board/route.ts。
// Discord チャンネル連携は次フェーズ（ここでは扱わない）。

/** 掲示板に残す投稿数（新しい順にこの件数だけ保持する）。 */
export const BOARD_MAX_POSTS = 30;
/** 投稿本文の上限文字数。 */
export const BOARD_TEXT_MAX = 120;
/** 表示名の上限文字数。 */
export const BOARD_NAME_MAX = 24;

export type BoardPost = {
  name: string;
  text: string;
  /** 投稿時刻（ミリ秒）。 */
  at: number;
};

/** 投稿本文を検証・整形する。空・長すぎ・文字列でなければ null。 */
export function sanitizeBoardText(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.replace(/[\u0000-\u001f\u007f]/g, " ").trim().replace(/\s+/g, " ");
  if (text.length === 0 || text.length > BOARD_TEXT_MAX) return null;
  return text;
}

function sanitizeBoardName(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, BOARD_NAME_MAX);
}

/** 1件の投稿として解釈できれば整形して返す。できなければ null。 */
export function parseBoardPost(raw: unknown): BoardPost | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Record<string, unknown>;
  const text = sanitizeBoardText(v.text);
  if (text === null) return null;
  if (typeof v.at !== "number" || !Number.isFinite(v.at) || v.at <= 0) return null;
  const name = sanitizeBoardName(v.name);
  if (!name) return null;
  return { name, text, at: v.at };
}

/** 保存値（JSON 文字列 or 配列）を投稿一覧へ戻す。新しい順・上限件数に整える。 */
export function parseBoardPosts(raw: unknown): BoardPost[] {
  let data: unknown = raw;
  if (typeof raw === "string") {
    try {
      data = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(data)) return [];
  const posts: BoardPost[] = [];
  for (const item of data) {
    const post = parseBoardPost(item);
    if (post) posts.push(post);
  }
  posts.sort((a, b) => b.at - a.at);
  return posts.slice(0, BOARD_MAX_POSTS);
}

/** 投稿を先頭に足し、上限件数で切り詰めた新しい一覧を返す（元の配列は壊さない）。 */
export function appendBoardPost(posts: readonly BoardPost[], post: BoardPost): BoardPost[] {
  return [post, ...posts].slice(0, BOARD_MAX_POSTS);
}
