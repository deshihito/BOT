// クレーンゲームの純粋ロジック（UI 非依存・シード決定的）。
// 台の上をクレーンが往復する。1回目の停止で横位置、2回目の停止で奥行きを決め、
// そのまま降下して景品の中心との距離だけで掴み判定する（確率要素なし）。
// 景品ごとに大きさと重さが違い、重い景品ほど掴める範囲（grabRadius）が狭い。
// 座標は台に対する 0〜100 の正規化座標。y は奥行き（0=奥、100=手前）。

export type CranePhase = "aimX" | "aimY" | "dropping" | "done";

/** 横移動の速さ（単位/秒）。 */
export const CRANE_SPEED_X = 38;
/** 奥行き移動の速さ（単位/秒）。 */
export const CRANE_SPEED_Y = 32;
/** 降下にかかる時間（ms）。 */
export const CRANE_DROP_MS = 900;
/** 台に並ぶ景品の数。 */
export const CRANE_PRIZE_COUNT = 8;

export interface CranePrizeKind {
  emoji: string;
  name: string;
  /** 見た目の半径（0〜100 座標系）。 */
  radius: number;
  /** 重さ 1〜3。重いほど掴みにくい。 */
  weight: 1 | 2 | 3;
}

export const CRANE_PRIZE_KINDS: CranePrizeKind[] = [
  { emoji: "🧸", name: "クマのぬいぐるみ", radius: 9, weight: 2 },
  { emoji: "🐰", name: "ウサギのぬいぐるみ", radius: 8, weight: 1 },
  { emoji: "🐱", name: "ネコのぬいぐるみ", radius: 8, weight: 2 },
  { emoji: "🐼", name: "パンダのぬいぐるみ", radius: 10, weight: 3 },
  { emoji: "🍩", name: "ドーナツクッション", radius: 9, weight: 1 },
  { emoji: "⭐", name: "星のクッション", radius: 8, weight: 1 },
  { emoji: "🎁", name: "プレゼント箱", radius: 7, weight: 3 },
  { emoji: "🍰", name: "ケーキの置物", radius: 7, weight: 2 },
];

export interface CranePrize {
  id: number;
  /** CRANE_PRIZE_KINDS の添字。 */
  kind: number;
  emoji: string;
  name: string;
  x: number;
  y: number;
  radius: number;
  weight: number;
  /** この距離以内にクレーン中心があれば掴める。 */
  grabRadius: number;
}

export interface CraneResult {
  /** 取れた景品の id。取れなければ null。 */
  prizeId: number | null;
  /** 一番近い景品までの距離。 */
  dist: number;
}

export interface CraneState {
  seed: number;
  prizes: CranePrize[];
  phase: CranePhase;
  craneX: number;
  craneY: number;
  dirX: 1 | -1;
  dirY: 1 | -1;
  /** 降下の経過（ms）。dropping の間だけ進む。 */
  dropElapsedMs: number;
  /** 降下を始めた位置（結果表示用）。 */
  grabX: number | null;
  grabY: number | null;
  result: CraneResult | null;
}

/** mulberry32。 */
function nextRandom(rng: number): { value: number; rng: number } {
  let t = (rng + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, rng: t | 0 };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/** 掴める範囲。大きいほど・軽いほど広い。 */
export function grabRadiusFor(kind: CranePrizeKind): number {
  return round2(kind.radius - (kind.weight - 1) * 1.5);
}

/**
 * 指定位置で掴み判定する純関数。
 * 一番近い景品までの距離がその景品の grabRadius 以内なら成功。
 */
export function evaluateGrab(
  prizes: CranePrize[],
  x: number,
  y: number,
): CraneResult {
  let best: CranePrize | null = null;
  let bestDist = Infinity;
  for (const p of prizes) {
    const dx = x - p.x;
    const dy = y - p.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < bestDist) {
      bestDist = d;
      best = p;
    }
  }
  if (!best) return { prizeId: null, dist: Infinity };
  return {
    prizeId: bestDist <= best.grabRadius ? best.id : null,
    dist: round2(bestDist),
  };
}

/** 景品配置をシードから決定的に生成する（2列×4、位置は少しだけ揺らす）。 */
export function createCraneGame(seed: number): CraneState {
  let rng = seed | 0;
  const draw = () => {
    const r = nextRandom(rng);
    rng = r.rng;
    return r.value;
  };
  // 景品の種類をシャッフルして割り当てる。
  const kinds = CRANE_PRIZE_KINDS.map((_, i) => i);
  for (let i = kinds.length - 1; i > 0; i--) {
    const j = Math.floor(draw() * (i + 1));
    [kinds[i], kinds[j]] = [kinds[j], kinds[i]];
  }
  const slotX = [14, 38, 62, 86];
  const slotY = [32, 68];
  const prizes: CranePrize[] = [];
  for (let row = 0; row < slotY.length; row++) {
    for (let col = 0; col < slotX.length; col++) {
      const id = prizes.length;
      const kind = CRANE_PRIZE_KINDS[kinds[id]];
      const jx = (draw() - 0.5) * 8;
      const jy = (draw() - 0.5) * 8;
      prizes.push({
        id,
        kind: kinds[id],
        emoji: kind.emoji,
        name: kind.name,
        x: round2(slotX[col] + jx),
        y: round2(slotY[row] + jy),
        radius: kind.radius,
        weight: kind.weight,
        grabRadius: grabRadiusFor(kind),
      });
    }
  }
  return {
    seed,
    prizes,
    phase: "aimX",
    craneX: 0,
    craneY: 0,
    dirX: 1,
    dirY: 1,
    dropElapsedMs: 0,
    grabX: null,
    grabY: null,
    result: null,
  };
}

/** 0〜100 の範囲で反射させる。 */
function bounce(pos: number, dir: 1 | -1): { pos: number; dir: 1 | -1 } {
  if (pos > 100) return { pos: 200 - pos, dir: -1 };
  if (pos < 0) return { pos: -pos, dir: 1 };
  return { pos, dir };
}

/**
 * dtMs だけ時間を進める。aimX/aimY ではクレーンが往復し、
 * dropping では降下が進んで、終わると掴み判定して done になる。
 * done では同一参照を返す。
 */
export function stepCrane(state: CraneState, dtMs: number): CraneState {
  if (state.phase === "done") return state;
  const dt = Number.isFinite(dtMs) ? Math.min(100, Math.max(0, dtMs)) : 0;
  if (dt === 0) return state;
  if (state.phase === "aimX") {
    const moved = bounce(state.craneX + (state.dirX * CRANE_SPEED_X * dt) / 1000, state.dirX);
    return { ...state, craneX: round2(moved.pos), dirX: moved.dir };
  }
  if (state.phase === "aimY") {
    const moved = bounce(state.craneY + (state.dirY * CRANE_SPEED_Y * dt) / 1000, state.dirY);
    return { ...state, craneY: round2(moved.pos), dirY: moved.dir };
  }
  // dropping
  const dropElapsedMs = state.dropElapsedMs + dt;
  if (dropElapsedMs < CRANE_DROP_MS) {
    return { ...state, dropElapsedMs };
  }
  const result = evaluateGrab(state.prizes, state.grabX ?? state.craneX, state.grabY ?? state.craneY);
  return { ...state, dropElapsedMs: CRANE_DROP_MS, phase: "done", result };
}

/**
 * 止めるボタン。aimX → aimY（奥行き移動の開始）、aimY → dropping（降下開始）。
 * それ以外のフェーズでは同一参照を返す。
 */
export function stopCrane(state: CraneState): CraneState {
  if (state.phase === "aimX") {
    return { ...state, phase: "aimY", craneY: 0, dirY: 1 };
  }
  if (state.phase === "aimY") {
    return {
      ...state,
      phase: "dropping",
      dropElapsedMs: 0,
      grabX: state.craneX,
      grabY: state.craneY,
    };
  }
  return state;
}
