"use client";
// チンチロリン。ロジックは lib/chinchiro.ts（点数制・全10ラウンド・シード決定的）。
// ベスト記録の設計: localStorage `ago-chinchiro-best` に「最終スコアの最高値」を保存する。
// 端末内で完結し、サーバーへ送信しない。
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  CC_MAX_ROLLS,
  CC_TOTAL_ROUNDS,
  ccWinner,
  createChinchiroGame,
  keepCcHand,
  nextCcRound,
  rollCc,
  type CcDice,
  type CcHand,
  type CcState,
} from "@/lib/chinchiro";
import { useGamesNav } from "../GamesShell";
import { sfxCorrect, sfxDice, sfxLose, sfxPlace, sfxTap, sfxWin, sfxWrong } from "@/lib/sfx";
import { EndScreen } from "../GameJuice";

const BEST_KEY = "ago-chinchiro-best";
const DICE_FACES = ["⚀", "⚁", "⚂", "⚃", "⚄", "⚅"];

function newGame(): CcState {
  return createChinchiroGame(Date.now() % 2147483647);
}

function DiceRow({ dice, size }: { dice: CcDice | null; size: number }) {
  return (
    <div role="group" style={{ display: "flex", gap: 8 }} aria-label={dice ? `出目 ${dice.join("・")}` : "まだ振っていない"}>
      {(dice ?? [0, 0, 0]).map((d, i) => (
        <span
          key={`${i}-${d}`}
          className={dice ? "juice-pop" : undefined}
          style={{
            fontSize: size,
            lineHeight: 1,
            width: size + 14,
            height: size + 14,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 10,
            background: dice ? "#fff" : "var(--soft, #eee)",
            border: "1px solid var(--line, #ccc)",
            opacity: dice ? 1 : 0.35,
          }}
        >
          {dice ? DICE_FACES[d - 1] : "？"}
        </span>
      ))}
    </div>
  );
}

function handText(hand: CcHand | null): string {
  return hand ? hand.label : "―";
}

export default function ChinchiroClient() {
  const { prefix } = useGamesNav();
  const [state, setState] = useState<CcState>(() => newGame());
  const [best, setBest] = useState<number | null>(null);
  const countedSeed = useRef<number | null>(null);
  const prevBestRef = useRef<number | null>(null);
  const roundSoundRef = useRef(-1);
  const endSoundRef = useRef<number | null>(null);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(BEST_KEY);
      const saved = raw === null ? NaN : Number(raw);
      const loaded = Number.isFinite(saved) ? saved : null;
      setBest(loaded);
      prevBestRef.current = loaded;
    } catch {
      setBest(null);
    }
  }, []);

  useEffect(() => {
    if (state.phase !== "finished") return;
    if (countedSeed.current === state.seed) return;
    countedSeed.current = state.seed;
    if (best !== null && state.playerScore <= best) return;
    setBest(state.playerScore);
    try {
      window.localStorage.setItem(BEST_KEY, String(state.playerScore));
    } catch {
      // 保存失敗はプレイに影響しない。
    }
  }, [state.phase, state.seed, state.playerScore, best]);

  // ラウンド決着と最終結果に効果音を連動させる。
  useEffect(() => {
    if (state.phase === "roundEnd") {
      const last = state.history[state.history.length - 1];
      if (!last || roundSoundRef.current === last.round) return;
      roundSoundRef.current = last.round;
      if (last.winner === "player") sfxCorrect();
      else if (last.winner === "cpu") sfxWrong();
      else sfxTap();
    }
    if (state.phase === "finished") {
      if (endSoundRef.current === state.seed) return;
      endSoundRef.current = state.seed;
      const w = ccWinner(state);
      if (w === "player") sfxWin();
      else if (w === "cpu") sfxLose();
      else sfxTap();
    }
  }, [state]);

  const restart = () => {
    prevBestRef.current = best;
    roundSoundRef.current = -1;
    setState(newGame());
  };

  const lastResult = state.history[state.history.length - 1];
  const winner = state.phase === "finished" ? ccWinner(state) : null;

  const statusText =
    state.phase === "finished"
      ? winner === "player"
        ? `全${CC_TOTAL_ROUNDS}ラウンド終了。あなたの勝ちです！`
        : winner === "cpu"
          ? `全${CC_TOTAL_ROUNDS}ラウンド終了。親（CPU）の勝ちです。`
          : `全${CC_TOTAL_ROUNDS}ラウンド終了。引き分けです。`
      : state.phase === "roundEnd" && lastResult
        ? lastResult.winner === "draw"
          ? `ラウンド${lastResult.round}は引き分け。`
          : lastResult.winner === "player"
            ? `ラウンド${lastResult.round}はあなたの勝ち（+${lastResult.points}点）。`
            : `ラウンド${lastResult.round}は親の勝ち（-${lastResult.points}点）。`
        : state.phase === "decide"
          ? `「${handText(state.playerHand)}」が出た。このまま確定するか、振り直すか選べます。`
          : state.playerHand?.kind === "menashi"
            ? "目なし。もう一度振ってください。"
            : "サイコロを振ってください。役が出れば確定もできます。";

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>チンチロリン</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>チンチロリン</h1>
        <p className="muted">
          「振る」ボタンでサイコロを振ります。役が出たら、そのまま確定するか振り直すか選べます。
        </p>
      </div>

      <div className="classic-controls" role="group" aria-label="操作">
        <button type="button" className="classic-btn" onClick={restart}>
          もう一度
        </button>
      </div>

      <p className="classic-status" role="status">
        ラウンド {Math.min(state.round, CC_TOTAL_ROUNDS)} / {CC_TOTAL_ROUNDS} ・ あなた {state.playerScore} 点 ・ 親 {state.cpuScore} 点
        {best !== null ? ` ・ ベスト ${best} 点` : ""} ・ {statusText}
      </p>

      <div style={{ display: "grid", gap: 16, maxWidth: 560 }}>
        <section
          aria-label="親（CPU）の結果"
          style={{ border: "1px solid var(--line, #ccc)", borderRadius: 12, padding: 12, display: "grid", gap: 8 }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
            <strong>親（CPU）</strong>
            <span>役: {handText(state.cpuHand)}</span>
          </div>
          <DiceRow dice={state.cpuDice} size={40} />
        </section>

        <section
          aria-label="あなたの結果"
          style={{ border: "1px solid var(--line, #ccc)", borderRadius: 12, padding: 12, display: "grid", gap: 8 }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
            <strong>あなた（子）</strong>
            <span>
              役: {handText(state.playerHand)} ・ 振った回数 {state.playerRolls} / {CC_MAX_ROLLS}
            </span>
          </div>
          <DiceRow dice={state.playerDice} size={52} />
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {(state.phase === "roll" || state.phase === "decide") && (
              <button
                type="button"
                className="classic-btn classic-btn-active"
                style={{ minHeight: 48, minWidth: 140 }}
                onClick={() => { sfxDice(); setState((s) => rollCc(s)); }}
              >
                {state.playerRolls === 0 ? "振る" : "振り直す"}
              </button>
            )}
            {state.phase === "decide" && (
              <button
                type="button"
                className="classic-btn"
                style={{ minHeight: 48, minWidth: 140 }}
                onClick={() => { sfxPlace(); setState((s) => keepCcHand(s)); }}
              >
                この役で確定
              </button>
            )}
            {state.phase === "roundEnd" && (
              <button
                type="button"
                className="classic-btn classic-btn-active"
                style={{ minHeight: 48, minWidth: 140 }}
                onClick={() => { sfxTap(); setState((s) => nextCcRound(s)); }}
              >
                次のラウンドへ
              </button>
            )}
          </div>
        </section>

        {state.phase === "finished" && winner !== null && (
          <EndScreen
            outcome={winner === "player" ? "win" : winner === "cpu" ? "lose" : "draw"}
            score={state.playerScore}
            scoreLabel="あなたのスコア"
            newBest={prevBestRef.current === null || state.playerScore > prevBestRef.current}
            previousBest={prevBestRef.current}
            onRetry={restart}
          >
            <p className="muted" style={{ margin: 0 }}>
              あなた {state.playerScore} 点 ・ 親（CPU） {state.cpuScore} 点
            </p>
          </EndScreen>
        )}

        {state.history.length > 0 && (
          <section aria-label="ラウンド履歴">
            <h2 style={{ fontSize: 16, margin: "4px 0 8px" }}>履歴</h2>
            <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 4 }}>
              {[...state.history].reverse().map((h) => (
                <li
                  key={h.round}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 8,
                    flexWrap: "wrap",
                    borderBottom: "1px solid var(--line, #ddd)",
                    padding: "4px 2px",
                    fontSize: 14,
                  }}
                >
                  <span>
                    R{h.round} 親:{h.cpuHand.label} vs あなた:{h.playerHand.label}
                  </span>
                  <strong>
                    {h.winner === "draw" ? "引き分け" : h.winner === "player" ? `あなた +${h.points}` : `親 +${h.points}`}
                  </strong>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </>
  );
}
