// AGO WORLD BOX のユニオン戦争の保存（サーバー専用）。
// 保存先は bot_kv（名前空間 "worldbox_wars"、キー "state"）。
import { isBotApiConfigured, kvGet, kvSet } from "../bot-api";
import { emptyWarState, parseWarState, type WarState } from "./war";
import { withUserLock } from "./user-lock";

export const WORLDBOX_WARS_NAMESPACE = "worldbox_wars";
const WARS_KEY = "state";

/**
 * 戦争状態（単一キー "state"）の RMW 全体を直列化するロック。
 * 戦争は複数ギルドが同じ state を触るため、ユーザー単位ではなく
 * state 全体を1つのキーで直列化する。war ルートの読み書きは必ず
 * このロックの中で行うこと（期限精算・宣言・攻撃・修復・解散の
 * 後始末までを1つの不可分な流れにする）。
 */
export function withWarLock<T>(fn: () => Promise<T>): Promise<T> {
  return withUserLock("worldbox_wars", fn);
}

export function isWarsEnabled(): boolean {
  return isBotApiConfigured();
}

/** 保存済みの戦争状態を読む。無い・読めない・未設定なら空の状態。 */
export async function loadWarState(): Promise<WarState> {
  if (!isBotApiConfigured()) return emptyWarState();
  try {
    return parseWarState(await kvGet(WORLDBOX_WARS_NAMESPACE, WARS_KEY));
  } catch {
    return emptyWarState();
  }
}

/** 戦争状態を保存する。成功したら true。 */
export async function storeWarState(state: WarState): Promise<boolean> {
  if (!isBotApiConfigured()) return false;
  try {
    await kvSet(WORLDBOX_WARS_NAMESPACE, WARS_KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}
