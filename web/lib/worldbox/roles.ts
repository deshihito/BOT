// AGO WORLD BOX の冒険役職（純粋ロジック）。
// 国の役職（Discord 権限が決める）とは無関係に本人が選ぶ「職業」。
// 効果は常時効果1つ＋専門行為1つだけ。成長軸は役職ごとの熟練ランク 1〜5。
// 技はダブルクリック/ダブルタップの単一ジェスチャで発動する（ボタンは置かない）。
// 技の演出は fx.ts のスキルプリセット9種を役職×ランクに割り当てる（全種を使う）:
//   剣士: 薙ぎ払い → 旋風斬り / 守護: アイスランス → サンダーストライク
//   斥候: ポイズンフィールド → アローレイン / 採掘者: ファイアーボール → メテオ
//   薬師: ヒーリングゾーン（全ランク、蘇生は専門行為）
//   テレポーター: ポーター設置（戦闘技ではなく、ダブルタップ地点への設置専用）
import type { PlayerProfile, AdventureRoleId } from "./profile";
import { isAdventureRoleId, ADVENTURE_ROLE_IDS } from "./profile";
export type { AdventureRoleId } from "./profile";
export { isAdventureRoleId, ADVENTURE_ROLE_IDS };
import type { SkillFxKind } from "./fx";

/** スキル演出プリセット（fx.ts の SkillFxKind と対応）。 */
export type SkillId =
  | "sweep" | "whirlwind" | "ice_lance" | "thunder_strike" | "poison_field"
  | "arrow_rain" | "fireball" | "meteor" | "heal_zone" | "taunt" | "porter";

export type SkillDef = {
  id: SkillId;
  name: string;
  /** 演出プリセット名（fx.ts）。 */
  fx: SkillFxKind;
  minRank: number;
  cooldownMs: number;
  /** 効果半径（タイル）。0 は単体/自己。 */
  radius: number;
  /** 攻撃倍率（剣の攻撃への倍率）。回復系は回復量として使う。 */
  power: number;
};

export const SKILLS: Record<SkillId, SkillDef> = {
  sweep: { id: "sweep", name: "薙ぎ払い", fx: "sweep", minRank: 1, cooldownMs: 12_000, radius: 1.7, power: 1.5 },
  whirlwind: { id: "whirlwind", name: "旋風斬り", fx: "whirlwind", minRank: 3, cooldownMs: 30_000, radius: 2.3, power: 2.0 },
  ice_lance: { id: "ice_lance", name: "アイスランス", fx: "ice_lance", minRank: 1, cooldownMs: 16_000, radius: 0, power: 0.8 },
  thunder_strike: { id: "thunder_strike", name: "サンダーストライク", fx: "thunder_strike", minRank: 5, cooldownMs: 45_000, radius: 0, power: 3.0 },
  poison_field: { id: "poison_field", name: "ポイズンフィールド", fx: "poison_field", minRank: 1, cooldownMs: 25_000, radius: 2.0, power: 1.2 },
  arrow_rain: { id: "arrow_rain", name: "アローレイン", fx: "arrow_rain", minRank: 3, cooldownMs: 40_000, radius: 2.1, power: 1.8 },
  fireball: { id: "fireball", name: "ファイアーボール", fx: "fireball", minRank: 1, cooldownMs: 20_000, radius: 1.0, power: 2.0 },
  meteor: { id: "meteor", name: "メテオ", fx: "meteor", minRank: 5, cooldownMs: 60_000, radius: 2.5, power: 2.5 },
  heal_zone: { id: "heal_zone", name: "ヒーリングゾーン", fx: "heal_zone", minRank: 1, cooldownMs: 45_000, radius: 2.25, power: 30 },
  taunt: { id: "taunt", name: "挑発", fx: "taunt", minRank: 1, cooldownMs: 20_000, radius: 3.5, power: 0 },
  porter: { id: "porter", name: "ポーター設置", fx: "warp", minRank: 1, cooldownMs: 30_000, radius: 0, power: 0 },
};

export type AdventureRoleDef = {
  id: AdventureRoleId;
  name: string;
  /** ネームプレート等で使う短い記号（絵文字は使わない）。 */
  symbol: string;
  passiveName: string;
  specialtyName: string;
  /** ダブルタップ技（ランクで上位に置き換わるものは上位が優先）。 */
  skills: readonly SkillId[];
};

export const ADVENTURE_ROLES: Record<AdventureRoleId, AdventureRoleDef> = {
  free: { id: "free", name: "自由人", symbol: "—", passiveName: "なし", specialtyName: "なし", skills: [] },
  blade: { id: "blade", name: "剣士", symbol: "剣", passiveName: "剣の攻撃上昇", specialtyName: "大振り", skills: ["sweep", "whirlwind"] },
  guard: { id: "guard", name: "守護", symbol: "盾", passiveName: "最大HP上昇・味方を守る", specialtyName: "挑発", skills: ["ice_lance", "thunder_strike", "taunt"] },
  scout: { id: "scout", name: "斥候", symbol: "斥", passiveName: "移動スタミナ節約", specialtyName: "罠の探知", skills: ["poison_field", "arrow_rain"] },
  miner: { id: "miner", name: "採掘者", symbol: "採", passiveName: "鉱脈の追加ドロップ", specialtyName: "鉱脈探知", skills: ["fireball", "meteor"] },
  medic: { id: "medic", name: "薬師", symbol: "薬", passiveName: "回復アイテム強化", specialtyName: "蘇生", skills: ["heal_zone"] },
  teleporter: { id: "teleporter", name: "テレポーター", symbol: "ポ", passiveName: "ポーター設置", specialtyName: "ポーター設置", skills: ["porter"] },
};

export function roleById(id: unknown): AdventureRoleDef {
  return isAdventureRoleId(id) ? ADVENTURE_ROLES[id] : ADVENTURE_ROLES.free;
}

// ---------------------------------------------------------------- 熟練
/** ランク到達に必要な累計 XP（ランク1は 0）。閾値はユーザー向けに開示しない。 */
export const MASTERY_THRESHOLDS: readonly number[] = [0, 30, 80, 160, 300];
export const MASTERY_MAX_RANK = 5;

export function rankForXp(xp: number): number {
  let rank = 1;
  for (let i = 0; i < MASTERY_THRESHOLDS.length; i++) {
    if (xp >= MASTERY_THRESHOLDS[i]) rank = i + 1;
  }
  return Math.min(MASTERY_MAX_RANK, rank);
}

export function masteryRankOf(profile: PlayerProfile, role: AdventureRoleId): number {
  return rankForXp(profile.mastery[role]?.xp ?? 0);
}

/** 熟練 XP を足す。ランクが上がったら rankUp=true。 */
export function addMasteryXp(
  profile: PlayerProfile,
  role: AdventureRoleId,
  amount: number,
): { profile: PlayerProfile; rankUp: boolean } {
  if (role === "free" || amount <= 0) return { profile, rankUp: false };
  const before = masteryRankOf(profile, role);
  const xp = (profile.mastery[role]?.xp ?? 0) + amount;
  const next: PlayerProfile = {
    ...profile,
    mastery: { ...profile.mastery, [role]: { xp } },
  };
  return { profile: next, rankUp: rankForXp(xp) > before };
}

// ---------------------------------------------------------------- 常時効果
/** 剣士の剣攻撃倍率。 */
export const BLADE_ATTACK_MULT = 1.25;
/** 守護の隣接味方への被ダメージ軽減率。 */
export const GUARD_AURA_REDUCTION = 0.3;
/** 採掘者の追加ドロップ抽選確率。 */
export const MINER_BONUS_CHANCE = 0.3;
/** 斥候の移動スタミナ消費倍率。 */
export const SCOUT_STAMINA_MULT = 0.8;


// ---------------------------------------------------------------- 技
/** その役職・ランクでダブルタップ発動できる技（上位ランクで置き換わる分は最上位のみ）。 */
export function activeSkillFor(profile: PlayerProfile): SkillDef | null {
  const def = roleById(profile.role);
  const rank = masteryRankOf(profile, profile.role);
  let best: SkillDef | null = null;
  for (const id of def.skills) {
    const skill = SKILLS[id];
    if (id === "taunt") continue; // 挑発は自分のタイルへのダブルタップ専用
    if (id === "porter") continue; // ポーター設置はダブルタップ地点への設置専用（戦闘技として返さない）
    if (rank >= skill.minRank) best = skill;
  }
  return best;
}

/** クールタイム中かと残りミリ秒。 */
export function skillCooldownLeft(profile: PlayerProfile, skillId: SkillId, now: number): number {
  const at = profile.skillAt[skillId] ?? 0;
  return Math.max(0, at + SKILLS[skillId].cooldownMs - now);
}

// ---------------------------------------------------------------- 転職コスト
/** 転職（2回目以降の役職変更）の価格（アゴコイン、ユーザー決定 2026-11-16）。 */
export const ROLE_CHANGE_COST = 100_000;
/** 転職の spend オプの理由（ブリッジの spend は理由ホワイトリストを持たない）。 */
export const ROLE_CHANGE_REASON = "role_change";

/**
 * その変更に掛かるコイン。初めての役職選択は無料、同じ役職の再選択は
 * 無料（no-op）。一度でも選んだことがある人（rolePicked、または旧データで
 * 既に free でない役職を持っている人）の変更は ROLE_CHANGE_COST。
 */
export function roleChangeCost(profile: PlayerProfile, nextRole: AdventureRoleId): number {
  if (nextRole === profile.role) return 0;
  const picked = profile.rolePicked === true || profile.role !== "free";
  return picked ? ROLE_CHANGE_COST : 0;
}

/** 役職変更の遷移（コスト計算込み）。変更したら rolePicked を立てる。 */
export function applyRoleChange(
  profile: PlayerProfile,
  nextRole: AdventureRoleId,
): { profile: PlayerProfile; cost: number } {
  const cost = roleChangeCost(profile, nextRole);
  if (nextRole === profile.role) return { profile, cost: 0 };
  return { profile: { ...profile, role: nextRole, rolePicked: true }, cost };
}

// ---------------------------------------------------------------- 解放ゲート
/** ダンジョンの解放条件（バッチ5で使用）: F2 はランク2+ が1人、ボス部屋はランク3+ が1人。 */
export function partyGateSatisfied(ranks: readonly number[], gate: "floor2" | "boss"): boolean {
  const need = gate === "floor2" ? 2 : 3;
  return ranks.some((r) => r >= need);
}
