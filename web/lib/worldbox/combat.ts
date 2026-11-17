// AGO WORLD BOX のフィールド戦闘（純粋ロジック、DOM 非依存）。
// モブの配置は mobs.ts の決定的配置が正で、個体は「種@アンカー座標」で識別する。
// HP と死亡（再出現待ち）だけをサーバー状態として持ち、攻撃のたびに
// サーバーが配置を再計算して実在を検証する（存在しない個体は殴れない）。
// ダメージは闘技場と同じ式（arena.ts の playerAttack: 素手8 + 最良の剣 tier×4）。
import { mobById, mobsForChunk, largeMobsForChunk, mobFootprintBounds, mobOccupiesTile, type MobDef, type PlacedMob } from "./mobs";
import { CHUNK_SIZE } from "./maplogic";

/** 倒したモブが同じアンカーに再出現するまでの基本時間（15分）。 */
export const MOB_RESPAWN_MS = 15 * 60 * 1000;
/** 個体キーから決定的に加算する追加遅延の上限（0〜10分。同時復活の分散）。 */
export const MOB_RESPAWN_JITTER_MS = 10 * 60 * 1000;

/** 個体キー（"mobId@x,y"）から決定的に 0〜MOB_RESPAWN_JITTER_MS の追加遅延を返す。 */
export function mobRespawnDelayMs(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % (MOB_RESPAWN_JITTER_MS + 1);
}

/**
 * モブの素材スプライト（実体は web/public/img/worldbox/mobs/）。
 * 基本セットは確定素材セット td16 由来（16×16）で、描き直した種から
 * 32×32 の新スプライトに順次置換している（2026-11-17〜、docs/world-box-shared.md）。
 * ここに無い種は MOB_SPRITE_FALLBACK に明示したものだけが図形フォールバックで描かれる。
 */
export const MOB_SPRITE: Readonly<Record<string, string>> = {
  chicken: "/img/worldbox/mobs/chicken.png",
  rabbit: "/img/worldbox/mobs/rabbit.png",
  frog: "/img/worldbox/mobs/frog.png",
  crab: "/img/worldbox/mobs/crab.png",
  bee: "/img/worldbox/mobs/bee.png",
  mouse: "/img/worldbox/mobs/mouse.png",
  slime: "/img/worldbox/mobs/slime.png",
  cave_bat: "/img/worldbox/mobs/bat.png",
  pig: "/img/worldbox/mobs/pig.png",
  sheep: "/img/worldbox/mobs/sheep.png",
  cow: "/img/worldbox/mobs/cow.png",
  deer: "/img/worldbox/mobs/deer.png",
  horse: "/img/worldbox/mobs/horse.png",
  boar: "/img/worldbox/mobs/boar.png",
  wolf: "/img/worldbox/mobs/wolf.png",
  spider: "/img/worldbox/mobs/spider.png",
  skeleton: "/img/worldbox/mobs/skeleton.png",
  ghost: "/img/worldbox/mobs/ghost.png",
  bear: "/img/worldbox/mobs/bear.png",
  golem: "/img/worldbox/mobs/golem.png",
  treant: "/img/worldbox/mobs/treant.png",
  dungeon_dragon: "/img/worldbox/mobs/dragon.png",
  sea_serpent: "/img/worldbox/mobs/serpent.png",
  spider_queen: "/img/worldbox/mobs/spider.png",
  giant_golem: "/img/worldbox/mobs/golem.png",
  ancient_turtle: "/img/worldbox/mobs/turtle.png",
  world_dragon: "/img/worldbox/mobs/dragon.png",
  cat: "/img/worldbox/mobs/cat.png",
  dog: "/img/worldbox/mobs/dog.png",
  duck: "/img/worldbox/mobs/duck.png",
  goat: "/img/worldbox/mobs/goat.png",
  fox: "/img/worldbox/mobs/fox.png",
  tanuki: "/img/worldbox/mobs/tanuki.png",
  bird_blue: "/img/worldbox/mobs/bird_blue.png",
  crow: "/img/worldbox/mobs/crow.png",
  owl: "/img/worldbox/mobs/owl.png",
  penguin: "/img/worldbox/mobs/penguin.png",
  butterfly: "/img/worldbox/mobs/butterfly.png",
  ladybug: "/img/worldbox/mobs/ladybug.png",
  snail: "/img/worldbox/mobs/snail.png",
  fish_blue: "/img/worldbox/mobs/fish_blue.png",
  fish_orange: "/img/worldbox/mobs/fish_orange.png",
  jellyfish: "/img/worldbox/mobs/jellyfish.png",
  octopus: "/img/worldbox/mobs/octopus.png",
  mushroom: "/img/worldbox/mobs/mushroom_mob.png",
  werewolf: "/img/worldbox/mobs/werewolf.png",
  ogre: "/img/worldbox/mobs/ogre.png",
  giant: "/img/worldbox/mobs/giant.png",
};

/** 素材が無い種の明示フォールバック（最小限の図形描画に落とす種）。全種に素材が揃ったため空。 */
export const MOB_SPRITE_FALLBACK: ReadonlySet<string> = new Set([]);

/** スプライト指定の整合チェック（テスト用）: 実在モブのみ・全モブがどちらかを持つ。 */
export function validateMobSprites(): string[] {
  const errors: string[] = [];
  for (const id of Object.keys(MOB_SPRITE)) {
    if (!mobById(id)) errors.push(`sprite for unknown mob ${id}`);
  }
  for (const id of MOB_SPRITE_FALLBACK) {
    if (!mobById(id)) errors.push(`fallback for unknown mob ${id}`);
    if (MOB_SPRITE[id]) errors.push(`${id}: in both sprite and fallback`);
  }
  return errors;
}

/** そのモブが素材スプライトか明示フォールバックのどちらかを持つか。 */
export function mobHasVisual(id: string): boolean {
  return Boolean(MOB_SPRITE[id]) || MOB_SPRITE_FALLBACK.has(id);
}
/** 攻撃が届く距離（プレイヤーのタイルからモブ占有範囲までのチェビシェフ距離）。 */
export const MOB_ATTACK_RANGE = 2;
/** サーバー側の距離検証の上限（タイル行為と同じ 2。占有範囲までの距離で測る）。 */
export const MOB_ATTACK_MAX_DISTANCE = 2;
/**
 * クライアントが申告するモブの現在タイルを、アンカーからこの距離までなら
 * 距離検証の実位置として採用する上限。モブの見た目はクライアント側で
 * アンカーからうろつき/追跡する（行動側の LEASH_DISTANCE=11＋サイズ・
 * 丸めのマージン）。申告がこの範囲を外れたらアンカー位置で検証する。
 * 申告なしの検証（アンカーのみ）だと、追跡してきたモブが画面では足元に
 * いてもサーバーには遠くに見えて攻撃が通らなかった（2026-11-16 実害）。
 */
export const MOB_REPORT_LEASH = 13;

/**
 * 距離検証に使うモブの実位置を決める。申告タイル（現在タイル）が
 * アンカーの占有範囲から MOB_REPORT_LEASH 以内なら申告を採用し、
 * それ以外（未申告・不正・リーシュ外）はアンカーを返す。
 */
export function resolveMobPosition<T extends Pick<PlacedMob, "mobId" | "x" | "y" | "size">>(
  placed: T,
  reported: { x: number; y: number } | null | undefined,
): T {
  if (!reported) return placed;
  if (!Number.isFinite(reported.x) || !Number.isFinite(reported.y)) return placed;
  const rx = Math.floor(reported.x);
  const ry = Math.floor(reported.y);
  if (mobDistance(rx, ry, placed) > MOB_REPORT_LEASH) return placed;
  return { ...placed, x: rx, y: ry };
}

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
  /** 凍結中の解除時刻（ms）。アイスランスで付く。 */
  frozenUntil?: number;
};

export function parseMobState(raw: unknown): MobState | null {
  let v: unknown = raw;
  if (typeof raw === "string") {
    try { v = JSON.parse(raw); } catch { return null; }
  }
  if (typeof v !== "object" || v === null) return null;
  const o = v as { hp?: unknown; deadUntil?: unknown; frozenUntil?: unknown };
  if (typeof o.hp !== "number" || !Number.isFinite(o.hp)) return null;
  const st: MobState = { hp: Math.max(0, Math.floor(o.hp)) };
  if (typeof o.deadUntil === "number" && Number.isFinite(o.deadUntil)) st.deadUntil = o.deadUntil;
  if (typeof o.frozenUntil === "number" && Number.isFinite(o.frozenUntil)) st.frozenUntil = o.frozenUntil;
  return st;
}

export function parseMobStates(raw: unknown): Record<string, MobState> {
  if (typeof raw !== "object" || raw === null) return {};
  const out: Record<string, MobState> = {};
  // 本番の呼び出し（mobs-online の loadMobStates）は bot-api の kvList が
  // 返す Map をそのまま渡す。Object.entries(Map) は常に [] になるため、
  // Map は entries() で反復する（幽霊モブ実害の再発防止）。
  const entries: Iterable<readonly [string, unknown]> =
    raw instanceof Map ? raw.entries() : Object.entries(raw as Record<string, unknown>);
  for (const [k, v] of entries) {
    // インスタンス内は "空間ID|mobId@x,y" の前置キーを許す
    const baseKey = k.includes("|") ? k.slice(k.lastIndexOf("|") + 1) : k;
    if (!parseMobKey(baseKey)) continue;
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

/**
 * 剣を振ったときの攻撃対象を決める（照準方式でなく範囲方式）。
 * プレイヤーから攻撃範囲内（占有範囲まで MOB_ATTACK_RANGE）にいる候補のうち、
 * タップしたマスを含むものを最優先し、次にタップ位置に近いもの、
 * 最後にプレイヤーに近いものを選ぶ。範囲内にいなければ null（空振り）。
 * 候補の現在位置は呼び出し側が渡す（アンカーでも現在タイルでもよい）。
 */
export function attackTarget<T extends Pick<PlacedMob, "mobId" | "x" | "y" | "size">>(
  px: number, py: number, tx: number, ty: number,
  candidates: readonly T[],
): T | null {
  let best: T | null = null;
  let bestRank: [number, number, number] | null = null;
  for (const m of candidates) {
    const distP = mobDistance(px, py, m);
    if (distP > MOB_ATTACK_RANGE) continue;
    const onTap = mobOccupiesTile(m.size, m.x, m.y, tx, ty) ? 0 : 1;
    const rank: [number, number, number] = [onTap, mobDistance(tx, ty, m), distP];
    if (
      !bestRank || rank[0] < bestRank[0] ||
      (rank[0] === bestRank[0] && (rank[1] < bestRank[1] || (rank[1] === bestRank[1] && rank[2] < bestRank[2])))
    ) {
      best = m;
      bestRank = rank;
    }
  }
  return best;
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
  mobKey?: string,
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
  // 再出現は基本15分＋個体キー決定的な追加遅延（0〜10分）で同時復活を分散する。
  // deadUntil に加算済みの値を保存するので、mobHpNow 側は deadUntil 判定だけで一貫する。
  const delay = mobKey ? mobRespawnDelayMs(mobKey) : 0;
  return { state: { hp: 0, deadUntil: now + MOB_RESPAWN_MS + delay }, hp: 0, dead: true, gained };
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
