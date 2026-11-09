"use client";

// 分散コンピューティングの参加UI（クライアント専用）。
// 計算は「計算をはじめる」を押したときだけ始まり、Web Worker 内で実行する。
// 個人の貢献数はこのブラウザの localStorage にだけ残し、サーバーへは送らない。
import { useEffect, useRef, useState } from "react";

type Progress = {
  suite: string;
  totalTasks: number;
  completedTasks: number;
  totalNodes: number;
  targetNodes: number;
  percent: number;
};

type HistoryEntry = {
  suite: string;
  totalTasks: number | null;
  completedTasks: number;
  totalNodes: number;
  targetNodes: number | null;
  completed: boolean;
  archivedAt: number;
};

function formatSuiteLabel(suite: string): string {
  return /^v\d+$/.test(suite) ? `スイート${suite.slice(1)}` : suite;
}

function formatHistoryLine(entry: HistoryEntry): string {
  const label = formatSuiteLabel(entry.suite);
  if (entry.completed) {
    return `${label}：${formatNumber(entry.completedTasks)}タスク／${formatNumber(entry.totalNodes)}ノード 完走`;
  }
  if (entry.totalTasks !== null) {
    return `${label}：${formatNumber(entry.completedTasks)} / ${formatNumber(entry.totalTasks)}タスク・${formatNumber(entry.totalNodes)}ノードまで完了`;
  }
  return `${label}：${formatNumber(entry.completedTasks)}タスク・${formatNumber(entry.totalNodes)}ノードまで完了`;
}

type LeaseResponse =
  | { taskId: string; fen: string; depth: number; leaseToken: string; expiresAt: number; progress: Progress }
  | { done: true };

type MyStats = { tasks: number; nodes: number };

const STORAGE_KEY = "agobot-compute-contrib-v1";
const REST_MS = 200;
const RETRY_MS = 5000;

function loadStats(): MyStats {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<MyStats>;
      if (typeof parsed.tasks === "number" && typeof parsed.nodes === "number") {
        return { tasks: parsed.tasks, nodes: parsed.nodes };
      }
    }
  } catch {
    // 読めなければ 0 から
  }
  return { tasks: 0, nodes: 0 };
}

function saveStats(stats: MyStats): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stats));
  } catch {
    // 保存できなくても計算は続行する
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatNumber(n: number): string {
  return n.toLocaleString("ja-JP");
}

export default function ComputeClient() {
  const [progress, setProgress] = useState<Progress | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [progressUnavailable, setProgressUnavailable] = useState(false);
  const [running, setRunning] = useState(false);
  const [tabHidden, setTabHidden] = useState(false);
  const [finished, setFinished] = useState(false);
  const [session, setSession] = useState<MyStats>({ tasks: 0, nodes: 0 });
  const [total, setTotal] = useState<MyStats>({ tasks: 0, nodes: 0 });
  const [message, setMessage] = useState("「計算をはじめる」を押すまで、計算は始まりません。");

  const runIdRef = useRef(0);
  const workersRef = useRef<Worker[]>([]);
  const pendingRef = useRef(new Map<number, { resolve: (v: { nodes: number }) => void; reject: (e: Error) => void }>());
  const stopRef = useRef<() => void>(() => {});

  const stop = () => {
    runIdRef.current += 1;
    for (const worker of workersRef.current) worker.terminate();
    workersRef.current = [];
    pendingRef.current.clear();
    setRunning(false);
  };
  stopRef.current = stop;

  const fetchProgress = async () => {
    try {
      const res = await fetch("/api/compute/status");
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as { progress: Progress; history?: HistoryEntry[] };
      setProgress(data.progress);
      if (Array.isArray(data.history)) setHistory(data.history);
      setProgressUnavailable(false);
      if (data.progress.completedTasks >= data.progress.totalTasks && data.progress.totalTasks > 0) {
        setFinished(true);
      }
    } catch {
      setProgressUnavailable(true);
    }
  };

  useEffect(() => {
    setTotal(loadStats());
    void fetchProgress();
    const onVisibility = () => setTabHidden(document.hidden);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      runIdRef.current += 1;
      for (const worker of workersRef.current) worker.terminate();
      workersRef.current = [];
    };
    // 初回マウント時のみ
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void fetchProgress(), 15_000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);

  const addMyStats = (tasks: number, nodes: number) => {
    setSession((prev) => ({ tasks: prev.tasks + tasks, nodes: prev.nodes + nodes }));
    setTotal((prev) => {
      const next = { tasks: prev.tasks + tasks, nodes: prev.nodes + nodes };
      saveStats(next);
      return next;
    });
  };

  const computeOnWorker = (slot: number, worker: Worker, task: { taskId: string; fen: string; depth: number }) =>
    new Promise<{ nodes: number }>((resolve, reject) => {
      pendingRef.current.set(slot, { resolve, reject });
      worker.postMessage({ type: "run", taskId: task.taskId, fen: task.fen, depth: task.depth });
    });

  const runSlot = async (slot: number, runId: number, worker: Worker) => {
    while (runIdRef.current === runId) {
      if (document.hidden) {
        await sleep(800);
        continue;
      }
      let lease: LeaseResponse | null = null;
      try {
        const res = await fetch("/api/compute/task", { method: "POST" });
        if (!res.ok) throw new Error(String(res.status));
        lease = (await res.json()) as LeaseResponse;
      } catch {
        if (runIdRef.current !== runId) return;
        setMessage("サーバーに接続できませんでした。少し待ってから自動で再試行します。");
        await sleep(RETRY_MS);
        continue;
      }
      if (runIdRef.current !== runId) return;
      if ("done" in lease) {
        setFinished(true);
        setMessage("すべてのタスクが完了しています。ご協力ありがとうございました！");
        stopRef.current();
        return;
      }
      setProgress(lease.progress);
      let nodes: number;
      try {
        const result = await computeOnWorker(slot, worker, lease);
        nodes = result.nodes;
      } catch {
        await sleep(1000);
        continue;
      }
      if (runIdRef.current !== runId) return;
      try {
        const res = await fetch("/api/compute/result", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ taskId: lease.taskId, nodes, token: lease.leaseToken }),
        });
        const data = (await res.json().catch(() => null)) as { status?: string; progress?: Progress } | null;
        if (res.ok && data?.status === "accepted") {
          addMyStats(1, nodes);
          setMessage(`タスクを1件完了しました（${formatNumber(nodes)} ノード計算）。`);
          if (data.progress) setProgress(data.progress);
        } else if (res.ok && data?.status === "duplicate") {
          setMessage("そのタスクは他の参加者が先に完了していました。次のタスクに進みます。");
          if (data?.progress) setProgress(data.progress);
        } else if (res.status === 422) {
          setMessage("結果を照合できませんでした。次のタスクに進みます。");
        }
      } catch {
        // 送信に失敗した結果は、リース期限の経過後に他の参加者へ再配布される
      }
      await sleep(REST_MS);
    }
  };

  const start = () => {
    if (running) return;
    const runId = runIdRef.current + 1;
    runIdRef.current = runId;
    setFinished(false);
    setRunning(true);
    setMessage("計算中です。タブを開いたままにしてください。");
    const concurrency = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
    const workers: Worker[] = [];
    for (let slot = 0; slot < concurrency; slot++) {
      const worker = new Worker(new URL("../../lib/compute.worker.ts", import.meta.url), { type: "module" });
      worker.onmessage = (event) => {
        const pending = pendingRef.current.get(slot);
        if (!pending) return;
        pendingRef.current.delete(slot);
        const data = event.data as { type?: string; nodes?: number; message?: string };
        if (data?.type === "result" && typeof data.nodes === "number") pending.resolve({ nodes: data.nodes });
        else pending.reject(new Error(data?.message ?? "worker error"));
      };
      worker.onerror = () => {
        const pending = pendingRef.current.get(slot);
        if (pending) {
          pendingRef.current.delete(slot);
          pending.reject(new Error("worker error"));
        }
      };
      workers.push(worker);
    }
    workersRef.current = workers;
    workers.forEach((worker, slot) => void runSlot(slot, runId, worker));
  };

  const statusText = running
    ? tabHidden
      ? "タブが裏に回っているため一時停止中です"
      : "計算中です"
    : finished
      ? "全タスク完了"
      : "停止中";

  return (
    <section className="compute-panel" aria-label="計算への参加">
      <div className="compute-actions">
        {running ? (
          <button type="button" className="compute-stop" onClick={stop}>
            停止する
          </button>
        ) : (
          <button type="button" className="compute-start" onClick={start} disabled={finished}>
            計算をはじめる
          </button>
        )}
        <p className="compute-status" role="status">
          状態：{statusText}
        </p>
      </div>
      <p className="compute-status">{message}</p>

      <div>
        {progress ? (
          <p className="compute-status">現在のスイート：{formatSuiteLabel(progress.suite)}</p>
        ) : null}
        <p className="compute-status">
          全体の進捗：
          {progress
            ? `完了タスク ${formatNumber(progress.completedTasks)} / ${formatNumber(progress.totalTasks)} 件`
            : progressUnavailable
              ? "取得できませんでした"
              : "読み込み中"}
        </p>
        <div className="compute-progress" aria-hidden="true">
          <div style={{ width: `${progress ? progress.percent : 0}%` }} />
        </div>
        {progress ? (
          <p className="compute-status">
            進捗 {progress.percent}% ・ 検証済みノード {formatNumber(progress.totalNodes)} /{" "}
            {formatNumber(progress.targetNodes)}
          </p>
        ) : null}
      </div>

      {history.length > 0 ? (
        <div className="compute-history">
          <p className="compute-history-title">これまでのスイートの実績</p>
          <ul>
            {history.map((entry) => (
              <li key={entry.suite}>{formatHistoryLine(entry)}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="compute-stats">
        <div className="compute-stat">
          <span>あなたの貢献（今回）</span>
          <strong>
            {formatNumber(session.tasks)} 件 / {formatNumber(session.nodes)} ノード
          </strong>
        </div>
        <div className="compute-stat">
          <span>あなたの貢献（このブラウザの累計）</span>
          <strong>
            {formatNumber(total.tasks)} 件 / {formatNumber(total.nodes)} ノード
          </strong>
        </div>
      </div>
    </section>
  );
}
