// AGO WORLD BOX のプレイヤーセーブ変換（純粋ロジック）。
// localStorage / サーバー（bot_kv）の読み書き自体は呼び出し側で行い、ここは
// 「状態 ⇄ JSON 文字列」の変換と検証だけを担う（壊れたデータは null を返す）。
//
// v6: セーブは { version: 6, space, x, y, worldReturn }。
// space はプレイヤーがいる空間（"world" | "lobby" | "lobby2" | "lobby3" | "tent"）。地形はどの空間も
// コードから決定的に作られるので保存しない。worldReturn はロビーへ入る直前
// のワールド位置で、ロビーを出るとそこへ戻る（無ければ null = スポーン）。
// v5 以前は破棄する（v5 はロビーが無く空間を持たない。v4 以前は旧マップ時代）。
import { LOBBY_H, LOBBY_W } from "./lobby";
import { TENT_MAX_H, TENT_MAX_W } from "./tent";
import { WORLD_COORD_LIMIT } from "./mapgen";

export const SAVE_VERSION = 6;

/** プレイヤーがいる空間。 */
/** 既存3空間 + インスタンス空間 ID（"cave:x,y:層" 等）。 */
export type SaveSpace = string;

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

// インスタンス空間 ID の判定（instances.ts の正規表現を複製。このファイルは
// 単体でトランスパイルされるため import しない）。
const SAVE_INSTANCE_SPACE_RE = /^(cave|ruins|dungeon):(-?\d+),(-?\d+):(\d+)$/;
function instanceKindOf(space: string): string | null {
  const m = SAVE_INSTANCE_SPACE_RE.exec(space);
  return m ? m[1] : null;
}

function sanitizeSpace(raw: unknown): SaveSpace {
  if (raw === "lobby" || raw === "lobby2" || raw === "lobby3" || raw === "tent") return raw;
  if (typeof raw === "string" && instanceKindOf(raw)) return raw;
  return "world";
}

/**
 * 空間に合わせて座標を丸める。ロビーとテントは有限グリッド内、ワールドは
 * 境界が無いので健全な絶対上限（WORLD_COORD_LIMIT）でだけ抑える。
 */
function clampToSpace(space: SaveSpace, x: number, y: number): { x: number; y: number } {
  if (space === "lobby") return { x: clampPos(x, LOBBY_W), y: clampPos(y, LOBBY_H) };
  // 階の寸法は lobby-floors.ts の正と一致させる（このファイルは単体で
  // トランスパイルされるため、cave/ruins/dungeon と同じく数値を直書きする）。
  if (space === "lobby2") return { x: clampPos(x, 40), y: clampPos(y, 28) }; // LOBBY2_W/H = 40/28
  if (space === "lobby3") return { x: clampPos(x, 32), y: clampPos(y, 24) }; // LOBBY3_W/H = 32/24
  if (space === "tent") return { x: clampPos(x, TENT_MAX_W), y: clampPos(y, TENT_MAX_H) };
  if (instanceKindOf(space) === "cave") return { x: clampPos(x, 64), y: clampPos(y, 64) }; // CAVE_W/H = 64
  if (instanceKindOf(space) === "ruins") return { x: clampPos(x, 48), y: clampPos(y, 48) }; // RUINS_W/H = 48
  if (instanceKindOf(space) === "dungeon") return { x: clampPos(x, 52), y: clampPos(y, 52) }; // DUNGEON_W/H = 52
  const lim = (v: number) => Math.max(-WORLD_COORD_LIMIT, Math.min(WORLD_COORD_LIMIT, v));
  return { x: lim(x), y: lim(y) };
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
