"use client";
// AGO WORLD BOX の経済パネル（かばん・ショップ・合成・銀行）。
// 売買・合成・送金は場所制約つき: それぞれの施設の前にいる間だけタブが出る。
// 売却は売却専用カウンター（station "sell"）の売却タブに一本化した:
// かばんには売却ボタンを置かない（ショップでかばんを開く手順をなくす）。
// Discord ボット側の経済機能（items / workshop craft）の規則をそのまま使い、
// かばん・空腹度は /api/worldbox/profile が正とする。
// steal は 2026-11-16 に一旦廃止したが、2026-11-18 のユーザー指示で
// 復活した（入口はこのパネルの steal タブ → profile ルートのみ）。
// 労働も廃止（2026-11-16）: ボタン・ルート・earn 許可リストから外してある。
// コインの正は AGO コイン本体: 残高と移動履歴は経済ブリッジ
// （/api/worldbox/economy）が返し、移動は Bot 本体が数十秒で適用する。
import { useCallback, useEffect, useRef, useState } from "react";
import type { EconomyOp } from "@/lib/worldbox/economy-bridge";
import { onEconomyApplied } from "@/lib/worldbox/economy-push";
import { ITEMS, itemById, recipeById, sellPrice } from "@/lib/worldbox/items";
import type { StationKind } from "@/lib/worldbox/tiles";
import { dailyPriceFor, dailyStockForGenre, genreById, isShopExcluded, itemsForGenre, shopDayKeyOf, type ShopGenreId } from "@/lib/worldbox/shops";
import type { LobbyStation } from "@/lib/worldbox/lobby";
import { ENHANCE_BASE_COST, ENHANCE_MATERIALS, ENHANCE_MAX_LEVEL, type PlayerProfile } from "@/lib/worldbox/profile";
import { quoteBuyTokens, quoteSellAga } from "@/lib/worldbox/market";
import type { SaveSpace } from "@/lib/worldbox/save";
import { playWbSe, type WbSeName } from "@/lib/worldbox/sound";
import { ItemAnnotation, ItemIcon, ItemSlot, ItemSlotGrid } from "./ItemSlotGrid";

/** 経済アクションの成功音（行為の意味で選ぶ）。 */
const ACTION_SE: Record<string, WbSeName> = {
  buy: "buy",
  sell: "sell",
  craft: "craft",
  eat: "harvest",
  enhance: "success",
  steal: "coin",
  token_buy: "coin",
  token_sell: "coin",
  token_convert: "coin",
};

type Tab = "bag" | "shop" | "sell" | "craft" | "steal" | "bank" | "exchange";
type LoadState = "loading" | "ready" | "guest" | "unavailable";
type StealTarget = { id: string; name: string };
type TokenInfo = {
  available: boolean;
  rate?: number;
  prevRate?: number;
  history?: { t: string; rate: number }[];
  halted?: boolean;
  haltReason?: string;
  tradeCapAga?: number;
  balance?: number;
  updatedAt?: string;
};

const ERROR_LABEL: Record<string, string> = {
  not_enough_coins: "コインが足りません",
  not_enough_items: "アイテムが足りません",
  hunger_full: "もう満腹です",
  work_disabled: "労働は廃止されました",
  steal_cooldown: "steal はクールダウン中です",
  target_protected: "その相手からは盗めません",
  target_recently_stolen: "その相手は最近盗まれたばかりで保護されています",
  self_target: "自分からは盗めません",
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
  not_at_exchange: "取引所の前にいません",
  trade_pending: "取引を確認中です。少し待って残高を見てください",
  not_sellable: "取引所でのみ売れます",
  position_unknown: "位置が分かりません",
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

/** 素材 id から決定的に色相を出す（同じ素材は常に同じ色。ランダムは使わない）。 */
function hueForItem(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return h;
}

/** セットした素材の色を個数で重み付けして混ぜた、台の液体/煙の色。 */
function mixColorFor(set: Record<string, number>): { liquid: string; smoke: string } {
  const entries = Object.entries(set);
  if (entries.length === 0) {
    return { liquid: "rgba(120,130,150,0.5)", smoke: "rgba(160,165,175,0.35)" };
  }
  let x = 0;
  let y = 0;
  for (const [id, n] of entries) {
    const rad = (hueForItem(id) * Math.PI) / 180;
    x += Math.cos(rad) * n;
    y += Math.sin(rad) * n;
  }
  const hue = Math.round(((Math.atan2(y, x) * 180) / Math.PI + 360) % 360);
  return {
    liquid: `hsla(${hue}, 65%, 50%, 0.85)`,
    smoke: `hsla(${hue}, 45%, 65%, 0.45)`,
  };
}

export default function WorldBoxEconomyPanel({ space, station, genre, worldStationKinds, onClose }: { space: SaveSpace; station: LobbyStation | null; genre: ShopGenreId | null; worldStationKinds?: string; onClose: () => void }) {
  // 行動の場所制約: 売買はショップの前、合成は作業台（鍛冶屋）の前、
  // 送金は銀行の前でのみ。いる場所に対応するタブだけを出す（サーバー側
  // でもプレゼンスで検証されるため、ここは表示の一致が役割）。
  const inLobby = space === "lobby";
  // 売買は店と鍛冶屋の両方で可。品目は店ごとのジャンルで選別される
  // （鍛冶屋はジャンル "smith"）。ジャンルが無い店は全品目。
  const shopGenre: ShopGenreId | null = station === "smith" ? "smith" : genre;
  const atShop = inLobby && (station === "shop" || station === "smith");
  // 売却専用カウンター（買取）: 売るだけの店。開いたら売却タブが既定で、
  // かばんを開く手順は挟まない（売却はここに一本化し、かばんからは外した）
  const atSellShop = inLobby && station === "sell";
  // ロビーの鍛冶屋は全種別可。ワールドでは設置した作業施設の種別だけ可
  const atLobbySmith = space !== "world" && station === "smith";
  const worldKinds = new Set((worldStationKinds ?? "").split(",").filter(Boolean));
  const canWork = (kind: StationKind) => atLobbySmith || worldKinds.has(kind);
  const atWorkbench = atLobbySmith || worldKinds.size > 0;
  const atBank = inLobby && station === "bank";
  const atExchange = inLobby && station === "exchange";
  const [profile, setProfile] = useState<PlayerProfile | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [tab, setTab] = useState<Tab>("bag");
  const [targets, setTargets] = useState<StealTarget[]>([]);
  const [tokenInfo, setTokenInfo] = useState<TokenInfo | null>(null);
  const [buyAga, setBuyAga] = useState("1000");
  const [sellTokens, setSellTokens] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [balance, setBalance] = useState<number | null>(null);
  const [ops, setOps] = useState<EconomyOp[]>([]);
  const [transferTo, setTransferTo] = useState("");
  const [transferAmount, setTransferAmount] = useState("");
  // かばん/ショップのスロット選択（注釈は選択中アイテムのものだけ出す）
  const [bagSel, setBagSel] = useState<string | null>(null);
  const [dropCount, setDropCount] = useState("1");
  const [shopSel, setShopSel] = useState<string | null>(null);
  const [sellSel, setSellSel] = useState<string | null>(null);
  // 強化のスロット選択と成功フラッシュ（金色背景 → 透明へ transition）
  const [enhanceSel, setEnhanceSel] = useState<string | null>(null);
  const [enhanceFlashId, setEnhanceFlashId] = useState<string | null>(null);
  const [enhanceFlashOn, setEnhanceFlashOn] = useState(false);
  const enhanceFlashTimersRef = useRef<number[]>([]);
  // 合成台（PR-B）: セットした素材（id → 個数）、工程の進捗、気配、出現した成果物
  const [craftSet, setCraftSet] = useState<Record<string, number>>({});
  const [craftBusy, setCraftBusy] = useState(false);
  const [craftPhase, setCraftPhase] = useState(0);
  const [craftHint, setCraftHint] = useState<"exact" | "near" | "far" | null>(null);
  const [craftResult, setCraftResult] = useState<string | null>(null);
  const [craftResultKey, setCraftResultKey] = useState(0);
  const [discSel, setDiscSel] = useState<string | null>(null);
  const craftTimerRef = useRef<number | null>(null);
  const aliveRef = useRef(true);

  // 売却専用カウンターの前にいる間は売却タブを既定にする
  useEffect(() => {
    if (atSellShop) setTab("sell");
  }, [atSellShop]);

  // 取引所の前にいる間は取引所タブを既定にする
  useEffect(() => {
    if (atExchange) setTab("exchange");
  }, [atExchange]);

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

  const refreshTargets = useCallback(async () => {
    try {
      const res = await fetch(`/api/worldbox/presence?space=${encodeURIComponent(space)}`, {
        headers: { Accept: "application/json" },
      });
      if (!res.ok) return;
      const data = (await res.json()) as { players?: StealTarget[] };
      if (aliveRef.current && Array.isArray(data.players)) {
        setTargets(data.players.map((p) => ({ id: p.id, name: p.name })));
      }
    } catch { /* 対象が読めなくても他の機能は使える */ }
  }, [space]);

  const refreshToken = useCallback(async () => {
    try {
      const res = await fetch("/api/worldbox/exchange", { headers: { Accept: "application/json" } });
      if (!res.ok) return;
      const data = (await res.json()) as TokenInfo;
      if (aliveRef.current) setTokenInfo(data);
    } catch { /* 価格が読めなくても他の機能は使える */ }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    void refreshProfile();
    void refreshBridge();
    void refreshTargets();
    void refreshToken();
    // 経済オプ確定の push で残高・履歴を即時更新する
    const off = onEconomyApplied(() => { void refreshProfile(); void refreshBridge(); });
    return () => {
      aliveRef.current = false;
      off();
      if (craftTimerRef.current !== null) window.clearInterval(craftTimerRef.current);
      craftTimerRef.current = null;
      for (const t of enhanceFlashTimersRef.current) window.clearTimeout(t);
      enhanceFlashTimersRef.current = [];
    };
  }, [refreshProfile, refreshBridge, refreshTargets, refreshToken]);

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
        profile?: PlayerProfile; error?: string; message?: string;
      };
      if (!res.ok || !data.profile) {
        setMsg(
          data.error === "market_trade_failed" && typeof data.message === "string"
            ? data.message
            : ERROR_LABEL[data.error ?? ""] ?? "できませんでした",
        );
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

  /**
   * 強化成功時の金色フラッシュ。act の describe（成功時にだけ呼ばれる）
   * から呼ぶことで成否に連動させる。背景を金色で点灯させた直後に
   * 透明へ戻し、約600ms の transition で消えるようにする。
   */
  const triggerEnhanceFlash = (itemId: string) => {
    for (const t of enhanceFlashTimersRef.current) window.clearTimeout(t);
    enhanceFlashTimersRef.current = [];
    setEnhanceFlashId(itemId);
    setEnhanceFlashOn(true);
    enhanceFlashTimersRef.current.push(
      window.setTimeout(() => { if (aliveRef.current) setEnhanceFlashOn(false); }, 30),
      window.setTimeout(() => { if (aliveRef.current) setEnhanceFlashId(null); }, 700),
    );
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

  // ---- 合成台（PR-B） -------------------------------------------------
  /** かばんの素材を台へ1個セットする（1種6個まで・4種まで・所持数まで）。 */
  const addToCraft = (itemId: string) => {
    if (craftBusy || !profile) return;
    setCraftResult(null);
    setCraftSet((prev) => {
      const cur = prev[itemId] ?? 0;
      if (cur >= 6) return prev;
      if (!(itemId in prev) && Object.keys(prev).length >= 4) return prev;
      if (cur + 1 > (profile.items[itemId] ?? 0)) return prev;
      return { ...prev, [itemId]: cur + 1 };
    });
  };
  /** 台の素材を1個かばんへ戻す。 */
  const removeFromCraft = (itemId: string) => {
    if (craftBusy) return;
    setCraftSet((prev) => {
      const cur = prev[itemId] ?? 0;
      if (cur <= 0) return prev;
      const next = { ...prev };
      if (cur === 1) delete next[itemId];
      else next[itemId] = cur - 1;
      return next;
    });
  };
  /** 工程が終わった瞬間に初めて結果を反映し、成果物を台の上に出現させる。 */
  const finishCraft = (pending: { profile: PlayerProfile; craftedId: string; rareId: string | null }) => {
    setProfile(pending.profile);
    setCraftSet({});
    setCraftPhase(0);
    setCraftBusy(false);
    setBusy(false);
    setCraftResult(pending.craftedId);
    setCraftResultKey((k) => k + 1);
    const name = itemById(pending.craftedId)?.name ?? "アイテム";
    const rareName = pending.rareId ? itemById(pending.rareId)?.name : null;
    setMsg(rareName ? `${name}ができた（${rareName}も）` : `${name}ができた`);
    playWbSe("success");
    void refreshBridge();
  };
  /**
   * 火を入れる: 結果は即表示しない。レスポンスの hint（気配）だけ保持し、
   * 約2.4秒の工程（煙・揺れ・進捗）を出したあとで初めて反映する。
   */
  const runCraft = async () => {
    const inputs = { ...craftSet };
    if (Object.keys(inputs).length === 0 || craftBusy) return;
    setCraftBusy(true);
    setBusy(true);
    setMsg("");
    setCraftResult(null);
    setCraftHint(null);
    setCraftPhase(0);
    playWbSe("craft");
    try {
      const res = await fetch("/api/worldbox/profile", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ action: "craft", inputs }),
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown> & {
        profile?: PlayerProfile; error?: string;
      };
      if (!res.ok || !data.profile) {
        setMsg(ERROR_LABEL[data.error ?? ""] ?? "できませんでした");
        setCraftBusy(false);
        setBusy(false);
        return;
      }
      setCraftHint(data.hint === "exact" || data.hint === "near" || data.hint === "far" ? data.hint : null);
      const pending = {
        profile: data.profile,
        craftedId: typeof data.craftedId === "string" ? data.craftedId : "mystery_lump",
        rareId: typeof data.rareId === "string" ? data.rareId : null,
      };
      const startedAt = Date.now();
      craftTimerRef.current = window.setInterval(() => {
        const p = Math.min(1, (Date.now() - startedAt) / 2400);
        setCraftPhase(p);
        if (p >= 1) {
          if (craftTimerRef.current !== null) window.clearInterval(craftTimerRef.current);
          craftTimerRef.current = null;
          if (aliveRef.current) finishCraft(pending);
        }
      }, 80);
    } catch {
      setMsg("できませんでした");
      setCraftBusy(false);
      setBusy(false);
    }
  };

  const closeBtn = (
    <button type="button" style={btn} onClick={onClose}>
      閉じる
    </button>
  );
  const panelHead = (text: string) => (
    <div style={panel} className="wb-panel" data-wb-se="self">
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
  // 選択中アイテム（所持/品目から消えていたら注釈を出さない）
  const bagSelItem = owned.find((item) => item.id === bagSel) ?? null;
  const shopSelItem = shopItems.find((item) => item.id === shopSel) ?? null;
  const sellSelItem = owned.find((item) => item.id === sellSel) ?? null;
  // 強化対象: 所持している道具だけ（従来の row リストと同じ対象）
  const enhanceTools = ITEMS.filter((item) => (profile.items[item.id] ?? 0) > 0 && item.tool);
  const enhanceSelItem = enhanceTools.find((item) => item.id === enhanceSel) ?? null;
  // 発見図鑑: 自分が完全一致で作れたレシピだけ（未発見のレシピは出さない）
  const discovered = (profile.discoveredRecipes ?? [])
    .map((id) => recipeById(id))
    .filter((r): r is NonNullable<typeof r> => r !== null);
  const discRecipe = discovered.find((r) => r.id === discSel) ?? null;
  // 施設の前にいないタブを開いたままにしない（その施設へ行くと使える）
  // 販売品目の無い店（鍛冶屋は合成・強化専用）ではショップタブ自体を出さない
  const tabAllowed = (t: Tab): boolean =>
    t === "shop" ? atShop && shopItems.length > 0 : t === "sell" ? atSellShop : t === "craft" ? atWorkbench : t === "bank" ? atBank : t === "exchange" ? atExchange : true;
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
    <div style={panel} className="wb-panel" data-wb-se="self">
      {/* ヘッダー（残高・タブ・閉じる）はスクロールに追随させず常時表示する。
          空腹度・HP はステージ左上の常時バーが正で、このパネルには出さない
          （ショップ利用中に要らない表示としてユーザー指示で撤去）。 */}
      <div
        style={{
          position: "sticky", top: -12, zIndex: 3,
          margin: "-12px -12px 0", padding: "12px 12px 8px",
          background: "rgba(10,12,18,0.98)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <strong>経済</strong>
          <span>残高 <strong>{balance === null ? "—" : balance}</strong> コイン</span>
          <span style={{ flex: 1 }} />
          {closeBtn}
        </div>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
          {tabBtn("bag", "かばん")}
          {atShop && shopItems.length > 0 && tabBtn("shop", shopGenre ? (genreById(shopGenre)?.name ?? "ショップ") : "ショップ")}
          {atSellShop && tabBtn("sell", "売却")}
          {atWorkbench && tabBtn("craft", "合成")}
          {tabBtn("steal", "steal")}
          {atExchange && tabBtn("exchange", "取引所")}
          {atBank && tabBtn("bank", "銀行")}
        </div>
      </div>
      {activeTab === "bag" && (
        <div style={{ marginTop: 6 }}>
          {owned.length === 0 && <p className="muted">かばんは空です</p>}
          <ItemSlotGrid>
            {owned.map((item) => (
              <ItemSlot
                key={item.id}
                itemId={item.id}
                count={profile.items[item.id]}
                selected={bagSel === item.id}
                onClick={() => setBagSel(item.id)}
              />
            ))}
          </ItemSlotGrid>
          {bagSelItem && (
            <ItemAnnotation itemId={bagSelItem.id}>
              {(bagSelItem.hunger || bagSelItem.heal || bagSelItem.curePoison) ? (
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 6 }}>
                  {bagSelItem.hunger ? <span className="muted">空腹+{bagSelItem.hunger}</span> : null}
                  {bagSelItem.heal ? <span className="muted">HP+{bagSelItem.heal}</span> : null}
                  {bagSelItem.curePoison ? <span className="muted">解毒</span> : null}
                </div>
              ) : null}
              {(bagSelItem.hunger || bagSelItem.heal || bagSelItem.curePoison) && (
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
                  <button type="button" style={btn} disabled={busy}
                    onClick={() => void act({ action: "eat", itemId: bagSelItem.id }, () => `${bagSelItem.name}を使った`)}>
                    {bagSelItem.heal && !bagSelItem.hunger ? "使う" : "食べる"}
                  </button>
                </div>
              )}
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8, alignItems: "center" }}>
                <input
                  type="number"
                  min={1}
                  max={99}
                  value={dropCount}
                  onChange={(e) => setDropCount(e.target.value)}
                  style={{ width: 64, minHeight: 36, padding: "4px 8px", borderRadius: 8, border: "1px solid rgba(255,255,255,0.25)", background: "rgba(255,255,255,0.06)", color: "inherit" }}
                />
                <button type="button" style={btn} disabled={busy}
                  onClick={() => void act(
                    { action: "drop", itemId: bagSelItem.id, count: Math.max(1, Math.floor(Number(dropCount) || 0)) },
                    () => `${bagSelItem.name}を捨てた`,
                  )}>
                  捨てる
                </button>
              </div>
            </ItemAnnotation>
          )}
        </div>
      )}

      {activeTab === "shop" && atShop && (
        <div style={{ marginTop: 6 }}>
          <ItemSlotGrid>
            {shopItems.map((item) => (
              <ItemSlot
                key={item.id}
                itemId={item.id}
                badge={`${priceOf(item)}`}
                selected={shopSel === item.id}
                onClick={() => setShopSel(item.id)}
              />
            ))}
          </ItemSlotGrid>
          {shopSelItem && (
            <ItemAnnotation itemId={shopSelItem.id}>
              {(shopSelItem.hunger || shopSelItem.heal || shopSelItem.curePoison) ? (
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 6 }}>
                  {shopSelItem.hunger ? <span className="muted">空腹度 +{shopSelItem.hunger}</span> : null}
                  {shopSelItem.heal ? <span className="muted">HP+{shopSelItem.heal}</span> : null}
                  {shopSelItem.curePoison ? <span className="muted">解毒</span> : null}
                </div>
              ) : null}
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
                <button type="button" style={btn} disabled={busy}
                  onClick={() => void act({ action: "buy", itemId: shopSelItem.id }, () => `${shopSelItem.name}を買った`)}>
                  買う（{priceOf(shopSelItem)} コイン）
                </button>
              </div>
            </ItemAnnotation>
          )}
        </div>
      )}

      {activeTab === "sell" && atSellShop && (
        <div style={{ marginTop: 6 }}>
          {owned.length === 0 && <p className="muted">売れるものがありません</p>}
          <ItemSlotGrid>
            {owned.map((item) => (
              <ItemSlot
                key={item.id}
                itemId={item.id}
                count={profile.items[item.id]}
                badge={`${sellPrice(item)}`}
                selected={sellSel === item.id}
                onClick={() => setSellSel(item.id)}
              />
            ))}
          </ItemSlotGrid>
          {sellSelItem && (
            <ItemAnnotation itemId={sellSelItem.id}>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
                <button type="button" style={btn} disabled={busy}
                  onClick={() => void act({ action: "sell", itemId: sellSelItem.id }, () => `${sellSelItem.name}を売った（代金 ${sellPrice(sellSelItem)} コインは処理中）`)}>
                  売る（{sellPrice(sellSelItem)}）
                </button>
              </div>
            </ItemAnnotation>
          )}
        </div>
      )}

      {activeTab === "craft" && (() => {
        const setEntries = Object.entries(craftSet);
        const totalSet = setEntries.reduce((a, [, n]) => a + n, 0);
        const mixed = mixColorFor(craftSet);
        // 工程中の煙は気配で変える（exact=金、near=暖色、far=灰色に濁る）
        const smokeColor = craftBusy
          ? craftHint === "exact"
            ? "rgba(255,210,62,0.8)"
            : craftHint === "near"
              ? "rgba(255,150,80,0.65)"
              : craftHint === "far"
                ? "rgba(125,125,130,0.6)"
                : mixed.smoke
          : mixed.smoke;
        return (
          <div style={{ marginTop: 6 }}>
            <style>{`@keyframes wbCraftPop { 0% { opacity: 0; transform: translateX(-50%) translateY(10px) scale(0.4); } 60% { opacity: 1; transform: translateX(-50%) translateY(-4px) scale(1.15); } 100% { opacity: 1; transform: translateX(-50%) translateY(0) scale(1); } } @keyframes wbCraftShake { 0%, 100% { transform: translateX(0); } 25% { transform: translateX(-2px); } 75% { transform: translateX(2px); } }`}</style>
            {/* 台: 煙/液体の表現エリア + 素材スロット4枠 + 成果物の出現 */}
            <div style={{ position: "relative", border: "1px solid rgba(255,255,255,0.14)", borderRadius: 12, padding: "10px 10px 12px", background: "rgba(255,255,255,0.03)", overflow: "hidden" }}>
              <div aria-hidden style={{ position: "relative", height: 64 }}>
                {[0, 1, 2].map((i) => (
                  <span
                    key={i}
                    style={{
                      position: "absolute", left: `${38 + i * 12}%`, bottom: 6,
                      width: 26 + i * 6, height: 26 + i * 6, borderRadius: "50%",
                      background: smokeColor, filter: "blur(6px)",
                      opacity: craftBusy ? 0.55 + craftPhase * 0.45 : totalSet > 0 ? 0.6 : 0.3,
                      transform: `translateY(${craftBusy ? -craftPhase * 22 - i * 4 : -i * 3}px) scale(${1 + (craftBusy ? craftPhase * 0.7 : 0) + i * 0.15})`,
                      transition: "background 0.4s, transform 0.3s, opacity 0.3s",
                    }}
                  />
                ))}
                <span
                  style={{
                    position: "absolute", left: "50%", bottom: 0, transform: "translateX(-50%)",
                    width: 150, height: 16, borderRadius: "50%", background: mixed.liquid,
                    transition: "background 0.4s",
                  }}
                />
                {craftResult && (
                  <span
                    key={craftResultKey}
                    style={{
                      position: "absolute", left: "50%", bottom: 10,
                      transform: "translateX(-50%)", animation: "wbCraftPop 0.45s ease-out",
                    }}
                  >
                    <ItemIcon id={craftResult} size={34} />
                  </span>
                )}
              </div>
              <div style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 8, ...(craftBusy ? { animation: "wbCraftShake 0.3s infinite" } : {}) }}>
                {[0, 1, 2, 3].map((i) => {
                  const entry = setEntries[i];
                  if (!entry) {
                    return (
                      <span
                        key={i}
                        aria-hidden
                        style={{ width: 48, height: 48, minWidth: 48, minHeight: 48, borderRadius: 10, border: "1px dashed rgba(255,255,255,0.3)", background: "rgba(255,255,255,0.03)", display: "block", boxSizing: "border-box" }}
                      />
                    );
                  }
                  const [id, n] = entry;
                  return (
                    <ItemSlot key={id} itemId={id} count={n} disabled={craftBusy} onClick={() => removeFromCraft(id)} />
                  );
                })}
              </div>
              <div style={{ display: "flex", justifyContent: "center", marginTop: 10 }}>
                <button type="button" style={btn} disabled={busy || totalSet === 0} onClick={() => void runCraft()}>
                  火を入れる
                </button>
              </div>
              {craftBusy && (
                <div style={{ height: 6, borderRadius: 3, background: "rgba(255,255,255,0.12)", marginTop: 10, overflow: "hidden" }}>
                  <div style={{ width: `${Math.round(craftPhase * 100)}%`, height: "100%", background: smokeColor, transition: "width 0.08s linear" }} />
                </div>
              )}
            </div>
            {/* かばんから素材をセットする（表示個数は所持数 − セット済み数） */}
            <div style={{ marginTop: 10 }}>
              {owned.length === 0 && <p className="muted">かばんは空です</p>}
              <ItemSlotGrid>
                {owned.map((item) => {
                  const remain = (profile.items[item.id] ?? 0) - (craftSet[item.id] ?? 0);
                  if (remain <= 0) return null;
                  return (
                    <ItemSlot
                      key={item.id}
                      itemId={item.id}
                      count={remain}
                      disabled={craftBusy}
                      onClick={() => addToCraft(item.id)}
                    />
                  );
                })}
              </ItemSlotGrid>
            </div>
          </div>
        );
      })()}

      {activeTab === "craft" && discovered.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <strong style={{ fontSize: 13 }}>発見した組み合わせ</strong>
          <div style={{ marginTop: 6 }}>
            <ItemSlotGrid>
              {discovered.map((recipe) => (
                <ItemSlot
                  key={recipe.id}
                  itemId={recipe.output}
                  count={recipe.outputCount > 1 ? recipe.outputCount : undefined}
                  selected={discSel === recipe.id}
                  onClick={() => setDiscSel(recipe.id)}
                />
              ))}
            </ItemSlotGrid>
            {discRecipe && (
              <ItemAnnotation itemId={discRecipe.output}>
                <div style={{ marginTop: 6 }}>
                  <span className="muted">
                    {Object.entries(discRecipe.inputs)
                      .map(([id, n]) => `${itemById(id)?.name ?? id}×${n}`)
                      .join(" + ")}
                  </span>
                </div>
              </ItemAnnotation>
            )}
          </div>
        </div>
      )}

      {activeTab === "craft" && canWork("enhance") && (
        <div style={{ marginTop: 10, borderTop: "1px solid rgba(255,255,255,0.14)", paddingTop: 8 }}>
          <strong style={{ fontSize: 13 }}>道具の強化</strong>
          <div style={{ marginTop: 6 }}>
            <ItemSlotGrid>
              {enhanceTools.map((item) => {
                const level = profile.enhance[item.id] ?? 0;
                const flashing = enhanceFlashId === item.id;
                return (
                  <span
                    key={item.id}
                    style={{
                      display: "inline-flex", borderRadius: 10,
                      background: flashing && enhanceFlashOn ? "rgba(255,210,62,0.35)" : "transparent",
                      transition: "background 0.6s ease-out",
                    }}
                  >
                    <ItemSlot
                      itemId={item.id}
                      count={profile.items[item.id]}
                      badge={level > 0 ? `+${level}` : undefined}
                      selected={enhanceSel === item.id}
                      onClick={() => setEnhanceSel(item.id)}
                    />
                  </span>
                );
              })}
            </ItemSlotGrid>
            {enhanceSelItem && (() => {
              const level = profile.enhance[enhanceSelItem.id] ?? 0;
              const material = enhanceSelItem.tier ? ENHANCE_MATERIALS[enhanceSelItem.tier] : undefined;
              const flashing = enhanceFlashId === enhanceSelItem.id;
              return (
                <div
                  style={{
                    borderRadius: 10,
                    background: flashing && enhanceFlashOn ? "rgba(255,210,62,0.35)" : "transparent",
                    transition: "background 0.6s ease-out",
                  }}
                >
                  <ItemAnnotation itemId={enhanceSelItem.id}>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 6, alignItems: "center" }}>
                      <span>{"+".repeat(level) || "未強化"}</span>
                      {level >= ENHANCE_MAX_LEVEL ? (
                        <span className="muted">最大</span>
                      ) : material ? (
                        <span className="muted">
                          {itemById(material.itemId)?.name}×{material.count}（所持 {profile.items[material.itemId] ?? 0}）・{ENHANCE_BASE_COST * (level + 1)} コイン
                        </span>
                      ) : null}
                    </div>
                    {level < ENHANCE_MAX_LEVEL && (
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
                        <button type="button" style={btn} disabled={busy}
                          onClick={() => void act({ action: "enhance", itemId: enhanceSelItem.id }, () => {
                            triggerEnhanceFlash(enhanceSelItem.id);
                            return `${enhanceSelItem.name}を強化した`;
                          })}>
                          強化する
                        </button>
                      </div>
                    )}
                  </ItemAnnotation>
                </div>
              );
            })()}
          </div>
        </div>
      )}

      {activeTab === "steal" && (
        <div style={{ marginTop: 6 }}>
          <div style={row}>
            <strong>steal</strong>
            <span style={{ flex: 1 }} />
            <button type="button" style={btn} disabled={busy} onClick={() => void refreshTargets()}>
              対象を更新
            </button>
          </div>
          {targets.length === 0 && <p className="muted">いま対象にできる相手がいません</p>}
          {targets.map((t) => (
            <div key={t.id} style={row}>
              <span>{t.name}</span>
              <span style={{ flex: 1 }} />
              <button
                type="button"
                style={btn}
                disabled={busy}
                onClick={() =>
                  void act({ action: "steal", targetId: t.id }, (d) => {
                    const amount = typeof d.amount === "number" ? d.amount : 0;
                    if (d.success === true) {
                      return amount > 0 ? `${t.name} から ${amount} コインを steal しました` : `${t.name} への steal は成功しましたが、奪えるコインがありませんでした`;
                    }
                    return amount > 0 ? `steal は失敗しました（罰金 ${amount} コイン）` : "steal は失敗しました";
                  })
                }
              >
                steal
              </button>
            </div>
          ))}
        </div>
      )}

      {activeTab === "exchange" && (() => {
        const available = tokenInfo?.available === true;
        const rate = available ? tokenInfo?.rate ?? null : null;
        const prev = available ? tokenInfo?.prevRate ?? null : null;
        const diff = rate !== null && prev !== null ? rate - prev : 0;
        const ownedTokens = tokenInfo?.balance ?? 0;
        const legacyTokens = profile.items["ago_token"] ?? 0;
        const halted = available && tokenInfo?.halted === true;
        const history = (tokenInfo?.history ?? []).filter((h) => typeof h.rate === "number");
        const hMax = Math.max(...history.map((h) => h.rate), 1);
        const hMin = Math.min(...history.map((h) => h.rate), 0);
        const points = history
          .map((h, i) => `${(i / Math.max(1, history.length - 1)) * 260},${36 - ((h.rate - hMin) / Math.max(1, hMax - hMin)) * 32}`)
          .join(" ");
        const agaAmount = Math.max(0, Math.floor(Number(buyAga) || 0));
        const buyQuote = rate !== null && agaAmount > 0 ? quoteBuyTokens(agaAmount, rate) : null;
        const sellAmount = Math.max(0, Number(sellTokens) || 0);
        const sellQuote = rate !== null && sellAmount > 0 ? quoteSellAga(sellAmount, rate) : null;
        const fmtTokens = (n: number) => n.toLocaleString("ja-JP", { maximumFractionDigits: 2 });
        const buy = async () => {
          await act({ action: "token_buy", agaAmount }, (d) =>
            `アゴトークン ${fmtTokens(typeof d.tokens === "number" ? d.tokens : 0)} を買いました`);
          void refreshToken();
        };
        const sell = async () => {
          await act({ action: "token_sell", tokenAmount: sellAmount }, (d) =>
            `アゴトークン ${fmtTokens(sellAmount)} を ${typeof d.netAga === "number" ? d.netAga : 0} コインで売りました`);
          void refreshToken();
        };
        const convert = async () => {
          await act({ action: "token_convert" }, () =>
            `旧トークン ${legacyTokens} 枚をアゴトークンに変換しました`);
          void refreshToken();
        };
        const numInput = {
          minHeight: 36, padding: "4px 8px", borderRadius: 8,
          border: "1px solid rgba(255,255,255,0.25)", background: "rgba(255,255,255,0.06)", color: "inherit",
        } as const;
        return (
          <div style={{ marginTop: 6 }}>
            <div style={row}>
              <strong>アゴトークン</strong>
              <span style={{ fontSize: 18 }}>
                {rate === null ? "—" : rate.toLocaleString("ja-JP", { maximumFractionDigits: 2 })}
                <span style={{ fontSize: 12 }}> コイン</span>
              </span>
              {rate !== null && prev !== null && (
                <span style={{ color: diff > 0 ? "#7ee787" : diff < 0 ? "#ff9c9c" : "inherit", fontSize: 12 }}>
                  {diff > 0 ? `+${diff.toFixed(2)}` : diff.toFixed(2)}
                </span>
              )}
              <span style={{ flex: 1 }} />
              <span>保有 {fmtTokens(ownedTokens)}</span>
            </div>
            {!available && <div style={row}><span>市場に接続できません</span></div>}
            {halted && <div style={row}><span>{tokenInfo?.haltReason || "取引を一時停止しています"}</span></div>}
            {history.length > 1 && (
              <svg viewBox="0 0 260 40" style={{ width: "100%", height: 40, display: "block" }} aria-hidden="true">
                <polyline points={points} fill="none" stroke="#ffd23e" strokeWidth="1.5" />
              </svg>
            )}
            <div style={row}>
              <input
                type="number"
                min={10}
                value={buyAga}
                onChange={(e) => setBuyAga(e.target.value)}
                style={{ ...numInput, width: 96 }}
              />
              <span>コインで買う</span>
              {buyQuote && <span style={{ fontSize: 12 }}>→ {fmtTokens(buyQuote.tokens)}（手数料 {buyQuote.fee}）</span>}
              <span style={{ flex: 1 }} />
              <button type="button" style={btn} disabled={busy || rate === null || halted || agaAmount <= 0} onClick={() => void buy()}>
                買う
              </button>
            </div>
            <div style={row}>
              <input
                type="number"
                min={0}
                step="0.01"
                value={sellTokens}
                onChange={(e) => setSellTokens(e.target.value)}
                style={{ ...numInput, width: 96 }}
              />
              <span>枚売る</span>
              {sellQuote && <span style={{ fontSize: 12 }}>→ {sellQuote.netAga} コイン（手数料 {sellQuote.fee}）</span>}
              <span style={{ flex: 1 }} />
              <button type="button" style={btn} disabled={busy || rate === null || halted || sellAmount <= 0 || sellAmount > ownedTokens} onClick={() => void sell()}>
                売る
              </button>
            </div>
            {legacyTokens > 0 && (
              <div style={row}>
                <span>旧トークン {legacyTokens} 枚</span>
                <span style={{ flex: 1 }} />
                <button type="button" style={btn} disabled={busy || !available} onClick={() => void convert()}>
                  本物に変換
                </button>
              </div>
            )}
          </div>
        );
      })()}

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
