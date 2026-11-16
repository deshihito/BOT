// AGO WORLD BOX のスマホ向けレイアウト判定（純粋ロジック、DOM 非依存）。
//
// 画面は「1つのレイアウトを全画面に流用」せず、ビューポートの向きと
// 高さで3モードに分ける。ブレークポイントは globals.css の .wb-panel
// 向けメディアクエリ（シート化）と必ず一致させること:
//   portrait : max-width 759px かつ orientation portrait
//   landscape: orientation landscape かつ max-height 499px（横持ちの低丈）
//   wide     : それ以外（PC・タブレット。従来レイアウトをそのまま使う）
//
// スマホ分岐の原則（ユーザー確定ルール）:
// - プレイ画面は常に1ビューポートに収める（ページスクロールで逃がさない）
// - 読みやすさの下限を割ってまで縮小しない。収まらない分は同時表示を
//   減らす（チャットとパーティカードの同位置ドックは排他にする等）
// - 主要なタップ対象は 44px 以上

/** レイアウトモード。 */
export type WbLayoutMode = "wide" | "portrait" | "landscape";

/** 縦持ちスマホとみなす最大幅（CSS の max-width と一致）。 */
export const WB_PORTRAIT_MAX_WIDTH = 759;
/** 横持ちスマホ（低丈）とみなす最大高さ（CSS の max-height と一致）。 */
export const WB_LANDSCAPE_MAX_HEIGHT = 499;

/** ビューポート寸法 → レイアウトモード。 */
export function wbLayoutMode(width: number, height: number): WbLayoutMode {
  if (width <= WB_PORTRAIT_MAX_WIDTH && height >= width) return "portrait";
  if (width > height && height <= WB_LANDSCAPE_MAX_HEIGHT) return "landscape";
  return "wide";
}

/** モードごとの HUD メトリクス（クライアントの絶対配置が参照する）。 */
export interface WbHudMetrics {
  /** ミニマップの一辺（px）。スマホでは小さくして上部の占有を減らす。 */
  minimapPx: number;
  /** ホットバーのスロット寸法（CSS の --slot に流す値）。 */
  hotbarSlotCss: string;
  /** 主要ボタンの最小高さ（px）。スマホではタップ下限の 44 に上げる。 */
  buttonMinHeight: number;
  /** チャットを右下ドックにするか（左下はスティック基点が占有する）。 */
  chatOnRight: boolean;
  /** チャットの幅（CSS）。右ドック時はスティックの当たり円を避ける。 */
  chatWidthCss: string;
  /** チャット下端のステージ下からの距離（px、safe-area は呼び出し側で加算）。 */
  chatBottomPx: number;
  /** チャットのメッセージ積み上げの最大高さ（px）。低丈の横持ちでは絞る。 */
  chatMessagesPx: number;
  /** プレイヤーカードの下端位置（px）。チャットの積み上げより上に逃がす。 */
  playerCardBottomPx: number;
  /** パーティカードの下端位置（px）。スマホではチャットと同じドックを共有する。 */
  partyCardBottomPx: number;
}

/**
 * 右ドック時のチャット左端がステージ左から確保する距離（px）。
 * スティック基点は左下固定で、中心は端から 78px・当たり半径 68px
 * （lib/worldbox/stick.ts）なので、左端は 146px より右に置く。
 */
export const WB_CHAT_LEFT_CLEARANCE_PX = 156;

export function wbHudMetrics(mode: WbLayoutMode): WbHudMetrics {
  switch (mode) {
    case "portrait":
      return {
        minimapPx: 88,
        // 360px 幅で 5枠＋インベントリボタンが 44px 級で収まる寸法
        hotbarSlotCss: "clamp(38px, 12vw, 44px)",
        buttonMinHeight: 44,
        chatOnRight: true,
        chatWidthCss: `min(260px, calc(100% - ${WB_CHAT_LEFT_CLEARANCE_PX}px))`,
        chatBottomPx: 70,
        chatMessagesPx: 118,
        playerCardBottomPx: 240,
        partyCardBottomPx: 70,
      };
    case "landscape":
      return {
        minimapPx: 88,
        hotbarSlotCss: "44px",
        buttonMinHeight: 44,
        chatOnRight: true,
        chatWidthCss: "260px",
        chatBottomPx: 70,
        // 低丈（360〜430px）ではメッセージの積み上げを絞ってステージを空ける
        chatMessagesPx: 84,
        playerCardBottomPx: 204,
        partyCardBottomPx: 70,
      };
    default:
      return {
        minimapPx: 112,
        hotbarSlotCss: "clamp(30px, 10.5vw, 42px)",
        buttonMinHeight: 40,
        chatOnRight: false,
        chatWidthCss: "min(300px, calc(100% - 130px))",
        chatBottomPx: 10,
        chatMessagesPx: 118,
        playerCardBottomPx: 108,
        partyCardBottomPx: 120,
      };
  }
}
