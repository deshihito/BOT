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
import { canAccessScope, isAccessScope, parseAccessScope } from "@/lib/worldbox/acl";
import { nationIdForPresenceId } from "@/lib/worldbox/nations";
import { loadNationsState } from "@/lib/worldbox/nations-online";
import { TENT_H, buildTent } from "@/lib/worldbox/tent";
import { buildLobby } from "@/lib/worldbox/lobby";
import { buildLobby2, buildLobby3 } from "@/lib/worldbox/lobby-floors";
import { withUserLock } from "@/lib/worldbox/user-lock";

export const runtime = "nodejs";

// AGO WORLD BOX の収納コンテナ（樽・宝箱）。
// 中身は bot_kv（名前空間 worldbox_containers、キー "<space>|x,y"）に
// タイル単位で持ち、設置ブロック（worldbox_tiles の上書き）が種類の正。
// 公開範囲 access（"public" | "union" | "owner"、既定 "public"）により
// 全員共有・自ユニオン限定・所有者限定の3段階を切り替えられる。
// GET ?x&y[&space=tent]: そのタイルのコンテナの中身を返す（無ければ 404）。
// POST { action: "move", x, y, from, to [, space] }: スロット移動。
// POST { action: "set_access", x, y, access }: 所有者による公開範囲変更（world のみ）。

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

/** コンテナが使える空間。world=設置ブロック、それ以外は室内の備え付け家具。 */
type ContainerSpace = "world" | "tent" | "lobby" | "lobby2" | "lobby3";

function parseContainerSpace(raw: unknown): ContainerSpace {
  return raw === "tent" || raw === "lobby" || raw === "lobby2" || raw === "lobby3" ? raw : "world";
}

/** 備え付け家具の保存空間キー。 */
function fixtureStoreSpace(space: ContainerSpace): string {
  return space;
}

/** サーバーが知る本人の位置（プレゼンス → セーブの順、空間一致のみ）。無ければ null。 */
async function actorPosition(ownerKey: string, space: ContainerSpace): Promise<{ x: number; y: number } | null> {
  const selfId = presenceIdFor(ownerKey);
  const entries = await listPresence();
  const now = Date.now();
  const entry = entries.find((e) => e.id === selfId && e.space === space && now - e.ts <= 15_000);
  if (entry) return { x: entry.x, y: entry.y };
  const saved = parseSave(await loadWorldBoxSave(ownerKey));
  if (saved && saved.space === space) return { x: saved.x, y: saved.y };
  return null;
}

type ResolvedContainer =
  | {
      ok: true;
      itemId: string;
      ownerId: string;
      state: ContainerState;
      storeSpace: string;
      storeX: number;
      storeY: number;
    }
  | { ok: false; error: string; status: number };

/** そのタイルにあるコンテナを解決する（所有・種類は設置ブロックが正）。 */
async function resolveContainer(
  ownerKey: string,
  space: ContainerSpace,
  x: number,
  y: number,
): Promise<ResolvedContainer> {
  const selfId = presenceIdFor(ownerKey);
  if (space !== "world") {
    const tent = space === "tent" ? buildTent((await loadProfile(ownerKey)).tentTier) : null;
    const objects = tent ? tent.objects
      : space === "lobby" ? buildLobby().objects
      : space === "lobby2" ? buildLobby2().objects
      : buildLobby3().objects;
    const obj = objects.find(
      (o) => isContainerItem(o.sprite) && x >= o.x && x < o.x + o.w && y >= o.y && y < o.y + o.h,
    );
    if (!obj) return { ok: false, error: "no_container", status: 404 };
    const storeSpace = fixtureStoreSpace(space);
    const storeX = obj.x;
    const storeY = tent ? obj.y - (tent.height - TENT_H) : obj.y;
    const stored = await loadContainer(storeSpace, storeX, storeY, obj.sprite);
    const state = stored ?? emptyContainer(selfId, obj.sprite);
    return { ok: true, itemId: obj.sprite, ownerId: selfId, state, storeSpace, storeX, storeY };
  }
  const ov = await loadTileOverride(x, y);
  const block = ov && isOverrideActive(ov, Date.now()) ? ov.block : undefined;
  if (!block || !isContainerItem(block.itemId)) {
    return { ok: false, error: "no_container", status: 404 };
  }
  const stored = await loadContainer("world", x, y, block.itemId);
  const state = stored ?? emptyContainer(block.ownerId, block.itemId);
  return {
    ok: true,
    itemId: block.itemId,
    ownerId: block.ownerId,
    state,
    storeSpace: "world",
    storeX: x,
    storeY: y,
  };
}

function errorJson(error: string, status: number) {
  return NextResponse.json({ error }, { status, headers: NO_STORE });
}

async function checkWorldContainerAcl(
  ownerKey: string,
  resolved: Extract<ResolvedContainer, { ok: true }>,
): Promise<NextResponse | null> {
  const access = parseAccessScope(resolved.state.access);
  if (access === "public") return null;
  const selfId = presenceIdFor(ownerKey);
  if (resolved.ownerId === selfId) return null;
  if (access === "owner") return errorJson("not_allowed", 403);
  const nations = await loadNationsState();
  const allowed = canAccessScope(access, {
    actorId: selfId,
    ownerId: resolved.ownerId,
    actorNationId: nations.members[ownerKey]?.nationId ?? null,
    ownerNationId: nationIdForPresenceId(nations, resolved.ownerId),
  });
  return allowed ? null : errorJson("not_allowed", 403);
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
  if ((xRaw !== null && xRaw.trim() === "") || (yRaw !== null && yRaw.trim() === "")) {
    return errorJson("invalid_tile", 400);
  }
  const coord = checkedCoord(
    xRaw === null ? NaN : Number(xRaw),
    yRaw === null ? NaN : Number(yRaw),
  );
  if (!coord) return errorJson("invalid_tile", 400);
  const space = parseContainerSpace(url.searchParams.get("space"));
  const ownerKey = sessionOwnerKey(session);
  const pos = await actorPosition(ownerKey, space);
  if (!pos) return errorJson("position_unknown", 409);
  const dist = Math.max(
    Math.abs(Math.floor(pos.x) - coord.x),
    Math.abs(Math.floor(pos.y) - coord.y),
  );
  if (dist > MAX_ACTION_DISTANCE) return errorJson("too_far", 409);
  const resolved = await resolveContainer(ownerKey, space, coord.x, coord.y);
  if (!resolved.ok) return errorJson(resolved.error, resolved.status);
  if (space === "world") {
    const denied = await checkWorldContainerAcl(ownerKey, resolved);
    if (denied) return denied;
  }
  const selfId = presenceIdFor(ownerKey);
  return NextResponse.json(
    {
      ok: true,
      x: coord.x,
      y: coord.y,
      itemId: resolved.itemId,
      capacity: containerCapacity(resolved.itemId),
      access: parseAccessScope(resolved.state.access),
      mine: space !== "world" || resolved.ownerId === selfId,
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
  const fields = (body ?? {}) as {
    action?: unknown;
    x?: unknown;
    y?: unknown;
    from?: unknown;
    to?: unknown;
    space?: unknown;
    access?: unknown;
  };
  if (fields.action !== "move" && fields.action !== "set_access") {
    return errorJson("invalid_action", 400);
  }
  const coord = checkedCoord(fields.x, fields.y);
  if (!coord) return errorJson("invalid_tile", 400);
  const space = parseContainerSpace(fields.space);
  if (fields.action === "set_access" && space !== "world") {
    return errorJson("invalid_action", 400);
  }
  const ownerKey = sessionOwnerKey(session);

  const pos = await actorPosition(ownerKey, space);
  if (!pos) return errorJson("position_unknown", 409);
  const dist = Math.max(
    Math.abs(Math.floor(pos.x) - coord.x),
    Math.abs(Math.floor(pos.y) - coord.y),
  );
  if (dist > MAX_ACTION_DISTANCE) return errorJson("too_far", 409);

  return withUserLock(`container:${space}:${coord.x},${coord.y}`, () =>
    withUserLock(ownerKey, async () => {
      const resolved = await resolveContainer(ownerKey, space, coord.x, coord.y);
      if (!resolved.ok) return errorJson(resolved.error, resolved.status);
      const selfId = presenceIdFor(ownerKey);

      if (fields.action === "set_access") {
        if (resolved.ownerId !== selfId) return errorJson("not_owner", 403);
        if (!isAccessScope(fields.access)) return errorJson("invalid_access", 400);
        const nextState: ContainerState = {
          ownerId: resolved.ownerId,
          slots: resolved.state.slots,
          ...(fields.access !== "public" ? { access: fields.access } : {}),
        };
        if (!(await storeContainer(resolved.storeSpace, resolved.storeX, resolved.storeY, nextState))) {
          return errorJson("containers_failed", 500);
        }
        return NextResponse.json(
          { ok: true, access: fields.access, mine: true, container: nextState },
          { headers: NO_STORE },
        );
      }

      if (space === "world") {
        const denied = await checkWorldContainerAcl(ownerKey, resolved);
        if (denied) return denied;
      }

      const profile = await loadProfile(ownerKey);
      const moved = moveContainerSlot(profile, resolved.state, fields.from, fields.to);
      if (!moved) return errorJson("invalid_action", 400);
      if (!(await storeContainer(resolved.storeSpace, resolved.storeX, resolved.storeY, moved.container))) {
        return errorJson("containers_failed", 500);
      }
      if (!(await storeProfile(ownerKey, moved.profile))) {
        await storeContainer(resolved.storeSpace, resolved.storeX, resolved.storeY, resolved.state);
        return errorJson("containers_failed", 500);
      }
      return NextResponse.json(
        {
          ok: true,
          profile: moved.profile,
          container: moved.container,
          access: parseAccessScope(moved.container.access),
          mine: space !== "world" || resolved.ownerId === selfId,
        },
        { headers: NO_STORE },
      );
    }),
  );
}
