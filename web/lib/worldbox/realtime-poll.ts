// AGO WORLD BOX: プレゼンス REST ポーリングの間引き判定（純粋ロジック）。
//
// 背景: presence GET は WS 中継が健全な間も 1 秒ごとに走り、サーバー側は
// 毎回 listPresence の全件スキャンをしていた（負荷監査 2026-11-16:
// 1 人あたり静止 約170 req/分・移動中 約260 req/分の主因のひとつ）。
// WS が健全な間は他者の出現/移動/退室は中継の push（snap/up/bye/prune）で
// 届くため、REST ポーリングは「WS だけでは拾えない相手」のセーフティに
// 落とせる。不健全（切断・無応答）なら従来の 1 秒へ即戻す。
//
// 時計同期: relay は 15 秒ごとに { t: "tick", now } を送るため、無人の
// 空間でもサーバー時刻サンプルが届き続け、補正（absorbClockSample）は
// ポーリングを落としても維持される。

/** WS 不健全時のプレゼンスポーリング間隔（従来どおり）。 */
export const PRESENCE_POLL_MS = 1_000;
/** WS 健全時のセーフティポーリング間隔。 */
export const PRESENCE_SAFETY_POLL_MS = 15_000;
/**
 * WS の生存窓: relay の tick は 15 秒間隔なので、20 秒を超えて無応答なら
 * 半開き接続とみなして不健全扱いにする（ping/pong の切断検知は 30 秒周期で
 * それより遅いため、こちらが先に効く）。
 */
export const WS_ALIVE_WINDOW_MS = 20_000;

/** WS が健全か（接続中かつ生存窓内に応答がある）。 */
export function isWsHealthy(wsOpen: boolean, lastWsMsgAt: number, now: number): boolean {
  return wsOpen && lastWsMsgAt > 0 && now - lastWsMsgAt <= WS_ALIVE_WINDOW_MS;
}

/** いま REST ポーリングすべきか。前回取得からの経過と WS の健全さで決める。 */
export function presencePollDue(args: {
  now: number;
  lastPollAt: number;
  wsHealthy: boolean;
}): boolean {
  const interval = args.wsHealthy ? PRESENCE_SAFETY_POLL_MS : PRESENCE_POLL_MS;
  return args.now - args.lastPollAt >= interval;
}
