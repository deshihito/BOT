// AGO WORLD BOX のプレイヤープロフィール（純粋ロジック）。
// 仕様書（Discord仮想国家経済MMO 基本仕様書）3.3 の個人データ:
// 空腹度（hunger, 0〜100）と steal のクールダウン時刻に、手持ちの
// インベントリ（ホットバー5枠＝すぐ使う手持ち、ストレージ10枠＝
// 持ち歩く裏の手持ち。マイクラ式）を加えたもの。
// 所持金の正は AGO コイン本体（economy-bridge / 案B）であり、
// coins フィールドは旧ローカル残高の互換のため読み込みだけ許容し、
// ロジック・表示では一切使わない（書き戻しても値はそのまま）。
// items フィールドは「スロット＋あふれ分」の集計ビューとして常に
// 同期される（読み取り専用のつもりで扱うこと）。保存・通信は
// profile-online.ts / API ルート側が担い、ここは検証とインベントリ
// 操作だけを行う。経済の状態遷移は economy.ts。
/** 冒険役職 ID（プロフィールが所有する。規則は roles.ts）。 */
export type AdventureRoleId = "free" | "blade" | "guard" | "scout" | "miner" | "medic";
export const ADVENTURE_ROLE_IDS: readonly AdventureRoleId[] = ["free", "blade", "guard", "scout", "miner", "medic"];
/** 守護の最大 HP ボーナス。 */
export const GUARD_HP_BONUS = 20;
/** 薬師の回復アイテム倍率。 */
export const MEDIC_HEAL_MULT = 1.5;
/** 役職込みの最大 HP。 */
export function maxHpFor(profile: PlayerProfile): number {
  return HP_MAX + (profile.role === "guard" ? GUARD_HP_BONUS : 0);
}

export function isAdventureRoleId(v: unknown): v is AdventureRoleId {
  return typeof v === "string" && (ADVENTURE_ROLE_IDS as readonly string[]).includes(v);
}
import { itemById } from "./items";

/** 空腹度の上限（仕様書 3.3: 0〜100）。 */
export const HUNGER_MAX = 100;
/** プレイヤー HP の上限。 */
export const HP_MAX = 100;

/** 状態異常の種類。poison は時間で HP が減り、解毒で消える。 */
export type StatusKind = "poison" | "warm" | "alert";
/** 状態異常1件（終了時刻つき）。 */
export type StatusEffect = { kind: StatusKind; until: number };
/** ワールド座標のリスポーン候補（タイル単位の浮動小数）。 */
export type RespawnPoint = { x: number; y: number };
/** 旧ローカル残高の初期値（互換のためだけに残す。実残高はブリッジ側）。 */
export const STARTING_COINS = 100;

/** ホットバーの枠数（すぐ使える手持ち）。 */
export const HOTBAR_SLOTS = 5;
/** ストレージの枠数（持ち歩く裏の手持ち）。 */
export const STORAGE_SLOTS = 10;
/** 1枠に積める最大数。 */
export const STACK_MAX = 99;

/** インベントリの1枠。空きは null。 */
export type ItemSlot = { id: string; count: number } | null;

export type PlayerProfile = {
  /** 廃止: 旧ローカル残高。読み込み互換のためだけに保持し、使わない。 */
  coins: number;
  hunger: number;
  /** プレイヤー HP（0〜HP_MAX）。0 で死亡し、死亡処理は vitals.ts。 */
  hp: number;
  /** 状態異常（毒など）。 */
  status: StatusEffect[];
  /** バイタル（空腹・毒・飢え）を最後に精算した時刻（epoch ms）。0 は未精算。 */
  vitalAt: number;
  /** ベッドで設定したリスポーン点（ワールド座標）。無ければ null。 */
  respawn: RespawnPoint | null;
  /** 最後に休憩した地点（ワールド座標）。無ければ null。 */
  restPoint: RespawnPoint | null;
  /** 最後にモブからダメージを受けた時刻（epoch ms）。接触ダメージの間隔管理。 */
  lastDamageAt: number;
  /** 累計の死亡回数。 */
  deaths: number;
  /** 集計ビュー: 全アイテムID → 総所持数（スロット＋あふれ分）。 */
  items: Record<string, number>;
  /** ホットバー（すぐ使う手持ち、HOTBAR_SLOTS 枠）。 */
  hotbar: ItemSlot[];
  /** ストレージ（持ち歩く裏の手持ち、STORAGE_SLOTS 枠）。 */
  storage: ItemSlot[];
  /** 最後に steal を実行した時刻（epoch ms）。 */
  stealActorAt: number;
  /** 最後に steal された時刻（epoch ms）。 */
  stealTargetAt: number;
  /** 冒険役職（自由人/剣士/守護/斥候/採掘者/薬師）。 */
  role: AdventureRoleId;
  /** 役職ごとの熟練 XP（ランクは roles.rankForXp で導出）。 */
  mastery: Partial<Record<AdventureRoleId, { xp: number }>>;
  /** 技ごとの最終発動時刻（epoch ms）。クールタイム検証はサーバー側。 */
  skillAt: Record<string, number>;
  /** 守護の挑発が有効な時刻（epoch ms）。 */
  tauntUntil: number;
  /** 薬師の蘇生を使った遠征（空間 ID と時刻）。1遠征1回の判定に使う。 */
  reviveMark: { space: string; at: number } | null;
  /** テント（個人空間）の拡張段階 0..2。 */
  tentTier: number;
  /** 道具の強化レベル（アイテム ID → 0..3）。 */
  enhance: Record<string, number>;
  /** 蘇生で戻される先（次回 sync でクライアントが適用し、サーバーが消す）。 */
  pendingTeleport: { space: string; x: number; y: number } | null;
};

function emptySlots(size: number): ItemSlot[] {
  return Array.from({ length: size }, () => null);
}

export const DEFAULT_PROFILE: PlayerProfile = {
  role: "free",
  mastery: {},
  skillAt: {},
  tauntUntil: 0,
  reviveMark: null,
  pendingTeleport: null,
  tentTier: 0,
  enhance: {},
  coins: STARTING_COINS,
  hunger: HUNGER_MAX,
  hp: HP_MAX,
  status: [],
  vitalAt: 0,
  respawn: null,
  restPoint: null,
  lastDamageAt: 0,
  deaths: 0,
  items: {},
  hotbar: emptySlots(HOTBAR_SLOTS),
  storage: emptySlots(STORAGE_SLOTS),
  stealActorAt: 0,
  stealTargetAt: 0,
};

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(v)));
}

function parseItems(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const items: Record<string, number> = {};
  for (const [id, count] of Object.entries(raw as Record<string, unknown>)) {
    if (!itemById(id)) continue; // 定義が無いアイテムは捨てる
    const n = clampInt(count, 0, 9999, 0);
    if (n > 0) items[id] = n;
  }
  return items;
}

function parseSlot(raw: unknown): ItemSlot {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const v = raw as { id?: unknown; count?: unknown };
  if (!itemById(v.id)) return null;
  const n = clampInt(v.count, 1, STACK_MAX, 0);
  return n > 0 ? { id: v.id as string, count: n } : null;
}

/** 枠配列を読む。配列でなければ null（＝旧形式で移行が必要）。 */
function parseSlots(raw: unknown, size: number): ItemSlot[] | null {
  if (!Array.isArray(raw)) return null;
  const out = emptySlots(size);
  for (let i = 0; i < Math.min(size, raw.length); i++) out[i] = parseSlot(raw[i]);
  return out;
}

function slotTotal(slots: readonly ItemSlot[], itemId: string): number {
  let n = 0;
  for (const s of slots) if (s && s.id === itemId) n += s.count;
  return n;
}

/**
 * 集計（総数）から枠へ注ぐ（移行用）。枠に入りきらない分は集計側に
 * 「あふれ分」として残るため、総数は変わらない（ロスレス）。
 */
function pourIntoSlots(totals: Record<string, number>, hotbar: ItemSlot[], storage: ItemSlot[]): void {
  const all = [...hotbar, ...storage];
  for (const id of Object.keys(totals)) {
    let remaining = totals[id] - (slotTotal(hotbar, id) + slotTotal(storage, id));
    for (const slot of all) {
      if (remaining <= 0) break;
      if (slot && slot.id === id && slot.count < STACK_MAX) {
        const add = Math.min(STACK_MAX - slot.count, remaining);
        slot.count += add;
        remaining -= add;
      }
    }
    for (let i = 0; i < all.length; i++) {
      if (remaining <= 0) break;
      if (all[i] === null) {
        const put = Math.min(STACK_MAX, remaining);
        all[i] = { id, count: put };
        remaining -= put;
      }
    }
    // all は hotbar/storage のコピー参照を含む配列ではないため、書き戻す
    for (let i = 0; i < hotbar.length; i++) hotbar[i] = all[i];
    for (let i = 0; i < storage.length; i++) storage[i] = all[hotbar.length + i];
  }
}

type InvView = { hotbar: ItemSlot[]; storage: ItemSlot[]; items: Record<string, number> };

/**
 * どんな形のプロフィールからでもインベントリを取り出す（読み取り用）。
 * 枠が無い旧形式は集計から注いだ状態として扱う。
 */
function invOf(profile: PlayerProfile): InvView {
  const items = parseItems(profile.items);
  let hotbar = parseSlots(profile.hotbar, HOTBAR_SLOTS);
  let storage = parseSlots(profile.storage, STORAGE_SLOTS);
  if (hotbar === null || storage === null) {
    hotbar = emptySlots(HOTBAR_SLOTS);
    storage = emptySlots(STORAGE_SLOTS);
    pourIntoSlots(items, hotbar, storage);
  }
  // 枠にあるのに集計に無い分は失わない（集計を枠に合わせて底上げする）
  for (const slot of [...hotbar, ...storage]) {
    if (!slot) continue;
    const slotted = slotTotal(hotbar, slot.id) + slotTotal(storage, slot.id);
    if ((items[slot.id] ?? 0) < slotted) items[slot.id] = slotted;
  }
  return { hotbar, storage, items };
}

/** 壊れたデータは既定値に落とす（範囲外はクランプ）。文字列でもオブジェクトでも受ける。 */
export function parseProfile(raw: unknown): PlayerProfile {
  let data: Record<string, unknown> | null = null;
  if (typeof raw === "string") {
    try {
      data = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return { ...DEFAULT_PROFILE, items: {}, hotbar: emptySlots(HOTBAR_SLOTS), storage: emptySlots(STORAGE_SLOTS), status: [], mastery: {}, skillAt: {} };
    }
  } else if (raw && typeof raw === "object") {
    data = raw as Record<string, unknown>;
  }
  if (!data) {
    return { ...DEFAULT_PROFILE, items: {}, hotbar: emptySlots(HOTBAR_SLOTS), storage: emptySlots(STORAGE_SLOTS), status: [], mastery: {}, skillAt: {} };
  }
  const inv = invOf({
    coins: 0, hunger: 0, hp: HP_MAX, status: [], vitalAt: 0, respawn: null, restPoint: null, lastDamageAt: 0, deaths: 0, stealActorAt: 0, stealTargetAt: 0,
    role: "free", mastery: {}, skillAt: {}, tauntUntil: 0, reviveMark: null, pendingTeleport: null, tentTier: 0, enhance: {},
    items: data.items as Record<string, number>,
    hotbar: data.hotbar as ItemSlot[],
    storage: data.storage as ItemSlot[],
  });
  return {
    coins: clampInt(data.coins, 0, Number.MAX_SAFE_INTEGER, DEFAULT_PROFILE.coins),
    hunger: clampInt(data.hunger, 0, HUNGER_MAX, DEFAULT_PROFILE.hunger),
    hp: clampInt(data.hp, 0, HP_MAX + 20, HP_MAX), // 守護の最大HPボーナス分まで許す
    status: parseStatus(data.status),
    vitalAt: clampInt(data.vitalAt, 0, Number.MAX_SAFE_INTEGER, 0),
    respawn: parsePoint(data.respawn),
    restPoint: parsePoint(data.restPoint),
    lastDamageAt: clampInt(data.lastDamageAt, 0, Number.MAX_SAFE_INTEGER, 0),
    deaths: clampInt(data.deaths, 0, Number.MAX_SAFE_INTEGER, 0),
    items: inv.items,
    hotbar: inv.hotbar,
    storage: inv.storage,
    stealActorAt: clampInt(data.stealActorAt, 0, Number.MAX_SAFE_INTEGER, 0),
    stealTargetAt: clampInt(data.stealTargetAt, 0, Number.MAX_SAFE_INTEGER, 0),
    role: isAdventureRoleId(data.role) ? data.role : "free",
    mastery: parseMastery(data.mastery),
    skillAt: parseSkillAt(data.skillAt),
    tauntUntil: clampInt(data.tauntUntil, 0, Number.MAX_SAFE_INTEGER, 0),
    reviveMark: parseReviveMark(data.reviveMark),
    pendingTeleport: parsePendingTeleport(data.pendingTeleport),
    tentTier: clampInt(data.tentTier, 0, 2, 0),
    enhance: parseEnhance(data.enhance),
  };
}

function parseMastery(raw: unknown): Partial<Record<AdventureRoleId, { xp: number }>> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Partial<Record<AdventureRoleId, { xp: number }>> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!isAdventureRoleId(k)) continue;
    const xp = (v as { xp?: unknown } | null)?.xp;
    if (typeof xp === "number" && Number.isFinite(xp) && xp > 0) out[k] = { xp: Math.floor(xp) };
  }
  return out;
}

function parseSkillAt(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "number" && Number.isFinite(v) && v > 0) out[k] = Math.floor(v);
  }
  return out;
}

function parseReviveMark(raw: unknown): { space: string; at: number } | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const v = raw as { space?: unknown; at?: unknown };
  if (typeof v.space !== "string" || typeof v.at !== "number" || !Number.isFinite(v.at)) return null;
  return { space: v.space.slice(0, 64), at: Math.floor(v.at) };
}

function parsePendingTeleport(raw: unknown): { space: string; x: number; y: number } | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const v = raw as { space?: unknown; x?: unknown; y?: unknown };
  if (typeof v.space !== "string" || typeof v.x !== "number" || typeof v.y !== "number") return null;
  if (!Number.isFinite(v.x) || !Number.isFinite(v.y)) return null;
  return { space: v.space.slice(0, 64), x: v.x, y: v.y };
}

/** 強化レベルの復元（道具以外・範囲外は落とす）。 */
export function parseEnhance(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, number> = {};
  for (const [itemId, level] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof level !== "number" || !Number.isFinite(level)) continue;
    const lv = Math.floor(level);
    if (lv <= 0) continue;
    out[itemId] = Math.min(ENHANCE_MAX_LEVEL, lv);
  }
  return out;
}

/** 道具強化の最大レベル。 */
export const ENHANCE_MAX_LEVEL = 3;
/** 強化1回のコイン価格（レベル+1 ごとにこの額 × (現在レベル+1)）。暫定。 */
export const ENHANCE_BASE_COST = 150;
/** 強化に要る素材（道具の tier ごと）。 */
export const ENHANCE_MATERIALS: Record<number, { itemId: string; count: number }> = {
  1: { itemId: "wood", count: 2 },
  2: { itemId: "stone", count: 2 },
  3: { itemId: "iron_ingot", count: 1 },
  4: { itemId: "mithril", count: 1 },
};

function parseStatus(raw: unknown): StatusEffect[] {
  if (!Array.isArray(raw)) return [];
  const out: StatusEffect[] = [];
  for (const v of raw) {
    if (!v || typeof v !== "object" || Array.isArray(v)) continue;
    const e = v as { kind?: unknown; until?: unknown };
    if (e.kind !== "poison" && e.kind !== "warm" && e.kind !== "alert") continue;
    if (typeof e.until !== "number" || !Number.isFinite(e.until) || e.until <= 0) continue;
    out.push({ kind: e.kind, until: Math.floor(e.until) });
  }
  return out.slice(0, 4);
}

function parsePoint(raw: unknown): RespawnPoint | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const v = raw as { x?: unknown; y?: unknown };
  if (typeof v.x !== "number" || typeof v.y !== "number") return null;
  if (!Number.isFinite(v.x) || !Number.isFinite(v.y)) return null;
  return {
    x: Math.max(-1_000_000, Math.min(1_000_000, v.x)),
    y: Math.max(-1_000_000, Math.min(1_000_000, v.y)),
  };
}

export function serializeProfile(profile: PlayerProfile): string {
  const inv = invOf(profile);
  return JSON.stringify({
    coins: clampInt(profile.coins, 0, Number.MAX_SAFE_INTEGER, 0),
    hunger: clampInt(profile.hunger, 0, HUNGER_MAX, 0),
    hp: clampInt(profile.hp, 0, HP_MAX + 20, HP_MAX),
    status: parseStatus(profile.status),
    vitalAt: clampInt(profile.vitalAt, 0, Number.MAX_SAFE_INTEGER, 0),
    respawn: parsePoint(profile.respawn),
    restPoint: parsePoint(profile.restPoint),
    lastDamageAt: clampInt(profile.lastDamageAt, 0, Number.MAX_SAFE_INTEGER, 0),
    deaths: clampInt(profile.deaths, 0, Number.MAX_SAFE_INTEGER, 0),
    items: inv.items,
    hotbar: inv.hotbar,
    storage: inv.storage,
    stealActorAt: clampInt(profile.stealActorAt, 0, Number.MAX_SAFE_INTEGER, 0),
    stealTargetAt: clampInt(profile.stealTargetAt, 0, Number.MAX_SAFE_INTEGER, 0),
    role: isAdventureRoleId(profile.role) ? profile.role : "free",
    mastery: parseMastery(profile.mastery),
    skillAt: parseSkillAt(profile.skillAt),
    tauntUntil: clampInt(profile.tauntUntil, 0, Number.MAX_SAFE_INTEGER, 0),
    reviveMark: parseReviveMark(profile.reviveMark),
    pendingTeleport: parsePendingTeleport(profile.pendingTeleport),
    tentTier: clampInt(profile.tentTier, 0, 2, 0),
    enhance: parseEnhance(profile.enhance),
  });
}

// ---------------------------------------------------------------- インベントリ
/** 総所持数（ホットバー＋ストレージ＋あふれ分）。 */
export function countItem(profile: PlayerProfile, itemId: string): number {
  const inv = invOf(profile);
  const slotted = slotTotal(inv.hotbar, itemId) + slotTotal(inv.storage, itemId);
  return Math.max(inv.items[itemId] ?? 0, slotted);
}

/** あふれ分（枠に入っていない数）。 */
export function overflowCount(profile: PlayerProfile, itemId: string): number {
  const inv = invOf(profile);
  const slotted = slotTotal(inv.hotbar, itemId) + slotTotal(inv.storage, itemId);
  return Math.max(0, (inv.items[itemId] ?? 0) - slotted);
}

function withInv(profile: PlayerProfile, inv: InvView): PlayerProfile {
  return { ...profile, items: inv.items, hotbar: inv.hotbar, storage: inv.storage };
}

/**
 * アイテムを加える。注ぐ順は「ホットバーの既存スタック →
 * ストレージの既存スタック → ホットバーの空き枠 → ストレージの
 * 空き枠」で、入りきらない分はあふれ分になる（総数は必ず増える）。
 * 負数を渡すとその分だけ減らす（0未満にはならない）。
 */
export function addItem(profile: PlayerProfile, itemId: string, count: number): PlayerProfile {
  if (count < 0) {
    const removed = removeItem(profile, itemId, -count);
    if (removed) return removed;
    // 足りない分はあるだけ減らす（旧 addItem の負数挙動）
    const inv = invOf(profile);
    const total = countItem(profile, itemId);
    const next = { ...inv, hotbar: inv.hotbar.map((s) => (s && s.id === itemId ? null : s)), storage: inv.storage.map((s) => (s && s.id === itemId ? null : s)) };
    const items = { ...next.items };
    if (total + count > 0) items[itemId] = total + count;
    else delete items[itemId];
    return withInv(profile, { ...next, items });
  }
  if (count === 0 || !itemById(itemId)) return profile;
  const inv = invOf(profile);
  const hotbar = inv.hotbar.map((s) => (s ? { ...s } : null));
  const storage = inv.storage.map((s) => (s ? { ...s } : null));
  let remaining = count;
  for (const slots of [hotbar, storage]) {
    for (const slot of slots) {
      if (remaining <= 0) break;
      if (slot && slot.id === itemId && slot.count < STACK_MAX) {
        const add = Math.min(STACK_MAX - slot.count, remaining);
        slot.count += add;
        remaining -= add;
      }
    }
  }
  for (const slots of [hotbar, storage]) {
    for (let i = 0; i < slots.length; i++) {
      if (remaining <= 0) break;
      if (slots[i] === null) {
        const put = Math.min(STACK_MAX, remaining);
        slots[i] = { id: itemId, count: put };
        remaining -= put;
      }
    }
  }
  const items = { ...inv.items };
  items[itemId] = countItem(profile, itemId) + count;
  return withInv(profile, { hotbar, storage, items });
}

/**
 * アイテムを減らす。引き出し順は「ホットバーのスタック →
 * ストレージのスタック → あふれ分」。足りなければ null（何も変えない）。
 */
export function removeItem(
  profile: PlayerProfile,
  itemId: string,
  count: number,
): PlayerProfile | null {
  if (count <= 0) return profile;
  if (countItem(profile, itemId) < count) return null;
  const inv = invOf(profile);
  const hotbar = inv.hotbar.map((s) => (s ? { ...s } : null));
  const storage = inv.storage.map((s) => (s ? { ...s } : null));
  let remaining = count;
  for (const slots of [hotbar, storage]) {
    for (let i = 0; i < slots.length; i++) {
      if (remaining <= 0) break;
      const slot = slots[i];
      if (slot && slot.id === itemId) {
        const take = Math.min(slot.count, remaining);
        slot.count -= take;
        remaining -= take;
        if (slot.count <= 0) slots[i] = null;
      }
    }
  }
  // remaining はあふれ分から引かれる（集計だけを減らせばよい）
  const items = { ...inv.items };
  const next = countItem(profile, itemId) - count;
  if (next > 0) items[itemId] = next;
  else delete items[itemId];
  return withInv(profile, { hotbar, storage, items });
}

/** ホットバーとストレージの枠を入れ替える。添字が不正なら null。 */
export function swapSlots(
  profile: PlayerProfile,
  hotbarIndex: unknown,
  storageIndex: unknown,
): PlayerProfile | null {
  if (typeof hotbarIndex !== "number" || typeof storageIndex !== "number") return null;
  const hi = Math.floor(hotbarIndex);
  const si = Math.floor(storageIndex);
  if (hi < 0 || hi >= HOTBAR_SLOTS || si < 0 || si >= STORAGE_SLOTS) return null;
  const inv = invOf(profile);
  const hotbar = [...inv.hotbar];
  const storage = [...inv.storage];
  const tmp = hotbar[hi];
  hotbar[hi] = storage[si];
  storage[si] = tmp;
  return withInv(profile, { hotbar, storage, items: inv.items });
}

/** スロットの住所（インベントリ整理用）。 */
export type SlotZone = "hotbar" | "storage";
export type SlotRef = { zone: SlotZone; index: number };

function parseSlotRef(raw: unknown): SlotRef | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const v = raw as { zone?: unknown; index?: unknown };
  if (v.zone !== "hotbar" && v.zone !== "storage") return null;
  if (typeof v.index !== "number" || !Number.isFinite(v.index)) return null;
  const index = Math.floor(v.index);
  const max = v.zone === "hotbar" ? HOTBAR_SLOTS : STORAGE_SLOTS;
  if (index < 0 || index >= max) return null;
  return { zone: v.zone, index };
}

/**
 * 任意スロット間の移動（マイクラ式の整理）: 空き枠へは移動、同種は
 * 合算（上限 STACK_MAX、あふれた分は元の枠に残る）、異種は入れ替え。
 * 住所が不正なら null。総量は常に保存されるため items 集計は不変。
 */
export function moveSlot(
  profile: PlayerProfile,
  fromRaw: unknown,
  toRaw: unknown,
): PlayerProfile | null {
  const from = parseSlotRef(fromRaw);
  const to = parseSlotRef(toRaw);
  if (!from || !to) return null;
  if (from.zone === to.zone && from.index === to.index) return profile;
  const inv = invOf(profile);
  const hotbar = [...inv.hotbar];
  const storage = [...inv.storage];
  const arr = (zone: SlotZone) => (zone === "hotbar" ? hotbar : storage);
  const src = arr(from.zone)[from.index];
  if (!src) return profile;
  const dst = arr(to.zone)[to.index];
  if (!dst) {
    arr(to.zone)[to.index] = src;
    arr(from.zone)[from.index] = null;
  } else if (dst.id === src.id) {
    const moved = Math.min(STACK_MAX - dst.count, src.count);
    if (moved <= 0) return profile;
    arr(to.zone)[to.index] = { id: dst.id, count: dst.count + moved };
    const rest = src.count - moved;
    arr(from.zone)[from.index] = rest > 0 ? { id: src.id, count: rest } : null;
  } else {
    arr(to.zone)[to.index] = src;
    arr(from.zone)[from.index] = dst;
  }
  return withInv(profile, { hotbar, storage, items: inv.items });
}
