// AGO WORLD BOX の運用基盤（バッチ9b）: タイル差分ジャーナル・凍結・
// 巻き戻し・通報の型と純粋ロジック。保存は ops-online.ts。
import type { TileOverride } from "./tiles";

export interface TileJournalEntry {
  key: string;
  prev: TileOverride | null;
  next: TileOverride | null;
  actor: string;
  at: number;
}

export interface ReportEntry {
  id: string;
  reporter: string;
  text: string;
  x?: number;
  y?: number;
  at: number;
}

export const JOURNAL_DAILY_CAP = 500;
export const REPORTS_CAP = 200;

export function parseJournal(raw: unknown): TileJournalEntry[] {
  let data: unknown = raw;
  if (typeof raw === "string") {
    try {
      data = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(data)) return [];
  const out: TileJournalEntry[] = [];
  for (const v of data) {
    if (!v || typeof v !== "object" || Array.isArray(v)) continue;
    const e = v as Record<string, unknown>;
    if (typeof e.key !== "string" || typeof e.actor !== "string") continue;
    if (typeof e.at !== "number" || !Number.isFinite(e.at)) continue;
    out.push({
      key: e.key,
      prev: (e.prev as TileOverride | null) ?? null,
      next: (e.next as TileOverride | null) ?? null,
      actor: e.actor,
      at: Math.floor(e.at),
    });
  }
  return out.slice(-JOURNAL_DAILY_CAP);
}

export function appendJournal(
  entries: readonly TileJournalEntry[],
  entry: TileJournalEntry,
): TileJournalEntry[] {
  return [...entries, entry].slice(-JOURNAL_DAILY_CAP);
}

/**
 * 巻き戻し先の状態: 時刻 toAt の時点でそのタイルがどうだったか。
 * toAt 以前の最後の変更の next がその時点の状態。変更が無ければ
 * 最初の変更の prev（= 変更前の素の状態）。履歴に無ければ undefined。
 */
export function stateAtTime(
  entries: readonly TileJournalEntry[],
  key: string,
  toAt: number,
): TileOverride | null | undefined {
  const mine = entries.filter((e) => e.key === key);
  if (mine.length === 0) return undefined;
  let state: TileOverride | null = mine[0].prev;
  for (const e of mine) {
    if (e.at > toAt) break;
    state = e.next;
  }
  return state;
}

export function parseReports(raw: unknown): ReportEntry[] {
  let data: unknown = raw;
  if (typeof raw === "string") {
    try {
      data = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(data)) return [];
  const out: ReportEntry[] = [];
  for (const v of data) {
    if (!v || typeof v !== "object" || Array.isArray(v)) continue;
    const e = v as Record<string, unknown>;
    if (typeof e.id !== "string" || typeof e.reporter !== "string" || typeof e.text !== "string") continue;
    if (typeof e.at !== "number" || !Number.isFinite(e.at)) continue;
    out.push({
      id: e.id,
      reporter: e.reporter,
      text: e.text.slice(0, 300),
      x: typeof e.x === "number" ? Math.floor(e.x) : undefined,
      y: typeof e.y === "number" ? Math.floor(e.y) : undefined,
      at: Math.floor(e.at),
    });
  }
  return out.slice(-REPORTS_CAP);
}
