// AGO WORLD BOX の光（純粋ロジック、v2.2）。
// 光は「空からの光（位相で減衰）」と「松明の光」の2系統を別々に持ち、
// 描画と敵の出現判定が同じ値を共有する。
// - 空光: 列の上空が開けているタイルを源泉にし、遮蔽物の向こうへは
//   伝播で回り込ませる。地下深くは昼でも本当に暗くなる。
// - 松明光: 松明タイルから半径 TORCH_RADIUS で線形に減衰する。
// フィールドはタイルが変わったときだけ作り直し、位相はスカラーとして
// 後から掛ける（毎フレーム再計算しない）。
import { TORCH, isSolidBlock } from "./blocks";
import { nightAmount } from "./daynight";
import { tileIndex, type World } from "./worldgen";

/** 松明の光が届く半径（タイル）。中心が最も明るい。 */
export const TORCH_RADIUS = 5;
/** 松明の中心タイルの明るさ。 */
export const TORCH_BRIGHTNESS = 0.98;
/** これ未満の暗さでは敵が出る（出現の暗さしきい値）。 */
export const SPAWN_DARK_THRESHOLD = 0.25;
/** 夜の空光の下限係数（真夜中の地表 = 1 - 0.78 = 0.22 → 暗くて出現可）。 */
const SKY_NIGHT_CUT = 0.78;
/** 空光の伝播コスト（空気など非遮蔽セルへ入るコスト）。 */
const PROPAGATE_COST_OPEN = 0.14;
/** 空光の伝播コスト（遮蔽セルへ入るコスト: 壁の向こうは速く暗くなる）。 */
const PROPAGATE_COST_SOLID = 0.34;
/** 伝播の反復回数（回り込みの到達距離を決める）。 */
const PROPAGATE_PASSES = 10;

export type LightField = {
  /** 空光（位相1.0＝昼の満量で正規化済み）。タイル配列と同じ並び。 */
  sky: Float32Array;
  /** 松明光（位相に依らない）。 */
  torch: Float32Array;
};

/** 位相に対する空光の係数（昼=1、真夜中=0.22）。 */
export function skyLevelAt(phase: number): number {
  return 1 - nightAmount(phase) * SKY_NIGHT_CUT;
}

/** 光を遮るタイルか（固体全般。松明・空気は通す）。 */
function blocksLight(world: World, x: number, y: number): boolean {
  return isSolidBlock(world.tiles[tileIndex(world.width, x, y)]);
}

/**
 * 光フィールドを構築する。タイル変更のたびに呼び直す想定で、
 * 256×64 でも数msに収まる反復伝播に留めている。
 */
export function buildLightField(world: World): LightField {
  const { width: w, height: h } = world;
  const sky = new Float32Array(w * h);
  const torch = new Float32Array(w * h);

  // 空光の源泉: 列ごとに「上空に遮蔽物がないタイル」を 1.0 とする。
  // 地表より深い源泉（掘った縦穴の底など）は深さで少し減衰させる。
  for (let x = 0; x < w; x++) {
    const surf = world.surfaces[x];
    let blocked = false;
    for (let y = 0; y < h; y++) {
      if (!blocked) {
        const depth = y - surf;
        sky[tileIndex(w, x, y)] = depth <= 2 ? 1 : Math.max(0.35, 1 - depth * 0.04);
      }
      if (blocksLight(world, x, y)) blocked = true;
    }
  }

  // 伝播: 隣接セルから「入るセルの遮蔽度」ぶん差し引いて回り込ませる。
  for (let pass = 0; pass < PROPAGATE_PASSES; pass++) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = tileIndex(w, x, y);
        const cost = blocksLight(world, x, y) ? PROPAGATE_COST_SOLID : PROPAGATE_COST_OPEN;
        let best = sky[idx];
        if (x > 0) best = Math.max(best, sky[idx - 1] - cost);
        if (x < w - 1) best = Math.max(best, sky[idx + 1] - cost);
        if (y > 0) best = Math.max(best, sky[idx - w] - cost);
        if (y < h - 1) best = Math.max(best, sky[idx + w] - cost);
        sky[idx] = best > 0 ? best : 0;
      }
    }
  }

  // 松明光: 松明タイルを中心に半径内を線形減衰で満たす（壁は無視する単純モデル）。
  const r = TORCH_RADIUS;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (world.tiles[tileIndex(w, x, y)] !== TORCH) continue;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist > r) continue;
          const tx = x + dx;
          const ty = y + dy;
          if (tx < 0 || tx >= w || ty < 0 || ty >= h) continue;
          const v = TORCH_BRIGHTNESS * (1 - dist / (r + 1));
          const idx = tileIndex(w, tx, ty);
          if (v > torch[idx]) torch[idx] = v;
        }
      }
    }
  }

  return { sky, torch };
}

/** そのタイルの最終的な明るさ（0〜1）。範囲外は上が空、下と横は暗闇。 */
export function lightLevelAt(field: LightField, world: World, x: number, y: number, phase: number): number {
  if (y < 0) return skyLevelAt(phase);
  if (x < 0 || x >= world.width || y >= world.height) return 0;
  const idx = tileIndex(world.width, x, y);
  const v = Math.max(field.sky[idx] * skyLevelAt(phase), field.torch[idx]);
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** 敵が出られる暗さか（出現判定は描画と同じ光で決める）。 */
export function isDarkAt(field: LightField, world: World, x: number, y: number, phase: number): boolean {
  return lightLevelAt(field, world, x, y, phase) < SPAWN_DARK_THRESHOLD;
}

/** 上空に開けているか（夜明けの燃焼判定用: 空光が十分に届く場所）。 */
export function isSkyExposed(field: LightField, world: World, x: number, y: number): boolean {
  if (x < 0 || x >= world.width || y < 0 || y >= world.height) return false;
  return field.sky[tileIndex(world.width, x, y)] >= 0.55;
}
