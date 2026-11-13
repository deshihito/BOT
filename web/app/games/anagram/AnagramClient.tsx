"use client";
// アナグラム。ロジックは lib/anagram.ts（カタカナ単語10問・タイル並べ替え）。
// タイルをタップして並べ、揃ったら「答える」。ヒントは1文字開示で -20点。
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { sfxCorrect, sfxLose, sfxTap, sfxWin, sfxWrong } from "@/lib/sfx";
import { tappableProps, useGesture } from "@/lib/gesture";
import { EndScreen } from "../GameJuice";
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
  // 直前の「外す」操作の時刻。回答欄のダブルタップ=ヒントが、マスの連続タップ
  // （外す操作）と重なって誤発火しないためのガード（下の onDoubleTap 参照）。
  const lastUnpickAtRef = useRef(0);

  useEffect(() => {
    if (state.status === "finished") return;
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [state.status]);

  const restart = () => {
    setState(newGame());
    setSeconds(0);
  };

  const prevStatusRef = useRef(state.status);
  useEffect(() => {
    if (prevStatusRef.current !== "finished" && state.status === "finished") {
      if (state.correctCount >= state.words.length * 0.7) sfxWin();
      else sfxLose();
    }
    prevStatusRef.current = state.status;
  }, [state]);

  const onSubmit = () => {
    const next = submitAnswer(state);
    if (next.status === "answered") {
      if (next.lastCorrect) sfxCorrect();
      else sfxWrong();
    }
    setState(next);
  };

  const word = currentWord(state);
  const wordLen = word ? [...word].length : 0;
  const answered = state.status === "answered";
  const allPicked = state.picked.length === state.tiles.length && state.tiles.length > 0;

  const trySubmit = () => {
    if (!allPicked || answered) return;
    onSubmit();
  };
  const tryClear = () => {
    if (state.picked.length === 0 || answered) return;
    sfxTap();
    setState((s) => clearPicks(s));
  };
  const tryHint = () => {
    if (answered || state.hintPositions.length >= wordLen) return;
    sfxTap();
    setState((s) => useHint(s));
  };

  // 回答欄のジェスチャ: 上スワイプ = 答える、左スワイプ = 並べ直す、
  // ダブルタップ = ヒント。キーボードは回答欄フォーカス時の Enter / Space・
  // Backspace・H。window リスナーはないため二重発火の余地はない。
  // 子の回答マスの onClick との二重発火は useGesture の suppressClickAfterSwipe が抑止する。
  // ただしダブルタップ判定は子のマスのタップも拾うため、直前に外す操作が
  // あった場合はヒントにしない（lastUnpickAtRef 参照）。
  const answerGesture = useGesture({
    onSwipe: (dir) => {
      if (dir === "up") trySubmit();
      else if (dir === "left") tryClear();
    },
    onDoubleTap: () => {
      // マスのタップは click（外す）が pointerup より後に発火するため、
      // 同じマスのダブルタップや2マスの連続タップもダブルタップ判定に入る。
      // 直前に外す操作があった場合はヒントにしない（-20点の誤発火を防ぐ）。
      if (Date.now() - lastUnpickAtRef.current < 400) return;
      tryHint();
    },
  });

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>アナグラム</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>アナグラム</h1>
        <p className="muted">文字タイルをタップして並べ、答えができたら回答欄を上にスワイプ（または Enter）で判定します。左スワイプで並べ直し、ダブルタップでヒント（-20点）。</p>
      </div>

      <p className="classic-status" role="status">
        {state.status === "finished"
          ? `終了！スコア ${state.score} 点 ・ 正解 ${state.correctCount} / ${state.words.length} 問 ・ ${seconds} 秒`
          : `第 ${state.index + 1} 問 / ${state.words.length} ・ スコア ${state.score} 点 ・ ${seconds} 秒`}
      </p>

      {state.status === "finished" ? (
        <div style={{ maxWidth: 480, margin: "0 auto" }}>
          <EndScreen
            outcome={state.correctCount === state.words.length ? "win" : "finish"}
            title={
              state.correctCount === state.words.length
                ? "全問正解！"
                : state.correctCount >= state.words.length * 0.7
                  ? "なかなかの出来です"
                  : "おつかれさまでした"
            }
            score={state.score}
            scoreLabel="スコア"
            onRetry={restart}
          >
            <p className="muted" style={{ textAlign: "center" }}>
              スコア {state.score} 点（満点 {state.words.length * 100} 点）・ 正解 {state.correctCount} 問 ・ タイム {seconds} 秒
            </p>
          </EndScreen>
        </div>
      ) : (
        <div style={{ maxWidth: 520, margin: "0 auto" }}>
          {/* 回答欄 */}
          <div
            aria-label="あなたの回答（上にスワイプで答える・左スワイプで並べ直す・ダブルタップでヒント）"
            role="group"
            tabIndex={0}
            {...answerGesture}
            onKeyDown={(e) => {
              // 子の回答マス（tappableProps）の Enter / Space はマス自身が受けるため、
              // 回答欄そのものにフォーカスがあるときだけ判定する。ガードがないと
              // 全選択済みのマスで Enter を押したときに外す操作と判定が両方走る
              // （reaction / wordle の二重発火と同じ構図）。
              if ((e.key === "Enter" || e.key === " ") && e.target !== e.currentTarget) return;
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                trySubmit();
              } else if (e.key === "Backspace") {
                e.preventDefault();
                tryClear();
              } else if (e.key === "h" || e.key === "H") {
                tryHint();
              }
            }}
            style={{ display: "flex", gap: 6, justifyContent: "center", flexWrap: "wrap", minHeight: 60, touchAction: "none" }}
          >
            {Array.from({ length: wordLen }, (_, pos) => {
              const tileId = state.picked[pos];
              const tile = tileId !== undefined ? state.tiles.find((t) => t.id === tileId) : undefined;
              const hint = hintCharAt(state, pos);
              const slotStyle: React.CSSProperties = {
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
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              };
              const hintMark = hint && !tile ? (
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
              ) : null;
              if (!tile || answered) {
                return (
                  <div
                    key={pos}
                    aria-label={tile ? `${pos + 1}文字目 ${tile.char} を外す` : `${pos + 1}文字目（空き）`}
                    aria-disabled="true"
                    tabIndex={-1}
                    style={slotStyle}
                  >
                    {tile ? tile.char : ""}
                    {hintMark}
                  </div>
                );
              }
              return (
                <div
                  key={pos}
                  {...tappableProps(() => { sfxTap(); lastUnpickAtRef.current = Date.now(); setState((s) => unpickTile(s, pos)); })}
                  aria-label={tile ? `${pos + 1}文字目 ${tile.char} を外す` : `${pos + 1}文字目（空き）`}
                  style={slotStyle}
                >
                  {tile ? tile.char : ""}
                  {hintMark}
                </div>
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
              const tileStyle: React.CSSProperties = {
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
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              };
              if (used || answered) {
                return (
                  <div key={tile.id} aria-label={tile.char} aria-disabled="true" tabIndex={-1} style={tileStyle}>
                    {used ? "・" : tile.char}
                  </div>
                );
              }
              return (
                <div
                  key={tile.id}
                  {...tappableProps(() => { sfxTap(); setState((s) => pickTile(s, tile.id)); })}
                  aria-label={tile.char}
                  style={tileStyle}
                >
                  {tile.char}
                </div>
              );
            })}
          </div>

          {answered ? (
            <div style={{ textAlign: "center", marginTop: 18 }}>
              <p role="status" className={state.lastCorrect ? "juice-pop" : "juice-shake"} style={{ fontWeight: 800, fontSize: 18, margin: "0 0 10px" }}>
                {state.lastCorrect ? "○ 正解！" : `✕ 不正解。正解は「${word ?? ""}」でした。`}
              </p>
              <div
                {...tappableProps(() => { sfxTap(); setState((s) => nextQuestion(s)); })}
                className="classic-btn"
                style={{ fontWeight: 800 }}
              >
                {state.index + 1 >= state.words.length ? "結果を見る" : "次の問題へ →"}
              </div>
            </div>
          ) : (
            <div className="classic-controls" style={{ justifyContent: "center", marginTop: 18 }}>
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
