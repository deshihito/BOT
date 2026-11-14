// viewslopper の診断履歴（この端末の localStorage に保存する）。
// ログインを持たないサービスなので、保存は端末ローカルが前提。
// サーバーには送らない・残さない。別端末とは同期しない。

export const HISTORY_KEY = "viewslopper.history.v1";
export const HISTORY_LIMIT = 50;

export type HistoryEntry = {
  savedAt: number;
  url: string;
  title: string;
  score: number;
  grade: string;
  uxFriction: number | null;
  appearanceScore: number | null;
  /** 詳細表示用の結果まるごと（API応答の形） */
  result: unknown;
};

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** API応答から履歴エントリを作る。形が壊れていたら null。 */
export function toHistoryEntry(result: unknown, savedAt: number): HistoryEntry | null {
  if (!result || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;
  if (typeof r.url !== "string" || typeof r.score !== "number") return null;
  const ux = (r.ux ?? null) as Record<string, unknown> | null;
  const appearance = (r.appearance ?? null) as Record<string, unknown> | null;
  return {
    savedAt,
    url: r.url,
    title: typeof r.title === "string" ? r.title : "",
    score: r.score,
    grade: typeof r.grade === "string" ? r.grade : "",
    uxFriction: ux && typeof ux.friction === "number" ? ux.friction : null,
    appearanceScore: appearance && typeof appearance.score === "number" ? appearance.score : null,
    result,
  };
}

function isValidEntry(value: unknown): value is HistoryEntry {
  if (!value || typeof value !== "object") return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.savedAt === "number" &&
    typeof e.url === "string" &&
    typeof e.score === "number" &&
    "result" in e
  );
}

/** 履歴を読む。壊れたデータは捨てて、読める分だけ返す。 */
export function loadHistory(storage: StorageLike): HistoryEntry[] {
  try {
    const raw = storage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidEntry).slice(0, HISTORY_LIMIT);
  } catch {
    return [];
  }
}

/**
 * 履歴に1件足して保存する。同じ URL は最新だけ残し（先頭へ移動）、
 * 上限を超えた分は古いものから捨てる。保存後の配列を返す。
 */
export function saveHistory(storage: StorageLike, entry: HistoryEntry | null): HistoryEntry[] {
  const current = loadHistory(storage);
  if (!entry) return current;
  const next = [entry, ...current.filter((e) => e.url !== entry.url)].slice(0, HISTORY_LIMIT);
  try {
    storage.setItem(HISTORY_KEY, JSON.stringify(next));
  } catch {
    // 容量超過などでは保存を諦める（診断自体は成立している）
  }
  return next;
}

/** 1件削除して保存する。 */
export function removeHistoryEntry(storage: StorageLike, savedAt: number): HistoryEntry[] {
  const next = loadHistory(storage).filter((e) => e.savedAt !== savedAt);
  try {
    storage.setItem(HISTORY_KEY, JSON.stringify(next));
  } catch {
    // noop
  }
  return next;
}

/** 全件削除する。 */
export function clearHistory(storage: StorageLike): void {
  try {
    storage.removeItem(HISTORY_KEY);
  } catch {
    // noop
  }
}
