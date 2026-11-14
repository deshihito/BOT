"use client";
// 数独。ロジックは lib/sudoku.ts（唯一解を保って穴あけ、ヒント・矛盾チェック付き）。
// 端末内で完結し、サーバーへ送信しない。
import Link from "next/link";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// 3D シーンは three を含むため遅延読み込み（このページ専用チャンクに閉じる）。
const SudokuScene3D = dynamic(() => import("./SudokuScene3D"), { ssr: false });
import {
  applyHint,
  clearCell,
  conflictIndexes,
  createSudokuGame,
  isMistake,
  setCell,
  toggleNote,
  type SudokuDifficulty,
  type SudokuState,
} from "@/lib/sudoku";
import { sfxCorrect, sfxPlace, sfxTap, sfxWin, sfxWrong } from "@/lib/sfx";
import { tappableProps, useGesture } from "@/lib/gesture";
import { EndScreen } from "../GameJuice";
import { useGamesNav } from "../GamesShell";

const LEVELS: { key: SudokuDifficulty; label: string }[] = [
  { key: "easy", label: "かんたん" },
  { key: "normal", label: "ふつう" },
  { key: "hard", label: "むずかしい" },
];

function newGame(d: SudokuDifficulty): SudokuState {
  return createSudokuGame(d, Date.now() % 2147483647);
}

function formatTime(total: number): string {
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export default function SudokuClient() {
  const { prefix } = useGamesNav();
  const [webglFailed, setWebglFailed] = useState(false);
  const [difficulty, setDifficulty] = useState<SudokuDifficulty>("easy");
  const [state, setState] = useState<SudokuState>(() => newGame("easy"));
  const [selected, setSelected] = useState<number | null>(null);
  const [noteMode, setNoteMode] = useState(false);
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    if (state.status === "won") return;
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [state.status]);

  const prevStatusRef = useRef(state.status);
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = state.status;
    if (prev !== state.status && state.status === "won") sfxWin();
  }, [state.status]);

  const conflicts = useMemo(() => conflictIndexes(state), [state]);

  const mistakes = useMemo(() => {
    const set = new Set<number>();
    for (let i = 0; i < 81; i++) if (isMistake(state, i)) set.add(i);
    return set;
  }, [state]);

  const selectCell = (i: number) => {
    sfxTap();
    setSelected(i);
  };

  // メモの正は DOM 側の注記でも担保する（3D ではドット表現のため）。
  const notesSummary = useMemo(() => {
    const parts: string[] = [];
    state.notes.forEach((ns, i) => {
      if (state.board[i] === 0 && ns.length > 0) {
        parts.push(`${Math.floor(i / 9) + 1}行${(i % 9) + 1}列: ${ns.join(" ")}`);
      }
    });
    return parts;
  }, [state.notes, state.board]);

  const restart = (d: SudokuDifficulty) => {
    setDifficulty(d);
    setState(newGame(d));
    setSelected(null);
    setSeconds(0);
    setNoteMode(false);
  };

  const onPad = useCallback((value: number) => {
    if (selected === null || state.status === "won") return;
    if (noteMode && value !== 0) {
      if (state.givens[selected] || state.board[selected] !== 0) return;
      sfxTap();
      setState((s) => toggleNote(s, selected, value));
    } else if (value === 0) {
      if (state.givens[selected] || state.board[selected] === 0) return;
      sfxTap();
      setState((s) => clearCell(s, selected));
    } else {
      if (state.givens[selected] || state.board[selected] === value) return;
      const next = setCell(state, selected, value);
      // 完成時は終局ジングルに任せ、二重に鳴らさない。
      if (next.status !== "won") {
        if (value === state.solution[selected]) sfxCorrect();
        else sfxWrong();
      }
      setState(next);
    }
  }, [selected, state, noteMode]);

  // 物理キーボードでも数字を入れられる（画面パッドの代替）。
  // パッドの div は Enter/Space のみ受けるため数字キーとの二重発火はない。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      if (/^[1-9]$/.test(e.key)) onPad(Number(e.key));
      else if (e.key === "Backspace" || e.key === "Delete") onPad(0);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onPad]);

  const onHint = () => {
    const next = applyHint(state);
    if (next !== state && next.status !== "won") sfxPlace();
    setState(next);
  };

  // 盤面の上スワイプでヒント（ヒントボタン廃止）。マスのタップは各マスが受ける。
  const boardGesture = useGesture({
    onSwipe: (dir) => {
      if (dir === "up") onHint();
    },
  });

  const selectedValue = selected !== null ? state.board[selected] : 0;

  // 2D 盤（WebGL が使えない場合のフォールバックとしてそのまま使う）。
  const board2d = (
      <div
        {...boardGesture}
        role="grid"
        aria-label="数独の盤（上スワイプでヒント）"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(9, minmax(0, 1fr))",
          maxWidth: 450,
          width: "100%",
          border: "2px solid #333",
          boxSizing: "border-box",
          touchAction: "none",
        }}
      >
        {state.board.map((value, i) => {
          const row = Math.floor(i / 9);
          const col = i % 9;
          const isGiven = state.givens[i];
          const isSelected = selected === i;
          const sameUnit =
            selected !== null &&
            (Math.floor(selected / 9) === row || selected % 9 === col ||
              (Math.floor(Math.floor(selected / 9) / 3) === Math.floor(row / 3) &&
                Math.floor((selected % 9) / 3) === Math.floor(col / 3)));
          const sameValue = value !== 0 && selectedValue !== 0 && value === selectedValue;
          const mistake = isMistake(state, i);
          const conflict = conflicts.has(i);
          const isHint = state.lastHint === i;
          const notes = state.notes[i];
          let bg = "#fff";
          if (isHint) bg = "#d1fae5";
          else if (isSelected) bg = "#bfdbfe";
          else if (sameValue) bg = "#dbeafe";
          else if (sameUnit) bg = "#eff6ff";
          if (mistake || conflict) bg = isSelected ? "#fecaca" : "#fee2e2";
          return (
            <div
              key={i}
              role="gridcell"
              tabIndex={0}
              aria-label={`行${row + 1}列${col + 1}${value ? ` ${value}` : " 空き"}`}
              aria-pressed={isSelected}
              className={
                mistake || conflict
                  ? "juice-shake"
                  : isHint
                    ? "juice-pulse"
                    : value !== 0 && !isGiven
                      ? "juice-pop"
                      : undefined
              }
              onClick={() => {
                sfxTap();
                setSelected(i);
              }}
              onKeyDown={(e) => {
                if (e.key !== "Enter" && e.key !== " ") return;
                e.preventDefault();
                sfxTap();
                setSelected(i);
              }}
              style={{
                aspectRatio: "1",
                minWidth: 0,
                minHeight: 44,
                padding: 1,
                borderTop: row % 3 === 0 ? "2px solid #333" : "1px solid #cbd5e1",
                borderLeft: col % 3 === 0 ? "2px solid #333" : "1px solid #cbd5e1",
                borderRight: col === 8 ? "2px solid #333" : undefined,
                borderBottom: row === 8 ? "2px solid #333" : undefined,
                background: bg,
                color: mistake || conflict ? "#b91c1c" : isGiven ? "#111827" : "#2563eb",
                fontWeight: isGiven ? 700 : 500,
                fontSize: "clamp(15px, 4.5vw, 22px)",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              {value !== 0 ? (
                value
              ) : notes.length > 0 ? (
                <span
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(3, 1fr)",
                    width: "100%",
                    height: "100%",
                    fontSize: "clamp(7px, 2vw, 10px)",
                    color: "#64748b",
                    lineHeight: 1.1,
                    textAlign: "center",
                  }}
                >
                  {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
                    <span key={n}>{notes.includes(n) ? n : ""}</span>
                  ))}
                </span>
              ) : (
                ""
              )}
            </div>
          );
        })}
      </div>
  );

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>数独</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>数独</h1>
        <p className="muted">縦・横・3×3ブロックに1〜9を重ならないように入れる定番パズル。メモとヒントも使えます。</p>
      </div>

      <div className="classic-controls" role="group" aria-label="難易度">
        {LEVELS.map((lv) => (
          <div
            key={lv.key}
            {...tappableProps(() => restart(lv.key))}
            aria-pressed={difficulty === lv.key}
            className={difficulty === lv.key ? "classic-btn classic-btn-active" : "classic-btn"}
          >
            {lv.label}
          </div>
        ))}
        <button type="button" className="classic-btn" onClick={() => restart(difficulty)}>
          もう一度
        </button>
        <div
          {...tappableProps(() => setNoteMode((v) => !v))}
          aria-pressed={noteMode}
          className={noteMode ? "classic-btn classic-btn-active" : "classic-btn"}
        >
          メモ{noteMode ? " ON" : " OFF"}
        </div>
      </div>

      <p className="classic-status" role="status">
        時間 {formatTime(seconds)} ・ ミス {state.mistakes} 回 ・ ヒント残り {state.hintsLeft} 回
        {state.status === "won" ? ` ・ 完成！ ${formatTime(seconds)} でクリアです。` : ""}
        {state.status !== "won" && selected === null ? " ・ マスを選んで数字を入れてください。" : ""}
      </p>

      {webglFailed ? board2d : (
        <div style={{ width: "100%", maxWidth: 450 }}>
          <SudokuScene3D
            board={state.board}
            givens={state.givens}
            notes={state.notes}
            selected={selected}
            conflicts={conflicts}
            mistakes={mistakes}
            lastHint={state.lastHint}
            onCell={selectCell}
            onHint={onHint}
            onFail={() => setWebglFailed(true)}
            fallback={board2d}
          />
        </div>
      )}
      {notesSummary.length > 0 ? (
        <p className="muted" style={{ fontSize: 13, marginTop: 8, maxWidth: 450 }}>
          メモ: {notesSummary.join(" / ")}
        </p>
      ) : null}

      <div
        role="group"
        aria-label="数字パッド"
        style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 14, maxWidth: 450 }}
      >
        {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
          <div
            key={n}
            {...tappableProps(() => onPad(n))}
            aria-label={`数字 ${n}`}
            className="classic-btn"
            style={{ minWidth: 44, minHeight: 44, fontSize: 18, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center" }}
          >
            {n}
          </div>
        ))}
        <div
          {...tappableProps(() => onPad(0))}
          aria-label="消す"
          className="classic-btn"
          style={{ minWidth: 44, minHeight: 44, display: "flex", alignItems: "center", justifyContent: "center" }}
        >
          消す
        </div>
      </div>
      <p className="muted" style={{ fontSize: 13, marginTop: 8 }}>
        赤いマスは解答と違うか、同じ列・行・ブロックで重なっています。完成後は操作できません。
        盤面を上にスワイプするとヒントを使えます。物理キーボードの 1〜9 / Backspace でも入力できます。
      </p>

      {state.status === "won" && (
        <div style={{ marginTop: 14, maxWidth: 450 }}>
          <EndScreen outcome="win" title="完成！" onRetry={() => restart(difficulty)}>
            <p>
              タイム {formatTime(seconds)} ・ ミス {state.mistakes} 回 ・ ヒント残り {state.hintsLeft} 回
            </p>
          </EndScreen>
        </div>
      )}
    </>
  );
}
