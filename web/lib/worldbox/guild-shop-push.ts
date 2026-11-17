// AGO WORLD BOX: ギルドショップ push の橋渡し（クライアント内イベント）。
//
// relay の watch が worldbox_guild_shop の変更を検知すると全体へ poke し、
// WorldBoxClient の WS 受信が notifyGuildShopChanged を呼ぶ。地図の
// 区画ギルド名表示は合図で REST を取り直し、開いているギルドショップ
// パネルも同じ合図で一覧を取り直す（従来は自分の操作でしか更新されず、
// 他人の借り換え・出品・購入が地図にもパネルにも出なかった）。
// 合図に内容は載せない（guild-board-push と同じ）。

export const GUILD_SHOP_CHANGED_EVENT = "worldbox:guild-shop-changed";

/** ギルドショップが変わった合図を出す（WorldBoxClient の WS 受信専用）。 */
export function notifyGuildShopChanged(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(GUILD_SHOP_CHANGED_EVENT));
  }
}

/** ギルドショップの変更合図の購読。戻り値は解除関数。 */
export function onGuildShopChanged(handler: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(GUILD_SHOP_CHANGED_EVENT, handler);
  return () => window.removeEventListener(GUILD_SHOP_CHANGED_EVENT, handler);
}
