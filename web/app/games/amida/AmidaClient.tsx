"use client";
// あみだくじ。ロジックは lib/amida.ts（横線生成・到達先計算・経路トレース）。
// 参加者名と景品ラベルはその場で編集でき、経路はアニメーションでたどる。
// 端末内で完結し、サーバーへ送信しない。
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AMIDA_MAX_PLAYERS,
  AMIDA_MIN_PLAYERS,
  computeResults,
  createAmida,
  tracePath,
  type AmidaState,
} from "@/lib/amida";
import { useGamesNav } from "../GamesShell";

const X_STEP = 72;
const X0 = 46;
const Y0 = 44;
const Y_STEP = 34;
const DEFAULT_PRIZES = ["🏆 大当たり", "🍰 ケーキ", "🍬 あめ", "🎁 プレゼント", "⭐ ラッキー", "🍀 クローバー", "🎈 風船", "📦 はこ"];
const DEFAULT_NAMES = ["A", "B", "C", "D", "E", "F", "G", "H"];

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
const inputStyle: React.CSSProperties = {
  width: "100%",
  minHeight: 40,
  padding: "6px 8px",
  borderRadius: 8,
  border: "1px solid #b9bdc9",
  fontSize: 14,
  boxSizing: "border-box",
};

export default function AmidaClient() {
  const { prefix } = useGamesNav();
  const [count, setCount] = useState(4);
  const [names, setNames] = useState<string[]>(DEFAULT_NAMES.slice(0, 4));
  const [prizes, setPrizes] = useState<string[]>(DEFAULT_PRIZES.slice(0, 4));
  const [amida, setAmida] = useState<AmidaState>(() => createAmida(4, Date.now() % 2147483647));
  const [selected, setSelected] = useState<number | null>(null);
  const [step, setStep] = useState(0); // 経路の描画済みステップ数（0 = 未開始）
  const [showResults, setShowResults] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const results = useMemo(() => computeResults(amida), [amida]);
  const trace = useMemo(
    () => (selected !== null ? tracePath(amida, selected) : null),
    [amida, selected],
  );

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  const regenerate = (n: number) => {
    setAmida(createAmida(n, Date.now() % 2147483647));
    setSelected(null);
    setStep(0);
    setShowResults(false);
  };

  const changeCount = (n: number) => {
    const next = Math.min(AMIDA_MAX_PLAYERS, Math.max(AMIDA_MIN_PLAYERS, n));
    setCount(next);
    setNames((prev) =>
      Array.from({ length: next }, (_, i) => prev[i] ?? DEFAULT_NAMES[i] ?? `${i + 1}`),
    );
    setPrizes((prev) =>
      Array.from({ length: next }, (_, i) => prev[i] ?? DEFAULT_PRIZES[i] ?? `景品 ${i + 1}`),
    );
    regenerate(next);
  };

  const startTrace = (i: number) => {
    if (timerRef.current) clearInterval(timerRef.current);
    setSelected(i);
    setStep(0);
    const t = tracePath(amida, i);
    let s = 0;
    timerRef.current = setInterval(() => {
      s += 1;
      setStep(s);
      if (s >= t.path.length) {
        if (timerRef.current) clearInterval(timerRef.current);
        timerRef.current = null;
      }
    }, 260);
  };

  const width = X0 * 2 + X_STEP * (amida.count - 1);
  const height = Y0 * 2 + Y_STEP * amida.levels + 8;
  const px = (x: number) => X0 + x * X_STEP;
  const py = (level: number) => Y0 + level * Y_STEP;

  // 経路の描画点: 各段では中ほど（横線の高さ）で横へ移る形に展開する。
  const tracedPoints = (() => {
    if (!trace || step <= 0) return "";
    const pts: string[] = [`${px(trace.path[0])},${py(0)}`];
    const shownLevels = Math.min(step - 1, amida.levels);
    for (let level = 0; level < shownLevels; level++) {
      const before = trace.path[level];
      const after = trace.path[level + 1];
      if (after !== before) {
        pts.push(`${px(before)},${py(level) + Y_STEP / 2}`);
        pts.push(`${px(after)},${py(level) + Y_STEP / 2}`);
      }
      pts.push(`${px(after)},${py(level + 1)}`);
    }
    return pts.join(" ");
  })();

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>あみだくじ</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>あみだくじ</h1>
        <p className="muted">参加者と景品を決めてくじを作る、定番の決めごとツール。</p>
      </div>

      <div className="classic-controls" style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 14 }}>
          人数
          <select
            value={count}
            onChange={(e) => changeCount(Number(e.target.value))}
            style={{ minHeight: 40, borderRadius: 8, fontSize: 15, padding: "4px 8px" }}
            aria-label="参加者数"
          >
            {Array.from({ length: AMIDA_MAX_PLAYERS - AMIDA_MIN_PLAYERS + 1 }, (_, k) => AMIDA_MIN_PLAYERS + k).map(
              (n) => (
                <option key={n} value={n}>
                  {n}人
                </option>
              ),
            )}
          </select>
        </label>
        <button type="button" style={btnStyle} onClick={() => regenerate(count)}>
          くじを作り直す
        </button>
        <button type="button" style={btnStyle} onClick={() => setShowResults((v) => !v)} aria-pressed={showResults}>
          {showResults ? "結果を隠す" : "全員の結果を見る"}
        </button>
      </div>

      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 12 }}>
        <section aria-label="参加者名" style={{ flex: "1 1 240px", maxWidth: 340 }}>
          <h2 style={{ fontSize: 15, margin: "0 0 6px" }}>参加者（{count}人）</h2>
          <div style={{ display: "grid", gap: 6 }}>
            {names.map((name, i) => (
              <input
                key={i}
                style={inputStyle}
                value={name}
                maxLength={10}
                aria-label={`参加者 ${i + 1} の名前`}
                onChange={(e) =>
                  setNames((prev) => prev.map((v, k) => (k === i ? e.target.value : v)))
                }
              />
            ))}
          </div>
        </section>
        <section aria-label="景品ラベル" style={{ flex: "1 1 240px", maxWidth: 340 }}>
          <h2 style={{ fontSize: 15, margin: "0 0 6px" }}>景品（下の位置の順）</h2>
          <div style={{ display: "grid", gap: 6 }}>
            {prizes.map((prize, i) => (
              <input
                key={i}
                style={inputStyle}
                value={prize}
                maxLength={14}
                aria-label={`景品 ${i + 1}`}
                onChange={(e) =>
                  setPrizes((prev) => prev.map((v, k) => (k === i ? e.target.value : v)))
                }
              />
            ))}
          </div>
        </section>
      </div>

      <div style={{ overflowX: "auto", maxWidth: "100%" }}>
        <svg
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label="あみだくじの図"
          style={{ background: "#fbfcfe", border: "1px solid #d5d8e0", borderRadius: 12, maxWidth: "none" }}
        >
          {Array.from({ length: amida.count }, (_, x) => (
            <line key={`v${x}`} x1={px(x)} y1={py(0)} x2={px(x)} y2={py(amida.levels)} stroke="#8a90a3" strokeWidth={2} />
          ))}
          {amida.bars.map((row, level) =>
            row.map((bar, i) =>
              bar ? (
                <line
                  key={`h${level}-${i}`}
                  x1={px(i)}
                  y1={py(level) + Y_STEP / 2}
                  x2={px(i + 1)}
                  y2={py(level) + Y_STEP / 2}
                  stroke="#8a90a3"
                  strokeWidth={2}
                />
              ) : null,
            ),
          )}
          {Array.from({ length: amida.count }, (_, x) => (
            <text key={`n${x}`} x={px(x)} y={py(0) - 24} textAnchor="middle" fontSize={13} fontWeight={700} fill="#1c2333">
              {names[x] || `${x + 1}`}
            </text>
          ))}
          {Array.from({ length: amida.count }, (_, x) => (
            <text key={`p${x}`} x={px(x)} y={py(amida.levels) + 26} textAnchor="middle" fontSize={12} fill="#1c2333">
              {prizes[x] || `景品 ${x + 1}`}
            </text>
          ))}
          {tracedPoints && (
            <polyline points={tracedPoints} fill="none" stroke="#d8542e" strokeWidth={4} strokeLinejoin="round" strokeLinecap="round" />
          )}
          {trace && step >= trace.path.length && (
            <circle cx={px(trace.end)} cy={py(amida.levels)} r={7} fill="#d8542e" />
          )}
        </svg>
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "10px 0" }} role="group" aria-label="経路をたどる参加者">
        {names.map((name, i) => (
          <button
            key={i}
            type="button"
            onClick={() => startTrace(i)}
            aria-pressed={selected === i}
            style={{
              minHeight: 44,
              padding: "8px 14px",
              borderRadius: 999,
              border: selected === i ? "2px solid #d8542e" : "1px solid #8a90a3",
              background: selected === i ? "#fdeee7" : "#ffffff",
              fontSize: 14,
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            {name || `参加者 ${i + 1}`} の経路
          </button>
        ))}
      </div>

      <p className="classic-status" role="status">
        {trace && step >= trace.path.length
          ? `${names[trace.path[0]] || "参加者"} は 「${prizes[trace.end] || `景品 ${trace.end + 1}`}」 に到達しました。`
          : selected !== null
            ? "経路をたどっています…"
            : "参加者のボタンを押すと経路をたどります。"}
      </p>

      {showResults && (
        <section aria-label="全員の結果">
          <h2 style={{ fontSize: 16, margin: "12px 0 8px" }}>全員の結果</h2>
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6, maxWidth: 420 }}>
            {results.map((end, i) => (
              <li
                key={i}
                style={{ display: "flex", justifyContent: "space-between", border: "1px solid #d5d8e0", borderRadius: 10, padding: "8px 12px", fontSize: 15 }}
              >
                <span style={{ fontWeight: 700 }}>{names[i] || `参加者 ${i + 1}`}</span>
                <span>→ {prizes[end] || `景品 ${end + 1}`}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
