"use strict";
// AGO WORLD BOX リアルタイム中継（relay）専用の bot_kv クライアント。
// relay は Next の外側で動く素の Node プロセスのため、web/lib/bot-api.ts
// （TS）を直接使えない。代わりに同じ BOT 自前 API（/v1/query）を同じ
// 環境変数（BOT_API_BASE_URL / BOT_API_KEY）・同じリクエスト形式で叩く。
// これにより watch（読み）と Phase 2 のプレゼンス集約書き込みが、
// Next 側の *-online.ts と同じ bot_kv レコードを触れる。

/** bot-api の設定（未設定なら null = relay の kv 機能は無効）。 */
function botKvConfig(env = process.env) {
  const base = String(env.BOT_API_BASE_URL || "").replace(/\/$/, "");
  const key = env.BOT_API_KEY || "";
  return base && key ? { base, key } : null;
}

async function kvQuery(cfg, body, fetchImpl = fetch) {
  const res = await fetchImpl(`${cfg.base}/v1/query`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.key}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`bot api returned ${res.status}`);
  const result = await res.json();
  return Array.isArray(result?.data) ? result.data : [];
}

/** 名前空間を全件読む（bot-api.ts の kvList と同じ。Map で返す）。 */
async function kvList(cfg, namespace, fetchImpl = fetch) {
  const rows = await kvQuery(cfg, {
    table: "bot_kv",
    action: "select",
    columns: "key,value",
    filters: [{ column: "namespace", op: "eq", value: namespace }],
    limit: 10_000,
  }, fetchImpl);
  const map = new Map();
  for (const row of rows) map.set(String(row.key), row.value ?? null);
  return map;
}

/** 1件読む（bot-api.ts の kvGet と同じ。無ければ null）。 */
async function kvGet(cfg, namespace, key, fetchImpl = fetch) {
  const rows = await kvQuery(cfg, {
    table: "bot_kv",
    action: "select",
    columns: "key,value",
    filters: [
      { column: "namespace", op: "eq", value: namespace },
      { column: "key", op: "eq", value: key },
    ],
    limit: 1,
  }, fetchImpl);
  if (rows.length === 0) return null;
  return rows[0].value ?? null;
}

/** 1件書く（bot-api.ts の kvSet と同じ upsert）。 */
async function kvSet(cfg, namespace, key, value, fetchImpl = fetch) {
  await kvQuery(cfg, {
    table: "bot_kv",
    action: "upsert",
    values: { namespace, key, value, updated_at: new Date().toISOString() },
    on_conflict: "namespace,key",
  }, fetchImpl);
}

/** 1件消す（bot-api.ts の kvDelete と同じ）。 */
async function kvDelete(cfg, namespace, key, fetchImpl = fetch) {
  await kvQuery(cfg, {
    table: "bot_kv",
    action: "delete",
    filters: [
      { column: "namespace", op: "eq", value: namespace },
      { column: "key", op: "eq", value: key },
    ],
  }, fetchImpl);
}

module.exports = { botKvConfig, kvList, kvGet, kvSet, kvDelete };
