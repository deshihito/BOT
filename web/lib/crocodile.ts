// ワニワニ（ワニの歯を押す運試し）の純粋ロジック（UI 非依存・シード決定的）。
// 歯は13本で、そのうち1本だけが「当たり」＝口が閉じる歯（シードで決まり、状態内に隠れる）。
// プレイヤーと CPU が交互に1本ずつ押していき、当たりを押した方が負け。
// プレイヤーが安全な歯を押すと、同じ遷移の中で CPU が未押下の歯から
// シード決定的に1本を選んで押す（CPU が当たりを引けばプレイヤーの勝ち）。
// 状態は JSON 化可能な値のみ。遷移関数は状態を破壊せず新しい状態を返す。

export const CR_TEETH = 13;

export type CrStatus = "playing" | "won" | "lost";

export type CrState = {
  seed: number;
  rng: number;
  /** 当たりの歯の index（0〜CR_TEETH-1）。UI には表示しない。 */
  trap: number;
  /** 押された歯は true。 */
  pressed: boolean[];
  status: CrStatus;
  /** 直前にプレイヤーが押した歯。無ければ null。 */
  lastPlayer: number | null;
  /** 直前に CPU が押した歯。無ければ null。 */
  lastCpu: number | null;
  playerPresses: number;
  cpuPresses: number;
};

/** mulberry32（minesweeper 等と同一方式）。 */
function nextRandom(rng: number): { value: number; rng: number } {
  let t = (rng + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, rng: t | 0 };
}

export function createCrocodileGame(seed: number): CrState {
  const r = nextRandom(seed | 0);
  return {
    seed: seed | 0,
    rng: r.rng,
    trap: Math.floor(r.value * CR_TEETH),
    pressed: Array.from({ length: CR_TEETH }, () => false),
    status: "playing",
    lastPlayer: null,
    lastCpu: null,
    playerPresses: 0,
    cpuPresses: 0,
  };
}

/** まだ押されていない歯の数。 */
export function remainingTeeth(state: CrState): number {
  return state.pressed.filter((p) => !p).length;
}

/**
 * プレイヤーが歯を1本押す。
 * - 当たりなら口が閉じてプレイヤーの負け（status: "lost"）。
 * - 安全なら続けて CPU が1本押す。CPU が当たりを引けばプレイヤーの勝ち（"won"）。
 * 無効な手（終了後・範囲外・押下済み）は状態をそのまま返す。
 */
export function pressTooth(state: CrState, index: number): CrState {
  if (state.status !== "playing") return state;
  if (!Number.isInteger(index) || index < 0 || index >= CR_TEETH) return state;
  if (state.pressed[index]) return state;

  const pressed = [...state.pressed];
  pressed[index] = true;
  const afterPlayer: CrState = {
    ...state,
    pressed,
    lastPlayer: index,
    lastCpu: null,
    playerPresses: state.playerPresses + 1,
  };
  if (index === state.trap) {
    return { ...afterPlayer, status: "lost" };
  }

  // CPU の手番: 未押下の歯からシード決定的に1本選ぶ。
  const candidates: number[] = [];
  for (let i = 0; i < CR_TEETH; i++) {
    if (!pressed[i]) candidates.push(i);
  }
  if (candidates.length === 0) return afterPlayer; // 理論上は到達しない（当たりが必ず残る）
  const r = nextRandom(afterPlayer.rng);
  const cpuIndex = candidates[Math.floor(r.value * candidates.length)];
  const pressed2 = [...pressed];
  pressed2[cpuIndex] = true;
  const afterCpu: CrState = {
    ...afterPlayer,
    rng: r.rng,
    pressed: pressed2,
    lastCpu: cpuIndex,
    cpuPresses: state.cpuPresses + 1,
  };
  if (cpuIndex === state.trap) {
    return { ...afterCpu, status: "won" };
  }
  return afterCpu;
}
