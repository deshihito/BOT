// AGO WORLD BOX: P2P 取引 push の橋渡し（クライアント内イベント）。
// relay の watch が worldbox_trade の変更を検知すると当事者 2 人だけへ
// { t: "sync", kind: "trade" } を送り、WorldBoxClient が notifyTradeChanged を
// 呼ぶ。開いている取引パネルはこの合図で最新の相手オファー・確定状態を取り直す。

export const TRADE_CHANGED_EVENT = "worldbox:trade-changed";

export function notifyTradeChanged(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(TRADE_CHANGED_EVENT));
  }
}

export function onTradeChanged(handler: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(TRADE_CHANGED_EVENT, handler);
  return () => window.removeEventListener(TRADE_CHANGED_EVENT, handler);
}
