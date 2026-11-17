// AGO WORLD BOX: ギルドボード push の橋渡し（クライアント内イベント）。
//
// relay の watch が worldbox_requests の変更を検知すると全体へ poke し、
// WorldBoxClient の WS 受信が notifyGuildRequestsChanged を呼ぶ。開いて
// いるギルドボードパネルは合図を受けて依頼一覧を取り直す（従来は自分の
// 操作でしか更新されず、他人の投稿・納品・取消が見えなかった）。
// ユニオン掲示（チャット）の変更も同じ経路で合図し、掲示タブを開いて
// いればメッセージを取り直す。合図に内容は載せない（economy-push と同じ）。

export const GUILD_REQUESTS_CHANGED_EVENT = "worldbox:guild-requests-changed";
export const GUILD_BOARD_CHANGED_EVENT = "worldbox:guild-board-changed";

/** ギルド依頼が変わった合図を出す（WorldBoxClient の WS 受信専用）。 */
export function notifyGuildRequestsChanged(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(GUILD_REQUESTS_CHANGED_EVENT));
  }
}

/** ギルド依頼の変更合図の購読。戻り値は解除関数。 */
export function onGuildRequestsChanged(handler: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(GUILD_REQUESTS_CHANGED_EVENT, handler);
  return () => window.removeEventListener(GUILD_REQUESTS_CHANGED_EVENT, handler);
}

/** ユニオン掲示が変わった合図を出す（WorldBoxClient の WS 受信専用）。 */
export function notifyGuildBoardChanged(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(GUILD_BOARD_CHANGED_EVENT));
  }
}

/** ユニオン掲示の変更合図の購読。戻り値は解除関数。 */
export function onGuildBoardChanged(handler: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(GUILD_BOARD_CHANGED_EVENT, handler);
  return () => window.removeEventListener(GUILD_BOARD_CHANGED_EVENT, handler);
}
