import { NextResponse } from "next/server";
import { getRequestSession, publicOrigin, sessionOwnerKey } from "@/lib/auth";
import { buildEconomyOp } from "@/lib/worldbox/economy-bridge";
import {
  isEconomyEnabled, readUserBalance, submitEconomyOp, waitForOpDone,
} from "@/lib/worldbox/economy-bridge-online";
import { presenceIdFor } from "@/lib/worldbox/presence";
import { listPresenceWithOwners } from "@/lib/worldbox/presence-online";
import { bumpProfileStat, countItem, type PlayerProfile } from "@/lib/worldbox/profile";
import { isProfileEnabled, loadProfile, storeProfile } from "@/lib/worldbox/profile-online";
import { notifyAchievementDiscord } from "@/lib/worldbox/progress-online";
import {
  confirmTrade, createTradeSession, isTradeExpired, makeTradeId, netCoinTransfer,
  normalizeTradeOffer, setTradeOffer, setTradeReady, sideOfTrade, swapTradeItems,
  toTradeClientView, TRADE_ID_RE, TRADE_RANGE, type TradeOffer, type TradeSession,
} from "@/lib/worldbox/trade";
import {
  clearActiveTradeIndex, isTradeEnabled, loadActiveTradeFor, loadTradeSession,
  setActiveTradeIndex, storeTradeSession,
} from "@/lib/worldbox/trade-online";
import { withUserLock } from "@/lib/worldbox/user-lock";

export const runtime = "nodejs";

// AGO WORLD BOX の P2P リアルタイム直接取引。
// GET (?id=): 現在関与中の取引（招待・進行中・指定 ID の終端結果）を返す。
// POST { action, ... }:
//   - invite { targetId }: 7タイル以内の同空間プレイヤーに取引申込。
//   - accept { tradeId }: 相手が承諾して open にする（近接検証つき）。
//   - decline / cancel { tradeId }: 拒否または中断。
//   - set_offer { tradeId, items, coins }: 自分の提示を更新。両者の ready/confirmed を自動解除（詐欺防止）。
//   - ready { tradeId, ready }: 準備完了の切替（アイテム・残高検証つき）。
//   - confirm { tradeId }: 最終確認。両者確認でアイテム交換＋純額 AGO コイン送金を原子的に確定する。
// ロック順は常に trade:${tradeId}（外側）→ sorted(ownerKeyA, ownerKeyB)（内側）。

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return !origin || origin === publicOrigin(request);
}

function err(error: string, status = 409) {
  return NextResponse.json({ error }, { status, headers: NO_STORE });
}

function discordIdFromKey(ownerKey: string): string | null {
  return ownerKey.startsWith("discord:") ? ownerKey.slice("discord:".length) : null;
}

async function expireIfNeeded(session: TradeSession, now: number): Promise<TradeSession> {
  if (!isTradeExpired(session, now)) return session;
  const cancelled: TradeSession = { ...session, status: "cancelled", updatedAt: now };
  await storeTradeSession(cancelled);
  await clearActiveTradeIndex(session.a.ownerKey);
  await clearActiveTradeIndex(session.b.ownerKey);
  return cancelled;
}

async function withSortedUserLocks<T>(keyA: string, keyB: string, fn: () => Promise<T>): Promise<T> {
  const [first, second] = keyA <= keyB ? [keyA, keyB] : [keyB, keyA];
  if (first === second) return withUserLock(first, fn);
  return withUserLock(first, () => withUserLock(second, fn));
}

function verifyOfferOwned(
  profile: PlayerProfile,
  offer: TradeOffer,
  balance: number | null,
): string | null {
  for (const [itemId, qty] of Object.entries(offer.items)) {
    if (countItem(profile, itemId) < qty) return "not_enough_items";
  }
  if (offer.coins > 0) {
    if (balance === null) return "discord_required";
    if (balance < offer.coins) return "insufficient_balance";
  }
  return null;
}

export async function GET(request: Request) {
  const session = getRequestSession(request);
  if (!session) return err("unauthorized", 401);
  if (!isTradeEnabled() || !isProfileEnabled()) return err("trade_unavailable", 503);

  const ownerKey = sessionOwnerKey(session);
  const now = Date.now();
  const url = new URL(request.url);
  const requestedId = url.searchParams.get("id");

  let trade: TradeSession | null = null;
  if (requestedId && TRADE_ID_RE.test(requestedId)) {
    const loaded = await loadTradeSession(requestedId);
    if (loaded && sideOfTrade(loaded, ownerKey)) {
      trade = await expireIfNeeded(loaded, now);
    }
  }
  if (!trade) {
    const active = await loadActiveTradeFor(ownerKey);
    if (active) {
      const checked = await expireIfNeeded(active, now);
      if (checked.status === "pending" || checked.status === "open") {
        trade = checked;
      }
    }
  }

  const discordId = discordIdFromKey(ownerKey);
  const balance = discordId && isEconomyEnabled() ? await readUserBalance(discordId) : null;

  return NextResponse.json(
    {
      trade: trade ? toTradeClientView(trade, ownerKey) : null,
      balance,
    },
    { headers: NO_STORE },
  );
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return err("forbidden", 403);
  const session = getRequestSession(request);
  if (!session) return err("unauthorized", 401);
  if (!isTradeEnabled() || !isProfileEnabled()) return err("trade_unavailable", 503);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return err("invalid_request", 400);
  }
  const fields = (body ?? {}) as {
    action?: unknown;
    targetId?: unknown;
    tradeId?: unknown;
    items?: unknown;
    coins?: unknown;
    ready?: unknown;
  };
  const ownerKey = sessionOwnerKey(session);
  const selfId = presenceIdFor(ownerKey);
  const myName = (session.username ?? "").trim() || "プレイヤー";
  const now = Date.now();

  if (fields.action === "invite") {
    const targetId = typeof fields.targetId === "string" ? fields.targetId : "";
    if (!targetId || targetId === selfId) return err("invalid_request", 400);

    const owners = await listPresenceWithOwners();
    const mePres = owners.find((o) => o.ownerKey === ownerKey && o.entry.id === selfId);
    const targetPres = owners.find((o) => o.entry.id === targetId);
    if (!mePres || !targetPres || mePres.entry.space !== targetPres.entry.space) {
      return err("target_not_near", 409);
    }
    if (Math.hypot(targetPres.entry.x - mePres.entry.x, targetPres.entry.y - mePres.entry.y) > TRADE_RANGE) {
      return err("target_not_near", 409);
    }
    if (targetPres.ownerKey === ownerKey) return err("invalid_request", 400);

    return withSortedUserLocks(ownerKey, targetPres.ownerKey, async () => {
      const [myActive, targetActive] = await Promise.all([
        loadActiveTradeFor(ownerKey),
        loadActiveTradeFor(targetPres.ownerKey),
      ]);
      if (myActive) {
        const checked = await expireIfNeeded(myActive, now);
        if (checked.status === "pending" || checked.status === "open") {
          return err("already_trading", 409);
        }
      }
      if (targetActive) {
        const checked = await expireIfNeeded(targetActive, now);
        if (checked.status === "pending" || checked.status === "open") {
          return err("target_busy", 409);
        }
      }

      const trade = createTradeSession(
        makeTradeId(now),
        mePres.entry.space,
        { ownerKey, id: selfId, name: myName },
        { ownerKey: targetPres.ownerKey, id: targetPres.entry.id, name: targetPres.entry.name || "プレイヤー" },
        now,
      );
      if (!(await storeTradeSession(trade))) return err("store_failed", 503);
      await Promise.all([
        setActiveTradeIndex(ownerKey, trade.id),
        setActiveTradeIndex(targetPres.ownerKey, trade.id),
      ]);
      return NextResponse.json(
        { ok: true, trade: toTradeClientView(trade, ownerKey) },
        { headers: NO_STORE },
      );
    });
  }

  const tradeId = typeof fields.tradeId === "string" ? fields.tradeId : "";
  if (!TRADE_ID_RE.test(tradeId)) return err("invalid_request", 400);

  return withUserLock(`trade:${tradeId}`, async () => {
    const loaded = await loadTradeSession(tradeId);
    if (!loaded || !sideOfTrade(loaded, ownerKey)) return err("trade_not_found", 404);
    const current = await expireIfNeeded(loaded, now);
    if (current.status === "cancelled" || current.status === "completed") {
      if (fields.action === "cancel" || fields.action === "decline") {
        return NextResponse.json(
          { ok: true, trade: toTradeClientView(current, ownerKey) },
          { headers: NO_STORE },
        );
      }
      return err("trade_closed", 409);
    }

    if (fields.action === "accept") {
      if (current.status !== "pending") return err("not_pending", 409);
      if (current.b.ownerKey !== ownerKey) return err("forbidden", 403);
      const owners = await listPresenceWithOwners();
      const presA = owners.find((o) => o.ownerKey === current.a.ownerKey);
      const presB = owners.find((o) => o.ownerKey === current.b.ownerKey);
      if (
        !presA || !presB ||
        presA.entry.space !== current.space || presB.entry.space !== current.space ||
        Math.hypot(presA.entry.x - presB.entry.x, presA.entry.y - presB.entry.y) > TRADE_RANGE
      ) {
        return err("target_not_near", 409);
      }
      const next: TradeSession = { ...current, status: "open", updatedAt: now };
      if (!(await storeTradeSession(next))) return err("store_failed", 503);
      return NextResponse.json(
        { ok: true, trade: toTradeClientView(next, ownerKey) },
        { headers: NO_STORE },
      );
    }

    if (fields.action === "decline" || fields.action === "cancel") {
      const next: TradeSession = { ...current, status: "cancelled", updatedAt: now };
      if (!(await storeTradeSession(next))) return err("store_failed", 503);
      await Promise.all([
        clearActiveTradeIndex(current.a.ownerKey),
        clearActiveTradeIndex(current.b.ownerKey),
      ]);
      return NextResponse.json(
        { ok: true, trade: toTradeClientView(next, ownerKey) },
        { headers: NO_STORE },
      );
    }

    if (fields.action === "set_offer") {
      const offer = normalizeTradeOffer({ items: fields.items ?? {}, coins: fields.coins ?? 0 });
      if (!offer) return err("invalid_offer", 400);
      if (offer.coins > 0 && !discordIdFromKey(ownerKey)) return err("discord_required", 409);
      const myProfile = await loadProfile(ownerKey);
      const myDiscordId = discordIdFromKey(ownerKey);
      const myBalance = offer.coins > 0 && myDiscordId && isEconomyEnabled() ? await readUserBalance(myDiscordId) : 0;
      if (offer.coins > 0 && myBalance === null) return err("economy_unavailable", 503);
      const ownedErr = verifyOfferOwned(myProfile, offer, myBalance);
      if (ownedErr) return err(ownedErr, 409);

      const updated = setTradeOffer(current, ownerKey, offer, now);
      if ("error" in updated) return err(updated.error, 409);
      if (!(await storeTradeSession(updated))) return err("store_failed", 503);
      return NextResponse.json(
        { ok: true, trade: toTradeClientView(updated, ownerKey) },
        { headers: NO_STORE },
      );
    }

    if (fields.action === "ready") {
      const ready = fields.ready === true;
      if (ready) {
        const side = sideOfTrade(current, ownerKey)!;
        const myOffer = side === "a" ? current.a.offer : current.b.offer;
        const myProfile = await loadProfile(ownerKey);
        const myDiscordId = discordIdFromKey(ownerKey);
        const myBalance = myOffer.coins > 0 && myDiscordId && isEconomyEnabled() ? await readUserBalance(myDiscordId) : 0;
        if (myOffer.coins > 0 && myBalance === null) return err("economy_unavailable", 503);
        const ownedErr = verifyOfferOwned(myProfile, myOffer, myBalance);
        if (ownedErr) return err(ownedErr, 409);
      }
      const updated = setTradeReady(current, ownerKey, ready, now);
      if ("error" in updated) return err(updated.error, 409);
      if (!(await storeTradeSession(updated))) return err("store_failed", 503);
      return NextResponse.json(
        { ok: true, trade: toTradeClientView(updated, ownerKey) },
        { headers: NO_STORE },
      );
    }

    if (fields.action === "confirm") {
      const confirmed = confirmTrade(current, ownerKey, now);
      if ("error" in confirmed) return err(confirmed.error, 409);
      if (!(confirmed.a.confirmed && confirmed.b.confirmed)) {
        if (!(await storeTradeSession(confirmed))) return err("store_failed", 503);
        return NextResponse.json(
          { ok: true, trade: toTradeClientView(confirmed, ownerKey) },
          { headers: NO_STORE },
        );
      }

      // 両者が最終確認済み → 近接確認・経済検証・在庫交換を原子的に確定する
      const owners = await listPresenceWithOwners();
      const presA = owners.find((o) => o.ownerKey === confirmed.a.ownerKey);
      const presB = owners.find((o) => o.ownerKey === confirmed.b.ownerKey);
      if (
        !presA || !presB ||
        presA.entry.space !== confirmed.space || presB.entry.space !== confirmed.space ||
        Math.hypot(presA.entry.x - presB.entry.x, presA.entry.y - presB.entry.y) > TRADE_RANGE
      ) {
        return err("target_not_near", 409);
      }

      return withSortedUserLocks(confirmed.a.ownerKey, confirmed.b.ownerKey, async () => {
        const [profA, profB] = await Promise.all([
          loadProfile(confirmed.a.ownerKey),
          loadProfile(confirmed.b.ownerKey),
        ]);
        const swapped = swapTradeItems(profA, profB, confirmed.a.offer.items, confirmed.b.offer.items);
        if (!swapped.ok) {
          return err("not_enough_items", 409);
        }

        const net = netCoinTransfer(confirmed);
        if (net) {
          const fromId = discordIdFromKey(net.from.ownerKey);
          const toId = discordIdFromKey(net.to.ownerKey);
          if (!fromId || !toId) return err("discord_required", 409);
          if (!isEconomyEnabled()) return err("economy_unavailable", 503);
          const bal = await readUserBalance(fromId);
          if (bal === null) return err("economy_unavailable", 503);
          if (bal < net.amount) return err("insufficient_balance", 409);
          const op = buildEconomyOp(
            {
              kind: "transfer",
              userKey: net.from.ownerKey,
              discordId: fromId,
              toDiscordId: toId,
              amount: net.amount,
              reason: "player_trade",
            },
            `trade-${confirmed.id}`,
            now,
          );
          if (!op) return err("economy_failed", 409);
          const submitRes = await submitEconomyOp(op);
          if (submitRes.state === "unavailable") return err("economy_unavailable", 503);
          const finalOp =
            submitRes.state === "pending"
              ? await waitForOpDone(op.userKey, op.id, { timeoutMs: 3_000 })
              : submitRes.op;
          if (!finalOp || finalOp.status === "pending") return err("economy_pending", 503);
          if (finalOp.status === "failed") return err(finalOp.error || "economy_failed", 409);
        }

        const nextA = bumpProfileStat(swapped.aProfile, "trades", 1);
        const nextB = bumpProfileStat(swapped.bProfile, "trades", 1);
        const savedA = await storeProfile(confirmed.a.ownerKey, nextA);
        if (!savedA) return err("store_failed", 500);
        const savedB = await storeProfile(confirmed.b.ownerKey, nextB);
        if (!savedB) {
          await storeProfile(confirmed.a.ownerKey, profA);
          return err("store_failed", 500);
        }

        const completed: TradeSession = { ...confirmed, status: "completed", updatedAt: now };
        await storeTradeSession(completed);
        await Promise.all([
          clearActiveTradeIndex(completed.a.ownerKey),
          clearActiveTradeIndex(completed.b.ownerKey),
        ]);

        void notifyAchievementDiscord(completed.a.ownerKey, completed.a.name, profA, nextA);
        void notifyAchievementDiscord(completed.b.ownerKey, completed.b.name, profB, nextB);

        const myNewProfile =
          ownerKey === completed.a.ownerKey ? nextA : nextB;
        return NextResponse.json(
          {
            ok: true,
            trade: toTradeClientView(completed, ownerKey),
            profile: myNewProfile,
          },
          { headers: NO_STORE },
        );
      });
    }

    return err("invalid_request", 400);
  });
}
