"use client";
// カタカナワードル（5文字カタカナ単語推測）。ロジックは lib/kwordle.ts。
// 画面キーボードと物理キーボードの両方に対応。端末内で完結し、サーバーへ送信しない。
// ベスト記録の設計: localStorage `ago-kwordle-best` に「勝利したゲームの最少推測回数」
// （1〜6、小さいほど良い）を保存する。負けたゲームは記録対象外。
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { sfxLose, sfxPlace, sfxTap, sfxWin, sfxWrong } from "@/lib/sfx";
import { tappableProps } from "@/lib/gesture";
import { EndScreen } from "../GameJuice";
import {
  createKwordleGame,
  isKanaChar,
  kanaChars,
  kwordleKeyboardState,
  submitKwordleGuess,
  KWORDLE_KEY_ROWS,
  KWORDLE_LENGTH,
  KWORDLE_MAX_GUESSES,
  type KanaMark,
  type KwordleState,
} from "@/lib/kwordle";
import { useGamesNav } from "../GamesShell";

const MARK_COLORS: Record<KanaMark, string> = {
  correct: "#538d4e",
  present: "#b59f3b",
  absent: "#787c7e",
};

const BEST_KEY = "ago-kwordle-best";

function loadBest(): number | null {
  try {
    const saved = Number(window.localStorage.getItem(BEST_KEY));
    return Number.isFinite(saved) && saved >= 1 && saved <= KWORDLE_MAX_GUESSES ? saved : null;
  } catch {
    return null;
  }
}

export default function KwordleClient() {
  const { prefix } = useGamesNav();
  const [game, setGame] = useState<KwordleState>(() => createKwordleGame(Date.now() % 2147483647));
  const [current, setCurrent] = useState("");
  const [message, setMessage] = useState("");
  const [best, setBest] = useState<number | null>(null);
  const [finishInfo, setFinishInfo] = useState<{ prevBest: number | null; isNewBest: boolean } | null>(null);
  const prevStatusRef = useRef(game.status);

  useEffect(() => {
    setBest(loadBest());
  }, []);

  // 終局が確定した瞬間の「前回ベスト」を、ベスト更新 effect より先に記録する。
  useEffect(() => {
    if (prevStatusRef.current === "playing" && game.status !== "playing") {
      setFinishInfo({
        prevBest: best,
        isNewBest: game.status === "won" && (best === null || game.guesses.length < best),
      });
      if (game.status === "won") sfxWin();
      else sfxLose();
    }
    prevStatusRef.current = game.status;
  }, [game.status, game.guesses.length, best]);

  // 勝利したらベスト（最少推測回数）を更新する。
  useEffect(() => {
    if (game.status !== "won") return;
    const used = game.guesses.length;
    setBest((prev) => {
      const next = prev === null || used < prev ? used : prev;
      if (next !== prev) {
        try {
          window.localStorage.setItem(BEST_KEY, String(next));
        } catch {
          // 保存失敗はプレイに影響しない。
        }
      }
      return next;
    });
  }, [game.status, game.guesses.length]);

  const submit = useCallback(() => {
    if (game.status !== "playing") return;
    if (kanaChars(current).length < KWORDLE_LENGTH) {
      sfxWrong();
      setMessage("カタカナ5文字を入力してください");
      return;
    }
    const result = submitKwordleGuess(game, current);
    if (result.error) {
      sfxWrong();
      setMessage(result.error);
      return;
    }
    if (result.state.status === "playing") sfxPlace();
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
        sfxTap();
        setCurrent((c) => kanaChars(c).slice(0, -1).join(""));
        return;
      }
      if (isKanaChar(key)) {
        if (kanaChars(current).length < KWORDLE_LENGTH) sfxTap();
        setCurrent((c) => (kanaChars(c).length < KWORDLE_LENGTH ? c + key : c));
      }
    },
    [game.status, submit, current],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Enter") {
        // 画面キー・決定・消す・「もう一度」にフォーカスがあるときは、その要素の
        // Enter ハンドラに任せ、window 側の決定と二重に走らせない（wordle の教訓）。
        // Backspace・カナキーには div 側のハンドラがないためガードは Enter 分岐の中だけ。
        if ((e.target as HTMLElement | null)?.closest?.("[data-kwordle-key]")) return;
        press("ENTER");
      } else if (e.key === "Backspace") press("BACK");
      else if (isKanaChar(e.key)) press(e.key);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [press]);

  const restart = () => {
    setGame(createKwordleGame(Date.now() % 2147483647));
    setCurrent("");
    setMessage("");
    setFinishInfo(null);
  };

  const keyState = kwordleKeyboardState(game);
  const currentChars = kanaChars(current);

  const cellStyle = (mark: KanaMark | null, filled: boolean): CSSProperties => ({
    width: 52,
    height: 52,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 24,
    fontWeight: 700,
    border: "2px solid",
    borderColor: mark ? MARK_COLORS[mark] : filled ? "#999" : "#ccc",
    background: mark ? MARK_COLORS[mark] : undefined,
    color: mark ? "#fff" : undefined,
    borderRadius: 6,
    boxSizing: "border-box",
  });

  const statusText =
    game.status === "won"
      ? `正解！ ${game.guesses.length} 回で当てました。`
      : game.status === "lost"
        ? `残念… 答えは ${game.answer} でした。`
        : `あと ${game.maxGuesses - game.guesses.length} 回。緑＝場所も一致、黄＝文字は含まれる。`;

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>カタカナワードル</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>カタカナワードル</h1>
        <p className="muted">推測はカタカナ5文字なら何でも入力できます。</p>
      </div>

      <div className="classic-controls" role="group" aria-label="操作">
        <button type="button" className="classic-btn" onClick={restart} data-kwordle-key="">
          もう一度
        </button>
      </div>

      <p className="classic-status" role="status">
        {message || statusText}
        {best !== null ? ` ・ ベスト ${best} 回` : ""}
      </p>

      <div
        role="grid"
        aria-label="推測の盤"
        style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "center", margin: "12px 0" }}
      >
        {Array.from({ length: KWORDLE_MAX_GUESSES }, (_, row) => {
          const guess = game.guesses[row];
          const marks = game.marks[row];
          const isCurrentRow = game.status === "playing" && row === game.guesses.length;
          return (
            <div key={row} role="row" style={{ display: "flex", gap: 6 }}>
              {Array.from({ length: KWORDLE_LENGTH }, (_, col) => {
                const ch = guess ? kanaChars(guess)[col] : isCurrentRow ? (currentChars[col] ?? "") : "";
                const mark = marks ? marks[col] : null;
                return (
                  <div
                    key={col}
                    role="gridcell"
                    className={mark ? "juice-flip" : isCurrentRow && ch !== "" ? "juice-pop" : undefined}
                    style={cellStyle(mark, ch !== "")}
                  >
                    {ch}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>

      <div role="group" aria-label="カタカナキーボード" style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "center" }}>
        {KWORDLE_KEY_ROWS.map((row, ri) => (
          <div key={ri} style={{ display: "flex", gap: 4, justifyContent: "center", flexWrap: "wrap" }}>
            {row.map((ch) => {
              const mark = keyState[ch];
              return (
                <div
                  key={ch}
                  {...tappableProps(() => press(ch))}
                  aria-label={ch}
                  data-kwordle-key=""
                  style={{
                    minWidth: 34,
                    minHeight: 44,
                    padding: "0 4px",
                    fontSize: 16,
                    fontWeight: 700,
                    borderRadius: 6,
                    border: "1px solid #bbb",
                    background: mark ? MARK_COLORS[mark] : "#e8e8e8",
                    color: mark ? "#fff" : undefined,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    cursor: "pointer",
                    touchAction: "manipulation",
                  }}
                >
                  {ch}
                </div>
              );
            })}
          </div>
        ))}
        <div style={{ display: "flex", gap: 6, justifyContent: "center", marginTop: 2 }}>
          <div
            {...tappableProps(() => press("ENTER"))}
            className="classic-btn"
            style={{ minWidth: 96, minHeight: 44 }}
            data-kwordle-key=""
          >
            決定
          </div>
          <div
            {...tappableProps(() => press("BACK"))}
            className="classic-btn"
            style={{ minWidth: 96, minHeight: 44 }}
            aria-label="1文字消す"
            data-kwordle-key=""
          >
            ⌫ 消す
          </div>
        </div>
      </div>

      {game.status !== "playing" && (
        <EndScreen
          outcome={game.status === "won" ? "win" : "lose"}
          title={game.status === "won" ? `正解！ ${game.guesses.length} 回で当てました。` : `残念… 答えは ${game.answer} でした。`}
          score={game.status === "won" ? game.guesses.length : undefined}
          scoreLabel="推測回数"
          newBest={game.status === "won" ? (finishInfo?.isNewBest ?? false) : undefined}
          previousBest={game.status === "won" && finishInfo && !finishInfo.isNewBest ? finishInfo.prevBest : undefined}
          onRetry={restart}
        >
          <p className="muted" style={{ textAlign: "center" }}>
            答えは {game.answer} でした{best !== null ? ` ・ ベスト ${best} 回` : ""}
          </p>
        </EndScreen>
      )}
    </>
  );
}
