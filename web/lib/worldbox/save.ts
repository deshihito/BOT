// AGO WORLD BOX のプレイヤーセーブ変換（純粋ロジック）。
// localStorage / サーバー（bot_kv）の読み書き自体は呼び出し側で行い、ここは
// 「状態 ⇄ JSON 文字列」の変換と検証だけを担う（壊れたデータは null を返す）。
//
// v6: セーブは { version: 6, space, x, y, worldReturn }。
// space はプレイヤーがいる空間（"world" | "lobby"）。地形はどちらの空間も
// コードから決定的に作られるので保存しない。worldReturn はロビーへ入る直前
// のワールド位置で、ロビーを出るとそこへ戻る（無ければ null = スポーン）。
// v5 以前は破棄する（v5 はロビーが無く空間を持たない。v4 以前は旧マップ時代）。
import { LOBBY_H, LOBBY_W } from "./lobby";
import { MAP_H, MAP_W } from "./mapgen";

export const SAVE_VERSION = 6;

/** プレイヤーがいる空間。 */
export type SaveSpace = "world" | "lobby";

/** プレイヤー状態（位置と空間）。座標はタイル単位の浮動小数。 */
export type WorldBoxState = {
  space: SaveSpace;
  x: number;
  y: number;
  /** ロビーから戻る先のワールド位置。ロビー未訪問なら null。 */
  worldReturn: { x: number; y: number } | null;
};

function clampPos(v: number, max: number): number {
  return Math.max(0.5, Math.min(max - 0.5, v));
}

function sanitizeSpace(raw: unknown): SaveSpace {
  return raw === "lobby" ? "lobby" : "world";
}

function boundsFor(space: SaveSpace): { width: number; height: number } {
  return space === "lobby" ? { width: LOBBY_W, height: LOBBY_H } : { width: MAP_W, height: MAP_H };
}

function clampToSpace(space: SaveSpace, x: number, y: number): { x: number; y: number } {
  const b = boundsFor(space);
  return { x: clampPos(x, b.width), y: clampPos(y, b.height) };
}

function parseWorldReturn(raw: unknown): { x: number; y: number } | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as { x?: unknown; y?: unknown };
  if (typeof v.x !== "number" || typeof v.y !== "number") return null;
  if (!Number.isFinite(v.x) || !Number.isFinite(v.y)) return null;
  return clampToSpace("world", v.x, v.y);
}

export function serializeSave(state: WorldBoxState): string {
  const pos = clampToSpace(state.space, state.x, state.y);
  return JSON.stringify({
    version: SAVE_VERSION,
    space: state.space,
    x: pos.x,
    y: pos.y,
    worldReturn: state.worldReturn ? clampToSpace("world", state.worldReturn.x, state.worldReturn.y) : null,
  });
}

/**
 * 壊れている・v6 でない場合は null（ワールドのスポーンにフォールバック）。
 * v5 以前のセーブは意図的に読み込まない（破棄）。
 */
export function parseSave(json: string | null | undefined): WorldBoxState | null {
  if (!json) return null;
  try {
    const data = JSON.parse(json) as { version?: unknown; space?: unknown; x?: unknown; y?: unknown; worldReturn?: unknown };
    if (data.version !== SAVE_VERSION) return null;
    if (typeof data.x !== "number" || typeof data.y !== "number") return null;
    if (!Number.isFinite(data.x) || !Number.isFinite(data.y)) return null;
    const space = sanitizeSpace(data.space);
    const pos = clampToSpace(space, data.x, data.y);
    return { space, x: pos.x, y: pos.y, worldReturn: parseWorldReturn(data.worldReturn) };
  } catch {
    return null;
  }
}
