"use client";
// 虫食い算。ロジックは lib/mushoku.ts（筆算を先に作り、一部を隠す）。
// 判定は元の答えとの一致ではなく「埋めた数字で筆算の式が整合するか」で行うため、
// 整合する別の解でもクリアになる。端末内で完結し、サーバーへ送信しない。
import Link from "next/link";
import { useEffect, useState } from "react";
import {
  checkMushoku,
  createMushoku,
  setMushokuInput,
  type MushokuLevel,
  type MushokuState,
} from "@/lib/mushoku";
import { useGamesNav } from "../GamesShell";

const LEVELS: { key: MushokuLevel; label: string }[] = [
  { key: "2x2", label: "2桁×2桁" },
  { key: "3x2", label: "3桁×2桁" },
];

const BEST_KEY = "ago-mushoku-best";

function loadBests(): Partial<Record<MushokuLevel, number>> {
  try {
    const raw = window.localStorage.getItem(BEST_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Partial<Record<MushokuLevel, number>>;
    }
  } catch {
    // 読めなければ記録なしとして扱う。
  }
  return {};
}

export default function MushokuClient() {
  const { prefix } = useGamesNav();
  const [level, setLevel] = useState<MushokuLevel>("2x2");
  const [state, setState] = useState<MushokuState>(() => createMushoku("2x2", Date.now() % 2147483647));
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [seconds, setSeconds] = useState(0);
  const [started, setStarted] = useState(false);
  const [bests, setBests] = useState<Partial<Record<MushokuLevel, number>>>({});
  const [wrongIds, setWrongIds] = useState<number[]>([]);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    setBests(loadBests());
  }, []);

  useEffect(() => {
    if (!started || state.status !== "playing") return;
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [started, state.status]);

  useEffect(() => {
    if (state.status !== "solved" || seconds <= 0) return;
    setBests((prev) => {
      const current = prev[level];
      if (current !== undefined && current <= seconds) return prev;
      const next = { ...prev, [level]: seconds };
      try {
        window.localStorage.setItem(BEST_KEY, JSON.stringify(next));
      } catch {
        // 保存失敗はプレイに影響しない。
      }
      return next;
    });
  }, [state.status, seconds, level]);

  const restart = (nextLevel: MushokuLevel) => {
    setLevel(nextLevel);
    setState(createMushoku(nextLevel, Date.now() % 2147483647));
    setSelectedId(null);
    setSeconds(0);
    setStarted(false);
    setWrongIds([]);
    setMessage(null);
  };

  const inputDigit = (digit: number | null) => {
    if (selectedId === null) return;
    setStarted(true);
    setWrongIds([]);
    setMessage(null);
    setState((s) => setMushokuInput(s, selectedId, digit));
  };

  useEffect(() => {
    if (selectedId === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key >= "0" && e.key <= "9") {
        inputDigit(Number(e.key));
      } else if (e.key === "Backspace" || e.key === "Delete") {
        inputDigit(null);
      } else if (e.key === "Escape") {
        setSelectedId(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // inputDigit は選択セルにのみ依存するため、selectedId の変化で張り直す。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  const onCheck = () => {
    const { state: next, evaluation } = checkMushoku(state);
    setState(next);
    setWrongIds(evaluation.wrongIds);
    if (evaluation.consistent) {
      setMessage("正解！筆算が完成しました。");
    } else if (evaluation.complete) {
      setMessage("全部埋まっていますが、式が合いません。どこかの数字を見直してみよう。");
    } else if (evaluation.wrongIds.length > 0) {
      setMessage(
        `${evaluation.wrongIds.length} 個のマスが式と合いません（赤いマス）。あと ${evaluation.totalCount - evaluation.filledCount} マス空いています。`,
      );
    } else {
      setMessage(`今のところ式に合っています。あと ${evaluation.totalCount - evaluation.filledCount} マス。`);
    }
  };

  const best = bests[level];
  const statusText =
    state.status === "solved"
      ? `クリア！ ${seconds} 秒でした。`
      : "隠れた数字を推理して、筆算を完成させよう。部分積と積がすべて合えば正解です（別の解でもOK）。";

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>虫食い算</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>虫食い算</h1>
        <p className="muted">マスを選んで数字を入れる、掛け算の筆算パズル。</p>
      </div>

      <div className="classic-controls" role="group" aria-label="レベル">
        {LEVELS.map((l) => (
          <button
            key={l.key}
            type="button"
            aria-pressed={level === l.key}
            className={level === l.key ? "classic-btn classic-btn-active" : "classic-btn"}
            onClick={() => restart(l.key)}
          >
            {l.label}
          </button>
        ))}
        <button type="button" className="classic-btn" onClick={() => restart(level)}>
          もう一度
        </button>
      </div>

      <p className="classic-status" role="status">
        {seconds} 秒{best !== undefined ? ` ・ ベスト ${best} 秒` : ""} ・ {statusText}
      </p>

      <div style={{ maxWidth: 360, margin: "0 auto" }} role="group" aria-label="筆算">
        {state.rowKinds.map((kind, row) => (
          <div
            key={row}
            style={{
              display: "flex",
              alignItems: "stretch",
              borderTop: kind === "partial" && row === 2 ? "3px solid #4b4237" : kind === "product" ? "3px solid #4b4237" : undefined,
              marginTop: kind === "partial" && row === 2 ? 6 : kind === "product" ? 6 : 2,
              paddingTop: kind === "partial" && row === 2 ? 6 : kind === "product" ? 6 : 0,
            }}
          >
            <span
              aria-hidden="true"
              style={{ width: 28, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22, fontWeight: 800 }}
            >
              {kind === "b" ? "×" : ""}
            </span>
            {Array.from({ length: state.width }, (_, col) => {
              const cell = state.cells.find((c) => c.row === row && c.col === col);
              if (!cell) return <span key={col} style={{ flex: 1 }} />;
              if (cell.given) {
                return (
                  <span
                    key={col}
                    style={{
                      flex: 1,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 26,
                      fontWeight: 700,
                      minHeight: 52,
                    }}
                  >
                    {cell.answer}
                  </span>
                );
              }
              const selected = selectedId === cell.id;
              const wrong = wrongIds.includes(cell.id);
              return (
                <button
                  key={col}
                  type="button"
                  aria-label={`${row + 1}行目 ${col + 1}列目のマス${cell.input !== null ? `（${cell.input}）` : "（空き）"}`}
                  aria-pressed={selected}
                  onClick={() => setSelectedId(cell.id)}
                  style={{
                    flex: 1,
                    minHeight: 52,
                    margin: 2,
                    borderRadius: 10,
                    border: `2px solid ${wrong ? "#dc2626" : selected ? "#4a6fa5" : "#d8c9a3"}`,
                    background: wrong ? "#fee2e2" : selected ? "#e0eaff" : "#fffdf6",
                    fontSize: 26,
                    fontWeight: 800,
                    color: wrong ? "#dc2626" : "inherit",
                    cursor: "pointer",
                    touchAction: "manipulation",
                  }}
                >
                  {cell.input !== null ? cell.input : ""}
                </button>
              );
            })}
          </div>
        ))}
      </div>

      <div
        style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 8, maxWidth: 360, margin: "16px auto 0" }}
        role="group"
        aria-label="数字パッド"
      >
        {[1, 2, 3, 4, 5, 6, 7, 8, 9, 0].map((d) => (
          <button
            key={d}
            type="button"
            className="classic-btn"
            disabled={selectedId === null || state.status !== "playing"}
            onClick={() => inputDigit(d)}
            style={{ minHeight: 48, fontSize: 20, fontWeight: 800 }}
          >
            {d}
          </button>
        ))}
      </div>
      <div style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 10, flexWrap: "wrap" }}>
        <button
          type="button"
          className="classic-btn"
          disabled={selectedId === null || state.status !== "playing"}
          onClick={() => inputDigit(null)}
        >
          消す
        </button>
        <button
          type="button"
          className="classic-btn classic-btn-active"
          disabled={state.status !== "playing"}
          onClick={onCheck}
          style={{ minWidth: 140 }}
        >
          チェック
        </button>
      </div>
      {message ? (
        <p className="classic-status" role="status" style={{ justifyContent: "center" }}>
          {message}
        </p>
      ) : null}
    </>
  );
}
