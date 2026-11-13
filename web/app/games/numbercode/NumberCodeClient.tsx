"use client";
// ナンバーコード。ロジックは lib/numbercode.ts（重複なし3桁、EAT/BITE 判定）。
// 数字パッドで3桁を入力して提出する。端末内で完結し、サーバーへ送信しない。
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { sfxLose, sfxPlace, sfxTap, sfxWin } from "@/lib/sfx";
import { tappableProps, useGesture } from "@/lib/gesture";
import { EndScreen } from "../GameJuice";
import {
  createNumberCodeGame,
  isValidNcGuess,
  ncRemainingTries,
  submitNcGuess,
  type NcState,
} from "@/lib/numbercode";
import { useGamesNav } from "../GamesShell";

const slotStyle: CSSProperties = {
  width: 64,
  height: 76,
  display: "grid",
  placeItems: "center",
  borderRadius: 12,
  border: "2px solid #c9b489",
  background: "#fffdf6",
  fontSize: 36,
  fontWeight: 800,
};

const padStyle = (used: boolean): CSSProperties => ({
  minHeight: 52,
  borderRadius: 12,
  border: "2px solid #d8c9a3",
  background: used ? "#e5e7eb" : "#fffdf6",
  color: used ? "#9ca3af" : "inherit",
  fontSize: 20,
  fontWeight: 700,
  cursor: used ? "default" : "pointer",
  touchAction: "manipulation",
});

export default function NumberCodeClient() {
  const { prefix } = useGamesNav();
  const [state, setState] = useState<NcState>(() => createNumberCodeGame(Date.now() % 2147483647));
  const [input, setInput] = useState<number[]>([]);

  const playing = state.status === "playing";
  const remaining = ncRemainingTries(state);

  const prevStatusRef = useRef(state.status);
  useEffect(() => {
    if (prevStatusRef.current === "playing" && state.status !== "playing") {
      if (state.status === "won") sfxWin();
      else sfxLose();
    }
    prevStatusRef.current = state.status;
  }, [state.status]);

  const pushDigit = useCallback(
    (d: number) => {
      if (!playing) return;
      if (input.length < 3 && !input.includes(d)) sfxTap();
      setInput((cur) => (cur.length >= 3 || cur.includes(d) ? cur : [...cur, d]));
    },
    [input, playing],
  );
  const backspace = useCallback(() => {
    if (input.length > 0) sfxTap();
    setInput((cur) => cur.slice(0, -1));
  }, [input]);
  const clearInput = useCallback(() => {
    if (input.length === 0) return;
    sfxTap();
    setInput([]);
  }, [input]);
  const submit = useCallback(() => {
    if (!isValidNcGuess(input)) return;
    sfxPlace();
    setState((s) => submitNcGuess(s, input));
    setInput([]);
  }, [input]);
  const restart = () => {
    setState(createNumberCodeGame(Date.now() % 2147483647));
    setInput([]);
  };

  // 入力枠の上スワイプ=回答する、左スワイプ=クリア。
  const slotsGesture = useGesture({
    onSwipe: (dir) => {
      if (dir === "up") submit();
      else if (dir === "left") clearInput();
    },
  });

  // 物理キーボードでも入力できる（sudoku / skyscrapers と同じ）。
  // 数字パッド・操作チップにフォーカスがあるときの Enter は、その要素の
  // Enter ハンドラに任せ、window 側の回答と二重に走らせない（wordle の教訓）。
  // 数字・Backspace には div 側のハンドラがないためガードは Enter 分岐の中だけ。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Enter") {
        if ((e.target as HTMLElement | null)?.closest?.("[data-numbercode-key]")) return;
        submit();
      } else if (e.key === "Backspace") {
        backspace();
      } else if (/^[0-9]$/.test(e.key)) {
        pushDigit(Number(e.key));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pushDigit, backspace, submit]);

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>ナンバーコード</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>ナンバーコード</h1>
        <p className="muted">
          EAT は数字も位置も一致、BITE は数字だけ一致。手がかりを読み解いて、3桁のコードを絞り込みます。入力枠を上にスワイプすると回答、左にスワイプするとクリア。キーボードの数字・Backspace・Enter でも入力できます。
        </p>
      </div>

      <p className="classic-status" role="status" style={{ justifyContent: "center" }}>
        {state.status === "won"
          ? `${state.guesses.length}回で正解！ コードは ${state.code.join("")} でした。`
          : state.status === "lost"
            ? `回数オーバー… 正解は ${state.code.join("")} でした。`
            : `残り ${remaining} 回 ・ これまでの回答 ${state.guesses.length} 件`}
      </p>

      <div
        {...slotsGesture}
        style={{ display: "flex", gap: 10, justifyContent: "center", margin: "14px 0", touchAction: "none" }}
        role="group"
        aria-label="入力中の数字"
      >
        {[0, 1, 2].map((i) => (
          <div key={`${i}-${input[i] ?? "empty"}`} className={input[i] !== undefined ? "juice-pop" : undefined} style={slotStyle}>
            {input[i] !== undefined ? input[i] : "・"}
          </div>
        ))}
      </div>

      {playing ? (
        <>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(5, minmax(0, 1fr))",
              gap: 8,
              maxWidth: 360,
              margin: "0 auto",
            }}
            role="group"
            aria-label="数字パッド"
          >
            {[1, 2, 3, 4, 5, 6, 7, 8, 9, 0].map((d) => (
              <div
                key={d}
                {...tappableProps(() => pushDigit(d))}
                style={padStyle(input.includes(d))}
                aria-label={`数字${d}`}
                aria-disabled={input.includes(d)}
                tabIndex={input.includes(d) ? -1 : 0}
                data-numbercode-key=""
              >
                {d}
              </div>
            ))}
          </div>
          <div className="classic-controls" style={{ justifyContent: "center", marginTop: 12 }}>
            <div
              {...tappableProps(backspace)}
              className="classic-btn"
              aria-disabled={input.length === 0}
              tabIndex={input.length === 0 ? -1 : 0}
              data-numbercode-key=""
            >
              ⌫ 消す
            </div>
            <div
              {...tappableProps(clearInput)}
              className="classic-btn"
              aria-disabled={input.length === 0}
              tabIndex={input.length === 0 ? -1 : 0}
              data-numbercode-key=""
            >
              クリア
            </div>
            <div
              {...tappableProps(submit)}
              className="classic-btn classic-btn-active"
              aria-disabled={!isValidNcGuess(input)}
              tabIndex={!isValidNcGuess(input) ? -1 : 0}
              data-numbercode-key=""
            >
              回答する
            </div>
          </div>
        </>
      ) : (
        <EndScreen
          outcome={state.status === "won" ? "win" : "lose"}
          title={state.status === "won" ? `${state.guesses.length}回で正解！` : "回数オーバー…"}
          onRetry={restart}
        >
          <p className="muted" style={{ textAlign: "center" }}>
            コードは {state.code.join("")} でした ・ 回答 {state.guesses.length} 件
          </p>
        </EndScreen>
      )}

      {state.guesses.length > 0 ? (
        <div style={{ maxWidth: 420, margin: "20px auto 0" }}>
          <h2 style={{ fontSize: 16, margin: "0 0 8px" }}>履歴</h2>
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6 }}>
            {[...state.guesses].reverse().map((g, i) => (
              <li
                key={state.guesses.length - i}
                className={i === 0 ? "juice-slide" : undefined}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  padding: "8px 12px",
                  borderRadius: 10,
                  border: "1px solid #e5e7eb",
                  background: "#fffdf6",
                }}
              >
                <span style={{ fontWeight: 800, letterSpacing: 4 }}>{g.digits.join("")}</span>
                <span>
                  <strong style={{ color: "#b45309" }}>{g.eat} EAT</strong>
                  <span aria-hidden="true"> ・ </span>
                  <strong style={{ color: "#2563eb" }}>{g.bite} BITE</strong>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );
}
