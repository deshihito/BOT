"use client";
// ワード当て（5文字英単語推測）。ロジックは lib/wordle.ts。
// 画面キーボードと物理キーボードの両方に対応。端末内で完結し、サーバーへ送信しない。
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import {
  buildShareText,
  createDailyWordleGame,
  createWordleGame,
  dailyKeyFor,
  emptyWordleStats,
  keyboardState,
  recordWordleResult,
  submitGuess,
  WORDLE_LENGTH,
  type LetterMark,
  type WordleState,
  type WordleStats,
} from "@/lib/wordle";
import { sfxFlip, sfxLose, sfxTap, sfxWin, sfxWrong } from "@/lib/sfx";
import { tappableProps } from "@/lib/gesture";
import { EndScreen } from "../GameJuice";
import { useGamesNav } from "../GamesShell";

const MARK_COLORS: Record<LetterMark, string> = {
  correct: "#538d4e",
  present: "#b59f3b",
  absent: "#787c7e",
};

const KEY_ROWS: string[] = ["QWERTYUIOP", "ASDFGHJKL", "ZXCVBNM"];
const STATS_KEY = "ago-wordle-stats";

type Mode = "daily" | "random";

function loadStats(): WordleStats {
  try {
    const raw = window.localStorage.getItem(STATS_KEY);
    if (!raw) return emptyWordleStats();
    const parsed = JSON.parse(raw) as Partial<WordleStats>;
    const base = emptyWordleStats();
    return {
      played: typeof parsed.played === "number" ? parsed.played : 0,
      wins: typeof parsed.wins === "number" ? parsed.wins : 0,
      currentStreak: typeof parsed.currentStreak === "number" ? parsed.currentStreak : 0,
      maxStreak: typeof parsed.maxStreak === "number" ? parsed.maxStreak : 0,
      distribution:
        Array.isArray(parsed.distribution) && parsed.distribution.length === 6
          ? parsed.distribution.map((n) => (typeof n === "number" ? n : 0))
          : base.distribution,
      recordedKeys: Array.isArray(parsed.recordedKeys)
        ? parsed.recordedKeys.filter((k): k is string => typeof k === "string")
        : [],
    };
  } catch {
    return emptyWordleStats();
  }
}

export default function WordleClient() {
  const { prefix } = useGamesNav();
  const [mode, setMode] = useState<Mode>("daily");
  const [game, setGame] = useState<WordleState>(() => createDailyWordleGame());
  const [gameKey, setGameKey] = useState<string>(() => `daily:${dailyKeyFor(new Date())}`);
  const [current, setCurrent] = useState("");
  const [message, setMessage] = useState("");
  const [shakeKey, setShakeKey] = useState(0);
  const [stats, setStats] = useState<WordleStats>(() => emptyWordleStats());
  const [copied, setCopied] = useState(false);
  const prevStatusRef = useRef(game.status);
  const recordedKeyRef = useRef<string | null>(null);

  useEffect(() => {
    setStats(loadStats());
  }, []);

  // 終局の瞬間に成績を1回だけ記録する（同じゲームの二重記録は lib 側でも防ぐ）。
  useEffect(() => {
    if (game.status === "playing") return;
    if (recordedKeyRef.current === gameKey) return;
    recordedKeyRef.current = gameKey;
    setStats((prev) => {
      const next = recordWordleResult(prev, {
        won: game.status === "won",
        guessesUsed: game.guesses.length,
        key: gameKey,
      });
      if (next !== prev) {
        try {
          window.localStorage.setItem(STATS_KEY, JSON.stringify(next));
        } catch {
          // 保存失敗はプレイに影響しない。
        }
      }
      return next;
    });
  }, [game.status, game.guesses.length, gameKey]);

  // 終局遷移の瞬間だけジングルを鳴らす。
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = game.status;
    if (prev === game.status) return;
    if (game.status === "won") sfxWin();
    else if (game.status === "lost") sfxLose();
  }, [game.status]);

  const failInput = (text: string) => {
    sfxWrong();
    setShakeKey((k) => k + 1);
    setMessage(text);
  };

  const submit = useCallback(() => {
    if (game.status !== "playing") return;
    if (current.length < WORDLE_LENGTH) {
      failInput("5文字の単語を入力してください");
      return;
    }
    const result = submitGuess(game, current);
    if (result.error) {
      failInput(result.error);
      return;
    }
    if (result.state.status === "playing") sfxFlip();
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
        setCurrent((c) => c.slice(0, -1));
        return;
      }
      if (/^[A-Z]$/.test(key)) {
        if (current.length < WORDLE_LENGTH) sfxTap();
        setCurrent((c) => (c.length < WORDLE_LENGTH ? c + key : c));
      }
    },
    [game.status, submit, current],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // 画面キーの div にフォーカスがあるときの Enter は div 側の tappableProps が
      // 受けるため、window 側と二重発火しないよう無視する
      // （reaction の Space 二重発火の教訓）。
      const target = e.target as HTMLElement | null;
      if (e.key === "Enter" && target?.closest?.("[data-wordle-key]")) return;
      if (e.key === "Enter") press("ENTER");
      else if (e.key === "Backspace") press("BACK");
      else if (/^[a-zA-Z]$/.test(e.key)) press(e.key.toUpperCase());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [press]);

  const startGame = (nextMode: Mode) => {
    setMode(nextMode);
    setCurrent("");
    setMessage("");
    setCopied(false);
    if (nextMode === "daily") {
      setGame(createDailyWordleGame());
      setGameKey(`daily:${dailyKeyFor(new Date())}`);
    } else {
      const seed = Date.now() % 2147483647;
      setGame(createWordleGame(seed));
      setGameKey(`random:${seed}`);
    }
  };

  const restart = () => startGame(mode);

  const shareLabel = mode === "daily" ? `デイリー ${dailyKeyFor(new Date())}` : "ランダム";

  const copyShare = async () => {
    const text = buildShareText(game, shareLabel);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setMessage("コピーできませんでした");
    }
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
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      userSelect: "none",
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
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    userSelect: "none",
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
          デイリーはその日の答えが全員共通です。
        </p>
      </div>

      <div className="classic-controls" role="group" aria-label="モード" style={{ justifyContent: "center" }}>
        <div
          {...tappableProps(() => startGame("daily"))}
          data-wordle-key=""
          aria-pressed={mode === "daily"}
          className={mode === "daily" ? "classic-btn classic-btn-active" : "classic-btn"}
        >
          デイリー（{dailyKeyFor(new Date())}）
        </div>
        <div
          {...tappableProps(() => startGame("random"))}
          data-wordle-key=""
          aria-pressed={mode === "random"}
          className={mode === "random" ? "classic-btn classic-btn-active" : "classic-btn"}
        >
          ランダム
        </div>
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
            <div
              key={isCurrentRow ? `cur-${shakeKey}` : row}
              style={{ display: "flex", gap: 6 }}
              role="row"
              className={isCurrentRow && shakeKey > 0 ? "juice-shake" : undefined}
            >
              {Array.from({ length: WORDLE_LENGTH }, (_, col) => {
                const letter = guess
                  ? guess[col]
                  : isCurrentRow
                    ? (current[col] ?? "")
                    : "";
                return (
                  <div
                    key={col}
                    style={tileStyle(marks ? marks[col] : null, letter !== "")}
                    role="gridcell"
                    className={marks ? "juice-flip" : isCurrentRow && letter !== "" ? "juice-pop" : undefined}
                  >
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
              <div
                style={wideKeyStyle}
                {...tappableProps(() => press("ENTER"))}
                data-wordle-key=""
                aria-label="決定"
              >
                Enter
              </div>
            ) : null}
            {row.split("").map((letter) => (
              <div
                key={letter}
                style={keyStyle(letter)}
                {...tappableProps(() => press(letter))}
                data-wordle-key=""
                aria-label={letter}
              >
                {letter}
              </div>
            ))}
            {rowIndex === 2 ? (
              <div
                style={wideKeyStyle}
                {...tappableProps(() => press("BACK"))}
                data-wordle-key=""
                aria-label="1文字消す"
              >
                ⌫
              </div>
            ) : null}
          </div>
        ))}
      </div>

      {game.status !== "playing" && (
        <div style={{ maxWidth: 500, margin: "16px auto 0" }}>
          <EndScreen
            outcome={game.status === "won" ? "win" : "lose"}
            title={game.status === "won" ? "正解！" : "残念…"}
            onRetry={restart}
            retryLabel={mode === "daily" ? "今日の単語でもう一度" : "別の単語でもう一度"}
          >
            <p className="muted">
              {game.status === "won"
                ? `答えは ${game.answer}。${game.guesses.length} 回で当てました。`
                : `答えは ${game.answer} でした。`}
            </p>
            {stats.played > 0 && (
              <div className="muted" style={{ fontSize: 13, lineHeight: 1.7 }}>
                <p style={{ margin: "8px 0 2px" }}>
                  成績: {stats.played} 戦 {stats.wins} 勝（勝率{" "}
                  {Math.round((stats.wins / stats.played) * 100)}%） ・ 連勝 {stats.currentStreak} ・ 最大連勝{" "}
                  {stats.maxStreak}
                </p>
                <p style={{ margin: 0 }}>
                  推測回数の分布:{" "}
                  {stats.distribution.map((n, i) => `${i + 1}回 ${n}`).join(" / ")}
                </p>
              </div>
            )}
            <div
              {...tappableProps(() => void copyShare())}
              data-wordle-key=""
              aria-label="結果をコピー（シェア用）"
              style={{
                marginTop: 10,
                padding: "8px 14px",
                borderRadius: 8,
                border: "1px solid #9ca3af",
                background: "#ffffff",
                color: "#1f2937",
                fontSize: 14,
                cursor: "pointer",
                display: "inline-block",
              }}
            >
              {copied ? "コピーしました" : "結果をコピー（シェア用）"}
            </div>
          </EndScreen>
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "center", marginTop: 16 }}>
        <button
          type="button"
          data-wordle-key=""
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
          {mode === "daily" ? "今日の単語でもう一度" : "別の単語でもう一度"}
        </button>
      </div>
    </>
  );
}
