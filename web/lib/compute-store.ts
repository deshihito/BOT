// クライアント分散コンピューティングのサーバー側ストア（サーバー専用）。
// 状態は Bot API 経由で bot_kv（compute_pool 名前空間、キー "state"）に保持する。
// 読み→変更→書きを同一プロセス内で直列化し、二重計上やリースの競合を防ぐ。
// Pi 側では重い再計算を一切しない（合計は done の値の単純な合算のみ）。
import { randomUUID } from "node:crypto";
import { isBotApiConfigured, kvGet, kvSet } from "./bot-api";
import {
  COMPUTE_CATALOG,
  COMPUTE_CATALOG_TOTAL_NODES,
  COMPUTE_CATALOG_TOTAL_TASKS,
  findComputeTask,
} from "./compute-catalog";
import {
  COMPUTE_POOL_NAMESPACE,
  COMPUTE_POOL_STATE_KEY,
  isRateLimited,
  leaseNextTask,
  parsePoolState,
  poolProgress,
  sanitizePoolState,
  submitVerifiedResult,
  type ComputePoolState,
  type PoolProgress,
  type SubmitOutcome,
} from "./compute-core";

export type LeasedTask = {
  taskId: string;
  fen: string;
  depth: number;
  leaseToken: string;
  expiresAt: number;
};

export type SubmitResult = {
  outcome: SubmitOutcome | "unknown_task";
  progress: PoolProgress;
};

let queue: Promise<void> = Promise.resolve();

function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function loadState(): Promise<ComputePoolState> {
  const raw = await kvGet(COMPUTE_POOL_NAMESPACE, COMPUTE_POOL_STATE_KEY);
  return sanitizePoolState(parsePoolState(raw), COMPUTE_CATALOG);
}

async function saveState(state: ComputePoolState): Promise<void> {
  await kvSet(COMPUTE_POOL_NAMESPACE, COMPUTE_POOL_STATE_KEY, state);
}

function currentProgress(state: ComputePoolState): PoolProgress {
  return poolProgress(state, COMPUTE_CATALOG_TOTAL_TASKS, COMPUTE_CATALOG_TOTAL_NODES);
}

export function isComputeConfigured(): boolean {
  return isBotApiConfigured();
}

/** 全体の進捗（読み取りのみ）。 */
export async function getComputeProgress(): Promise<PoolProgress> {
  const state = await withLock(loadState);
  return currentProgress(state);
}

/** タスクを1つ貸し出す。貸し出せるタスクが無ければ null（カタログ完了）。 */
export async function leaseComputeTask(): Promise<{ lease: LeasedTask; progress: PoolProgress } | null> {
  return withLock(async () => {
    const state = await loadState();
    const token = randomUUID();
    const leased = leaseNextTask(state, COMPUTE_CATALOG, Date.now(), token);
    if (!leased) return null;
    await saveState(state);
    return {
      lease: {
        taskId: leased.task.id,
        fen: leased.task.fen,
        depth: leased.task.depth,
        leaseToken: token,
        expiresAt: leased.expiresAt,
      },
      progress: currentProgress(state),
    };
  });
}

/** 結果を受け付け、正解値と照合してから集計に加える。 */
export async function submitComputeResult(
  taskId: string,
  nodes: number,
  token: string,
): Promise<SubmitResult> {
  return withLock(async () => {
    const state = await loadState();
    const task = findComputeTask(taskId);
    if (!task) return { outcome: "unknown_task" as const, progress: currentProgress(state) };
    const outcome = submitVerifiedResult(state, task, nodes, token);
    if (outcome === "accepted" || outcome === "mismatch") await saveState(state);
    return { outcome, progress: currentProgress(state) };
  });
}

// --- 簡易レート制限（プロセス内メモリ。IP ごとのスライディングウィンドウ） ---

const RATE_WINDOW_MS = 60 * 1000;
const buckets = new Map<string, number[]>();

export function allowComputeRequest(kind: "task" | "result", clientKey: string): boolean {
  const limit = kind === "task" ? 60 : 120;
  const key = `${kind}:${clientKey}`;
  const now = Date.now();
  const timestamps = (buckets.get(key) ?? []).filter((ts) => now - ts < RATE_WINDOW_MS);
  if (isRateLimited(timestamps, now, limit, RATE_WINDOW_MS)) {
    buckets.set(key, timestamps);
    return false;
  }
  timestamps.push(now);
  buckets.set(key, timestamps);
  return true;
}

/** API ルート用のクライアント識別子（Cloudflare Tunnel 経由のヘッダを優先）。 */
export function computeClientKey(request: Request): string {
  const cfIp = request.headers.get("cf-connecting-ip");
  if (cfIp) return cfIp.slice(0, 64);
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim().slice(0, 64);
  return "unknown";
}
