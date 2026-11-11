// ラッシュアワーの純粋ロジック（UI 非依存・シード決定的）。
// 6x6 盤で車（縦/横・2〜3マス）をスライドさせ、赤い車（target）を
// 3行目（index 2）の右端の出口へ出すパズル。
//
// 生成（可解性の保証）:
// 解けた状態（赤い車が出口にいる配置）から始め、合法なスライドを
// ランダムに繰り返して崩す。スライドはすべて可逆なので、崩した手順を
// 逆順にたどれば必ず解ける。作成時の state.solution にその逆手順を
// 保持する（初期局面に対してのみ有効）。

export type RushDir = "h" | "v";

export type RushCar = {
  id: number;
  row: number;
  col: number;
  len: 2 | 3;
  dir: RushDir;
  target: boolean;
};

export type RushSlide = { carId: number; delta: number };

export type RushState = {
  size: 6;
  cars: RushCar[];
  moves: number;
  status: "playing" | "won";
  seed: number;
  /** 生成時の崩し手順の逆（初期局面を解く手順）。 */
  solution: RushSlide[];
};

export const RUSH_SIZE = 6;
/** 出口のある行（0-based）。 */
export const RUSH_EXIT_ROW = 2;

function nextRandom(rng: number): { value: number; rng: number } {
  let t = (rng + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, rng: t | 0 };
}

function randInt(rng: number, n: number): { value: number; rng: number } {
  const r = nextRandom(rng);
  return { value: Math.floor(r.value * n), rng: r.rng };
}

/** 盤面占有（マス index → carId、空きは -1）。 */
export function rushOccupancy(cars: RushCar[]): number[] {
  const grid = new Array<number>(RUSH_SIZE * RUSH_SIZE).fill(-1);
  for (const car of cars) {
    for (let k = 0; k < car.len; k++) {
      const r = car.dir === "v" ? car.row + k : car.row;
      const c = car.dir === "h" ? car.col + k : car.col;
      grid[r * RUSH_SIZE + c] = car.id;
    }
  }
  return grid;
}

function slideRangeWith(cars: RushCar[], carId: number): { min: number; max: number } {
  const car = cars.find((c) => c.id === carId);
  if (!car) return { min: 0, max: 0 };
  const grid = rushOccupancy(cars);
  let min = 0;
  let max = 0;
  // 負方向（左/上）
  for (let d = 1; ; d++) {
    const r = car.dir === "v" ? car.row - d : car.row;
    const c = car.dir === "h" ? car.col - d : car.col;
    if (r < 0 || c < 0 || grid[r * RUSH_SIZE + c] !== -1) break;
    min = -d;
  }
  // 正方向（右/下）。先端の1マス先を見る。
  for (let d = 1; ; d++) {
    const r = car.dir === "v" ? car.row + car.len - 1 + d : car.row;
    const c = car.dir === "h" ? car.col + car.len - 1 + d : car.col;
    if (r >= RUSH_SIZE || c >= RUSH_SIZE || grid[r * RUSH_SIZE + c] !== -1) break;
    max = d;
  }
  return { min, max };
}

/** 車がスライドできる delta の範囲。 */
export function rushSlideRange(state: RushState, carId: number): { min: number; max: number } {
  return slideRangeWith(state.cars, carId);
}

/** 車がスライドできる delta の一覧（0 を除く）。 */
export function rushSlideOptions(state: RushState, carId: number): number[] {
  const { min, max } = slideRangeWith(state.cars, carId);
  const out: number[] = [];
  for (let d = min; d <= max; d++) {
    if (d !== 0) out.push(d);
  }
  return out;
}

export function rushIsSolved(cars: RushCar[]): boolean {
  const target = cars.find((c) => c.target);
  if (!target) return false;
  return target.row === RUSH_EXIT_ROW && target.col + target.len === RUSH_SIZE;
}

function applySlideToCars(cars: RushCar[], carId: number, delta: number): RushCar[] {
  return cars.map((car) => {
    if (car.id !== carId || delta === 0) return car;
    return car.dir === "h"
      ? { ...car, col: car.col + delta }
      : { ...car, row: car.row + delta };
  });
}

/** スライドを実行する。不正な delta は同じ state を返す。 */
export function rushSlide(state: RushState, carId: number, delta: number): RushState {
  if (state.status !== "playing") return state;
  if (!Number.isInteger(delta) || delta === 0) return state;
  if (!rushSlideOptions(state, carId).includes(delta)) return state;
  const cars = applySlideToCars(state.cars, carId, delta);
  return {
    ...state,
    cars,
    moves: state.moves + 1,
    status: rushIsSolved(cars) ? "won" : "playing",
  };
}

function tryPlaceCars(rng: number): { cars: RushCar[]; rng: number } | null {
  let r = rng;
  const cars: RushCar[] = [
    { id: 0, row: RUSH_EXIT_ROW, col: RUSH_SIZE - 2, len: 2, dir: "h", target: true },
  ];
  const grid = rushOccupancy(cars);
  const carCountPick = randInt(r, 3);
  r = carCountPick.rng;
  const carCount = 8 + carCountPick.value; // 8〜10 台
  let id = 1;
  let guard = 0;
  while (id <= carCount && guard < 300) {
    guard++;
    const dirPick = randInt(r, 2);
    r = dirPick.rng;
    const dir: RushDir = dirPick.value === 0 ? "h" : "v";
    const lenPick = randInt(r, 2);
    r = lenPick.rng;
    const len = (lenPick.value === 0 ? 2 : 3) as 2 | 3;
    const rowPick = randInt(r, dir === "v" ? RUSH_SIZE - len + 1 : RUSH_SIZE);
    r = rowPick.rng;
    const colPick = randInt(r, dir === "h" ? RUSH_SIZE - len + 1 : RUSH_SIZE);
    r = colPick.rng;
    const row = rowPick.value;
    const col = colPick.value;
    // 出口の行の右端は赤い車の通り道として空けておく（初期解の前提）。
    let ok = true;
    for (let k = 0; k < len; k++) {
      const rr = dir === "v" ? row + k : row;
      const cc = dir === "h" ? col + k : col;
      if (grid[rr * RUSH_SIZE + cc] !== -1) ok = false;
    }
    if (!ok) continue;
    const car: RushCar = { id, row, col, len, dir, target: false };
    cars.push(car);
    const g2 = rushOccupancy(cars);
    for (let i = 0; i < g2.length; i++) grid[i] = g2[i];
    id++;
  }
  if (id <= carCount) return null;
  return { cars, rng: r };
}

export function createRushHour(seed: number): RushState {
  let rng = seed | 0;
  for (let attempt = 0; attempt < 80; attempt++) {
    const placed = tryPlaceCars(rng);
    if (!placed) {
      rng = nextRandom(rng).rng;
      continue;
    }
    let cars = placed.cars;
    rng = placed.rng;
    // 解けた状態からランダムスライドで崩す（可逆なので可解性が保たれる）。
    // ただし「対象車が出口に戻る」スライドは使わない。途中の局面が
    // 解けた形になると、解の再生がその時点で勝ち扱いになり止まってしまう。
    const scramble: RushSlide[] = [];
    const scrambleCount = 26 + (attempt % 7);
    for (let step = 0; step < scrambleCount; step++) {
      const movable: Array<{ carId: number; options: number[] }> = [];
      for (const car of cars) {
        const options: number[] = [];
        const { min, max } = slideRangeWith(cars, car.id);
        for (let d = min; d <= max; d++) {
          if (d === 0) continue;
          if (rushIsSolved(applySlideToCars(cars, car.id, d))) continue;
          options.push(d);
        }
        if (options.length > 0) movable.push({ carId: car.id, options });
      }
      if (movable.length === 0) break;
      const pick = randInt(rng, movable.length);
      rng = pick.rng;
      const chosen = movable[pick.value];
      const dPick = randInt(rng, chosen.options.length);
      rng = dPick.rng;
      const delta = chosen.options[dPick.value];
      cars = applySlideToCars(cars, chosen.carId, delta);
      scramble.push({ carId: chosen.carId, delta });
    }
    if (rushIsSolved(cars)) continue;
    if (scramble.length < 10) continue;
    const solution: RushSlide[] = scramble
      .slice()
      .reverse()
      .map((s) => ({ carId: s.carId, delta: -s.delta }));
    return { size: 6, cars, moves: 0, status: "playing", seed: seed | 0, solution };
  }
  // フォールバック（通常は到達しない）: 手検証済みの固定配置。
  // 解けた配置（対象車が出口）から「縦車を下へ3マス、対象車を左へ2マス」
  // 崩したものなので、solution の手順で必ず解ける。
  const cars: RushCar[] = [
    { id: 0, row: 2, col: 2, len: 2, dir: "h", target: true },
    { id: 1, row: 3, col: 3, len: 3, dir: "v", target: false },
    { id: 2, row: 0, col: 0, len: 2, dir: "h", target: false },
    { id: 3, row: 3, col: 5, len: 3, dir: "v", target: false },
    { id: 4, row: 4, col: 1, len: 2, dir: "h", target: false },
  ];
  const solution: RushSlide[] = [
    { carId: 0, delta: 2 },
    { carId: 1, delta: -3 },
  ];
  return { size: 6, cars, moves: 0, status: "playing", seed: seed | 0, solution };
}
