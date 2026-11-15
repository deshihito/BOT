// AGO WORLD BOX のアニメーション/モーション/パーティクル基盤（純粋ロジック、DOM 非依存）。
// 描画側（WorldBoxClient）は canvas に形を描くだけで、粒の生成・寿命・物理と
// 画面の揺れ・出現ポップの計算はここに寄せてテスト可能にする。
// 方針（桜井流エフェクト原則の読み替え）:
// - 粒は寿命を短く、同時数を絞る（上限で頭打ち。重ねて無駄を出さない）。
// - 明色だけでなく暗色も混ぜ、明るい地面でも暗い地面でも見えるようにする。
// - 形ははっきり描く（chip=破片 / spark=火花 / drop=水滴 / ring=波紋 / puff=煙）。
// - 乱数はシステム内の決定的シードで持つ（同じ種からは同じ飛び方＝テスト可能）。

/** パーティクルの形。描画側はこの形だけを見て描き分ける。 */
export type FxShape = "chip" | "spark" | "drop" | "ring" | "puff" | "leaf" | "snow" | "glow";

export type FxParticle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** 経過秒。 */
  age: number;
  /** 寿命秒。age がこれに達したら消える。 */
  life: number;
  /** 1タイル=1 とした大きさ（直径相当）。 */
  size: number;
  /** 重力（タイル/秒^2、下向き正）。 */
  gravity: number;
  /** 速度の減衰率（1/秒）。 */
  drag: number;
  /** 回転角と角速度（chip/leaf の転がり）。 */
  rot: number;
  vrot: number;
  shape: FxShape;
  /** 描画色。明暗を混ぜるため配列で持ち、粒ごとに1つ選ばれている。 */
  color: string;
};

export type FxSystem = {
  particles: FxParticle[];
  /** 同時上限。これを超える生成は古い粒から間引く。 */
  cap: number;
  /** 決定的乱数の状態。 */
  rngState: number;
  /** 生成を絞る倍率（0〜1、prefers-reduced-motion 時は小さくする）。 */
  intensity: number;
};

/** 同時パーティクル上限（負荷の天井）。 */
export const FX_CAP = 260;
/** 1バーストの最大粒数（1回の行為で出す上限）。 */
export const FX_BURST_MAX = 26;

/** 決定的乱数（mulberry32 系）。0〜1 を返す。 */
export function fxRand(sys: FxSystem): number {
  sys.rngState = (sys.rngState + 0x6d2b79f5) | 0;
  let t = sys.rngState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function createFxSystem(seed = 1, cap = FX_CAP): FxSystem {
  return { particles: [], cap: Math.max(8, Math.floor(cap)), rngState: seed | 0, intensity: 1 };
}

/** 粒の残り割合（1=生まれたて、0=消滅直前）。 */
export function fxLifeRatio(p: FxParticle): number {
  if (p.life <= 0) return 0;
  const r = 1 - p.age / p.life;
  return r < 0 ? 0 : r > 1 ? 1 : r;
}

function pushParticle(sys: FxSystem, p: FxParticle): void {
  if (sys.particles.length >= sys.cap) {
    // 上限では一番古い（残り割合が小さい）粒から捨てる
    let worst = 0;
    let worstRatio = Infinity;
    for (let i = 0; i < sys.particles.length; i++) {
      const r = fxLifeRatio(sys.particles[i]);
      if (r < worstRatio) {
        worstRatio = r;
        worst = i;
      }
    }
    sys.particles.splice(worst, 1);
  }
  sys.particles.push(p);
}

/** 粒を1ステップ進める。寿命が尽きた粒は除く。 */
export function stepFx(sys: FxSystem, dt: number): void {
  if (dt <= 0) return;
  const d = Math.min(dt, 0.05);
  for (let i = sys.particles.length - 1; i >= 0; i--) {
    const p = sys.particles[i];
    p.age += d;
    if (p.age >= p.life) {
      sys.particles.splice(i, 1);
      continue;
    }
    const dragK = Math.max(0, 1 - p.drag * d);
    p.vx *= dragK;
    p.vy = p.vy * dragK + p.gravity * d;
    p.x += p.vx * d;
    p.y += p.vy * d;
    p.rot += p.vrot * d;
  }
}

// ---- バースト（行為への払い戻し） ----

export type FxBurstKind =
  | "chop" // 伐採: 木片
  | "mine" // 採掘: 石片
  | "debris" // 設置ブロック/建物の破壊: 破片
  | "till" // 耕す: 土塊
  | "plant" // 植える: 土＋若葉のきらめき
  | "harvest" // 収穫:実りのきらめき（上へ弾けて落ちる）
  | "place" // 設置: 土煙＋収まる輪
  | "build" // 建築: 木/石片＋土煙
  | "splash" // 入水/出水: 水滴
  | "step" // 足元: 小さな土ぼこり/水しぶき
  | "dash" // ダッシュ: 風の筋
  | "warp" // ワープ: 立ち上る光
  | "poof" // 消滅: 煙
  | "hit" // 被ダメージ: 赤い火花（短命）
  | "death" // 死亡: 大きめの破片と煙
  | "spawn"; // 出現: 煙と光が立ち上る

type BurstSpec = {
  count: number;
  shapes: FxShape[];
  colors: string[];
  speed: [number, number];
  /** 発射方向の中心角（ラジアン、-Math.PI/2 が上）。null は全方位。 */
  dir: number | null;
  spread: number;
  life: [number, number];
  size: [number, number];
  gravity: number;
  drag: number;
  vrot: number;
};

const BURSTS: Record<FxBurstKind, BurstSpec> = {
  chop: {
    count: 12, shapes: ["chip", "chip", "spark"],
    colors: ["#8a5a2b", "#5d3a17", "#c89b62", "#2f6121"],
    speed: [1.2, 3.4], dir: -Math.PI / 2, spread: 2.2, life: [0.3, 0.6], size: [0.06, 0.13],
    gravity: 7, drag: 1.2, vrot: 9,
  },
  mine: {
    count: 12, shapes: ["chip", "chip", "spark"],
    colors: ["#8d8d93", "#55555c", "#c9c9cf", "#3c3c42"],
    speed: [1.2, 3.6], dir: -Math.PI / 2, spread: 2.2, life: [0.3, 0.55], size: [0.05, 0.12],
    gravity: 7.5, drag: 1.2, vrot: 10,
  },
  debris: {
    count: 16, shapes: ["chip", "puff", "spark"],
    colors: ["#9a7b4f", "#6b543a", "#c9b18a", "#4c4438"],
    speed: [1.4, 4.0], dir: -Math.PI / 2, spread: 2.6, life: [0.35, 0.7], size: [0.06, 0.15],
    gravity: 7, drag: 1.4, vrot: 9,
  },
  till: {
    count: 10, shapes: ["chip", "puff"],
    colors: ["#8a5a2b", "#5d3a17", "#a9743f", "#3d2712"],
    speed: [0.8, 2.4], dir: -Math.PI / 2, spread: 2.0, life: [0.3, 0.55], size: [0.06, 0.13],
    gravity: 6.5, drag: 1.6, vrot: 7,
  },
  plant: {
    count: 9, shapes: ["spark", "chip"],
    colors: ["#69b84a", "#3e7d2c", "#cfe89a", "#8a5a2b"],
    speed: [0.6, 1.8], dir: -Math.PI / 2, spread: 2.4, life: [0.35, 0.65], size: [0.04, 0.09],
    gravity: 3.5, drag: 1.4, vrot: 5,
  },
  harvest: {
    count: 16, shapes: ["spark", "spark", "chip"],
    colors: ["#ffd23e", "#f59e0b", "#69b84a", "#fff3b0"],
    speed: [1.4, 3.8], dir: -Math.PI / 2, spread: 2.4, life: [0.4, 0.8], size: [0.04, 0.1],
    gravity: 5.5, drag: 1.1, vrot: 8,
  },
  place: {
    count: 8, shapes: ["puff", "ring"],
    colors: ["#d8cfc0", "#a89a83", "#ffffff"],
    speed: [0.5, 1.4], dir: null, spread: Math.PI * 2, life: [0.25, 0.45], size: [0.08, 0.16],
    gravity: -0.6, drag: 2.2, vrot: 0,
  },
  build: {
    count: 14, shapes: ["chip", "puff", "spark"],
    colors: ["#c89b62", "#8a5a2b", "#9aa0a6", "#5d3a17"],
    speed: [1.0, 3.0], dir: -Math.PI / 2, spread: 2.4, life: [0.35, 0.65], size: [0.05, 0.13],
    gravity: 6.5, drag: 1.4, vrot: 8,
  },
  splash: {
    count: 12, shapes: ["drop", "drop", "ring"],
    colors: ["#7cc0e8", "#3a7cb4", "#ffffff", "#bfe6ff"],
    speed: [1.0, 3.0], dir: -Math.PI / 2, spread: 1.7, life: [0.3, 0.55], size: [0.04, 0.1],
    gravity: 8, drag: 0.7, vrot: 0,
  },
  step: {
    count: 2, shapes: ["puff"],
    colors: ["#cfc4ae", "#a89a83"],
    speed: [0.2, 0.6], dir: -Math.PI / 2, spread: 2.6, life: [0.2, 0.35], size: [0.05, 0.09],
    gravity: -0.8, drag: 2.4, vrot: 0,
  },
  dash: {
    count: 3, shapes: ["spark"],
    colors: ["#ffffff", "#d8ecff"],
    speed: [0.4, 1.0], dir: null, spread: Math.PI * 2, life: [0.16, 0.28], size: [0.05, 0.1],
    gravity: 0, drag: 3.2, vrot: 0,
  },
  warp: {
    count: 20, shapes: ["glow", "spark"],
    colors: ["#b79cff", "#7c5cd6", "#ffffff", "#e6dcff"],
    speed: [0.3, 1.1], dir: -Math.PI / 2, spread: 0.9, life: [0.45, 0.9], size: [0.05, 0.12],
    gravity: -2.6, drag: 1.0, vrot: 0,
  },
  poof: {
    count: 10, shapes: ["puff"],
    colors: ["#e8e4da", "#b9b2a2", "#8d867a"],
    speed: [0.5, 1.5], dir: null, spread: Math.PI * 2, life: [0.35, 0.6], size: [0.1, 0.2],
    gravity: -1.2, drag: 2.0, vrot: 0,
  },
  hit: {
    count: 10, shapes: ["spark", "spark", "chip"],
    colors: ["#e5484d", "#ffffff", "#7a1f24", "#ffb3b8"],
    speed: [1.6, 4.2], dir: -Math.PI / 2, spread: 2.4, life: [0.18, 0.38], size: [0.04, 0.09],
    gravity: 6, drag: 1.6, vrot: 8,
  },
  death: {
    count: 22, shapes: ["chip", "puff", "chip"],
    colors: ["#c9c2b4", "#8d867a", "#5c564c", "#e8e4da"],
    speed: [1.2, 3.8], dir: null, spread: Math.PI * 2, life: [0.4, 0.85], size: [0.09, 0.22],
    gravity: 5.5, drag: 1.3, vrot: 8,
  },
  spawn: {
    count: 14, shapes: ["puff", "glow"],
    colors: ["#e6dcff", "#b79cff", "#ffffff", "#8d867a"],
    speed: [0.3, 1.2], dir: -Math.PI / 2, spread: 1.2, life: [0.4, 0.8], size: [0.08, 0.18],
    gravity: -2.2, drag: 1.2, vrot: 0,
  },
};

/** バーストの実生成（粒数・大きさ・散らばりを差し替え可能にした共通部）。 */
function emitBurst(
  sys: FxSystem,
  spec: BurstSpec,
  x: number,
  y: number,
  opts: { count: number; sizeMul?: number; scatterX?: number; scatterY?: number; dirX?: number; color?: string },
): number {
  const n = Math.max(0, Math.min(FX_BURST_MAX, Math.round(opts.count * sys.intensity)));
  const sizeMul = opts.sizeMul ?? 1;
  const scatterX = opts.scatterX ?? 0.3;
  const scatterY = opts.scatterY ?? 0.2;
  for (let i = 0; i < n; i++) {
    const baseDir = spec.dir ?? fxRand(sys) * Math.PI * 2;
    const ang = baseDir + (fxRand(sys) - 0.5) * spec.spread;
    const speed = spec.speed[0] + fxRand(sys) * (spec.speed[1] - spec.speed[0]);
    let vx = Math.cos(ang) * speed;
    const vy = Math.sin(ang) * speed;
    if (opts.dirX) vx += opts.dirX * 0.8;
    pushParticle(sys, {
      x: x + (fxRand(sys) - 0.5) * scatterX,
      y: y + (fxRand(sys) - 0.5) * scatterY,
      vx,
      vy,
      age: 0,
      life: spec.life[0] + fxRand(sys) * (spec.life[1] - spec.life[0]),
      size: (spec.size[0] + fxRand(sys) * (spec.size[1] - spec.size[0])) * sizeMul,
      gravity: spec.gravity,
      drag: spec.drag,
      rot: fxRand(sys) * Math.PI * 2,
      vrot: (fxRand(sys) - 0.5) * 2 * spec.vrot,
      shape: spec.shapes[Math.floor(fxRand(sys) * spec.shapes.length) % spec.shapes.length],
      color: opts.color ?? spec.colors[Math.floor(fxRand(sys) * spec.colors.length) % spec.colors.length],
    });
  }
  return n;
}

/**
 * 行為の払い戻しとして粒を出す。x/y はワールド座標（タイル単位）。
 * 返り値は実際に出た粒数（intensity で絞られる）。
 */
export function spawnBurst(
  sys: FxSystem,
  kind: FxBurstKind,
  x: number,
  y: number,
  opts: { dirX?: number; color?: string } = {},
): number {
  const spec = BURSTS[kind];
  return emitBurst(sys, spec, x, y, { count: spec.count, dirX: opts.dirX, color: opts.color });
}

// ---- モブ演出（出現/被ダメージ/死亡） ----

export type FxMobEvent = "spawn" | "hit" | "death";

/**
 * モブの大きさ（sizeTiles = 占有マス数 1〜20）に応じた粒数倍率。
 * 大きいモブほど多く出すが、FX_BURST_MAX の天井は別途 emitBurst が守る。
 */
export function mobCountMul(sizeTiles: number): number {
  return Math.min(2.6, 0.8 + 0.18 * sizeTiles);
}

/** モブの大きさに応じた粒サイズ倍率（最大 2.2 倍で頭打ち）。 */
export function mobSizeMul(sizeTiles: number): number {
  return Math.min(2.2, 0.85 + 0.09 * sizeTiles);
}

/**
 * モブの出現/被ダメージ/死亡の粒を出す。x/y はモブのアンカー中心（タイル単位）。
 * 粒は占有範囲いっぱいに散らし、粒数・粒サイズは大きさでスケールする。
 * sizeTiles が不正（0/NaN/負）なら 1 として扱う。返り値は出た粒数。
 */
export function spawnMobFx(
  sys: FxSystem,
  event: FxMobEvent,
  x: number,
  y: number,
  opts: { sizeTiles?: number; color?: string } = {},
): number {
  const raw = opts.sizeTiles ?? 1;
  const sizeTiles = Number.isFinite(raw) ? Math.min(20, Math.max(1, Math.floor(raw))) : 1;
  const spec = BURSTS[event];
  return emitBurst(sys, spec, x, y, {
    count: spec.count * mobCountMul(sizeTiles),
    sizeMul: mobSizeMul(sizeTiles),
    scatterX: Math.max(0.3, sizeTiles * 0.8),
    scatterY: Math.max(0.2, sizeTiles * 0.8),
    color: opts.color,
  });
}

// ---- 環境パーティクル（バイオームと時刻で決まる漂い） ----

export type FxAmbientKind = "snow" | "leaf" | "pollen" | "firefly" | "rain";

/**
 * その場所で漂う環境粒の種類。雪原は雪、森は落葉、夜は蛍、それ以外は花粉。
 * tile は実効地形 ID（mapgen の T_*）。優先順位は 雪 > 森 > 夜 > 花粉。
 */
export function ambientKindFor(tile: number, isTree: boolean, night: number): FxAmbientKind {
  // T_SNOW=6 / T_SNOW_TREE=7（mapgen の定義と一致させる。循環import回避のため数値で受ける）
  if (tile === 6 || tile === 7) return "snow";
  if (isTree) return "leaf";
  if (night > 0.45) return "firefly";
  return "pollen";
}

// ---- 天候（決定的サイクル。全員が同じ空を見る） ----

export type FxWeather = "clear" | "rain";

/** 天候1区間の長さ（秒）。昼夜サイクル（240秒）とは独立に切り替わる。 */
export const WEATHER_PERIOD_SEC = 360;

/**
 * unix 時刻からその区間の天候を決める（決定的）。
 * 区間インデックスのハッシュで決めるため、サーバーを介さず全クライアントが一致する。
 */
export function weatherAt(unixSec: number): FxWeather {
  const idx = Math.floor(unixSec / WEATHER_PERIOD_SEC);
  let h = idx | 0;
  h = Math.imul(h ^ (h >>> 15), 2246822519);
  h ^= h >>> 13;
  h = Math.imul(h, 3266489917);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296 < 0.35 ? "rain" : "clear";
}

/**
 * 天候つきの環境粒の種類。優先順位は 雪 > 雨 > 森 > 夜 > 花粉
 * （雪バイオームでは雨でなく雪が降り続ける）。
 */
export function weatherAmbientKind(weather: FxWeather, tile: number, isTree: boolean, night: number): FxAmbientKind {
  if (tile === 6 || tile === 7) return "snow";
  if (weather === "rain") return "rain";
  return ambientKindFor(tile, isTree, night);
}

// ---- 時間帯（daynight の位相の名前づけ） ----

export type FxPhaseKind = "day" | "dusk" | "night" | "dawn";

/**
 * 昼夜位相（0〜1、daynight.ts と同じ時計）の時間帯名。
 * nightAmount と整合させる: 真夜中は 0.86〜0.18、朝の移行が dawn（0.18〜0.30）、
 * 昼が day（0.30〜0.68）、夕方〜日没の移行が dusk（0.68〜0.86）。
 */
export function phaseKind(phase: number): FxPhaseKind {
  // 範囲外だけを 0〜1 へ畳む（0.18+1 の %1 で境界がずれる浮動小数誤差を避ける）
  let p = phase % 1;
  if (p < 0) p += 1;
  if (p >= 0.18 && p < 0.3) return "dawn";
  if (p >= 0.3 && p < 0.68) return "day";
  if (p >= 0.68 && p < 0.86) return "dusk";
  return "night";
}

const AMBIENT_SPEC: Record<FxAmbientKind, { colors: string[]; size: [number, number]; life: [number, number]; fall: [number, number]; sway: number }> = {
  snow: { colors: ["#ffffff", "#e8f1f7"], size: [0.03, 0.07], life: [1.6, 2.8], fall: [0.5, 0.9], sway: 0.5 },
  leaf: { colors: ["#69b84a", "#3e7d2c", "#a8c256"], size: [0.05, 0.1], life: [1.4, 2.4], fall: [0.35, 0.65], sway: 0.8 },
  pollen: { colors: ["#fff3b0", "#ffe98a"], size: [0.02, 0.045], life: [1.8, 3.0], fall: [0.06, 0.16], sway: 0.35 },
  firefly: { colors: ["#d8ffb0", "#aef29a"], size: [0.03, 0.055], life: [1.6, 2.6], fall: [-0.05, 0.05], sway: 0.6 },
  rain: { colors: ["#7cc0e8", "#a8d4f0", "#3a7cb4"], size: [0.03, 0.06], life: [0.9, 1.4], fall: [7, 10], sway: 0.4 },
};

/** 画面範囲 [x0,x1]×[y0,y1] の上辺付近に環境粒を1つ出す。 */
export function spawnAmbient(sys: FxSystem, kind: FxAmbientKind, x0: number, x1: number, y0: number): FxParticle | null {
  if (sys.intensity <= 0) return null;
  const spec = AMBIENT_SPEC[kind];
  const p: FxParticle = {
    x: x0 + fxRand(sys) * Math.max(0.1, x1 - x0),
    y: y0 - 0.3,
    vx: (fxRand(sys) - 0.5) * spec.sway,
    vy: spec.fall[0] + fxRand(sys) * (spec.fall[1] - spec.fall[0]),
    age: 0,
    life: spec.life[0] + fxRand(sys) * (spec.life[1] - spec.life[0]),
    size: spec.size[0] + fxRand(sys) * (spec.size[1] - spec.size[0]),
    gravity: 0,
    drag: 0,
    rot: fxRand(sys) * Math.PI * 2,
    vrot: (fxRand(sys) - 0.5) * 3,
    shape: kind === "snow" ? "snow" : kind === "leaf" ? "leaf" : kind === "rain" ? "spark" : "glow",
    color: spec.colors[Math.floor(fxRand(sys) * spec.colors.length) % spec.colors.length],
  };
  pushParticle(sys, p);
  return p;
}

// ---- 画面の揺れ（ヒット感） ----

export type FxShake = { amp: number; startedAt: number; durationMs: number };

export function createShake(): FxShake {
  return { amp: 0, startedAt: 0, durationMs: 0 };
}

/** 揺れを開始する。amp はピクセル。既存より弱い揺れでは上書きしない。 */
export function startShake(shake: FxShake, amp: number, nowMs: number, durationMs = 180): FxShake {
  const remain = shake.durationMs > 0 ? 1 - (nowMs - shake.startedAt) / shake.durationMs : 0;
  if (remain > 0 && shake.amp * remain >= amp) return shake;
  return { amp: Math.max(0, amp), startedAt: nowMs, durationMs: Math.max(1, durationMs) };
}

/** 時刻における揺れオフセット（px）。最初に強く、徐々に収束し、終われば 0。 */
export function shakeOffsetAt(shake: FxShake, nowMs: number): { x: number; y: number } {
  if (shake.amp <= 0 || shake.durationMs <= 0) return { x: 0, y: 0 };
  const k = (nowMs - shake.startedAt) / shake.durationMs;
  if (k < 0 || k >= 1) return { x: 0, y: 0 };
  const decay = (1 - k) * (1 - k);
  const t = nowMs / 16.7;
  return {
    x: Math.sin(t * 2.7) * shake.amp * decay,
    y: Math.cos(t * 3.4) * shake.amp * decay * 0.7,
  };
}

// ---- 出現ポップ（設置・建築の「収まった」感） ----

/** 出現の拡大率。0.55 から行き過ぎて（最大 ~1.13）1 に収まる（k は 0〜1）。 */
export function popScale(k: number): number {
  const c = k < 0 ? 0 : k > 1 ? 1 : k;
  if (c >= 1) return 1;
  // 減衰振動のバネ: 小さく生まれ、一度膨らみ過ぎてから等倍に落ち着く
  return 1 - 0.45 * Math.exp(-3.5 * c) * Math.cos(9 * c);
}

/** ポップの経過比（開始時刻と現在時刻から、長さ ms）。 */
export function popProgress(startedAt: number, nowMs: number, durationMs = 240): number {
  if (durationMs <= 0) return 1;
  const k = (nowMs - startedAt) / durationMs;
  return k < 0 ? 0 : k > 1 ? 1 : k;
}

// ---- 道具スイング（タップへの即時応答） ----

/** スイング全体の長さ（ms）。構え→振り抜き→戻り。 */
export const SWING_DURATION_MS = 230;

/** スイングの経過比（開始していなければ 1=終了）。 */
export function swingProgress(startedAt: number, nowMs: number): number {
  if (startedAt <= 0) return 1;
  const k = (nowMs - startedAt) / SWING_DURATION_MS;
  return k < 0 ? 0 : k > 1 ? 1 : k;
}

/** 空振り（行為の失敗）時の風切りの濃さ係数。成功時のスイングより薄く・細く出す。 */
export const WHIFF_ALPHA_SCALE = 0.45;

/** 風切りの弧の不透明度（振り抜きの瞬間だけ濃く、すぐ消える）。 */
export function slashAlpha(k: number): number {
  const c = k < 0 ? 0 : k > 1 ? 1 : k;
  if (c < 0.25) return c / 0.25;
  return Math.max(0, 1 - (c - 0.25) / 0.5);
}
