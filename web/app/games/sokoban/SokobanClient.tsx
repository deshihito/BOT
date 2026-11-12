"use client";
// 倉庫番。ロジックは lib/sokoban.ts。箱を全部ゴールの上に運ぶ定番パズル。
// 十字ボタンとキーボード（矢印/WASD）で操作。1手戻し・最初から直し対応。
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  SOKOBAN_LEVELS,
  createSokobanGame,
  deadlockedBoxes,
  moveSokoban,
  pushBoxByClick,
  undoSokoban,
  type SokobanDir,
  type SokobanState,
} from "@/lib/sokoban";
import { sfxPlace, sfxSlide, sfxTap, sfxWin, sfxWrong } from "@/lib/sfx";
import { EndScreen } from "../GameJuice";
import { useGamesNav } from "../GamesShell";

function bestKey(level: number): string {
  return `ago-sokoban-best-${level}`;
}

type SokobanBest = { moves: number | null; pushes: number | null };

/** ベスト記録は手数（Moves）と押し回数（Pushes）を分けて持つ。旧形式（手数の数値のみ）も読み取る。 */
function loadBest(level: number): SokobanBest {
  try {
    const raw = window.localStorage.getItem(bestKey(level));
    if (!raw) return { moves: null, pushes: null };
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "number") {
      return { moves: Number.isFinite(parsed) && parsed > 0 ? parsed : null, pushes: null };
    }
    if (parsed && typeof parsed === "object") {
      const rec = parsed as Record<string, unknown>;
      const moves = typeof rec.moves === "number" && rec.moves > 0 ? rec.moves : null;
      const pushes = typeof rec.pushes === "number" && rec.pushes > 0 ? rec.pushes : null;
      return { moves, pushes };
    }
  } catch {
    // 読めない場合は記録なしとして扱う。
  }
  return { moves: null, pushes: null };
}

export default function SokobanClient() {
  const { prefix } = useGamesNav();
  const [level, setLevel] = useState(0);
  const [state, setState] = useState<SokobanState>(() => createSokobanGame(0));
  const [best, setBest] = useState<SokobanBest>({ moves: null, pushes: null });

  useEffect(() => {
    setBest(loadBest(level));
  }, [level]);

  useEffect(() => {
    if (state.status !== "won") return;
    setBest((prev) => {
      const next: SokobanBest = {
        moves: prev.moves === null || state.moves < prev.moves ? state.moves : prev.moves,
        pushes: prev.pushes === null || state.pushes < prev.pushes ? state.pushes : prev.pushes,
      };
      if (next.moves === prev.moves && next.pushes === prev.pushes) return prev;
      try {
        window.localStorage.setItem(bestKey(level), JSON.stringify(next));
      } catch {
        // 保存失敗はプレイに影響しない。
      }
      return next;
    });
  }, [state.status, state.moves, state.pushes, level]);

  const deadlocked = useMemo(
    () => (state.status === "playing" ? new Set(deadlockedBoxes(state)) : new Set<number>()),
    [state],
  );

  const prevStatusRef = useRef(state.status);
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = state.status;
    if (prev !== state.status && state.status === "won") sfxWin();
  }, [state.status]);

  const startLevel = useCallback((idx: number) => {
    sfxTap();
    setLevel(idx);
    setState(createSokobanGame(idx));
  }, []);

  const move = useCallback(
    (dir: SokobanDir) => {
      const next = moveSokoban(state, dir);
      if (next === state) {
        // 壁や押せない箱で進めなかった場合だけ誤り音（クリア後は moveSokoban が同参照を返すが鳴らさない）。
        if (state.status === "playing") sfxWrong();
        return;
      }
      // クリア手は終局ジングルに任せ、二重に鳴らさない。
      if (next.status !== "won") {
        if (next.pushes > state.pushes) sfxPlace();
        else sfxSlide();
      }
      setState(next);
    },
    [state],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const map: Record<string, SokobanDir> = {
        ArrowUp: "up",
        ArrowDown: "down",
        ArrowLeft: "left",
        ArrowRight: "right",
        w: "up",
        s: "down",
        a: "left",
        d: "right",
      };
      const dir = map[e.key];
      if (dir) {
        e.preventDefault();
        move(dir);
      } else if (e.key === "z" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        setState((s) => {
          const next = undoSokoban(s);
          if (next !== s) sfxSlide();
          return next;
        });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [move]);

  const cellPx = Math.max(30, Math.min(52, Math.floor(340 / state.width) + 8));

  const onBoxClick = (i: number) => {
    const next = pushBoxByClick(state, i);
    if (next === state) {
      if (state.status === "playing") sfxWrong();
      return;
    }
    if (next.status !== "won") {
      if (next.pushes > state.pushes) sfxPlace();
      else sfxSlide();
    }
    setState(next);
  };

  const renderCell = (i: number) => {
    const wall = state.walls[i];
    const goal = state.goals[i];
    const box = state.boxes.includes(i);
    const player = state.player === i;
    const isDead = box && deadlocked.has(i);
    let bg = "#f3ead8";
    if (wall) bg = "#5b4a3a";
    else if (goal) bg = "#fde9c8";
    if (isDead) bg = "#f6c9c9";
    // 箱とプレイヤーは図形で描く（絵文字は使わない）。
    let content: ReactNode = "";
    if (box)
      content = (
        <span
          aria-hidden
          style={{
            width: "74%",
            height: "74%",
            boxSizing: "border-box",
            background: goal ? "#7cb342" : "#b07d3c",
            border: goal ? "2px solid #4e7a27" : "2px solid #7c4f1d",
            borderRadius: 3,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#ffffff",
            fontSize: cellPx * 0.38,
            lineHeight: 1,
          }}
        >
          {goal ? "✓" : ""}
        </span>
      );
    else if (player)
      content = (
        <span
          aria-hidden
          style={{
            width: "66%",
            height: "66%",
            boxSizing: "border-box",
            borderRadius: "50%",
            background: "#3f6fb5",
            border: "2px solid #274b7d",
          }}
        />
      );
    else if (goal) content = "◎";
    return (
      <div
        key={i}
        aria-hidden="true"
        onClick={box ? () => onBoxClick(i) : undefined}
        className={player ? "juice-pop" : box && goal ? "juice-pulse" : box ? "juice-pop" : undefined}
        style={{
          width: cellPx,
          height: cellPx,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: bg,
          border: wall ? "1px solid #4a3a2d" : isDead ? "2px solid #d33" : "1px solid #e0d3b8",
          borderRadius: wall ? 4 : 2,
          fontSize: cellPx * 0.52,
          lineHeight: 1,
          color: "#d97706",
          fontWeight: 800,
          cursor: box ? "pointer" : undefined,
        }}
      >
        {content}
      </div>
    );
  };

  const padButton = (dir: SokobanDir, label: string) => (
    <button
      type="button"
      aria-label={label}
      onClick={() => move(dir)}
      style={{
        width: 60,
        height: 52,
        borderRadius: 10,
        border: "1px solid #d8c9a3",
        background: "#fffdf6",
        fontSize: 20,
        cursor: "pointer",
        touchAction: "manipulation",
      }}
    >
      {label}
    </button>
  );

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>倉庫番</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>倉庫番</h1>
        <p className="muted">下の十字ボタンかキーボードで移動し、箱を押して運びます。</p>
      </div>

      <div className="classic-controls" role="group" aria-label="面の選択">
        {SOKOBAN_LEVELS.map((lv, i) => (
          <button
            key={lv.name}
            type="button"
            aria-pressed={level === i}
            className={level === i ? "classic-btn classic-btn-active" : "classic-btn"}
            onClick={() => startLevel(i)}
          >
            {lv.name}
          </button>
        ))}
        <button type="button" className="classic-btn" onClick={() => startLevel(level)}>
          もう一度
        </button>
        <button
          type="button"
          className="classic-btn"
          disabled={state.history.length === 0}
          onClick={() =>
            setState((s) => {
              const next = undoSokoban(s);
              if (next !== s) sfxSlide();
              return next;
            })
          }
        >
          ↩ 1手戻す
        </button>
      </div>

      <p className="classic-status" role="status">
        {SOKOBAN_LEVELS[level].name} ・ 手数 {state.moves}（箱押し {state.pushes} 回）
        {best.moves !== null ? ` ・ ベスト手数 ${best.moves}` : ""}
        {best.pushes !== null ? ` ・ ベスト押し ${best.pushes} 回` : ""} ・{" "}
        {state.status === "won"
          ? "クリア！全部の箱がゴールの上にあります。"
          : "ゴール ◎ の上に箱を全部のせればクリア。箱をクリックすると、行ける場合は歩いて行って押します。"}
      </p>
      {deadlocked.size > 0 && state.status === "playing" && (
        <p className="classic-status" role="alert" style={{ color: "#b91c1c" }}>
          ⚠ 赤い箱はこのままでは二度と動かせません（詰み）。「1手戻す」で立て直せます。
        </p>
      )}

      <div
        role="img"
        aria-label="倉庫番の盤面"
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${state.width}, ${cellPx}px)`,
          gap: 2,
          justifyContent: "center",
          margin: "10px auto",
          maxWidth: "100%",
          overflowX: "auto",
          padding: 4,
        }}
      >
        {Array.from({ length: state.width * state.height }, (_, i) => renderCell(i))}
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, 60px)",
          gridTemplateRows: "repeat(2, 52px)",
          gap: 6,
          justifyContent: "center",
          marginTop: 8,
        }}
        role="group"
        aria-label="移動ボタン"
      >
        <span />
        {padButton("up", "▲")}
        <span />
        {padButton("left", "◀")}
        {padButton("down", "▼")}
        {padButton("right", "▶")}
      </div>
      <p className="muted" style={{ textAlign: "center" }}>
        キーボードの矢印キー / WASD でも動けます（Ctrl+Z で1手戻し）。
      </p>

      {state.status === "won" && (
        <div style={{ marginTop: 14 }}>
          <EndScreen outcome="win" title="クリア！" score={state.moves} scoreLabel="手数" onRetry={() => startLevel(level)}>
            <p>
              {SOKOBAN_LEVELS[level].name} ・ 箱押し {state.pushes} 回
              {best.moves !== null ? ` ・ ベスト手数 ${best.moves}` : ""}
              {best.pushes !== null ? ` ・ ベスト押し ${best.pushes} 回` : ""}
            </p>
          </EndScreen>
        </div>
      )}

      {state.status === "won" && level + 1 < SOKOBAN_LEVELS.length ? (
        <p style={{ textAlign: "center" }}>
          <button type="button" className="classic-btn" onClick={() => startLevel(level + 1)}>
            次の面へ →
          </button>
        </p>
      ) : null}
    </>
  );
}
