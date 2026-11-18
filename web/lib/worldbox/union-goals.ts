// AGO WORLD BOX のユニオン週間共闘目標（純粋ロジック、DOM 非依存）。
// Discord サーバー（ユニオン）ごとに毎週3本の共闘目標（開拓/工房/討伐）を進め、
// 達成時に Discord 連携チャンネルへ達成速報を送るための状態遷移を扱う。

export type UnionGoalKind = "gather" | "craft" | "combat";

export type UnionGoalDef = {
  id: UnionGoalKind;
  name: string;
  target: number;
};

export const UNION_GOALS: readonly UnionGoalDef[] = [
  { id: "gather", name: "開拓協力（採集・釣り・建築）", target: 40 },
  { id: "craft", name: "工房協力（合成・精錬・調理）", target: 25 },
  { id: "combat", name: "討伐協力（魔物撃破）", target: 30 },
];

export type UnionGoalsState = {
  week: string;
  progress: Record<UnionGoalKind, number>;
  completed: Partial<Record<UnionGoalKind, number>>;
  /** 累計達成回数（過去の週を含む）。 */
  totalCompleted: number;
};

/** 週間キー（ISO 週・月曜起点）。events.ts の weekKeyOf と同じ週区分。 */
export function goalWeekKeyOf(nowMs: number): string {
  const d = new Date(nowMs);
  const utc = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const day = new Date(utc).getUTCDay() || 7; // 月=1..日=7
  const mon = new Date(utc - (day - 1) * 86_400_000);
  const y = mon.getUTCFullYear();
  const m = String(mon.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(mon.getUTCDate()).padStart(2, "0");
  return `${y}-W${m}${dd}`;
}

export function emptyUnionGoalsState(week: string, totalCompleted = 0): UnionGoalsState {
  return {
    week,
    progress: { gather: 0, craft: 0, combat: 0 },
    completed: {},
    totalCompleted: Math.max(0, Math.floor(totalCompleted)),
  };
}

export function parseUnionGoalsState(raw: unknown, nowMs = Date.now()): UnionGoalsState {
  const currentWeek = goalWeekKeyOf(nowMs);
  let data: unknown = raw;
  if (typeof raw === "string") {
    try {
      data = JSON.parse(raw);
    } catch {
      return emptyUnionGoalsState(currentWeek);
    }
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return emptyUnionGoalsState(currentWeek);
  }
  const v = data as Record<string, unknown>;
  const totalCompleted =
    typeof v.totalCompleted === "number" && Number.isFinite(v.totalCompleted) && v.totalCompleted > 0
      ? Math.floor(v.totalCompleted)
      : 0;
  // 週が切り替わったら今週の進捗・達成印だけリセットし、累計達成回数は引き継ぐ
  if (v.week !== currentWeek) {
    return emptyUnionGoalsState(currentWeek, totalCompleted);
  }
  const progRaw = (v.progress && typeof v.progress === "object" ? v.progress : {}) as Record<string, unknown>;
  const compRaw = (v.completed && typeof v.completed === "object" ? v.completed : {}) as Record<string, unknown>;
  const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) && x > 0 ? Math.floor(x) : 0);
  const completed: Partial<Record<UnionGoalKind, number>> = {};
  for (const def of UNION_GOALS) {
    const at = num(compRaw[def.id]);
    if (at > 0) completed[def.id] = at;
  }
  return {
    week: currentWeek,
    progress: {
      gather: num(progRaw.gather),
      craft: num(progRaw.craft),
      combat: num(progRaw.combat),
    },
    completed,
    totalCompleted,
  };
}

export function applyUnionGoalProgress(
  state: UnionGoalsState,
  nowMs: number,
  kind: UnionGoalKind,
  delta = 1,
): { state: UnionGoalsState; newlyCompleted: UnionGoalDef | null } {
  const amount = Math.max(0, Math.floor(delta));
  const week = goalWeekKeyOf(nowMs);
  const base = state.week === week ? state : emptyUnionGoalsState(week, state.totalCompleted);
  if (amount <= 0) return { state: base, newlyCompleted: null };
  const def = UNION_GOALS.find((g) => g.id === kind);
  if (!def) return { state: base, newlyCompleted: null };

  const cur = base.progress[kind] ?? 0;
  const nextVal = Math.min(def.target * 20, cur + amount);
  const alreadyDone = (base.completed[kind] ?? 0) > 0;
  const completedNow = !alreadyDone && nextVal >= def.target;

  const nextState: UnionGoalsState = {
    week,
    progress: { ...base.progress, [kind]: nextVal },
    completed: completedNow ? { ...base.completed, [kind]: nowMs } : { ...base.completed },
    totalCompleted: base.totalCompleted + (completedNow ? 1 : 0),
  };
  return { state: nextState, newlyCompleted: completedNow ? def : null };
}

export type UnionGoalView = {
  id: UnionGoalKind;
  name: string;
  current: number;
  target: number;
  completedAt: number | null;
};

export function toUnionGoalViews(state: UnionGoalsState): UnionGoalView[] {
  return UNION_GOALS.map((def) => ({
    id: def.id,
    name: def.name,
    current: Math.min(state.progress[def.id] ?? 0, def.target),
    target: def.target,
    completedAt: state.completed[def.id] ?? null,
  }));
}
