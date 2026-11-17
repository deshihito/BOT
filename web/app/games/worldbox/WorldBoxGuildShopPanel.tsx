"use client";

// AGO WORLD BOX のギルドショップパネル。
// ロビー2階の屋台区画（6つ）をユニオンが借り、所属員が出品し誰でも買える。
// 状態の正はサーバー（/api/worldbox/guild-shop）。購入は区画の近くでのみ。
import { useCallback, useEffect, useState } from "react";
import type { PlayerProfile } from "@/lib/worldbox/profile";
import { onGuildShopChanged } from "@/lib/worldbox/guild-shop-push";
import { ItemAnnotation, ItemSlot, ItemSlotGrid } from "./ItemSlotGrid";

const panelStyle: React.CSSProperties = {
  position: "absolute", left: "50%", top: "50%", transform: "translate(-50%, -50%)",
  width: "min(430px, calc(100% - 20px))", maxHeight: "calc(100% - 24px)", overflowY: "auto",
  zIndex: 30, background: "rgba(16,20,18,0.96)", border: "1px solid rgba(255,255,255,0.22)",
  borderRadius: 12, padding: "12px 14px", color: "#fff", boxShadow: "0 8px 28px rgba(0,0,0,0.45)",
};
const btn: React.CSSProperties = {
  minHeight: 30, padding: "3px 10px", borderRadius: 8, cursor: "pointer",
  border: "1px solid rgba(255,255,255,0.35)", background: "rgba(255,255,255,0.12)", color: "#fff",
  fontSize: 13,
};
const input: React.CSSProperties = {
  minHeight: 30, padding: "3px 8px", borderRadius: 8, border: "1px solid rgba(255,255,255,0.25)",
  background: "rgba(255,255,255,0.08)", color: "#fff", fontSize: 13,
};

type ListingView = { id: string; itemId: string; name: string; available: number; price: number; mine: boolean };
type PlotView = { idx: number; guildId: string; guildName: string; listings: ListingView[] } | null;
type ShopView = {
  plots: PlotView[];
  plotFee: number;
  myGuildId: string | null;
  myRole: string | null;
};

export default function WorldBoxGuildShopPanel({
  profile,
  onProfileChange,
  onClose,
}: {
  profile: PlayerProfile | null;
  onProfileChange: (profile: PlayerProfile) => void;
  onClose: () => void;
}) {
  const [shop, setShop] = useState<ShopView | null>(null);
  const [msg, setMsg] = useState("");
  const [sellItemId, setSellItemId] = useState("");
  const [sellCount, setSellCount] = useState(1);
  const [sellPrice, setSellPrice] = useState(100);
  const [listSel, setListSel] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/worldbox/guild-shop", { headers: { Accept: "application/json" } });
      if (res.ok) setShop((await res.json()) as ShopView);
    } catch { /* noop */ }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 他人の借り換え・出品・購入が relay の poke で届いたら取り直す
  useEffect(() => onGuildShopChanged(() => { void refresh(); }), [refresh]);

  const post = async (payload: Record<string, unknown>) => {
    setMsg("");
    try {
      const res = await fetch("/api/worldbox/guild-shop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await res.json().catch(() => ({}))) as ShopView & { error?: string };
      if (!res.ok) {
        setMsg(
          data.error === "too_far" ? "区画の近くで買える"
          : data.error === "insufficient_balance" ? "コインが足りない"
          : data.error === "not_enough_items" ? "持ち物が足りない"
          : data.error === "not_enough_stock" ? "在庫が足りない"
          : "できない",
        );
        return;
      }
      setShop(data);
      // 出品/取り下げで自分の持ち物が動いたら取り直す
      const profRes = await fetch("/api/worldbox/profile", { headers: { Accept: "application/json" } });
      if (profRes.ok) {
        const profData = (await profRes.json()) as { profile?: PlayerProfile };
        if (profData.profile) onProfileChange(profData.profile);
      }
    } catch {
      setMsg("できない");
    }
  };

  const isLeader = shop?.myRole === "king" || shop?.myRole === "minister";
  const myPlot = shop?.plots.find((p) => p && p.guildId === shop.myGuildId) ?? null;
  const myItems = profile
    ? Object.entries(profile.items).filter(([, n]) => n > 0)
    : [];

  return (
    <div style={panelStyle} role="dialog" aria-label="ギルドショップ" className="wb-panel">
      <div
        style={{
          display: "flex", alignItems: "center", gap: 8,
          position: "sticky", top: -12, zIndex: 3,
          margin: "-12px -14px 0", padding: "12px 14px 8px",
          background: "rgba(16,20,18,0.98)",
        }}
      >
        <strong style={{ fontSize: 15 }}>ギルドショップ</strong>
        <span style={{ flex: 1 }} />
        <button type="button" style={btn} onClick={onClose}>閉じる</button>
      </div>
      {!shop ? (
        <p style={{ fontSize: 13, opacity: 0.75 }}>…</p>
      ) : (
        <>
          <div style={{ display: "grid", gap: 10, marginTop: 10 }}>
            {shop.plots.map((plot, idx) => (
              <div key={idx} style={{ borderTop: "1px solid rgba(255,255,255,0.14)", paddingTop: 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                  <strong>区画{idx + 1}</strong>
                  {plot ? (
                    <span>{plot.guildName}</span>
                  ) : (
                    <>
                      <span style={{ opacity: 0.7 }}>空き</span>
                      {isLeader && !myPlot && (
                        <button type="button" style={btn} onClick={() => { void post({ action: "register", plotIdx: idx }); }}>
                          借りる（{shop.plotFee}）
                        </button>
                      )}
                    </>
                  )}
                  {plot && myPlot && plot.idx === myPlot.idx && isLeader && (
                    <button type="button" style={btn} onClick={() => { void post({ action: "unregister" }); }}>
                      撤去
                    </button>
                  )}
                </div>
                {plot && plot.listings.filter((l) => l.available > 0).length === 0 && (
                  <div style={{ fontSize: 12, opacity: 0.65, marginTop: 4 }}>出品なし</div>
                )}
                {plot && plot.listings.filter((l) => l.available > 0).length > 0 && (
                  <div style={{ marginTop: 6 }}>
                    <ItemSlotGrid>
                      {plot.listings.filter((l) => l.available > 0).map((l) => (
                        <ItemSlot
                          key={l.id}
                          itemId={l.itemId}
                          count={l.available}
                          badge={`${l.price}`}
                          selected={listSel === l.id}
                          onClick={() => setListSel(l.id)}
                        />
                      ))}
                    </ItemSlotGrid>
                    {(() => {
                      const sel = plot.listings.find((l) => l.id === listSel && l.available > 0);
                      if (!sel) return null;
                      return (
                        <ItemAnnotation itemId={sel.itemId}>
                          <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
                            <button type="button" style={btn} onClick={() => { void post({ action: "buy", listingId: sel.id, count: 1 }); }}>
                              買う（{sel.price}）
                            </button>
                            {(sel.mine || (isLeader && shop.myGuildId === plot.guildId)) && (
                              <button type="button" style={btn} onClick={() => { void post({ action: "unlist", listingId: sel.id }); }}>
                                下げる
                              </button>
                            )}
                          </div>
                        </ItemAnnotation>
                      );
                    })()}
                  </div>
                )}
              </div>
            ))}
          </div>
          {myPlot && (
            <div style={{ borderTop: "1px solid rgba(255,255,255,0.14)", marginTop: 10, paddingTop: 8 }}>
              <strong style={{ fontSize: 13 }}>出品する</strong>
              <div style={{ marginTop: 6 }}>
                <ItemSlotGrid>
                  {myItems.map(([itemId, n]) => (
                    <ItemSlot
                      key={itemId}
                      itemId={itemId}
                      count={n}
                      selected={sellItemId === itemId}
                      onClick={() => setSellItemId(itemId)}
                    />
                  ))}
                </ItemSlotGrid>
              </div>
              <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
                <input type="number" min={1} max={999} value={sellCount} onChange={(e) => setSellCount(Number(e.target.value))} style={{ ...input, width: 64 }} aria-label="個数" />
                <input type="number" min={1} value={sellPrice} onChange={(e) => setSellPrice(Number(e.target.value))} style={{ ...input, width: 84 }} aria-label="価格" />
                <button
                  type="button"
                  style={btn}
                  disabled={!sellItemId}
                  onClick={() => { void post({ action: "list", itemId: sellItemId, count: sellCount, price: sellPrice }); }}
                >
                  出品
                </button>
              </div>
            </div>
          )}
          {msg && <p role="status" style={{ margin: "10px 0 0", fontSize: 13 }}>{msg}</p>}
        </>
      )}
    </div>
  );
}
