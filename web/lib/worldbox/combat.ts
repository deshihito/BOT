// AGO WORLD BOX のフィールド戦闘（純粋ロジック、DOM 非依存）。
// モブの配置は mobs.ts の決定的配置が正で、個体は「種@アンカー座標」で識別する。
// HP と死亡（再出現待ち）だけをサーバー状態として持ち、攻撃のたびに
// サーバーが配置を再計算して実在を検証する（存在しない個体は殴れない）。
// ダメージは闘技場と同じ式（arena.ts の playerAttack: 素手8 + 最良の剣 tier×4）。
import { mobById, mobsForChunk, largeMobsForChunk, mobFootprintBounds, mobOccupiesTile, type MobDef, type PlacedMob } from "./mobs";
import { CHUNK_SIZE } from "./maplogic";

/** 倒したモブが同じアンカーに再出現するまでの時間。 */
export const MOB_RESPAWN_MS = 5 * 60 * 1000;
/** 攻撃が届く距離（プレイヤーのタイルからモブ占有範囲までのチェビシェフ距離）。 */
export const MOB_ATTACK_RANGE = 1;
/** サーバー側の距離検証の上限（タイル行為と同じ 2。占有範囲までの距離で測る）。 */
export const MOB_ATTACK_MAX_DISTANCE = 2;

/** 個体キー: "mobId@x,y"（アンカー＝中心タイル）。 */
export function mobKeyOf(placed: Pick<PlacedMob, "mobId" | "x" | "y">): string {
  return `${placed.mobId}@${placed.x},${placed.y}`;
}

export function parseMobKey(key: unknown): { mobId: string; x: number; y: number } | null {
  if (typeof key !== "string") return null;
  const m = /^([a-z0-9_]+)@(-?\d+),(-?\d+)$/.exec(key);
  if (!m) return null;
  if (!mobById(m[1])) return null;
  return { mobId: m[1], x: Number(m[2]), y: Number(m[3]) };
}

/** サーバーに保存する個体状態。未保存 = 満タンで生存。 */
export type MobState = {
  hp: number;
  /** 死亡中の再出現時刻（ms）。これを過ぎたら満タンで復活。 */
  deadUntil?: number;
};

export function parseMobState(raw: unknown): MobState | null {
  let v: unknown = raw;
  if (typeof raw === "string") {
    try { v = JSON.parse(raw); } catch { return null; }
  }
  if (typeof v !== "object" || v === null) return null;
  const o = v as { hp?: unknown; deadUntil?: unknown };
  if (typeof o.hp !== "number" || !Number.isFinite(o.hp)) return null;
  const st: MobState = { hp: Math.max(0, Math.floor(o.hp)) };
  if (typeof o.deadUntil === "number" && Number.isFinite(o.deadUntil)) st.deadUntil = o.deadUntil;
  return st;
}

export function parseMobStates(raw: unknown): Record<string, MobState> {
  if (typeof raw !== "object" || raw === null) return {};
  const out: Record<string, MobState> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!parseMobKey(k)) continue;
    const st = parseMobState(v);
    if (st) out[k] = st;
  }
  return out;
}

/** 状態から見た現在 HP と生存。deadUntil を過ぎた死亡状態は満タン復活として扱う。 */
export function mobHpNow(def: MobDef, state: MobState | null, now: number): { hp: number; alive: boolean } {
  if (!state) return { hp: def.hp, alive: true };
  if (state.deadUntil !== undefined) {
    if (now < state.deadUntil) return { hp: 0, alive: false };
    return { hp: def.hp, alive: true };
  }
  return { hp: Math.min(def.hp, Math.max(0, state.hp)), alive: state.hp > 0 };
}

/** 範囲内のモブ配置をすべて返す（通常配置＋大型のスーパーセル配置）。 */
export function visibleMobs(
  seed: number, x0: number, y0: number, x1: number, y1: number, isNight: boolean,
): PlacedMob[] {
  const out: PlacedMob[] = [];
  const cx0 = Math.floor(x0 / CHUNK_SIZE);
  const cy0 = Math.floor(y0 / CHUNK_SIZE);
  const cx1 = Math.floor(x1 / CHUNK_SIZE);
  const cy1 = Math.floor(y1 / CHUNK_SIZE);
  for (let cy = cy0; cy <= cy1; cy++) {
    for (let cx = cx0; cx <= cx1; cx++) {
      for (const m of mobsForChunk(seed, cx, cy, isNight)) {
        if (m.x >= x0 && m.x <= x1 && m.y >= y0 && m.y <= y1) out.push(m);
      }
      for (const m of largeMobsForChunk(seed, cx, cy, isNight)) {
        if (m.x >= x0 && m.x <= x1 && m.y >= y0 && m.y <= y1) out.push(m);
      }
    }
  }
  return out;
}

/** そのアンカーにその種が実在するか（配置の再計算で検証する）。 */
export function mobExistsAt(seed: number, mobId: string, x: number, y: number, isNight: boolean): boolean {
  const cx = Math.floor(x / CHUNK_SIZE);
  const cy = Math.floor(y / CHUNK_SIZE);
  const hit = (m: PlacedMob) => m.mobId === mobId && m.x === x && m.y === y;
  return mobsForChunk(seed, cx, cy, isNight).some(hit) || largeMobsForChunk(seed, cx, cy, isNight).some(hit);
}

/** プレイヤーのタイルからモブ占有範囲までのチェビシェフ距離（範囲内なら 0）。 */
export function mobDistance(px: number, py: number, placed: Pick<PlacedMob, "x" | "y" | "size">): number {
  const b = mobFootprintBounds(placed.size, placed.x, placed.y);
  const dx = px < b.minX ? b.minX - px : px > b.maxX ? px - b.maxX : 0;
  const dy = py < b.minY ? b.minY - py : py > b.maxY ? py - b.maxY : 0;
  return Math.max(dx, dy);
}

export type MobAttackResult = {
  state: MobState;
  hp: number;
  dead: boolean;
  /** 倒したときに落ちたアイテム（itemId → 個数）。 */
  gained: Record<string, number>;
};

/** 攻撃を1回適用する。乱数は注入する（ドロップ抽選）。 */
export function applyMobAttack(
  def: MobDef,
  state: MobState | null,
  power: number,
  now: number,
  rng: () => number,
): MobAttackResult | { error: "mob_dead" } {
  const cur = mobHpNow(def, state, now);
  if (!cur.alive) return { error: "mob_dead" };
  const hp = Math.max(0, cur.hp - Math.max(1, Math.floor(power)));
  if (hp > 0) return { state: { hp }, hp, dead: false, gained: {} };
  const gained: Record<string, number> = {};
  for (const entry of def.loot) {
    if (rng() >= entry.chance) continue;
    const n = entry.min + Math.floor(rng() * (entry.max - entry.min + 1));
    if (n > 0) gained[entry.itemId] = (gained[entry.itemId] ?? 0) + n;
  }
  return { state: { hp: 0, deadUntil: now + MOB_RESPAWN_MS }, hp: 0, dead: true, gained };
}

/** 指定アンカー（中心タイル）における占有タイルキー一覧（"x,y"）。 */
export function mobFootprintTiles(size: number, tx: number, ty: number): string[] {
  const b = mobFootprintBounds(size, tx, ty);
  const tiles: string[] = [];
  for (let y = b.minY; y <= b.maxY; y++) {
    for (let x = b.minX; x <= b.maxX; x++) tiles.push(`${x},${y}`);
  }
  return tiles;
}

/**
 * モブ群の占有タイル集合（プレイヤー移動の BlockedTiles へ合成する用）。
 * 引数の x, y は「現在の中心タイル」（モブは動くためアンカーではなく現在位置）。
 */
export function mobBlockedTiles(mobs: readonly { size: number; x: number; y: number }[]): Set<string> {
  const out = new Set<string>();
  for (const m of mobs) {
    for (const key of mobFootprintTiles(m.size, m.x, m.y)) out.add(key);
  }
  return out;
}

/**
 * 敵対モブ接触時のノックバック先（タイル中心座標）。
 * モブの中心からプレイヤーへ向かう方向へ押し出し、着地点が占有内であれば
 * 占有の外に出るまで距離を伸ばす。
 */
export function knockbackTarget(
  placed: Pick<PlacedMob, "x" | "y" | "size">,
  player: { x: number; y: number },
  distance = 1.4,
): { x: number; y: number } {
  const cx = placed.x + 0.5;
  const cy = placed.y + 0.5;
  let dx = player.x - cx;
  let dy = player.y - cy;
  const len = Math.hypot(dx, dy);
  if (len < 0.001) {
    dx = 0;
    dy = 1;
  } else {
    dx /= len;
    dy /= len;
  }
  let d = distance;
  let tx = player.x + dx * d;
  let ty = player.y + dy * d;
  while (mobOccupiesTile(placed.size, placed.x, placed.y, Math.floor(tx), Math.floor(ty)) && d < placed.size + 2) {
    d += 0.5;
    tx = player.x + dx * d;
    ty = player.y + dy * d;
  }
  return { x: tx, y: ty };
}
