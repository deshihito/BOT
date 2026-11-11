// ワードサーチの純粋ロジック（UI 非依存・シード決定的）。
// 9x9 グリッドにカタカナ単語（4〜7文字）8語を横・縦・斜めに配置し、
// 残りのマスはランダムなカタカナで埋める。単語同士の交差は、
// 交差するマスの文字が一致する場合のみ許可する。
// 単語は左→右／上→下方向にだけ置く（読み方向は4方向）。

export const WS_SIZE = 9;
export const WS_WORD_COUNT = 8;

/** 内蔵単語バンク（カタカナ、4〜7文字）。 */
export const WS_WORD_BANK: string[] = [
  "サクランボ",
  "カブトムシ",
  "トウモロコシ",
  "アイスクリーム",
  "ヒマワリ",
  "ハンバーガー",
  "スパゲッティ",
  "サンタクロース",
  "ユキダルマ",
  "クリスマス",
  "タンポポ",
  "チューリップ",
  "ライオン",
  "ドラゴン",
  "ユニコーン",
  "ロボット",
  "コンピュータ",
  "ヘリコプター",
  "シンカンセン",
  "ペンギン",
  "カンガルー",
  "フラミンゴ",
  "バイオリン",
  "トランペット",
  "メロンパン",
  "ドーナツ",
  "オコノミヤキ",
  "ラーメン",
  "キャンプ",
  "バナナジュース",
  "プレゼント",
  "エレベーター",
  "スマートフォン",
  "ポップコーン",
  "ショートケーキ",
];

/** 埋め草に使うカタカナ。 */
const FILLER = [..."アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲンー"];

/** 配置方向（dr, dc）: 右・下・右下・右上。単語はこの向きに読む。 */
const DIRS: [number, number][] = [
  [0, 1],
  [1, 0],
  [1, 1],
  [-1, 1],
];

export type WsPlacement = {
  word: string;
  /** 単語の文字順に対応するセル index 列。 */
  cells: number[];
};

export type WsStatus = "playing" | "won";

export interface WordSearchState {
  size: number;
  /** size*size の1文字配列。 */
  grid: string[];
  placements: WsPlacement[];
  /** 発見済みの単語。 */
  found: string[];
  mistakes: number;
  status: WsStatus;
  seed: number;
}

/** mulberry32。状態を数値で持ち回り、決定的に再現できるようにする。 */
function nextRandom(rng: number): { value: number; rng: number } {
  let t = (rng + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, rng: t | 0 };
}

export function createWordSearch(seed: number): WordSearchState {
  const size = WS_SIZE;
  let rng = seed | 0;
  const rand = (n: number): number => {
    const r = nextRandom(rng);
    rng = r.rng;
    return Math.floor(r.value * n);
  };

  const cells: (string | null)[] = new Array(size * size).fill(null);
  const placements: WsPlacement[] = [];

  // バンクをシャッフルし、置けたものから WS_WORD_COUNT 語まで配置する。
  const bank = [...WS_WORD_BANK];
  for (let i = bank.length - 1; i > 0; i--) {
    const j = rand(i + 1);
    [bank[i], bank[j]] = [bank[j], bank[i]];
  }

  for (const word of bank) {
    if (placements.length >= WS_WORD_COUNT) break;
    const chars = [...word];
    if (chars.length < 4 || chars.length > size) continue;
    let placed: WsPlacement | null = null;
    for (let attempt = 0; attempt < 300 && !placed; attempt++) {
      const [dr, dc] = DIRS[rand(DIRS.length)];
      const startR = rand(size);
      const startC = rand(size);
      const endR = startR + dr * (chars.length - 1);
      const endC = startC + dc * (chars.length - 1);
      if (endR < 0 || endR >= size || endC < 0 || endC >= size) continue;
      const idxs: number[] = [];
      let ok = true;
      for (let k = 0; k < chars.length; k++) {
        const idx = (startR + dr * k) * size + (startC + dc * k);
        const existing = cells[idx];
        if (existing !== null && existing !== chars[k]) {
          ok = false;
          break;
        }
        idxs.push(idx);
      }
      if (!ok) continue;
      for (let k = 0; k < chars.length; k++) cells[idxs[k]] = chars[k];
      placed = { word, cells: idxs };
    }
    if (placed) placements.push(placed);
  }

  const grid = cells.map((c) => (c === null ? FILLER[rand(FILLER.length)] : c));
  return {
    size,
    grid,
    placements,
    found: [],
    mistakes: 0,
    status: "playing",
    seed: seed | 0,
  };
}

/**
 * 2点間が直線（縦・横・45度の斜め）なら、そのセル index 列を始点→終点の順で返す。
 * 直線でない／範囲外なら null。
 */
export function wsLineCells(from: number, to: number, size: number): number[] | null {
  if (!Number.isInteger(from) || !Number.isInteger(to)) return null;
  if (from < 0 || to < 0 || from >= size * size || to >= size * size) return null;
  if (from === to) return null;
  const r1 = Math.floor(from / size);
  const c1 = from % size;
  const r2 = Math.floor(to / size);
  const c2 = to % size;
  const dr = r2 - r1;
  const dc = c2 - c1;
  if (dr !== 0 && dc !== 0 && Math.abs(dr) !== Math.abs(dc)) return null;
  const steps = Math.max(Math.abs(dr), Math.abs(dc));
  const sr = Math.sign(dr);
  const sc = Math.sign(dc);
  const out: number[] = [];
  for (let k = 0; k <= steps; k++) out.push((r1 + sr * k) * size + (c1 + sc * k));
  return out;
}

/**
 * 始点と終点をタップして単語を選択する。
 * - 選択した文字列（逆順も可）が未発見の配置単語と一致すれば発見として記録する。
 * - 直線でない選択は状態を変えない（同一参照を返す）。
 * - 直線だが単語でない場合は mistakes を +1 した新しい状態を返す。
 */
export function selectLine(state: WordSearchState, from: number, to: number): WordSearchState {
  if (state.status !== "playing") return state;
  const line = wsLineCells(from, to, state.size);
  if (!line) return state;
  const text = line.map((i) => state.grid[i]).join("");
  const reversed = [...line].reverse().map((i) => state.grid[i]).join("");
  const hit = state.placements.find(
    (p) => !state.found.includes(p.word) && (p.word === text || p.word === reversed),
  );
  if (!hit) {
    return { ...state, mistakes: state.mistakes + 1 };
  }
  const found = [...state.found, hit.word];
  return {
    ...state,
    found,
    status: found.length >= state.placements.length ? "won" : "playing",
  };
}

/** その単語が発見済みかどうか。 */
export function wsIsFound(state: WordSearchState, word: string): boolean {
  return state.found.includes(word);
}
