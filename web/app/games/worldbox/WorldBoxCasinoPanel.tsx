"use client";
// AGO WORLD BOX のカジノパネル（ロビー右翼のカジノルーム専用）。
// スロットマシンの前: スロット / セブンスロット。
// カジノテーブルの前: ルーレット / ダイス / ブラックジャック / ダブルアップ。
// 位置の検証はサーバー側（プレゼンス）が行い、このパネルは今いる機器を
// 表示して遊ぶだけ。コインの正は AGO コイン本体: プレイは経済ブリッジの
// オプとして Bot 本体が適用し、残高はその結果を読み直して表示する。
import { useCallback, useEffect, useRef, useState } from "react";
import {
  CASINO_BET_TIERS, SLOT_SYMBOLS,
  type CasinoMachine, type RouletteColor, type RoulettePick,
} from "@/lib/worldbox/casino";
import { DICE_RANGES } from "@/lib/worldbox/casino-games";
import type { EconomyOp } from "@/lib/worldbox/economy-bridge";

type LoadState = "loading" | "ready" | "guest" | "unavailable";

type SessionView = {
  kind: "slot7" | "double" | "blackjack";
  bet: number;
  total?: number;
  remaining?: number;
  pendingReward?: number;
  pendingPenalty?: number;
  lastReels?: number[] | null;
  lastEvents?: string[];
  multiplier?: number;
  streak?: number;
  currentValue?: number;
  busted?: boolean;
  totalBet?: number;
  doubled?: boolean;
  playerHand?: { suit: string; rank: number }[];
  dealerHand?: { suit: string; rank: number }[];
  dealerHidden?: boolean;
  phase?: string;
  outcome?: string | null;
};

interface CasinoState {
  balance: number;
  effectiveBalance: number;
  machine: CasinoMachine | null;
  ops: EconomyOp[];
  session: SessionView | null;
  userState: { kakuhen: number; internalMode: string };
}

type PlayResult =
  | { game: "slot"; reels: [number, number, number]; payout: number }
  | { game: "roulette"; number: number; color: RouletteColor; payout: number }
  | { game: "dice"; rolled: number; hit: boolean; payout: number };

type Tab = "slot" | "slot7" | "roulette" | "dice" | "blackjack" | "double";

const ERROR_LABEL: Record<string, string> = {
  not_enough_coins: "コインが足りません",
  not_at_casino: "カジノの機器の前にいません",
  wrong_machine: "その機器では遊べません",
  invalid_bet: "ベット額が不正です",
  invalid_spins: "回数が不正です",
  invalid_dice_range: "範囲が不正です",
  invalid_dice_number: "予想が不正です",
  session_active: "進行中のゲームがあります",
  no_session: "ゲームが始まっていません",
  bet_pending: "前のベットを精算中です。少し待ってください",
  bet_failed: "ベットが失敗しました",
  unauthorized: "ログインが必要です",
  discord_required: "Discord ログインが必要です",
  economy_unavailable: "いまカジノを使えません",
  economy_failed: "受け付けられませんでした",
};

const OP_STATUS_LABEL: Record<EconomyOp["status"], string> = {
  pending: "処理中",
  done: "精算済み",
  failed: "失敗",
};

const REASON_LABEL: Record<string, string> = {
  casino_slot: "スロット",
  casino_roulette: "ルーレット",
  casino_dice: "ダイス",
  casino_slot7: "セブン",
  casino_blackjack: "BJ",
  casino_double: "ダブル",
};

const SLOT7_SPIN_CHOICES = [10, 50, 100];
const BJ_OUTCOME_LABEL: Record<string, string> = {
  blackjack: "ブラックジャック",
  dealer_blackjack: "ディーラーのブラックジャック",
  win: "勝ち",
  lose: "負け",
  push: "引き分け",
  bust: "バースト",
};
const SUIT_GLYPH: Record<string, { glyph: string; color: string }> = {
  spade: { glyph: "♠", color: "#e8e8f0" },
  heart: { glyph: "♥", color: "#ff7a7a" },
  diamond: { glyph: "♦", color: "#ff7a7a" },
  club: { glyph: "♣", color: "#e8e8f0" },
};

function rankLabel(rank: number): string {
  if (rank === 1) return "A";
  if (rank === 11) return "J";
  if (rank === 12) return "Q";
  if (rank === 13) return "K";
  return String(rank);
}

function handTotal(hand: { rank: number }[]): number {
  let total = 0;
  let aces = 0;
  for (const c of hand) {
    if (c.rank === 1) { aces++; total += 11; } else total += Math.min(c.rank, 10);
  }
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  return total;
}

const root: React.CSSProperties = {
  position: "absolute", left: "50%", top: "50%", transform: "translate(-50%, -50%)",
  width: "min(430px, calc(100% - 24px))", maxHeight: "calc(100% - 24px)", overflowY: "auto",
  padding: 14, borderRadius: 12, zIndex: 6, textAlign: "left",
  border: "1px solid rgba(255,210,62,0.45)", background: "rgba(12,10,18,0.94)", color: "#fff",
  boxShadow: "0 10px 32px rgba(0,0,0,0.55)",
};
const btn: React.CSSProperties = {
  minHeight: 38, padding: "4px 14px", borderRadius: 10, cursor: "pointer",
  border: "1px solid rgba(255,255,255,0.25)", background: "rgba(255,255,255,0.07)", color: "inherit",
  touchAction: "manipulation", userSelect: "none", WebkitUserSelect: "none", WebkitTouchCallout: "none",
};
const chipOn: React.CSSProperties = {
  background: "rgba(255,210,62,0.22)", borderColor: "rgba(255,210,62,0.8)",
};
const reelBox: React.CSSProperties = {
  width: 72, height: 84, borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "center",
  fontSize: 44, fontWeight: 700, background: "rgba(255,255,255,0.08)",
  border: "1px solid rgba(255,255,255,0.22)",
};
const digitBox: React.CSSProperties = {
  flex: 1, height: 56, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center",
  fontSize: 30, fontWeight: 700, background: "rgba(255,255,255,0.08)",
  border: "1px solid rgba(255,255,255,0.22)",
};
const cardBox: React.CSSProperties = {
  width: 40, height: 54, borderRadius: 6, display: "flex", flexDirection: "column",
  alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 17,
  background: "rgba(255,255,255,0.1)", border: "1px solid rgba(255,255,255,0.3)",
};
const tabBtn: React.CSSProperties = { ...btn, minHeight: 32, padding: "2px 10px", fontSize: 13 };

export default function WorldBoxCasinoPanel({ onClose }: { onClose: () => void }) {
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [state, setState] = useState<CasinoState | null>(null);
  const [bet, setBet] = useState<number>(CASINO_BET_TIERS[0]);
  const [pick, setPick] = useState<RoulettePick>("red");
  const [tab, setTab] = useState<Tab>("slot");
  const [result, setResult] = useState<PlayResult | null>(null);
  const [spinning, setSpinning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [spinReels, setSpinReels] = useState<[number, number, number]>([1, 2, 3]);
  const [msg, setMsg] = useState("");
  const [spins, setSpins] = useState<number>(SLOT7_SPIN_CHOICES[0]);
  const [diceRange, setDiceRange] = useState<number>(DICE_RANGES[0]);
  const [diceNumber, setDiceNumber] = useState<number>(1);
  const [bjFinal, setBjFinal] = useState<SessionView | null>(null);
  const [lastSpin, setLastSpin] = useState<{ reward: number; penalty: number; events: string[] } | null>(null);
  const [lastGo, setLastGo] = useState<{ win: boolean; currentValue: number } | null>(null);
  const aliveRef = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/worldbox/casino", { headers: { Accept: "application/json" } });
      if (res.status === 401 || res.status === 403) {
        if (aliveRef.current) setLoadState("guest");
        return;
      }
      if (!res.ok) {
        if (aliveRef.current) setLoadState((prev) => (prev === "ready" ? prev : "unavailable"));
        return;
      }
      const data = (await res.json()) as CasinoState;
      if (aliveRef.current) {
        setState(data);
        setLoadState("ready");
      }
    } catch {
      if (aliveRef.current) setLoadState((prev) => (prev === "ready" ? prev : "unavailable"));
    }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => {
      aliveRef.current = false;
      window.clearInterval(timer);
    };
  }, [refresh]);

  useEffect(() => {
    if (!spinning) return;
    const timer = window.setInterval(() => {
      setSpinReels([
        Math.floor(Math.random() * SLOT_SYMBOLS.length),
        Math.floor(Math.random() * SLOT_SYMBOLS.length),
        Math.floor(Math.random() * SLOT_SYMBOLS.length),
      ]);
    }, 90);
    return () => window.clearInterval(timer);
  }, [spinning]);

  const post = useCallback(async (payload: Record<string, unknown>) => {
    const res = await fetch("/api/worldbox/casino", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown> & { error?: string };
    return { res, data };
  }, []);

  const play = async () => {
    if (!state?.machine || spinning) return;
    const game = tab === "dice" ? "dice" : state.machine;
    setMsg("");
    setResult(null);
    setSpinning(true);
    try {
      const payload: Record<string, unknown> = { action: "play", game, bet };
      if (game === "roulette") payload.pick = pick;
      if (game === "dice") { payload.maxValue = diceRange; payload.number = diceNumber; }
      const { res, data } = await post(payload);
      if (!res.ok) {
        setMsg(ERROR_LABEL[data.error ?? ""] ?? "遊べませんでした");
        return;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 650));
      if (!aliveRef.current) return;
      const r = data.result as { reels?: [number, number, number]; number?: number; color?: RouletteColor; rolled?: number; hit?: boolean } | undefined;
      if (game === "slot" && r?.reels) {
        setResult({ game, reels: r.reels, payout: data.payout as number ?? 0 });
      } else if (game === "roulette" && typeof r?.number === "number" && r.color) {
        setResult({ game, number: r.number, color: r.color, payout: data.payout as number ?? 0 });
      } else if (game === "dice" && typeof r?.rolled === "number") {
        setResult({ game, rolled: r.rolled, hit: r.hit === true, payout: data.payout as number ?? 0 });
      }
      void refresh();
    } catch {
      if (aliveRef.current) setMsg("遊べませんでした");
    } finally {
      if (aliveRef.current) setSpinning(false);
    }
  };

  const act = async (payload: Record<string, unknown>, onOk?: (data: Record<string, unknown>) => void) => {
    if (busy) return;
    setMsg("");
    setBusy(true);
    try {
      const { res, data } = await post(payload);
      if (!res.ok) {
        setMsg(ERROR_LABEL[data.error ?? ""] ?? "受け付けられませんでした");
        return;
      }
      onOk?.(data);
      void refresh();
    } catch {
      if (aliveRef.current) setMsg("受け付けられませんでした");
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  };

  const header = (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <strong>カジノ</strong>
      {state && <span>残高 <strong>{state.effectiveBalance}</strong></span>}
      <span style={{ flex: 1 }} />
      <button type="button" style={{ ...btn, minHeight: 32, padding: "2px 10px" }} onClick={onClose}>
        閉じる
      </button>
    </div>
  );

  if (loadState === "loading") return <div style={root}>{header}<p style={{ margin: "10px 0 0" }}>読み込み中…</p></div>;
  if (loadState === "guest") return <div style={root}>{header}<p style={{ margin: "10px 0 0" }}>ログインが必要です</p></div>;
  if (loadState === "unavailable" || !state) {
    return <div style={root}>{header}<p style={{ margin: "10px 0 0" }}>いまカジノを使えません</p></div>;
  }

  const machine = state.machine;
  const session = state.session;
  const shownReels: [number, number, number] =
    result?.game === "slot" ? result.reels : spinReels;
  const pending = state.ops.filter((op) => op.status === "pending");
  const recent = state.ops.slice(0, 3);
  const tabs: { id: Tab; label: string }[] =
    machine === "slot"
      ? [{ id: "slot", label: "スロット" }, { id: "slot7", label: "セブン" }]
      : machine === "roulette"
        ? [
            { id: "roulette", label: "ルーレット" },
            { id: "dice", label: "ダイス" },
            { id: "blackjack", label: "ブラックジャック" },
            { id: "double", label: "ダブルアップ" },
          ]
        : [];
  const activeTab: Tab = session
    ? session.kind === "slot7" ? "slot7" : session.kind === "double" ? "double" : "blackjack"
    : tabs.some((t) => t.id === tab) ? tab : (tabs[0]?.id ?? "slot");

  const betRow = (actionButton: React.ReactNode) => (
    <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 14, flexWrap: "wrap" }}>
      <span>ベット</span>
      {CASINO_BET_TIERS.map((tier) => (
        <button key={tier} type="button" style={{ ...btn, ...(bet === tier ? chipOn : {}) }}
          onClick={() => setBet(tier)} aria-pressed={bet === tier}>
          {tier}
        </button>
      ))}
      <span style={{ flex: 1 }} />
      {actionButton}
    </div>
  );
  const startBtn = (label: string, onClick: () => void, disabled = false) => (
    <button type="button" disabled={busy || disabled || bet > state.effectiveBalance}
      style={{ ...btn, background: "rgba(255,210,62,0.25)", borderColor: "rgba(255,210,62,0.7)", fontWeight: 700 }}
      onClick={onClick}>
      {label}
    </button>
  );

  return (
    <div style={root} role="dialog" aria-label="カジノ">
      {header}

      {machine === null && (
        <p style={{ margin: "12px 0 0" }}>スロットマシンかカジノテーブルの前へ</p>
      )}

      {machine !== null && (
        <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
          {tabs.map((t) => (
            <button key={t.id} type="button" style={{ ...tabBtn, ...(activeTab === t.id ? chipOn : {}) }}
              onClick={() => { setTab(t.id); setResult(null); setBjFinal(null); }} aria-pressed={activeTab === t.id}>
              {t.label}
            </button>
          ))}
        </div>
      )}

      {/* ------------------------------------------------ スロット */}
      {machine === "slot" && activeTab === "slot" && !session && (
        <>
          <div style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 12 }}>
            {shownReels.map((idx, i) => (
              <div key={i} style={{ ...reelBox, color: SLOT_SYMBOLS[idx].color }}>
                {SLOT_SYMBOLS[idx].glyph}
              </div>
            ))}
          </div>
          {betRow(
            <button type="button" disabled={spinning || bet > state.effectiveBalance}
              style={{ ...btn, background: "rgba(255,210,62,0.25)", borderColor: "rgba(255,210,62,0.7)", fontWeight: 700 }}
              onClick={() => void play()}>
              回す
            </button>,
          )}
          {result?.game === "slot" && !spinning && (
            <p role="status" style={{ margin: "10px 0 0", fontWeight: 700 }}>
              {result.payout > 0 ? `当たり 配当 ${result.payout}` : "はずれ"}
            </p>
          )}
        </>
      )}

      {/* ------------------------------------------------ セブンスロット */}
      {machine === "slot" && (activeTab === "slot7" || session?.kind === "slot7") && (
        <div style={{ marginTop: 12 }}>
          {session?.kind === "slot7" ? (
            <>
              <div style={{ display: "flex", gap: 4 }}>
                {(session.lastReels ?? [null, null, null, null, null, null, null]).map((d, i) => (
                  <div key={i} style={{ ...digitBox, ...(d === 7 ? { color: "#ffd23e" } : {}), ...(d === 6 ? { color: "#ff7a7a" } : {}) }}>
                    {d ?? "―"}
                  </div>
                ))}
              </div>
              <div style={{ display: "flex", gap: 10, marginTop: 10, fontSize: 13, flexWrap: "wrap" }}>
                <span>残り <strong>{session.remaining}</strong> / {session.total}</span>
                <span>払い戻し集計 <strong>{session.pendingReward ?? 0}</strong></span>
                {(session.pendingPenalty ?? 0) > 0 && <span style={{ color: "#ff7a7a" }}>ペナルティ {session.pendingPenalty}</span>}
                {state.userState.kakuhen > 0 && <span style={{ color: "#ffd23e" }}>確変 {state.userState.kakuhen}</span>}
              </div>
              {lastSpin && (
                <p role="status" style={{ margin: "8px 0 0", fontWeight: 700 }}>
                  {lastSpin.events.includes("super_jackpot") ? "超JACKPOT"
                    : lastSpin.events.includes("six_confiscate") ? "66666"
                    : lastSpin.penalty > 0 ? `ペナルティ -${lastSpin.penalty}`
                    : lastSpin.reward > 0 ? `+${lastSpin.reward}` : "はずれ"}
                </p>
              )}
              <div style={{ marginTop: 10 }}>
                <button type="button" disabled={busy || (session.remaining ?? 0) <= 0}
                  style={{ ...btn, width: "100%", background: "rgba(255,210,62,0.25)", borderColor: "rgba(255,210,62,0.7)", fontWeight: 700 }}
                  onClick={() => void act({ action: "slot7_spin" }, (data) => {
                    const spin = data.spin as { reward: number; penalty: number; events: string[] } | undefined;
                    if (spin) setLastSpin(spin);
                  })}>
                  回す（{session.bet}）
                </button>
              </div>
            </>
          ) : (
            <>
              <div style={{ display: "flex", gap: 4 }}>
                {[7, 7, 7, 7, 7, 7, 7].map((d, i) => (
                  <div key={i} style={{ ...digitBox, color: "#ffd23e" }}>{d}</div>
                ))}
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 12, flexWrap: "wrap" }}>
                <span>回数</span>
                {SLOT7_SPIN_CHOICES.map((n) => (
                  <button key={n} type="button" style={{ ...btn, ...(spins === n ? chipOn : {}) }}
                    onClick={() => setSpins(n)} aria-pressed={spins === n}>
                    {n}
                  </button>
                ))}
              </div>
              {betRow(startBtn("始める", () => void act({ action: "slot7_start", bet, spins })))}
              <p style={{ margin: "8px 0 0", fontSize: 12, opacity: 0.8 }}>先払い {bet * spins} コイン</p>
            </>
          )}
        </div>
      )}

      {/* ------------------------------------------------ ルーレット */}
      {machine === "roulette" && activeTab === "roulette" && !session && (
        <>
          <div style={{ display: "flex", gap: 10, alignItems: "center", justifyContent: "center", marginTop: 12 }}>
            <div
              style={{
                width: 84, height: 84, borderRadius: "50%", display: "flex",
                alignItems: "center", justifyContent: "center", fontSize: 34, fontWeight: 700,
                border: "2px solid rgba(255,255,255,0.35)",
                background:
                  result?.game === "roulette"
                    ? result.color === "red" ? "#b03030" : result.color === "green" ? "#2e7d46" : "#26262e"
                    : "#26262e",
              }}
            >
              {result?.game === "roulette" ? result.number : "―"}
            </div>
            <div style={{ display: "grid", gap: 8 }}>
              <button type="button" style={{ ...btn, ...(pick === "red" ? { background: "#b03030", borderColor: "#ff8a8a" } : {}) }}
                onClick={() => setPick("red")} aria-pressed={pick === "red"}>
                赤
              </button>
              <button type="button" style={{ ...btn, ...(pick === "black" ? { background: "#26262e", borderColor: "#9a9aad" } : {}) }}
                onClick={() => setPick("black")} aria-pressed={pick === "black"}>
                黒
              </button>
            </div>
          </div>
          {betRow(
            <button type="button" disabled={spinning || bet > state.effectiveBalance}
              style={{ ...btn, background: "rgba(255,210,62,0.25)", borderColor: "rgba(255,210,62,0.7)", fontWeight: 700 }}
              onClick={() => void play()}>
              賭ける
            </button>,
          )}
          {result?.game === "roulette" && !spinning && (
            <p role="status" style={{ margin: "10px 0 0", fontWeight: 700 }}>
              {result.payout > 0 ? `当たり 配当 ${result.payout}` : "はずれ"}
            </p>
          )}
        </>
      )}

      {/* ------------------------------------------------ ダイス */}
      {machine === "roulette" && activeTab === "dice" && !session && (
        <div style={{ marginTop: 12 }}>
          <div style={{ display: "flex", gap: 10, alignItems: "center", justifyContent: "center" }}>
            <div style={{
              width: 84, height: 84, borderRadius: 14, display: "flex", alignItems: "center",
              justifyContent: "center", fontSize: 34, fontWeight: 700,
              background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.22)",
            }}>
              {result?.game === "dice" ? result.rolled : "―"}
            </div>
            <div style={{ display: "grid", gap: 8 }}>
              <div style={{ display: "flex", gap: 6 }}>
                {DICE_RANGES.map((r) => (
                  <button key={r} type="button" style={{ ...btn, ...(diceRange === r ? chipOn : {}) }}
                    onClick={() => { setDiceRange(r); setDiceNumber((n) => Math.min(Math.max(1, n), r)); }} aria-pressed={diceRange === r}>
                    1〜{r}
                  </button>
                ))}
              </div>
              <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
                予想
                <input type="number" min={1} max={diceRange} value={diceNumber}
                  onChange={(e) => setDiceNumber(Math.floor(Number(e.target.value) || 1))}
                  style={{
                    width: 76, minHeight: 36, borderRadius: 8, padding: "0 8px", color: "#fff",
                    background: "rgba(255,255,255,0.07)", border: "1px solid rgba(255,255,255,0.25)",
                  }} />
              </label>
            </div>
          </div>
          {betRow(
            <button type="button" disabled={spinning || bet > state.effectiveBalance}
              style={{ ...btn, background: "rgba(255,210,62,0.25)", borderColor: "rgba(255,210,62,0.7)", fontWeight: 700 }}
              onClick={() => void play()}>
              振る
            </button>,
          )}
          {result?.game === "dice" && !spinning && (
            <p role="status" style={{ margin: "10px 0 0", fontWeight: 700 }}>
              {result.hit ? `当たり 配当 ${result.payout}` : "はずれ"}
            </p>
          )}
        </div>
      )}

      {/* ------------------------------------------------ ブラックジャック */}
      {machine === "roulette" && (activeTab === "blackjack" || session?.kind === "blackjack") && (
        <div style={{ marginTop: 12 }}>
          {(() => {
            const view = session?.kind === "blackjack" ? session : bjFinal;
            if (!view) {
              return betRow(startBtn("配る", () => void act({ action: "bj_start", bet }, (data) => {
                const f = data.final as SessionView | null;
                if (f) setBjFinal(f);
              })));
            }
            const player = view.playerHand ?? [];
            const dealer = view.dealerHand ?? [];
            const inPlay = view.phase === "player";
            return (
              <>
                <div style={{ fontSize: 12, opacity: 0.85 }}>
                  ディーラー {view.dealerHidden ? `${handTotal(dealer)} + ?` : handTotal(dealer)}
                </div>
                <div style={{ display: "flex", gap: 6, marginTop: 4, flexWrap: "wrap" }}>
                  {dealer.map((c, i) => (
                    <div key={i} style={cardBox}>
                      {view.dealerHidden && i > 0 ? "?" : (
                        <>
                          <span>{rankLabel(c.rank)}</span>
                          <span style={{ color: SUIT_GLYPH[c.suit]?.color }}>{SUIT_GLYPH[c.suit]?.glyph}</span>
                        </>
                      )}
                    </div>
                  ))}
                </div>
                <div style={{ fontSize: 12, opacity: 0.85, marginTop: 10 }}>
                  あなた {handTotal(player)}（ベット {view.totalBet ?? view.bet}）
                </div>
                <div style={{ display: "flex", gap: 6, marginTop: 4, flexWrap: "wrap" }}>
                  {player.map((c, i) => (
                    <div key={i} style={cardBox}>
                      <span>{rankLabel(c.rank)}</span>
                      <span style={{ color: SUIT_GLYPH[c.suit]?.color }}>{SUIT_GLYPH[c.suit]?.glyph}</span>
                    </div>
                  ))}
                </div>
                {inPlay && session?.kind === "blackjack" ? (
                  <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
                    <button type="button" style={btn} disabled={busy}
                      onClick={() => void act({ action: "bj_hit" }, (data) => {
                        const f = data.final as SessionView | null;
                        if (f) setBjFinal(f);
                      })}>
                      ヒット
                    </button>
                    <button type="button" style={btn} disabled={busy}
                      onClick={() => void act({ action: "bj_stand" }, (data) => {
                        const f = data.final as SessionView | null;
                        if (f) setBjFinal(f);
                      })}>
                      スタンド
                    </button>
                    {player.length === 2 && !view.doubled && (
                      <button type="button" style={btn} disabled={busy}
                        onClick={() => void act({ action: "bj_double" }, (data) => {
                          const f = data.final as SessionView | null;
                          if (f) setBjFinal(f);
                        })}>
                        ダブル
                      </button>
                    )}
                  </div>
                ) : (
                  <>
                    {view.outcome && (
                      <p role="status" style={{ margin: "10px 0 0", fontWeight: 700 }}>
                        {BJ_OUTCOME_LABEL[view.outcome] ?? view.outcome}
                      </p>
                    )}
                    {!session && betRow(startBtn("もう一度", () => { setBjFinal(null); void act({ action: "bj_start", bet }, (data) => {
                      const f = data.final as SessionView | null;
                      if (f) setBjFinal(f);
                    }); }))}
                  </>
                )}
              </>
            );
          })()}
        </div>
      )}

      {/* ------------------------------------------------ ダブルアップ */}
      {machine === "roulette" && (activeTab === "double" || session?.kind === "double") && (
        <div style={{ marginTop: 12 }}>
          {session?.kind === "double" ? (
            <>
              <div style={{ display: "flex", gap: 12, alignItems: "baseline", flexWrap: "wrap" }}>
                <span style={{ fontSize: 30, fontWeight: 700 }}>×{(session.multiplier ?? 1).toFixed(2)}</span>
                <span>{session.currentValue} コイン</span>
                <span style={{ opacity: 0.8 }}>{session.streak} 連勝</span>
                {state.userState.internalMode === "FEVER" && <span style={{ color: "#ffd23e" }}>FEVER</span>}
              </div>
              {lastGo && (
                <p role="status" style={{ margin: "8px 0 0", fontWeight: 700 }}>
                  {session.busted ? "バースト" : lastGo.win ? "成功" : ""}
                </p>
              )}
              {!session.busted ? (
                <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                  <button type="button" disabled={busy}
                    style={{ ...btn, flex: 1, background: "rgba(255,210,62,0.25)", borderColor: "rgba(255,210,62,0.7)", fontWeight: 700 }}
                    onClick={() => void act({ action: "double_go" }, (data) => {
                      const go = data.go as { win: boolean; currentValue: number } | undefined;
                      if (go) setLastGo(go);
                    })}>
                    GO
                  </button>
                  <button type="button" disabled={busy} style={{ ...btn, flex: 1 }}
                    onClick={() => void act({ action: "double_cashout" }, () => setLastGo(null))}>
                    キャッシュアウト
                  </button>
                </div>
              ) : (
                <p style={{ margin: "8px 0 0", fontSize: 12, opacity: 0.8 }}>精算中…</p>
              )}
            </>
          ) : (
            betRow(startBtn("始める", () => { setLastGo(null); void act({ action: "double_start", bet }); }))
          )}
        </div>
      )}

      {pending.length > 0 && (
        <p style={{ margin: "8px 0 0", fontSize: 12, opacity: 0.8 }}>
          処理中 {pending.reduce((sum, op) => sum + op.amount, 0)} コイン
        </p>
      )}

      {recent.length > 0 && (
        <div style={{ marginTop: 12, borderTop: "1px solid rgba(255,255,255,0.12)", paddingTop: 8 }}>
          {recent.map((op) => (
            <div key={op.id} style={{ display: "flex", gap: 8, fontSize: 12, padding: "3px 0" }}>
              <span>{REASON_LABEL[op.reason] ?? op.reason}</span>
              <span style={{ opacity: 0.75 }}>ベット {op.amount}</span>
              <span style={{ flex: 1 }} />
              {op.status === "done" && <span>配当 {op.appliedAmount ?? 0}</span>}
              <span style={{ opacity: 0.75 }}>{OP_STATUS_LABEL[op.status]}</span>
            </div>
          ))}
        </div>
      )}

      {msg && <p role="status" style={{ margin: "10px 0 0" }}>{msg}</p>}
    </div>
  );
}
