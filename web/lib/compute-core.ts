// クライアント分散コンピューティングのプール管理ロジック（純粋関数）。
// 状態は Bot API 経由で bot_kv の compute_pool 名前空間に保持する。
// サーバー（Pi）側は配布・照合・集計だけを行い、計算そのものはしない。
//
// 状態は「スイート」（タスクカタログの世代）単位で管理する。現行スイートと
// 世代の異なる状態を読んだら、旧スイートの実績を history へ退避してから
// 現行スイートの空状態に切り替える（migratePoolState、冪等）。
import type { ComputeTaskDef } from "./compute-catalog";

/** プール状態を置く bot_kv の名前空間とキー。 */
export const COMPUTE_POOL_NAMESPACE = "compute_pool";
export const COMPUTE_POOL_STATE_KEY = "state";
export const COMPUTE_POOL_HISTORY_KEY = "history";

/** スイート識別子を持たない旧形式の状態が属する世代。 */
export const LEGACY_SUITE_ID = "v1";

/** 過去スイートの既知の規模（アーカイブ表示用）。未知の世代は null になる。 */
export const KNOWN_SUITE_TOTALS: Readonly<Record<string, { totalTasks: number; targetNodes: number }>> = {
  v1: { totalTasks: 613, targetNodes: 41812668 },
};

/** リースの有効期限。これを過ぎたタスクは未完了として再配布される。 */
export const LEASE_TTL_MS = 3 * 60 * 1000;

export type LeaseInfo = { exp: number; token: string };

export type ComputePoolState = {
  version: 2;
  /** この状態が属するスイート識別子。 */
  suite: string;
  /** 検証を通過して完了したタスク: taskId -> 計算ノード数 */
  done: Record<string, number>;
  /** 配布中（リース中）のタスク: taskId -> リース情報 */
  leases: Record<string, LeaseInfo>;
};

/** 退避された過去スイートの実績。 */
export type ArchivedSuiteRecord = {
  suite: string;
  /** スイート全体のタスク数（既知の場合のみ） */
  totalTasks: number | null;
  completedTasks: number;
  /** 検証済みの累計計算ノード数 */
  totalNodes: number;
  /** スイート全体のノード数（既知の場合のみ） */
  targetNodes: number | null;
  completed: boolean;
  archivedAt: number;
};

export type PoolProgress = {
  suite: string;
  totalTasks: number;
  completedTasks: number;
  /** 検証済みの累計計算ノード数 */
  totalNodes: number;
  /** カタログ全体のノード数（目標） */
  targetNodes: number;
  percent: number;
};

export function emptyPoolState(suiteId: string = LEGACY_SUITE_ID): ComputePoolState {
  return { version: 2, suite: suiteId, done: {}, leases: {} };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function cleanNonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * bot_kv から読んだ生データを、壊れた項目を落として安全な形へ寄せる。
 * suite を持たない旧形式（version 1）は LEGACY_SUITE_ID の状態として扱う。
 */
export function parsePoolState(raw: unknown): ComputePoolState {
  const state = emptyPoolState();
  if (!isPlainObject(raw)) return state;
  if (typeof raw.suite === "string" && raw.suite !== "") state.suite = raw.suite;
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
 * 旧スイートの状態からアーカイブ記録を作る。
 * 完了・リースとも空の状態（実績なし）は退避する意味がないので null。
 */
export function buildArchiveRecord(
  state: ComputePoolState,
  archivedAt: number,
): ArchivedSuiteRecord | null {
  const doneEntries = Object.values(state.done);
  if (doneEntries.length === 0 && Object.keys(state.leases).length === 0) return null;
  const known = KNOWN_SUITE_TOTALS[state.suite];
  const completedTasks = doneEntries.length;
  return {
    suite: state.suite,
    totalTasks: known ? known.totalTasks : null,
    completedTasks,
    totalNodes: doneEntries.reduce((sum, n) => sum + n, 0),
    targetNodes: known ? known.targetNodes : null,
    completed: known ? completedTasks >= known.totalTasks : false,
    archivedAt,
  };
}

/**
 * 状態の世代を現行スイートへ移行する。
 * 既に現行スイートなら状態をそのまま返し、アーカイブは作らない。
 * 世代が異なれば旧実績のアーカイブと、現行スイートの空状態を返す。
 */
export function migratePoolState(
  state: ComputePoolState,
  currentSuiteId: string,
  archivedAt: number,
): { state: ComputePoolState; archive: ArchivedSuiteRecord | null } {
  if (state.suite === currentSuiteId) return { state, archive: null };
  return {
    state: emptyPoolState(currentSuiteId),
    archive: buildArchiveRecord(state, archivedAt),
  };
}

/** history の生データを安全な形へ寄せる。同じスイートは最初の1件だけ残す。 */
export function parseSuiteHistory(raw: unknown): ArchivedSuiteRecord[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const history: ArchivedSuiteRecord[] = [];
  for (const entry of raw) {
    if (!isPlainObject(entry)) continue;
    const suite = typeof entry.suite === "string" && entry.suite !== "" ? entry.suite : null;
    const completedTasks = cleanNonNegative(entry.completedTasks);
    const totalNodes = cleanNonNegative(entry.totalNodes);
    const archivedAt = typeof entry.archivedAt === "number" && Number.isFinite(entry.archivedAt) ? entry.archivedAt : null;
    if (suite === null || completedTasks === null || totalNodes === null || archivedAt === null) continue;
    if (seen.has(suite)) continue;
    seen.add(suite);
    history.push({
      suite,
      totalTasks: cleanNonNegative(entry.totalTasks),
      completedTasks,
      totalNodes,
      targetNodes: cleanNonNegative(entry.targetNodes),
      completed: entry.completed === true,
      archivedAt,
    });
  }
  return history;
}

/** アーカイブを history へ追加する。同じスイートが既にあれば何もしない（冪等）。 */
export function appendSuiteHistory(
  history: readonly ArchivedSuiteRecord[],
  record: ArchivedSuiteRecord | null,
): ArchivedSuiteRecord[] {
  if (record === null) return [...history];
  if (history.some((entry) => entry.suite === record.suite)) return [...history];
  return [...history, record];
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

/** 1回のバッチで貸し出すタスク数の上限。 */
export const MAX_LEASE_BATCH = 16;
/** 1回のバッチで受け付ける結果数の上限。 */
export const MAX_RESULT_BATCH = 32;

/**
 * 未完了かつリース空きのタスクを最大 maxCount 件までまとめて貸し出す。
 * サーバー側の状態の読み書きを1回に抑えるために使う（往復削減）。
 * 1バッチ内のタスクは同じトークンで貸し出す。
 */
export function leaseTaskBatch(
  state: ComputePoolState,
  catalog: readonly ComputeTaskDef[],
  now: number,
  token: string,
  maxCount: number,
  leaseTtlMs: number = LEASE_TTL_MS,
): { task: ComputeTaskDef; expiresAt: number }[] {
  const leased: { task: ComputeTaskDef; expiresAt: number }[] = [];
  const limit = Math.max(1, Math.min(MAX_LEASE_BATCH, Math.floor(maxCount) || 1));
  for (let i = 0; i < limit; i++) {
    const one = leaseNextTask(state, catalog, now, token, leaseTtlMs);
    if (!one) break;
    leased.push(one);
  }
  return leased;
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
  return { suite: state.suite, totalTasks, completedTasks, totalNodes, targetNodes, percent };
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

/** バッチ結果 POST のボディ検証。各要素は parseResultBody と同じ基準を通す。 */
export function parseBatchResultBody(
  raw: unknown,
): { taskId: string; nodes: number; token: string }[] | null {
  if (!isPlainObject(raw)) return null;
  const results = raw.results;
  if (!Array.isArray(results) || results.length === 0 || results.length > MAX_RESULT_BATCH) {
    return null;
  }
  const parsed: { taskId: string; nodes: number; token: string }[] = [];
  for (const item of results) {
    const one = parseResultBody(item);
    if (!one) return null;
    parsed.push(one);
  }
  return parsed;
}

/** バッチリース POST のボディから件数を取り出す。不正な値は null（=従来の1件リース）。 */
export function parseLeaseBatchCount(raw: unknown): number | null {
  if (!isPlainObject(raw)) return null;
  const count = raw.count;
  if (typeof count !== "number" || !Number.isSafeInteger(count)) return null;
  if (count < 2 || count > MAX_LEASE_BATCH) return null;
  return count;
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
