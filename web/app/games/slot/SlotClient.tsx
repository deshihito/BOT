"use client";
// スロット。ロジックは lib/slot.ts（確率表と配当表は lib 内で明示）。
// リールは左から順に止まるアニメーションで、最終結果は lib のスピン結果と一致させる。
// チップは端末内だけの遊び用ポイントで localStorage に保存する。サーバーへ送信しない。
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  SLOT_CHERRY_PAIR_MULT,
  SLOT_INITIAL_CHIPS,
  SLOT_MIN_BET,
  SLOT_SYMBOLS,
  createSlotGame,
  refillChips,
  slotSymbol,
  spin,
  type SlotState,
  type SlotSymbolId,
} from "@/lib/slot";
import { sfxCorrect, sfxSlide, sfxTap, sfxTick, sfxWin } from "@/lib/sfx";
import { ScorePop } from "../GameJuice";
import { useGamesNav } from "../GamesShell";

const CHIPS_KEY = "ago-slot-chips";
const BET_OPTIONS = [10, 50, 100, 500] as const;

function loadChips(): number {
  try {
    const v = Number(localStorage.getItem(CHIPS_KEY));
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : SLOT_INITIAL_CHIPS;
  } catch {
    return SLOT_INITIAL_CHIPS;
  }
}

const btnStyle: React.CSSProperties = {
  padding: "10px 22px",
  borderRadius: 999,
  border: "1px solid #8a90a3",
  background: "#22304f",
  color: "#fff",
  fontSize: 16,
  fontWeight: 700,
  cursor: "pointer",
  minHeight: 44,
};
const btnDisabled: React.CSSProperties = { ...btnStyle, opacity: 0.4, cursor: "default" };

export default function SlotClient() {
  const { prefix } = useGamesNav();
  const [state, setState] = useState<SlotState>(() => createSlotGame(Date.now() % 2147483647));
  const [bet, setBet] = useState<number>(100);
  const [hydrated, setHydrated] = useState(false);
  const [spinning, setSpinning] = useState(false);
  const [stopped, setStopped] = useState(3); // 止まっているリール数
  const [display, setDisplay] = useState<SlotSymbolId[]>(["seven", "star", "cherry"]);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pendingRef = useRef<SlotState | null>(null);
  const stoppedRef = useRef(3);

  useEffect(() => {
    setState(createSlotGame(Date.now() % 2147483647, loadChips()));
    setHydrated(true);
    return () => {
      timersRef.current.forEach(clearTimeout);
      timersRef.current = [];
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  useEffect(() => {
    if (!hydrated || spinning) return;
    try {
      localStorage.setItem(CHIPS_KEY, String(state.chips));
    } catch {
      /* 保存できなくても遊べる */
    }
  }, [hydrated, spinning, state.chips]);

  const startSpin = () => {
    if (spinning || bet > state.chips || bet < SLOT_MIN_BET) return;
    const result = spin(state, bet);
    if (result === state) return;
    sfxSlide();
    pendingRef.current = result;
    setSpinning(true);
    setStopped(0);
    stoppedRef.current = 0;
    const finalReels = result.reels ?? display;
    // 回転中はまだ止まっていないリールだけランダム表示を回し、左から順に最終結果で止める
    intervalRef.current = setInterval(() => {
      setDisplay((d) =>
        d.map((sym, idx) =>
          idx < stoppedRef.current
            ? sym
            : SLOT_SYMBOLS[Math.floor(Math.random() * SLOT_SYMBOLS.length)].id,
        ),
      );
    }, 80);
    [650, 1150, 1650].forEach((ms, i) => {
      const t = setTimeout(() => {
        sfxTick();
        stoppedRef.current = i + 1;
        setStopped(i + 1);
        setDisplay((d) => {
          const next = [...d];
          for (let k = 0; k <= i; k++) next[k] = finalReels[k];
          return next;
        });
        if (i === 2) {
          if (intervalRef.current) clearInterval(intervalRef.current);
          intervalRef.current = null;
          setSpinning(false);
          if (pendingRef.current) {
            const delta = pendingRef.current.result?.delta ?? 0;
            if (delta > 0) {
              if (delta >= bet * 5) sfxWin();
              else sfxCorrect();
            }
            setState(pendingRef.current);
          }
          pendingRef.current = null;
        }
      }, ms);
      timersRef.current.push(t);
    });
  };

  const broke = !spinning && state.chips < SLOT_MIN_BET;
  const chipBtn = (amount: number): React.CSSProperties => ({
    padding: "8px 14px",
    borderRadius: 999,
    border: bet === amount ? "2px solid #f2b33d" : "1px solid #8a90a3",
    background: bet === amount ? "#4a3a10" : "#182238",
    color: "#fff",
    fontSize: 15,
    fontWeight: 700,
    cursor: "pointer",
    minHeight: 40,
    opacity: amount > state.chips ? 0.35 : 1,
  });

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>スロット</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>スロット</h1>
        <p className="muted">ベットを選んでスピン。リールは左から順に止まります。配当は下の表のとおりです。</p>
      </div>

      <p className="classic-status" role="status">
        チップ {state.chips} ・ {state.spins} スピン
        {!spinning && state.result
          ? ` ・ ${state.result.message}（${state.result.delta >= 0 ? "+" : ""}${state.result.delta}）`
          : ""}
        {!spinning && state.result && state.result.delta !== 0 ? (
          <ScorePop key={state.spins} amount={state.result.delta} />
        ) : null}
        {spinning ? " ・ 回転中…" : ""}
      </p>

      <div
        role="img"
        aria-label={`リール: ${display.map((id) => slotSymbol(id).label).join("、")}`}
        className={!spinning && state.result && state.result.delta > 0 ? "juice-pulse" : undefined}
        style={{
          display: "flex",
          gap: 10,
          justifyContent: "center",
          maxWidth: 420,
          margin: "10px 0 18px",
          padding: 16,
          borderRadius: 16,
          background: "#182238",
          boxShadow: "inset 0 0 0 2px #f2b33d",
        }}
      >
        {display.map((id, i) => (
          <div
            key={i}
            style={{
              width: 92,
              height: 92,
              borderRadius: 12,
              background: "#ffffff",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 52,
              opacity: spinning && stopped <= i ? 0.75 : 1,
              transform: spinning && stopped <= i ? "translateY(2px)" : "none",
              transition: "opacity 0.15s",
              userSelect: "none",
            }}
          >
            {slotSymbol(id).glyph}
          </div>
        ))}
      </div>

      <div className="classic-controls" style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        {!broke && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }} role="group" aria-label="ベット額">
            {BET_OPTIONS.map((amount) => (
              <button
                key={amount}
                type="button"
                style={chipBtn(amount)}
                disabled={spinning || amount > state.chips}
                onClick={() => {
                  sfxTap();
                  setBet(amount);
                }}
              >
                {amount}
              </button>
            ))}
          </div>
        )}
        {!broke ? (
          <button
            type="button"
            style={!spinning && bet <= state.chips ? btnStyle : btnDisabled}
            disabled={spinning || bet > state.chips}
            onClick={startSpin}
          >
            スピン
          </button>
        ) : (
          <button type="button" style={btnStyle} onClick={() => setState((s) => refillChips(s))}>
            チップを再支給（{SLOT_INITIAL_CHIPS}）
          </button>
        )}
      </div>

      <section aria-label="配当表" style={{ marginTop: 22, maxWidth: 420 }}>
        <h2 style={{ fontSize: 16, margin: "0 0 8px" }}>配当表（3つ揃い）</h2>
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 4 }}>
          {SLOT_SYMBOLS.map((s) => (
            <li key={s.id} style={{ display: "flex", justifyContent: "space-between", fontSize: 15 }}>
              <span>
                {s.glyph} {s.label} ×3
              </span>
              <span style={{ fontWeight: 700 }}>{s.three} 倍</span>
            </li>
          ))}
          <li style={{ display: "flex", justifyContent: "space-between", fontSize: 15 }}>
            <span>桜桜 チェリー×2（先頭2つ）</span>
            <span style={{ fontWeight: 700 }}>{SLOT_CHERRY_PAIR_MULT} 倍</span>
          </li>
        </ul>
        <p className="muted" style={{ fontSize: 13 }}>
          回転中の表示は演出です。結果はスピンを押した時点で決まっています。
        </p>
      </section>
    </>
  );
}
