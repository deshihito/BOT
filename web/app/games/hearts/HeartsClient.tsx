"use client";
// ハーツ（自分＋CPU3人）。ロジックは lib/hearts.ts。
// ベスト記録の設計: localStorage `ago-hearts-best` に「優勝した回数」を保存する。
// 端末内で完結し、サーバーへ送信しない。
import Link from "next/link";
import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";

// 3D シーンは three を含むため遅延読み込み（このページ専用チャンクに閉じる）。
const HeartsScene3D = dynamic(() => import("./HeartsScene3D"), { ssr: false });
import {
  PASS_DIR_LABELS,
  cardRank,
  cardSuit,
  createHeartsGame,
  legalPlays,
  nextHand,
  playCard,
  pointsOfCard,
  submitPass,
  type HeartsState,
} from "@/lib/hearts";
import { sfxDeal, sfxFlip, sfxLose, sfxTap, sfxWin } from "@/lib/sfx";
import { EndScreen } from "../GameJuice";
import { useGamesNav } from "../GamesShell";

const BEST_KEY = "ago-hearts-best";

const SUIT_GLYPH = { spade: "♠", heart: "♥", diamond: "♦", club: "♣" } as const;
const SUIT_NAME = { spade: "スペード", heart: "ハート", diamond: "ダイヤ", club: "クラブ" } as const;

function rankLabel(rank: number): string {
  if (rank === 1) return "A";
  if (rank === 11) return "J";
  if (rank === 12) return "Q";
  if (rank === 13) return "K";
  return String(rank);
}

function cardLabel(id: number): string {
  return `${SUIT_NAME[cardSuit(id)]}の${rankLabel(cardRank(id))}`;
}

function CardView({ id, small }: { id: number; small?: boolean }) {
  const suit = cardSuit(id);
  const red = suit === "heart" || suit === "diamond";
  const size = small ? 40 : 52;
  return (
    <span
      aria-hidden="true"
      style={{
        display: "inline-flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        width: size,
        height: Math.round(size * 1.35),
        borderRadius: 6,
        border: "1px solid var(--line, #ccc)",
        background: "#fff",
        color: red ? "#c0392b" : "#222",
        fontWeight: 700,
        lineHeight: 1.05,
        flexShrink: 0,
      }}
    >
      <span style={{ fontSize: small ? 13 : 16 }}>{rankLabel(cardRank(id))}</span>
      <span style={{ fontSize: small ? 13 : 16 }}>{SUIT_GLYPH[suit]}</span>
    </span>
  );
}

function loadWins(): number {
  try {
    const v = Number(localStorage.getItem(BEST_KEY));
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
  } catch {
    return 0;
  }
}

export default function HeartsClient() {
  const { prefix } = useGamesNav();
  const [webglFailed, setWebglFailed] = useState(false);
  const [state, setState] = useState<HeartsState>(() => createHeartsGame(Date.now() % 2147483647));
  const [selectedPass, setSelectedPass] = useState<number[]>([]);
  const [wins, setWins] = useState(0);
  const countedSeed = useRef<number | null>(null);
  const endSfxRef = useRef<number | null>(null);

  useEffect(() => {
    setWins(loadWins());
  }, []);

  useEffect(() => {
    if (state.phase !== "finished" || !state.winners?.includes(0)) return;
    if (countedSeed.current === state.seed) return;
    countedSeed.current = state.seed;
    const next = loadWins() + 1;
    setWins(next);
    try {
      localStorage.setItem(BEST_KEY, String(next));
    } catch {
      // 保存失敗はプレイに影響しない。
    }
  }, [state.phase, state.winners, state.seed]);

  useEffect(() => {
    if (state.phase !== "finished") return;
    if (endSfxRef.current === state.seed) return;
    endSfxRef.current = state.seed;
    if (state.winners?.includes(0)) sfxWin();
    else sfxLose();
  }, [state.phase, state.seed, state.winners]);

  const restart = () => {
    sfxTap();
    endSfxRef.current = null;
    setState(createHeartsGame(Date.now() % 2147483647));
    setSelectedPass([]);
  };

  const togglePassCard = (id: number) => {
    sfxTap();
    setSelectedPass((prev) => {
      if (prev.includes(id)) return prev.filter((c) => c !== id);
      if (prev.length >= 3) return prev;
      return [...prev, id];
    });
  };

  const legal = legalPlays(state);
  const isPassPhase = state.phase === "pass";
  const trickPoints = state.trick.reduce((s, p) => s + pointsOfCard(p.card), 0);
  // 3D シーンの手札タップ（合法判定・パス可否はこの既存ハンドラ側にあり、シーンは呼ぶだけ）。
  const handleCardTap = (id: number) => {
    if (isPassPhase) togglePassCard(id);
    else if (legal.includes(id)) {
      sfxFlip();
      setState((s) => playCard(s, id));
    }
  };


  // 2D テーブル（場のトリック＋手札。WebGL が使えない場合のフォールバック）。
  const table2d = (
    <>
      <section aria-label="場のトリック" style={{ margin: "12px 0" }}>
        <h2 style={{ fontSize: 16, margin: "0 0 6px" }}>
          場のカード{state.trick.length > 0 ? `（このトリックの点: ${trickPoints}）` : ""}
        </h2>
        {state.trick.length === 0 && !state.lastTrick && <p className="muted">まだカードが出ていません。</p>}
        {state.trick.length === 0 && state.lastTrick && (
          <p className="muted">
            直前のトリックは {state.players[state.lastTrick.winner].name} が取りました。
          </p>
        )}
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {state.trick.map((play) => (
            <div
              key={`${play.seat}-${play.card}-${state.tricksPlayed}`}
              className="juice-flip"
              style={{ textAlign: "center" }}
            >
              <CardView id={play.card} />
              <div style={{ fontSize: 12 }}>{state.players[play.seat].name}</div>
            </div>
          ))}
        </div>
        {state.lastTrick && state.trick.length > 0 && (
          <p className="muted" style={{ marginTop: 6 }}>
            直前のトリック: {state.lastTrick.plays.map((p) => cardLabel(p.card)).join(" / ")} →{" "}
            {state.players[state.lastTrick.winner].name} が取りました。
          </p>
        )}
      </section>

      <section aria-label="あなたの手札">
        <h2 style={{ fontSize: 16, margin: "0 0 6px" }}>
          あなたの手札
          {isPassPhase ? `（${PASS_DIR_LABELS[state.passDir]}パスする3枚を選んでください）` : ""}
        </h2>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {state.players[0].hand.map((id) => {
            const playable = !isPassPhase && legal.includes(id);
            const selected = selectedPass.includes(id);
            const disabled = isPassPhase ? false : !playable;
            return (
              <button
                key={id}
                type="button"
                aria-label={cardLabel(id)}
                aria-pressed={isPassPhase ? selected : undefined}
                disabled={disabled && !isPassPhase}
                onClick={() => {
                  if (isPassPhase) togglePassCard(id);
                  else if (playable) {
                    sfxFlip();
                    setState((s) => playCard(s, id));
                  }
                }}
                style={{
                  padding: 2,
                  border: selected ? "2px solid var(--accent, #2f6db3)" : "2px solid transparent",
                  borderRadius: 8,
                  background: "transparent",
                  cursor: disabled && !isPassPhase ? "default" : "pointer",
                  opacity: !isPassPhase && state.phase === "play" && !playable ? 0.45 : 1,
                  transform: selected ? "translateY(-6px)" : undefined,
                  minHeight: 44,
                }}
              >
                <CardView id={id} />
              </button>
            );
          })}
        </div>
        {state.phase === "play" && state.turn !== 0 && <p className="muted">CPUの手番です。</p>}
      </section>
    </>
  );

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>ハーツ</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>ハーツ</h1>
        <p className="muted">
          手番になったら、手札から出せるカードを選んで出します。ハートは各1点、スペードのQは13点のマイナス点です。
        </p>
      </div>

      <div className="classic-controls" role="group" aria-label="操作">
        <button type="button" className="classic-btn" onClick={restart}>
          もう一度
        </button>
        {isPassPhase && (
          <button
            type="button"
            className="classic-btn classic-btn-active"
            disabled={selectedPass.length !== 3}
            onClick={() => {
              sfxDeal();
              setState((s) => submitPass(s, selectedPass));
              setSelectedPass([]);
            }}
          >
            {PASS_DIR_LABELS[state.passDir]}パスする（{selectedPass.length}/3）
          </button>
        )}
        {state.phase === "handEnd" && (
          <button
            type="button"
            className="classic-btn classic-btn-active"
            onClick={() => {
              sfxDeal();
              setState((s) => nextHand(s));
            }}
          >
            次のハンドへ
          </button>
        )}
      </div>

      <p className="classic-status" role="status">
        ハンド {state.handNumber + 1} ・ ハートは{state.heartsBroken ? "切れました" : "まだ切れていません"}
        {wins > 0 ? ` ・ 優勝回数 ${wins}` : ""} ・ {state.message}
      </p>

      <div
        role="group"
        aria-label="スコア"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
          gap: 8,
          margin: "12px 0",
        }}
      >
        {state.players.map((p) => (
          <div
            key={p.seat}
            style={{
              border: "1px solid var(--line, #ddd)",
              borderRadius: 8,
              padding: "8px 10px",
              background:
                state.phase === "play" && state.turn === p.seat ? "var(--accent-soft, #eef4ff)" : undefined,
            }}
          >
            <div style={{ fontWeight: 700 }}>
              {p.name}
              {state.phase === "play" && state.turn === p.seat ? "（手番）" : ""}
              {state.winners?.includes(p.seat) ? " （優勝）" : ""}
            </div>
            <div>
              {p.score} 点
              {state.handPoints ? ` （このハンド +${state.handPoints[p.seat]}）` : ""}
            </div>
            <div className="muted" style={{ fontSize: 13 }}>
              手札 {p.hand.length} 枚 ・ 取った点 {p.taken.reduce((s, c) => s + pointsOfCard(c), 0)}
            </div>
          </div>
        ))}
      </div>

      {webglFailed ? table2d : (
        <HeartsScene3D
          myHand={state.players[0].hand}
          trick={state.trick}
          players={state.players.map((pl) => ({ seat: pl.seat, handCount: pl.hand.length }))}
          legal={legal}
          selectedPass={selectedPass}
          phase={state.phase}
          isPassPhase={isPassPhase}
          isMyTurn={state.phase === "play" && state.turn === 0}
          onCardTap={handleCardTap}
          onFail={() => setWebglFailed(true)}
          fallback={table2d}
        />
      )}

      {state.phase === "handEnd" && state.handPoints && (
        <section aria-label="ハンド結果" className="juice-slide" style={{ marginTop: 12 }}>
          <h2 style={{ fontSize: 16, margin: "0 0 6px" }}>ハンド結果</h2>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {state.players.map((p) => (
              <li key={p.seat}>
                {p.name}: +{state.handPoints?.[p.seat]} 点（合計 {p.score} 点）
                {state.moonShooter === p.seat ? "（シュート・ザ・ムーン）" : ""}
              </li>
            ))}
          </ul>
        </section>
      )}

      {state.phase === "finished" && (
        <EndScreen
          outcome={state.winners?.includes(0) ? "win" : "lose"}
          score={state.players[0].score}
          scoreLabel="あなたの点数"
          onRetry={restart}
        >
          <p role="status" style={{ margin: 0 }}>
            {state.message}
          </p>
          <ul style={{ margin: 0, paddingLeft: 18, textAlign: "left" }}>
            {state.players.map((p) => (
              <li key={p.seat}>
                {p.name}: {p.score} 点{state.winners?.includes(p.seat) ? "（勝者）" : ""}
              </li>
            ))}
          </ul>
          {wins > 0 ? <p className="muted" style={{ margin: 0 }}>優勝回数 {wins}</p> : null}
        </EndScreen>
      )}
    </>
  );
}
