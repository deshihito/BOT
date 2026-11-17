// AGO WORLD BOX の線路（純粋ロジック）。
// 経済仕様書 §5.2（サプライライン）/ §6.2（鉄道）の実装。
// 線路は床ブロック（アイテム "rail"）として置かれ、4近傍でつながった
// 線路タイルの集合が1つの路線（連結成分）になる。
// - サプライライン: 自国の首都に隣接する線路を含む成分へ、畑・岩場が
//   隣接していれば「接続」扱いで収穫/採掘にボーナスが付く。仕様書は
//   未接続なら休眠だが、既存の畑・岩場が一斉に止まる破壊的変更になる
//   ため、現行はボーナス方式（休眠化はしない）。
// - 線路ワープ: 線路の上に立つと、同じ成分内の線路タイルへ移動できる
//   （スタミナ消費なし）。検証は /api/worldbox/rails がこのロジックで
//   サーバー側で行う。
// 上書きマップは呼び出し側が有効なものだけに絞って渡すこと
// （isOverrideActive を通した RailOverridesMap）。
// このモジュールは tiles.ts に依存しない（キー形式だけ合わせる）:
// ルートを bundle するテストが単体で差し替えられるようにするため。

/** 線路判定に必要な最小限の形をした上書きマップ。 */
export type RailOverridesMap = Record<
  string,
  { block?: { itemId?: unknown } | null } | null | undefined
>;

function keyOf(x: number, y: number): string {
  return `${x},${y}`;
}

/** 線路ブロックのアイテム ID。 */
export const RAIL_ITEM_ID = "rail";

/** 線路ワープの行き先として返す上限（近い順）。 */
export const RAIL_STOPS_LIMIT = 30;

const DIRS4: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

function parseKey(key: string): { x: number; y: number } | null {
  const m = /^(-?\d+),(-?\d+)$/.exec(key);
  if (!m) return null;
  return { x: Number(m[1]), y: Number(m[2]) };
}

/** 線路タイルのキー集合。 */
export function railKeysOf(overrides: RailOverridesMap): Set<string> {
  const keys = new Set<string>();
  for (const [key, ov] of Object.entries(overrides)) {
    if (ov?.block?.itemId === RAIL_ITEM_ID) keys.add(key);
  }
  return keys;
}

/** そのタイルが線路かどうか。 */
export function isRailAt(overrides: RailOverridesMap, x: number, y: number): boolean {
  return overrides[keyOf(x, y)]?.block?.itemId === RAIL_ITEM_ID;
}

/**
 * startKey を含む線路の連結成分（4近傍 BFS）。
 * startKey が線路でなければ空集合。
 */
export function railComponent(overrides: RailOverridesMap, startKey: string): Set<string> {
  const rails = railKeysOf(overrides);
  const component = new Set<string>();
  if (!rails.has(startKey)) return component;
  const queue = [startKey];
  component.add(startKey);
  while (queue.length > 0) {
    const key = queue.pop()!;
    const pos = parseKey(key);
    if (!pos) continue;
    for (const [dx, dy] of DIRS4) {
      const nk = keyOf(pos.x + dx, pos.y + dy);
      if (rails.has(nk) && !component.has(nk)) {
        component.add(nk);
        queue.push(nk);
      }
    }
  }
  return component;
}

/** 成分内の線路が首都タイルに隣接しているか（チェビシェフ距離1以内）。 */
export function componentTouchesCapital(
  component: ReadonlySet<string>,
  capital: { x: number; y: number },
): boolean {
  for (const key of component) {
    const pos = parseKey(key);
    if (!pos) continue;
    if (Math.max(Math.abs(pos.x - capital.x), Math.abs(pos.y - capital.y)) <= 1) return true;
  }
  return false;
}

/**
 * サプライライン接続判定: 資源マス (x, y) の8近傍にある線路が、
 * 首都に触れる連結成分に属していれば接続している。
 */
export function isSupplyConnected(
  overrides: RailOverridesMap,
  capital: { x: number; y: number },
  x: number,
  y: number,
): boolean {
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const key = keyOf(x + dx, y + dy);
      if (!isRailAt(overrides, x + dx, y + dy)) continue;
      if (componentTouchesCapital(railComponent(overrides, key), capital)) return true;
    }
  }
  return false;
}

/** 線路ワープの行き先候補。 */
export type RailStop = { x: number; y: number; capital: boolean };

/**
 * fromKey の成分内の行き先一覧（自分が立つタイルは除く）。
 * 首都に隣接するタイルには capital フラグを立てる。近い順に並べ、
 * RAIL_STOPS_LIMIT 件で打ち切る。
 */
export function railStops(
  overrides: RailOverridesMap,
  fromKey: string,
  capital: { x: number; y: number } | null,
): RailStop[] {
  const from = parseKey(fromKey);
  if (!from) return [];
  const component = railComponent(overrides, fromKey);
  const stops: RailStop[] = [];
  for (const key of component) {
    if (key === fromKey) continue;
    const pos = parseKey(key);
    if (!pos) continue;
    stops.push({
      x: pos.x,
      y: pos.y,
      capital:
        capital !== null &&
        Math.max(Math.abs(pos.x - capital.x), Math.abs(pos.y - capital.y)) <= 1,
    });
  }
  stops.sort((a, b) => {
    const da = Math.abs(a.x - from.x) + Math.abs(a.y - from.y);
    const db = Math.abs(b.x - from.x) + Math.abs(b.y - from.y);
    return da - db;
  });
  return stops.slice(0, RAIL_STOPS_LIMIT);
}

/**
 * 線路ワープの検証: 乗り場・降り場がどちらも線路で、同じ成分に属すること。
 * 問題なければ null、あれば理由を返す。
 */
export function railRideError(
  overrides: RailOverridesMap,
  fromKey: string,
  toKey: string,
): "not_on_rail" | "not_connected" | null {
  if (!isRailAt(overrides, ...splitKey(fromKey)) || !isRailAt(overrides, ...splitKey(toKey))) {
    return "not_on_rail";
  }
  if (fromKey === toKey) return null;
  const component = railComponent(overrides, fromKey);
  return component.has(toKey) ? null : "not_connected";
}

function splitKey(key: string): [number, number] {
  const pos = parseKey(key);
  return pos ? [pos.x, pos.y] : [Number.NaN, Number.NaN];
}
