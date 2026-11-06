// BOT自前API（/v1/query）への薄いクライアント（サーバー専用。BOT_API_KEYをクライアントへ出さない）
// 国づくりマップ（lib/nation.ts）と同じ接続・資格情報を再利用する。
// 大きな整数（DiscordのID等）は dashboard-core の番兵文字列で受け渡し、精度を落とさない。
import { parseJsonPreservingInts, stringifyWithInts } from "./dashboard-core";

type QueryBody = {
  table: string;
  action: "select" | "insert" | "upsert" | "update" | "delete";
  columns?: string;
  filters?: { column: string; op: string; value: unknown }[];
  values?: unknown;
  on_conflict?: string;
  limit?: number;
};

export function isBotApiConfigured() {
  return Boolean(process.env.BOT_API_BASE_URL && process.env.BOT_API_KEY);
}

async function query<T>(body: QueryBody): Promise<T[]> {
  const baseUrl = process.env.BOT_API_BASE_URL?.replace(/\/$/, "");
  const apiKey = process.env.BOT_API_KEY;
  if (!baseUrl || !apiKey) throw new Error("database API environment is missing");

  const res = await fetch(`${baseUrl}/v1/query`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: stringifyWithInts(body),
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`database API returned ${res.status}`);
  const result = parseJsonPreservingInts(await res.text()) as { data?: T[] };
  return Array.isArray(result.data) ? result.data : [];
}

type KvRow = { key: string; value: unknown };

const KV_TABLE = "bot_kv";

export async function kvGet(namespace: string, key: string): Promise<unknown | null> {
  const rows = await query<KvRow>({
    table: KV_TABLE,
    action: "select",
    columns: "key,value",
    filters: [
      { column: "namespace", op: "eq", value: namespace },
      { column: "key", op: "eq", value: key },
    ],
    limit: 1,
  });
  return rows.length > 0 ? rows[0].value ?? null : null;
}

export async function kvList(namespace: string): Promise<Map<string, unknown>> {
  const rows = await query<KvRow>({
    table: KV_TABLE,
    action: "select",
    columns: "key,value",
    filters: [{ column: "namespace", op: "eq", value: namespace }],
    limit: 10_000,
  });
  const map = new Map<string, unknown>();
  for (const row of rows) map.set(String(row.key), row.value ?? null);
  return map;
}

export async function kvSet(namespace: string, key: string, value: unknown): Promise<void> {
  await query({
    table: KV_TABLE,
    action: "upsert",
    values: {
      namespace,
      key,
      value,
      updated_at: new Date().toISOString(),
    },
    on_conflict: "namespace,key",
  });
}

export async function kvDelete(namespace: string, key: string): Promise<void> {
  await query({
    table: KV_TABLE,
    action: "delete",
    filters: [
      { column: "namespace", op: "eq", value: namespace },
      { column: "key", op: "eq", value: key },
    ],
  });
}
