// BOT自前API（/v1/query）への薄いクライアント（サーバー専用。BOT_API_KEYをクライアントへ出さない）
// 大きな整数（DiscordのID等）は dashboard-core の番兵文字列で受け渡し、精度を落とさない。
import { parseJsonPreservingInts, stringifyWithInts } from "./dashboard-core";

export type BotApiFilter = { column: string; op: string; value: unknown };

type QueryBody = {
  table: string;
  action: "select" | "insert" | "upsert" | "update" | "delete";
  columns?: string;
  filters?: BotApiFilter[];
  values?: unknown;
  on_conflict?: string;
  limit?: number;
};

/** bot-api がエラーを返したときに投げる。status と API 側コードを保持する。 */
export class BotApiError extends Error {
  status: number;
  code?: string;
  constructor(status: number, code?: string) {
    super(`database API returned ${status}${code ? ` (${code})` : ""}`);
    this.status = status;
    this.code = code;
  }
}

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

/** 許可テーブルへの汎用 select（Bot 本体が db_api 経由で使うのと同じ経路）。 */
export async function tableSelect<T>(
  table: string,
  columns: string,
  filters: { column: string; op: string; value: unknown }[],
  limit = 1,
): Promise<T[]> {
  return query<T>({ table, action: "select", columns, filters, limit });
}

/** 許可テーブルへの汎用 upsert。 */
export async function tableUpsert(table: string, values: unknown, onConflict: string): Promise<void> {
  await query({ table, action: "upsert", values, on_conflict: onConflict });
}

/** 許可テーブルへの汎用 insert。 */
export async function tableInsert(table: string, values: unknown): Promise<void> {
  await query({ table, action: "insert", values });
}

/** 許可テーブルへの条件付き update。更新された行（RETURNING）を返す。 */
export async function tableUpdate<T>(
  table: string,
  values: unknown,
  filters: BotApiFilter[],
): Promise<T[]> {
  return query<T>({ table, action: "update", values, filters });
}

/**
 * 許可 RPC の呼び出し（/v1/rpc）。戻り値は API の data そのまま
 * （スカラー関数は値、表関数は行配列）。エラー時は BotApiError
 * （status と API のエラーコード付き）を投げる。
 */
export async function rpc<T>(name: string, params: Record<string, unknown>): Promise<T> {
  const baseUrl = process.env.BOT_API_BASE_URL?.replace(/\/$/, "");
  const apiKey = process.env.BOT_API_KEY;
  if (!baseUrl || !apiKey) throw new Error("database API environment is missing");

  const res = await fetch(`${baseUrl}/v1/rpc`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: stringifyWithInts({ name, params }),
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  if (!res.ok) {
    let code: string | undefined;
    try {
      const parsed = JSON.parse(text) as { detail?: { code?: unknown } };
      if (typeof parsed.detail?.code === "string") code = parsed.detail.code;
    } catch {
      // コードが読めなくても status だけで十分に扱える
    }
    throw new BotApiError(res.status, code);
  }
  const result = parseJsonPreservingInts(text) as { data?: T };
  return result.data as T;
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
