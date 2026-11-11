// 麻雀ソリティアの純粋ロジック（UI 非依存・シード決定的）。
// 積み重なった牌から、フリーな同じ種類のペアを取り除いていくパズル。
//
// 配置: 牌は 2x2 単位の矩形として座標 (x, y, layer) を持つ固定レイアウト（全88枚）。
// フリー判定: 上に牌が乗っておらず（矩形が重なる上層の牌が無い）、
//   かつ左右どちらかの側が空いている（同レイヤーで真横に接する牌が無い）こと。
// 可解性の保証: 生成時に「今フリーな2枚」を繰り返し選んで種類を割り当てる。
//   割り当ての過程で残り集合は単調に減っていくため、割り当てた順序そのままで
//   ペアを取り除いていける（k 番目のペアは、k-1 番目までを外した盤面でフリー）。
// 種類は22種×4枚。各種類はちょうど2ペアに割り当てられる。

export type MjTile = {
  id: number;
  /** 種類 index（0..MJ_KINDS.length-1）。 */
  kind: number;
  /** 左上の座標（単位は牌の半分）。牌の大きさは 2x2 単位。 */
  x: number;
  y: number;
  layer: number;
  removed: boolean;
};

export type MjState = {
  tiles: MjTile[];
  moves: number;
  status: "playing" | "won" | "stuck";
  seed: number;
  /** 解のペア列（この順に取り除けば必ず全て取れる）。タイル id のペア。 */
  solution: [number, number][];
};

/** 牌の種類（絵柄）。22種。 */
export const MJ_KINDS: string[] = [
  "🀇", "🀈", "🀉", "🀊", "🀋", "🀌", "🀍", "🀎", "🀏", // 萬子 1-9
  "🀙", "🀚", "🀛", "🀜", "🀝", "🀞", "🀟", "🀠", "🀡", // 筒子 1-9
  "🀀", "🀁", "🀂", "🀃", // 風牌
];

/** 盤面の広さ（単位）。牌は 2x2 単位。 */
export const MJ_BOARD_W = 24;
export const MJ_BOARD_H = 10;

type Pos = { x: number; y: number; layer: number };

/** 固定レイアウト（88枚）。下の層から順に定義する。 */
function layoutPositions(): Pos[] {
  const out: Pos[] = [];
  // layer 0: 5行 x 12列
  for (const y of [0, 2, 4, 6, 8]) {
    for (let x = 0; x <= 22; x += 2) out.push({ x, y, layer: 0 });
  }
  // layer 1: 3行 x 6列（中央）
  for (const y of [2, 4, 6]) {
    for (let x = 6; x <= 16; x += 2) out.push({ x, y, layer: 1 });
  }
  // layer 2: 2行 x 3列（半マスずらし）
  for (const y of [3, 5]) {
    for (let x = 9; x <= 13; x += 2) out.push({ x, y, layer: 2 });
  }
  // layer 3: 2行 x 2列（頂上）
  for (const y of [3, 5]) {
    for (let x = 10; x <= 12; x += 2) out.push({ x, y, layer: 3 });
  }
  return out;
}

/** mulberry32（minesweeper 等と同一方式）。 */
function nextRandom(rng: number): { value: number; rng: number } {
  let t = (rng + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, rng: t | 0 };
}

function rectsOverlap(a: Pos, b: Pos): boolean {
  return a.x < b.x + 2 && b.x < a.x + 2 && a.y < b.y + 2 && b.y < a.y + 2;
}

/**
 * 残っている牌集合の中で、タイルがフリーかどうか。
 * remaining は「まだ盤に残っている牌の id 集合」。
 */
function isFreeAmong(tiles: MjTile[], remaining: Set<number>, tile: MjTile): boolean {
  // 上に乗っている牌があるか（上層で矩形が重なる牌）。
  for (const other of tiles) {
    if (other.id === tile.id || !remaining.has(other.id)) continue;
    if (other.layer > tile.layer && rectsOverlap(tile, other)) return false;
  }
  // 左右の側に同レイヤーの牌が真横に接しているか。
  let leftBlocked = false;
  let rightBlocked = false;
  for (const other of tiles) {
    if (other.id === tile.id || !remaining.has(other.id)) continue;
    if (other.layer !== tile.layer) continue;
    const yOverlap = other.y < tile.y + 2 && tile.y < other.y + 2;
    if (!yOverlap) continue;
    if (other.x + 2 === tile.x) leftBlocked = true;
    if (other.x === tile.x + 2) rightBlocked = true;
  }
  return !leftBlocked || !rightBlocked;
}

/** 現在の状態でフリーな牌の id 一覧。 */
export function freeTileIds(state: MjState): number[] {
  const remaining = new Set(state.tiles.filter((t) => !t.removed).map((t) => t.id));
  return state.tiles
    .filter((t) => !t.removed && isFreeAmong(state.tiles, remaining, t))
    .map((t) => t.id);
}

/** 今取り除けるペア（フリーで同じ種類）の候補一覧。 */
export function availablePairs(state: MjState): [number, number][] {
  const free = freeTileIds(state);
  const byKind = new Map<number, number[]>();
  for (const id of free) {
    const kind = state.tiles[id].kind;
    const list = byKind.get(kind) ?? [];
    list.push(id);
    byKind.set(kind, list);
  }
  const pairs: [number, number][] = [];
  for (const list of byKind.values()) {
    for (let i = 0; i + 1 < list.length; i += 2) {
      pairs.push([list[i], list[i + 1]]);
    }
  }
  return pairs;
}

/** 残り枚数。 */
export function remainingCount(state: MjState): number {
  return state.tiles.filter((t) => !t.removed).length;
}

function computeStatus(state: MjState): MjState["status"] {
  if (remainingCount(state) === 0) return "won";
  return availablePairs(state).length > 0 ? "playing" : "stuck";
}

export function createMahjongGame(seed: number): MjState {
  const positions = layoutPositions();
  const total = positions.length; // 88
  const tiles: MjTile[] = positions.map((p, i) => ({
    id: i,
    kind: -1,
    x: p.x,
    y: p.y,
    layer: p.layer,
    removed: false,
  }));

  let rng = seed | 0;
  // 種類の使用順をシャッフル（各種類は2ペア＝4枚に使う）。
  const kindOrder = MJ_KINDS.map((_, i) => i);
  for (let i = kindOrder.length - 1; i > 0; i--) {
    const r = nextRandom(rng);
    rng = r.rng;
    const j = Math.floor(r.value * (i + 1));
    [kindOrder[i], kindOrder[j]] = [kindOrder[j], kindOrder[i]];
  }

  // 割り当てシミュレーション: フリーな2枚を選んでペアにし、盤から外していく。
  // 詰まったら rng を進めて最初からやり直す（決定的）。
  for (let attempt = 0; attempt < 200; attempt++) {
    const remaining = new Set(tiles.map((t) => t.id));
    const assignOrder: [number, number][] = [];
    const kinds = new Array<number>(total).fill(-1);
    let ok = true;
    while (remaining.size > 0) {
      const free = tiles.filter(
        (t) => remaining.has(t.id) && isFreeAmong(tiles, remaining, t),
      );
      if (free.length < 2) {
        ok = false;
        break;
      }
      const r1 = nextRandom(rng);
      rng = r1.rng;
      const first = free.splice(Math.floor(r1.value * free.length), 1)[0];
      const r2 = nextRandom(rng);
      rng = r2.rng;
      const second = free[Math.floor(r2.value * free.length)];
      const pairIndex = assignOrder.length;
      const kind = kindOrder[Math.floor(pairIndex / 2) % kindOrder.length];
      kinds[first.id] = kind;
      kinds[second.id] = kind;
      assignOrder.push([first.id, second.id]);
      remaining.delete(first.id);
      remaining.delete(second.id);
    }
    if (ok) {
      for (const t of tiles) t.kind = kinds[t.id];
      // ゲーム内での解は割り当て順そのまま。
      const solution = assignOrder;
      const state: MjState = { tiles, moves: 0, status: "playing", seed: seed | 0, solution };
      return { ...state, status: computeStatus(state) };
    }
  }
  // 到達しない想定（レイアウトは常に割り当て可能）。保険として素直に割り当てる。
  tiles.forEach((t, i) => {
    t.kind = kindOrder[Math.floor(i / 2) % kindOrder.length];
  });
  const fallback: MjState = { tiles, moves: 0, status: "playing", seed: seed | 0, solution: [] };
  return { ...fallback, status: computeStatus(fallback) };
}

/** 2枚の牌を取り除く。不正な組み合わせなら状態を変えずに返す。 */
export function removePair(state: MjState, idA: number, idB: number): MjState {
  if (state.status === "won") return state;
  if (idA === idB) return state;
  const a = state.tiles[idA];
  const b = state.tiles[idB];
  if (!a || !b || a.removed || b.removed) return state;
  if (a.kind !== b.kind) return state;
  const free = new Set(freeTileIds(state));
  if (!free.has(idA) || !free.has(idB)) return state;
  const tiles = state.tiles.map((t) =>
    t.id === idA || t.id === idB ? { ...t, removed: true } : t,
  );
  const next: MjState = { ...state, tiles, moves: state.moves + 1, status: "playing" };
  return { ...next, status: computeStatus(next) };
}

/** ヒント: 解の順序の中でまだ盤に残っている最初のペア。無ければ取れるペアの先頭。 */
export function hintPair(state: MjState): [number, number] | null {
  for (const [a, b] of state.solution) {
    if (!state.tiles[a].removed && !state.tiles[b].removed) return [a, b];
  }
  const pairs = availablePairs(state);
  return pairs.length > 0 ? pairs[0] : null;
}
