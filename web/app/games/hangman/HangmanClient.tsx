"use client";
// ハングマン。ロジックは lib/hangman.ts（文字開示・ミス6回・勝敗）。
// 画面のアルファベットキーと物理キーボードで入力できる。端末内で完結。
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { sfxCorrect, sfxLose, sfxWin, sfxWrong } from "@/lib/sfx";
import { EndScreen } from "../GameJuice";
import {
  createHangmanGame,
  displayWord,
  guessLetter,
  isLetterInWord,
  remainingMisses,
  type HangmanState,
} from "@/lib/hangman";
import { useGamesNav } from "../GamesShell";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

function newGame(): HangmanState {
  return createHangmanGame(Date.now() % 2147483647);
}

/** ミス回数に応じて絞首台の人体が1パーツずつ増える（最大6）。 */
function Gallows({ misses }: { misses: number }) {
  const stroke = "var(--text)";
  return (
    <svg width="140" height="160" viewBox="0 0 140 160" role="img" aria-label={`ミス ${misses} 回`}>
      {/* 台と柱（常に表示） */}
      <line x1="10" y1="155" x2="80" y2="155" stroke={stroke} strokeWidth="4" />
      <line x1="30" y1="155" x2="30" y2="10" stroke={stroke} strokeWidth="4" />
      <line x1="30" y1="10" x2="95" y2="10" stroke={stroke} strokeWidth="4" />
      <line x1="95" y1="10" x2="95" y2="30" stroke={stroke} strokeWidth="3" />
      {/* 1:頭 2:胴 3:左腕 4:右腕 5:左脚 6:右脚 */}
      {misses >= 1 && <circle cx="95" cy="42" r="12" fill="none" stroke={stroke} strokeWidth="3" />}
      {misses >= 2 && <line x1="95" y1="54" x2="95" y2="95" stroke={stroke} strokeWidth="3" />}
      {misses >= 3 && <line x1="95" y1="65" x2="78" y2="80" stroke={stroke} strokeWidth="3" />}
      {misses >= 4 && <line x1="95" y1="65" x2="112" y2="80" stroke={stroke} strokeWidth="3" />}
      {misses >= 5 && <line x1="95" y1="95" x2="80" y2="118" stroke={stroke} strokeWidth="3" />}
      {misses >= 6 && <line x1="95" y1="95" x2="110" y2="118" stroke={stroke} strokeWidth="3" />}
    </svg>
  );
}

export default function HangmanClient() {
  const { prefix } = useGamesNav();
  const [state, setState] = useState<HangmanState>(() => newGame());

  const prevStatusRef = useRef(state.status);
  useEffect(() => {
    if (prevStatusRef.current === "playing" && state.status !== "playing") {
      if (state.status === "won") sfxWin();
      else sfxLose();
    }
    prevStatusRef.current = state.status;
  }, [state.status]);

  const doGuess = (letter: string) => {
    if (state.status !== "playing") return;
    if (state.guessed.includes(letter.toUpperCase())) return;
    if (isLetterInWord(state, letter.toUpperCase())) sfxCorrect();
    else sfxWrong();
    setState(guessLetter(state, letter));
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.length === 1 && /[a-zA-Z]/.test(e.key)) {
        doGuess(e.key);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const restart = () => setState(newGame());
  const shown = displayWord(state);

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>ハングマン</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>ハングマン</h1>
        <p className="muted">英単語の文字を1文字ずつ当てていくゲーム。ミス6回で終了です。カテゴリがヒントになります。</p>
      </div>

      <div className="classic-controls">
        <button type="button" className="classic-btn" onClick={restart}>
          もう一度（別の単語）
        </button>
      </div>

      <p className="classic-status" role="status">
        カテゴリ: <strong>{state.category}</strong> ・ あと {remainingMisses(state)} 回ミスできます
        {state.status === "won"
          ? " ・ 正解！ 単語を当てました。"
          : state.status === "lost"
            ? ` ・ 終了… 正解は ${state.word} でした。`
            : ""}
      </p>

      <div style={{ display: "flex", gap: 20, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div key={state.misses} className={state.misses > 0 ? "juice-shake" : undefined}>
          <Gallows misses={state.misses} />
        </div>
        <div
          aria-label="単語"
          style={{
            display: "flex",
            gap: 6,
            flexWrap: "wrap",
            alignItems: "center",
            minHeight: 60,
            paddingTop: 18,
          }}
        >
          {shown.split("").map((ch, i) => (
            <span
              key={i}
              className={ch !== "_" ? "juice-pop" : undefined}
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                width: 30,
                height: 40,
                fontSize: 22,
                fontWeight: 700,
                borderBottom: "3px solid var(--text)",
                color: ch === "_" ? "transparent" : "var(--text)",
              }}
            >
              {ch === "_" ? "・" : ch}
            </span>
          ))}
        </div>
      </div>

      <div
        role="group"
        aria-label="アルファベット"
        style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 18, maxWidth: 560 }}
      >
        {ALPHABET.map((letter) => {
          const used = state.guessed.includes(letter);
          const correct = used && isLetterInWord(state, letter);
          const wrong = used && !correct;
          return (
            <button
              key={letter}
              type="button"
              disabled={used || state.status !== "playing"}
              aria-label={`${letter}${used ? "（入力済み）" : ""}`}
              onClick={() => doGuess(letter)}
              style={{
                width: 38,
                height: 38,
                fontSize: 16,
                fontWeight: 700,
                borderRadius: 8,
                border: "1px solid var(--line)",
                background: correct ? "#dff3df" : wrong ? "#fbe3e3" : "#fff",
                color: wrong ? "#b03a3a" : "var(--text)",
                opacity: used || state.status !== "playing" ? 0.75 : 1,
                cursor: used || state.status !== "playing" ? "not-allowed" : "pointer",
              }}
            >
              {letter}
            </button>
          );
        })}
      </div>
      <p className="muted" style={{ fontSize: 13, marginTop: 10 }}>
        物理キーボードの A〜Z でも入力できます。
      </p>

      {state.status !== "playing" && (
        <EndScreen
          outcome={state.status === "won" ? "win" : "lose"}
          title={state.status === "won" ? "正解！ 単語を当てました。" : `終了… 正解は ${state.word} でした。`}
          onRetry={restart}
          retryLabel="もう一度（別の単語）"
        >
          <p className="muted" style={{ textAlign: "center" }}>
            単語 {state.word} ・ カテゴリ {state.category} ・ ミス {state.misses} 回
          </p>
        </EndScreen>
      )}
    </>
  );
}
