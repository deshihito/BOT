import { NextResponse } from "next/server";
import { getRequestSession, publicOrigin, sessionOwnerKey } from "@/lib/auth";
import { WORLD_COORD_LIMIT } from "@/lib/worldbox/mapgen";
import { itemById } from "@/lib/worldbox/items";
import { addItem, removeItem } from "@/lib/worldbox/profile";
import { loadProfile, storeProfile } from "@/lib/worldbox/profile-online";
import { listPresence } from "@/lib/worldbox/presence-online";
import { presenceIdFor } from "@/lib/worldbox/presence";
import { parseSave } from "@/lib/worldbox/save";
import { loadWorldBoxSave } from "@/lib/worldbox/save-online";
import { isOverrideActive } from "@/lib/worldbox/tiles";
import { isTilesEnabled, loadTileOverride } from "@/lib/worldbox/tiles-online";
import { isStallItem, stallAfterSale, validStallCount, validStallPrice } from "@/lib/worldbox/stalls";
import { isStallsEnabled, loadStall, storeStall } from "@/lib/worldbox/stalls-online";
import { buildEconomyOp } from "@/lib/worldbox/economy-bridge";
import { enqueueEconomyOp, isEconomyEnabled, readUserBalance } from "@/lib/worldbox/economy-bridge-online";
import { withUserLock } from "@/lib/worldbox/user-lock";

export const runtime = "nodejs";

// AGO WORLD BOX の屋台（個人商店）。
// 出品は bot_kv（名前空間 worldbox_stalls、キー "x,y"）にタイル単位で持ち、
// 設置ブロック（worldbox_tiles の上書き）が所有と種類の正。
// GET ?x&y: そのタイルの出品を返す（無ければ stall: null）。
// POST { action: "list_item", x, y, itemId, price, count }: 店主だけ。
//   アイテムを所持から預かり（escrow）として出品する。既存の出品があれば不可。
// POST { action: "unlist", x, y }: 店主だけ。出品をすべて手元へ戻す。
// POST { action: "buy", x, y }: 誰でも（店主以外）。残高を確認し、経済
//   ブリッジの transfer オプ（買手→店主）が積めたらアイテムを渡す。
// 隣接検証はタイル行為と同じ（プレゼンス → セーブ、チェビシェフ ≤2）。

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };
const MAX_ACTION_DISTANCE = 2;

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return !origin || origin === publicOrigin(request);
}

function errorResponse(error: string, status: number) {
  return NextResponse.json({ error }, { status, headers: NO_STORE });
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

async function nearTile(ownerKey: string, x: number, y: number): Promise<boolean> {
  const pos = await actorWorldPosition(ownerKey);
  if (!pos) return true; // 位置が分からない場合は従来どおり通す（タイル行為と同じ方針）
  return Math.max(Math.abs(Math.floor(pos.x) - x), Math.abs(Math.floor(pos.y) - y)) <= MAX_ACTION_DISTANCE;
}

/** そのタイルに屋台が設置されていて、設置者が ownerKey か（設置者の presence ID で照合）。 */
async function stallTileOwner(x: number, y: number): Promise<{ isStall: boolean; ownerId: string | null }> {
  const ov = await loadTileOverride(x, y);
  if (!ov?.block || !isOverrideActive(ov, Date.now()) || !isStallItem(ov.block.itemId)) {
    return { isStall: false, ownerId: null };
  }
  return { isStall: true, ownerId: ov.block.ownerId };
}

function discordIdOf(session: { provider: string; id: string }): string | null {
  return session.provider === "discord" ? session.id : null;
}

export async function GET(request: Request) {
  const session = getRequestSession(request);
  if (!session) return errorResponse("unauthorized", 401);
  if (!isStallsEnabled()) return errorResponse("stalls_unavailable", 503);
  const url = new URL(request.url);
  const coord = checkedCoord(Number(url.searchParams.get("x")), Number(url.searchParams.get("y")));
  if (!coord) return errorResponse("invalid_request", 400);
  const stall = await loadStall(coord.x, coord.y);
  return NextResponse.json(
    {
      stall: stall
        ? { itemId: stall.itemId, name: itemById(stall.itemId)?.name ?? stall.itemId, price: stall.price, count: stall.count, mine: stall.ownerKey === sessionOwnerKey(session) }
        : null,
    },
    { headers: NO_STORE },
  );
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return errorResponse("forbidden", 403);
  const session = getRequestSession(request);
  if (!session) return errorResponse("unauthorized", 401);
  if (!isStallsEnabled() || !isTilesEnabled()) return errorResponse("stalls_unavailable", 503);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("invalid_request", 400);
  }
  const data = (body ?? {}) as {
    action?: unknown; x?: unknown; y?: unknown; itemId?: unknown; price?: unknown; count?: unknown;
  };
  const coord = checkedCoord(data.x, data.y);
  if (!coord) return errorResponse("invalid_request", 400);
  const { x, y } = coord;
  const ownerKey = sessionOwnerKey(session);
  if (!(await nearTile(ownerKey, x, y))) return errorResponse("too_far", 409);

  // タイル単位＋ユーザー単位で直列化する（タイル行為と同じ二重ロック）
  return withUserLock(`tile:${x},${y}`, () =>
    withUserLock(ownerKey, async () => {
      const tile = await stallTileOwner(x, y);
      if (!tile.isStall) return errorResponse("no_stall", 404);
      const stall = await loadStall(x, y);
      const profile = await loadProfile(ownerKey);
      if (!profile) return errorResponse("profile_unavailable", 503);

      if (data.action === "list_item") {
        if (tile.ownerId !== presenceIdFor(ownerKey)) return errorResponse("not_owner", 403);
        if (stall) return errorResponse("already_listed", 409);
        const def = itemById(data.itemId);
        const price = validStallPrice(data.price);
        const count = validStallCount(data.count);
        if (!def || price === null || count === null) return errorResponse("invalid_request", 400);
        const removed = removeItem(profile, def.id, count);
        if (!removed) return errorResponse("not_enough_items", 409);
        if (!(await storeStall(x, y, { ownerKey, itemId: def.id, price, count }))) {
          return errorResponse("stalls_failed", 500);
        }
        if (!(await storeProfile(ownerKey, removed))) return errorResponse("store_failed", 503);
        return NextResponse.json(
          { stall: { itemId: def.id, name: def.name, price, count, mine: true }, profile: removed },
          { headers: NO_STORE },
        );
      }

      if (data.action === "unlist") {
        if (!stall) return errorResponse("not_listed", 409);
        if (stall.ownerKey !== ownerKey) return errorResponse("not_owner", 403);
        const back = addItem(profile, stall.itemId, stall.count);
        if (!(await storeStall(x, y, null))) return errorResponse("stalls_failed", 500);
        if (!(await storeProfile(ownerKey, back))) return errorResponse("store_failed", 503);
        return NextResponse.json({ stall: null, profile: back }, { headers: NO_STORE });
      }

      if (data.action === "buy") {
        if (!stall) return errorResponse("not_listed", 409);
        if (stall.ownerKey === ownerKey) return errorResponse("own_stall", 409);
        const buyerId = discordIdOf(session);
        const sellerId = stall.ownerKey.startsWith("discord:") ? stall.ownerKey.slice("discord:".length) : null;
        if (!buyerId || !sellerId || !isEconomyEnabled()) return errorResponse("economy_unavailable", 503);
        const balance = await readUserBalance(buyerId);
        if (balance === null) return errorResponse("economy_unavailable", 503);
        if (balance < stall.price) return errorResponse("insufficient_balance", 409);
        const op = buildEconomyOp(
          { kind: "transfer", userKey: ownerKey, discordId: buyerId, toDiscordId: sellerId, amount: stall.price, reason: "stall_buy" },
          `stall-buy-${buyerId}-${x}-${y}-${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffffff).toString(36)}`,
          Date.now(),
        );
        if (!op || !(await enqueueEconomyOp(op))) return errorResponse("economy_failed", 503);
        const nextStall = stallAfterSale(stall);
        if (!(await storeStall(x, y, nextStall))) return errorResponse("stalls_failed", 500);
        const gained = addItem(profile, stall.itemId, 1);
        if (!(await storeProfile(ownerKey, gained))) return errorResponse("store_failed", 503);
        return NextResponse.json(
          {
            stall: nextStall
              ? { itemId: nextStall.itemId, name: itemById(nextStall.itemId)?.name ?? nextStall.itemId, price: nextStall.price, count: nextStall.count, mine: false }
              : null,
            profile: gained,
          },
          { headers: NO_STORE },
        );
      }

      return errorResponse("invalid_action", 400);
    }),
  );
}
