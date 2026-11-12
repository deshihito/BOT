"use client";
// 覆面算。ロジックは lib/alphametic.ts（解は必ず1つだけになるよう生成時に検証済み）。
// 記号を選んで数字パッドで割り当てる。端末内で完結し、ベストタイムは
// localStorage の ago-alphametic-best に保存する。
import Link from "next/link";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  alphameticTermValue,
  createAlphameticGame,
  evaluateAlphametic,
  setAlphameticGuess,
  type AlphameticState,
} from "@/lib/alphametic";
import { sfxPlace, sfxTap, sfxWin } from "@/lib/sfx";
import { EndScreen } from "../GameJuice";
import { useGamesNav } from "../GamesShell";

const BEST_KEY = "ago-alphametic-best";

function newGame(): AlphameticState {
  return createAlphameticGame(Date.now() % 2147483647);
}

export default function AlphameticClient() {
  const { prefix } = useGamesNav();
  const [state, setState] = useState<AlphameticState>(() => newGame());
  const [selected, setSelected] = useState<string | null>(null);
  const [seconds, setSeconds] = useState(0);
  const [best, setBest] = useState<number | null>(null);

  useEffect(() => {
    if (state.status !== "playing") return;
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [state.status]);

  useEffect(() => {
    try {
      const saved = Number(window.localStorage.getItem(BEST_KEY));
      setBest(Number.isFinite(saved) && saved > 0 ? saved : null);
    } catch {
      setBest(null);
    }
  }, []);

  const prevStatusRef = useRef(state.status);
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = state.status;
    if (prev !== state.status && state.status === "won") sfxWin();
  }, [state.status]);

  useEffect(() => {
    if (state.status !== "won" || seconds <= 0) return;
    if (best !== null && seconds >= best) return;
    setBest(seconds);
    try {
      window.localStorage.setItem(BEST_KEY, String(seconds));
    } catch {
      // 保存失敗はプレイに影響しない。
    }
  }, [state.status, seconds, best]);

  const restart = () => {
    setState(newGame());
    setSelected(null);
    setSeconds(0);
  };

  const ev = evaluateAlphametic(state);
  const aVal = alphameticTermValue(state.a, state.guesses);
  const bVal = alphameticTermValue(state.b, state.guesses);
  const cVal = alphameticTermValue(state.c, state.guesses);
  const assignedCount = state.symbols.filter((s) => state.guesses[s] !== undefined).length;

  const statusText =
    state.status === "won"
      ? "等式が成り立ちました！クリアです。"
      : ev.complete
        ? `いまは ${aVal} + ${bVal} = ${cVal} で、等式は成り立っていません。`
        : "同じ数字は2つの記号に使えません。";

  const termRow = (term: string, op: string) => (
    <div style={{ display: "flex", alignItems: "center", gap: 6, justifyContent: "flex-end" }}>
      <span style={{ width: 28, textAlign: "center", fontSize: 30, fontWeight: 800 }}>{op}</span>
      <div style={{ display: "flex", gap: 4 }}>
        {term.split("").map((ch, i) => {
          const d = state.guesses[ch];
          const isSelected = selected === ch;
          return (
            <button
              key={`${ch}-${i}`}
              type="button"
              className={isSelected ? "juice-pulse" : undefined}
              aria-label={`記号 ${ch}${d !== undefined ? `（${d}）` : ""}`}
              aria-pressed={isSelected}
              onClick={() => {
                sfxTap();
                setSelected(isSelected ? null : ch);
              }}
              style={{
                width: 52,
                height: 62,
                borderRadius: 10,
                border: isSelected ? "3px solid var(--accent)" : "2px solid var(--line)",
                background: isSelected ? "var(--accent-soft)" : "var(--soft)",
                fontSize: 24,
                fontWeight: 800,
                cursor: "pointer",
                touchAction: "manipulation",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                lineHeight: 1.1,
                padding: 0,
              }}
            >
              <span>{ch}</span>
              <span
                key={d !== undefined ? d : "empty"}
                className={d !== undefined ? "juice-pop" : undefined}
                style={{ fontSize: 14, color: d !== undefined ? "var(--accent)" : "var(--muted, #999)", minHeight: 18 }}
              >
                {d !== undefined ? d : "・"}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );

  const padBtn = (label: string, disabled: boolean, onClick: () => void, extra?: CSSProperties) => (
    <button
      key={label}
      type="button"
      className="classic-btn"
      disabled={disabled}
      onClick={onClick}
      style={{ minWidth: 44, minHeight: 48, fontSize: 17, fontWeight: 700, ...extra }}
    >
      {label}
    </button>
  );

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>覆面算</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>覆面算</h1>
        <p className="muted">式の中の記号をタップして選び、下の数字パッドで数字を割り当てます。</p>
      </div>

      <div className="classic-controls">
        <button type="button" className="classic-btn" onClick={restart}>
          もう一度
        </button>
      </div>

      <p className="classic-status" role="status">
        割り当て {assignedCount} / {state.symbols.length} ・ {seconds} 秒
        {best !== null ? ` ・ ベスト ${best} 秒` : ""} ・ {statusText}
      </p>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 8,
          alignItems: "flex-end",
          width: "fit-content",
          margin: "10px auto 0",
          padding: "16px 18px",
          borderRadius: 12,
          background: "var(--soft)",
        }}
        role="group"
        aria-label="覆面算の式"
      >
        {termRow(state.a, "")}
        {termRow(state.b, "+")}
        <div style={{ width: "100%", borderTop: "3px solid currentColor", opacity: 0.35 }} />
        {termRow(state.c, "=")}
      </div>

      <div
        style={{
          display: "flex",
          gap: 6,
          justifyContent: "center",
          flexWrap: "wrap",
          marginTop: 16,
          maxWidth: 560,
          marginLeft: "auto",
          marginRight: "auto",
        }}
        role="group"
        aria-label="数字パッド"
      >
        {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => {
          const usedBy = state.symbols.find((s) => s !== selected && state.guesses[s] === d);
          const disabled =
            state.status !== "playing" ||
            selected === null ||
            usedBy !== undefined ||
            (d === 0 && selected !== null && state.leading.includes(selected));
          return padBtn(String(d), disabled, () => {
            if (selected === null) return;
            const next = setAlphameticGuess(state, selected, d);
            // 完成（won）は終局ジングル側が担当する。
            if (next !== state && next.status === "playing") sfxPlace();
            setState(next);
          });
        })}
        {padBtn(
          "消す",
          state.status !== "playing" || selected === null || state.guesses[selected] === undefined,
          () => {
            if (selected === null) return;
            const next = setAlphameticGuess(state, selected, null);
            if (next !== state) sfxTap();
            setState(next);
          },
        )}
      </div>

      {state.status === "won" && (
        <div style={{ maxWidth: 560, margin: "16px auto 0" }}>
          <EndScreen outcome="win" title="クリア！" score={seconds} scoreLabel="クリア時間（秒）" onRetry={restart}>
            <p className="muted" style={{ margin: 0 }}>
              {aVal} + {bVal} = {cVal} ・ 割り当て {state.moves} 手
              {best !== null ? ` ・ ベスト ${best} 秒` : ""}
            </p>
          </EndScreen>
        </div>
      )}

      <p className="classic-status" style={{ justifyContent: "center" }}>
        {selected === null
          ? "まず式の中の記号をタップして選んでください。"
          : `「${selected}」を選択中${state.leading.includes(selected) ? "（先頭の記号には 0 は入りません）" : ""}`}
      </p>
    </>
  );
}
