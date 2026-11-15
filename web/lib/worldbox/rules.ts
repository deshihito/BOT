// AGO WORLD BOX の掘る／置くルール（純粋ロジック）。
// ワールド配列と所持品（5枠インベントリ）の付け替えだけを扱い、入力や描画は持たない。
// 道具の段階による掘削ゲートは items.ts（canDigWith）が担い、ここは
// 「掘れたら受け取る／置けたら消費する」の在庫整合だけを見る。
import { AIR, TORCH, canDigBlock, dropOf } from "./blocks";
import { addItem, countOf, removeItem, type InventoryV2 } from "./inventory";
import { getTile, setTile, type World } from "./worldgen";

/** 掘れる範囲（プレイヤー中心から対象タイル中心までの距離、タイル単位）。 */
export const REACH = 4.5;

export function withinReach(px: number, py: number, tx: number, ty: number): boolean {
  const dx = tx + 0.5 - px;
  const dy = ty + 0.5 - py;
  return dx * dx + dy * dy <= REACH * REACH;
}

/**
 * タイルを掘る。成功したら手に入ったブロック ID、失敗したら null。
 * 岩盤・空気・範囲外は掘れない。さらに v2 では「掘った物を受け取る枠が
 * ない（満杯）」場合も掘れない（ブロックはその場に残る）。
 * world と inv を直接書き換える。
 */
export function digTile(world: World, inv: InventoryV2, x: number, y: number): number | null {
  const id = getTile(world, x, y);
  if (id === AIR || !canDigBlock(id)) return null;
  // 範囲外 getTile は岩盤を返すので、座標そのものも範囲内であることを確認する
  if (x < 0 || x >= world.width || y < 0 || y >= world.height) return null;
  const drop = dropOf(id);
  if (addItem(inv, drop, 1) < 1) return null; // 満杯では掘れない（先に受け取り可否を見る）
  setTile(world, x, y, AIR);
  return drop;
}

export type BodyRect = { x: number; y: number; w: number; h: number };

/** タイル1マスと矩形が重なるか。 */
export function tileIntersectsBody(tx: number, ty: number, body: BodyRect): boolean {
  return tx < body.x + body.w && tx + 1 > body.x && ty < body.y + body.h && ty + 1 > body.y;
}

/**
 * タイルを置く。成功したら true。
 * 占有済み・所持数ゼロ・設置不可ブロック・プレイヤーと重なる場所には置けない。
 */
export function placeTile(world: World, inv: InventoryV2, x: number, y: number, block: number, body?: BodyRect): boolean {
  if (x < 0 || x >= world.width || y < 0 || y >= world.height) return false;
  if (getTile(world, x, y) !== AIR) return false;
  if (countOf(inv, block) <= 0) return false;
  if (body && tileIntersectsBody(x, y, body)) return false;
  setTile(world, x, y, block);
  removeItem(inv, block, 1);
  return true;
}

/**
 * 松明を置く。成功したら true。
 * 松明は固体ではない置き物なので、自分の体と重なるセルにも置ける
 * （placeTile との違いはそこだけ）。占有済み・所持数ゼロでは置けない。
 */
export function placeTorch(world: World, inv: InventoryV2, x: number, y: number): boolean {
  if (x < 0 || x >= world.width || y < 0 || y >= world.height) return false;
  if (getTile(world, x, y) !== AIR) return false;
  if (countOf(inv, TORCH) <= 0) return false;
  setTile(world, x, y, TORCH);
  removeItem(inv, TORCH, 1);
  return true;
}

/**
 * プレス（長押し）の操作モード。押し始めた時点の対象で固定し、
 * 押し続けている間は変わらない（掘り終わった長押しが設置に化けて
 * 掘ったブロックを即置き戻す、といった事故を防ぐ）。
 * - "dig": ブロック上で押し始めた（または敵がいる）。採掘/攻撃だけが続く。
 * - "place": 空白から押し始めて設置できる物を持っている。設置だけが続く。
 * - null: どちらでもない（掘れない岩盤、設置できる物を持っていない空白）。
 */
export type PressMode = "dig" | "place";

export function pressModeFor(id: number, hasPlaceable: boolean, enemyThere: boolean): PressMode | null {
  if (enemyThere) return "dig";
  if (id !== AIR && canDigBlock(id)) return "dig";
  if (id === AIR && hasPlaceable) return "place";
  return null;
}

/** 掘りヒビの段階数（進捗 0〜1 を 0〜CRACK_STAGES に写す）。 */
export const CRACK_STAGES = 4;

/** 掘り進捗（0〜1）→ ヒビの段階（0=なし、1〜4=だんだん深く）。 */
export function crackStage(progress: number): number {
  if (!Number.isFinite(progress) || progress <= 0) return 0;
  return Math.min(CRACK_STAGES, Math.ceil(progress * CRACK_STAGES));
}
