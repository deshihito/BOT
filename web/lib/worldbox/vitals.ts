// AGO WORLD BOX のプレイヤーバイタル（純粋ロジック、DOM 非依存）。
// HP・空腹・毒・死亡・リスポーンの規則はここに集約し、保存は呼び出し側
// （API ルート）が profile（bot_kv worldbox_profiles）に対して行う。
// 状態そのものは PlayerProfile の hp / hunger / status / vitalAt 等に載る。
// - 空腹は時間で減る（放置では満腹から空まで約4時間。移動・ダッシュでは
//   少し速くなる。活動クラスはサーバー側が位置変化の平均速度から判定する）、
//   0 が続くと HP が減る
// - 毒は一定間隔で HP を削り、時間経過か解毒で消える
// - モブの接触ダメージはサーバー側が配置と距離を検証してからここで適用する
// - プレイヤー同士の攻撃（PvP）も同じ被弾規則（精算・保護・クールダウン）で適用する
// - 死亡時は道具（tool）を落とさず、それ以外を半分落とす
// - リスポーン優先順: ベッド → 最後の休憩地点 → 所属国のマーク（首都）
// 割合・間隔などの数値はユーザー向けに開示しない（探索優先の原則）。
import { ITEMS, itemById } from "./items";
import {
  HP_MAX, HUNGER_MAX, maxHpFor, MEDIC_HEAL_MULT, removeItem,
  type PlayerProfile, type RespawnPoint, type StatusEffect,
} from "./profile";


/** 空腹の活動クラス（サーバー側が位置変化の平均速度から判定する）。 */
export type HungerActivity = "idle" | "move" | "dash";
/** 放置中の空腹の減少（/秒）。満腹 100 → 0 まで約4時間。 */
export const HUNGER_DRAIN_IDLE_PER_SEC = 100 / 14400;
/** 移動中の空腹の減少倍率（対 放置）。 */
export const HUNGER_MOVE_MULT = 1.6;
/** ダッシュ中の空腹の減少倍率（対 放置）。 */
export const HUNGER_DASH_MULT = 2.5;

/** 活動クラスの空腹の減少（/秒）。 */
export function hungerDrainPerSec(activity: HungerActivity): number {
  if (activity === "dash") return HUNGER_DRAIN_IDLE_PER_SEC * HUNGER_DASH_MULT;
  if (activity === "move") return HUNGER_DRAIN_IDLE_PER_SEC * HUNGER_MOVE_MULT;
  return HUNGER_DRAIN_IDLE_PER_SEC;
}

/**
 * 活動判定に使う平均速度の上限（タイル/秒）。歩行 4.4 / 泳ぎ 3.0 /
 * ダッシュ泳 5.4 / ダッシュ 7.0 が根拠で、テレポート等の跳びは
 * この速度で頭打ちにして過大評価しない。
 */
export const ACTIVITY_SPEED_CAP = 7;
/** この平均速度未満は放置（idle）。 */
export const ACTIVITY_IDLE_MAX_SPEED = 0.3;
/** この平均速度以上はダッシュ（dash）。未満は移動（move）。 */
export const ACTIVITY_DASH_MIN_SPEED = 5.6;

/** 平均速度（タイル/秒）から活動クラスを決める。 */
export function classifyActivity(avgSpeed: number): HungerActivity {
  if (!Number.isFinite(avgSpeed)) return "idle";
  const s = Math.min(Math.max(0, avgSpeed), ACTIVITY_SPEED_CAP);
  if (s < ACTIVITY_IDLE_MAX_SPEED) return "idle";
  if (s < ACTIVITY_DASH_MIN_SPEED) return "move";
  return "dash";
}

/**
 * 精算窓の活動クラス: 前回精算位置と現在位置の平均速度で決める。
 * 前回位置が無い・空間が変わった・現在位置が不明・窓が無い場合は idle
 * （空間が変わった窓は移動として数えない）。
 */
export function activityForWindow(
  prev: { x: number; y: number; space: string } | null,
  cur: { x: number; y: number; space: string } | null,
  elapsedSec: number,
): HungerActivity {
  if (!prev || !cur || prev.space !== cur.space || !(elapsedSec > 0)) return "idle";
  return classifyActivity(Math.hypot(cur.x - prev.x, cur.y - prev.y) / elapsedSec);
}
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
export const POISON_MOB_IDS: ReadonlySet<string> = new Set(["spider", "spider_queen", "bee", "jellyfish"]);
/** モブ接触ダメージの最小間隔（ミリ秒）。クライアントの接触発火間隔と一致。 */
export const MOB_DAMAGE_COOLDOWN_MS = 1000;
/** バイタル精算で進める時間の上限（ミリ秒）。長期離脱で即死させない。 */
export const VITAL_SETTLE_CAP_MS = 30 * 60 * 1000;
/** 死亡時に落とす割合（道具以外、各アイテムの半分を落とす）。 */
export const DEATH_DROP_RATE = 0.5;
/** リスポーン直後の HP / 空腹。 */
export const RESPAWN_HP = HP_MAX;

/** そのプレイヤーの最大 HP（守護ボーナス込み）。 */
export { maxHpFor };
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
/**
 * 持続効果（バフ）の長さ。定義の正はアイテム側（ItemDef.buff.minutes）で、
 * ここは種類ごとの代表アイテムから導出するだけ（二重定義にしない）。
 * バフ持ちアイテムが無い種類は従来値にフォールバックする。
 */
function buffDurationFromCatalog(kind: "warm" | "alert", fallbackMinutes: number): number {
  const def = ITEMS.find((i) => i.buff?.kind === kind);
  return (def?.buff?.minutes ?? fallbackMinutes) * 60 * 1000;
}
export const BUFF_DURATION_MS: Record<"warm" | "alert", number> = {
  warm: buffDurationFromCatalog("warm", 10),
  alert: buffDurationFromCatalog("alert", 5),
};
/** warm の間、空腹の減りがこの倍率になる。 */
export const WARM_HUNGER_MULT = 0.6;
/** alert の間、満腹（50超）なら HP が回復する量（/秒）。 */
export const ALERT_REGEN_PER_SEC = 0.2;

/** バフを付ける（同種は付け直し）。 */
export function applyBuff(
  profile: PlayerProfile,
  kind: "warm" | "alert",
  now: number,
): PlayerProfile {
  const status = statusOf(profile).filter((e) => e.kind !== kind);
  status.push({ kind, until: now + BUFF_DURATION_MS[kind] });
  return { ...profile, status };
}

/** バフが精算窓 [vitalAt, now] と重なる秒数（過剰計算を避けるため毒と同じ窓方式）。 */
function buffActiveSec(profile: PlayerProfile, kind: "warm" | "alert", now: number): number {
  const e = statusOf(profile).find((x) => x.kind === kind);
  if (!e) return 0;
  const start = Math.max(profile.vitalAt, e.until - BUFF_DURATION_MS[kind]);
  return Math.max(0, Math.min(e.until, now) - start) / 1000;
}

/**
 * バフが精算窓 [vitalAt, windowEnd] と重なる区間（窓起点からの秒）。
 * 重なりが無ければ null。windowEnd は精算キャップ後の窓の終端。
 */
function buffWindowSec(
  profile: PlayerProfile,
  kind: "warm" | "alert",
  windowEnd: number,
): { startSec: number; endSec: number } | null {
  const e = statusOf(profile).find((x) => x.kind === kind);
  if (!e) return null;
  const start = Math.max(profile.vitalAt, e.until - BUFF_DURATION_MS[kind]);
  const end = Math.min(e.until, windowEnd);
  if (end <= start) return null;
  return { startSec: (start - profile.vitalAt) / 1000, endSec: (end - profile.vitalAt) / 1000 };
}

/**
 * 空腹 amount が実効レートで尽きるまでの秒数。実効レートは活動クラスの
 * レートで、warm 区間だけ WARM_HUNGER_MULT 倍になる（区間ごとに積算する）。
 */
function secondsUntilHungerEmpty(
  amount: number,
  rate: number,
  warmWin: { startSec: number; endSec: number } | null,
  elapsedSec: number,
): number {
  const segments = warmWin
    ? [
        { from: 0, to: warmWin.startSec, mult: 1 },
        { from: warmWin.startSec, to: warmWin.endSec, mult: WARM_HUNGER_MULT },
        { from: warmWin.endSec, to: elapsedSec, mult: 1 },
      ]
    : [{ from: 0, to: elapsedSec, mult: 1 }];
  let remaining = amount;
  for (const seg of segments) {
    const segRate = rate * seg.mult;
    const segDrain = segRate * (seg.to - seg.from);
    if (remaining > segDrain) {
      remaining -= segDrain;
      continue;
    }
    return seg.from + remaining / segRate;
  }
  return elapsedSec;
}

export function stepVitals(
  profile: PlayerProfile,
  now: number,
  activity: HungerActivity = "idle",
): { profile: PlayerProfile; died: boolean } {
  if (profile.vitalAt <= 0 || now <= profile.vitalAt) {
    return { profile: { ...profile, vitalAt: now }, died: profile.hp <= 0 };
  }
  const elapsedMs = Math.min(now - profile.vitalAt, VITAL_SETTLE_CAP_MS);
  const elapsedSec = elapsedMs / 1000;
  const windowEnd = profile.vitalAt + elapsedMs;
  let hunger = profile.hunger;
  let hp = profile.hp;
  // 空腹の減少と、空腹0の間の飢えダメージ。減少レートは活動クラスで変わり、
  // warm（温かい食事）の間はさらに緩やかになる。飢えの開始時刻は、窓内の
  // 実効レート（活動 × warm）で空腹が尽きる時刻として求める。
  const hungerBefore = hunger;
  const rate = hungerDrainPerSec(activity);
  const warmWin = buffWindowSec(profile, "warm", windowEnd);
  const warmSec = warmWin ? warmWin.endSec - warmWin.startSec : 0;
  const drainSec = elapsedSec - warmSec + warmSec * WARM_HUNGER_MULT;
  hunger = Math.max(0, hunger - rate * drainSec);
  let starveSec = 0;
  if (hungerBefore <= 0) starveSec = elapsedSec;
  else if (hunger <= 0) starveSec = elapsedSec - secondsUntilHungerEmpty(hungerBefore, rate, warmWin, elapsedSec);
  hp -= STARVE_HP_PER_SEC * starveSec;
  // alert（はちみつティー等）の間、満腹なら少しずつ回復する
  const alertSec = buffActiveSec(profile, "alert", now);
  if (alertSec > 0 && hungerBefore > 50) {
    hp = Math.min(maxHpFor(profile), hp + ALERT_REGEN_PER_SEC * alertSec);
  }
  // 毒: 生存区間の長さに比例して削り、期限切れは掃除する。
  // 毒の有効窓は [until - POISON_DURATION_MS, until] で、vitalAt は起点に
  // しない。罠は精算なしで毒を付けるため vitalAt が古いままになることが
  // あり、vitalAt 起点だと古さぶん tick を過剰に数えて即死する（S5）。
  // ダメージは tick 単位で切り捨てず比例計算にする: 精算窓ごとに
  // floor すると3秒未満の端数が毎回消え、頻繁な精算で毒が無力化する。
  // 窓は vitalAt 起点で連続するので、比例ぶんの合計は一括精算と一致する。
  let status: StatusEffect[] = [];
  for (const e of statusOf(profile)) {
    if (e.kind === "poison") {
      const poisonStart = Math.max(profile.vitalAt, e.until - POISON_DURATION_MS);
      const activeMs = Math.max(0, Math.min(e.until, now) - poisonStart);
      hp -= POISON_DAMAGE * (activeMs / POISON_TICK_MS);
      if (e.until > now) status.push(e);
    } else {
      status.push(e);
    }
  }
  // HP・空腹は端数を保持する（profile.ts の clampVital と同じ理由）。
  // 精算ごとに整数化すると、放置の空腹減少（15秒で約0.1）が毎回 -1 に
  // 化けて約25分で空になり、活動倍率の差も消える。
  hp = Math.round(Math.max(0, hp) * 1000) / 1000;
  return {
    profile: { ...profile, hunger: Math.round(hunger * 1000) / 1000, hp, status, vitalAt: now },
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
  // スポーン保護中（新規プレイヤーの最初の数分）はモブのダメージを受けない
  if ((settled.spawnProtectedUntil ?? 0) > now) {
    return { profile: settled, applied: false, died: false, poisoned: false };
  }
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

/** 環境ハザード（設置ブロック）の接触ダメージ量。足元のタイルで判定する。 */
export const HAZARD_DAMAGE: Readonly<Record<string, number>> = {
  cactus_block: 4,
  magma_block: 10,
};

/** そのアイテムが環境ハザードならダメージ量、違えば 0。 */
export function hazardDamageFor(itemId: string | null | undefined): number {
  return itemId ? (HAZARD_DAMAGE[itemId] ?? 0) : 0;
}

/**
 * 環境ハザードのダメージを適用する。モブ接触（applyMobDamage）と同じ規則:
 * バイタル精算の後、スポーン保護中は無効、被弾クールダウン
 * （MOB_DAMAGE_COOLDOWN_MS を共有）中も無効。位置とタイルの検証は
 * API ルート側がサーバー位置で行う（申告位置は使わない）。
 */
export function applyHazardDamage(
  profile: PlayerProfile,
  amount: number,
  now: number,
): { profile: PlayerProfile; applied: boolean; died: boolean } {
  const settled = stepVitals(profile, now).profile;
  if ((settled.spawnProtectedUntil ?? 0) > now) {
    return { profile: settled, applied: false, died: false };
  }
  if (now - settled.lastDamageAt < MOB_DAMAGE_COOLDOWN_MS || settled.hp <= 0) {
    return { profile: settled, applied: false, died: settled.hp <= 0 };
  }
  const next: PlayerProfile = {
    ...settled,
    hp: Math.max(0, settled.hp - Math.max(0, Math.floor(amount))),
    lastDamageAt: now,
  };
  return { profile: next, applied: true, died: next.hp <= 0 };
}

/** PvP の攻撃が届く距離（ユークリッド）。剣の間合い2＋見た目の余裕。 */
export const PVP_ATTACK_MAX_DISTANCE = 2.5;

/** PvP ができるインスタンス空間の ID 形式（洞窟・遺跡のみ。ダンジョンは協力なので不可）。 */
const PVP_INSTANCE_SPACE_RE = /^(cave|ruins):-?\d+,-?\d+:\d+$/;

/**
 * PvP が許可される空間か。ワールドと洞窟・遺跡のインスタンスだけが対象で、
 * ロビー系・テント・ダンジョン（パーティ協力）では不可。
 * （このファイルは単体でトランスパイルされるため、インスタンス空間の
 * 正規表現は instances.ts から import せず複製する。形式の正は instances.ts。）
 */
export function pvpSpaceAllowed(space: unknown): boolean {
  if (space === "world") return true;
  if (typeof space !== "string") return false;
  return PVP_INSTANCE_SPACE_RE.test(space);
}

/**
 * プレイヤーからの攻撃ダメージを適用する。モブの接触ダメージ
 * （applyMobDamage）と同じ形: 先にバイタルを精算し、スポーン保護中は
 * 無効、被弾クールダウン（MOB_DAMAGE_COOLDOWN_MS を共有）中も無効。
 * 毒は無い。ダメージ量の式（arena の playerAttack、剣士倍率）は
 * 呼び出し側が算出して渡す。
 */
export function applyPvpDamage(
  profile: PlayerProfile,
  attack: number,
  now: number,
): { profile: PlayerProfile; applied: boolean; died: boolean; damage: number } {
  const settled = stepVitals(profile, now).profile;
  // スポーン保護中（新規プレイヤーの最初の数分）はプレイヤーの攻撃も受けない
  if ((settled.spawnProtectedUntil ?? 0) > now) {
    return { profile: settled, applied: false, died: false, damage: 0 };
  }
  if (now - settled.lastDamageAt < MOB_DAMAGE_COOLDOWN_MS || settled.hp <= 0) {
    return { profile: settled, applied: false, died: settled.hp <= 0, damage: 0 };
  }
  const damage = Math.max(0, Math.floor(attack));
  const next: PlayerProfile = {
    ...settled,
    hp: Math.max(0, settled.hp - damage),
    lastDamageAt: now,
  };
  return { profile: next, applied: true, died: next.hp <= 0, damage };
}

/**
 * 食事・薬の効果を適用する（消費はしない。消費は economy.eatItem が担い、
 * 効果の数式はここを正とする）。hunger / heal / curePoison を持つアイテム
 * が対象で、それ以外は null。
 */
export function consumeEffect(
  profile: PlayerProfile,
  itemId: string,
  now: number = Date.now(),
): { profile: PlayerProfile; hungerGain: number; hpGain: number; cured: boolean } | null {
  const item = itemById(itemId);
  if (!item || (!item.hunger && !item.heal && !item.curePoison && !item.buff)) return null;
  let next = profile;
  let cured = false;
  if (item.curePoison) {
    cured = statusOf(next).some((e) => e.kind === "poison");
    next = curePoison(next);
  }
  const hungerGain = item.hunger ? Math.min(HUNGER_MAX, next.hunger + item.hunger) - next.hunger : 0;
  const healAmount = item.heal ? item.heal * (next.role === "medic" ? MEDIC_HEAL_MULT : 1) : 0;
  const hpGain = item.heal ? Math.min(maxHpFor(next), next.hp + healAmount) - next.hp : 0;
  next = { ...next, hunger: next.hunger + hungerGain, hp: next.hp + hpGain };
  if (item.buff) next = applyBuff(next, item.buff.kind, now);
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
      // リスポーンはテレポートなので前回精算位置は捨てる（次の窓は idle から）
      vitalX: undefined,
      vitalY: undefined,
      vitalSpace: undefined,
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
    hp: maxHpFor(profile),
    status: [],
    vitalAt: now,
    ...(point ? { restPoint: point } : {}),
  };
}
