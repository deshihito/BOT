import { NextResponse } from "next/server";
import { getRequestSession, publicOrigin, sessionOwnerKey } from "@/lib/auth";
import { WORLD_COORD_LIMIT } from "@/lib/worldbox/mapgen";
import { loadProfile, storeProfile } from "@/lib/worldbox/profile-online";
import { listPresence } from "@/lib/worldbox/presence-online";
import { presenceIdFor } from "@/lib/worldbox/presence";
import { parseSave } from "@/lib/worldbox/save";
import { loadWorldBoxSave } from "@/lib/worldbox/save-online";
import { isOverrideActive } from "@/lib/worldbox/tiles";
import { isTilesEnabled, loadTileOverride } from "@/lib/worldbox/tiles-online";
import {
  containerCapacity, emptyContainer, isContainerItem, moveContainerSlot,
  type ContainerState,
} from "@/lib/worldbox/containers";
import {
  isContainersEnabled, loadContainer, storeContainer,
} from "@/lib/worldbox/containers-online";
import { withUserLock } from "@/lib/worldbox/user-lock";

export const runtime = "nodejs";

// AGO WORLD BOX の収納コンテナ（樽・宝箱）。
// 中身は bot_kv（名前空間 worldbox_containers、キー "x,y"）にタイル単位で
// 持ち、設置ブロック（worldbox_tiles の上書き）が所有と種類の正。
// 開ける・出し入れできるのは所有者だけ（他人は 403）。
// GET ?x&y: そのタイルのコンテナの中身を返す（コンテナが無ければ 404）。
// POST { action: "move", x, y, from, to }: プロフィール⇔コンテナ間の
// スロット移動をサーバー側で再計算して適用し、両方の更新後を返す。
// 隣接検証はタイル行為と同じ（プレゼンス → セーブ、チェビシェフ ≤2）。
// Bot API 未設定なら 503（クライアントは収納なしで遊び続ける）。

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

/** 行為できるタイルと本人位置のチェビシェフ距離の上限（タイル行為と同じ）。 */
const MAX_ACTION_DISTANCE = 2;

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return !origin || origin === publicOrigin(request);
}

function checkedCoord(xRaw: unknown, yRaw: unknown): { x: number; y: number } | null {
  if (typeof xRaw !== "number" || typeof yRaw !== "number") return null;
  if (!Number.isFinite(xRaw) || !Number.isFinite(yRaw)) return null;
  const x = Math.floor(xRaw);
  const y = Math.floor(yRaw);
  if (Math.abs(x) > WORLD_COORD_LIMIT || Math.abs(y) > WORLD_COORD_LIMIT) return null;
  return { x, y };
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

type ResolvedContainer =
  | { ok: true; itemId: string; state: ContainerState }
  | { ok: false; error: string; status: number };

/** そのタイルにある本人のコンテナを解決する（所有・種類は設置ブロックが正）。 */
async function resolveContainer(
  ownerKey: string,
  x: number,
  y: number,
): Promise<ResolvedContainer> {
  const ov = await loadTileOverride(x, y);
  const block = ov && isOverrideActive(ov, Date.now()) ? ov.block : undefined;
  if (!block || !isContainerItem(block.itemId)) {
    return { ok: false, error: "no_container", status: 404 };
  }
  const selfId = presenceIdFor(ownerKey);
  if (block.ownerId !== selfId) {
    return { ok: false, error: "not_owner", status: 403 };
  }
  const stored = await loadContainer("world", x, y, block.itemId);
  // 状態が無い・所有がずれている場合は空のコンテナとして扱う
  const state = stored && stored.ownerId === selfId
    ? stored
    : emptyContainer(selfId, block.itemId);
  return { ok: true, itemId: block.itemId, state };
}

function errorJson(error: string, status: number) {
  return NextResponse.json({ error }, { status, headers: NO_STORE });
}

export async function GET(request: Request) {
  const session = getRequestSession(request);
  if (!session) return errorJson("unauthorized", 401);
  if (!isContainersEnabled() || !isTilesEnabled()) {
    return errorJson("containers_unavailable", 503);
  }
  const url = new URL(request.url);
  const xRaw = url.searchParams.get("x");
  const yRaw = url.searchParams.get("y");
  const coord = checkedCoord(
    xRaw === null ? NaN : Number(xRaw),
    yRaw === null ? NaN : Number(yRaw),
  );
  if (!coord) return errorJson("invalid_tile", 400);
  // 隣接検証（POST と同じ。読み取りでも遠隔地から中身を覗けないように）
  const ownerKey = sessionOwnerKey(session);
  const pos = await actorWorldPosition(ownerKey);
  if (!pos) return errorJson("position_unknown", 409);
  const dist = Math.max(
    Math.abs(Math.floor(pos.x) - coord.x),
    Math.abs(Math.floor(pos.y) - coord.y),
  );
  if (dist > MAX_ACTION_DISTANCE) return errorJson("too_far", 409);
  const resolved = await resolveContainer(ownerKey, coord.x, coord.y);
  if (!resolved.ok) return errorJson(resolved.error, resolved.status);
  return NextResponse.json(
    {
      ok: true,
      x: coord.x,
      y: coord.y,
      itemId: resolved.itemId,
      capacity: containerCapacity(resolved.itemId),
      container: resolved.state,
    },
    { headers: NO_STORE },
  );
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return errorJson("forbidden", 403);
  const session = getRequestSession(request);
  if (!session) return errorJson("unauthorized", 401);
  if (!isContainersEnabled() || !isTilesEnabled()) {
    return errorJson("containers_unavailable", 503);
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorJson("invalid_request", 400);
  }
  const fields = (body ?? {}) as { action?: unknown; x?: unknown; y?: unknown; from?: unknown; to?: unknown };
  if (fields.action !== "move") return errorJson("invalid_action", 400);
  const coord = checkedCoord(fields.x, fields.y);
  if (!coord) return errorJson("invalid_tile", 400);
  const ownerKey = sessionOwnerKey(session);

  // 隣接検証（タイル行為と同じ。位置不明は素通りさせず拒否する）
  const pos = await actorWorldPosition(ownerKey);
  if (!pos) return errorJson("position_unknown", 409);
  const dist = Math.max(
    Math.abs(Math.floor(pos.x) - coord.x),
    Math.abs(Math.floor(pos.y) - coord.y),
  );
  if (dist > MAX_ACTION_DISTANCE) return errorJson("too_far", 409);

  // 同一ユーザーへの並行リクエストを直列化する（S4）: コンテナと
  // プロフィールの両方を読み書きするため、ロック無しだと二重移動や
  // lost update が起きる（タイル側と同じ型、S1 の横展開）。
  return withUserLock(ownerKey, async () => {
        const resolved = await resolveContainer(ownerKey, coord.x, coord.y);
        if (!resolved.ok) return errorJson(resolved.error, resolved.status);

        const profile = await loadProfile(ownerKey);
        const moved = moveContainerSlot(profile, resolved.state, fields.from, fields.to);
        if (!moved) return errorJson("invalid_action", 400);
        if (!(await storeContainer("world", coord.x, coord.y, moved.container))) {
          return errorJson("containers_failed", 500);
        }
        if (!(await storeProfile(ownerKey, moved.profile))) {
          return errorJson("containers_failed", 500);
        }
        return NextResponse.json(
          { ok: true, profile: moved.profile, container: moved.container },
          { headers: NO_STORE },
        );
  });
}
