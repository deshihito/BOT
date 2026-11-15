// AGO WORLD BOX の固定式ジョイスティック（純粋ロジック、DOM 非依存）。
// スティックの基点は画面左下の固定位置だけ。タッチした場所に基点が
// 出るフローティング式だと、ブロック設置や採掘のタップがスティックに
// 化けて操作が干渉するため、基点は動かさない。スティックに触れる
// 操作は「基点の円の中から始まったタッチ」だけに限定し、それ以外の
// タッチはすべてタイル操作（設置・採掘・耕作）に回す。

/** スティック基点の半径（描画・倒し量の正規化に使う）。 */
export const STICK_RADIUS = 52;
/** 基点の中心から画面の左端・下端までの距離。 */
export const STICK_CENTER_OFFSET = 78;
/** タッチ開始をスティックとみなす基点からの距離（描画より少し広く取る）。 */
export const STICK_HIT_RADIUS = 68;

/** キャンバス寸法からスティック基点（左下固定）を返す。 */
export function stickBase(width: number, height: number): { x: number; y: number } {
  return { x: STICK_CENTER_OFFSET, y: Math.max(STICK_CENTER_OFFSET, height - STICK_CENTER_OFFSET) };
}

/** タッチ開始点がスティック基点の円の中か。 */
export function isStickTouch(x: number, y: number, base: { x: number; y: number }): boolean {
  return Math.hypot(x - base.x, y - base.y) <= STICK_HIT_RADIUS;
}

/** タッチ点 → スティックの倒し量（長さ1でクランプ）。 */
export function stickVector(x: number, y: number, base: { x: number; y: number }): { dx: number; dy: number } {
  let dx = (x - base.x) / STICK_RADIUS;
  let dy = (y - base.y) / STICK_RADIUS;
  const len = Math.hypot(dx, dy);
  if (len > 1) {
    dx /= len;
    dy /= len;
  }
  return { dx, dy };
}
