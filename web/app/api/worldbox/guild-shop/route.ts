import { NextResponse } from "next/server";
import { getRequestSession, publicOrigin, sessionOwnerKey } from "@/lib/auth";
import { buildEconomyOp } from "@/lib/worldbox/economy-bridge";
import {
  enqueueEconomyOpOnce, isEconomyEnabled, loadMyEconomyOps, readUserBalance, submitEconomyOp,
} from "@/lib/worldbox/economy-bridge-online";
import {
  GUILD_LISTING_MAX, GUILD_PLOT_ANCHORS, GUILD_PLOT_COUNT, GUILD_PLOT_FEE,
  findListing, listingAvailable, plotOfGuild, saleTaxAmount, sellerProceeds,
  type GuildShopState,
} from "@/lib/worldbox/guild-shop";
import { isGuildShopEnabled, loadGuildShopState, storeGuildShopState } from "@/lib/worldbox/guild-shop-online";
import { itemById } from "@/lib/worldbox/items";
import { loadNationsState } from "@/lib/worldbox/nations-online";
import { memberKeysOf, resolveMemberRole, taxRateOf } from "@/lib/worldbox/nation-settings";
import { loadNationSettings, updateNationSettings } from "@/lib/worldbox/nation-settings-online";
import { listPresence } from "@/lib/worldbox/presence-online";
import { presenceIdFor } from "@/lib/worldbox/presence";
import { addItem, countItem, removeItem } from "@/lib/worldbox/profile";
import { loadProfile, storeProfile } from "@/lib/worldbox/profile-online";
import { parseSave } from "@/lib/worldbox/save";
import { loadWorldBoxSave } from "@/lib/worldbox/save-online";
import { withUserLock } from "@/lib/worldbox/user-lock";
import { bumpMetric } from "@/lib/worldbox/metrics-online";

export const runtime = "nodejs";

// AGO WORLD BOX のギルドショップ。
// GET: 全区画と出品、自分の所属・役職を返す。
// POST: register（国王/大臣、区画料は spend guild_plot_fee）/
// unregister（出品は売り手へ返却）/ list（所属員が出品、アイテムは
// エスクローでプロフィールから引く）/ unlist（返却）/
// buy（区画カウンター近くでのみ。購入 spend guild_shop_buy + 売り手 earn
// guild_shop_sale（区画の国の税率を差し引き、税分はシンク+累計へ記録）、
// オプ ID は決定的で冪等）。役職は国家設定込みで解決する（任命大臣も可）。
// 状態の read-modify-write は全体ロックで直列化する。

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };
const BUY_RANGE = 3.5;

function err(error: string, status: number) {
  return NextResponse.json({ error }, { status, headers: NO_STORE });
}

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return !origin || origin === publicOrigin(request);
}

function discordIdOf(session: NonNullable<ReturnType<typeof getRequestSession>>): string | null {
  return session.provider === "discord" ? session.id : null;
}

async function lobbyPosition(ownerKey: string): Promise<{ x: number; y: number } | null> {
  const selfId = presenceIdFor(ownerKey);
  const now = Date.now();
  const entries = await listPresence();
  const entry = entries.find((e) => e.id === selfId && e.space === "lobby" && now - e.ts <= 15_000);
  if (entry) return { x: entry.x, y: entry.y };
  const saved = parseSave(await loadWorldBoxSave(ownerKey));
  if (saved && saved.space === "lobby") return { x: saved.x, y: saved.y };
  return null;
}

function view(
  state: GuildShopState,
  nations: Awaited<ReturnType<typeof loadNationsState>>,
  viewerKey: string,
) {
  return {
    plots: state.plots.map((plot) =>
      plot
        ? {
            idx: plot.idx,
            guildId: plot.guildId,
            guildName: nations.nations[plot.guildId]?.name ?? plot.guildId,
            listings: plot.listings.map((l) => ({
              id: l.id,
              itemId: l.itemId,
              name: itemById(l.itemId)?.name ?? l.itemId,
              available: listingAvailable(l),
              price: l.price,
              // 閲覧者本人の出品か（売り手の生キーは出さない）。
              // 「下げる」の表示条件をサーバーの unlist 権限と一致させる用。
              mine: l.sellerKey === viewerKey,
            })),
          }
        : null,
    ),
    plotFee: GUILD_PLOT_FEE,
  };
}

/** 国家設定込みの実効役職（任命大臣を含む）。 */
async function resolvedRole(
  nations: Awaited<ReturnType<typeof loadNationsState>>,
  ownerKey: string,
) {
  const membership = nations.members[ownerKey];
  if (!membership) return null;
  const nation = nations.nations[membership.nationId];
  if (!nation) return membership.role;
  const settings = await loadNationSettings(membership.nationId);
  const resolved = resolveMemberRole(
    nation, settings, ownerKey, membership.role, memberKeysOf(nations, membership.nationId),
  );
  return resolved?.role ?? membership.role;
}

export async function GET(request: Request) {
  const session = getRequestSession(request);
  if (!session) return err("unauthorized", 401);
  if (!isGuildShopEnabled()) return err("guild_shop_unavailable", 503);
  const ownerKey = sessionOwnerKey(session);
  const [state, nations] = await Promise.all([loadGuildShopState(), loadNationsState()]);
  const membership = nations.members[ownerKey];
  return NextResponse.json(
    {
      ...view(state, nations, ownerKey),
      myGuildId: membership?.nationId ?? null,
      myRole: await resolvedRole(nations, ownerKey),
    },
    { headers: NO_STORE },
  );
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return err("forbidden", 403);
  const session = getRequestSession(request);
  if (!session) return err("unauthorized", 401);
  if (!isGuildShopEnabled() || !isEconomyEnabled()) return err("guild_shop_unavailable", 503);
  const discordId = discordIdOf(session);
  if (!discordId) return err("discord_required", 403);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return err("invalid_request", 400);
  }
  const fields = (body ?? {}) as {
    action?: unknown; plotIdx?: unknown; listingId?: unknown;
    itemId?: unknown; count?: unknown; price?: unknown;
  };
  const ownerKey = sessionOwnerKey(session);

  return withUserLock("guild-shop:state", async () => {
    const [state, nations] = await Promise.all([loadGuildShopState(), loadNationsState()]);
    const membership = nations.members[ownerKey];
    const myGuild = membership?.nationId ?? null;
    const myRole = await resolvedRole(nations, ownerKey);
    const isLeader = myRole === "king" || myRole === "minister";
    const respond = async (next: GuildShopState) => {
      // 完売した出品は保存前に取り除く。残しておくとパネルからは
      // 到達できず（在庫 0 は表示されない）state に溜まり続ける。
      // 完売時点で売り手への入金は済んでおり、返却すべき在庫も無い。
      const pruned: GuildShopState = {
        ...next,
        plots: next.plots.map((p) =>
          p ? { ...p, listings: p.listings.filter((l) => listingAvailable(l) > 0) } : p,
        ),
      };
      if (!(await storeGuildShopState(pruned))) return err("store_failed", 503);
      return NextResponse.json(
        { ok: true, ...view(pruned, nations, ownerKey), myGuildId: myGuild, myRole },
        { headers: NO_STORE },
      );
    };

    if (fields.action === "register") {
      if (!myGuild || !isLeader) return err("leader_only", 403);
      const idx = typeof fields.plotIdx === "number" && Number.isFinite(fields.plotIdx) ? Math.floor(fields.plotIdx) : -1;
      if (idx < 0 || idx >= GUILD_PLOT_COUNT) return err("invalid_plot", 400);
      if (state.plots[idx]) return err("plot_taken", 409);
      if (plotOfGuild(state, myGuild)) return err("already_has_plot", 409);
      const balance = await readUserBalance(discordId);
      const ops = await loadMyEconomyOps(ownerKey);
      const pending = ops.filter((o) => o.status === "pending" && o.kind === "spend").reduce((s, o) => s + o.amount, 0);
      if (balance === null || balance - pending < GUILD_PLOT_FEE) return err("insufficient_balance", 409);
      const feeSeq = state.feeSeq + 1;
      const op = buildEconomyOp(
        { kind: "spend", userKey: ownerKey, discordId, amount: GUILD_PLOT_FEE, reason: "guild_plot_fee" },
        `gshop-fee-${discordId}-${feeSeq}`,
        Date.now(),
      );
      if (!op || !(await enqueueEconomyOpOnce(op))) return err("economy_failed", 503);
      const plots = [...state.plots];
      plots[idx] = { idx, guildId: myGuild, listings: [] };
      return respond({ ...state, plots, feeSeq });
    }

    if (fields.action === "unregister") {
      if (!myGuild || !isLeader) return err("leader_only", 403);
      const plot = plotOfGuild(state, myGuild);
      if (!plot) return err("no_plot", 409);
      // 残っている出品は各売り手へ返却する
      for (const listing of plot.listings) {
        const left = listingAvailable(listing);
        if (left <= 0) continue;
        const sellerProfile = await loadProfile(listing.sellerKey);
        await storeProfile(listing.sellerKey, addItem(sellerProfile, listing.itemId, left));
      }
      const plots = [...state.plots];
      plots[plot.idx] = null;
      return respond({ ...state, plots });
    }

    if (fields.action === "list") {
      if (!myGuild) return err("no_union", 409);
      const plot = plotOfGuild(state, myGuild);
      if (!plot) return err("no_plot", 409);
      if (plot.listings.filter((l) => listingAvailable(l) > 0).length >= GUILD_LISTING_MAX) {
        return err("too_many_listings", 409);
      }
      const itemId = typeof fields.itemId === "string" ? fields.itemId : "";
      const def = itemById(itemId);
      const count = typeof fields.count === "number" && Number.isFinite(fields.count) ? Math.floor(fields.count) : 0;
      const price = typeof fields.price === "number" && Number.isFinite(fields.price) ? Math.floor(fields.price) : 0;
      if (!def || count <= 0 || count > 999 || price <= 0 || price > 1_000_000) {
        return err("invalid_listing", 400);
      }
      const profile = await loadProfile(ownerKey);
      if (countItem(profile, itemId) < count) return err("not_enough_items", 409);
      const removed = removeItem(profile, itemId, count);
      if (!removed) return err("not_enough_items", 409);
      if (!(await storeProfile(ownerKey, removed))) return err("store_failed", 503);
      const seq = state.listingSeq + 1;
      const listing = { id: `l${seq}`, sellerKey: ownerKey, itemId, count, sold: 0, price };
      const plots = state.plots.map((p) =>
        p && p.idx === plot.idx ? { ...p, listings: [...p.listings, listing] } : p,
      );
      return respond({ ...state, plots, listingSeq: seq });
    }

    if (fields.action === "unlist") {
      const found = typeof fields.listingId === "string" ? findListing(state, fields.listingId) : null;
      if (!found) return err("no_listing", 404);
      const mine = found.listing.sellerKey === ownerKey;
      const leaderOfPlot = myGuild === found.plot.guildId && isLeader;
      if (!mine && !leaderOfPlot) return err("not_seller", 403);
      const left = listingAvailable(found.listing);
      if (left > 0) {
        const sellerProfile = await loadProfile(found.listing.sellerKey);
        await storeProfile(found.listing.sellerKey, addItem(sellerProfile, found.listing.itemId, left));
      }
      const plots = state.plots.map((p) =>
        p && p.idx === found.plot.idx
          ? { ...p, listings: p.listings.filter((l) => l.id !== found.listing.id) }
          : p,
      );
      return respond({ ...state, plots });
    }

    if (fields.action === "buy") {
      const found = typeof fields.listingId === "string" ? findListing(state, fields.listingId) : null;
      if (!found) return err("no_listing", 404);
      const count = typeof fields.count === "number" && Number.isFinite(fields.count) ? Math.floor(fields.count) : 1;
      if (count <= 0 || count > listingAvailable(found.listing)) return err("not_enough_stock", 409);
      if (found.listing.sellerKey === ownerKey) return err("own_listing", 409);
      // 区画カウンターの近くにいること（プレゼンス/セーブで検証）
      const pos = await lobbyPosition(ownerKey);
      if (!pos) return err("position_unknown", 409);
      const anchor = GUILD_PLOT_ANCHORS[found.plot.idx];
      if (Math.hypot(pos.x - (anchor.x + 0.5), pos.y - (anchor.y + 0.5)) > BUY_RANGE) {
        return err("too_far", 409);
      }
      const cost = found.listing.price * count;
      const balance = await readUserBalance(discordId);
      const ops = await loadMyEconomyOps(ownerKey);
      const pending = ops.filter((o) => o.status === "pending" && o.kind === "spend").reduce((s, o) => s + o.amount, 0);
      if (balance === null || balance - pending < cost) return err("insufficient_balance", 409);
      const newSold = found.listing.sold + count;
      const buyOp = buildEconomyOp(
        { kind: "spend", userKey: ownerKey, discordId, amount: cost, reason: "guild_shop_buy" },
        `gshop-buy-${found.listing.id}-${newSold}`,
        Date.now(),
      );
      if (!buyOp) return err("economy_failed", 503);
      // 直接適用で確定失敗（残高不足・CAS 枯渇）した買い手には
      // アイテムを渡さない。done / pending（キュー経路）は従来どおり進める。
      const buySubmitted = await submitEconomyOp(buyOp);
      if (buySubmitted.state === "unavailable") return err("economy_failed", 503);
      if (buySubmitted.state === "failed") return err("economy_failed", 409);
      // 売り手への入金（区画の国の税率を引いた額）。税分はシンクし、
      // 累計税収へ表示用に加算する。売り手が Discord 連携でない場合は積まない
      const plotSettings = await loadNationSettings(found.plot.guildId);
      const taxRate = taxRateOf(plotSettings);
      const sellerDiscord = found.listing.sellerKey.startsWith("discord:")
        ? found.listing.sellerKey.slice("discord:".length)
        : null;
      if (sellerDiscord) {
        const saleOp = buildEconomyOp(
          { kind: "earn", userKey: found.listing.sellerKey, discordId: sellerDiscord, amount: sellerProceeds(found.listing.price, count, taxRate), reason: "guild_shop_sale" },
          `gshop-sale-${found.listing.id}-${newSold}`,
          Date.now(),
        );
        if (saleOp) await enqueueEconomyOpOnce(saleOp);
      }
      const tax = saleTaxAmount(found.listing.price, count, taxRate);
      if (tax > 0) {
        await updateNationSettings(found.plot.guildId, (cur) => ({
          ...cur, taxCollected: cur.taxCollected + tax,
        }));
      }
      const profile = await loadProfile(ownerKey);
      await storeProfile(ownerKey, addItem(profile, found.listing.itemId, count));
      void bumpMetric("guildShopVolume", cost, Date.now());
      const plots = state.plots.map((p) =>
        p && p.idx === found.plot.idx
          ? {
              ...p,
              listings: p.listings.map((l) => (l.id === found.listing.id ? { ...l, sold: newSold } : l)),
            }
          : p,
      );
      return respond({ ...state, plots });
    }

    return err("invalid_action", 400);
  });
}
