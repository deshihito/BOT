// 背景透過（Web 一時リンク版）のサーバー側部品。
// トークン検証と、処理結果の bot_kv への受け渡しを行う。結果レコードの
// 形式は Bot 側（core/general/bg_cutout.py の bgcut_result_post_plan）が
// 期待する契約に合わせる。Bot は bgcut_results 名前空間をポーリングして
// 発行元チャンネルへ公開投稿し、投稿後にキーを削除する。

import { kvGet, kvSet } from "./bot-api";
import { intToken } from "./dashboard-core";
import { purposeBudget, type BgCutPurpose } from "./bgcut-core";
import {
  verifyBgcutToken,
  type BgCutTokenPayload,
  type BgCutTokenStatus,
} from "./bgcut-token";

export const BGCUT_RESULTS_NAMESPACE = "bgcut_results";

export function getBgcutSession(token: string): BgCutTokenStatus {
  return verifyBgcutToken(token, process.env.BOT_API_KEY);
}

export type BgCutResultMeta = {
  format: "PNG" | "GIF";
  filename: string;
  width: number;
  height: number;
  inBytes: number;
  inWidth: number;
  inHeight: number;
  notes: string[];
};

export type BgCutResultSave =
  | { saved: true }
  | { saved: false; reason: "duplicate" | "too_large" | "bad_meta" };

function isValidMeta(meta: unknown, purpose: BgCutPurpose): meta is BgCutResultMeta {
  if (typeof meta !== "object" || meta === null) return false;
  const m = meta as Record<string, unknown>;
  if (m.format !== "PNG" && m.format !== "GIF") return false;
  const expectedName = `${purpose}.${(m.format as string).toLowerCase()}`;
  if (m.filename !== expectedName) return false;
  for (const key of ["width", "height", "inBytes", "inWidth", "inHeight"]) {
    const v = m[key];
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > 100_000_000) {
      return false;
    }
  }
  if (!Array.isArray(m.notes) || m.notes.length > 8) return false;
  if (!m.notes.every((n) => typeof n === "string" && n.length <= 200)) return false;
  return true;
}

/** 結果を bot_kv に保存する。1ジョブ1回まで（既存キーがあれば duplicate）。 */
export async function saveBgcutResult(
  payload: BgCutTokenPayload,
  meta: unknown,
  data: Uint8Array,
): Promise<BgCutResultSave> {
  if (!isValidMeta(meta, payload.purpose)) return { saved: false, reason: "bad_meta" };
  if (data.byteLength === 0 || data.byteLength > purposeBudget(payload.purpose)) {
    return { saved: false, reason: "too_large" };
  }
  const existing = await kvGet(BGCUT_RESULTS_NAMESPACE, payload.jobId);
  if (existing !== null && existing !== undefined) {
    return { saved: false, reason: "duplicate" };
  }
  // ID は番兵文字列で載せ、API 境界で生の JSON 数値に戻す（Bot が整数で読む）。
  const record = {
    status: "pending",
    user_id: intToken(payload.userId),
    guild_id: intToken(payload.guildId),
    channel_id: intToken(payload.channelId),
    purpose: payload.purpose,
    filename: meta.filename,
    format: meta.format,
    width: Math.trunc(meta.width),
    height: Math.trunc(meta.height),
    out_bytes: data.byteLength,
    in_bytes: Math.trunc(meta.inBytes),
    in_width: Math.trunc(meta.inWidth),
    in_height: Math.trunc(meta.inHeight),
    notes: meta.notes,
    data_b64: Buffer.from(data).toString("base64"),
    created_at: Math.floor(Date.now() / 1000),
  };
  await kvSet(BGCUT_RESULTS_NAMESPACE, payload.jobId, record);
  return { saved: true };
}
