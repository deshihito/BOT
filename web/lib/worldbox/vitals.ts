// AGO WORLD BOX のプレイヤーバイタル（純粋ロジック、DOM 非依存）。
// HP・空腹・毒・死亡・リスポーンの規則はここに集約し、保存は呼び出し側
// （API ルート）が profile（bot_kv worldbox_profiles）に対して行う。
// 状態そのものは PlayerProfile の hp / hunger / status / vitalAt 等に載る。
// - 空腹は時間で減り（満腹から空まで約20分）、0 が続くと HP が減る
// - 毒は一定間隔で HP を削り、時間経過か解毒で消える
// - モブの接触ダメージはサーバー側が配置と距離を検証してからここで適用する
// - 死亡時は道具（tool）を落とさず、それ以外を半分落とす
// - リスポーン優先順: ベッド → 最後の休憩地点 → 所属国のマーク（首都）
// 割合・間隔などの数値はユーザー向けに開示しない（探索優先の原則）。
import { itemById } from "./items";
import {
  HP_MAX, HUNGER_MAX, removeItem,
  type PlayerProfile, type RespawnPoint, type StatusEffect,
} from "./profile";

/** 空腹の減少（/秒）。満腹 100 → 0 まで約20分。 */
export const HUNGER_DRAIN_PER_SEC = 100 / 1200;
/** 飢え（空腹0）で HP が減る量（/秒）。 */
export const STARVE_HP_PER_SEC = 0.5;
/** 毒のダメージ（/tick）。 */
export const POISON_DAMAGE = 2;
/** 毒の tick 間隔（ミリ秒）。 */
export const POISON_TICK_MS = 3000;
/** 毒の継続時間（ミリ秒）。 */
export const POISON_DURATION_MS = 30000;
/** 毒を持つモブが毒を与える確率。 */
export const POISON_CHANCE = 0.35;
/** 毒を与えるモブ。 */
export const POISON_MOB_IDS: ReadonlySet<string> = new Set(["spider", "spider_queen", "bee"]);
/** モブ接触ダメージの最小間隔（ミリ秒）。クライアントの接触発火間隔と一致。 */
export const MOB_DAMAGE_COOLDOWN_MS = 1000;
/** バイタル精算で進める時間の上限（ミリ秒）。長期離脱で即死させない。 */
export const VITAL_SETTLE_CAP_MS = 30 * 60 * 1000;
/** 死亡時に落とす割合（道具以外、各アイテムの半分を落とす）。 */
export const DEATH_DROP_RATE = 0.5;
/** リスポーン直後の HP / 空腹。 */
export const RESPAWN_HP = HP_MAX;
export const RESPAWN_HUNGER = 50;

export function isPoisoned(profile: PlayerProfile, now: number): boolean {
  return Array.isArray(profile.status) && profile.status.some((e) => e.kind === "poison" && e.until > now);
}

function statusOf(profile: PlayerProfile): StatusEffect[] {
  return Array.isArray(profile.status) ? profile.status : [];
}

/** 毒を付ける（既に毒なら期限を延長するだけ）。 */
export function applyPoison(profile: PlayerProfile, now: number): PlayerProfile {
  const until = now + POISON_DURATION_MS;
  const rest = statusOf(profile).filter((e) => e.kind !== "poison");
  return { ...profile, status: [...rest, { kind: "poison" as const, until }] };
}

/** 毒を治す。 */
export function curePoison(profile: PlayerProfile): PlayerProfile {
  if (!statusOf(profile).some((e) => e.kind === "poison")) return profile;
  return { ...profile, status: statusOf(profile).filter((e) => e.kind !== "poison") };
}

/**
 * バイタルを now まで精算する: 空腹の減少、毒の tick、飢えの HP 減少。
 * vitalAt が 0（未精算）なら now を起点にするだけ。精算で進める時間は
 * VITAL_SETTLE_CAP_MS で頭打ちにする。戻り値の died は精算で HP が 0 に
 * なったことを示す（死亡処理そのものは applyDeath が担う）。
 */
export function stepVitals(
  profile: PlayerProfile,
  now: number,
): { profile: PlayerProfile; died: boolean } {
  if (profile.vitalAt <= 0 || now <= profile.vitalAt) {
    return { profile: { ...profile, vitalAt: now }, died: profile.hp <= 0 };
  }
  const elapsedMs = Math.min(now - profile.vitalAt, VITAL_SETTLE_CAP_MS);
  const elapsedSec = elapsedMs / 1000;
  let hunger = profile.hunger;
  let hp = profile.hp;
  // 空腹の減少と、空腹0の間の飢えダメージ
  const hungerBefore = hunger;
  hunger = Math.max(0, hunger - HUNGER_DRAIN_PER_SEC * elapsedSec);
  const starveSec = hungerBefore <= 0
    ? elapsedSec
    : Math.max(0, elapsedSec - hungerBefore / HUNGER_DRAIN_PER_SEC);
  hp -= STARVE_HP_PER_SEC * starveSec;
  // 毒: 生存区間の tick 回数ぶん削り、期限切れは掃除する
  let status: StatusEffect[] = [];
  for (const e of statusOf(profile)) {
    if (e.kind === "poison") {
      const activeMs = Math.max(0, Math.min(e.until, now) - profile.vitalAt);
      const ticks = Math.floor(activeMs / POISON_TICK_MS);
      hp -= POISON_DAMAGE * ticks;
      if (e.until > now) status.push(e);
    } else {
      status.push(e);
    }
  }
  hp = Math.max(0, Math.floor(hp));
  return {
    profile: { ...profile, hunger: Math.floor(hunger), hp, status, vitalAt: now },
    died: hp <= 0,
  };
}

/**
 * モブの接触ダメージを適用する。配置・距離の検証は API ルート側が済ませ、
 * ここは「攻撃力・クールダウン・毒・死亡可否」の規則だけを持つ。
 * applied=false のときはクールダウン中（profile は vitalAt 精算済みのもの）。
 */
export function applyMobDamage(
  profile: PlayerProfile,
  mobId: string,
  attack: number,
  now: number,
  rng: () => number = Math.random,
): { profile: PlayerProfile; applied: boolean; died: boolean; poisoned: boolean } {
  const settled = stepVitals(profile, now).profile;
  if (now - settled.lastDamageAt < MOB_DAMAGE_COOLDOWN_MS || settled.hp <= 0) {
    return { profile: settled, applied: false, died: settled.hp <= 0, poisoned: false };
  }
  let next: PlayerProfile = {
    ...settled,
    hp: Math.max(0, settled.hp - Math.max(0, Math.floor(attack))),
    lastDamageAt: now,
  };
  let poisoned = false;
  if (next.hp > 0 && POISON_MOB_IDS.has(mobId) && rng() < POISON_CHANCE) {
    next = applyPoison(next, now);
    poisoned = true;
  }
  return { profile: next, applied: true, died: next.hp <= 0, poisoned };
}

/**
 * 食事・薬の効果を適用する（消費はしない。消費は economy.eatItem が担い、
 * 効果の数式はここを正とする）。hunger / heal / curePoison を持つアイテム
 * が対象で、それ以外は null。
 */
export function consumeEffect(
  profile: PlayerProfile,
  itemId: string,
): { profile: PlayerProfile; hungerGain: number; hpGain: number; cured: boolean } | null {
  const item = itemById(itemId);
  if (!item || (!item.hunger && !item.heal && !item.curePoison)) return null;
  let next = profile;
  let cured = false;
  if (item.curePoison) {
    cured = statusOf(next).some((e) => e.kind === "poison");
    next = curePoison(next);
  }
  const hungerGain = item.hunger ? Math.min(HUNGER_MAX, next.hunger + item.hunger) - next.hunger : 0;
  const hpGain = item.heal ? Math.min(HP_MAX, next.hp + item.heal) - next.hp : 0;
  next = { ...next, hunger: next.hunger + hungerGain, hp: next.hp + hpGain };
  return { profile: next, hungerGain, hpGain, cured };
}

/**
 * 死亡処理: 道具（category "tool"）は落とさず、それ以外の所持品を
 * 各アイテム半分（切り捨て）落とす。落とした分は dropped に返す
 * （このバッチでは世界に残さず消える。回収は将来のドロップ実体で）。
 * HP はリスポーン値に戻し、空腹は RESPAWN_HUNGER、毒は消え、死亡回数+1。
 */
export function applyDeath(
  profile: PlayerProfile,
  now: number,
): { profile: PlayerProfile; dropped: Record<string, number> } {
  const dropped: Record<string, number> = {};
  let next = profile;
  for (const [itemId, count] of Object.entries(profile.items)) {
    const def = itemById(itemId);
    if (!def || def.category === "tool") continue;
    const drop = Math.floor(count * DEATH_DROP_RATE);
    if (drop <= 0) continue;
    const removed = removeItem(next, itemId, drop);
    if (removed) {
      next = removed;
      dropped[itemId] = drop;
    }
  }
  return {
    profile: {
      ...next,
      hp: RESPAWN_HP,
      hunger: Math.max(next.hunger, RESPAWN_HUNGER),
      status: [],
      vitalAt: now,
      lastDamageAt: now,
      deaths: (typeof next.deaths === "number" ? next.deaths : 0) + 1,
    },
    dropped,
  };
}

/** リスポーン先の解決: ベッド → 最後の休憩地点 → 所属国のマーク（首都）。 */
export function resolveRespawnPoint(
  profile: PlayerProfile,
  unionMark: RespawnPoint | null,
  fallback: RespawnPoint,
): { point: RespawnPoint; source: "bed" | "rest" | "mark" | "spawn" } {
  if (profile.respawn) return { point: profile.respawn, source: "bed" };
  if (profile.restPoint) return { point: profile.restPoint, source: "rest" };
  if (unionMark) return { point: unionMark, source: "mark" };
  return { point: fallback, source: "spawn" };
}

/** ベッドのリスポーン点を記録する（ベッドの隣のタイルを点とする）。 */
export function setBedRespawn(
  profile: PlayerProfile,
  bedX: number,
  bedY: number,
): PlayerProfile {
  return { ...profile, respawn: { x: bedX + 0.5, y: bedY + 0.5 } };
}

/** 休憩地点を記録し、HP 全回復・毒を消す（休憩ポッド/噴水と同じ休息の扱い）。 */
export function applyRest(
  profile: PlayerProfile,
  point: RespawnPoint | null,
  now: number,
): PlayerProfile {
  return {
    ...profile,
    hp: HP_MAX,
    status: [],
    vitalAt: now,
    ...(point ? { restPoint: point } : {}),
  };
}

/** 所持する道具の総数（死亡で失わないことの検証用ヘルパー）。 */
export function toolCount(profile: PlayerProfile): number {
  let n = 0;
  for (const [itemId, count] of Object.entries(profile.items)) {
    if (itemById(itemId)?.category === "tool") n += count;
  }
  return n;
}
