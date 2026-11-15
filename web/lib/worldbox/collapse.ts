// AGO WORLD BOX の崩落（純粋ロジック）。
// 緩いブロック（草・土・砂・葉）は下が空くと落ちる。掘る／置くの直後に
// 変更した列だけを調べ、支えを失った緩いブロックを「落下中ブロック」に
// 変える（上のブロックも連鎖する）。構造材（石・鉱石・原木・岩盤）は
// 支えを失っても落ちないので、木の葉が世界中で一斉に落ちることはない。
// 落下中ブロックは重力で落ち、地面に着くとタイルに戻る。落下中に
// プレイヤーや敵に当たると潰してダメージを与える。
import { AIR, isLooseBlock, isSolidBlock } from "./blocks";
import { getTile, setTile, type World } from "./worldgen";

/** 落下ブロックが当たったときのダメージ。 */
export const FALL_BLOCK_DAMAGE = 3;

const FALL_GRAVITY = 30;
const FALL_MAX_SPEED = 18;

export type FallingBlock = {
  blockId: number;
  /** 列（タイル座標、そのまま固定）。 */
  x: number;
  /** 上端の y（浮動小数）。 */
  y: number;
  vy: number;
};

export type CrushTarget = { key: string; x: number; y: number; w: number; h: number };

export type FallingEvents = {
  /** 着地してタイルに戻った落下ブロック。 */
  landed: FallingBlock[];
  /** 対象を潰した落下ブロック（ブロック自体は砕けて消える）。 */
  crushed: { targetKey: string; block: FallingBlock }[];
};

/**
 * タイル変更（掘る／置く）の後に呼ぶ。その列で支えを失った緩いブロックを
 * 落下ブロックとして切り離し、生成した一覧を返す。
 * - 掘った場合: 空いたセルの真上から、緩いブロックが続く限り全部落ちる。
 * - 置いた場合: 置いたブロック自体が緩くて下が空なら、それも落ちる。
 */
export function settleAfterChange(world: World, tx: number, ty: number): FallingBlock[] {
  const spawned: FallingBlock[] = [];
  if (tx < 0 || tx >= world.width || ty < 0 || ty >= world.height) return spawned;

  const release = (x: number, y: number) => {
    const id = getTile(world, x, y);
    if (id === AIR || !isLooseBlock(id)) return false;
    setTile(world, x, y, AIR);
    spawned.push({ blockId: id, x, y, vy: 0 });
    return true;
  };

  // 置いたばかりの緩いブロックが宙に浮いていたら落とす
  const here = getTile(world, tx, ty);
  if (here !== AIR && isLooseBlock(here) && !isSolidBlock(getTile(world, tx, ty + 1))) {
    release(tx, ty);
  }
  // 空いたセルの真上: 緩いブロックが続く限り連鎖して落とす（構造材で止まる）
  for (let y = ty - 1; y >= 0; y--) {
    const id = getTile(world, tx, y);
    if (id === AIR || !isLooseBlock(id)) break;
    release(tx, y);
  }
  return spawned;
}

/**
 * 落下ブロックを dt 秒進める。着地したらタイルに戻す。
 * targets と重なった落下ブロックは潰しイベントになり、ブロックは砕ける。
 * falling 配列は直接書き換える（残ったものだけが残る）。
 */
export function stepFalling(world: World, falling: FallingBlock[], dt: number, targets: CrushTarget[] = []): FallingEvents {
  const events: FallingEvents = { landed: [], crushed: [] };
  // 下にあるものから処理する（積み重なりを正しく着地させる）
  const order = [...falling].sort((a, b) => b.y - a.y);
  const remaining: FallingBlock[] = [];
  for (const f of order) {
    f.vy = Math.min(FALL_MAX_SPEED, f.vy + FALL_GRAVITY * dt);
    const ny = f.y + f.vy * dt;

    // 潰し判定（移動後の矩形で見る）
    const hit = targets.find((t) => f.x < t.x + t.w && f.x + 1 > t.x && ny < t.y + t.h && ny + 1 > t.y);
    if (hit) {
      events.crushed.push({ targetKey: hit.key, block: { ...f, y: ny } });
      continue;
    }

    // 着地判定: 底辺が入るセルが固体（下の落下ブロックは着地時にタイル化
    // されるので、同じ列の連鎖もタイルとして受け止められる）
    const cellBelow = Math.floor(ny + 1);
    const blockedByTile = isSolidBlock(getTile(world, f.x, cellBelow));
    if (blockedByTile || ny + 1 >= world.height) {
      const landY = Math.min(cellBelow - 1, world.height - 1);
      if (landY >= 0 && getTile(world, f.x, landY) === AIR) {
        setTile(world, f.x, landY, f.blockId);
        events.landed.push({ ...f, y: landY });
        continue;
      }
      // 着地先が埋まっていたら元の浮動位置で保持する（次の機会に再判定）
      f.y = ny;
      remaining.push(f);
      continue;
    }
    f.y = ny;
    remaining.push(f);
  }
  falling.length = 0;
  falling.push(...remaining);
  return events;
}
