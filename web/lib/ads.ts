// 広告申請システムのサーバー側処理（bot_kv の partner_ads 読み書き、clef スクリーニング、オーナー判定）
// 仕様: ~/workspace/goals/ago-bot-2/files/ad-application-system-spec-2026-11-10.md
import { NextResponse } from "next/server";
import { getRequestSession } from "./auth";
import { kvGet, kvList, kvSet } from "./bot-api";
import { getDashboardContext, type DashboardContext } from "./dashboard";
import {
  buildScreeningRequest,
  normalizeApplication,
  parseScreeningResponse,
  unavailableScreening,
  SCREENING_MODEL,
  type AdApplication,
  type AdScreening,
  type ScreeningInput,
} from "./ads-core";
import { logfareApiKeys } from "./one-prompter-server";

export const PARTNER_ADS_NAMESPACE = "partner_ads";

const DECISION_TIMEOUT_MS = 30_000;

function logfareBaseUrl(): string {
  return (process.env.LOGFARE_BASE_URL?.trim() || "https://logfare.ai/v1").replace(/\/+$/, "");
}

/** bot_kv の partner_ads を全件読む。形式が壊れているレコードは落とす。 */
export async function loadAllApplications(): Promise<AdApplication[]> {
  const rows = await kvList(PARTNER_ADS_NAMESPACE);
  const apps: AdApplication[] = [];
  for (const [key, value] of rows) {
    const app = normalizeApplication(key, value);
    if (app) apps.push(app);
  }
  apps.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return apps;
}

export async function loadApplication(id: string): Promise<AdApplication | null> {
  const raw = await kvGet(PARTNER_ADS_NAMESPACE, id);
  return raw === null ? null : normalizeApplication(id, raw);
}

export async function saveApplication(app: AdApplication): Promise<void> {
  await kvSet(PARTNER_ADS_NAMESPACE, app.id, app);
}

/**
 * Logfare decision API（モデル clef）で申請文をスクリーニングする。
 * Bot 側 logfare.decision と同じ /decisions 形式（model / state / questions）で送り、
 * キーの切り替えは HTTP 429 のときだけ（キー値はログに出さない）。
 * 失敗しても例外は外に出さず「未実施（unavailable）」を返す — 申請自体は落とさない。
 */
export async function runScreening(input: ScreeningInput): Promise<AdScreening> {
  const at = new Date().toISOString();
  const keys = logfareApiKeys();
  if (keys.length === 0) {
    console.error("[Ads] LOGFARE_API_KEY が未設定のためスクリーニングを未実施で登録します");
    return unavailableScreening(at);
  }
  const { state, questions } = buildScreeningRequest(input);
  const payload = { model: SCREENING_MODEL, state, questions };
  for (let i = 0; i < keys.length; i++) {
    let response: Response;
    try {
      response = await fetch(`${logfareBaseUrl()}/decisions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${keys[i]}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        cache: "no-store",
        signal: AbortSignal.timeout(DECISION_TIMEOUT_MS),
      });
    } catch (error) {
      // ネットワークエラー・タイムアウトはキーを替えずに未実施として扱う
      console.error("[Ads] clef スクリーニングの呼び出しに失敗しました（未実施で登録します）", error);
      return unavailableScreening(at);
    }
    if (response.status === 429) {
      console.warn(`[Ads] Logfare key #${i + 1} returned 429, failing over to next key`);
      continue;
    }
    if (!response.ok) {
      console.error(`[Ads] clef スクリーニングが HTTP ${response.status} を返しました（未実施で登録します）`);
      return unavailableScreening(at);
    }
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      console.error("[Ads] clef スクリーニングの応答を解釈できませんでした（未実施で登録します）");
      return unavailableScreening(at);
    }
    const screening = parseScreeningResponse(data, at);
    if (!screening) {
      console.error("[Ads] clef スクリーニングの応答に使える判定がありませんでした（未実施で登録します）");
      return unavailableScreening(at);
    }
    return screening;
  }
  // 全キー 429
  console.error("[Ads] clef スクリーニングが全キーで 429 でした（未実施で登録します）");
  return unavailableScreening(at);
}

/** オーナーの Discord ID（環境変数 OWNER_DISCORD_ID）。未設定なら審査は誰にも開かない。 */
export function ownerDiscordId(): string | null {
  const value = process.env.OWNER_DISCORD_ID?.trim();
  return value && /^\d+$/.test(value) ? value : null;
}

export function isOwner(userId: string): boolean {
  const owner = ownerDiscordId();
  return owner !== null && userId === owner;
}

type Authorized = { context: DashboardContext };
type Denied = { error: NextResponse };

/** ダッシュボード用ログイン（sid 付き）＋権限再検証を通した文脈を返す。 */
export async function authorizeAdsRequest(request: Request): Promise<Authorized | Denied> {
  const session = getRequestSession(request);
  if (!session) return { error: NextResponse.json({ error: "ログインが必要です" }, { status: 401 }) };
  if (!session.sid) return { error: NextResponse.json({ error: "再ログインが必要です" }, { status: 401 }) };
  const context = await getDashboardContext(session);
  if (!context) {
    return { error: NextResponse.json({ error: "セッションを確認できませんでした。再ログインしてください" }, { status: 401 }) };
  }
  return { context };
}

/** オーナー専用。OWNER_DISCORD_ID 未設定の環境では存在しないものとして 404 を返す。 */
export async function authorizeOwnerRequest(request: Request): Promise<Authorized | Denied> {
  if (!ownerDiscordId()) {
    return { error: NextResponse.json({ error: "見つかりません" }, { status: 404 }) };
  }
  const authorized = await authorizeAdsRequest(request);
  if ("error" in authorized) return authorized;
  if (!isOwner(authorized.context.user.id)) {
    return { error: NextResponse.json({ error: "権限がありません" }, { status: 403 }) };
  }
  return authorized;
}
