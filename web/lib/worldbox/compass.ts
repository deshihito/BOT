// AGO WORLD BOX の開拓のコンパス（純粋ロジック、DOM 非依存）。
// 入口の配置は maplogic.ts の決定的生成（structuresForChunk）が正で、
// ここでは「現在位置から最も近い洞窟入口 / ダンジョン入口」を探す。
// 構造物はスーパーセル方式で「セルに候補チャンクは最大1つ」なので、
// 全チャンクを走査せず、対象構造物のスーパーセル候補だけを現在地の
// セルからリング状（チェビシェフ距離の輪）に広げて評価する。
// リング r のセル領域までの距離の下限は (r-1) * セル幅（タイル）で、
// これが既知の最良距離と探索上限を超えたら打ち切る。
// 再計算は高くつかないが、それでもクライアント側は移動時のスロットル
// （一定距離動いたら再計算）を前提に呼ぶこと。
import {
  CHUNK_SIZE, STRUCTURES, chunkHash, structuresForChunk,
} from "./maplogic";

export type CompassEntranceKind = "cave" | "dungeon";

export type CompassTarget = {
  kind: CompassEntranceKind;
  structureId: string;
  /** 入口タイルの中心座標（タイル単位）。 */
  x: number;
  y: number;
  /** 現在位置からの距離（タイル、ユークリッド）。 */
  dist: number;
  /** 現在位置から見た方位角（ラジアン、atan2(dy, dx)。y は下向き）。 */
  angle: number;
};

/** 探索の上限（タイル）。これより遠い入口は「見つからない」として扱う。 */
export const COMPASS_MAX_TILES = 3072;

const COMPASS_TARGETS: readonly { kind: CompassEntranceKind; structureId: string }[] = [
  { kind: "cave", structureId: "cave_entrance" },
  { kind: "dungeon", structureId: "dungeon_entrance" },
];

function divFloor(a: number, b: number): number {
  return Math.floor(a / b);
}

/**
 * 指定した構造物（入口）への最寄りを探す。探索上限（maxTiles）以内に
 * 無ければ null。配置の真値は structuresForChunk に委ね、ここは候補の
 * 列挙順だけを持つ（候補チャンクで別の構造物が勝っていれば、その入口は
 * そこに存在しないので読み飛ばす）。
 */
export function nearestEntrance(
  seed: number,
  kind: CompassEntranceKind,
  x: number,
  y: number,
  maxTiles: number = COMPASS_MAX_TILES,
): CompassTarget | null {
  const target = COMPASS_TARGETS.find((t) => t.kind === kind);
  const def = STRUCTURES.find((s) => s.id === target?.structureId);
  if (!target || !def) return null;
  const cell = def.cellChunks;
  const cellTiles = cell * CHUNK_SIZE;
  const psx = divFloor(Math.floor(x / CHUNK_SIZE), cell);
  const psy = divFloor(Math.floor(y / CHUNK_SIZE), cell);
  let best: CompassTarget | null = null;
  for (let r = 0; ; r++) {
    // リング r のセルまでの距離の下限。これが上限や既知の最良を超えたら
    // それより外側に答えは無い（近い順に広げているため）。
    const lowerBound = r === 0 ? 0 : (r - 1) * cellTiles;
    if (lowerBound > maxTiles) break;
    if (best && lowerBound > best.dist) break;
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const sx = psx + dx;
        const sy = psy + dy;
        // maplogic の候補選出と同一式（セル内の候補チャンクは1つだけ）。
        const candCx = sx * cell + Math.floor(chunkHash(seed, sx, sy, 11) * cell);
        const candCy = sy * cell + Math.floor(chunkHash(seed, sx, sy, 23) * cell);
        for (const st of structuresForChunk(seed, candCx, candCy)) {
          if (st.structureId !== def.id) continue;
          const tx = st.x + 0.5;
          const ty = st.y + 0.5;
          const dist = Math.hypot(tx - x, ty - y);
          if (dist > maxTiles) continue;
          if (!best || dist < best.dist) {
            best = { kind, structureId: def.id, x: tx, y: ty, dist, angle: Math.atan2(ty - y, tx - x) };
          }
        }
      }
    }
  }
  return best;
}

/** 洞窟とダンジョンの最寄り入口をまとめて返す（開拓のコンパスの表示用）。 */
export function nearestEntrances(
  seed: number,
  x: number,
  y: number,
  maxTiles: number = COMPASS_MAX_TILES,
): { cave: CompassTarget | null; dungeon: CompassTarget | null } {
  return {
    cave: nearestEntrance(seed, "cave", x, y, maxTiles),
    dungeon: nearestEntrance(seed, "dungeon", x, y, maxTiles),
  };
}
