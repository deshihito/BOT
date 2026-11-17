// AGO WORLD BOX のユニオン戦争（バッチ7a: レイド宣言 / 戦争状態 /
// マーク破壊判定 / 他者ブロック破壊ルール / 防衛）と繁栄ランキング。
// 純粋ロジックのみ（DOM 非依存、乱数なし、決定的 ID）。
//
// 決定（企画書 PLAN §9-3 の推奨初期値を採用）:
// - レイド宣言はギルドボードの前で王/大臣だけが行う。宣言で即戦争状態。
// - 平時は他者のブロックを壊せない。戦争状態のときだけ、攻撃側の国民が
//   防衛側の首都から WAR_TERRITORY_RADIUS 以内の他者ブロックを掘れる。
//   掘ったブロックは掘った者の所持品に入る（略奪ルールはこれに一本化）。
// - マーク = 首都タイル。戦争中、攻撃側は首都の2タイル以内から
//   attack_mark でマーク HP を削れる（1回 -10、10秒クールダウン）。
//   防衛側は repair_mark で回復できる（1回 +10、30秒クールダウン）。
// - マーク HP が 0 になると防衛国は解散し、戦争は攻撃側の勝利で終わる。
//   期限（24時間）を過ぎた戦争は引き分け（expired）で終わる。
// - 1国が同時に関わる戦争は1件まで。宣言は1国あたり24時間に1回まで。
// - コインの流れは無い（略奪はブロック現物のみ）。earn/spend は作らない。

/** 戦争の継続時間。 */
export const WAR_DURATION_MS = 24 * 60 * 60 * 1000;
/** マークの最大 HP。 */
export const WAR_MARK_MAX_HP = 100;
/** マーク攻撃1回のダメージ。 */
export const WAR_MARK_ATTACK_DAMAGE = 10;
/** マーク攻撃の個人クールダウン。 */
export const WAR_MARK_ATTACK_COOLDOWN_MS = 10_000;
/** マーク修復1回の回復量。 */
export const WAR_MARK_REPAIR_AMOUNT = 10;
/** マーク修復の個人クールダウン。 */
export const WAR_MARK_REPAIR_COOLDOWN_MS = 30_000;
/** レイド宣言の間隔（宣言した国あたり）。 */
export const WAR_DECLARE_COOLDOWN_MS = 24 * 60 * 60 * 1000;
/** 戦争中に他者ブロックを掘れる範囲（防衛側の首都からのチェビシェフ距離）。 */
export const WAR_TERRITORY_RADIUS = 12;
/** マーク攻撃・修復ができる範囲（首都からのチェビシェフ距離）。 */
export const WAR_MARK_RANGE = 2;
/** 戦争履歴の保持上限。 */
export const WAR_HISTORY_MAX = 20;

export type WarOutcome = "attacker_win" | "expired";

export type War = {
  /** 決定的 ID: `war-<攻撃国>-<防衛国>-<宣言時刻>`。 */
  id: string;
  attackerId: string;
  defenderId: string;
  attackerName: string;
  defenderName: string;
  declaredAt: number;
  endsAt: number;
  markHp: number;
  markMax: number;
  status: "active" | "closed";
  outcome: WarOutcome | null;
  endedAt: number | null;
  /** 攻撃者個人（プレゼンス ID）の最終マーク攻撃時刻。 */
  lastAttackAt: Record<string, number>;
  /** 防衛者個人（プレゼンス ID）の最終マーク修復時刻。 */
  lastRepairAt: Record<string, number>;
};

export type WarHistoryEntry = {
  id: string;
  attackerId: string;
  defenderId: string;
  attackerName: string;
  defenderName: string;
  outcome: WarOutcome;
  endedAt: number;
};

export type WarState = {
  v: 1;
  wars: Record<string, War>;
  history: WarHistoryEntry[];
  /** 宣言した国 → 最終宣言時刻（宣言クールダウン用）。 */
  lastDeclaredAt: Record<string, number>;
};

export function emptyWarState(): WarState {
  return { v: 1, wars: {}, history: [], lastDeclaredAt: {} };
}

export function warIdFor(attackerId: string, defenderId: string, declaredAt: number): string {
  return `war-${attackerId}-${defenderId}-${declaredAt}`;
}

/** その国が関わる進行中の戦争（攻撃側・防衛側どちらか）。無ければ null。 */
export function activeWarFor(state: WarState, nationId: string): War | null {
  for (const war of Object.values(state.wars)) {
    if (war.status !== "active") continue;
    if (war.attackerId === nationId || war.defenderId === nationId) return war;
  }
  return null;
}

export function activeWarBetween(state: WarState, attackerId: string, defenderId: string): War | null {
  for (const war of Object.values(state.wars)) {
    if (war.status !== "active") continue;
    if (war.attackerId === attackerId && war.defenderId === defenderId) return war;
  }
  return null;
}

/**
 * その戦争が時刻 now の時点で生きているか（進行中かつ期限内）。
 * expireWars は war ルートが読むときにしか走らないため、期限切れでも
 * status が "active" のまま残ることがある。他の経路（タイルの略奪
 * 判定など）が戦争状態を引くときは、この判定で期限も見ること。
 * 期限の境界は expireWars と同じ（now > endsAt で失効）。
 */
export function warLiveAt(war: War, now: number): boolean {
  return war.status === "active" && now <= war.endsAt;
}

/**
 * 世界地図のマーク表示用: 戦争中の国 → マークの状態。
 * 防衛側は自国マークの HP（削られている対象そのもの）、攻撃側は
 * markHp null（自国マークは削られていない。戦争中であることだけ示す）。
 * 期限切れ（未精算）の戦争は warLiveAt で除外する（タイル判定と同じ規則）。
 */
export type WarMarkView = { markHp: number | null; markMax: number };

export function warMarksByNation(state: WarState, now: number): Record<string, WarMarkView> {
  const out: Record<string, WarMarkView> = {};
  for (const war of Object.values(state.wars)) {
    if (!warLiveAt(war, now)) continue;
    out[war.defenderId] = { markHp: war.markHp, markMax: war.markMax };
    if (!(war.attackerId in out)) out[war.attackerId] = { markHp: null, markMax: war.markMax };
  }
  return out;
}

export type DeclareWarResult =
  | { ok: true; state: WarState; war: War }
  | { ok: false; error: string };

/**
 * レイド宣言: 攻撃国が防衛国へ戦争を仕掛ける。両国が存在し、別国で、
 * どちらも他の進行中の戦争に関わっておらず、攻撃国の宣言クールダウンが
 * 明けている場合だけ成立する。
 */
export function declareWar(
  state: WarState,
  attacker: { id: string; name: string },
  defender: { id: string; name: string },
  now: number,
): DeclareWarResult {
  if (!attacker?.id || !defender?.id) return { ok: false, error: "invalid_request" };
  if (attacker.id === defender.id) return { ok: false, error: "same_nation" };
  if (activeWarFor(state, attacker.id) || activeWarFor(state, defender.id)) {
    return { ok: false, error: "already_at_war" };
  }
  const last = state.lastDeclaredAt[attacker.id];
  if (typeof last === "number" && now - last < WAR_DECLARE_COOLDOWN_MS) {
    return { ok: false, error: "declare_cooldown" };
  }
  const war: War = {
    id: warIdFor(attacker.id, defender.id, now),
    attackerId: attacker.id,
    defenderId: defender.id,
    attackerName: attacker.name,
    defenderName: defender.name,
    declaredAt: now,
    endsAt: now + WAR_DURATION_MS,
    markHp: WAR_MARK_MAX_HP,
    markMax: WAR_MARK_MAX_HP,
    status: "active",
    outcome: null,
    endedAt: null,
    lastAttackAt: {},
    lastRepairAt: {},
  };
  const next: WarState = {
    ...state,
    wars: { ...state.wars, [war.id]: war },
    lastDeclaredAt: { ...state.lastDeclaredAt, [attacker.id]: now },
  };
  return { ok: true, state: next, war };
}

function closeWar(state: WarState, war: War, outcome: WarOutcome, endedAt: number): WarState {
  const closed: War = { ...war, status: "closed", outcome, endedAt };
  const history: WarHistoryEntry[] = [
    {
      id: war.id,
      attackerId: war.attackerId,
      defenderId: war.defenderId,
      attackerName: war.attackerName,
      defenderName: war.defenderName,
      outcome,
      endedAt,
    },
    ...state.history,
  ].slice(0, WAR_HISTORY_MAX);
  return { ...state, wars: { ...state.wars, [war.id]: closed }, history };
}

/** 期限切れの戦争をすべて引き分けで閉じる。変化が無ければ同じ状態を返す。 */
export function expireWars(state: WarState, now: number): WarState {
  let next = state;
  for (const war of Object.values(state.wars)) {
    if (war.status === "active" && now > war.endsAt) {
      next = closeWar(next, war, "expired", war.endsAt);
    }
  }
  return next;
}

export type AttackMarkResult =
  | { ok: true; state: WarState; war: War; destroyed: boolean }
  | { ok: false; error: string };

/**
 * マーク攻撃: 攻撃側の国民が防衛国のマーク HP を削る。個人クールダウンを
 * 守る。HP が 0 になると戦争は攻撃側の勝利で終わる（防衛国の解散は
 * 呼び出し側＝ルートが nations 側へ適用する）。
 */
export function attackMark(
  state: WarState,
  warId: string,
  attackerPresenceId: string,
  now: number,
): AttackMarkResult {
  const war = state.wars[warId];
  if (!war || war.status !== "active") return { ok: false, error: "not_at_war" };
  const last = war.lastAttackAt[attackerPresenceId];
  if (typeof last === "number" && now - last < WAR_MARK_ATTACK_COOLDOWN_MS) {
    return { ok: false, error: "too_soon" };
  }
  const markHp = Math.max(0, war.markHp - WAR_MARK_ATTACK_DAMAGE);
  const attacked: War = {
    ...war,
    markHp,
    lastAttackAt: { ...war.lastAttackAt, [attackerPresenceId]: now },
  };
  if (markHp > 0) {
    return { ok: true, state: { ...state, wars: { ...state.wars, [war.id]: attacked } }, war: attacked, destroyed: false };
  }
  const closed = closeWar({ ...state, wars: { ...state.wars, [war.id]: attacked } }, attacked, "attacker_win", now);
  return { ok: true, state: closed, war: closed.wars[war.id], destroyed: true };
}

export type RepairMarkResult =
  | { ok: true; state: WarState; war: War }
  | { ok: false; error: string };

/** マーク修復: 防衛側の国民がマーク HP を回復する（上限まで）。 */
export function repairMark(
  state: WarState,
  warId: string,
  defenderPresenceId: string,
  now: number,
): RepairMarkResult {
  const war = state.wars[warId];
  if (!war || war.status !== "active") return { ok: false, error: "not_at_war" };
  if (war.markHp >= war.markMax) return { ok: false, error: "mark_full" };
  const last = war.lastRepairAt[defenderPresenceId];
  if (typeof last === "number" && now - last < WAR_MARK_REPAIR_COOLDOWN_MS) {
    return { ok: false, error: "too_soon" };
  }
  const repaired: War = {
    ...war,
    markHp: Math.min(war.markMax, war.markHp + WAR_MARK_REPAIR_AMOUNT),
    lastRepairAt: { ...war.lastRepairAt, [defenderPresenceId]: now },
  };
  return { ok: true, state: { ...state, wars: { ...state.wars, [war.id]: repaired } }, war: repaired };
}

/**
 * 他者ブロック破壊の可否: 進行中の戦争で、掘る側の国が攻撃側・
 * ブロック所有者の国が防衛側で、ブロックが防衛側の首都の
 * WAR_TERRITORY_RADIUS 以内にある場合だけ可。
 * now を渡すと期限切れ（status は "active" のまま未精算）の戦争を
 * 不可として扱う。タイル経路は expireWars を走らせないため、必ず
 * now を渡すこと。
 */
export function canBreakOthersBlock(
  state: WarState,
  attackerNationId: string,
  defenderNationId: string,
  x: number,
  y: number,
  defenderCapital: { x: number; y: number },
  now?: number,
): boolean {
  if (attackerNationId === defenderNationId) return false;
  const war = activeWarBetween(state, attackerNationId, defenderNationId);
  if (!war) return false;
  if (now !== undefined && !warLiveAt(war, now)) return false;
  return Math.max(Math.abs(x - defenderCapital.x), Math.abs(y - defenderCapital.y)) <= WAR_TERRITORY_RADIUS;
}

// ---------- 繁栄ランキング ----------

export type RankingNation = {
  id: string;
  name: string;
  color: string;
  members: number;
  prosperity: number;
  createdAt: number;
};

export type RankingEntry = RankingNation & { rank: number };

/** 繁栄度順のランキング（同値は建国が早い方を上位に）。順位は1始まり。 */
export function prosperityRanking(nations: RankingNation[]): RankingEntry[] {
  return [...nations]
    .sort((a, b) => b.prosperity - a.prosperity || a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    .map((n, i) => ({ ...n, rank: i + 1 }));
}

// ---------- 保存形式 ----------

function asRecord(raw: unknown): Record<string, unknown> | null {
  let data: unknown = raw;
  if (typeof raw === "string") {
    try {
      data = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  return data as Record<string, unknown>;
}

function parseWar(raw: unknown): War | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Record<string, unknown>;
  if (typeof v.id !== "string" || v.id.length === 0) return null;
  if (typeof v.attackerId !== "string" || !/^\d+$/.test(v.attackerId)) return null;
  if (typeof v.defenderId !== "string" || !/^\d+$/.test(v.defenderId)) return null;
  if (typeof v.attackerName !== "string" || typeof v.defenderName !== "string") return null;
  if (typeof v.declaredAt !== "number" || typeof v.endsAt !== "number") return null;
  if (!Number.isFinite(v.declaredAt) || !Number.isFinite(v.endsAt)) return null;
  if (typeof v.markHp !== "number" || typeof v.markMax !== "number") return null;
  if (!Number.isFinite(v.markHp) || !Number.isFinite(v.markMax) || v.markMax <= 0) return null;
  if (v.status !== "active" && v.status !== "closed") return null;
  if (v.outcome !== null && v.outcome !== "attacker_win" && v.outcome !== "expired") return null;
  if (v.endedAt !== null && typeof v.endedAt !== "number") return null;
  const lastAttackAt: Record<string, number> = {};
  const la = asRecord(v.lastAttackAt);
  if (la) {
    for (const [k, t] of Object.entries(la)) if (typeof t === "number" && Number.isFinite(t)) lastAttackAt[k] = t;
  }
  const lastRepairAt: Record<string, number> = {};
  const lr = asRecord(v.lastRepairAt);
  if (lr) {
    for (const [k, t] of Object.entries(lr)) if (typeof t === "number" && Number.isFinite(t)) lastRepairAt[k] = t;
  }
  return {
    id: v.id,
    attackerId: v.attackerId,
    defenderId: v.defenderId,
    attackerName: v.attackerName,
    defenderName: v.defenderName,
    declaredAt: v.declaredAt,
    endsAt: v.endsAt,
    markHp: Math.max(0, Math.min(v.markMax, Math.floor(v.markHp))),
    markMax: Math.floor(v.markMax),
    status: v.status,
    outcome: v.outcome,
    endedAt: v.endedAt,
    lastAttackAt,
    lastRepairAt,
  };
}

function parseHistoryEntry(raw: unknown): WarHistoryEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Record<string, unknown>;
  if (typeof v.id !== "string" || v.id.length === 0) return null;
  if (typeof v.attackerId !== "string" || typeof v.defenderId !== "string") return null;
  if (typeof v.attackerName !== "string" || typeof v.defenderName !== "string") return null;
  if (v.outcome !== "attacker_win" && v.outcome !== "expired") return null;
  if (typeof v.endedAt !== "number" || !Number.isFinite(v.endedAt)) return null;
  return {
    id: v.id,
    attackerId: v.attackerId,
    defenderId: v.defenderId,
    attackerName: v.attackerName,
    defenderName: v.defenderName,
    outcome: v.outcome,
    endedAt: v.endedAt,
  };
}

/** bot_kv の1値から戦争状態を復元する。壊れていれば空の状態。 */
export function parseWarState(raw: unknown): WarState {
  const state = emptyWarState();
  const wrapped = asRecord(raw);
  if (!wrapped || wrapped.v !== 1) return state;
  const warsRaw = asRecord(wrapped.wars);
  if (warsRaw) {
    for (const rawWar of Object.values(warsRaw)) {
      const war = parseWar(rawWar);
      if (war) state.wars[war.id] = war;
    }
  }
  if (Array.isArray(wrapped.history)) {
    for (const rawEntry of wrapped.history) {
      const entry = parseHistoryEntry(rawEntry);
      if (entry) state.history.push(entry);
    }
    state.history = state.history.slice(0, WAR_HISTORY_MAX);
  }
  const declared = asRecord(wrapped.lastDeclaredAt);
  if (declared) {
    for (const [k, t] of Object.entries(declared)) {
      if (typeof t === "number" && Number.isFinite(t)) state.lastDeclaredAt[k] = t;
    }
  }
  return state;
}

/** API 表示用の戦争（個人クールダウンの時刻は出さない）。 */
export type WarView = {
  id: string;
  attackerId: string;
  defenderId: string;
  attackerName: string;
  defenderName: string;
  declaredAt: number;
  endsAt: number;
  markHp: number;
  markMax: number;
  status: "active" | "closed";
  outcome: WarOutcome | null;
  endedAt: number | null;
};

export function warView(war: War): WarView {
  return {
    id: war.id,
    attackerId: war.attackerId,
    defenderId: war.defenderId,
    attackerName: war.attackerName,
    defenderName: war.defenderName,
    declaredAt: war.declaredAt,
    endsAt: war.endsAt,
    markHp: war.markHp,
    markMax: war.markMax,
    status: war.status,
    outcome: war.outcome,
    endedAt: war.endedAt,
  };
}
