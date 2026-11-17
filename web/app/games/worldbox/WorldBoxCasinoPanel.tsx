"use client";
// AGO WORLD BOX のカジノパネル（ロビー右翼のカジノルーム専用）。
// スロットマシンの前: スロット / セブンスロット。
// カジノテーブルの前: ルーレット / ダイス / ブラックジャック / ダブルアップ。
// 位置の検証はサーバー側（プレゼンス）が行い、このパネルは今いる機器を
// 表示して遊ぶだけ。コインの正は AGO コイン本体: プレイは経済ブリッジの
// オプとして Bot 本体が適用し、残高はその結果を読み直して表示する。
// 演出はドーパミン濃いめ: リールは1つずつ止まり、先2つが揃えばリーチで
// 3つ目が長く回る。配当は階級（casino-fx）で紙吹雪・カウントアップ・
// フラッシュ・シェイク・効果音の強さが変わる。
import { useCallback, useEffect, useRef, useState } from "react";
import {
  CASINO_BET_TIERS, SLOT_SYMBOLS,
  type CasinoMachine, type RouletteColor, type RoulettePick,
} from "@/lib/worldbox/casino";
import { DICE_RANGES } from "@/lib/worldbox/casino-games";
import { createPollGuard, type PollGuard } from "@/lib/poll-guard";
import { onEconomyApplied } from "@/lib/worldbox/economy-push";
import {
  confettiParticles, countUpValue, isReach, tierFx, winTier, type WinTier,
} from "@/lib/worldbox/casino-fx";
import type { EconomyOp } from "@/lib/worldbox/economy-bridge";
import {
  sfxCorrect, sfxDeal, sfxDice, sfxFlip, sfxJingle, sfxLose, sfxPlace, sfxTick, sfxWin, sfxWrong,
} from "@/lib/sfx";

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

interface CasinoTournamentView {
  status: "none" | "entry" | "running" | "done";
  fee: number;
  maxEntrants: number;
  entrantCount: number;
  entryEndsAt: number | null;
  playEndsAt: number | null;
  prizePool: number;
  entered: boolean;
  myNet: number;
  myRank: number | null;
  standings: { rank: number; net: number; you: boolean }[];
}

interface CasinoTournamentState {
  tournament: CasinoTournamentView;
}


interface Celebration {
  key: number;
  tier: WinTier;
  amount: number;
}

const MACHINE_LABEL: Record<CasinoMachine, string> = {
  slot: "スロット",
  slot7: "セブンスロット",
  roulette: "ルーレット",
  dice: "ダイス",
  blackjack: "ブラックジャック",
  double: "ダブルアップ",
};

const ERROR_LABEL: Record<string, string> = {
  not_enough_coins: "コインが足りません",
  not_at_casino: "カジノの機器の前にいません",
  wrong_machine: "その機器では遊べません",
  invalid_bet: "ベット額が不正です",
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
  tournament_closed: "大会は締め切られました",
  tournament_full: "大会は満員です",
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
  animation: "wb-casino-deal 0.28s ease-out",
};
const tabBtn: React.CSSProperties = { ...btn, minHeight: 32, padding: "2px 10px", fontSize: 13 };

const JUICE_CSS = `
@keyframes wb-casino-pop { 0% { transform: scale(0.6); } 55% { transform: scale(1.18); } 100% { transform: scale(1); } }
@keyframes wb-casino-shake { 0%,100% { margin-left: 0; } 20% { margin-left: -7px; } 40% { margin-left: 6px; } 60% { margin-left: -4px; } 80% { margin-left: 3px; } }
@keyframes wb-casino-flash { 0% { opacity: 0.55; } 100% { opacity: 0; } }
@keyframes wb-casino-reach { 0%,100% { box-shadow: 0 0 0 rgba(255,60,60,0); border-color: rgba(255,210,62,0.45); } 50% { box-shadow: 0 0 34px rgba(255,60,60,0.75); border-color: #ff5050; } }
@keyframes wb-casino-gold { 0%,100% { box-shadow: 0 0 6px rgba(255,210,62,0.35); } 50% { box-shadow: 0 0 22px rgba(255,210,62,0.85); } }
@keyframes wb-casino-deal { 0% { transform: translateY(-10px) rotate(-4deg); opacity: 0; } 100% { transform: translateY(0) rotate(0); opacity: 1; } }
@keyframes wb-casino-bounce { 0% { transform: scale(0.5); } 60% { transform: scale(1.22); } 100% { transform: scale(1); } }
@media (prefers-reduced-motion: reduce) {
  .wb-casino-juice * { animation: none !important; }
}
`;

/** 配当のカウントアップ表示。 */
function CountUp({ value, durationMs, runKey }: { value: number; durationMs: number; runKey: number }) {
  const [shown, setShown] = useState(0);
  useEffect(() => {
    if (durationMs <= 0) { setShown(value); return; }
    let raf = 0;
    const start = performance.now();
    const stepFn = (now: number) => {
      const t = (now - start) / durationMs;
      setShown(countUpValue(0, value, t));
      if (t < 1) raf = requestAnimationFrame(stepFn);
    };
    raf = requestAnimationFrame(stepFn);
    return () => cancelAnimationFrame(raf);
  }, [value, durationMs, runKey]);
  return <>{shown.toLocaleString()}</>;
}

/** 紙吹雪キャンバス。celebration が差し替わるたびに噴き出す。 */
function ConfettiCanvas({ celebration }: { celebration: Celebration | null }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    if (!celebration || celebration.tier === 0) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const parent = canvas.parentElement;
    if (!parent) return;
    canvas.width = parent.clientWidth;
    canvas.height = parent.clientHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const fx = tierFx(celebration.tier);
    const parts = confettiParticles(fx.confetti, Math.random).map((p) => ({
      ...p,
      x: p.x * canvas.width,
      y: p.y * canvas.height,
      vx: p.vx * 260,
      vy: p.vy * 260,
      rot: 0,
    }));
    let raf = 0;
    const start = performance.now();
    const lifeMs = fx.countUpMs + 1400;
    const stepFn = (now: number) => {
      const t = (now - start) / 1000;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      let alive = false;
      for (const p of parts) {
        if (t < p.delay) { alive = true; continue; }
        const lt = t - p.delay;
        const x = p.x + p.vx * lt;
        const y = p.y + p.vy * lt + 340 * lt * lt;
        const alpha = Math.max(0, 1 - lt / (lifeMs / 1000));
        if (alpha <= 0 || y > canvas.height + 20) continue;
        alive = true;
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(p.rot + p.spin * lt);
        ctx.globalAlpha = alpha;
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
        ctx.restore();
      }
      if (alive && now - start < lifeMs + 500) raf = requestAnimationFrame(stepFn);
      else ctx.clearRect(0, 0, canvas.width, canvas.height);
    };
    raf = requestAnimationFrame(stepFn);
    return () => cancelAnimationFrame(raf);
  }, [celebration]);
  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", zIndex: 3 }}
    />
  );
}

export default function WorldBoxCasinoPanel({ onClose }: { onClose: () => void }) {
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [state, setState] = useState<CasinoState | null>(null);
  const [bet, setBet] = useState<number>(CASINO_BET_TIERS[0]);
  const [pick, setPick] = useState<RoulettePick>("red");
  const [result, setResult] = useState<PlayResult | null>(null);
  const [spinning, setSpinning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [spinReels, setSpinReels] = useState<[number, number, number]>([1, 2, 3]);
  const [msg, setMsg] = useState("");
  const [diceRange, setDiceRange] = useState<number>(DICE_RANGES[0]);
  const [diceNumber, setDiceNumber] = useState<number>(1);
  const [bjFinal, setBjFinal] = useState<SessionView | null>(null);
  const [tournament, setTournament] = useState<CasinoTournamentView | null>(null);
  const [tournamentMsg, setTournamentMsg] = useState("");
  const [lastSpin, setLastSpin] = useState<{ reward: number; penalty: number; events: string[] } | null>(null);
  const [lastGo, setLastGo] = useState<{ win: boolean; currentValue: number } | null>(null);
  // 演出用
  const [celebration, setCelebration] = useState<Celebration | null>(null);
  const [slotPending, setSlotPending] = useState<PlayResult | null>(null);
  const [stopped, setStopped] = useState(3);
  const [reach, setReach] = useState(false);
  const [wheelNum, setWheelNum] = useState(0);
  const [diceFace, setDiceFace] = useState(1);
  const [rolling7, setRolling7] = useState<number[] | null>(null);
  const aliveRef = useRef(true);
  // カジノ状態のポーリングガード（S6）: 3s 間隔で重ねて走らせず、古い
  // レスポンスでプレイ後の残高表示を巻き戻さない。
  const refreshGuardRef = useRef<PollGuard>(createPollGuard());
  const tournamentGuardRef = useRef<PollGuard>(createPollGuard());
  const timersRef = useRef<number[]>([]);

  const later = useCallback((fn: () => void, ms: number) => {
    const id = window.setTimeout(() => { if (aliveRef.current) fn(); }, ms);
    timersRef.current.push(id);
  }, []);

  const celebrate = useCallback((payout: number, betAmount: number, forceTier?: WinTier) => {
    const tier = forceTier ?? winTier(payout, betAmount);
    if (tier === 0) return;
    setCelebration({ key: Date.now(), tier, amount: payout });
    if (tier >= 3) { sfxJingle(true); sfxWin(); }
    else if (tier === 2) sfxWin();
    else sfxCorrect();
    later(() => setCelebration(null), tierFx(tier).countUpMs + 1600);
  }, [later]);

  const badFlash = useCallback(() => {
    setCelebration({ key: Date.now(), tier: 0, amount: 0 });
    sfxWrong();
    later(() => setCelebration(null), 700);
  }, [later]);

  const refresh = useCallback(async (force = false) => {
    const ticket = refreshGuardRef.current.begin(force ? { force: true } : undefined);
    if (ticket === null) return;
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
      if (aliveRef.current && refreshGuardRef.current.isCurrent(ticket)) {
        setState(data);
        setLoadState("ready");
      }
    } catch {
      if (aliveRef.current) setLoadState((prev) => (prev === "ready" ? prev : "unavailable"));
    } finally {
      refreshGuardRef.current.end(ticket);
    }
  }, []);

  const refreshTournament = useCallback(async () => {
    const ticket = tournamentGuardRef.current.begin();
    if (ticket === null) return;
    try {
      const res = await fetch("/api/worldbox/casino-tournament", { headers: { Accept: "application/json" } });
      if (!res.ok) return;
      const data = (await res.json()) as CasinoTournamentState;
      if (aliveRef.current && tournamentGuardRef.current.isCurrent(ticket)) setTournament(data.tournament);
    } catch {
      // 大会の取得失敗はカジノの表示を壊さない（次の更新で取り直す）
    } finally {
      tournamentGuardRef.current.end(ticket);
    }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    void refresh();
    void refreshTournament();
    const timer = window.setInterval(() => { void refresh(); void refreshTournament(); }, 3000);
    // 経済オプ確定の push でも即時更新する（3秒ポーリングは fallback）
    const off = onEconomyApplied(() => { void refresh(); void refreshTournament(); });
    const timers = timersRef.current;
    return () => {
      aliveRef.current = false;
      window.clearInterval(timer);
      off();
      for (const id of timers) window.clearTimeout(id);
    };
  }, [refresh, refreshTournament]);

  // 回転中の目まぐるしい切り替え（スロット/ルーレット/ダイス共通）
  useEffect(() => {
    if (!spinning) return;
    const timer = window.setInterval(() => {
      setSpinReels([
        Math.floor(Math.random() * SLOT_SYMBOLS.length),
        Math.floor(Math.random() * SLOT_SYMBOLS.length),
        Math.floor(Math.random() * SLOT_SYMBOLS.length),
      ]);
      setWheelNum(Math.floor(Math.random() * 37));
      setDiceFace(1 + Math.floor(Math.random() * diceRange));
    }, 70);
    return () => window.clearInterval(timer);
  }, [spinning, diceRange]);

  // セブンの数字ロール
  useEffect(() => {
    if (!rolling7) return;
    const timer = window.setInterval(() => {
      setRolling7(Array.from({ length: 7 }, () => Math.floor(Math.random() * 10)));
    }, 60);
    return () => window.clearInterval(timer);
  }, [rolling7 !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  const post = useCallback(async (payload: Record<string, unknown>) => {
    const res = await fetch("/api/worldbox/casino", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown> & { error?: string };
    return { res, data };
  }, []);

  const postTournament = async (payload: Record<string, unknown>) => {
    setBusy(true);
    try {
      const res = await fetch("/api/worldbox/casino-tournament", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await res.json().catch(() => ({}))) as CasinoTournamentState & { error?: string };
      if (!res.ok) {
        setTournamentMsg(ERROR_LABEL[data.error ?? ""] ?? "受け付けられませんでした");
        return;
      }
      setTournamentMsg("");
      setTournament(data.tournament);
    } catch {
      setTournamentMsg("受け付けられませんでした");
    } finally {
      setBusy(false);
    }
  };

  const finishPlay = useCallback((r: PlayResult, betAmount: number) => {
    setResult(r);
    setSpinning(false);
    if (r.game === "slot" || r.game === "roulette" || r.game === "dice") {
      if (r.payout > 0) celebrate(r.payout, betAmount);
      else sfxWrong();
    }
    void refresh(true);
  }, [celebrate, refresh]);

  const play = async () => {
    if (!state?.machine || spinning) return;
    const game = state.machine === "slot" || state.machine === "roulette" || state.machine === "dice"
      ? state.machine
      : null;
    if (game === null) return;
    setMsg("");
    setResult(null);
    setCelebration(null);
    setSlotPending(null);
    setStopped(0);
    setReach(false);
    setSpinning(true);
    if (game === "dice") sfxDice();
    try {
      const payload: Record<string, unknown> = { action: "play", game, bet };
      if (game === "roulette") payload.pick = pick;
      if (game === "dice") { payload.maxValue = diceRange; payload.number = diceNumber; }
      const { res, data } = await post(payload);
      if (!res.ok) {
        setMsg(ERROR_LABEL[data.error ?? ""] ?? "遊べませんでした");
        setSpinning(false);
        return;
      }
      const r = data.result as { reels?: [number, number, number]; number?: number; color?: RouletteColor; rolled?: number; hit?: boolean } | undefined;
      const payout = (data.payout as number) ?? 0;
      if (game === "slot" && r?.reels) {
        const finalResult: PlayResult = { game, reels: r.reels, payout };
        setSlotPending(finalResult);
        const reachHit = isReach(r.reels);
        later(() => { setStopped(1); sfxPlace(); }, 450);
        later(() => {
          setStopped(2);
          sfxPlace();
          if (reachHit) {
            setReach(true);
            for (let i = 0; i < 5; i++) later(() => sfxTick(), 200 + i * 210);
          }
        }, 950);
        later(() => {
          setStopped(3);
          setReach(false);
          setSlotPending(null);
          finishPlay(finalResult, bet);
        }, reachHit ? 2250 : 1450);
      } else if (game === "roulette" && typeof r?.number === "number" && r.color) {
        const num = r.number;
        const color = r.color;
        later(() => finishPlay({ game, number: num, color, payout }, bet), 1000);
      } else if (game === "dice" && typeof r?.rolled === "number") {
        const rolled = r.rolled;
        const hit = r.hit === true;
        later(() => finishPlay({ game, rolled, hit, payout }, bet), 800);
      } else {
        setSpinning(false);
      }
    } catch {
      if (aliveRef.current) {
        setMsg("遊べませんでした");
        setSpinning(false);
      }
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
      void refresh(true);
    } catch {
      if (aliveRef.current) setMsg("受け付けられませんでした");
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  };

  const spin7 = () => {
    if (busy) return;
    setRolling7(Array.from({ length: 7 }, () => Math.floor(Math.random() * 10)));
    void act({ action: "slot7_spin" }, (data) => {
      const spin = data.spin as { reward: number; penalty: number; events: string[] } | undefined;
      later(() => {
        setRolling7(null);
        if (!spin) return;
        setLastSpin(spin);
        if (spin.events.includes("super_jackpot")) celebrate(spin.reward, bet, 4);
        else if (spin.events.includes("seven_bonus")) celebrate(spin.reward, bet, Math.max(3, winTier(spin.reward, bet)) as WinTier);
        else if (spin.events.includes("kakuhen_start")) celebrate(spin.reward, bet, 2);
        else if (spin.reward > 0) celebrate(spin.reward, bet);
        else if (spin.penalty > 0 || spin.events.includes("six_confiscate")) badFlash();
      }, 620);
    });
  };

  const header = (
    <div
      style={{
        display: "flex", alignItems: "center", gap: 10,
        position: "sticky", top: -14, zIndex: 3,
        margin: "-14px -14px 0", padding: "14px 14px 8px",
        background: "rgba(12,10,18,0.98)",
      }}
    >
      <strong>カジノ</strong>
      {state?.machine && <span style={{ fontWeight: 700, color: "#ffd23e" }}>{MACHINE_LABEL[state.machine]}</span>}
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
  const slotReels: [number, number, number] = slotPending?.game === "slot"
    ? slotPending.reels
    : result?.game === "slot" ? result.reels : spinReels;
  const shownReels: [number, number, number] = [
    stopped >= 1 ? slotReels[0] : spinReels[0],
    stopped >= 2 ? slotReels[1] : spinReels[1],
    stopped >= 3 ? slotReels[2] : spinReels[2],
  ];
  const pending = state.ops.filter((op) => op.status === "pending");
  const recent = state.ops.slice(0, 3);
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

  const fx = celebration ? tierFx(celebration.tier) : null;
  const rootAnim = reach
    ? "wb-casino-reach 0.55s ease-in-out infinite"
    : fx?.shake ? "wb-casino-shake 0.45s ease-in-out" : undefined;

  const payoutBanner = celebration && celebration.tier > 0 && celebration.amount > 0 && (
    <div
      key={celebration.key}
      role="status"
      style={{
        marginTop: 10, textAlign: "center", fontWeight: 800,
        fontSize: celebration.tier >= 3 ? 30 : 22, color: "#ffd23e",
        animation: "wb-casino-pop 0.35s ease-out",
        textShadow: "0 0 18px rgba(255,210,62,0.65)",
      }}
    >
      +<CountUp value={celebration.amount} durationMs={fx?.countUpMs ?? 0} runKey={celebration.key} />
    </div>
  );

  return (
    <div
      style={{ ...root, animation: rootAnim, position: "absolute", overflow: "hidden auto" }}
      role="dialog" aria-label="カジノ" className="wb-casino-juice wb-panel" data-wb-se="self"
    >
      <style>{JUICE_CSS}</style>
      {celebration && (
        <div
          key={`flash-${celebration.key}`}
          aria-hidden
          style={{
            position: "absolute", inset: 0, pointerEvents: "none", zIndex: 2,
            background: celebration.tier === 0 ? "rgba(255,60,60,0.5)" : "rgba(255,210,62,0.55)",
            animation: "wb-casino-flash 0.6s ease-out forwards",
          }}
        />
      )}
      <ConfettiCanvas celebration={celebration} />
      {header}

      {machine === null && (
        <p style={{ margin: "12px 0 0" }}>遊びたいゲームの台・テーブルの前へ</p>
      )}

      {/* ------------------------------------------------ スロット */}
      {machine === "slot" && !session && (
        <>
          <div style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 12 }}>
            {shownReels.map((idx, i) => (
              <div
                key={i}
                style={{
                  ...reelBox, color: SLOT_SYMBOLS[idx].color,
                  ...(reach && i === 2 ? { borderColor: "#ff5050", boxShadow: "0 0 16px rgba(255,60,60,0.8)" } : {}),
                  ...(stopped === i + 1 || (stopped >= 3 && i === 2) ? { animation: "wb-casino-bounce 0.3s ease-out" } : {}),
                }}
              >
                {SLOT_SYMBOLS[idx].glyph}
              </div>
            ))}
          </div>
          {reach && (
            <p role="status" style={{ margin: "8px 0 0", textAlign: "center", fontWeight: 800, color: "#ff5050", fontSize: 18 }}>
              リーチ
            </p>
          )}
          {betRow(
            <button type="button" disabled={spinning || bet > state.effectiveBalance}
              style={{ ...btn, background: "rgba(255,210,62,0.25)", borderColor: "rgba(255,210,62,0.7)", fontWeight: 700 }}
              onClick={() => void play()}>
              回す
            </button>,
          )}
          {payoutBanner}
          {result?.game === "slot" && !spinning && !celebration && (
            <p role="status" style={{ margin: "10px 0 0", fontWeight: 700 }}>
              {result.payout > 0 ? `当たり 配当 ${result.payout}` : "はずれ"}
            </p>
          )}
        </>
      )}

      {/* ------------------------------------------------ セブンスロット */}
      {(machine === "slot7" || session?.kind === "slot7") && (
        <div style={{ marginTop: 12 }}>
          {session?.kind === "slot7" ? (
            <>
              <div
                style={{
                  display: "flex", gap: 4, padding: 4, borderRadius: 10,
                  ...(state.userState.kakuhen > 0 ? { animation: "wb-casino-gold 1.1s ease-in-out infinite" } : {}),
                }}
              >
                {(rolling7 ?? session.lastReels ?? [null, null, null, null, null, null, null]).map((d, i) => (
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
              {payoutBanner}
              {lastSpin && !celebration && (
                <p role="status" style={{ margin: "8px 0 0", fontWeight: 700 }}>
                  {lastSpin.events.includes("super_jackpot") ? "超JACKPOT"
                    : lastSpin.events.includes("six_confiscate") ? "66666"
                    : lastSpin.penalty > 0 ? `ペナルティ -${lastSpin.penalty}`
                    : lastSpin.reward > 0 ? `+${lastSpin.reward}` : "はずれ"}
                </p>
              )}
              <div style={{ marginTop: 10 }}>
                <button type="button" disabled={busy || rolling7 !== null || (session.remaining ?? 0) <= 0}
                  style={{ ...btn, width: "100%", background: "rgba(255,210,62,0.25)", borderColor: "rgba(255,210,62,0.7)", fontWeight: 700 }}
                  onClick={spin7}>
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
              {betRow(startBtn("始める", () => void act({ action: "slot7_start", bet })))}
              <p style={{ margin: "8px 0 0", fontSize: 12, opacity: 0.8 }}>先払い {bet} コイン</p>
            </>
          )}
        </div>
      )}

      {/* ------------------------------------------------ ルーレット */}
      {machine === "roulette" && !session && (
        <>
          <div style={{ display: "flex", gap: 10, alignItems: "center", justifyContent: "center", marginTop: 12 }}>
            <div
              style={{
                width: 84, height: 84, borderRadius: "50%", display: "flex",
                alignItems: "center", justifyContent: "center", fontSize: 34, fontWeight: 700,
                border: "2px solid rgba(255,255,255,0.35)",
                background:
                  !spinning && result?.game === "roulette"
                    ? result.color === "red" ? "#b03030" : result.color === "green" ? "#2e7d46" : "#26262e"
                    : "#26262e",
                ...(result?.game === "roulette" && !spinning ? { animation: "wb-casino-bounce 0.35s ease-out" } : {}),
              }}
            >
              {spinning ? wheelNum : result?.game === "roulette" ? result.number : "―"}
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
          {payoutBanner}
          {result?.game === "roulette" && !spinning && !celebration && (
            <p role="status" style={{ margin: "10px 0 0", fontWeight: 700 }}>
              {result.payout > 0 ? `当たり 配当 ${result.payout}` : "はずれ"}
            </p>
          )}
        </>
      )}

      {/* ------------------------------------------------ ダイス */}
      {machine === "dice" && !session && (
        <div style={{ marginTop: 12 }}>
          <div style={{ display: "flex", gap: 10, alignItems: "center", justifyContent: "center" }}>
            <div style={{
              width: 84, height: 84, borderRadius: 14, display: "flex", alignItems: "center",
              justifyContent: "center", fontSize: 34, fontWeight: 700,
              background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.22)",
              ...(result?.game === "dice" && !spinning ? { animation: "wb-casino-bounce 0.35s ease-out" } : {}),
            }}>
              {spinning ? diceFace : result?.game === "dice" ? result.rolled : "―"}
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
          {payoutBanner}
          {result?.game === "dice" && !spinning && !celebration && (
            <p role="status" style={{ margin: "10px 0 0", fontWeight: 700 }}>
              {result.hit ? `当たり 配当 ${result.payout}` : "はずれ"}
            </p>
          )}
        </div>
      )}

      {/* ------------------------------------------------ ブラックジャック */}
      {(machine === "blackjack" || session?.kind === "blackjack") && (
        <div style={{ marginTop: 12 }}>
          {(() => {
            const view = session?.kind === "blackjack" ? session : bjFinal;
            if (!view) {
              return betRow(startBtn("配る", () => {
                sfxDeal();
                later(() => sfxDeal(), 140);
                void act({ action: "bj_start", bet }, (data) => {
                  const f = data.final as SessionView | null;
                  if (f) setBjFinal(f);
                });
              }));
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
                    <div key={`${i}-${c.rank}-${c.suit}`} style={cardBox}>
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
                    <div key={`${i}-${c.rank}-${c.suit}`} style={cardBox}>
                      <span>{rankLabel(c.rank)}</span>
                      <span style={{ color: SUIT_GLYPH[c.suit]?.color }}>{SUIT_GLYPH[c.suit]?.glyph}</span>
                    </div>
                  ))}
                </div>
                {inPlay && session?.kind === "blackjack" ? (
                  <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
                    <button type="button" style={btn} disabled={busy}
                      onClick={() => { sfxFlip(); void act({ action: "bj_hit" }, (data) => {
                        const f = data.final as SessionView | null;
                        if (f) { setBjFinal(f); bjOutcomeFx(f); }
                      }); }}>
                      ヒット
                    </button>
                    <button type="button" style={btn} disabled={busy}
                      onClick={() => void act({ action: "bj_stand" }, (data) => {
                        const f = data.final as SessionView | null;
                        if (f) { setBjFinal(f); bjOutcomeFx(f); }
                      })}>
                      スタンド
                    </button>
                    {player.length === 2 && !view.doubled && (
                      <button type="button" style={btn} disabled={busy}
                        onClick={() => void act({ action: "bj_double" }, (data) => {
                          const f = data.final as SessionView | null;
                          if (f) { setBjFinal(f); bjOutcomeFx(f); }
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
      {(machine === "double" || session?.kind === "double") && (
        <div style={{ marginTop: 12 }}>
          {session?.kind === "double" ? (
            <>
              <div style={{ display: "flex", gap: 12, alignItems: "baseline", flexWrap: "wrap" }}>
                <span
                  key={session.multiplier}
                  style={{
                    fontSize: 30, fontWeight: 700, display: "inline-block",
                    animation: "wb-casino-pop 0.3s ease-out",
                    ...((session.streak ?? 0) >= 3 || state.userState.internalMode === "FEVER"
                      ? { color: "#ffd23e", textShadow: "0 0 14px rgba(255,210,62,0.7)" } : {}),
                  }}
                >
                  ×{(session.multiplier ?? 1).toFixed(2)}
                </span>
                <span>
                  <CountUp value={session.currentValue ?? 0} durationMs={450} runKey={session.currentValue ?? 0} /> コイン
                </span>
                <span style={{ opacity: 0.8 }}>{session.streak} 連勝</span>
                {state.userState.internalMode === "FEVER" && <span style={{ color: "#ffd23e" }}>FEVER</span>}
              </div>
              {payoutBanner}
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
                      if (go) {
                        setLastGo(go);
                        if (go.win) sfxCorrect();
                      }
                    })}>
                    GO
                  </button>
                  <button type="button" disabled={busy} style={{ ...btn, flex: 1 }}
                    onClick={() => {
                      const amount = session.currentValue ?? 0;
                      void act({ action: "double_cashout" }, () => {
                        setLastGo(null);
                        if (amount > 0) celebrate(amount, session.bet);
                      });
                    }}>
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

      {tournament && (
        <div style={{ marginTop: 12, borderTop: "1px solid rgba(255,255,255,0.12)", paddingTop: 8 }}>
          <p style={{ margin: "0 0 8px", fontSize: 14, fontWeight: 700 }}>大会</p>
          {tournament.status === "none" && (
            <button
              type="button" disabled={busy || machine === null}
              style={{ ...btn, display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%", textAlign: "left" }}
              onClick={() => void postTournament({ action: "enter" })}
            >
              <span>大会に参加する</span>
              <span>参加費 {tournament.fee} → 純益の上位3人が賞金を分け合う</span>
            </button>
          )}
          {tournament.status === "entry" && (
            <div>
              <p style={{ margin: "0 0 8px", fontSize: 13 }}>
                募集中（{tournament.entrantCount}/{tournament.maxEntrants}人）・賞金総額 {tournament.prizePool}
              </p>
              {tournament.entered ? (
                <p style={{ margin: 0, fontSize: 13 }}>参加済みです</p>
              ) : (
                <button
                  type="button" disabled={busy || machine === null}
                  style={{ ...btn, display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%", textAlign: "left" }}
                  onClick={() => void postTournament({ action: "enter" })}
                >
                  <span>参加する</span>
                  <span>参加費 {tournament.fee}</span>
                </button>
              )}
            </div>
          )}
          {tournament.status === "running" && (
            <div>
              <p style={{ margin: "0 0 8px", fontSize: 13 }}>
                対局中・賞金総額 {tournament.prizePool}
                {tournament.entered && ` — あなたの純益 ${tournament.myNet}${tournament.myRank ? `（${tournament.myRank}位）` : ""}`}
              </p>
              {tournament.standings.map((row) => (
                <div key={row.rank} style={{ display: "flex", gap: 8, fontSize: 12, padding: "3px 0" }}>
                  <span>{row.rank}位</span>
                  <span style={{ flex: 1 }} />
                  <span>{row.you ? "あなた" : "参加者"}</span>
                  <span>純益 {row.net}</span>
                </div>
              ))}
            </div>
          )}
          {tournament.status === "done" && (
            <div>
              <p style={{ margin: "0 0 8px", fontSize: 13 }}>
                {tournament.entrantCount < 2
                  ? "不成立 — 参加費を返金します"
                  : tournament.standings.length > 0 && tournament.standings[0].net > 0
                    ? "終了 — 賞金を配分しました"
                    : "終了 — 純益プラスの参加者がいませんでした"}
                {tournament.entered && ` — あなたの純益 ${tournament.myNet}${tournament.myRank ? `（${tournament.myRank}位）` : ""}`}
              </p>
              {tournament.standings.map((row) => (
                <div key={row.rank} style={{ display: "flex", gap: 8, fontSize: 12, padding: "3px 0" }}>
                  <span>{row.rank}位</span>
                  <span style={{ flex: 1 }} />
                  <span>{row.you ? "あなた" : "参加者"}</span>
                  <span>純益 {row.net}</span>
                </div>
              ))}
            </div>
          )}
          {tournamentMsg && <p role="status" style={{ margin: "10px 0 0" }}>{tournamentMsg}</p>}
        </div>
      )}

      {msg && <p role="status" style={{ margin: "10px 0 0" }}>{msg}</p>}
    </div>
  );

  function bjOutcomeFx(f: SessionView) {
    if (f.outcome === "blackjack") celebrate(0, bet, 3);
    else if (f.outcome === "win") celebrate(0, bet, 1);
    else if (f.outcome === "lose" || f.outcome === "bust" || f.outcome === "dealer_blackjack") sfxLose();
  }
}
