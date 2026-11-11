// ビンゴの純粋ロジック（UI 非依存・シード決定的）。
// 5x5 カード（列ごとに B=1-15 / I=16-30 / N=31-45 / G=46-60 / O=61-75、中央はフリー）。
// プレイヤー1枚 + CPU 3枚で、抽選（1〜75）を進めてライン完成を競う。
// 状態は JSON 化可能な値のみ。遷移関数は状態を破壊せず新しい状態を返す。

export type BingoCard = {
  /** row-major 25マス。中央（index 12）はフリーで 0。 */
  cells: number[];
};

export type BingoWinner = { type: "player" } | { type: "cpu"; index: number } | null;

export type BingoPhase = "playing" | "finished";

export type BingoState = {
  playerCard: BingoCard;
  cpuCards: BingoCard[];
  /** 残りの抽選順（先頭から引く）。 */
  pool: number[];
  /** 引かれた数字（引いた順）。 */
  drawn: number[];
  phase: BingoPhase;
  winner: BingoWinner;
  rng: number;
};

export const BINGO_CPU_COUNT = 3;
export const BINGO_MAX_NUMBER = 75;

/** mulberry32。状態を数値で持ち回り、決定的に再現できるようにする。 */
function nextRandom(rng: number): { value: number; rng: number } {
  let t = (rng + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, rng: t | 0 };
}

function shuffled(values: number[], rng: number): { values: number[]; rng: number } {
  const out = [...values];
  let r = rng;
  for (let i = out.length - 1; i > 0; i--) {
    const n = nextRandom(r);
    r = n.rng;
    const j = Math.floor(n.value * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return { values: out, rng: r };
}

/** 列 col（0=B … 4=O）の数字範囲 [min, max]。 */
export function columnRange(col: number): { min: number; max: number } {
  const min = col * 15 + 1;
  return { min, max: min + 14 };
}

/** 数字に対応する列の文字（B/I/N/G/O）。 */
export function columnLetter(value: number): string {
  if (value < 1 || value > BINGO_MAX_NUMBER) return "";
  return "BINGO"[Math.floor((value - 1) / 15)];
}

function createCard(rng: number): { card: BingoCard; rng: number } {
  let r = rng;
  const cells = new Array<number>(25).fill(0);
  for (let col = 0; col < 5; col++) {
    const { min } = columnRange(col);
    const picks = shuffled(
      Array.from({ length: 15 }, (_, i) => min + i),
      r,
    );
    r = picks.rng;
    for (let row = 0; row < 5; row++) {
      cells[row * 5 + col] = picks.values[row];
    }
  }
  cells[12] = 0; // 中央フリー
  return { card: { cells }, rng: r };
}

/** カードの妥当性検証（列範囲・重複なし・中央フリー）。テストと安全確認用。 */
export function isValidCard(card: BingoCard): boolean {
  if (!card || !Array.isArray(card.cells) || card.cells.length !== 25) return false;
  if (card.cells[12] !== 0) return false;
  const seen = new Set<number>();
  for (let col = 0; col < 5; col++) {
    const { min, max } = columnRange(col);
    for (let row = 0; row < 5; row++) {
      const v = card.cells[row * 5 + col];
      if (row === 2 && col === 2) continue;
      if (!Number.isInteger(v) || v < min || v > max) return false;
      if (seen.has(v)) return false;
      seen.add(v);
    }
  }
  return seen.size === 24;
}

/** 全12ライン（横5・縦5・斜め2）のマス index 配列。 */
export const BINGO_LINES: { id: string; label: string; cells: number[] }[] = [
  ...Array.from({ length: 5 }, (_, row) => ({
    id: `row${row}`,
    label: `横 ${row + 1} 行目`,
    cells: Array.from({ length: 5 }, (_, col) => row * 5 + col),
  })),
  ...Array.from({ length: 5 }, (_, col) => ({
    id: `col${col}`,
    label: `縦 ${"BINGO"[col]} 列`,
    cells: Array.from({ length: 5 }, (_, row) => row * 5 + col),
  })),
  { id: "diag0", label: "斜め（左上→右下）", cells: [0, 6, 12, 18, 24] },
  { id: "diag1", label: "斜め（右上→左下）", cells: [4, 8, 12, 16, 20] },
];

/** そのマスがマーク済みか（引かれた数字か、中央フリー）。 */
export function isMarked(card: BingoCard, drawn: number[], index: number): boolean {
  const v = card.cells[index];
  if (v === 0) return true;
  return drawn.includes(v);
}

/** 完成しているラインの id 一覧。 */
export function completedLines(card: BingoCard, drawn: number[]): string[] {
  return BINGO_LINES.filter((line) =>
    line.cells.every((i) => isMarked(card, drawn, i)),
  ).map((line) => line.id);
}

/** あと1マスで完成するライン（リーチ）の id 一覧。完成済みラインは含まない。 */
export function reachLines(card: BingoCard, drawn: number[]): string[] {
  return BINGO_LINES.filter((line) => {
    const unmarked = line.cells.filter((i) => !isMarked(card, drawn, i));
    return unmarked.length === 1;
  }).map((line) => line.id);
}

export type CardStatus = {
  bingo: boolean;
  reach: boolean;
  lines: string[];
  reachCount: number;
  /** 完成までの最短残りマス数（ビンゴ済みなら 0）。 */
  minRemaining: number;
  markedCount: number;
};

export function cardStatus(card: BingoCard, drawn: number[]): CardStatus {
  const lines = completedLines(card, drawn);
  const reach = reachLines(card, drawn);
  let minRemaining = 5;
  for (const line of BINGO_LINES) {
    const unmarked = line.cells.filter((i) => !isMarked(card, drawn, i)).length;
    if (unmarked < minRemaining) minRemaining = unmarked;
  }
  return {
    bingo: lines.length > 0,
    reach: lines.length === 0 && reach.length > 0,
    lines,
    reachCount: reach.length,
    minRemaining,
    markedCount: card.cells.filter((_, i) => isMarked(card, drawn, i)).length,
  };
}

export function createBingoGame(seed: number): BingoState {
  let rng = seed | 0;
  const player = createCard(rng);
  rng = player.rng;
  const cpuCards: BingoCard[] = [];
  for (let i = 0; i < BINGO_CPU_COUNT; i++) {
    const c = createCard(rng);
    rng = c.rng;
    cpuCards.push(c.card);
  }
  const pool = shuffled(
    Array.from({ length: BINGO_MAX_NUMBER }, (_, i) => i + 1),
    rng,
  );
  return {
    playerCard: player.card,
    cpuCards,
    pool: pool.values,
    drawn: [],
    phase: "playing",
    winner: null,
    rng: pool.rng,
  };
}

function judge(state: BingoState): BingoState {
  // 同時ビンゴのときはプレイヤー優先。
  if (cardStatus(state.playerCard, state.drawn).bingo) {
    return { ...state, phase: "finished", winner: { type: "player" } };
  }
  for (let i = 0; i < state.cpuCards.length; i++) {
    if (cardStatus(state.cpuCards[i], state.drawn).bingo) {
      return { ...state, phase: "finished", winner: { type: "cpu", index: i } };
    }
  }
  if (state.pool.length === 0) {
    // 理論上は必ず誰かがビンゴするが、保険として引き分け終了。
    return { ...state, phase: "finished", winner: null };
  }
  return state;
}

/** 次の1球を引く。終了後・プール切れでは状態をそのまま返す。 */
export function drawNext(state: BingoState): BingoState {
  if (state.phase !== "playing" || state.pool.length === 0) return state;
  const next: BingoState = {
    ...state,
    pool: state.pool.slice(1),
    drawn: [...state.drawn, state.pool[0]],
  };
  return judge(next);
}

/** 勝者メッセージ（UI 表示用）。未終了なら空文字。 */
export function winnerMessage(state: BingoState, cpuNames: string[]): string {
  if (state.phase !== "finished") return "";
  if (state.winner?.type === "player") return "あなたのビンゴ！ 優勝です。";
  if (state.winner?.type === "cpu") {
    const name = cpuNames[state.winner.index] ?? `CPU ${state.winner.index + 1}`;
    return `${name} がビンゴ。今回は負けてしまいました。`;
  }
  return "全ての数字を引きましたが、決着はつきませんでした。";
}
