"use client";
// カナクロス。ロジックは lib/kanacross.ts（内蔵問題・単語判定・完成判定）。
// マスを選んでカナパレット（またはキーボード）で入力する。端末内で完結する。
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  KANA_PALETTE_ROWS,
  KANACROSS_PUZZLES,
  checkWord,
  getKanacrossPuzzle,
  createKanacrossGame,
  progress,
  setEntry,
  wordCells,
  wordStatus,
  type KanaDirection,
  type KanaState,
  type KanaWord,
} from "@/lib/kanacross";
import { sfxCorrect, sfxPlace, sfxTap, sfxWin, sfxWrong } from "@/lib/sfx";
import { EndScreen } from "../GameJuice";
import { useGamesNav } from "../GamesShell";

const btnStyle: React.CSSProperties = {
  padding: "10px 20px",
  borderRadius: 999,
  border: "1px solid #8a90a3",
  background: "#22304f",
  color: "#fff",
  fontSize: 15,
  fontWeight: 700,
  cursor: "pointer",
  minHeight: 44,
};

function wordAt(
  puzzleIndex: number,
  index: number,
  dir: KanaDirection,
): KanaWord | undefined {
  const puzzle = getKanacrossPuzzle(puzzleIndex);
  return puzzle.words.find(
    (w) => w.direction === dir && wordCells(puzzle, w).includes(index),
  );
}

export default function KanacrossClient() {
  const { prefix } = useGamesNav();
  const [state, setState] = useState<KanaState>(() => createKanacrossGame(0));
  const [selected, setSelected] = useState<{ index: number; dir: KanaDirection } | null>(null);
  const [notice, setNotice] = useState("");
  const [seconds, setSeconds] = useState(0);

  const puzzle = getKanacrossPuzzle(state.puzzleIndex);
  const prog = progress(state);

  const prevStatusRef = useRef(state.status);
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = state.status;
    if (prev !== state.status && state.status === "completed") sfxWin();
  }, [state.status]);

  useEffect(() => {
    if (state.status !== "playing") return;
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [state.status, state.puzzleIndex]);

  const selectedWord = useMemo(
    () => (selected ? wordAt(state.puzzleIndex, selected.index, selected.dir) : undefined),
    [state.puzzleIndex, selected],
  );
  const selectedCells = useMemo(
    () => (selectedWord ? wordCells(puzzle, selectedWord) : []),
    [puzzle, selectedWord],
  );
  const correctCells = useMemo(() => {
    const set = new Set<number>();
    for (const w of puzzle.words) {
      if (wordStatus(state, w.id) === "correct") {
        for (const i of wordCells(puzzle, w)) set.add(i);
      }
    }
    return set;
  }, [puzzle, state]);

  const changePuzzle = (index: number) => {
    setState(createKanacrossGame(index));
    setSelected(null);
    setNotice("");
    setSeconds(0);
  };

  const onCell = (index: number) => {
    if (puzzle.solution[index] === null) return;
    sfxTap();
    const across = wordAt(state.puzzleIndex, index, "across");
    const down = wordAt(state.puzzleIndex, index, "down");
    if (selected && selected.index === index && across && down) {
      setSelected({ index, dir: selected.dir === "across" ? "down" : "across" });
      return;
    }
    setSelected({ index, dir: across ? "across" : "down" });
  };

  const inputChar = (ch: string) => {
    if (!selected || !selectedWord) return;
    const next = setEntry(state, selected.index, ch);
    if (next === state && ch !== "") return;
    // 完成（completed）は終局ジングル側が担当する。
    if (next !== state && next.status !== "completed") {
      if (ch === "") sfxTap();
      else sfxPlace();
    }
    setState(next);
    setNotice("");
    if (ch !== "") {
      const cells = wordCells(puzzle, selectedWord);
      const pos = cells.indexOf(selected.index);
      if (pos >= 0 && pos + 1 < cells.length) {
        setSelected({ index: cells[pos + 1], dir: selected.dir });
      }
    }
  };

  const backspace = () => {
    if (!selected || !selectedWord) return;
    if (state.entries[selected.index] !== "") {
      inputChar("");
      return;
    }
    const cells = wordCells(puzzle, selectedWord);
    const pos = cells.indexOf(selected.index);
    if (pos > 0) setSelected({ index: cells[pos - 1], dir: selected.dir });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Backspace") {
        e.preventDefault();
        backspace();
        return;
      }
      if (/^[ァ-ヶー]$/.test(e.key)) {
        inputChar(e.key);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const onCheck = () => {
    if (!selectedWord) {
      setNotice("まず単語かマスを選んでください。");
      return;
    }
    const { state: next, status } = checkWord(state, selectedWord.id);
    if (status === "correct") sfxCorrect();
    else if (status === "wrong") sfxWrong();
    setState(next);
    setNotice(
      status === "correct"
        ? `「${selectedWord.answer}」正解です！`
        : status === "wrong"
          ? "全部埋まっていますが、どこか違います。"
          : "まだ埋まっていないマスがあります。",
    );
  };

  const selectWord = (word: KanaWord) => {
    sfxTap();
    const cells = wordCells(puzzle, word);
    setSelected({ index: cells[0], dir: word.direction });
    setNotice("");
  };

  const wordList = (dir: KanaDirection, label: string) => (
    <section aria-label={label} style={{ flex: "1 1 220px" }}>
      <h2 style={{ fontSize: 15, margin: "0 0 6px" }}>{label}</h2>
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6 }}>
        {puzzle.words
          .filter((w) => w.direction === dir)
          .map((w) => {
            const st = wordStatus(state, w.id);
            const active = selectedWord?.id === w.id;
            return (
              <li key={w.id}>
                <button
                  type="button"
                  onClick={() => selectWord(w)}
                  aria-pressed={active}
                  style={{
                    width: "100%",
                    textAlign: "left",
                    minHeight: 44,
                    padding: "8px 10px",
                    borderRadius: 10,
                    border: active ? "2px solid #33509e" : "1px solid #d5d8e0",
                    background:
                      st === "correct" ? "#e4f3e6" : active ? "#eef3fd" : "#ffffff",
                    fontSize: 14,
                    cursor: "pointer",
                  }}
                >
                  <strong>
                    {w.length}文字 {st === "correct" ? "✓" : ""}
                  </strong>
                  {" "}— {w.hint}
                </button>
              </li>
            );
          })}
      </ul>
    </section>
  );

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>カナクロス</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>カナクロス</h1>
        <p className="muted">
          マスを選んで下のパレットで入力します。交差するマスでもう一度押すと方向が切り替わります。
        </p>
      </div>

      <div className="classic-controls" style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }} role="group" aria-label="問題の選択">
        {KANACROSS_PUZZLES.map((p, i) => (
          <button
            key={p.id}
            type="button"
            style={btnStyle}
            aria-pressed={state.puzzleIndex === i}
            onClick={() => changePuzzle(i)}
          >
            {p.title}
          </button>
        ))}
        <button type="button" style={btnStyle} onClick={() => changePuzzle(state.puzzleIndex)}>
          もう一度
        </button>
      </div>

      <p className={`classic-status${notice.includes("どこか違います") ? " juice-shake" : ""}`} role="status">
        {puzzle.title} ・ 入力 {prog.filled} / {prog.total} マス ・ チェックのミス {state.mistakes} 回 ・ {seconds} 秒
        {state.status === "completed" ? ` ・ 完成！ お見事です（${seconds} 秒）。` : ""}
        {notice ? ` ・ ${notice}` : ""}
      </p>

      <div style={{ display: "flex", gap: 22, flexWrap: "wrap", alignItems: "flex-start" }}>
        <div>
          <div
            role="grid"
            aria-label="カナクロスの盤"
            style={{
              display: "grid",
              gridTemplateColumns: `repeat(${puzzle.cols}, 46px)`,
              gap: 3,
            }}
          >
            {puzzle.solution.map((answer, i) => {
              if (answer === null) {
                return <div key={i} style={{ width: 46, height: 46, background: "#22304f", borderRadius: 6 }} aria-hidden="true" />;
              }
              const isSelected = selected?.index === i;
              const inWord = selectedCells.includes(i);
              const correct = correctCells.has(i);
              return (
                <button
                  key={i}
                  type="button"
                  role="gridcell"
                  className={isSelected ? "juice-pulse" : correct ? "juice-pop" : undefined}
                  aria-label={`${Math.floor(i / puzzle.cols) + 1}行${(i % puzzle.cols) + 1}列${state.entries[i] ? ` ${state.entries[i]}` : " 空白"}`}
                  aria-pressed={isSelected}
                  onClick={() => onCell(i)}
                  style={{
                    width: 46,
                    height: 46,
                    borderRadius: 6,
                    border: isSelected ? "3px solid #d8542e" : "1px solid #b9bdc9",
                    background: correct ? "#cdeccd" : inWord ? "#dbe7fd" : "#ffffff",
                    fontSize: 22,
                    fontWeight: 700,
                    color: "#1c2333",
                    cursor: "pointer",
                    padding: 0,
                  }}
                >
                  {state.entries[i]}
                </button>
              );
            })}
          </div>

          <div aria-label="カナ入力パレット" style={{ marginTop: 14, display: "grid", gap: 4, maxWidth: 480 }}>
            {KANA_PALETTE_ROWS.map((row, ri) => (
              <div key={ri} style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                {row.split("").map((ch) => (
                  <button
                    key={ch}
                    type="button"
                    onClick={() => inputChar(ch)}
                    style={{
                      width: 42,
                      height: 42,
                      borderRadius: 8,
                      border: "1px solid #b9bdc9",
                      background: "#ffffff",
                      fontSize: 17,
                      fontWeight: 700,
                      cursor: "pointer",
                    }}
                  >
                    {ch}
                  </button>
                ))}
                {ri === KANA_PALETTE_ROWS.length - 1 && (
                  <button
                    type="button"
                    onClick={backspace}
                    style={{
                      height: 42,
                      padding: "0 14px",
                      borderRadius: 8,
                      border: "1px solid #b9bdc9",
                      background: "#eef0f5",
                      fontSize: 14,
                      fontWeight: 700,
                      cursor: "pointer",
                    }}
                  >
                    消す
                  </button>
                )}
              </div>
            ))}
          </div>

          <div className="classic-controls" style={{ marginTop: 12 }}>
            <button type="button" style={btnStyle} onClick={onCheck}>
              選んだ単語をチェック
            </button>
          </div>
        </div>

        <div style={{ display: "flex", gap: 18, flexWrap: "wrap", flex: "1 1 300px" }}>
          {wordList("across", "→ よこのヒント")}
          {wordList("down", "↓ たてのヒント")}
        </div>
      </div>

      {state.status === "completed" && (
        <div style={{ marginTop: 16 }}>
          <EndScreen outcome="win" title="完成！" onRetry={() => changePuzzle(state.puzzleIndex)}>
            <p className="muted" style={{ margin: 0 }}>
              {puzzle.title} ・ {seconds} 秒 ・ チェックのミス {state.mistakes} 回
            </p>
          </EndScreen>
        </div>
      )}
    </>
  );
}
