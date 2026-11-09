// 広告申請システムの純粋ロジック（環境変数・fetch に触れない。tests/ads.test.mjs で検証する）
//
// 仕様: ~/workspace/goals/ago-bot-2/files/ad-application-system-spec-2026-11-10.md
// レコードは bot_kv の partner_ads 名前空間に「1申請＝1キー」で置き、
// Bot（core/ads.py）は status=approved・期限内・対象ギルドが guild_registry に
// 現存するものだけを読み取り時に配信対象にする。

export type AdStatus = "pending" | "approved" | "rejected" | "expired" | "revoked";

export type RejectReason = "spam" | "shop" | "nsfw" | "mismatch" | "screening" | "other";

export const REJECT_REASONS: { value: RejectReason; label: string }[] = [
  { value: "spam", label: "スパム鯖と判断" },
  { value: "shop", label: "ショップ鯖と判断" },
  { value: "nsfw", label: "過度なNSFWと判断" },
  { value: "mismatch", label: "紹介文と実態の不一致" },
  { value: "screening", label: "自動スクリーニングによる却下" },
  { value: "other", label: "その他" },
];

export type ScreeningVerdict = "suspect" | "clear" | "unknown";

export type ScreeningCriteria = "spam" | "shop" | "nsfw" | "mismatch";

export type AdScreening = {
  /** done = clef の判定が取れた / unavailable = 呼び出し失敗（審査には回す） */
  status: "done" | "unavailable";
  at: string;
  model: string;
  verdicts: Record<ScreeningCriteria, ScreeningVerdict>;
  /** いずれかの観点で suspect のとき true（要確認フラグ） */
  flagged: boolean;
};

export type AdApplication = {
  id: string;
  guild_id: string;
  guild_name: string;
  applicant_user_id: string;
  text: string;
  url: string;
  status: AdStatus;
  screening: AdScreening | null;
  created_at: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
  reject_reason: RejectReason | null;
  reject_note: string | null;
  revoke_reason: "bot_removed" | "manual" | null;
  expires_at: string | null;
};

export const AD_TEXT_MAX = 60;
export const AD_TERM_DAYS = 30;
export const AD_GLOBAL_APPROVED_LIMIT = 20;
export const SCREENING_MODEL = "clef";
export const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------- 検証

export type ValidationResult = { ok: true; value: string } | { ok: false; error: string };

/** 紹介文: 60字以内・1行・URL不可（リンク先は招待リンク項目が担う）。 */
export function validateAdText(raw: unknown): ValidationResult {
  if (typeof raw !== "string") return { ok: false, error: "紹介文を入力してください" };
  const value = raw.trim();
  if (!value) return { ok: false, error: "紹介文を入力してください" };
  if (/[\r\n]/.test(value)) return { ok: false, error: "紹介文は1行で入力してください" };
  if ([...value].length > AD_TEXT_MAX) return { ok: false, error: `紹介文は${AD_TEXT_MAX}字以内で入力してください` };
  if (/https?:\/\//i.test(value) || /www\./i.test(value)) {
    return { ok: false, error: "紹介文にURLは書けません（リンク先は招待リンクで指定してください）" };
  }
  return { ok: true, value };
}

const INVITE_CODE = /^[A-Za-z0-9-]{2,64}$/;

/** 招待リンク: discord.gg/<コード> / discord.com/invite/<コード> のみ。 https://discord.gg/<コード> に正規化する。 */
export function normalizeInviteUrl(raw: unknown): ValidationResult {
  if (typeof raw !== "string") return { ok: false, error: "招待リンクを入力してください" };
  const value = raw.trim();
  const match =
    /^(?:https?:\/\/)?discord\.gg\/([A-Za-z0-9-]+)\/?$/.exec(value) ??
    /^(?:https?:\/\/)?discord\.com\/invite\/([A-Za-z0-9-]+)\/?$/.exec(value);
  if (!match || !INVITE_CODE.test(match[1])) {
    return { ok: false, error: "招待リンクは discord.gg または discord.com/invite の形式で入力してください" };
  }
  return { ok: true, value: `https://discord.gg/${match[1]}` };
}

/** 却下入力: 理由分類は必須、other のときは自由文も必須。自由文は500字まで。 */
export function validateRejectInput(reason: unknown, note: unknown): { ok: true; reason: RejectReason; note: string | null } | { ok: false; error: string } {
  if (typeof reason !== "string" || !REJECT_REASONS.some((item) => item.value === reason)) {
    return { ok: false, error: "却下理由を選んでください" };
  }
  const noteText = typeof note === "string" ? note.trim() : "";
  if (noteText.length > 500) return { ok: false, error: "却下理由の補足は500字以内で入力してください" };
  if (reason === "other" && !noteText) return { ok: false, error: "「その他」の場合は理由を入力してください" };
  return { ok: true, reason: reason as RejectReason, note: noteText || null };
}

// ---------------------------------------------------------------- レコード

/** bot_kv から読んだ生値を AdApplication に寄せる。想定外の形なら null。 */
export function normalizeApplication(key: string, raw: unknown): AdApplication | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  const strOrNull = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
  const status = str(r.status);
  if (!["pending", "approved", "rejected", "expired", "revoked"].includes(status)) return null;
  if (!str(r.guild_id) || !str(r.text) || !str(r.url)) return null;
  return {
    id: str(r.id) || key,
    guild_id: str(r.guild_id),
    guild_name: str(r.guild_name),
    applicant_user_id: str(r.applicant_user_id),
    text: str(r.text),
    url: str(r.url),
    status: status as AdStatus,
    screening: normalizeScreening(r.screening),
    created_at: str(r.created_at),
    reviewed_at: strOrNull(r.reviewed_at),
    reviewed_by: strOrNull(r.reviewed_by),
    reject_reason: (REJECT_REASONS.some((item) => item.value === r.reject_reason)
      ? (r.reject_reason as RejectReason)
      : null),
    reject_note: strOrNull(r.reject_note),
    revoke_reason: r.revoke_reason === "manual" || r.revoke_reason === "bot_removed" ? r.revoke_reason : null,
    expires_at: strOrNull(r.expires_at),
  };
}

function normalizeScreening(raw: unknown): AdScreening | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const s = raw as Record<string, unknown>;
  if (s.status !== "done" && s.status !== "unavailable") return null;
  const rawVerdicts = (typeof s.verdicts === "object" && s.verdicts !== null ? s.verdicts : {}) as Record<string, unknown>;
  const verdict = (v: unknown): ScreeningVerdict => (v === "suspect" || v === "clear" ? v : "unknown");
  const verdicts: Record<ScreeningCriteria, ScreeningVerdict> = {
    spam: verdict(rawVerdicts.spam),
    shop: verdict(rawVerdicts.shop),
    nsfw: verdict(rawVerdicts.nsfw),
    mismatch: verdict(rawVerdicts.mismatch),
  };
  return {
    status: s.status,
    at: typeof s.at === "string" ? s.at : "",
    model: typeof s.model === "string" ? s.model : SCREENING_MODEL,
    verdicts,
    flagged: Object.values(verdicts).includes("suspect"),
  };
}

/** 申請ID: 作成時刻（ミリ秒）＋ギルドID＋ランダム。キー昇順＝おおよそ作成順になる。 */
export function newApplicationId(nowMs: number, guildId: string, randomHex: string): string {
  return `${nowMs}_${guildId}_${randomHex}`;
}

// ---------------------------------------------------------------- 状態と上限

/**
 * 表示・配信の実効ステータス。approved でも期限切れなら expired、
 * registryIds が渡され対象ギルドが含まれなければ revoked（Bot退出）として扱う。
 * レコード自体の status は書き換えない（書き換えは審査操作のときだけ）。
 */
export function effectiveStatus(
  app: Pick<AdApplication, "status" | "expires_at" | "guild_id">,
  nowMs: number,
  registryIds?: ReadonlySet<string> | null,
): AdStatus {
  if (app.status !== "approved") return app.status;
  if (app.expires_at) {
    const expires = Date.parse(app.expires_at);
    if (Number.isFinite(expires) && expires <= nowMs) return "expired";
  }
  if (registryIds && !registryIds.has(app.guild_id)) return "revoked";
  return "approved";
}

/** そのギルドで新規申請を作れるか（pending が既にあれば作れない）。 */
export function canCreateForGuild(apps: AdApplication[], guildId: string): boolean {
  return !apps.some((app) => app.guild_id === guildId && app.status === "pending");
}

/** 掲載中（実効 approved）の件数。全体上限の判定に使う。 */
export function countActiveApproved(apps: AdApplication[], nowMs: number, registryIds?: ReadonlySet<string> | null): number {
  return apps.filter((app) => effectiveStatus(app, nowMs, registryIds) === "approved").length;
}

/** 承認してよいか（全体上限20件・先着）。 */
export function canApprove(apps: AdApplication[], nowMs: number, registryIds?: ReadonlySet<string> | null): boolean {
  return countActiveApproved(apps, nowMs, registryIds) < AD_GLOBAL_APPROVED_LIMIT;
}

/** 承認時の掲載期限（承認時点＋30日）。 */
export function approvalExpiry(nowMs: number): string {
  return new Date(nowMs + AD_TERM_DAYS * MS_PER_DAY).toISOString();
}

// ---------------------------------------------------------------- スクリーニング（clef）

export type ScreeningInput = {
  guildName: string;
  memberCount: number | null;
  text: string;
  url: string;
};

const CRITERIA_INSTRUCTIONS: Record<ScreeningCriteria, { instructions: string; suspect: string }> = {
  spam: {
    instructions: "このサーバーがスパム・荒らし目的のサーバーである疑いを判定してください。",
    suspect: "スパム・荒らし目的の疑いが強い",
  },
  shop: {
    instructions: "このサーバーが物品・サービスの販売を主目的とするショップ系サーバーである疑いを判定してください。",
    suspect: "販売を主目的とする疑いが強い",
  },
  nsfw: {
    instructions: "このサーバーが過度にNSFWな内容を主とするサーバーである疑いを判定してください。",
    suspect: "過度なNSFWを主とする疑いが強い",
  },
  mismatch: {
    instructions: "紹介文の内容と、サーバー名などから推測されるサーバーの実態が食い違っている疑いを判定してください。",
    suspect: "紹介文と実態が食い違う疑いが強い",
  },
};

/** Logfare decision API（モデル clef）へ送る state / questions を作る。 */
export function buildScreeningRequest(input: ScreeningInput): { state: string; questions: Record<string, unknown> } {
  const state = JSON.stringify({
    server_name: input.guildName,
    member_count: input.memberCount,
    description_text: input.text,
    invite_url: input.url,
  });
  const questions: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(CRITERIA_INSTRUCTIONS) as [ScreeningCriteria, { instructions: string; suspect: string }][]) {
    questions[key] = {
      type: "choice",
      instructions: item.instructions,
      criteria: {
        suspect: item.suspect,
        clear: "そのような疑いは薄い",
      },
    };
  }
  return { state, questions };
}

function answerValue(answer: unknown): string | null {
  if (typeof answer === "string") return answer.trim().toLowerCase();
  if (typeof answer === "object" && answer !== null) {
    const a = answer as Record<string, unknown>;
    for (const key of ["choice", "answer", "value"]) {
      if (typeof a[key] === "string") return (a[key] as string).trim().toLowerCase();
    }
  }
  return null;
}

/**
 * decision API の応答を AdScreening に変換する。使える回答が1つも無ければ null
 * （呼び出し側は「スクリーニング未実施」として審査に回す）。
 * 応答の包み方は Bot 側 core/general/ai_tools の解釈に合わせる
 * （result で包まれる場合と answers が直下にある場合の両対応）。
 */
export function parseScreeningResponse(data: unknown, at: string): AdScreening | null {
  if (typeof data !== "object" || data === null) return null;
  const root = data as Record<string, unknown>;
  if (root.success === false || root.errors) return null;
  const inner = (typeof root.result === "object" && root.result !== null ? root.result : root) as Record<string, unknown>;
  const answers = (typeof inner.answers === "object" && inner.answers !== null ? inner.answers : null) as Record<string, unknown> | null;
  if (!answers) return null;
  const verdicts = {} as Record<ScreeningCriteria, ScreeningVerdict>;
  let usable = 0;
  for (const key of Object.keys(CRITERIA_INSTRUCTIONS) as ScreeningCriteria[]) {
    const value = answerValue(answers[key]);
    if (value === "suspect" || value === "clear") {
      verdicts[key] = value;
      usable += 1;
    } else {
      verdicts[key] = "unknown";
    }
  }
  if (usable === 0) return null;
  return {
    status: "done",
    at,
    model: SCREENING_MODEL,
    verdicts,
    flagged: Object.values(verdicts).includes("suspect"),
  };
}

/** スクリーニング未実施を表すレコード（clef 呼び出し失敗時）。 */
export function unavailableScreening(at: string): AdScreening {
  return {
    status: "unavailable",
    at,
    model: SCREENING_MODEL,
    verdicts: { spam: "unknown", shop: "unknown", nsfw: "unknown", mismatch: "unknown" },
    flagged: false,
  };
}
