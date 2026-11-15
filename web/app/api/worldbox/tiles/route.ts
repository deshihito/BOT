import { NextResponse } from "next/server";
import { getRequestSession, publicOrigin, sessionOwnerKey } from "@/lib/auth";
import { generateMap, MAP_H, MAP_W } from "@/lib/worldbox/mapgen";
import { loadProfile, storeProfile } from "@/lib/worldbox/profile-online";
import { listPresence } from "@/lib/worldbox/presence-online";
import { presenceIdFor } from "@/lib/worldbox/presence";
import { parseSave } from "@/lib/worldbox/save";
import { loadWorldBoxSave } from "@/lib/worldbox/save-online";
import {
  applyTileAction, isOverrideActive, tileKey,
  type TileOverridesMap,
} from "@/lib/worldbox/tiles";
import {
  isTilesEnabled, loadTileOverride, loadTileOverrides, storeTileOverride,
} from "@/lib/worldbox/tiles-online";

export const runtime = "nodejs";

// AGO WORLD BOX のタイル行為（伐採・採掘・耕作・作付け・収穫）。
// 地形の真値は生成マップ＋bot_kv の上書き（名前空間 worldbox_tiles、
// キー "x,y"）で、行為の可否はすべてサーバー側で検証する。
// 隣接検証: サーバーが知る本人の位置（プレゼンス優先、無ければ
// オンラインセーブ）がある場合だけタイルとの距離を確かめる。
// GET ?x0&y0&x1&y1: その範囲（各辺128まで）の上書きだけを返す
// POST { action, x, y, seedId? }: 行為を適用し、更新後のタイルと
// プロフィール（収穫・種の消費を反映）を返す。
// Bot API 未設定なら 503（クライアントは上書きなしで遊び続ける）。

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

/** GET で返す範囲の上限（1辺のタイル数）。 */
const MAX_RECT_SPAN = 128;
/** 行為できるタイルと本人位置のチェビシェフ距離の上限（保存の遅れを許容）。 */
const MAX_ACTION_DISTANCE = 2;

const BAD_REQUEST_ERRORS = new Set(["invalid_action", "invalid_request", "invalid_tile", "unknown_seed"]);

function errorStatus(error: string): number {
  if (error === "not_owner") return 403;
  return BAD_REQUEST_ERRORS.has(error) ? 400 : 409;
}

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return !origin || origin === publicOrigin(request);
}

function clampIntParam(raw: string | null, min: number, max: number, fallback: number): number {
  const n = raw === null ? NaN : Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

/** サーバーが知る本人のワールド位置（プレゼンス → セーブの順）。無ければ null。 */
async function actorWorldPosition(ownerKey: string): Promise<{ x: number; y: number } | null> {
  const selfId = presenceIdFor(ownerKey);
  const entries = await listPresence();
  const now = Date.now();
  const entry = entries.find((e) => e.id === selfId && e.space === "world" && now - e.ts <= 15_000);
  if (entry) return { x: entry.x, y: entry.y };
  const saved = parseSave(await loadWorldBoxSave(ownerKey));
  if (saved && saved.space === "world") return { x: saved.x, y: saved.y };
  return null;
}

export async function GET(request: Request) {
  if (!isTilesEnabled()) {
    return NextResponse.json({ error: "tiles_unavailable" }, { status: 503, headers: NO_STORE });
  }
  const session = getRequestSession(request);
  const url = new URL(request.url);
  const x0 = clampIntParam(url.searchParams.get("x0"), 0, MAP_W - 1, 0);
  const y0 = clampIntParam(url.searchParams.get("y0"), 0, MAP_H - 1, 0);
  const x1 = Math.min(clampIntParam(url.searchParams.get("x1"), 0, MAP_W - 1, MAP_W - 1), x0 + MAX_RECT_SPAN - 1);
  const y1 = Math.min(clampIntParam(url.searchParams.get("y1"), 0, MAP_H - 1, MAP_H - 1), y0 + MAX_RECT_SPAN - 1);
  const all = await loadTileOverrides();
  const now = Date.now();
  const overrides: TileOverridesMap = {};
  for (const [key, ov] of Object.entries(all)) {
    const m = /^(-?\d+),(-?\d+)$/.exec(key);
    if (!m) continue;
    const x = Number(m[1]);
    const y = Number(m[2]);
    if (x < x0 || x > x1 || y < y0 || y > y1) continue;
    if (!isOverrideActive(ov, now)) continue; // 失効分は地形どおり
    overrides[key] = ov;
  }
  return NextResponse.json(
    { overrides, loggedIn: session !== null },
    { headers: NO_STORE },
  );
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403, headers: NO_STORE });
  }
  const session = getRequestSession(request);
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  }
  if (!isTilesEnabled()) {
    return NextResponse.json({ error: "tiles_unavailable" }, { status: 503, headers: NO_STORE });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400, headers: NO_STORE });
  }
  const fields = (body ?? {}) as { action?: unknown; x?: unknown; y?: unknown; seedId?: unknown };
  const ownerKey = sessionOwnerKey(session);

  // 隣接検証（本人の位置がサーバー側で分かる場合だけ）
  if (typeof fields.x === "number" && typeof fields.y === "number") {
    const pos = await actorWorldPosition(ownerKey);
    if (pos) {
      const dist = Math.max(
        Math.abs(Math.floor(pos.x) - Math.floor(fields.x)),
        Math.abs(Math.floor(pos.y) - Math.floor(fields.y)),
      );
      if (dist > MAX_ACTION_DISTANCE) {
        return NextResponse.json({ error: "too_far" }, { status: 409, headers: NO_STORE });
      }
    }
  }

  const tx = typeof fields.x === "number" ? Math.floor(fields.x) : -1;
  const ty = typeof fields.y === "number" ? Math.floor(fields.y) : -1;
  const current = tx >= 0 && ty >= 0 ? await loadTileOverride(tx, ty) : null;
  const profile = await loadProfile(ownerKey);
  const result = applyTileAction(
    current, profile, generateMap(), ownerKey,
    fields.action, fields.x, fields.y, fields.seedId, Date.now(),
  );
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: errorStatus(result.error), headers: NO_STORE });
  }
  if (!(await storeTileOverride(tx, ty, result.override))) {
    return NextResponse.json({ error: "tiles_failed" }, { status: 500, headers: NO_STORE });
  }
  if (!(await storeProfile(ownerKey, result.profile))) {
    return NextResponse.json({ error: "tiles_failed" }, { status: 500, headers: NO_STORE });
  }
  return NextResponse.json(
    {
      ok: true,
      tile: result.view,
      override: result.override,
      key: tileKey(tx, ty),
      profile: result.profile,
      gained: result.gained,
    },
    { headers: NO_STORE },
  );
}
