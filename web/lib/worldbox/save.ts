// AGO WORLD BOX のプレイヤーセーブ変換（純粋ロジック）。
// localStorage / サーバー（bot_kv）の読み書き自体は呼び出し側で行い、ここは
// 「状態 ⇄ JSON 文字列」の変換と検証だけを担う（壊れたデータは null を返す）。
//
// v4（見下ろし型）: セーブはプレイヤーの位置だけ { version: 4, x, y }。
// 地形は固定シードから生成される共有マップなので保存しない。
// v3 以前のセーブは破棄する（横スクロール時代の座標は意味を持たないため、
// 読み込まずマップ中央スポーンから始める）。
import { MAP_H, MAP_W } from "./mapgen";

export const SAVE_VERSION = 4;

/** プレイヤー状態（位置のみ）。座標はタイル単位の浮動小数。 */
export type WorldBoxState = {
  x: number;
  y: number;
};

function clampPos(v: number, max: number): number {
  return Math.max(0.5, Math.min(max - 0.5, v));
}

export function serializeSave(state: WorldBoxState): string {
  return JSON.stringify({
    version: SAVE_VERSION,
    x: clampPos(state.x, MAP_W),
    y: clampPos(state.y, MAP_H),
  });
}

/**
 * 壊れている・v4 でない場合は null（マップ中央スポーンにフォールバック）。
 * v1〜v3 のセーブは意図的に読み込まない（破棄）。
 */
export function parseSave(json: string | null | undefined): WorldBoxState | null {
  if (!json) return null;
  try {
    const data = JSON.parse(json) as { version?: unknown; x?: unknown; y?: unknown };
    if (data.version !== SAVE_VERSION) return null;
    if (typeof data.x !== "number" || typeof data.y !== "number") return null;
    if (!Number.isFinite(data.x) || !Number.isFinite(data.y)) return null;
    return { x: clampPos(data.x, MAP_W), y: clampPos(data.y, MAP_H) };
  } catch {
    return null;
  }
}
