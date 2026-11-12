"use client";
// ドローポーカー（ビデオポーカー式の配当制）。ロジックは lib/drawpoker.ts。
// チップは端末内だけの遊び用ポイントで、保存はラウンド確定（settled）時に限る。
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  DP_HAND_TABLE,
  DP_INITIAL_CHIPS,
  DP_MIN_BET,
  createDrawPokerGame,
  drawCards,
  evaluateHand,
  refillDpChips,
  startRound,
  suggestHolds,
  type DpCard,
  type DpState,
} from "@/lib/drawpoker";
import { useGamesNav } from "../GamesShell";
import { sfxCorrect, sfxDeal, sfxFlip, sfxPop, sfxTap, sfxWrong } from "@/lib/sfx";
import { ScorePop } from "../GameJuice";

const CHIPS_KEY = "ago-drawpoker-chips";
const BET_OPTIONS = [10, 50, 100, 500] as const;

function loadChips(): number {
  try {
    const v = Number(localStorage.getItem(CHIPS_KEY));
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : DP_INITIAL_CHIPS;
  } catch {
    return DP_INITIAL_CHIPS;
  }
}

const SUIT_GLYPHS: Record<DpCard["suit"], string> = { spade: "♠", heart: "♥", diamond: "♦", club: "♣" };

function rankLabel(rank: number): string {
  if (rank === 1) return "A";
  if (rank <= 10) return String(rank);
  return { 11: "J", 12: "Q", 13: "K" }[rank as 11 | 12 | 13];
}

function isRed(card: DpCard): boolean {
  return card.suit === "heart" || card.suit === "diamond";
}

const mainBtn: React.CSSProperties = {
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
const mainBtnDisabled: React.CSSProperties = { ...mainBtn, opacity: 0.4, cursor: "default" };

export default function DrawPokerClient() {
  const { prefix } = useGamesNav();
  const [state, setState] = useState<DpState>(() => createDrawPokerGame(Date.now() % 2147483647));
  const [bet, setBet] = useState<number>(100);
  /** 交換する札の index 集合。 */
  const [discards, setDiscards] = useState<number[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const savedRoundRef = useRef(0);

  useEffect(() => {
    setState(createDrawPokerGame(Date.now() % 2147483647, loadChips()));
    setHydrated(true);
  }, []);

  // チップ保存はラウンド確定時に限る（対局中は保存しない）。
  useEffect(() => {
    if (!hydrated) return;
    if (state.phase !== "settled" || state.round === savedRoundRef.current) return;
    savedRoundRef.current = state.round;
    try {
      localStorage.setItem(CHIPS_KEY, String(state.chips));
    } catch {
      // 保存失敗はプレイに影響しない。
    }
  }, [hydrated, state.phase, state.round, state.chips]);

  // ラウンド確定時に収支へ効果音を連動させる。
  const settledSoundRef = useRef(0);
  useEffect(() => {
    if (state.phase !== "settled" || !state.result) return;
    if (settledSoundRef.current === state.round) return;
    settledSoundRef.current = state.round;
    if (state.result.delta > 0) sfxCorrect();
    else if (state.result.delta < 0) sfxWrong();
    else sfxTap();
  }, [state.phase, state.round, state.result]);

  const deal = () => {
    const next = startRound(state, bet);
    if (next === state) return;
    sfxDeal();
    setDiscards([]);
    setState(next);
    // 簡易戦略で初期の「残す札」を選び、捨て札をその補集合にする。
    const holds = new Set(suggestHolds(next.hand));
    setDiscards(next.hand.map((_, i) => i).filter((i) => !holds.has(i)));
  };

  const toggleDiscard = (index: number) => {
    if (state.phase !== "draw") return;
    sfxTap();
    setDiscards((d) => (d.includes(index) ? d.filter((x) => x !== index) : [...d, index]));
  };

  const confirmDraw = () => {
    sfxFlip();
    setState((s) => drawCards(s, discards));
  };

  const currentHand = state.hand.length === 5 ? evaluateHand(state.hand) : null;
  const broke = state.phase !== "draw" && state.chips < DP_MIN_BET;

  const chipBtn = (amount: number): React.CSSProperties => ({
    padding: "8px 14px",
    borderRadius: 999,
    border: bet === amount ? "2px solid #f59e0b" : "1px solid #8a90a3",
    background: bet === amount ? "#fef3c7" : "#fff",
    color: "#1f2937",
    fontSize: 14,
    fontWeight: 700,
    cursor: "pointer",
    minHeight: 40,
  });

  return (
    <div style={{ maxWidth: 560, margin: "0 auto", padding: "16px 12px 40px" }}>
      <p style={{ margin: "0 0 8px" }}>
        <Link href={`${prefix}/games`} style={{ color: "#38bdf8", fontSize: 14 }}>
          ← ゲーム一覧へ
        </Link>
      </p>
      <h1 style={{ fontSize: 22, margin: "0 0 6px" }}>♠ ドローポーカー</h1>
      <p style={{ margin: "0 0 12px", color: "#64748b", fontSize: 14, lineHeight: 1.6 }}>
        ベット額を選んで「配る」を押し、交換したい札をタップで選んで確定します。
      </p>

      <p style={{ fontSize: 16, fontWeight: 700, margin: "0 0 10px" }}>
        チップ: {state.chips}
        {state.phase !== "betting" && <span style={{ marginLeft: 12, fontWeight: 400 }}>ベット: {state.bet}</span>}
      </p>

      {state.phase === "draw" && (
        <p role="status" style={{ minHeight: 22, margin: "0 0 8px", fontWeight: 700 }}>
          現在の役: {currentHand?.name} ／ 交換する札をタップで選んでください
        </p>
      )}
      {state.phase === "settled" && state.result && (
        <p role="status" style={{ minHeight: 22, margin: "0 0 8px", fontWeight: 700, color: state.result.delta >= 0 ? "#16a34a" : "#dc2626" }}>
          {state.result.message}（収支 {state.result.delta >= 0 ? "+" : ""}{state.result.delta}）
          {state.result.delta !== 0 ? <ScorePop key={state.round} amount={state.result.delta} /> : null}
        </p>
      )}

      <div style={{ display: "flex", gap: 8, justifyContent: "center", margin: "14px 0 18px", flexWrap: "wrap" }}>
        {state.hand.length === 0 &&
          [0, 1, 2, 3, 4].map((i) => (
            <div
              key={i}
              style={{
                width: 60, height: 86, borderRadius: 8, border: "1px dashed #cbd5e1",
                display: "flex", alignItems: "center", justifyContent: "center", color: "#cbd5e1", fontSize: 20,
              }}
            >
              ?
            </div>
          ))}
        {state.hand.map((card, i) => {
          const dropping = discards.includes(i);
          return (
            <button
              key={`${state.round}-${i}-${card.suit}-${card.rank}`}
              className="juice-flip"
              type="button"
              disabled={state.phase !== "draw"}
              aria-pressed={dropping}
              aria-label={`${SUIT_GLYPHS[card.suit]}の${rankLabel(card.rank)}${dropping ? "（交換する）" : "（残す）"}`}
              onClick={() => toggleDiscard(i)}
              style={{
                width: 60,
                height: 86,
                borderRadius: 8,
                border: dropping ? "2px solid #dc2626" : "2px solid #334155",
                background: dropping ? "#fee2e2" : "#fff",
                color: isRed(card) ? "#dc2626" : "#1f2937",
                cursor: state.phase === "draw" ? "pointer" : "default",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: 2,
                transform: dropping ? "translateY(6px)" : undefined,
                opacity: dropping ? 0.75 : 1,
              }}
            >
              <span style={{ fontSize: 22, lineHeight: 1 }}>{SUIT_GLYPHS[card.suit]}</span>
              <span style={{ fontSize: 20, fontWeight: 700, lineHeight: 1 }}>{rankLabel(card.rank)}</span>
              <span style={{ fontSize: 10, fontWeight: 700 }}>{dropping ? "交換" : "残す"}</span>
            </button>
          );
        })}
      </div>

      {state.phase === "betting" || state.phase === "settled" ? (
        <div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
            {BET_OPTIONS.map((amount) => (
              <button key={amount} type="button" style={chipBtn(amount)} onClick={() => { sfxTap(); setBet(amount); }} aria-pressed={bet === amount}>
                {amount}
              </button>
            ))}
          </div>
          {broke ? (
            <button type="button" style={mainBtn} onClick={() => { sfxPop(); setState((s) => refillDpChips(s)); }}>
              チップを再支給する（{DP_INITIAL_CHIPS}）
            </button>
          ) : (
            <button
              type="button"
              style={bet > state.chips ? mainBtnDisabled : mainBtn}
              disabled={bet > state.chips}
              onClick={deal}
            >
              {state.phase === "settled" ? "次のラウンドを配る" : "配る"}
            </button>
          )}
          {bet > state.chips && !broke && (
            <p style={{ color: "#dc2626", fontSize: 14 }}>チップが足りません。ベットを下げてください。</p>
          )}
        </div>
      ) : (
        <button type="button" style={mainBtn} onClick={confirmDraw}>
          {discards.length === 0 ? "交換せずに確定" : `${discards.length}枚を交換して確定`}
        </button>
      )}

      <details style={{ marginTop: 24 }}>
        <summary style={{ cursor: "pointer", fontWeight: 700, fontSize: 14 }}>配当表（ベットの倍率）</summary>
        <table style={{ borderCollapse: "collapse", marginTop: 8, fontSize: 14 }}>
          <tbody>
            {DP_HAND_TABLE.filter((r) => r.multiplier > 0).map((row) => (
              <tr key={row.category}>
                <td style={{ border: "1px solid #e2e8f0", padding: "4px 10px" }}>{row.name}</td>
                <td style={{ border: "1px solid #e2e8f0", padding: "4px 10px", textAlign: "right" }}>{row.multiplier}倍</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p style={{ fontSize: 12, color: "#64748b" }}>ワンペアは J・Q・K・A のペアのときだけ配当があります。</p>
      </details>
    </div>
  );
}
