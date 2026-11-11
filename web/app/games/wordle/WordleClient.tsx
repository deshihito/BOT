"use client";
// ワード当て（5文字英単語推測）。ロジックは lib/wordle.ts。
// 画面キーボードと物理キーボードの両方に対応。端末内で完結し、サーバーへ送信しない。
import Link from "next/link";
import { useCallback, useEffect, useState, type CSSProperties } from "react";
import {
  createWordleGame,
  keyboardState,
  submitGuess,
  WORDLE_LENGTH,
  type LetterMark,
  type WordleState,
} from "@/lib/wordle";
import { useGamesNav } from "../GamesShell";

const MARK_COLORS: Record<LetterMark, string> = {
  correct: "#538d4e",
  present: "#b59f3b",
  absent: "#787c7e",
};

const KEY_ROWS: string[] = ["QWERTYUIOP", "ASDFGHJKL", "ZXCVBNM"];

export default function WordleClient() {
  const { prefix } = useGamesNav();
  const [game, setGame] = useState<WordleState>(() => createWordleGame(Date.now() % 2147483647));
  const [current, setCurrent] = useState("");
  const [message, setMessage] = useState("");

  const submit = useCallback(() => {
    if (game.status !== "playing") return;
    if (current.length < WORDLE_LENGTH) {
      setMessage("5文字の単語を入力してください");
      return;
    }
    const result = submitGuess(game, current);
    if (result.error) {
      setMessage(result.error);
      return;
    }
    setGame(result.state);
    setCurrent("");
    if (result.state.status === "won") {
      setMessage(`正解！ ${result.state.guesses.length} 回で当てました。`);
    } else if (result.state.status === "lost") {
      setMessage(`残念… 答えは ${result.state.answer} でした。`);
    } else {
      setMessage("");
    }
  }, [game, current]);

  const press = useCallback(
    (key: string) => {
      if (game.status !== "playing") return;
      if (key === "ENTER") {
        submit();
        return;
      }
      if (key === "BACK") {
        setCurrent((c) => c.slice(0, -1));
        return;
      }
      if (/^[A-Z]$/.test(key)) {
        setCurrent((c) => (c.length < WORDLE_LENGTH ? c + key : c));
      }
    },
    [game.status, submit],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Enter") press("ENTER");
      else if (e.key === "Backspace") press("BACK");
      else if (/^[a-zA-Z]$/.test(e.key)) press(e.key.toUpperCase());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [press]);

  const restart = () => {
    setGame(createWordleGame(Date.now() % 2147483647));
    setCurrent("");
    setMessage("");
  };

  const kb = keyboardState(game);

  const tileStyle = (mark: LetterMark | null, filled: boolean): CSSProperties => ({
    width: "min(13vw, 56px)",
    aspectRatio: "1 / 1",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: "clamp(20px, 6vw, 28px)",
    fontWeight: 700,
    textTransform: "uppercase",
    boxSizing: "border-box",
    border: mark
      ? `2px solid ${MARK_COLORS[mark]}`
      : `2px solid ${filled ? "#9ca3af" : "#d1d5db"}`,
    background: mark ? MARK_COLORS[mark] : "transparent",
    color: mark ? "#ffffff" : "#1f2937",
    transition: "background-color 0.3s ease, border-color 0.3s ease",
  });

  const keyStyle = (letter: string): CSSProperties => {
    const mark = kb[letter];
    return {
      flex: "1 1 0",
      minWidth: 0,
      height: 52,
      borderRadius: 6,
      border: "none",
      background: mark ? MARK_COLORS[mark] : "#d3d6da",
      color: mark ? "#ffffff" : "#1f2937",
      fontSize: 15,
      fontWeight: 700,
      cursor: "pointer",
      padding: 0,
    };
  };

  const wideKeyStyle: CSSProperties = {
    flex: "1.6 1 0",
    minWidth: 0,
    height: 52,
    borderRadius: 6,
    border: "none",
    background: "#d3d6da",
    color: "#1f2937",
    fontSize: 13,
    fontWeight: 700,
    cursor: "pointer",
    padding: 0,
  };

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>ワード当て</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>ワード当て</h1>
        <p className="muted">
          隠れた5文字の英単語を6回以内に当てるゲーム。緑は位置も一致、黄は文字が含まれます。
        </p>
      </div>

      <p className="classic-status" role="status" aria-live="polite">
        {message || `${game.guesses.length} / ${game.maxGuesses} 回`}
        {game.status === "lost" ? ` ・ 答えは ${game.answer} でした` : ""}
      </p>

      <div
        style={{
          display: "grid",
          gridTemplateRows: "repeat(6, auto)",
          gap: 6,
          justifyContent: "center",
          margin: "12px auto",
        }}
        role="grid"
        aria-label="ワード当ての盤"
      >
        {Array.from({ length: game.maxGuesses }, (_, row) => {
          const guess = game.guesses[row];
          const marks = game.marks[row];
          const isCurrentRow = row === game.guesses.length && game.status === "playing";
          return (
            <div key={row} style={{ display: "flex", gap: 6 }} role="row">
              {Array.from({ length: WORDLE_LENGTH }, (_, col) => {
                const letter = guess
                  ? guess[col]
                  : isCurrentRow
                    ? (current[col] ?? "")
                    : "";
                return (
                  <div key={col} style={tileStyle(marks ? marks[col] : null, letter !== "")} role="gridcell">
                    {letter}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>

      <div style={{ maxWidth: 500, margin: "16px auto 0", display: "flex", flexDirection: "column", gap: 6 }} aria-label="画面キーボード">
        {KEY_ROWS.map((row, rowIndex) => (
          <div key={row} style={{ display: "flex", gap: 5, justifyContent: "center", padding: rowIndex === 1 ? "0 5%" : undefined }}>
            {rowIndex === 2 ? (
              <button type="button" style={wideKeyStyle} onClick={() => press("ENTER")} aria-label="決定">
                Enter
              </button>
            ) : null}
            {row.split("").map((letter) => (
              <button
                key={letter}
                type="button"
                style={keyStyle(letter)}
                onClick={() => press(letter)}
                aria-label={letter}
              >
                {letter}
              </button>
            ))}
            {rowIndex === 2 ? (
              <button type="button" style={wideKeyStyle} onClick={() => press("BACK")} aria-label="1文字消す">
                ⌫
              </button>
            ) : null}
          </div>
        ))}
      </div>

      <div style={{ display: "flex", justifyContent: "center", marginTop: 16 }}>
        <button
          type="button"
          onClick={restart}
          style={{
            padding: "8px 14px",
            borderRadius: 8,
            border: "1px solid #9ca3af",
            background: "#ffffff",
            color: "#1f2937",
            fontSize: 14,
            cursor: "pointer",
          }}
        >
          別の単語でもう一度
        </button>
      </div>
    </>
  );
}
