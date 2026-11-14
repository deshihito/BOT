"use client";
// ブラックジャック。ロジックは lib/blackjack.ts（配当 3:2、ディーラーは17でスタンド）。
// チップは端末内だけの遊び用ポイントで localStorage に保存する。サーバーへ送信しない。
import Link from "next/link";
import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";

// 3D シーンは three を含むため遅延読み込み（このページ専用チャンクに閉じる）。
const BlackjackScene3D = dynamic(() => import("./BlackjackScene3D"), { ssr: false });
import {
  BJ_INITIAL_CHIPS,
  BJ_MIN_BET,
  canDouble,
  createBlackjackGame,
  doubleDown,
  handValue,
  hit,
  nextRound,
  refillChips,
  stand,
  startRound,
  type BjState,
  type Card,
} from "@/lib/blackjack";
import { useGamesNav } from "../GamesShell";
import { tappableProps, useGesture } from "@/lib/gesture";
import { sfxCorrect, sfxDeal, sfxPlace, sfxPop, sfxTap, sfxWrong } from "@/lib/sfx";
import { ScorePop } from "../GameJuice";

const CHIPS_KEY = "ago-blackjack-chips";
const BET_OPTIONS = [10, 50, 100, 500] as const;

const SUIT_GLYPH: Record<Card["suit"], string> = {
  spade: "♠",
  heart: "♥",
  diamond: "♦",
  club: "♣",
};

function rankLabel(rank: number): string {
  if (rank === 1) return "A";
  if (rank === 11) return "J";
  if (rank === 12) return "Q";
  if (rank === 13) return "K";
  return String(rank);
}

function loadChips(): number {
  try {
    const v = Number(localStorage.getItem(CHIPS_KEY));
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : BJ_INITIAL_CHIPS;
  } catch {
    return BJ_INITIAL_CHIPS;
  }
}

function CardView({ card, hidden }: { card?: Card; hidden?: boolean }) {
  const red = card && (card.suit === "heart" || card.suit === "diamond");
  return (
    <span
      aria-hidden="true"
      className="juice-flip"
      style={{
        display: "inline-flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        width: 56,
        height: 78,
        borderRadius: 8,
        border: "1px solid #b9bdc9",
        background: hidden ? "#33509e" : "#ffffff",
        color: hidden ? "#ffffff" : red ? "#c62828" : "#1c2333",
        fontWeight: 700,
        fontSize: 20,
        lineHeight: 1.1,
        boxShadow: "0 1px 3px rgba(0,0,0,0.25)",
        userSelect: "none",
      }}
    >
      {hidden || !card ? (
        <span style={{ fontSize: 26 }}>🂠</span>
      ) : (
        <>
          <span>{rankLabel(card.rank)}</span>
          <span style={{ fontSize: 22 }}>{SUIT_GLYPH[card.suit]}</span>
        </>
      )}
    </span>
  );
}

export default function BlackjackClient() {
  const { prefix } = useGamesNav();
  const [webglFailed, setWebglFailed] = useState(false);
  const [state, setState] = useState<BjState>(() =>
    createBlackjackGame(Date.now() % 2147483647),
  );
  const [bet, setBet] = useState<number>(100);
  const [hydrated, setHydrated] = useState(false);

  // 保存済みチップで開始する（初回マウント時のみ）
  useEffect(() => {
    setState(createBlackjackGame(Date.now() % 2147483647, loadChips()));
    setHydrated(true);
  }, []);

  // チップが動いたら保存する（対局中は保存しない＝再読込で賭けが宙に浮かないように）
  useEffect(() => {
    if (!hydrated || state.phase === "player") return;
    try {
      localStorage.setItem(CHIPS_KEY, String(state.chips));
    } catch {
      /* 保存できなくても遊べる */
    }
  }, [hydrated, state.chips, state.phase]);

  // ラウンド確定時に結果へ効果音を連動させる。
  const settledSoundRef = useRef<BjState["result"]>(null);
  useEffect(() => {
    if (state.phase !== "settled" || !state.result) return;
    if (settledSoundRef.current === state.result) return;
    settledSoundRef.current = state.result;
    if (state.result.delta > 0) sfxCorrect();
    else if (state.result.delta < 0) sfxWrong();
    else sfxTap();
  }, [state.phase, state.result]);

  const player = handValue(state.playerHand);
  const dealerUp =
    state.phase === "player" && state.dealerHand.length > 0
      ? handValue([state.dealerHand[0]])
      : handValue(state.dealerHand);
  const broke = state.phase !== "player" && state.chips < BJ_MIN_BET;

  const dealRound = () => {
    sfxDeal();
    setState((s) => startRound(s, bet));
  };
  const doHit = () => {
    sfxDeal();
    setState((s) => hit(s));
  };
  const doStand = () => {
    sfxPlace();
    setState((s) => stand(s));
  };
  const doDouble = () => {
    sfxDeal();
    setState((s) => doubleDown(s));
  };
  const nextOrRefill = () => {
    if (broke) {
      sfxPop();
      setState((s) => refillChips(s));
    } else {
      sfxTap();
      setState((s) => nextRound(s));
    }
  };
  // テーブル（手札エリア）への直接ジェスチャに一本化:
  // 対局中: タップ=ヒット / 下スワイプ=スタンド / ダブルタップ=ダブル
  // ベット中: タップ=配る / 結果表示中: タップ=次のラウンド（チップ切れ時は再支給）
  const tapAction = () => {
    if (state.phase === "player") doHit();
    else if (state.phase === "betting") { if (!broke && bet <= state.chips) dealRound(); }
    else nextOrRefill();
  };
  const tableGesture = useGesture({
    onTap: tapAction,
    onDoubleTap: () => { if (state.phase === "player" && canDouble(state)) doDouble(); },
    onSwipe: (dir) => { if (state.phase === "player" && dir === "down") doStand(); },
  });

  const chipStyle = (amount: number): React.CSSProperties => ({
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

  // 2D テーブル（WebGL が使えない場合のフォールバックとしてそのまま使う）。
  const table2d = (
    <div {...tableGesture} style={{ display: "grid", gap: 18, maxWidth: 640, touchAction: "none", cursor: "pointer" }} aria-label="テーブル: タップで進行、対局中は下スワイプでスタンド、ダブルタップでダブル">
      <section aria-label="ディーラーの手札">
        <p style={{ margin: "0 0 6px", fontWeight: 700 }}>
          ディーラー
          {state.dealerHand.length > 0
            ? state.phase === "player"
              ? `（見えている合計 ${dealerUp.total}）`
              : `（合計 ${dealerUp.total}）`
            : ""}
        </p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", minHeight: 78 }}>
          {state.dealerHand.length === 0 && <span className="muted">まだ配られていません</span>}
          {state.dealerHand.map((card, i) =>
            state.phase === "player" && i === 1 ? (
              <CardView key={`${i}-hole`} hidden />
            ) : (
              <CardView key={`${i}-${card.suit}-${card.rank}`} card={card} />
            ),
          )}
        </div>
      </section>

      <section aria-label="あなたの手札">
        <p style={{ margin: "0 0 6px", fontWeight: 700 }}>
          あなた
          {state.playerHand.length > 0
            ? `（合計 ${player.total}${player.soft && player.total !== 21 ? "・ソフト" : ""}）`
            : ""}
        </p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", minHeight: 78 }}>
          {state.playerHand.length === 0 && <span className="muted">ベットして始めましょう</span>}
          {state.playerHand.map((card, i) => (
            <CardView key={`${i}-${card.suit}-${card.rank}`} card={card} />
          ))}
        </div>
      </section>
    </div>
  );

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>ブラックジャック</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>ブラックジャック</h1>
        <p className="muted">
          21に近づけてディーラーに勝つカードゲーム。ブラックジャックの配当は 3:2、
          ディーラーは17以上で止まります。チップは端末内だけの遊び用ポイントです。
        </p>
      </div>

      <p className="classic-status" role="status">
        チップ {state.chips}
        {state.phase !== "betting" ? ` ・ ベット ${state.bet}${state.doubled ? "（ダブル）" : ""}` : ""}
        {state.result
          ? ` ・ ${state.result.message}（${state.result.delta >= 0 ? "+" : ""}${state.result.delta}）`
          : ""}
        {state.phase === "settled" && state.result && state.result.delta !== 0 ? (
          <ScorePop key={state.chips} amount={state.result.delta} />
        ) : null}
      </p>

      {webglFailed ? table2d : (
        <div style={{ maxWidth: 640 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", marginBottom: 6 }}>
            <span style={{ fontWeight: 700 }}>
              ディーラー（奥）
              {state.dealerHand.length > 0
                ? state.phase === "player"
                  ? `・見えている合計 ${dealerUp.total}`
                  : `・合計 ${dealerUp.total}`
                : ""}
            </span>
            <span style={{ fontWeight: 700 }}>
              あなた（手前）
              {state.playerHand.length > 0
                ? `・合計 ${player.total}${player.soft && player.total !== 21 ? "・ソフト" : ""}`
                : ""}
            </span>
          </div>
          <BlackjackScene3D
            playerHand={state.playerHand}
            dealerHand={state.dealerHand}
            phase={state.phase}
            betAmount={state.phase === "betting" ? bet : state.bet}
            canDoubleNow={canDouble(state)}
            onTapAction={tapAction}
            onDouble={doDouble}
            onStand={doStand}
            onFail={() => setWebglFailed(true)}
            fallback={table2d}
          />
        </div>
      )}

      <div className="classic-controls" style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 16 }}>
        {state.phase === "betting" && !broke && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }} role="group" aria-label="ベット額チップ">
            {BET_OPTIONS.map((amount) => (
              <div
                key={amount}
                {...tappableProps(() => { if (amount <= state.chips) { sfxTap(); setBet(amount); } })}
                aria-disabled={amount > state.chips}
                style={chipStyle(amount)}
              >
                {amount}
              </div>
            ))}
          </div>
        )}
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          {state.phase === "betting" && !broke
            ? "チップをタップで選び、テーブルをタップで配る"
            : state.phase === "player"
              ? "手札をタップ=ヒット / 下へスワイプ=スタンド / ダブルタップ=ダブル"
              : broke
                ? "テーブルをタップでチップ再支給"
                : "テーブルをタップで次のラウンドへ"}
        </p>
      </div>
    </>
  );
}
