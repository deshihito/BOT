// AGO WORLD BOX のギルド依頼データ保存（サーバー専用）。
// 保存先は bot_kv（名前空間 "worldbox_requests"、キー "requests" の1ドキュメント）。
// 依頼は投稿・納品・取消で相互参照するため、read-modify-write でまとめて扱う。
import { isBotApiConfigured, kvGet, kvSet } from "../bot-api";
import {
  emptyRequestsState, parseRequestsState, serializeRequestsState, type RequestsState,
} from "./requests";

export const WORLDBOX_REQUESTS_NAMESPACE = "worldbox_requests";
const REQUESTS_KEY = "requests";

export function isRequestsEnabled(): boolean {
  return isBotApiConfigured();
}

/** 保存済みの依頼状態を読む。無い・読めない・未設定なら空の状態。 */
export async function loadRequestsState(): Promise<RequestsState> {
  if (!isBotApiConfigured()) return emptyRequestsState();
  try {
    const raw = await kvGet(WORLDBOX_REQUESTS_NAMESPACE, REQUESTS_KEY);
    return parseRequestsState(raw);
  } catch {
    return emptyRequestsState();
  }
}

/** 依頼状態を保存する。成功したら true。 */
export async function storeRequestsState(state: RequestsState): Promise<boolean> {
  if (!isBotApiConfigured()) return false;
  try {
    await kvSet(WORLDBOX_REQUESTS_NAMESPACE, REQUESTS_KEY, serializeRequestsState(state));
    return true;
  } catch {
    return false;
  }
}
