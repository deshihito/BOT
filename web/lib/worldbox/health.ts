// AGO WORLD BOX のプレイヤー体力（純粋ロジック）。
// HP は最大10（= ハート5個、半ハート単位）。敵の接触と落下で減り、
// ハートの拾い物で回復する。0 になると死亡: スポーンへ戻され、
// 所持ブロックの一部をその場に落とす（ワールド自体は残る）。
import { isItemId } from "./items";
import { countOf, removeItem, type InventoryV2 } from "./inventory";

export const PLAYER_MAX_HP = 10;
/** ダメージ後の無敵時間（秒）。連続接触で溶けないようにする。 */
export const INVULN_SEC = 1.0;
/** 落下ダメージが付かない高さ（タイル）。 */
export const SAFE_FALL_TILES = 3.5;

export type HealthState = {
  hp: number;
  /** この時刻（ゲーム内秒）まではダメージを受けない。 */
  invulnUntil: number;
};

export function createHealth(): HealthState {
  return { hp: PLAYER_MAX_HP, invulnUntil: 0 };
}

/** 落下距離（タイル）→ ダメージ。安全な高さを超えた分だけ1ずつ増える。 */
export function fallDamageFor(fallTiles: number): number {
  if (!Number.isFinite(fallTiles) || fallTiles <= SAFE_FALL_TILES) return 0;
  return Math.min(PLAYER_MAX_HP, Math.floor(fallTiles - SAFE_FALL_TILES));
}

/**
 * ダメージを与える。無敵時間中・ダメージ0以下なら false（受けていない）。
 * 成功したら無敵時間を更新する。now はゲーム内秒（クライアントの累積時計）。
 */
export function damagePlayer(h: HealthState, amount: number, now: number): boolean {
  if (amount <= 0 || h.hp <= 0) return false;
  if (now < h.invulnUntil) return false;
  h.hp = Math.max(0, h.hp - amount);
  h.invulnUntil = now + INVULN_SEC;
  return true;
}

/** 回復する。実際に回復した量を返す。 */
export function healPlayer(h: HealthState, amount: number): number {
  if (amount <= 0 || h.hp <= 0) return 0;
  const before = h.hp;
  h.hp = Math.min(PLAYER_MAX_HP, h.hp + amount);
  return h.hp - before;
}

export function isDead(h: HealthState): boolean {
  return h.hp <= 0;
}

/**
 * 死亡時の落とし物: ブロックの各スタックの半分（切り捨て）を落とす。
 * 道具とインゴットは落とさない（取り戻しに行く手間はブロック分だけ）。
 * inv を書き換え、落とした { blockId, count } の一覧を返す。
 */
export function deathDrops(inv: InventoryV2): { blockId: number; count: number }[] {
  const drops: { blockId: number; count: number }[] = [];
  const ids = new Set<number>();
  for (const slot of inv.slots) if (slot) ids.add(slot.id);
  for (const id of ids) {
    if (isItemId(id)) continue; // インゴット・道具は落とさない
    const half = Math.floor(countOf(inv, id) / 2);
    if (half > 0 && removeItem(inv, id, half)) drops.push({ blockId: id, count: half });
  }
  return drops;
}
