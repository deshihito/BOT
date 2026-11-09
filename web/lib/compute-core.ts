// クライアント分散コンピューティングのプール管理ロジック（純粋関数）。
// 状態は Bot API 経由で bot_kv の compute_pool 名前空間に1レコードで保持する。
// サーバー（Pi）側は配布・照合・集計だけを行い、計算そのものはしない。
import type { ComputeTaskDef } from "./compute-catalog";

/** プール状態を置く bot_kv の名前空間とキー。 */
export const COMPUTE_POOL_NAMESPACE = "compute_pool";
export const COMPUTE_POOL_STATE_KEY = "state";

/** リースの有効期限。これを過ぎたタスクは未完了として再配布される。 */
export const LEASE_TTL_MS = 3 * 60 * 1000;

export type LeaseInfo = { exp: number; token: string };

export type ComputePoolState = {
  version: 1;
  /** 検証を通過して完了したタスク: taskId -> 計算ノード数 */
  done: Record<string, number>;
  /** 配布中（リース中）のタスク: taskId -> リース情報 */
  leases: Record<string, LeaseInfo>;
};

export type PoolProgress = {
  totalTasks: number;
  completedTasks: number;
  /** 検証済みの累計計算ノード数 */
  totalNodes: number;
  /** カタログ全体のノード数（目標） */
  targetNodes: number;
  percent: number;
};

export function emptyPoolState(): ComputePoolState {
  return { version: 1, done: {}, leases: {} };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** bot_kv から読んだ生データを、壊れた項目を落として安全な形へ寄せる。 */
export function parsePoolState(raw: unknown): ComputePoolState {
  const state = emptyPoolState();
  if (!isPlainObject(raw)) return state;
  if (isPlainObject(raw.done)) {
    for (const [taskId, nodes] of Object.entries(raw.done)) {
      const clean = cleanCount(nodes);
      if (clean !== null) state.done[taskId] = clean;
    }
  }
  if (isPlainObject(raw.leases)) {
    for (const [taskId, lease] of Object.entries(raw.leases)) {
      if (!isPlainObject(lease)) continue;
      const exp = typeof lease.exp === "number" && Number.isFinite(lease.exp) ? lease.exp : null;
      const token = typeof lease.token === "string" && lease.token !== "" ? lease.token : null;
      if (exp !== null && token !== null) state.leases[taskId] = { exp, token };
    }
  }
  return state;
}

/** カタログに無いタスクの記録と、完了済みタスクのリースを掃除する。 */
export function sanitizePoolState(
  state: ComputePoolState,
  catalog: readonly ComputeTaskDef[],
): ComputePoolState {
  const known = new Set(catalog.map((t) => t.id));
  for (const taskId of Object.keys(state.done)) {
    if (!known.has(taskId)) delete state.done[taskId];
  }
  for (const taskId of Object.keys(state.leases)) {
    if (!known.has(taskId) || taskId in state.done) delete state.leases[taskId];
  }
  return state;
}

/**
 * 未完了かつリース空き（または期限切れ）のタスクをカタログ順に1つ貸し出す。
 * 貸し出せるタスクが無ければ null。
 */
export function leaseNextTask(
  state: ComputePoolState,
  catalog: readonly ComputeTaskDef[],
  now: number,
  token: string,
  leaseTtlMs: number = LEASE_TTL_MS,
): { task: ComputeTaskDef; expiresAt: number } | null {
  for (const task of catalog) {
    if (task.id in state.done) continue;
    const lease = state.leases[task.id];
    if (lease && lease.exp > now) continue;
    const expiresAt = now + leaseTtlMs;
    state.leases[task.id] = { exp: expiresAt, token };
    return { task, expiresAt };
  }
  return null;
}

export type SubmitOutcome = "accepted" | "duplicate" | "mismatch";

/**
 * 結果を受け付ける。正解値との照合を通ったものだけを完了として記録する（冪等）。
 * 不一致の場合、送信者がリース保持者ならリースを解放して再配布可能にする。
 */
export function submitVerifiedResult(
  state: ComputePoolState,
  task: ComputeTaskDef,
  nodes: number,
  token: string,
): SubmitOutcome {
  if (task.id in state.done) return "duplicate";
  if (nodes !== task.expected) {
    const lease = state.leases[task.id];
    if (lease && lease.token === token) delete state.leases[task.id];
    return "mismatch";
  }
  state.done[task.id] = nodes;
  delete state.leases[task.id];
  return "accepted";
}

export function poolProgress(
  state: ComputePoolState,
  totalTasks: number,
  targetNodes: number,
): PoolProgress {
  const doneEntries = Object.values(state.done);
  const completedTasks = doneEntries.length;
  const totalNodes = doneEntries.reduce((sum, n) => sum + n, 0);
  const percent = totalTasks > 0 ? Math.floor((completedTasks / totalTasks) * 1000) / 10 : 0;
  return { totalTasks, completedTasks, totalNodes, targetNodes, percent };
}

/** 結果 POST のボディ検証。余分な型・範囲外の値は受け付けない。 */
export function parseResultBody(
  raw: unknown,
): { taskId: string; nodes: number; token: string } | null {
  if (!isPlainObject(raw)) return null;
  const { taskId, nodes, token } = raw;
  if (typeof taskId !== "string" || taskId === "" || taskId.length > 128) return null;
  if (typeof nodes !== "number" || !Number.isSafeInteger(nodes) || nodes < 0 || nodes > 1_000_000_000) {
    return null;
  }
  if (typeof token !== "string" || token.length < 8 || token.length > 64) return null;
  return { taskId, nodes, token };
}

/** 単純なスライディングウィンドウ判定（タイムスタンプ列は呼び出し側が保持する）。 */
export function isRateLimited(
  timestamps: readonly number[],
  now: number,
  limit: number,
  windowMs: number,
): boolean {
  let count = 0;
  for (const ts of timestamps) {
    if (now - ts < windowMs) count += 1;
  }
  return count >= limit;
}
