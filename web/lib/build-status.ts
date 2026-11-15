// Web デプロイのビルド状態（deploy/write_build_status.py が書く JSON）の
// 純粋ロジック。ファイル読み込みは lib/build-status-server.ts、表示は
// app/BuildStatusBanner.tsx と app/status/page.tsx が担う。

/** ビルド状態ファイルの既定パス（Pi 上の Web ルート。deploy 側と一致させる）。 */
export const BUILD_STATUS_DEFAULT_PATH = "/srv/supabase-data/agobot-web/build-status.json";

/** PR へのリンク先リポジトリ。 */
export const GITHUB_REPO_URL = "https://github.com/deshihito/BOT";

export type BuildState = "building" | "deployed" | "failed";

export type BuildPr = { number: number; title: string };

export type BuildStatus = {
  state: BuildState;
  /** 対象コミットのフル SHA（40桁 hex）。不明な場合は空文字。 */
  commit: string;
  prs: BuildPr[];
  started_at: string;
  finished_at: string | null;
  updated_at: string;
};

const BUILD_STATES: readonly string[] = ["building", "deployed", "failed"];
const SHA_RE = /^[0-9a-f]{40}$/;

function cleanIso(raw: unknown): string | null {
  return typeof raw === "string" && raw !== "" && !Number.isNaN(Date.parse(raw)) ? raw : null;
}

function cleanPrs(raw: unknown): BuildPr[] {
  if (!Array.isArray(raw)) return [];
  const prs: BuildPr[] = [];
  const seen = new Set<number>();
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    if (typeof record.number !== "number" || !Number.isFinite(record.number)) continue;
    const number = Math.trunc(record.number);
    if (number <= 0 || seen.has(number)) continue;
    seen.add(number);
    prs.push({ number, title: typeof record.title === "string" ? record.title : "" });
  }
  return prs;
}

/** デプロイ側が書いた生 JSON を、表示に使える形へ検証して寄せる。壊れていれば null。 */
export function parseBuildStatus(raw: unknown): BuildStatus | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.state !== "string" || !BUILD_STATES.includes(record.state)) return null;
  const startedAt = cleanIso(record.started_at);
  const updatedAt = cleanIso(record.updated_at);
  if (startedAt === null || updatedAt === null) return null;
  return {
    state: record.state as BuildState,
    commit: typeof record.commit === "string" && SHA_RE.test(record.commit) ? record.commit : "",
    prs: cleanPrs(record.prs),
    started_at: startedAt,
    finished_at: cleanIso(record.finished_at),
    updated_at: updatedAt,
  };
}

/** ビルドは通常数分で終わる。これを過ぎた building は、書き手が落ちた残骸とみなす。 */
export const BUILDING_STALE_MS = 30 * 60 * 1000;

/** いまビルド中として表示すべき状態かどうか（古い building 残骸は表示しない）。 */
export function isActivelyBuilding(status: BuildStatus, now: Date = new Date()): boolean {
  if (status.state !== "building") return false;
  const startedMs = Date.parse(status.started_at);
  if (Number.isNaN(startedMs)) return false;
  return now.getTime() - startedMs <= BUILDING_STALE_MS;
}

/** PR 1件への GitHub リンク。 */
export function prUrl(number: number): string {
  return `${GITHUB_REPO_URL}/pull/${number}`;
}
