// AGO WORLD BOX: 経済オプ適用 push の橋渡し（クライアント内イベント）。
//
// relay の watch が worldbox_economy のオプ確定（pending→done/failed）を
// 本人へ push すると、WorldBoxClient の WS 受信が notifyEconomyApplied を
// 呼び、開いている経済/カジノ/アリーナパネルが即時 refresh する。
// パネルは従来のポーリング（カジノ/アリーナ 3 秒・プロフィール 15 秒束）も
// fallback として維持するため、push が届かない環境でも従来どおり動く。
// イベントに金額やオプ内容は載せない（合図だけ）。

export const ECONOMY_APPLIED_EVENT = "worldbox:economy-applied";

/** 経済オプが確定した合図を出す（WorldBoxClient の WS 受信専用）。 */
export function notifyEconomyApplied(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(ECONOMY_APPLIED_EVENT));
  }
}

/** 合図の購読。戻り値は解除関数。 */
export function onEconomyApplied(handler: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(ECONOMY_APPLIED_EVENT, handler);
  return () => window.removeEventListener(ECONOMY_APPLIED_EVENT, handler);
}
