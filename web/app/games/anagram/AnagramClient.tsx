"use client";
// アナグラム。ロジックは lib/anagram.ts（カタカナ単語10問・タイル並べ替え）。
// タイルをタップして並べ、揃ったら「答える」。ヒントは1文字開示で -20点。
import Link from "next/link";
import { useEffect, useState } from "react";
import {
  clearPicks,
  currentWord,
  hintCharAt,
  nextQuestion,
  pickTile,
  submitAnswer,
  unpickTile,
  useHint,
  createAnagramGame,
  type AnagramState,
} from "@/lib/anagram";
import { useGamesNav } from "../GamesShell";

function newGame(): AnagramState {
  return createAnagramGame(Date.now() % 2147483647);
}

export default function AnagramClient() {
  const { prefix } = useGamesNav();
  const [state, setState] = useState<AnagramState>(() => newGame());
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    if (state.status === "finished") return;
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [state.status]);

  const restart = () => {
    setState(newGame());
    setSeconds(0);
  };

  const word = currentWord(state);
  const wordLen = word ? [...word].length : 0;
  const answered = state.status === "answered";
  const allPicked = state.picked.length === state.tiles.length && state.tiles.length > 0;

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>アナグラム</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>アナグラム</h1>
        <p className="muted">文字タイルをタップして並べ、答えができたら「答える」で判定します。</p>
      </div>

      <p className="classic-status" role="status">
        {state.status === "finished"
          ? `終了！スコア ${state.score} 点 ・ 正解 ${state.correctCount} / ${state.words.length} 問 ・ ${seconds} 秒`
          : `第 ${state.index + 1} 問 / ${state.words.length} ・ スコア ${state.score} 点 ・ ${seconds} 秒`}
      </p>

      {state.status === "finished" ? (
        <div style={{ textAlign: "center", maxWidth: 480, margin: "0 auto" }}>
          <h2 style={{ fontSize: 24, margin: "12px 0" }}>
            {state.correctCount === state.words.length
              ? "🎉 全問正解！"
              : state.correctCount >= state.words.length * 0.7
                ? "👏 なかなかの出来です"
                : "おつかれさまでした"}
          </h2>
          <p className="muted">
            スコア {state.score} 点（満点 {state.words.length * 100} 点）・ 正解 {state.correctCount} 問 ・ タイム {seconds} 秒
          </p>
          <button type="button" className="classic-btn" onClick={restart}>
            もう一度
          </button>
        </div>
      ) : (
        <div style={{ maxWidth: 520, margin: "0 auto" }}>
          {/* 回答欄 */}
          <div
            aria-label="あなたの回答"
            style={{ display: "flex", gap: 6, justifyContent: "center", flexWrap: "wrap", minHeight: 60 }}
          >
            {Array.from({ length: wordLen }, (_, pos) => {
              const tileId = state.picked[pos];
              const tile = tileId !== undefined ? state.tiles.find((t) => t.id === tileId) : undefined;
              const hint = hintCharAt(state, pos);
              return (
                <button
                  key={pos}
                  type="button"
                  disabled={!tile || answered}
                  onClick={() => setState((s) => unpickTile(s, pos))}
                  aria-label={tile ? `${pos + 1}文字目 ${tile.char} を外す` : `${pos + 1}文字目（空き）`}
                  style={{
                    width: 52,
                    height: 56,
                    borderRadius: 10,
                    border: tile ? "2px solid #4a6fa5" : "2px dashed #c9b98f",
                    background: tile ? "#e0eaff" : "#fffdf6",
                    fontSize: 24,
                    fontWeight: 800,
                    cursor: tile && !answered ? "pointer" : "default",
                    position: "relative",
                    touchAction: "manipulation",
                  }}
                >
                  {tile ? tile.char : ""}
                  {hint && !tile ? (
                    <span
                      style={{
                        position: "absolute",
                        inset: 0,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        color: "#b45309",
                        opacity: 0.55,
                      }}
                    >
                      {hint}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>

          {/* タイル置き場 */}
          <div
            aria-label="文字タイル"
            style={{ display: "flex", gap: 6, justifyContent: "center", flexWrap: "wrap", marginTop: 14 }}
          >
            {state.tiles.map((tile) => {
              const used = state.picked.includes(tile.id);
              return (
                <button
                  key={tile.id}
                  type="button"
                  disabled={used || answered}
                  onClick={() => setState((s) => pickTile(s, tile.id))}
                  style={{
                    width: 52,
                    height: 56,
                    borderRadius: 10,
                    border: "2px solid #d8c9a3",
                    background: used ? "#e5e7eb" : "#fff3c4",
                    color: used ? "#9ca3af" : "inherit",
                    fontSize: 24,
                    fontWeight: 800,
                    cursor: used || answered ? "default" : "pointer",
                    touchAction: "manipulation",
                  }}
                >
                  {used ? "・" : tile.char}
                </button>
              );
            })}
          </div>

          {answered ? (
            <div style={{ textAlign: "center", marginTop: 18 }}>
              <p role="status" style={{ fontWeight: 800, fontSize: 18, margin: "0 0 10px" }}>
                {state.lastCorrect ? "⭕ 正解！" : `❌ 不正解。正解は「${word ?? ""}」でした。`}
              </p>
              <button
                type="button"
                className="classic-btn"
                onClick={() => setState((s) => nextQuestion(s))}
                style={{ fontWeight: 800 }}
              >
                {state.index + 1 >= state.words.length ? "結果を見る" : "次の問題へ →"}
              </button>
            </div>
          ) : (
            <div className="classic-controls" style={{ justifyContent: "center", marginTop: 18 }}>
              <button
                type="button"
                className="classic-btn"
                disabled={!allPicked}
                onClick={() => setState((s) => submitAnswer(s))}
                style={{ fontWeight: 800 }}
              >
                答える
              </button>
              <button
                type="button"
                className="classic-btn"
                disabled={state.picked.length === 0}
                onClick={() => setState((s) => clearPicks(s))}
              >
                並べ直す
              </button>
              <button
                type="button"
                className="classic-btn"
                disabled={state.hintPositions.length >= wordLen}
                onClick={() => setState((s) => useHint(s))}
              >
                💡 ヒント（-20点）
              </button>
              <button type="button" className="classic-btn" onClick={restart}>
                もう一度
              </button>
            </div>
          )}
          <p className="muted" style={{ textAlign: "center" }}>
            {wordLen} 文字の単語です。ヒントを使うと答えの文字が薄く表示されます（今 {state.hintsUsed} 回使用）。
          </p>
        </div>
      )}
    </>
  );
}
