"use client";
// 川渡りパズル。ロジックと最短手数は lib/river.ts（全状態 BFS で計算）。
// 荷物をタップでボートに乗せ、ボートを対岸へスワイプして渡る。端末内で完結し、
// 問題ごとの最少渡河回数は localStorage の ago-river-best-<problemId> に保存する。
import Link from "next/link";
import dynamic from "next/dynamic";
import { useEffect, useRef, useState, type CSSProperties } from "react";

// 3D シーンは three を含むため遅延読み込み（このページ専用チャンクに閉じる）。
const RiverScene3D = dynamic(() => import("./RiverScene3D"), { ssr: false });
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
import { sfxLose, sfxPlace, sfxSlide, sfxTap, sfxWin } from "@/lib/sfx";
import { tappableProps, useGesture } from "@/lib/gesture";
import { EndScreen } from "../GameJuice";
import { useGamesNav } from "../GamesShell";

const FARMER = { name: "農夫", kanji: "農", color: "#3c6e47" };

/** 荷物・農夫の漢字チップ（漢字1字＋色分けバッジ）。 */
function KanjiBadge({ kanji, color }: { kanji: string; color: string }) {
  return (
    <span
      aria-hidden="true"
      style={{
        display: "inline-grid",
        placeItems: "center",
        width: 30,
        height: 30,
        borderRadius: 9,
        background: color,
        color: "#fff",
        fontSize: 16,
        fontWeight: 800,
        lineHeight: 1,
        flex: "0 0 auto",
      }}
    >
      {kanji}
    </span>
  );
}

function bestKey(problemId: string): string {
  return `ago-river-best-${problemId}`;
}

export default function RiverClient() {
  const { prefix } = useGamesNav();
  const [webglFailed, setWebglFailed] = useState(false);
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

  const prevStatusRef = useRef(state.status);
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = state.status;
    if (prev === state.status || state.status === "playing") return;
    if (state.status === "won") sfxWin();
    else if (state.status === "failed") sfxLose();
  }, [state.status]);

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
    sfxTap();
    setState(createRiverGame(problemId));
  };

  const restart = () => setState(createRiverGame(state.problemId));

  // 3D シーンの荷物タップも、2D チップと同じ乗せ降ろし経路へ接続する。
  const handleItem = (id: string) => {
    const next = toggleRiverItem(state, id);
    if (next !== state) sfxPlace();
    setState(next);
  };

  const statusText =
    state.status === "won"
      ? state.crossings === minCrossings
        ? "全員渡れました！最短手数でクリアです。"
        : `全員渡れました！クリアです（最短は ${minCrossings} 回）。`
      : state.status === "failed"
        ? (state.failMessage ?? "失敗です。")
        : "荷物をタップしてボートに乗せ、ボートを対岸へスワイプして渡ろう。農夫のいない岸に危険なペアを残さないように。";

  const bankStyle: CSSProperties = {
    flex: "1 1 150px",
    minHeight: 170,
    borderRadius: 12,
    padding: 10,
    display: "flex",
    flexDirection: "column",
    gap: 8,
  };

  const chip = (
    id: string,
    name: string,
    kanji: string,
    color: string,
    clickable: boolean,
    onBoat: boolean,
  ) => {
    const interactive = clickable && state.status === "playing";
    return (
      <div
        key={id}
        {...(interactive
          ? tappableProps(() => {
              const next = toggleRiverItem(state, id);
              if (next !== state) sfxPlace();
              setState(next);
            })
          : {})}
        aria-disabled={!interactive}
        className={onBoat ? "juice-pop" : undefined}
        aria-label={name}
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
          cursor: interactive ? "pointer" : "default",
          opacity: clickable || onBoat ? 1 : 0.55,
          touchAction: "manipulation",
        }}
      >
        <KanjiBadge kanji={kanji} color={color} />
        {name}
      </div>
    );
  };

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
              <KanjiBadge kanji={FARMER.kanji} color={FARMER.color} />
              {FARMER.name}
            </span>
          )}
          {itemsHere.map((i) => chip(i.id, i.name, i.kanji, i.color, farmerHere, false))}
          {itemsHere.length === 0 && !farmerHere && <span className="muted">（だれもいません）</span>}
        </div>
      </div>
    );
  };

  const boatItems = problem.items.filter((i) => state.locations[i.id] === "boat");

  const cross = () => {
    const next = crossRiver(state);
    // 終局（won/failed）は終局ジングル側が担当する。
    if (next !== state && next.status === "playing") sfxSlide();
    setState(next);
  };

  // ボートの横スワイプ = 渡る（対岸の方向へ）。ボート内の荷物タップとは分離する:
  // タップ（24px未満）は荷物の乗せ降ろしだけで、スワイプだけが渡る。
  // スワイプ直後の click は useGesture の suppressClickAfterSwipe が抑止し、
  // 荷物の誤切替を防ぐ（solitaire / tsume / sudoku / battleship と同じ）。
  const boatGesture = useGesture({
    onSwipe: (dir) => {
      if (state.farmerSide === "left" && dir === "right") cross();
      else if (state.farmerSide === "right" && dir === "left") cross();
    },
  });

  // 2D 表示（WebGL が使えない場合のフォールバックとしてそのまま使う）。
  const board2d = (
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
        {...boatGesture}
        key={state.farmerSide}
        role="button"
        tabIndex={0}
        aria-label={`ボート（${state.farmerSide === "left" ? "左岸" : "右岸"}、対岸へスワイプで渡る）`}
        onKeyDown={(e) => {
          // ボートそのものにフォーカスがあるときだけ Enter で渡る。
          // ガードがないと荷物チップにフォーカスして Enter を押したときに
          // 乗せ降ろしと渡河が両方走る（anagram / mastermind と同じ構図）。
          if (e.target !== e.currentTarget) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            cross();
          }
        }}
        className="juice-slide"
        style={{
          border: "2px dashed rgba(0,0,0,0.35)",
          borderRadius: 10,
          padding: 8,
          minWidth: 130,
          background: "rgba(255,255,255,0.65)",
          touchAction: "none",
        }}
      >
        <p style={{ margin: "0 0 6px", fontWeight: 700, fontSize: 14 }}>
          ボート（{boatItems.length} / {problem.capacity}）
        </p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {boatItems.length === 0 && <span className="muted">（空っぽ）</span>}
          {boatItems.map((i) => chip(i.id, i.name, i.kanji, i.color, true, true))}
        </div>
      </div>
      <p className="muted" style={{ margin: "6px 0 0", fontSize: 13 }}>
        ボートを{state.farmerSide === "left" ? "右" : "左"}へスワイプ（またはボートにフォーカスして Enter）で渡ります。
      </p>
    </div>
    {bank("right", "右岸（ゴール）", "var(--soft)")}
  </div>
  );

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
          <div
            key={p.id}
            {...tappableProps(() => selectProblem(p.id))}
            aria-pressed={state.problemId === p.id}
            className={state.problemId === p.id ? "classic-btn classic-btn-active" : "classic-btn"}
          >
            {p.title}
          </div>
        ))}
        <button type="button" className="classic-btn" onClick={restart}>
          もう一度
        </button>
      </div>

      <p className={`classic-status${state.status === "failed" ? " juice-shake" : ""}`} role="status">
        渡った回数 {state.crossings} 回 ・ 最短 {minCrossings} 回
        {best !== null ? ` ・ あなたの最少 ${best} 回` : ""} ・ {statusText}
      </p>

      {webglFailed ? board2d : (
        <div style={{ width: "100%", maxWidth: 780, margin: "10px auto 0" }}>
          <RiverScene3D
            items={problem.items}
            locations={state.locations}
            farmerSide={state.farmerSide}
            status={state.status}
            onItem={handleItem}
            onCross={cross}
            onFail={() => setWebglFailed(true)}
            fallback={board2d}
          />
        </div>
      )}

      {state.status !== "playing" && (
        <EndScreen
          outcome={state.status === "won" ? "win" : "lose"}
          title={state.status === "won" ? "全員渡れました！" : "失敗です"}
          score={state.status === "won" ? state.crossings : undefined}
          scoreLabel="渡った回数"
          onRetry={restart}
        >
          <p className="muted" style={{ margin: 0 }}>
            {problem.title} ・ 最短 {minCrossings} 回
            {best !== null ? ` ・ あなたの最少 ${best} 回` : ""}
            {state.status === "failed" && state.failMessage ? ` ・ ${state.failMessage}` : ""}
          </p>
        </EndScreen>
      )}
    </>
  );
}
