"use client";
// AGO WORLD BOX の P2P 直接取引パネル。
// 近いプレイヤー間でアイテム＋AGOコインを同時に確認して交換する。
import { useCallback, useEffect, useMemo, useState } from "react";
import { ITEMS } from "@/lib/worldbox/items";
import { countItem, type PlayerProfile } from "@/lib/worldbox/profile";
import {
  TRADE_MAX_COINS, TRADE_MAX_DISTINCT_ITEMS, TRADE_MAX_ITEM_COUNT,
  type TradeClientView,
} from "@/lib/worldbox/trade";
import { onTradeChanged } from "@/lib/worldbox/trade-push";
import { ItemAnnotation, ItemSlot, ItemSlotGrid } from "./ItemSlotGrid";

const panelStyle: React.CSSProperties = {
  position: "absolute", left: "50%", top: "50%", transform: "translate(-50%, -50%)",
  width: "min(410px, calc(100% - 20px))", zIndex: 32,
  maxHeight: "calc(100% - 24px)", overflowY: "auto", overscrollBehavior: "contain",
  background: "rgba(12,15,22,0.96)", border: "1px solid rgba(255,255,255,0.25)",
  borderRadius: 12, padding: "12px 14px", color: "#fff",
  boxShadow: "0 10px 32px rgba(0,0,0,0.55)",
};
const btn: React.CSSProperties = {
  minHeight: 34, padding: "4px 10px", borderRadius: 8, cursor: "pointer",
  border: "1px solid rgba(255,255,255,0.3)", background: "rgba(255,255,255,0.09)", color: "#fff",
  fontSize: 13, touchAction: "manipulation", userSelect: "none",
};
const primaryBtn: React.CSSProperties = {
  ...btn,
  background: "rgba(255,210,62,0.22)", borderColor: "rgba(255,210,62,0.8)", fontWeight: 700,
};
const boxStyle: React.CSSProperties = {
  marginTop: 8, padding: "8px 10px", borderRadius: 10,
  border: "1px solid rgba(255,255,255,0.14)", background: "rgba(255,255,255,0.04)",
};
const inputStyle: React.CSSProperties = {
  width: 96, minHeight: 34, padding: "4px 8px", borderRadius: 8,
  border: "1px solid rgba(255,255,255,0.25)", background: "rgba(255,255,255,0.08)",
  color: "#fff", fontSize: 13,
};

const TRADE_ERROR_LABEL: Record<string, string> = {
  target_not_near: "相手が近くにいない",
  already_trading: "取引中",
  target_busy: "相手が取引中",
  not_enough_items: "アイテム不足",
  insufficient_balance: "コイン不足",
  discord_required: "Discord ログインが必要",
  economy_unavailable: "コイン機能停止中",
  economy_pending: "決済処理中",
  economy_failed: "決済失敗",
  not_ready: "準備未完了",
  trade_closed: "取引終了",
  trade_not_found: "取引なし",
  invalid_offer: "提示が不正",
  not_open: "開始待ち",
};

function offerStateLabel(p: { ready: boolean; confirmed: boolean }): string {
  if (p.confirmed) return "確定済";
  if (p.ready) return "準備OK";
  return "調整中";
}

function sameItems(a: Record<string, number>, b: Record<string, number>): boolean {
  const ak = Object.keys(a).filter((k) => (a[k] ?? 0) > 0);
  const bk = Object.keys(b).filter((k) => (b[k] ?? 0) > 0);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => a[k] === b[k]);
}

export default function WorldBoxTradePanel({
  initialTrade,
  profile,
  onTradeUpdate,
  onProfileChange,
  onRefreshProfile,
  onClose,
}: {
  initialTrade: TradeClientView | null;
  profile: PlayerProfile | null;
  onTradeUpdate: (trade: TradeClientView | null) => void;
  onProfileChange: (profile: PlayerProfile) => void;
  onRefreshProfile: () => void;
  onClose: () => void;
}) {
  const [trade, setTrade] = useState<TradeClientView | null>(initialTrade);
  const [balance, setBalance] = useState<number | null>(null);
  const [draftItems, setDraftItems] = useState<Record<string, number>>(() => initialTrade?.self.offer.items ?? {});
  const [draftCoinsText, setDraftCoinsText] = useState<string>(() => String(initialTrade?.self.offer.coins ?? 0));
  const [selTarget, setSelTarget] = useState<{ zone: "partner" | "self" | "bag"; id: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [syncedTradeId, setSyncedTradeId] = useState<string>(initialTrade?.id ?? "");

  const applyServerTrade = useCallback(
    (next: TradeClientView | null) => {
      setTrade(next);
      onTradeUpdate(next);
      if (!next) return;
      if (next.id !== syncedTradeId) {
        setSyncedTradeId(next.id);
        setDraftItems({ ...next.self.offer.items });
        setDraftCoinsText(String(next.self.offer.coins));
      }
      if (next.status === "completed") {
        setMsg("取引完了");
        onRefreshProfile();
      } else if (next.status === "cancelled") {
        setMsg("取引終了");
      }
    },
    [onTradeUpdate, onRefreshProfile, syncedTradeId],
  );

  const refresh = useCallback(async () => {
    try {
      const q = trade?.id ? `?id=${encodeURIComponent(trade.id)}` : "";
      const res = await fetch(`/api/worldbox/trade${q}`, { headers: { Accept: "application/json" } });
      if (!res.ok) return;
      const data = (await res.json()) as { trade?: TradeClientView | null; balance?: number | null };
      if (typeof data.balance === "number" || data.balance === null) setBalance(data.balance);
      if (data.trade !== undefined) applyServerTrade(data.trade);
    } catch { /* noop */ }
  }, [trade?.id, applyServerTrade]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => onTradeChanged(() => { void refresh(); }), [refresh]);

  const draftCoins = useMemo(() => {
    const n = Math.floor(Number(draftCoinsText));
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.min(TRADE_MAX_COINS, n);
  }, [draftCoinsText]);

  const postAction = async (payload: Record<string, unknown>) => {
    setBusy(true);
    setMsg("");
    try {
      const res = await fetch("/api/worldbox/trade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        trade?: TradeClientView | null;
        profile?: PlayerProfile;
      };
      if (!res.ok) {
        setMsg(TRADE_ERROR_LABEL[data.error ?? ""] ?? "失敗");
        void refresh();
        return false;
      }
      if (data.profile) onProfileChange(data.profile);
      if (data.trade !== undefined) {
        if (data.trade) {
          setDraftItems({ ...data.trade.self.offer.items });
          setDraftCoinsText(String(data.trade.self.offer.coins));
        }
        applyServerTrade(data.trade);
      }
      return true;
    } catch {
      setMsg("失敗");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const dirty = Boolean(
    trade &&
    trade.status === "open" &&
    (!sameItems(draftItems, trade.self.offer.items) || draftCoins !== trade.self.offer.coins),
  );

  const adjustDraftItem = (itemId: string, delta: number) => {
    if (!profile || !trade || trade.status !== "open") return;
    const owned = countItem(profile, itemId);
    const cur = draftItems[itemId] ?? 0;
    const nextCount = Math.max(0, Math.min(TRADE_MAX_ITEM_COUNT, owned, cur + delta));
    const next = { ...draftItems };
    if (nextCount > 0) {
      if (!cur && Object.keys(next).length >= TRADE_MAX_DISTINCT_ITEMS) {
        setMsg(`最大${TRADE_MAX_DISTINCT_ITEMS}種`);
        return;
      }
      next[itemId] = nextCount;
    } else {
      delete next[itemId];
    }
    setDraftItems(next);
  };

  const bagItems = useMemo(() => {
    if (!profile) return [];
    return ITEMS.filter((def) => countItem(profile, def.id) > 0);
  }, [profile]);

  const partnerItems = trade ? Object.entries(trade.partner.offer.items).filter(([, c]) => c > 0) : [];
  const draftEntries = Object.entries(draftItems).filter(([, c]) => c > 0);

  return (
    <div style={panelStyle} role="dialog" aria-label="取引" className="wb-panel">
      <div
        style={{
          display: "flex", alignItems: "center", gap: 8,
          position: "sticky", top: -12, zIndex: 3,
          margin: "-12px -14px 0", padding: "12px 14px 8px",
          background: "rgba(12,15,22,0.98)", borderBottom: "1px solid rgba(255,255,255,0.1)",
        }}
      >
        <strong style={{ fontSize: 15 }}>取引</strong>
        {trade && <span style={{ fontSize: 13, opacity: 0.85 }}>{trade.partner.name}</span>}
        <span style={{ flex: 1 }} />
        {balance !== null && <span style={{ fontSize: 12, color: "#ffd75e" }}>{balance.toLocaleString()} C</span>}
        <button type="button" style={btn} onClick={onClose}>閉じる</button>
      </div>

      {!trade ? (
        <div style={{ marginTop: 12, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: 13, opacity: 0.75 }}>取引なし</span>
          <button type="button" style={btn} onClick={onClose}>閉じる</button>
        </div>
      ) : trade.status === "pending" ? (
        <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontSize: 13 }}>
            {trade.selfSide === "a" ? `${trade.partner.name} 応答待ち` : `${trade.partner.name} から申込`}
          </span>
          <span style={{ flex: 1 }} />
          {trade.selfSide === "b" && (
            <button
              type="button"
              style={primaryBtn}
              disabled={busy}
              onClick={() => { void postAction({ action: "accept", tradeId: trade.id }); }}
            >
              受ける
            </button>
          )}
          <button
            type="button"
            style={btn}
            disabled={busy}
            onClick={() => {
              void postAction({ action: trade.selfSide === "b" ? "decline" : "cancel", tradeId: trade.id }).then(() => onClose());
            }}
          >
            {trade.selfSide === "b" ? "断る" : "取消"}
          </button>
        </div>
      ) : (
        <>
          <div style={boxStyle}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, fontSize: 13 }}>
              <strong>{trade.partner.name}</strong>
              <span style={{ fontSize: 12, color: trade.partner.ready ? "#8ce08a" : "#bbb" }}>
                {offerStateLabel(trade.partner)}
              </span>
              <span style={{ flex: 1 }} />
              <span style={{ color: "#ffd75e", fontWeight: 700 }}>{trade.partner.offer.coins.toLocaleString()} C</span>
            </div>
            {partnerItems.length === 0 ? (
              <span style={{ fontSize: 12, opacity: 0.65 }}>アイテムなし</span>
            ) : (
              <ItemSlotGrid>
                {partnerItems.map(([id, count]) => (
                  <ItemSlot
                    key={id}
                    itemId={id}
                    count={count}
                    selected={selTarget?.zone === "partner" && selTarget.id === id}
                    onClick={() => setSelTarget({ zone: "partner", id })}
                  />
                ))}
              </ItemSlotGrid>
            )}
            {selTarget?.zone === "partner" && (
              <ItemAnnotation itemId={selTarget.id} />
            )}
          </div>

          <div style={boxStyle}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, fontSize: 13 }}>
              <strong>あなた</strong>
              <span style={{ fontSize: 12, color: trade.self.ready ? "#8ce08a" : "#bbb" }}>
                {offerStateLabel(trade.self)}
              </span>
              <span style={{ flex: 1 }} />
              <span style={{ color: "#ffd75e", fontWeight: 700 }}>{draftCoins.toLocaleString()} C</span>
            </div>
            {draftEntries.length === 0 ? (
              <span style={{ fontSize: 12, opacity: 0.65 }}>アイテムなし</span>
            ) : (
              <ItemSlotGrid>
                {draftEntries.map(([id, count]) => (
                  <ItemSlot
                    key={id}
                    itemId={id}
                    count={count}
                    selected={selTarget?.zone === "self" && selTarget.id === id}
                    onClick={() => setSelTarget({ zone: "self", id })}
                  />
                ))}
              </ItemSlotGrid>
            )}
            {selTarget?.zone === "self" && (
              <ItemAnnotation itemId={selTarget.id}>
                {trade.status === "open" && (
                  <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
                    <button type="button" style={btn} onClick={() => adjustDraftItem(selTarget.id, -1)}>-1</button>
                    <button type="button" style={btn} onClick={() => adjustDraftItem(selTarget.id, -5)}>-5</button>
                    <button type="button" style={btn} onClick={() => adjustDraftItem(selTarget.id, 1)}>+1</button>
                    <button
                      type="button"
                      style={btn}
                      onClick={() => {
                        adjustDraftItem(selTarget.id, -TRADE_MAX_ITEM_COUNT);
                        setSelTarget(null);
                      }}
                    >
                      はずす
                    </button>
                  </div>
                )}
              </ItemAnnotation>
            )}

            {trade.status === "open" && (
              <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
                <span style={{ fontSize: 12 }}>コイン</span>
                <input
                  type="number"
                  min={0}
                  max={TRADE_MAX_COINS}
                  value={draftCoinsText}
                  onChange={(e) => setDraftCoinsText(e.target.value)}
                  style={inputStyle}
                  aria-label="提示コイン"
                />
                <button type="button" style={btn} onClick={() => setDraftCoinsText(String(Math.min(TRADE_MAX_COINS, draftCoins + 100)))}>+100</button>
                <button type="button" style={btn} onClick={() => setDraftCoinsText(String(Math.min(TRADE_MAX_COINS, draftCoins + 1000)))}>+1000</button>
                <button type="button" style={btn} onClick={() => setDraftCoinsText("0")}>0</button>
                <button
                  type="button"
                  style={dirty ? primaryBtn : btn}
                  disabled={busy}
                  onClick={() => { void postAction({ action: "set_offer", tradeId: trade.id, items: draftItems, coins: draftCoins }); }}
                >
                  提示反映
                </button>
              </div>
            )}
          </div>

          {trade.status === "open" && (
            <div style={boxStyle}>
              <div style={{ fontSize: 12, marginBottom: 6, opacity: 0.85 }}>手持ち</div>
              {bagItems.length === 0 ? (
                <span style={{ fontSize: 12, opacity: 0.65 }}>なし</span>
              ) : (
                <ItemSlotGrid>
                  {bagItems.map((def) => (
                    <ItemSlot
                      key={def.id}
                      itemId={def.id}
                      count={profile ? countItem(profile, def.id) : 0}
                      selected={selTarget?.zone === "bag" && selTarget.id === def.id}
                      onClick={() => setSelTarget({ zone: "bag", id: def.id })}
                    />
                  ))}
                </ItemSlotGrid>
              )}
              {selTarget?.zone === "bag" && (
                <ItemAnnotation itemId={selTarget.id}>
                  <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
                    <button type="button" style={btn} onClick={() => adjustDraftItem(selTarget.id, 1)}>+1</button>
                    <button type="button" style={btn} onClick={() => adjustDraftItem(selTarget.id, 5)}>+5</button>
                    <button type="button" style={btn} onClick={() => adjustDraftItem(selTarget.id, TRADE_MAX_ITEM_COUNT)}>最大</button>
                  </div>
                </ItemAnnotation>
              )}
            </div>
          )}

          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
            {trade.status === "open" ? (
              <>
                <button
                  type="button"
                  style={trade.self.ready ? btn : primaryBtn}
                  disabled={busy || dirty}
                  onClick={() => { void postAction({ action: "ready", tradeId: trade.id, ready: !trade.self.ready }); }}
                >
                  {trade.self.ready ? "準備解除" : "準備完了"}
                </button>
                {trade.self.ready && trade.partner.ready && !trade.self.confirmed && !dirty && (
                  <button
                    type="button"
                    style={primaryBtn}
                    disabled={busy}
                    onClick={() => { void postAction({ action: "confirm", tradeId: trade.id }); }}
                  >
                    取引確定
                  </button>
                )}
                <span style={{ flex: 1 }} />
                <button
                  type="button"
                  style={btn}
                  disabled={busy}
                  onClick={() => { void postAction({ action: "cancel", tradeId: trade.id }); }}
                >
                  中止
                </button>
              </>
            ) : (
              <>
                <span style={{ fontSize: 13, fontWeight: 700, color: trade.status === "completed" ? "#8ce08a" : "#bbb" }}>
                  {trade.status === "completed" ? "取引完了" : "取引終了"}
                </span>
                <span style={{ flex: 1 }} />
                <button type="button" style={primaryBtn} onClick={onClose}>閉じる</button>
              </>
            )}
          </div>
        </>
      )}

      {msg && <p role="status" style={{ margin: "8px 0 0", fontSize: 13, color: "#ffd75e" }}>{msg}</p>}
    </div>
  );
}
