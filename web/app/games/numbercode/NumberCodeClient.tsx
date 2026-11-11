"use client";
// ナンバーコード。ロジックは lib/numbercode.ts（重複なし3桁、EAT/BITE 判定）。
// 数字パッドで3桁を入力して提出する。端末内で完結し、サーバーへ送信しない。
import Link from "next/link";
import { useState, type CSSProperties } from "react";
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

  const pushDigit = (d: number) => {
    if (!playing) return;
    setInput((cur) => (cur.length >= 3 || cur.includes(d) ? cur : [...cur, d]));
  };
  const backspace = () => setInput((cur) => cur.slice(0, -1));
  const submit = () => {
    if (!isValidNcGuess(input)) return;
    setState((s) => submitNcGuess(s, input));
    setInput([]);
  };
  const restart = () => {
    setState(createNumberCodeGame(Date.now() % 2147483647));
    setInput([]);
  };

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
          EAT は数字も位置も一致、BITE は数字だけ一致。手がかりを読み解いて、3桁のコードを絞り込みます。
        </p>
      </div>

      <p className="classic-status" role="status" style={{ justifyContent: "center" }}>
        {state.status === "won"
          ? `${state.guesses.length}回で正解！ コードは ${state.code.join("")} でした。`
          : state.status === "lost"
            ? `回数オーバー… 正解は ${state.code.join("")} でした。`
            : `残り ${remaining} 回 ・ これまでの回答 ${state.guesses.length} 件`}
      </p>

      <div style={{ display: "flex", gap: 10, justifyContent: "center", margin: "14px 0" }} role="group" aria-label="入力中の数字">
        {[0, 1, 2].map((i) => (
          <div key={i} style={slotStyle}>
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
              <button key={d} type="button" disabled={input.includes(d)} onClick={() => pushDigit(d)} style={padStyle(input.includes(d))} aria-label={`数字${d}`}>
                {d}
              </button>
            ))}
          </div>
          <div className="classic-controls" style={{ justifyContent: "center", marginTop: 12 }}>
            <button type="button" className="classic-btn" onClick={backspace} disabled={input.length === 0}>
              ⌫ 消す
            </button>
            <button type="button" className="classic-btn" onClick={() => setInput([])} disabled={input.length === 0}>
              クリア
            </button>
            <button type="button" className="classic-btn classic-btn-active" onClick={submit} disabled={!isValidNcGuess(input)}>
              回答する
            </button>
          </div>
        </>
      ) : (
        <div className="classic-controls" style={{ justifyContent: "center" }}>
          <button type="button" className="classic-btn classic-btn-active" onClick={restart}>
            もう一度
          </button>
        </div>
      )}

      {state.guesses.length > 0 ? (
        <div style={{ maxWidth: 420, margin: "20px auto 0" }}>
          <h2 style={{ fontSize: 16, margin: "0 0 8px" }}>履歴</h2>
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6 }}>
            {[...state.guesses].reverse().map((g, i) => (
              <li
                key={state.guesses.length - i}
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
