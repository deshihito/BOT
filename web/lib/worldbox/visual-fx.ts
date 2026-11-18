// AGO WORLD BOX の視覚効果・演出強化ロジック（純粋関数・DOM 非依存）。
// - フローティング数値（ダメージ/回復/クリティカル/状態変化/拾得）
// - 残像（ダッシュ/敵突進/テレポート）
// - 武器・道具種別ごとの斬撃カラー＆トレイル設定
// - 技エフェクトの枝分かれ稲妻・流星・氷槍の補助計算＋専用粒エミッタ
// - モブの状態・予兆色・影スケール・震え・HP残像アニメーション
// - 時間帯（朝焼け/夕焼け/雨天）と光源（松明/ランプ/焚き火/溶岩）の暖色ブルーム
import {
  emitFxParticle,
  fxRand,
  hash01,
  phaseKind,
  type FxSystem,
} from "./fx";
import type { MobPatternId } from "./mob-behavior";

// ---------------------------------------------------------------------------
// 1. フローティング数値・テキスト（ダメージ / 回復 / 状態異常）
// ---------------------------------------------------------------------------

export type FloatingTextKind = "damage" | "crit" | "player_hurt" | "heal" | "status" | "pickup";

export type FloatingText = {
  id: number;
  x: number;
  y: number;
  text: string;
  kind: FloatingTextKind;
  createdAt: number;
  durationMs: number;
  vx: number;
  scale: number;
};

export type FloatingTextSystem = {
  items: FloatingText[];
  nextId: number;
  cap: number;
};

export const FLOATING_TEXT_CAP = 28;

export function createFloatingTextSystem(cap = FLOATING_TEXT_CAP): FloatingTextSystem {
  return { items: [], nextId: 1, cap: Math.max(4, Math.floor(cap)) };
}

export function spawnFloatingText(
  sys: FloatingTextSystem,
  opts: {
    x: number;
    y: number;
    text: string;
    kind: FloatingTextKind;
    nowMs: number;
    durationMs?: number;
    scale?: number;
  },
): FloatingText {
  const jitter = ((sys.nextId * 37) % 11 - 5) * 0.08;
  const item: FloatingText = {
    id: sys.nextId++,
    x: opts.x + jitter * 0.6,
    y: opts.y,
    text: opts.text,
    kind: opts.kind,
    createdAt: opts.nowMs,
    durationMs: opts.durationMs ?? (opts.kind === "crit" ? 1050 : opts.kind === "status" ? 950 : 820),
    vx: jitter * 0.45,
    scale: opts.scale ?? (opts.kind === "crit" ? 1.28 : opts.kind === "status" ? 1.05 : 1),
  };
  if (sys.items.length >= sys.cap) sys.items.shift();
  sys.items.push(item);
  return item;
}

export function stepFloatingTexts(sys: FloatingTextSystem, nowMs: number): void {
  for (let i = sys.items.length - 1; i >= 0; i--) {
    if (nowMs - sys.items[i].createdAt >= sys.items[i].durationMs) {
      sys.items.splice(i, 1);
    }
  }
}

/** 時刻における浮遊文字の座標オフセット（タイル単位）・拡大率・不透明度。 */
export function floatingTextPose(
  item: FloatingText,
  nowMs: number,
  reducedMotion = false,
): { dx: number; dy: number; scale: number; alpha: number } {
  const elapsed = Math.max(0, nowMs - item.createdAt);
  const k = Math.min(1, elapsed / Math.max(1, item.durationMs));
  // 序盤で素早く上へ弾け、後半は減速して消える
  const rise = 1 - Math.pow(1 - k, 2.3);
  const dy = -(0.25 + rise * (item.kind === "crit" ? 1.05 : 0.85));
  const dx = reducedMotion ? 0 : item.vx * k;
  // 出現直後のポップ拡大（0..0.18）
  const pop = k < 0.18 ? 0.65 + (k / 0.18) * 0.55 : k < 0.32 ? 1.2 - ((k - 0.18) / 0.14) * 0.2 : 1;
  const alpha = k < 0.65 ? 1 : Math.max(0, 1 - (k - 0.65) / 0.35);
  return { dx, dy, scale: item.scale * (reducedMotion ? 1 : pop), alpha };
}

export function floatingTextColors(kind: FloatingTextKind): { fill: string; stroke: string } {
  switch (kind) {
    case "crit":
      return { fill: "#ffd74a", stroke: "#5c1408" };
    case "player_hurt":
      return { fill: "#ff6b6b", stroke: "#3a0a10" };
    case "heal":
      return { fill: "#7ef28a", stroke: "#0c3518" };
    case "status":
      return { fill: "#9fe8ff", stroke: "#0e2240" };
    case "pickup":
      return { fill: "#ffe8a3", stroke: "#281e0a" };
    default:
      return { fill: "#ffffff", stroke: "#181a24" };
  }
}

// ---------------------------------------------------------------------------
// 2. 残像システム（プレイヤーダッシュ・モブ突進/転移）
// ---------------------------------------------------------------------------

export type AfterimageKind = "player_dash" | "mob_dash" | "mob_teleport";

export type Afterimage = {
  x: number;
  y: number;
  face: 1 | -1;
  sizeTiles: number;
  mobId: string | null;
  kind: AfterimageKind;
  color: string;
  createdAt: number;
  durationMs: number;
};

export const AFTERIMAGE_CAP = 32;

export function pushAfterimage(list: Afterimage[], item: Afterimage, cap = AFTERIMAGE_CAP): void {
  if (list.length >= cap) list.shift();
  list.push(item);
}

export function pruneAfterimages(list: Afterimage[], nowMs: number): void {
  for (let i = list.length - 1; i >= 0; i--) {
    if (nowMs - list[i].createdAt >= list[i].durationMs) {
      list.splice(i, 1);
    }
  }
}

export function afterimageAlpha(item: Afterimage, nowMs: number): number {
  const k = Math.max(0, Math.min(1, (nowMs - item.createdAt) / Math.max(1, item.durationMs)));
  return (1 - k) * (item.kind === "mob_teleport" ? 0.55 : 0.38);
}

// ---------------------------------------------------------------------------
// 3. 武器・道具の斬撃スタイル（素材ごとに色と迫力を変える）
// ---------------------------------------------------------------------------

export type SwingVisualStyle = {
  primary: string;
  glow: string;
  core: string;
  widthMul: number;
  radiusMul: number;
  hasGlint: boolean;
};

export function swingStyleFor(itemId: string | null | undefined, whiff: boolean): SwingVisualStyle {
  if (whiff || !itemId) {
    return {
      primary: "rgba(255,255,255,0.65)",
      glow: "rgba(210,225,245,0.22)",
      core: "#ffffff",
      widthMul: whiff ? 0.65 : 0.9,
      radiusMul: 0.92,
      hasGlint: false,
    };
  }
  if (itemId.includes("mithril")) {
    return {
      primary: "#7fefff",
      glow: "rgba(110,235,255,0.45)",
      core: "#ffffff",
      widthMul: 1.45,
      radiusMul: 1.15,
      hasGlint: true,
    };
  }
  if (itemId.includes("gold")) {
    return {
      primary: "#ffd84d",
      glow: "rgba(255,195,55,0.42)",
      core: "#fff9d6",
      widthMul: 1.25,
      radiusMul: 1.08,
      hasGlint: true,
    };
  }
  if (itemId.includes("iron")) {
    return {
      primary: "#dbe9ff",
      glow: "rgba(155,195,255,0.36)",
      core: "#ffffff",
      widthMul: 1.18,
      radiusMul: 1.05,
      hasGlint: true,
    };
  }
  if (itemId.includes("stone") || itemId.includes("wood")) {
    return {
      primary: "#f3eee2",
      glow: "rgba(220,210,190,0.28)",
      core: "#ffffff",
      widthMul: 1.0,
      radiusMul: 1.0,
      hasGlint: false,
    };
  }
  return {
    primary: "#f0f6ff",
    glow: "rgba(200,225,255,0.28)",
    core: "#ffffff",
    widthMul: 1.0,
    radiusMul: 0.98,
    hasGlint: false,
  };
}

// ---------------------------------------------------------------------------
// 4. 枝分かれ稲妻・モブ予兆カラー・モブ動き補助
// ---------------------------------------------------------------------------

/** 落雷の枝分かれポリライン群（決定的生成）。メインボルトの中継点から左右へ分岐する。 */
export function thunderBranches(
  seed: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): { x: number; y: number }[][] {
  const branches: { x: number; y: number }[][] = [];
  const count = 3;
  for (let b = 0; b < count; b++) {
    const startT = 0.22 + b * 0.24;
    const sx = x0 + (x1 - x0) * startT + (hash01(seed * 19 + b * 41) - 0.5) * 0.28;
    const sy = y0 + (y1 - y0) * startT;
    const side = (b % 2 === 0 ? 1 : -1) * (hash01(seed * 7 + b * 13) > 0.25 ? 1 : -1);
    const lenX = side * (0.45 + hash01(seed * 53 + b * 29) * 0.55);
    const lenY = 0.65 + hash01(seed * 67 + b * 31) * 0.6;
    const midX = sx + lenX * 0.55 + (hash01(seed * 83 + b * 11) - 0.5) * 0.24;
    const midY = sy + lenY * 0.45;
    branches.push([
      { x: sx, y: sy },
      { x: midX, y: midY },
      { x: sx + lenX, y: sy + lenY },
    ]);
  }
  return branches;
}

export type TelegraphTint = {
  fillRgb: string;
  strokeRgb: string;
  accentHex: string;
};

/** パターン種別に応じた予兆色（炎・氷・毒・物理で直感的に識別できる）。 */
export function telegraphTintFor(pattern: MobPatternId): TelegraphTint {
  switch (pattern) {
    case "breath_cone":
      return { fillRgb: "255,112,42", strokeRgb: "255,176,72", accentHex: "#ff9442" };
    case "gust":
    case "shard_burst":
      return { fillRgb: "88,196,255", strokeRgb: "165,232,255", accentHex: "#7fe0ff" };
    case "web_shot":
    case "phase_strike":
      return { fillRgb: "184,116,255", strokeRgb: "224,180,255", accentHex: "#c99bff" };
    case "root_strike":
    case "leaf_burst":
      return { fillRgb: "110,208,92", strokeRgb: "178,242,140", accentHex: "#8be068" };
    default:
      return { fillRgb: "255,64,44", strokeRgb: "255,120,88", accentHex: "#ff5c44" };
  }
}

/** 跳躍・飛行高度（bob）に応じて足元影を縮め、宙に浮いた立体感を作る（0.48〜1.0）。 */
export function mobShadowScale(bobTiles: number): number {
  return Math.max(0.48, Math.min(1, 1 - Math.max(0, bobTiles) * 2.1));
}

/** 予兆（windup）後半の震え（タイル単位）。reducedMotion 時は 0。 */
export function telegraphTremble(frac: number, nowMs: number, reducedMotion: boolean): number {
  if (reducedMotion || frac <= 0.45) return 0;
  const k = Math.min(1, (frac - 0.45) / 0.55);
  return Math.sin(nowMs * 0.09) * 0.045 * k;
}

/** 待機中の微かな呼吸（scaleY 倍率、0.98〜1.02）。 */
export function idleBreathScaleY(nowMs: number, phaseOffset = 0): number {
  return 1 + Math.sin(nowMs * 0.0032 + phaseOffset) * 0.018;
}

// ---------------------------------------------------------------------------
// 5. 時間帯・天候の色味と設置光源の暖色ブルーム
// ---------------------------------------------------------------------------

/** 昼夜位相と雨の強さに応じた空の薄い大気ティント（真昼・晴れは null）。 */
export function atmosphereTintFor(
  phase: number,
  rainStrength: number,
): { rgb: string; alpha: number } | null {
  const pk = phaseKind(phase);
  if (rainStrength > 0.15 && pk === "day") {
    return { rgb: "42,66,102", alpha: Math.min(0.14, rainStrength * 0.14) };
  }
  if (pk === "dawn") {
    // phase 0.18..0.30 の中心 0.24 で山を作る
    const d = 1 - Math.abs((phase - 0.24) / 0.06);
    const k = Math.max(0, Math.min(1, d));
    if (k <= 0.02) return null;
    return { rgb: "255,156,120", alpha: +(0.11 * k).toFixed(3) };
  }
  if (pk === "dusk") {
    // phase 0.68..0.86 の中心 0.77 で山を作る
    const d = 1 - Math.abs((phase - 0.77) / 0.09);
    const k = Math.max(0, Math.min(1, d));
    if (k <= 0.02) return null;
    return { rgb: "255,126,64", alpha: +(0.14 * k).toFixed(3) };
  }
  return null;
}

export type PlacedGlowSpec = {
  rgb: string;
  coreRgb: string;
  strength: number;
};

/** 光源ブロック/道具の種類に応じた暖色/魔力色のブルーム定義。 */
export function placedLightGlowColor(itemId: string | null | undefined): PlacedGlowSpec | null {
  if (!itemId) return null;
  switch (itemId) {
    case "torch":
      return { rgb: "255,152,64", coreRgb: "255,222,145", strength: 0.28 };
    case "campfire":
      return { rgb: "255,124,48", coreRgb: "255,204,112", strength: 0.34 };
    case "lamp":
      return { rgb: "255,208,118", coreRgb: "255,244,200", strength: 0.26 };
    case "glowstone_block":
      return { rgb: "255,232,148", coreRgb: "255,250,210", strength: 0.24 };
    case "lava_block":
    case "magma_block":
      return { rgb: "255,78,28", coreRgb: "255,168,72", strength: 0.32 };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// 6. スキル・属性用の追加パーティクルエミッタ
// ---------------------------------------------------------------------------

function emitN(
  sys: FxSystem,
  baseCount: number,
  build: (i: number) => Parameters<typeof emitFxParticle>[1],
): number {
  const n = Math.max(0, Math.round(baseCount * sys.intensity));
  let emitted = 0;
  for (let i = 0; i < n; i++) {
    if (emitFxParticle(sys, build(i))) emitted++;
  }
  return emitted;
}

/** 炎の尾・爆発の残り火（fireball / meteor 用）。 */
export function spawnFireTrailFx(sys: FxSystem, x: number, y: number, count = 4): number {
  const colors = ["#ff9a3c", "#ffd23e", "#ff5a2a", "#fff2a6"];
  return emitN(sys, count, (i) => {
    const ang = fxRand(sys) * Math.PI * 2;
    const spd = 0.4 + fxRand(sys) * 1.4;
    return {
      x: x + (fxRand(sys) - 0.5) * 0.25,
      y: y + (fxRand(sys) - 0.5) * 0.25,
      vx: Math.cos(ang) * spd,
      vy: Math.sin(ang) * spd - 0.8,
      age: 0,
      life: 0.24 + fxRand(sys) * 0.26,
      size: 0.05 + fxRand(sys) * 0.07,
      gravity: -2.0,
      drag: 1.8,
      rot: fxRand(sys) * Math.PI * 2,
      vrot: 4,
      shape: i % 3 === 0 ? "puff" : "glow",
      color: colors[Math.floor(fxRand(sys) * colors.length) % colors.length],
    };
  });
}

/** 氷晶の飛散（ice_lance / 凍結解除 / 氷攻撃）。 */
export function spawnIceShatterFx(sys: FxSystem, x: number, y: number, count = 14): number {
  const colors = ["#e8fbff", "#9ce4ff", "#4eb8f0", "#ffffff"];
  return emitN(sys, count, (i) => {
    const ang = (i / Math.max(1, count)) * Math.PI * 2 + (fxRand(sys) - 0.5) * 0.4;
    const spd = 1.4 + fxRand(sys) * 2.8;
    return {
      x: x + (fxRand(sys) - 0.5) * 0.2,
      y: y + (fxRand(sys) - 0.5) * 0.2,
      vx: Math.cos(ang) * spd,
      vy: Math.sin(ang) * spd - 0.9,
      age: 0,
      life: 0.35 + fxRand(sys) * 0.35,
      size: 0.06 + fxRand(sys) * 0.08,
      gravity: 4.5,
      drag: 1.5,
      rot: fxRand(sys) * Math.PI * 2,
      vrot: (fxRand(sys) - 0.5) * 14,
      shape: i % 4 === 0 ? "glow" : "chip",
      color: colors[Math.floor(fxRand(sys) * colors.length) % colors.length],
    };
  });
}

/** 雷撃の電光スパーク（thunder_strike 用）。 */
export function spawnElectricSparkFx(sys: FxSystem, x: number, y: number, count = 16): number {
  const colors = ["#ffffff", "#aef2ff", "#ffe96b", "#5ecbff"];
  return emitN(sys, count, (i) => {
    const ang = fxRand(sys) * Math.PI * 2;
    const spd = 2.2 + fxRand(sys) * 3.8;
    return {
      x,
      y,
      vx: Math.cos(ang) * spd,
      vy: Math.sin(ang) * spd - 0.4,
      age: 0,
      life: 0.2 + fxRand(sys) * 0.25,
      size: 0.06 + fxRand(sys) * 0.07,
      gravity: 1.5,
      drag: 2.2,
      rot: ang,
      vrot: 0,
      shape: i % 5 === 0 ? "glow" : "spark",
      color: colors[Math.floor(fxRand(sys) * colors.length) % colors.length],
    };
  });
}

/** 回復の光の粒（heal_zone / 食事・回復用）。 */
export function spawnHealMoteFx(sys: FxSystem, x: number, y: number, count = 10): number {
  const colors = ["#8ef596", "#c4ffad", "#fff29a", "#ffffff"];
  return emitN(sys, count, () => ({
    x: x + (fxRand(sys) - 0.5) * 1.4,
    y: y + (fxRand(sys) - 0.5) * 0.6,
    vx: (fxRand(sys) - 0.5) * 0.4,
    vy: -(0.8 + fxRand(sys) * 1.1),
    age: 0,
    life: 0.55 + fxRand(sys) * 0.45,
    size: 0.05 + fxRand(sys) * 0.07,
    gravity: -0.9,
    drag: 0.8,
    rot: 0,
    vrot: 0,
    shape: "glow",
    color: colors[Math.floor(fxRand(sys) * colors.length) % colors.length],
  }));
}

/** 毒霧の泡（poison_field 用）。 */
export function spawnPoisonBubbleFx(sys: FxSystem, x: number, y: number, count = 10): number {
  const colors = ["#9be15d", "#6dc043", "#b87cff", "#d7f989"];
  return emitN(sys, count, (i) => ({
    x: x + (fxRand(sys) - 0.5) * 2.4,
    y: y + (fxRand(sys) - 0.5) * 1.1,
    vx: (fxRand(sys) - 0.5) * 0.5,
    vy: -(0.5 + fxRand(sys) * 0.8),
    age: 0,
    life: 0.5 + fxRand(sys) * 0.5,
    size: 0.06 + fxRand(sys) * 0.09,
    gravity: -0.5,
    drag: 1.2,
    rot: 0,
    vrot: 0,
    shape: i % 3 === 0 ? "puff" : "drop",
    color: colors[Math.floor(fxRand(sys) * colors.length) % colors.length],
  }));
}

/** 強打・着地の砂煙リング（slam / rock_throw 着弾 / ジャンプ着地用）。 */
export function spawnSlamDustFx(sys: FxSystem, x: number, y: number, radiusTiles = 1.2): number {
  const colors = ["#d8cfc0", "#a89a83", "#8d867a", "#efe7d8"];
  return emitN(sys, 10, (i) => {
    const ang = (i / 10) * Math.PI * 2 + (fxRand(sys) - 0.5) * 0.3;
    const spd = (1.2 + fxRand(sys) * 1.8) * Math.max(0.7, Math.min(2, radiusTiles * 0.65));
    return {
      x: x + Math.cos(ang) * 0.25,
      y: y + Math.sin(ang) * 0.12,
      vx: Math.cos(ang) * spd,
      vy: Math.sin(ang) * spd * 0.45 - 0.4,
      age: 0,
      life: 0.35 + fxRand(sys) * 0.3,
      size: 0.08 + fxRand(sys) * 0.09,
      gravity: 1.8,
      drag: 2.6,
      rot: fxRand(sys) * Math.PI * 2,
      vrot: (fxRand(sys) - 0.5) * 6,
      shape: i === 0 ? "ring" : "puff",
      color: colors[Math.floor(fxRand(sys) * colors.length) % colors.length],
    };
  });
}
