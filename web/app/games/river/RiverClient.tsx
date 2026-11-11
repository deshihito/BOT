"use client";
// 川渡りパズル。ロジックと最短手数は lib/river.ts（全状態 BFS で計算）。
// 荷物をタップでボートに乗せ、「わたる」で川を渡る。端末内で完結し、
// 問題ごとの最少渡河回数は localStorage の ago-river-best-<problemId> に保存する。
import Link from "next/link";
import { useEffect, useState, type CSSProperties } from "react";
import {
  createRiverGame,
  crossRiver,
  getRiverProblem,
  riverMinCrossings,
  toggleRiverItem,
  RIVER_PROBLEMS,
  type RiverSide,
  type RiverState,
} from "@/lib/river";
import { useGamesNav } from "../GamesShell";

const FARMER = { name: "農夫", emoji: "🧑‍🌾" };

function bestKey(problemId: string): string {
  return `ago-river-best-${problemId}`;
}

export default function RiverClient() {
  const { prefix } = useGamesNav();
  const [state, setState] = useState<RiverState>(() => createRiverGame(RIVER_PROBLEMS[0].id));
  const [best, setBest] = useState<number | null>(null);
  const problem = getRiverProblem(state.problemId);
  const minCrossings = riverMinCrossings(problem);

  useEffect(() => {
    try {
      const saved = Number(window.localStorage.getItem(bestKey(state.problemId)));
      setBest(Number.isFinite(saved) && saved > 0 ? saved : null);
    } catch {
      setBest(null);
    }
  }, [state.problemId]);

  useEffect(() => {
    if (state.status !== "won") return;
    if (best !== null && state.crossings >= best) return;
    setBest(state.crossings);
    try {
      window.localStorage.setItem(bestKey(state.problemId), String(state.crossings));
    } catch {
      // 保存失敗はプレイに影響しない。
    }
  }, [state.status, state.crossings, best, state.problemId]);

  const selectProblem = (problemId: string) => {
    setState(createRiverGame(problemId));
  };

  const restart = () => setState(createRiverGame(state.problemId));

  const statusText =
    state.status === "won"
      ? state.crossings === minCrossings
        ? "全員渡れました！最短手数でクリアです。"
        : `全員渡れました！クリアです（最短は ${minCrossings} 回）。`
      : state.status === "failed"
        ? (state.failMessage ?? "失敗です。")
        : "荷物をタップしてボートに乗せ、「わたる」で川を渡ろう。農夫のいない岸に危険なペアを残さないように。";

  const bankStyle: CSSProperties = {
    flex: "1 1 150px",
    minHeight: 170,
    borderRadius: 12,
    padding: 10,
    display: "flex",
    flexDirection: "column",
    gap: 8,
  };

  const chip = (id: string, name: string, emoji: string, clickable: boolean, onBoat: boolean) => (
    <button
      key={id}
      type="button"
      disabled={!clickable || state.status !== "playing"}
      aria-label={name}
      onClick={() => setState((s) => toggleRiverItem(s, id))}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "8px 10px",
        borderRadius: 999,
        border: onBoat ? "2px solid var(--accent)" : "1px solid var(--line)",
        background: onBoat ? "var(--accent-soft)" : "var(--bg, #fff)",
        fontSize: 15,
        fontWeight: 700,
        minHeight: 44,
        cursor: clickable && state.status === "playing" ? "pointer" : "default",
        opacity: clickable || onBoat ? 1 : 0.55,
        touchAction: "manipulation",
      }}
    >
      <span style={{ fontSize: 22 }}>{emoji}</span>
      {name}
    </button>
  );

  const bank = (side: RiverSide, label: string, color: string) => {
    const itemsHere = problem.items.filter((i) => state.locations[i.id] === side);
    const farmerHere = state.farmerSide === side;
    return (
      <div style={{ ...bankStyle, background: color }} role="group" aria-label={label}>
        <p style={{ margin: 0, fontWeight: 800 }}>{label}</p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {farmerHere && (
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "8px 10px",
                fontSize: 15,
                fontWeight: 700,
                minHeight: 44,
              }}
            >
              <span style={{ fontSize: 22 }}>{FARMER.emoji}</span>
              {FARMER.name}
            </span>
          )}
          {itemsHere.map((i) => chip(i.id, i.name, i.emoji, farmerHere, false))}
          {itemsHere.length === 0 && !farmerHere && <span className="muted">（だれもいません）</span>}
        </div>
      </div>
    );
  };

  const boatItems = problem.items.filter((i) => state.locations[i.id] === "boat");

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>川渡り</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>川渡り</h1>
        <p className="muted">{problem.description}</p>
      </div>

      <div className="classic-controls" role="group" aria-label="問題">
        {RIVER_PROBLEMS.map((p) => (
          <button
            key={p.id}
            type="button"
            aria-pressed={state.problemId === p.id}
            className={state.problemId === p.id ? "classic-btn classic-btn-active" : "classic-btn"}
            onClick={() => selectProblem(p.id)}
          >
            {p.title}
          </button>
        ))}
        <button type="button" className="classic-btn" onClick={restart}>
          もう一度
        </button>
      </div>

      <p className="classic-status" role="status">
        渡った回数 {state.crossings} 回 ・ 最短 {minCrossings} 回
        {best !== null ? ` ・ あなたの最少 ${best} 回` : ""} ・ {statusText}
      </p>

      <div
        style={{
          display: "flex",
          gap: 10,
          alignItems: "stretch",
          flexWrap: "wrap",
          marginTop: 10,
        }}
      >
        {bank("left", "左岸（出発）", "var(--soft)")}
        <div
          style={{
            flex: "1 1 170px",
            minHeight: 170,
            borderRadius: 12,
            padding: 10,
            background: "#bfe3f2",
            display: "flex",
            flexDirection: "column",
            gap: 8,
            alignItems: state.farmerSide === "left" ? "flex-start" : "flex-end",
          }}
          role="group"
          aria-label="川とボート"
        >
          <p style={{ margin: 0, fontWeight: 800 }}>川（ボートは{state.farmerSide === "left" ? "左岸" : "右岸"}）</p>
          <div
            style={{
              border: "2px dashed rgba(0,0,0,0.35)",
              borderRadius: 10,
              padding: 8,
              minWidth: 130,
              background: "rgba(255,255,255,0.65)",
            }}
          >
            <p style={{ margin: "0 0 6px", fontWeight: 700, fontSize: 14 }}>
              🚣 ボート（{boatItems.length} / {problem.capacity}）
            </p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {boatItems.length === 0 && <span className="muted">（空っぽ）</span>}
              {boatItems.map((i) => chip(i.id, i.name, i.emoji, true, true))}
            </div>
          </div>
        </div>
        {bank("right", "右岸（ゴール）", "var(--soft)")}
      </div>

      <div className="classic-controls" style={{ justifyContent: "center", marginTop: 12 }}>
        <button
          type="button"
          className="classic-btn classic-btn-active"
          disabled={state.status !== "playing"}
          onClick={() => setState((s) => crossRiver(s))}
          style={{ minHeight: 52, fontSize: 17, fontWeight: 800, padding: "0 28px" }}
        >
          {state.farmerSide === "left" ? "わたる →" : "← もどる"}
        </button>
      </div>
      {state.status !== "playing" && (
        <div className="classic-controls" style={{ justifyContent: "center" }}>
          <button type="button" className="classic-btn" onClick={restart}>
            もう一度
          </button>
        </div>
      )}
    </>
  );
}
