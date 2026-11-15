// AGO WORLD BOX 掲示板の保存（サーバー専用）。
// 保存先は bot_kv（名前空間 "worldbox_board"、キー "messages"）。
// 値は投稿一覧の JSON 文字列。検証・整形は lib/worldbox/board.ts が担う。
import { isBotApiConfigured, kvGet, kvSet } from "../bot-api";
import { parseBoardPosts, type BoardPost } from "./board";

export const WORLDBOX_BOARD_NAMESPACE = "worldbox_board";
const BOARD_KEY = "messages";

export function isBoardEnabled(): boolean {
  return isBotApiConfigured();
}

/** 保存済みの投稿一覧（新しい順）。無い・読めない・未設定なら空配列。 */
export async function loadBoardPosts(): Promise<BoardPost[]> {
  if (!isBotApiConfigured()) return [];
  try {
    const raw = await kvGet(WORLDBOX_BOARD_NAMESPACE, BOARD_KEY);
    return parseBoardPosts(raw);
  } catch {
    return [];
  }
}

/** 投稿一覧を保存する。成功したら true。 */
export async function storeBoardPosts(posts: readonly BoardPost[]): Promise<boolean> {
  if (!isBotApiConfigured()) return false;
  try {
    await kvSet(WORLDBOX_BOARD_NAMESPACE, BOARD_KEY, JSON.stringify(posts));
    return true;
  } catch {
    return false;
  }
}
