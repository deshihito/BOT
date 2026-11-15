import { NextResponse } from "next/server";
import { getRequestSession, publicOrigin, sessionOwnerKey } from "@/lib/auth";
import { dayKeyOf } from "@/lib/worldbox/metrics";
import { stateAtTime } from "@/lib/worldbox/ops";
import {
  appendReport, loadFrozen, loadReports, loadTileJournal, storeFrozen, worldboxAdminIds,
} from "@/lib/worldbox/ops-online";
import { isTilesEnabled, storeTileOverride } from "@/lib/worldbox/tiles-online";
import { parseTileKey } from "@/lib/worldbox/tiles";

export const runtime = "nodejs";

// AGO WORLD BOX の運用（荒らし対策）。
// GET: 凍結状態（全員）+ 通報と凍結の詳細（運営のみ）。
// POST { action: "report", text, x?, y? }: 通報の受付（ログイン中なら誰でも）。
// POST { action: "freeze", on }: ワールドのタイル書き換えを凍結/解除（運営のみ）。
// POST { action: "rollback_tile", x, y, toAt }: ジャーナルからそのタイルを
// 指定時刻の状態へ巻き戻す（運営のみ）。

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

function err(error: string, status: number) {
  return NextResponse.json({ error }, { status, headers: NO_STORE });
}

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return !origin || origin === publicOrigin(request);
}

function isAdmin(session: NonNullable<ReturnType<typeof getRequestSession>>): boolean {
  return session.provider === "discord" && worldboxAdminIds().has(session.id);
}

export async function GET(request: Request) {
  const session = getRequestSession(request);
  if (!session) return err("unauthorized", 401);
  const frozen = await loadFrozen();
  if (!isAdmin(session)) {
    return NextResponse.json({ frozen }, { headers: NO_STORE });
  }
  const reports = await loadReports();
  return NextResponse.json({ frozen, reports: reports.slice(-30).reverse() }, { headers: NO_STORE });
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return err("forbidden", 403);
  const session = getRequestSession(request);
  if (!session) return err("unauthorized", 401);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return err("invalid_request", 400);
  }
  const fields = (body ?? {}) as {
    action?: unknown; text?: unknown; x?: unknown; y?: unknown; on?: unknown; toAt?: unknown;
  };
  const ownerKey = sessionOwnerKey(session);

  if (fields.action === "report") {
    const text = typeof fields.text === "string" ? fields.text.trim().slice(0, 300) : "";
    if (!text) return err("empty_text", 400);
    const ok = await appendReport({
      id: crypto.randomUUID(),
      reporter: ownerKey,
      text,
      x: typeof fields.x === "number" ? Math.floor(fields.x) : undefined,
      y: typeof fields.y === "number" ? Math.floor(fields.y) : undefined,
      at: Date.now(),
    });
    if (!ok) return err("store_failed", 503);
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  }

  if (!isAdmin(session)) return err("admin_only", 403);

  if (fields.action === "freeze") {
    const on = fields.on === true;
    if (!(await storeFrozen(on))) return err("store_failed", 503);
    return NextResponse.json({ ok: true, frozen: on }, { headers: NO_STORE });
  }

  if (fields.action === "rollback_tile") {
    if (!isTilesEnabled()) return err("tiles_unavailable", 503);
    const x = typeof fields.x === "number" ? Math.floor(fields.x) : NaN;
    const y = typeof fields.y === "number" ? Math.floor(fields.y) : NaN;
    const toAt = typeof fields.toAt === "number" ? fields.toAt : NaN;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(toAt)) {
      return err("invalid_request", 400);
    }
    const key = `${x},${y}`;
    if (!parseTileKey(key)) return err("invalid_tile", 400);
    // 当日と前日のジャーナルから探す（巻き戻しは直近の荒らしへの対処が主）
    const dates = [dayKeyOf(toAt), dayKeyOf(toAt - 86_400_000), dayKeyOf(Date.now())];
    let target: ReturnType<typeof stateAtTime> = undefined;
    for (const date of [...new Set(dates)]) {
      const entries = await loadTileJournal(date);
      const found = stateAtTime(entries, key, toAt);
      if (found !== undefined) {
        target = found;
        break;
      }
    }
    if (target === undefined) return err("no_journal", 404);
    if (!(await storeTileOverride(x, y, target))) return err("store_failed", 503);
    return NextResponse.json({ ok: true, restored: target }, { headers: NO_STORE });
  }

  return err("invalid_action", 400);
}
