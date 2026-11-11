// ミサイル防衛の純粋ロジック（UI 非依存・シード決定的）。
// 空から降ってくる敵ミサイルを、タップ地点に発生させる爆風で迎撃する。
// 固定ステップ（50ms）シミュレーションで、状態は JSON 化可能な値のみ。
// 乱数は mulberry32 の状態（数値）を state に持ち回るため、
// 同じシード＋同じ操作列では完全に同じ展開を再現できる。

export const MISSILE_STEP_MS = 50;
export const FIELD_W = 1000;
export const FIELD_H = 600;
/** 地面の y 座標（この高さに都市と基地が並ぶ）。 */
export const GROUND_Y = 560;
/** 爆風の最大半径。 */
export const BLAST_MAX_RADIUS = 62;
/** 爆風の寿命（ステップ数）: 成長6＋持続8＋縮小6 = 20ステップ（1秒）。 */
export const BLAST_TOTAL_STEPS = 20;
/** ウェーブごとに各基地へ補充される迎撃弾。 */
export const AMMO_PER_WAVE = 10;
/** 敵ミサイル1発を破壊したときの得点。 */
export const SCORE_PER_KILL = 25;
/** ウェーブクリアボーナス: 都市1つ / 基地1つ。 */
export const BONUS_PER_CITY = 100;
export const BONUS_PER_BASE = 50;
/** ウェーブクリア表示のステップ数（2秒）。 */
export const WAVE_CLEAR_STEPS = 40;

export type StructureKind = "base" | "city";

export type Structure = {
  kind: StructureKind;
  x: number;
  alive: boolean;
};

export type EnemyMissile = {
  id: number;
  sx: number;
  sy: number;
  tx: number;
  ty: number;
  /** 着弾予定の構造物の index。すでに破壊済みなら地面に落ちる。 */
  targetIndex: number;
  elapsedMs: number;
  durationMs: number;
  /** 分裂する割合（0〜1）。null なら分裂しない。 */
  splitAt: number | null;
  splitDone: boolean;
};

export type Interceptor = {
  sx: number;
  sy: number;
  tx: number;
  ty: number;
  elapsedMs: number;
  durationMs: number;
};

export type Blast = {
  x: number;
  y: number;
  ageSteps: number;
};

export type SpawnItem = {
  atStep: number;
  sx: number;
  targetIndex: number;
  durationMs: number;
  splitAt: number | null;
};

export type MissilePhase = "playing" | "waveclear" | "over";

export type MissileState = {
  phase: MissilePhase;
  wave: number;
  score: number;
  structures: Structure[];
  /** 基地（structures の base の順）ごとの残弾。 */
  ammo: number[];
  enemies: EnemyMissile[];
  interceptors: Interceptor[];
  blasts: Blast[];
  spawnQueue: SpawnItem[];
  stepInWave: number;
  waveClearSteps: number;
  nextId: number;
  kills: number;
  seed: number;
  rng: number;
};

/** 基地と都市の配置（x 座標）。基地3・都市6。 */
export const BASE_XS = [70, 500, 930];
export const CITY_XS = [185, 295, 405, 595, 705, 815];

/** mulberry32。状態を数値で持ち回り、決定的に再現できるようにする。 */
function nextRandom(rng: number): { value: number; rng: number } {
  let t = (rng + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, rng: t | 0 };
}

function buildStructures(): Structure[] {
  const out: Structure[] = [];
  const all: { kind: StructureKind; x: number }[] = [
    ...BASE_XS.map((x) => ({ kind: "base" as StructureKind, x })),
    ...CITY_XS.map((x) => ({ kind: "city" as StructureKind, x })),
  ];
  all.sort((a, b) => a.x - b.x);
  return all.map((s) => ({ ...s, alive: true }));
}

/** ウェーブのスポーン計画を決定的に生成する。 */
function planWave(
  wave: number,
  rng: number,
  structures: Structure[],
): { queue: SpawnItem[]; rng: number } {
  let r = rng;
  const draw = () => {
    const n = nextRandom(r);
    r = n.rng;
    return n.value;
  };
  const aliveIndexes = structures
    .map((s, i) => (s.alive ? i : -1))
    .filter((i) => i >= 0);
  const count = 6 + wave * 2;
  const baseDuration = Math.max(4500, 10500 - wave * 650);
  const intervalMs = Math.max(420, 950 - wave * 55);
  const queue: SpawnItem[] = [];
  for (let i = 0; i < count; i++) {
    const targetIndex =
      aliveIndexes.length > 0
        ? aliveIndexes[Math.floor(draw() * aliveIndexes.length)]
        : Math.floor(draw() * structures.length);
    const durationMs = Math.round(baseDuration * (0.85 + draw() * 0.35));
    const splitAt =
      wave >= 2 && draw() < 0.28 ? 0.35 + draw() * 0.25 : null;
    queue.push({
      atStep: Math.round(((i * intervalMs + draw() * 300) / MISSILE_STEP_MS)),
      sx: Math.round(40 + draw() * (FIELD_W - 80)),
      targetIndex,
      durationMs,
      splitAt,
    });
  }
  queue.sort((a, b) => a.atStep - b.atStep);
  return { queue, rng: r };
}

export function createMissileGame(seed: number): MissileState {
  const structures = buildStructures();
  const { queue, rng } = planWave(1, seed | 0, structures);
  return {
    phase: "playing",
    wave: 1,
    score: 0,
    structures,
    ammo: BASE_XS.map(() => AMMO_PER_WAVE),
    enemies: [],
    interceptors: [],
    blasts: [],
    spawnQueue: queue,
    stepInWave: 0,
    waveClearSteps: 0,
    nextId: 1,
    kills: 0,
    seed: seed | 0,
    rng,
  };
}

/** 爆風の現在半径（ステップ齢から決定的に決まる）。 */
export function blastRadius(ageSteps: number): number {
  if (ageSteps <= 0) return 0;
  if (ageSteps <= 6) return 8 + (BLAST_MAX_RADIUS - 8) * (ageSteps / 6);
  if (ageSteps <= 14) return BLAST_MAX_RADIUS;
  if (ageSteps >= BLAST_TOTAL_STEPS) return 0;
  return BLAST_MAX_RADIUS * (1 - (ageSteps - 14) / 6);
}

/** 敵ミサイルの現在位置。 */
export function enemyPosition(m: EnemyMissile): { x: number; y: number } {
  const t = Math.min(1, Math.max(0, m.elapsedMs / m.durationMs));
  return { x: m.sx + (m.tx - m.sx) * t, y: m.sy + (m.ty - m.sy) * t };
}

/** 迎撃ミサイルの現在位置。 */
export function interceptorPosition(m: Interceptor): { x: number; y: number } {
  const t = Math.min(1, Math.max(0, m.elapsedMs / m.durationMs));
  return { x: m.sx + (m.tx - m.sx) * t, y: m.sy + (m.ty - m.sy) * t };
}

export function aliveCities(state: MissileState): number {
  return state.structures.filter((s) => s.kind === "city" && s.alive).length;
}

export function aliveBases(state: MissileState): number {
  return state.structures.filter((s) => s.kind === "base" && s.alive).length;
}

export function totalAmmo(state: MissileState): number {
  return state.ammo.reduce((a, b) => a + b, 0);
}

/**
 * 指定地点へ迎撃弾を撃つ。最も近い、残弾のある生存基地から発射する。
 * 撃てない場合（終了済み・基地なし・残弾なし）は状態を変えない。
 */
export function fireAt(state: MissileState, x: number, y: number): MissileState {
  if (state.phase !== "playing") return state;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return state;
  const tx = Math.min(FIELD_W, Math.max(0, x));
  const ty = Math.min(GROUND_Y - 30, Math.max(30, y));
  const bases = state.structures
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => s.kind === "base" && s.alive);
  let best: { index: number; baseOrder: number; dist: number } | null = null;
  let order = -1;
  for (const { s, i } of bases) {
    order = state.structures.slice(0, i + 1).filter((v) => v.kind === "base").length - 1;
    if ((state.ammo[order] ?? 0) <= 0) continue;
    const dist = Math.abs(s.x - tx);
    if (!best || dist < best.dist) best = { index: i, baseOrder: order, dist };
  }
  if (!best) return state;
  const base = state.structures[best.index];
  const dist = Math.hypot(tx - base.x, ty - (GROUND_Y - 12));
  const durationMs = Math.max(110, Math.round((dist / 1500) * 1000));
  const ammo = [...state.ammo];
  ammo[best.baseOrder] -= 1;
  return {
    ...state,
    ammo,
    interceptors: [
      ...state.interceptors,
      { sx: base.x, sy: GROUND_Y - 12, tx, ty, elapsedMs: 0, durationMs },
    ],
  };
}

/** 1ステップ（50ms）進める。 */
export function stepMissile(state: MissileState): MissileState {
  if (state.phase === "over") return state;

  if (state.phase === "waveclear") {
    const steps = state.waveClearSteps + 1;
    if (steps < WAVE_CLEAR_STEPS) return { ...state, waveClearSteps: steps };
    const wave = state.wave + 1;
    const { queue, rng } = planWave(wave, state.rng, state.structures);
    return {
      ...state,
      phase: "playing",
      wave,
      ammo: BASE_XS.map(() => AMMO_PER_WAVE),
      spawnQueue: queue,
      stepInWave: 0,
      waveClearSteps: 0,
      rng,
    };
  }

  let rng = state.rng;
  const draw = () => {
    const n = nextRandom(rng);
    rng = n.rng;
    return n.value;
  };

  const stepInWave = state.stepInWave + 1;
  const structures = state.structures.map((s) => ({ ...s }));
  let enemies = state.enemies.map((m) => ({ ...m }));
  let nextId = state.nextId;
  let score = state.score;
  let kills = state.kills;

  // スポーン
  const due = state.spawnQueue.filter((q) => q.atStep <= stepInWave);
  const rest = state.spawnQueue.filter((q) => q.atStep > stepInWave);
  for (const q of due) {
    const target = structures[q.targetIndex] ?? structures[0];
    enemies.push({
      id: nextId++,
      sx: q.sx,
      sy: 0,
      tx: target.x,
      ty: GROUND_Y,
      targetIndex: q.targetIndex,
      elapsedMs: 0,
      durationMs: q.durationMs,
      splitAt: q.splitAt,
      splitDone: false,
    });
  }

  // 爆風を先に進める（このステップの判定に使う）
  const blasts = state.blasts
    .map((b) => ({ ...b, ageSteps: b.ageSteps + 1 }))
    .filter((b) => b.ageSteps < BLAST_TOTAL_STEPS);

  // 迎撃弾の移動と着弾
  const interceptors: Interceptor[] = [];
  const newBlasts: Blast[] = [];
  for (const it of state.interceptors) {
    const moved = { ...it, elapsedMs: it.elapsedMs + MISSILE_STEP_MS };
    if (moved.elapsedMs >= moved.durationMs) {
      newBlasts.push({ x: moved.tx, y: moved.ty, ageSteps: 1 });
    } else {
      interceptors.push(moved);
    }
  }
  const allBlasts = [...blasts, ...newBlasts];

  // 敵ミサイルの移動・分裂・被弾・着弾
  const survivors: EnemyMissile[] = [];
  for (const m of enemies) {
    const moved = { ...m, elapsedMs: m.elapsedMs + MISSILE_STEP_MS };
    const pos = enemyPosition(moved);

    // 爆風に巻き込まれたら破壊
    const hit = allBlasts.some((b) => {
      const r = blastRadius(b.ageSteps);
      return r > 0 && Math.hypot(pos.x - b.x, pos.y - b.y) <= r;
    });
    if (hit) {
      score += SCORE_PER_KILL;
      kills += 1;
      continue;
    }

    // 着弾
    if (moved.elapsedMs >= moved.durationMs) {
      const target = structures[moved.targetIndex];
      if (target && target.alive && Math.abs(target.x - moved.tx) < 1) {
        target.alive = false;
      }
      continue;
    }

    // 分裂（ウェーブ2以降の一部）
    if (
      moved.splitAt !== null &&
      !moved.splitDone &&
      moved.elapsedMs / moved.durationMs >= moved.splitAt
    ) {
      moved.splitDone = true;
      const speed =
        Math.hypot(moved.tx - moved.sx, moved.ty - moved.sy) /
        (moved.durationMs / 1000);
      const targets = structures
        .map((s, i) => (s.alive ? i : -1))
        .filter((i) => i >= 0);
      const childCount = 2;
      for (let c = 0; c < childCount; c++) {
        const ti =
          targets.length > 0
            ? targets[Math.floor(draw() * targets.length)]
            : moved.targetIndex;
        const t = structures[ti] ?? structures[moved.targetIndex];
        const dist = Math.hypot(t.x - pos.x, GROUND_Y - pos.y);
        survivors.push({
          id: nextId++,
          sx: pos.x,
          sy: pos.y,
          tx: t.x,
          ty: GROUND_Y,
          targetIndex: ti,
          elapsedMs: 0,
          durationMs: Math.max(400, Math.round((dist / Math.max(1, speed)) * 1000)),
          splitAt: null,
          splitDone: true,
        });
      }
      continue;
    }

    survivors.push(moved);
  }
  enemies = survivors;

  const citiesAlive = structures.filter(
    (s) => s.kind === "city" && s.alive,
  ).length;

  // 都市が全滅したら終了
  if (citiesAlive === 0) {
    return {
      ...state,
      phase: "over",
      structures,
      enemies,
      interceptors,
      blasts: allBlasts,
      spawnQueue: rest,
      stepInWave,
      score,
      kills,
      nextId,
      rng,
    };
  }

  // ウェーブ終了判定
  if (
    rest.length === 0 &&
    enemies.length === 0 &&
    interceptors.length === 0
  ) {
    const bonus =
      citiesAlive * BONUS_PER_CITY +
      structures.filter((s) => s.kind === "base" && s.alive).length *
        BONUS_PER_BASE;
    return {
      ...state,
      phase: "waveclear",
      structures,
      enemies,
      interceptors,
      blasts: allBlasts,
      spawnQueue: rest,
      stepInWave,
      waveClearSteps: 0,
      score: score + bonus,
      kills,
      nextId,
      rng,
    };
  }

  return {
    ...state,
    structures,
    enemies,
    interceptors,
    blasts: allBlasts,
    spawnQueue: rest,
    stepInWave,
    score,
    kills,
    nextId,
    rng,
  };
}
