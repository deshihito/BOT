// 覆面算（A + B = C 形式の足し算）の純粋ロジック（UI 非依存・シード決定的）。
// 数字をカタカナ記号に置き換えた等式を示し、各記号に 0〜9 を割り当てて等式を成立させる。
// 生成は「記号のパターン（式の形）を先に作り、桁ごとの総当たり（繰り上がり伝播つき
// 深さ優先）で解を数え、ちょうど1つだけになるパターンだけを採用する」方式。
// ランダムな数値の等式を記号化する方式では一意解がほぼ得られないため、
// 繰り返し記号を含むパターンを先に作るのが品質の肝になる。
// 先頭の記号には 0 を割り当てられない。

/** 記号に使うカタカナ。問題では最大で8種類まで使う。 */
export const ALPHAMETIC_SYMBOLS = [
  "ア", "イ", "ウ", "エ", "オ", "カ", "キ", "ク", "ケ", "コ",
  "サ", "シ", "ス", "セ", "ソ", "タ", "チ", "ツ", "テ", "ト",
] as const;

export type AlphameticStatus = "playing" | "won";

export type AlphameticState = {
  seed: number;
  /** 記号で書かれた被加数・加数・和。 */
  a: string;
  b: string;
  c: string;
  /** 出現する記号（出現順）。 */
  symbols: string[];
  /** 先頭に来るため 0 を割り当てられない記号。 */
  leading: string[];
  /** 正解の割り当て（検証・テスト用。UI には出さない）。 */
  solution: Record<string, number>;
  /** プレイヤーの割り当て（未割り当てはキー自体なし）。 */
  guesses: Record<string, number>;
  status: AlphameticStatus;
  /** 割り当て変更の回数。 */
  moves: number;
};

/** mulberry32。状態を数値で持ち回り、決定的に再現できるようにする。 */
function nextRandom(rng: number): { value: number; rng: number } {
  let t = (rng + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, rng: t | 0 };
}

function randInt(rng: number, lo: number, hi: number): { value: number; rng: number } {
  const r = nextRandom(rng);
  return { value: lo + Math.floor(r.value * (hi - lo + 1)), rng: r.rng };
}

/**
 * 記号の等式 a + b = c（記号文字列）の解を最大 limit 件まで探す。
 * 桁ごとに右から見て、繰り上がりを伝播させながら割り当てを深さ優先で試す。
 */
export function searchAlphameticSolutions(
  a: string,
  b: string,
  c: string,
  limit = 2,
): Record<string, number>[] {
  const symbols: string[] = [];
  for (const ch of a + b + c) {
    if (!symbols.includes(ch)) symbols.push(ch);
  }
  if (symbols.length > 10) return [];
  const index = new Map(symbols.map((s, i) => [s, i]));
  const leading = new Set([a[0], b[0], c[0]]);
  const assign = new Array<number>(symbols.length).fill(-1);
  const used = new Array<boolean>(10).fill(false);
  const cols = c.length;
  const solutions: Record<string, number>[] = [];

  const dfsColumn = (col: number, carry: number): void => {
    if (solutions.length >= limit) return;
    if (col === cols) {
      if (carry === 0) {
        const sol: Record<string, number> = {};
        symbols.forEach((s, i) => {
          sol[s] = assign[i];
        });
        solutions.push(sol);
      }
      return;
    }
    const sa = col < a.length ? a[a.length - 1 - col] : null;
    const sb = col < b.length ? b[b.length - 1 - col] : null;
    const sc = c[c.length - 1 - col];
    const colSymbols: string[] = [];
    for (const s of [sa, sb, sc]) {
      if (s !== null && !colSymbols.includes(s)) colSymbols.push(s);
    }
    const pending = colSymbols.filter((s) => assign[index.get(s) as number] === -1);
    const tryAssign = (k: number): void => {
      if (solutions.length >= limit) return;
      if (k === pending.length) {
        const da = sa === null ? 0 : assign[index.get(sa) as number];
        const db = sb === null ? 0 : assign[index.get(sb) as number];
        const dc = assign[index.get(sc) as number];
        const sum = da + db + carry;
        if (sum % 10 === dc) dfsColumn(col + 1, Math.floor(sum / 10));
        return;
      }
      const s = pending[k];
      const si = index.get(s) as number;
      for (let d = 0; d <= 9; d++) {
        if (used[d]) continue;
        if (d === 0 && leading.has(s)) continue;
        assign[si] = d;
        used[d] = true;
        tryAssign(k + 1);
        assign[si] = -1;
        used[d] = false;
        if (solutions.length >= limit) return;
      }
    };
    tryAssign(0);
  };

  dfsColumn(0, 0);
  return solutions;
}

/** 記号の等式 a + b = c の解の数を数える（limit で打ち切り）。 */
export function countAlphameticSolutions(a: string, b: string, c: string, limit = 2): number {
  return searchAlphameticSolutions(a, b, c, limit).length;
}

/** 割り当てで記号文字列を数値に直す。全記号が割り当て済みでなければ null。 */
export function alphameticTermValue(term: string, assign: Record<string, number>): number | null {
  let value = 0;
  for (const ch of term) {
    const d = assign[ch];
    if (d === undefined) return null;
    value = value * 10 + d;
  }
  return value;
}

/** 現在の割り当ての評価。complete = 全記号に数字が入っている、holds = 等式が成り立つ。 */
export function evaluateAlphametic(state: AlphameticState): { complete: boolean; holds: boolean } {
  const complete = state.symbols.every((s) => state.guesses[s] !== undefined);
  if (!complete) return { complete: false, holds: false };
  const av = alphameticTermValue(state.a, state.guesses);
  const bv = alphameticTermValue(state.b, state.guesses);
  const cv = alphameticTermValue(state.c, state.guesses);
  return { complete: true, holds: av !== null && bv !== null && cv !== null && av + bv === cv };
}

/** 記号パターンから一意解の覆面算を作る。失敗したら null（呼び出し側で再試行）。 */
function buildPuzzle(rng: number): { puzzle: Omit<AlphameticState, "guesses" | "status" | "moves" | "seed">; rng: number } | null {
  let r = rng;
  // 使う記号の集合（4〜6種）をプールからシャッフルして選ぶ。
  const pool = [...ALPHAMETIC_SYMBOLS];
  for (let i = pool.length - 1; i > 0; i--) {
    const nr = nextRandom(r);
    r = nr.rng;
    const j = Math.floor(nr.value * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const kPick = randInt(r, 4, 6);
  r = kPick.rng;
  const alphabet = pool.slice(0, kPick.value);

  const lenPickA = randInt(r, 2, 3);
  r = lenPickA.rng;
  const lenPickB = randInt(r, 2, 3);
  r = lenPickB.rng;
  const carryPick = randInt(r, 0, 1);
  r = carryPick.rng;
  const lenC = Math.min(4, Math.max(lenPickA.value, lenPickB.value) + carryPick.value);

  const makeTerm = (len: number): string => {
    let out = "";
    for (let i = 0; i < len; i++) {
      const pick = randInt(r, 0, alphabet.length - 1);
      r = pick.rng;
      out += alphabet[pick.value];
    }
    return out;
  };
  const a = makeTerm(lenPickA.value);
  const b = makeTerm(lenPickB.value);
  const c = makeTerm(lenC);

  const symbols: string[] = [];
  for (const ch of a + b + c) {
    if (!symbols.includes(ch)) symbols.push(ch);
  }
  if (symbols.length < 4) return null;

  const solutions = searchAlphameticSolutions(a, b, c, 2);
  if (solutions.length !== 1) return null;
  const leading = [...new Set([a[0], b[0], c[0]])];
  return { puzzle: { a, b, c, symbols, leading, solution: solutions[0] }, rng: r };
}

export function createAlphameticGame(seed: number): AlphameticState {
  let rng = seed | 0;
  // 一意解になる問題が得られるまで再生成する（通常は数回で決まる）。
  for (let attempt = 0; attempt < 2000; attempt++) {
    const built = buildPuzzle(rng);
    rng = built ? built.rng : nextRandom(rng).rng;
    if (built) {
      return {
        seed: seed | 0,
        ...built.puzzle,
        guesses: {},
        status: "playing",
        moves: 0,
      };
    }
  }
  // 到達しない想定の保険（19 + 81 = 100 を記号化した固定題。解は1つだけ）。
  return {
    seed: seed | 0,
    a: "イト",
    b: "オイ",
    c: "イタタ",
    symbols: ["イ", "ト", "オ", "タ"],
    leading: ["イ", "オ"],
    solution: { イ: 1, ト: 9, オ: 8, タ: 0 },
    guesses: {},
    status: "playing",
    moves: 0,
  };
}

/**
 * 記号への割り当てを変更する。digit が null なら解除。
 * 不正な変更（終了後・未知の記号・範囲外・先頭記号への 0・他記号と重複する数字）は同状態を返す。
 */
export function setAlphameticGuess(
  state: AlphameticState,
  symbol: string,
  digit: number | null,
): AlphameticState {
  if (state.status !== "playing") return state;
  if (!state.symbols.includes(symbol)) return state;
  const guesses = { ...state.guesses };
  if (digit === null) {
    if (guesses[symbol] === undefined) return state;
    delete guesses[symbol];
    return { ...state, guesses, moves: state.moves + 1 };
  }
  if (!Number.isInteger(digit) || digit < 0 || digit > 9) return state;
  if (digit === 0 && state.leading.includes(symbol)) return state;
  for (const [s, d] of Object.entries(state.guesses)) {
    if (s !== symbol && d === digit) return state;
  }
  if (guesses[symbol] === digit) return state;
  guesses[symbol] = digit;
  const next: AlphameticState = { ...state, guesses, moves: state.moves + 1 };
  const ev = evaluateAlphametic(next);
  if (ev.complete && ev.holds) return { ...next, status: "won" };
  return next;
}
