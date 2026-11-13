"use client";
// ルーレット（欧式）。ロジックは lib/roulette.ts。
// 賭けは1スピンに1つ。ホイールは結果ポケットへ簡易アニメーションで止める。
// チップは端末内だけの遊び用ポイントで、localStorage に保存する。
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  ROULETTE_START_CHIPS,
  ROULETTE_WHEEL,
  betLabel,
  createRoulette,
  pocketColor,
  refillChips,
  spinRoulette,
  type PlacedBet,
  type RouletteBet,
  type RouletteState,
} from "@/lib/roulette";
import { sfxCorrect, sfxSlide, sfxTap, sfxTick, sfxWrong } from "@/lib/sfx";
import { ScorePop } from "../GameJuice";
import { useGamesNav } from "../GamesShell";
import { tappableProps, useGesture } from "@/lib/gesture";

const CHIPS_KEY = "ago-roulette-chips";
const AMOUNTS = [10, 50, 100, 500] as const;

const OUTSIDE_BETS: RouletteBet[] = [
  { kind: "red" },
  { kind: "black" },
  { kind: "even" },
  { kind: "odd" },
  { kind: "low" },
  { kind: "high" },
  { kind: "dozen", value: 1 },
  { kind: "dozen", value: 2 },
  { kind: "dozen", value: 3 },
  { kind: "column", value: 1 },
  { kind: "column", value: 2 },
  { kind: "column", value: 3 },
];

function betKey(bet: RouletteBet): string {
  return `${bet.kind}:${bet.value ?? ""}`;
}

function pocketBg(pocket: number): string {
  const c = pocketColor(pocket);
  return c === "green" ? "#1e8449" : c === "red" ? "#c0392b" : "#22252a";
}

export default function RouletteClient() {
  const { prefix } = useGamesNav();
  const [state, setState] = useState<RouletteState>(() => createRoulette(Date.now() % 2147483647));
  const [selected, setSelected] = useState<RouletteBet>({ kind: "red" });
  const [straightNumber, setStraightNumber] = useState(7);
  const [amount, setAmount] = useState<number>(50);
  const [spinning, setSpinning] = useState(false);
  const [displayPocket, setDisplayPocket] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // 保存チップの読み込み（初回のみ）。
  useEffect(() => {
    try {
      const saved = Number(window.localStorage.getItem(CHIPS_KEY));
      if (Number.isFinite(saved) && saved > 0) {
        setState((s) => ({ ...s, chips: Math.floor(saved) }));
      }
    } catch {
      /* 保存できない環境では初期チップで開始 */
    }
    setHydrated(true);
  }, []);

  // 読み込みが終わるまでは保存しない（初期値で保存済みチップを上書きしないため）。
  // 回転中は state 自体が結果確定まで更新されないので、賭けが宙に浮く保存は起きない。
  useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem(CHIPS_KEY, String(state.chips));
    } catch {
      /* プレイに影響しない */
    }
  }, [hydrated, state.chips]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  const currentBet: RouletteBet =
    selected.kind === "straight" ? { kind: "straight", value: straightNumber } : selected;

  const onSpin = () => {
    if (spinning) return;
    const placed: PlacedBet = { ...currentBet, amount };
    let next: RouletteState;
    try {
      next = spinRoulette(state, [placed]);
    } catch (e) {
      sfxWrong();
      setError(e instanceof Error ? e.message : "スピンできませんでした");
      return;
    }
    setError(null);
    setSpinning(true);
    sfxSlide();
    const resultPocket = next.lastResult?.pocket ?? 0;
    let ticks = 0;
    timerRef.current = setInterval(() => {
      ticks += 1;
      if (ticks % 4 === 0) sfxTick();
      setDisplayPocket(ROULETTE_WHEEL[Math.floor(Math.random() * ROULETTE_WHEEL.length)]);
      if (ticks >= 14) {
        if (timerRef.current) clearInterval(timerRef.current);
        timerRef.current = null;
        setDisplayPocket(resultPocket);
        const delta = next.lastResult?.delta ?? 0;
        if (delta > 0) sfxCorrect();
        else if (delta < 0) sfxWrong();
        setState(next);
        setSpinning(false);
      }
    }, 70);
  };

  // ホイールをフリック/スワイプで回す（スピンボタンは廃止）。チップ切れ時はホイールタップで再支給。
  const wheelGesture = useGesture({
    onSwipe: () => onSpin(),
    onTap: () => { if (state.chips <= 0 && !spinning) setState((s) => refillChips(s)); },
  });

  const last = state.lastResult;
  const shownPocket = spinning || displayPocket !== null ? displayPocket : last?.pocket ?? null;

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>ルーレット</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>ルーレット</h1>
        <p className="muted">欧式（0が1つ）のルーレット。賭けの種類と金額をタップで選び、ホイールをフリックして回します。</p>
      </div>

      <div style={{ textAlign: "center", margin: "8px 0 4px" }} aria-live="polite">
        <div {...wheelGesture}
          key={spinning ? "spinning" : state.spins}
          className={!spinning && last ? "juice-pop" : undefined}
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 96,
            height: 96,
            borderRadius: "50%",
            background: shownPocket !== null ? pocketBg(shownPocket) : "#6b7280",
            color: "#fff",
            fontSize: 36,
            fontWeight: 800,
            border: "6px solid #d9a41c",
            fontVariantNumeric: "tabular-nums",
            touchAction: "none",
            cursor: "grab",
            margin: "0 auto",
          }}
        >
          {shownPocket !== null ? shownPocket : "?"}
        </div>
        <p className="classic-status" role="status">
          チップ {state.chips} ・ スピン {state.spins} 回
          {!spinning && last ? ` ・ 前回 ${last.pocket}（${last.color === "green" ? "緑" : last.color === "red" ? "赤" : "黒"}） ${last.delta >= 0 ? `+${last.delta}` : last.delta}` : ""}
          {!spinning && last && last.delta !== 0 ? <ScorePop key={state.spins} amount={last.delta} /> : null}
          {spinning ? " ・ 回転中…" : ""}
        </p>
      </div>

      {!spinning && last ? (
        <p style={{ textAlign: "center", margin: "0 0 8px", fontSize: 14 }}>
          {last.details.map((d, i) => (
            <span key={i}>
              {betLabel(d.bet)} に {d.bet.amount} → {d.win ? `当たり！払い戻し ${d.payout}` : "外れ"}
            </span>
          ))}
        </p>
      ) : null}
      {error ? (
        <p role="alert" style={{ textAlign: "center", color: "#b91c1c", fontWeight: 700 }}>
          {error}
        </p>
      ) : null}

      <div style={{ maxWidth: 560, margin: "0 auto" }}>
        <p style={{ fontWeight: 700, margin: "10px 0 6px" }}>賭けの種類</p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {OUTSIDE_BETS.map((bet) => (
            <div
              key={betKey(bet)}
              {...tappableProps(() => { if (!spinning) { sfxTap(); setSelected(bet); } })}
              className={betKey(selected) === betKey(bet) ? "classic-btn classic-btn-active" : "classic-btn"}
              aria-pressed={betKey(selected) === betKey(bet)}
              aria-disabled={spinning}
            >
              {betLabel(bet)}
            </div>
          ))}
          <div
            {...tappableProps(() => { if (!spinning) { sfxTap(); setSelected({ kind: "straight", value: straightNumber }); } })}
            className={selected.kind === "straight" ? "classic-btn classic-btn-active" : "classic-btn"}
            aria-pressed={selected.kind === "straight"}
            aria-disabled={spinning}
          >
            単数（配当35倍）
          </div>
          {selected.kind === "straight" ? (
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              数字
              <input
                type="number"
                min={0}
                max={36}
                disabled={spinning}
                value={straightNumber}
                onChange={(e) => {
                  const v = Math.min(36, Math.max(0, Math.floor(Number(e.target.value) || 0)));
                  setStraightNumber(v);
                }}
                style={{ width: 72, minHeight: 40, padding: "6px 8px", borderRadius: 8, border: "1px solid #d8d8d8" }}
              />
            </label>
          ) : null}
        </div>

        <p style={{ fontWeight: 700, margin: "14px 0 6px" }}>賭け金</p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {AMOUNTS.map((a) => (
            <div
              key={a}
              {...tappableProps(() => { if (!spinning) { sfxTap(); setAmount(a); } })}
              className={amount === a ? "classic-btn classic-btn-active" : "classic-btn"}
              aria-pressed={amount === a}
              aria-disabled={spinning}
              style={{ borderRadius: 999 }}
            >
              {a}
            </div>
          ))}
        </div>

        <p className="muted" style={{ fontSize: 13, margin: "12px 0 0" }}>
          {state.chips <= 0
            ? "チップ切れ: ホイールをタップで再支給"
            : `ホイールをフリックで回す（${betLabel(currentBet)}に${amount}）`}
        </p>

        {state.history.length > 0 ? (
          <p style={{ fontSize: 13, color: "#6b7280" }}>履歴: {state.history.slice(-15).join(" / ")}</p>
        ) : null}
      </div>
    </>
  );
}
