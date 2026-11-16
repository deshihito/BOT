"use client";
// AGO WORLD BOX の経済パネル（かばん・ショップ・合成・銀行）。
// 売買・合成・送金は場所制約つき: それぞれの施設の前にいる間だけタブが出る。
// Discord ボット側の経済機能（items / workshop craft）の規則をそのまま使い、
// かばん・空腹度は /api/worldbox/profile が正とする。
// steal は一旦廃止（2026-11-16）: タブ・ルート・オプ生成・ワーカー適用の
// すべてで止めてある（履歴表示のラベルだけ残る）。
// 労働も廃止（2026-11-16）: ボタン・ルート・earn 許可リストから外してある。
// コインの正は AGO コイン本体: 残高と移動履歴は経済ブリッジ
// （/api/worldbox/economy）が返し、移動は Bot 本体が数十秒で適用する。
import { useCallback, useEffect, useRef, useState } from "react";
import type { EconomyOp } from "@/lib/worldbox/economy-bridge";
import { onEconomyApplied } from "@/lib/worldbox/economy-push";
import { ITEMS, RECIPES, itemById, sellPrice } from "@/lib/worldbox/items";
import { dailyPriceFor, dailyStockForGenre, genreById, isShopExcluded, itemsForGenre, shopDayKeyOf, type ShopGenreId } from "@/lib/worldbox/shops";
import type { LobbyStation } from "@/lib/worldbox/lobby";
import { ENHANCE_BASE_COST, ENHANCE_MATERIALS, ENHANCE_MAX_LEVEL, type PlayerProfile } from "@/lib/worldbox/profile";
import type { SaveSpace } from "@/lib/worldbox/save";
import { playWbSe, type WbSeName } from "@/lib/worldbox/sound";

/** 経済アクションの成功音（行為の意味で選ぶ）。 */
const ACTION_SE: Record<string, WbSeName> = {
  buy: "buy",
  sell: "sell",
  craft: "craft",
  eat: "harvest",
};

type Tab = "bag" | "shop" | "craft" | "bank";
type LoadState = "loading" | "ready" | "guest" | "unavailable";

const ERROR_LABEL: Record<string, string> = {
  not_enough_coins: "コインが足りません",
  not_enough_items: "アイテムが足りません",
  hunger_full: "もう満腹です",
  work_disabled: "労働は廃止されました",
  steal_disabled: "steal は廃止されました",
  unauthorized: "ログインが必要です",
  discord_required: "コインの移動には Discord ログインが必要です",
  economy_unavailable: "いま経済ブリッジを使えません",
  economy_failed: "コインの移動を受け付けられませんでした",
  invalid_recipient: "相手のIDが不正です",
  self_transfer: "自分には送れません",
  invalid_amount: "金額が不正です",
  not_at_shop: "ショップの前にいません",
  wrong_shop: "この店では買えません",
  not_sold: "販売していません",
  not_at_workbench: "作業台の前にいません",
  not_at_bank: "銀行の前にいません",
};

const OP_KIND_LABEL: Record<EconomyOp["kind"], string> = {
  spend: "支払い",
  earn: "受取",
  transfer: "送金",
  steal: "steal",
  gamble: "カジノ",
};
const OP_STATUS_LABEL: Record<EconomyOp["status"], string> = {
  pending: "処理中",
  done: "完了",
  failed: "失敗",
};

/** 経済パネルもゲームステージ内のオーバーレイ（クライアント側 panelOverlay と同値）。 */
const panel: React.CSSProperties = {
  position: "absolute", left: "50%", top: "50%", transform: "translate(-50%, -50%)",
  width: "min(600px, calc(100% - 20px))", maxHeight: "calc(100% - 20px)", overflowY: "auto",
  overscrollBehavior: "contain", touchAction: "pan-y",
  padding: 12, borderRadius: 12, zIndex: 6, textAlign: "left",
  border: "1px solid rgba(255,255,255,0.22)", background: "rgba(10,12,18,0.93)", color: "#f2f2f2",
  boxShadow: "0 12px 36px rgba(0,0,0,0.5)",
};
const btn: React.CSSProperties = {
  minHeight: 36, padding: "4px 12px", borderRadius: 10, cursor: "pointer",
  border: "1px solid rgba(255,255,255,0.25)", background: "rgba(255,255,255,0.06)", color: "inherit",
  touchAction: "manipulation", userSelect: "none", WebkitUserSelect: "none", WebkitTouchCallout: "none",
};
const row: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
  padding: "7px 0", borderBottom: "1px solid rgba(255,255,255,0.08)",
};

/** アイテムのドット絵アイコン（無いアイテムは名前ラベルのみで出す）。 */
function ItemIcon({ id, size = 24 }: { id: string; size?: number }) {
  const def = itemById(id);
  if (!def?.icon) return null;
  return (
    <img
      src={def.icon}
      alt=""
      width={size}
      height={size}
      draggable={false}
      style={{ imageRendering: "pixelated", flexShrink: 0 }}
    />
  );
}

export default function WorldBoxEconomyPanel({ space, station, genre, onClose }: { space: SaveSpace; station: LobbyStation | null; genre: ShopGenreId | null; onClose: () => void }) {
  // 行動の場所制約: 売買はショップの前、合成は作業台（鍛冶屋）の前、
  // 送金は銀行の前でのみ。いる場所に対応するタブだけを出す（サーバー側
  // でもプレゼンスで検証されるため、ここは表示の一致が役割）。
  const inLobby = space === "lobby";
  // 売買は店と鍛冶屋の両方で可。品目は店ごとのジャンルで選別される
  // （鍛冶屋はジャンル "smith"）。ジャンルが無い店は全品目。
  const shopGenre: ShopGenreId | null = station === "smith" ? "smith" : genre;
  const atShop = inLobby && (station === "shop" || station === "smith");
  const atWorkbench = space !== "world" && station === "smith";
  const atBank = inLobby && station === "bank";
  const [profile, setProfile] = useState<PlayerProfile | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [tab, setTab] = useState<Tab>("bag");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [balance, setBalance] = useState<number | null>(null);
  const [ops, setOps] = useState<EconomyOp[]>([]);
  const [transferTo, setTransferTo] = useState("");
  const [transferAmount, setTransferAmount] = useState("");
  const aliveRef = useRef(true);

  const refreshBridge = useCallback(async () => {
    try {
      const res = await fetch("/api/worldbox/economy", { headers: { Accept: "application/json" } });
      if (!res.ok) return;
      const data = (await res.json()) as { balance: number; ops: EconomyOp[] };
      if (aliveRef.current) {
        setBalance(data.balance);
        setOps(Array.isArray(data.ops) ? data.ops : []);
      }
    } catch { /* ブリッジが読めなくても他の機能は使える */ }
  }, []);

  const refreshProfile = useCallback(async () => {
    try {
      const res = await fetch("/api/worldbox/profile", { headers: { Accept: "application/json" } });
      if (res.status === 401) {
        if (aliveRef.current) setLoadState("guest");
        return;
      }
      if (!res.ok) {
        if (aliveRef.current) setLoadState("unavailable");
        return;
      }
      const data = (await res.json()) as { profile: PlayerProfile };
      if (aliveRef.current) {
        setProfile(data.profile);
        setLoadState("ready");
      }
    } catch {
      if (aliveRef.current) setLoadState("unavailable");
    }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    void refreshProfile();
    void refreshBridge();
    // 経済オプ確定の push で残高・履歴を即時更新する
    const off = onEconomyApplied(() => { void refreshProfile(); void refreshBridge(); });
    return () => {
      aliveRef.current = false;
      off();
    };
  }, [refreshProfile, refreshBridge]);

  const act = async (payload: Record<string, unknown>, describe: (data: Record<string, unknown>) => string) => {
    setBusy(true);
    setMsg("");
    try {
      const res = await fetch("/api/worldbox/profile", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown> & {
        profile?: PlayerProfile; error?: string;
      };
      if (!res.ok || !data.profile) {
        setMsg(ERROR_LABEL[data.error ?? ""] ?? "できませんでした");
        return;
      }
      setProfile(data.profile);
      setMsg(describe(data));
      const se = ACTION_SE[String(payload.action ?? "")];
      if (se) playWbSe(se);
      void refreshBridge();
    } catch {
      setMsg("できませんでした");
    } finally {
      setBusy(false);
    }
  };

  const sendTransfer = async () => {
    setBusy(true);
    setMsg("");
    try {
      const res = await fetch("/api/worldbox/economy", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ action: "transfer", toDiscordId: transferTo.trim(), amount: Number(transferAmount) }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setMsg(ERROR_LABEL[data.error ?? ""] ?? "送金を受け付けられませんでした");
        return;
      }
      setTransferTo("");
      setTransferAmount("");
      setMsg("送金を受け付けました");
      playWbSe("coin");
      void refreshBridge();
    } catch {
      setMsg("送金を受け付けられませんでした");
    } finally {
      setBusy(false);
    }
  };

  const closeBtn = (
    <button type="button" style={btn} onClick={onClose}>
      閉じる
    </button>
  );
  const panelHead = (text: string) => (
    <div style={panel} className="wb-panel">
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span>{text}</span>
        <span style={{ flex: 1 }} />
        {closeBtn}
      </div>
    </div>
  );
  if (loadState === "loading") return panelHead("読み込み中…");
  if (loadState === "guest") {
    return panelHead("経済機能（かばん・ショップ・合成）を使うにはログインが必要です。");
  }
  if (loadState === "unavailable" || !profile) {
    return panelHead("いまは経済機能を使えません。");
  }

  const owned = ITEMS.filter((item) => (profile.items[item.id] ?? 0) > 0);
  // この店で売られている品目（ジャンル選別。販売はホワイトリスト86品のみ）
  // 品目と価格は日次ローテーション（サーバー側の購入検証と同じ式）
  const shopDayKey = shopDayKeyOf(Date.now());
  const shopItems = shopGenre ? dailyStockForGenre(shopGenre, shopDayKey) : ITEMS.filter((item) => !isShopExcluded(item));
  const priceOf = (item: (typeof ITEMS)[number]): number =>
    shopGenre ? dailyPriceFor(item, shopDayKey) : item.price;
  // 施設の前にいないタブを開いたままにしない（その施設へ行くと使える）
  // 販売品目の無い店（鍛冶屋は合成・強化専用）ではショップタブ自体を出さない
  const tabAllowed = (t: Tab): boolean =>
    t === "shop" ? atShop && shopItems.length > 0 : t === "craft" ? atWorkbench : t === "bank" ? atBank : true;
  const activeTab: Tab = tabAllowed(tab) ? tab : "bag";
  const tabBtn = (t: Tab, label: string) => (
    <button
      type="button"
      style={{ ...btn, ...(activeTab === t ? { background: "rgba(255,210,62,0.18)", borderColor: "rgba(255,210,62,0.55)" } : {}) }}
      onClick={() => setTab(t)}
      aria-pressed={activeTab === t}
    >
      {label}
    </button>
  );

  return (
    <div style={panel} className="wb-panel">
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <strong>経済</strong>
        <span>残高 <strong>{balance === null ? "—" : balance}</strong> コイン</span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          空腹度
          <span style={{ width: 90, height: 10, borderRadius: 5, background: "rgba(255,255,255,0.12)", overflow: "hidden", display: "inline-block" }}>
            <span style={{ display: "block", width: `${profile.hunger}%`, height: "100%", background: profile.hunger <= 20 ? "#ff7a59" : "#ffd23e" }} />
          </span>
          <strong>{Math.floor(profile.hunger)}</strong>
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          HP
          <span style={{ width: 90, height: 10, borderRadius: 5, background: "rgba(255,255,255,0.12)", overflow: "hidden", display: "inline-block" }}>
            <span style={{ display: "block", width: `${profile.hp}%`, height: "100%", background: profile.hp <= 25 ? "#e2483a" : "#7ed957" }} />
          </span>
          <strong>{Math.floor(profile.hp)}</strong>
        </span>
        {profile.status.some((e) => e.kind === "poison") && <span style={{ color: "#b6f26d" }}>毒</span>}
        <span style={{ flex: 1 }} />
        {closeBtn}
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
        {tabBtn("bag", "かばん")}
        {atShop && shopItems.length > 0 && tabBtn("shop", shopGenre ? (genreById(shopGenre)?.name ?? "ショップ") : "ショップ")}
        {atWorkbench && tabBtn("craft", "合成")}
        {atBank && tabBtn("bank", "銀行")}
      </div>
      {activeTab === "bag" && (
        <div style={{ marginTop: 6 }}>
          {owned.length === 0 && <p className="muted">かばんは空です</p>}
          {owned.map((item) => (
            <div key={item.id} style={row}>
              <ItemIcon id={item.id} />
              <strong>{item.name}</strong>
              <span className="muted">× {profile.items[item.id]}</span>
              <span className="muted">{item.desc}</span>
              <span style={{ flex: 1 }} />
              {(item.hunger || item.heal || item.curePoison) && (
                <button type="button" style={btn} disabled={busy}
                  onClick={() => void act({ action: "eat", itemId: item.id }, () => `${item.name}を使った`)}>
                  {item.heal && !item.hunger ? "使う" : "食べる"}
                  {item.hunger ? `（空腹+${item.hunger}` : ""}
                  {item.heal ? `${item.hunger ? "・" : "（"}HP+${item.heal}` : ""}
                  {item.curePoison ? "・解毒" : ""}
                  {(item.hunger || item.heal) ? "）" : ""}
                </button>
              )}
              {atShop && (
                <button type="button" style={btn} disabled={busy}
                  onClick={() => void act({ action: "sell", itemId: item.id }, () => `${item.name}を売った（代金 ${sellPrice(item)} コインは処理中）`)}>
                  売る（{sellPrice(item)}）
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {activeTab === "shop" && atShop && (
        <div style={{ marginTop: 6 }}>
          {shopItems.map((item) => (
            <div key={item.id} style={row}>
              <ItemIcon id={item.id} />
              <strong>{item.name}</strong>
              <span className="muted">{item.desc}</span>
              {item.hunger ? <span className="muted">空腹度 +{item.hunger}</span> : null}
              <span style={{ flex: 1 }} />
              <span>{priceOf(item)} コイン</span>
              <button type="button" style={btn} disabled={busy}
                onClick={() => void act({ action: "buy", itemId: item.id }, () => `${item.name}を買った`)}>
                買う
              </button>
            </div>
          ))}
        </div>
      )}

      {activeTab === "craft" && (
        <div style={{ marginTop: 6 }}>
          {RECIPES.map((recipe) => {
            const output = itemById(recipe.output);
            const inputs = Object.entries(recipe.inputs)
              .map(([id, n]) => `${itemById(id)?.name ?? id}×${n}（所持 ${profile.items[id] ?? 0}）`)
              .join(" + ");
            return (
              <div key={recipe.id} style={row}>
                <ItemIcon id={recipe.output} />
                <strong>{output?.name ?? recipe.output}</strong>
                <span className="muted">{inputs}</span>
                {recipe.rareItem && <span className="muted">レア: {itemById(recipe.rareItem)?.name}</span>}
                <span style={{ flex: 1 }} />
                <button type="button" style={btn} disabled={busy}
                  onClick={() => void act(
                    { action: "craft", recipeId: recipe.id },
                    (data) => `${output?.name ?? "アイテム"}を作った${data.rareId ? `（レア: ${itemById(data.rareId as string)?.name}も手に入れた！）` : ""}`,
                  )}>
                  合成する
                </button>
              </div>
            );
          })}
        </div>
      )}

      {activeTab === "craft" && (
        <div style={{ marginTop: 10, borderTop: "1px solid rgba(255,255,255,0.14)", paddingTop: 8 }}>
          <strong style={{ fontSize: 13 }}>道具の強化</strong>
          {Object.entries(profile.items)
            .filter(([itemId, n]) => n > 0 && itemById(itemId)?.tool)
            .map(([itemId]) => {
              const def = itemById(itemId);
              const level = profile.enhance[itemId] ?? 0;
              const material = def?.tier ? ENHANCE_MATERIALS[def.tier] : undefined;
              return (
                <div key={itemId} style={row}>
                  <ItemIcon id={itemId} />
                  <strong>{def?.name ?? itemId}</strong>
                  <span className="muted">{"+".repeat(level) || "未強化"}</span>
                  {material && level < ENHANCE_MAX_LEVEL && (
                    <span className="muted">
                      {itemById(material.itemId)?.name}×{material.count}（所持 {profile.items[material.itemId] ?? 0}）+ {ENHANCE_BASE_COST * (level + 1)}
                    </span>
                  )}
                  <span style={{ flex: 1 }} />
                  {level < ENHANCE_MAX_LEVEL ? (
                    <button type="button" style={btn} disabled={busy}
                      onClick={() => void act({ action: "enhance", itemId }, () => `${def?.name ?? "道具"}を強化した`)}>
                      強化する
                    </button>
                  ) : (
                    <span className="muted">最大</span>
                  )}
                </div>
              );
            })}
        </div>
      )}

      {activeTab === "bank" && (
        <div style={{ marginTop: 6 }}>
          <div style={row}>
            <strong>送金</strong>
            <input
              type="text"
              inputMode="numeric"
              placeholder="相手の Discord ID"
              value={transferTo}
              onChange={(e) => setTransferTo(e.target.value)}
              style={{ flex: "1 1 160px", minHeight: 36, padding: "4px 8px", borderRadius: 8, border: "1px solid rgba(255,255,255,0.25)", background: "rgba(255,255,255,0.06)", color: "inherit" }}
            />
            <input
              type="number"
              min={1}
              placeholder="金額"
              value={transferAmount}
              onChange={(e) => setTransferAmount(e.target.value)}
              style={{ width: 110, minHeight: 36, padding: "4px 8px", borderRadius: 8, border: "1px solid rgba(255,255,255,0.25)", background: "rgba(255,255,255,0.06)", color: "inherit" }}
            />
            <button type="button" style={btn} disabled={busy} onClick={() => void sendTransfer()}>
              送金する
            </button>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
            <strong>履歴</strong>
            <button type="button" style={btn} disabled={busy} onClick={() => void refreshBridge()}>
              更新
            </button>
          </div>
          {ops.length === 0 && <p className="muted">まだコインの移動はありません。</p>}
          {ops.map((op) => (
            <div key={op.id} style={row}>
              <strong>{OP_KIND_LABEL[op.kind]}</strong>
              <span className="muted">{op.reason}</span>
              <span style={{ flex: 1 }} />
              <span>{op.appliedAmount ?? op.amount} コイン</span>
              <span className="muted">{OP_STATUS_LABEL[op.status]}</span>
            </div>
          ))}
        </div>
      )}

      {msg && <p role="status" style={{ margin: "10px 0 0" }}>{msg}</p>}
    </div>
  );
}
