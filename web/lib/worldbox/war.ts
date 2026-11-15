// AGO WORLD BOX のユニオン戦争（純粋ロジック）。
// 宣言は国王のみ。戦争状態の間だけ、相手ユニオンの設置ブロックを
// 耐久つきで破壊できる（平時は所有者のみ）。ユニオンマーク（首都）を
// 削り切るとレイド成立になり、戦争は終わる。
// 保存（bot_kv）は war-online.ts、API は app/api/worldbox/war/route.ts。

/** 戦争の継続時間（48時間）。 */
export const WAR_DURATION_MS = 48 * 60 * 60_000;
/** 戦争終了後、同じ攻撃側が再宣言できるまでの間隔（24時間）。 */
export const WAR_COOLDOWN_MS = 24 * 60 * 60_000;
/** ユニオンマークの最大 HP。 */
export const MARK_HP_MAX = 100;
/** マーク攻撃1回のダメージ。 */
export const MARK_ATTACK_DAMAGE = 10;
/** マーク HP の自然回復（1時間ごと）。 */
export const MARK_REGEN_PER_HOUR = 10;
/** レイド成立後の修復期間（この間マークは攻撃されず、宣言もできない）。 */
export const RAID_REPAIR_MS = 24 * 60 * 60_000;

export type War = {
  id: string;
  attacker: string;
  defender: string;
  declaredAt: number;
  expiresAt: number;
};

export type RaidRecord = {
  attacker: string;
  defender: string;
  at: number;
};

export type WarState = {
  wars: War[];
  /** ギルド ID → マークの状態（hp は at 時点の値、回復は読み側で計算）。 */
  marks: Record<string, { hp: number; at: number; destroyedAt?: number }>;
  raids: RaidRecord[];
  /** 攻撃側ギルド ID → 最後に戦争が終わった時刻（クールダウン判定）。 */
  lastWarEndAt: Record<string, number>;
};

export function emptyWarState(): WarState {
  return { wars: [], marks: {}, raids: [], lastWarEndAt: {} };
}

function isGuildId(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= 32;
}

export function parseWarState(raw: unknown): WarState {
  let data: unknown = raw;
  if (typeof raw === "string") {
    try {
      data = JSON.parse(raw);
    } catch {
      return emptyWarState();
    }
  }
  if (!data || typeof data !== "object") return emptyWarState();
  const v = data as Record<string, unknown>;
  const wars: War[] = [];
  if (Array.isArray(v.wars)) {
    for (const w of v.wars) {
      if (!w || typeof w !== "object") continue;
      const r = w as Record<string, unknown>;
      if (!isGuildId(r.attacker) || !isGuildId(r.defender)) continue;
      if (typeof r.declaredAt !== "number" || typeof r.expiresAt !== "number") continue;
      wars.push({
        id: typeof r.id === "string" ? r.id : `${r.attacker}:${r.defender}:${r.declaredAt}`,
        attacker: r.attacker,
        defender: r.defender,
        declaredAt: r.declaredAt,
        expiresAt: r.expiresAt,
      });
    }
  }
  const marks: WarState["marks"] = {};
  if (v.marks && typeof v.marks === "object" && !Array.isArray(v.marks)) {
    for (const [gid, m] of Object.entries(v.marks as Record<string, unknown>)) {
      if (!m || typeof m !== "object") continue;
      const r = m as Record<string, unknown>;
      if (typeof r.hp !== "number" || typeof r.at !== "number") continue;
      marks[gid] = {
        hp: Math.max(0, Math.min(MARK_HP_MAX, r.hp)),
        at: r.at,
        destroyedAt: typeof r.destroyedAt === "number" ? r.destroyedAt : undefined,
      };
    }
  }
  const raids: RaidRecord[] = [];
  if (Array.isArray(v.raids)) {
    for (const r of v.raids) {
      if (!r || typeof r !== "object") continue;
      const rec = r as Record<string, unknown>;
      if (isGuildId(rec.attacker) && isGuildId(rec.defender) && typeof rec.at === "number") {
        raids.push({ attacker: rec.attacker, defender: rec.defender, at: rec.at });
      }
    }
  }
  const lastWarEndAt: Record<string, number> = {};
  if (v.lastWarEndAt && typeof v.lastWarEndAt === "object" && !Array.isArray(v.lastWarEndAt)) {
    for (const [gid, at] of Object.entries(v.lastWarEndAt as Record<string, unknown>)) {
      if (typeof at === "number") lastWarEndAt[gid] = at;
    }
  }
  return { wars, marks, raids: raids.slice(-50), lastWarEndAt };
}

/** 期限切れの戦争を取り除き、終了時刻を記録した新しい状態を返す。 */
export function pruneWars(state: WarState, now: number): WarState {
  const active = state.wars.filter((w) => w.expiresAt > now);
  if (active.length === state.wars.length) return state;
  const lastWarEndAt = { ...state.lastWarEndAt };
  for (const w of state.wars) {
    if (w.expiresAt <= now) {
      lastWarEndAt[w.attacker] = Math.max(lastWarEndAt[w.attacker] ?? 0, w.expiresAt);
    }
  }
  return { ...state, wars: active, lastWarEndAt };
}

/** 2ギルド間に有効な戦争があるか（双方向）。 */
export function activeWarBetween(state: WarState, a: string, b: string, now: number): War | null {
  return (
    state.wars.find(
      (w) =>
        w.expiresAt > now &&
        ((w.attacker === a && w.defender === b) || (w.attacker === b && w.defender === a)),
    ) ?? null
  );
}

export type DeclareError = "self_war" | "already_at_war" | "cooldown" | "repairing";

/** 宣言できるか。できなければ理由を返す。 */
export function declareError(
  state: WarState,
  attacker: string,
  defender: string,
  now: number,
): DeclareError | null {
  if (attacker === defender) return "self_war";
  if (activeWarBetween(state, attacker, defender, now)) return "already_at_war";
  const lastEnd = state.lastWarEndAt[attacker] ?? 0;
  if (lastEnd > 0 && now - lastEnd < WAR_COOLDOWN_MS) return "cooldown";
  if (isRepairing(state, attacker, now) || isRepairing(state, defender, now)) return "repairing";
  return null;
}

export function declareWar(state: WarState, attacker: string, defender: string, now: number): WarState {
  const war: War = {
    id: `${attacker}:${defender}:${now}`,
    attacker,
    defender,
    declaredAt: now,
    expiresAt: now + WAR_DURATION_MS,
  };
  return { ...state, wars: [...state.wars, war] };
}

/** 修復期間中か（レイド成立から RAID_REPAIR_MS の間）。 */
export function isRepairing(state: WarState, guildId: string, now: number): boolean {
  const destroyedAt = state.marks[guildId]?.destroyedAt;
  return destroyedAt !== undefined && now - destroyedAt < RAID_REPAIR_MS;
}

/** 現在のマーク HP（自然回復を織り込む）。修復期間中は 0 のまま。 */
export function markHpNow(state: WarState, guildId: string, now: number): number {
  const mark = state.marks[guildId];
  if (!mark) return MARK_HP_MAX;
  if (isRepairing(state, guildId, now)) return 0;
  const regen = Math.floor((now - mark.at) / 3_600_000) * MARK_REGEN_PER_HOUR;
  return Math.min(MARK_HP_MAX, mark.hp + regen);
}

/**
 * マークへ攻撃する。HP が 0 になったらレイド成立:
 * その戦争（attacker→defender）を終了し、修復期間に入る。
 */
export function applyMarkAttack(
  state: WarState,
  attackerGuild: string,
  defenderGuild: string,
  now: number,
): { state: WarState; hp: number; destroyed: boolean } {
  const hpBefore = markHpNow(state, defenderGuild, now);
  // 破壊済みのマークへの追加攻撃は記録を増やさない
  if (hpBefore <= 0) return { state, hp: 0, destroyed: true };
  const hp = Math.max(0, hpBefore - MARK_ATTACK_DAMAGE);
  const destroyed = hp <= 0;
  const marks = {
    ...state.marks,
    [defenderGuild]: {
      hp,
      at: now,
      destroyedAt: destroyed ? now : state.marks[defenderGuild]?.destroyedAt,
    },
  };
  if (!destroyed) return { state: { ...state, marks }, hp, destroyed };
  const wars = state.wars.filter(
    (w) => !(w.attacker === attackerGuild && w.defender === defenderGuild),
  );
  return {
    state: {
      ...state,
      marks,
      wars,
      raids: [...state.raids, { attacker: attackerGuild, defender: defenderGuild, at: now }].slice(-50),
      lastWarEndAt: { ...state.lastWarEndAt, [attackerGuild]: now },
    },
    hp,
    destroyed,
  };
}

/** 戦時だけ他者ブロックを壊せる: 破壊に必要な累積ダメージはブロック耐久そのもの。 */
export function warMineDamage(pickaxeTier: number): number {
  return 20 + Math.max(0, Math.min(4, pickaxeTier)) * 15;
}
