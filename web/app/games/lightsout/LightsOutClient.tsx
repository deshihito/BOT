"use client";
// ライツアウト。ロジックは lib/lightsout.ts（解ける盤を逆再生で生成）。
// 押したマスと上下左右が反転する。全消灯でクリア。端末内で完結。
import Link from "next/link";
import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";

// 3D シーンは three を含むため遅延読み込み（このページ専用チャンクに閉じる）。
const LightsOutScene3D = dynamic(() => import("./LightsOutScene3D"), { ssr: false });
import {
  createLightsOutGame,
  litCount,
  pressCell,
  remainingPresses,
  type LightsOutDifficulty,
  type LightsOutSize,
  type LightsOutState,
} from "@/lib/lightsout";
import { sfxFlip, sfxTap, sfxWin } from "@/lib/sfx";
import { tappableProps } from "@/lib/gesture";
import { EndScreen } from "../GameJuice";
import { useGamesNav } from "../GamesShell";

const SIZES: { key: LightsOutSize; label: string }[] = [
  { key: 3, label: "3×3" },
  { key: 4, label: "4×4" },
  { key: 5, label: "5×5" },
];

const DIFFS: { key: LightsOutDifficulty; label: string }[] = [
  { key: "easy", label: "かんたん" },
  { key: "normal", label: "ふつう" },
  { key: "hard", label: "むずかしい" },
];

function newGame(size: LightsOutSize, diff: LightsOutDifficulty): LightsOutState {
  return createLightsOutGame(size, Date.now() % 2147483647, diff);
}

/** 1ゲームで使えるヒントの回数（数独の「ヒント残り」と同じ作法）。 */
const HINT_LIMIT = 3;

function formatTime(total: number): string {
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export default function LightsOutClient() {
  const { prefix } = useGamesNav();
  const [webglFailed, setWebglFailed] = useState(false);
  const [size, setSize] = useState<LightsOutSize>(5);
  const [difficulty, setDifficulty] = useState<LightsOutDifficulty>("normal");
  const [state, setState] = useState<LightsOutState>(() => newGame(5, "normal"));
  const [seconds, setSeconds] = useState(0);
  const [hintsUsed, setHintsUsed] = useState(0);
  const [hintIndex, setHintIndex] = useState<number | null>(null);
  // プレイヤーが押したマスの偶奇（ヒントの残り解計算用。押下は可換・自己逆操作）。
  const pressedParityRef = useRef<Set<number>>(new Set());
  const prevStatusRef = useRef(state.status);

  // 終局遷移の瞬間だけジングルを鳴らす。
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = state.status;
    if (prev !== state.status && state.status === "won") sfxWin();
  }, [state.status]);

  useEffect(() => {
    if (state.status === "won") return;
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);
  return () => clearInterval(id);
  }, [state.status]);

  const handlePress = (i: number) => {
    const next = pressCell(state, i);
    if (next !== state) {
      const parity = pressedParityRef.current;
      if (parity.has(i)) parity.delete(i);
      else parity.add(i);
      setHintIndex(null);
      if (next.status !== "won") sfxFlip();
    }
    setState(next);
  };

  const restart = (nextSize: LightsOutSize, nextDiff: LightsOutDifficulty) => {
    setSize(nextSize);
    setDifficulty(nextDiff);
    setState(newGame(nextSize, nextDiff));
    setSeconds(0);
    setHintsUsed(0);
    setHintIndex(null);
    pressedParityRef.current = new Set();
  };

  // 詰み救済のヒント: 解のうち「あと押すべきマス」を1つだけ位置で示す（自動では押さない）。
  const onHint = () => {
    if (state.status === "won" || hintsUsed >= HINT_LIMIT) return;
    const rest = remainingPresses(state, pressedParityRef.current);
    if (rest.length === 0) return;
    sfxTap();
    setHintIndex(rest[0]);
    setHintsUsed((n) => n + 1);
  };

  const lit = litCount(state.cells);

  // 2D 盤（WebGL が使えない場合のフォールバックとしてそのまま使う）。
  const board2d = (
    <div
      role="grid"
      aria-label="ライツアウトの盤"
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${size}, minmax(0, 1fr))`,
        gap: 6,
        maxWidth: 400,
        width: "100%",
      }}
    >
      {state.cells.map((on, i) => (
        <div
          key={i}
          role="gridcell"
          tabIndex={state.status === "won" ? -1 : 0}
          aria-label={on ? "点灯" : "消灯"}
          aria-pressed={on}
          aria-disabled={state.status === "won"}
          className={on ? "juice-flip" : undefined}
          onClick={() => handlePress(i)}
          onKeyDown={(e) => {
            if (e.key !== "Enter" && e.key !== " ") return;
            e.preventDefault();
            handlePress(i);
          }}
          style={{
            aspectRatio: "1",
            minHeight: 52,
            borderRadius: 10,
            border: i === hintIndex ? "2px solid #38bdf8" : on ? "1px solid #d97706" : "1px solid #334155",
            background: on ? "#fbbf24" : "#1e293b",
            color: on ? "#92400e" : "#64748b",
            fontSize: "clamp(18px, 6vw, 26px)",
            cursor: state.status === "won" ? "default" : "pointer",
            boxShadow:
              i === hintIndex
                ? "0 0 0 3px #38bdf8, 0 0 14px rgba(56,189,248,0.7)"
                : on
                  ? "0 0 12px rgba(251,191,36,0.55)"
                  : "inset 0 1px 3px rgba(0,0,0,0.5)",
          }}
        >
          {on ? "●" : "·"}
        </div>
      ))}
    </div>
  );


  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>ライツアウト</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>ライツアウト</h1>
        <p className="muted">マスを押すとそのマスと上下左右が反転します。全部消灯できればクリアです。</p>
      </div>

      <div className="classic-controls" role="group" aria-label="盤のサイズ">
        {SIZES.map((s) => (
          <div
            key={s.key}
            {...tappableProps(() => restart(s.key, difficulty))}
            aria-pressed={size === s.key}
            className={size === s.key ? "classic-btn classic-btn-active" : "classic-btn"}
          >
            {s.label}
          </div>
        ))}
      </div>
      <div className="classic-controls" role="group" aria-label="難易度">
        {DIFFS.map((d) => (
          <div
            key={d.key}
            {...tappableProps(() => restart(size, d.key))}
            aria-pressed={difficulty === d.key}
            className={difficulty === d.key ? "classic-btn classic-btn-active" : "classic-btn"}
          >
            {d.label}
          </div>
        ))}
        <button type="button" className="classic-btn" onClick={() => restart(size, difficulty)}>
          もう一度
        </button>
        <div
          {...tappableProps(onHint)}
          aria-disabled={state.status === "won" || hintsUsed >= HINT_LIMIT}
          className="classic-btn"
          style={state.status === "won" || hintsUsed >= HINT_LIMIT ? { opacity: 0.5 } : undefined}
        >
          ヒント（残り {HINT_LIMIT - hintsUsed}）
        </div>
      </div>

      <p className="classic-status" role="status">
        点灯 {lit} / {state.cells.length} ・ {state.moves} 手 ・ 時間 {formatTime(seconds)}
        {state.status === "won" ? ` ・ 全消灯！ ${state.moves} 手でクリアです。` : ""}
        {hintIndex !== null && state.status !== "won"
          ? ` ・ ヒント: 上から ${Math.floor(hintIndex / size) + 1} 行目・左から ${(hintIndex % size) + 1} 列目のマスを押してみてください。`
          : ""}
      </p>

      {webglFailed ? board2d : (
        <div style={{ width: "100%", maxWidth: 400 }}>
          <LightsOutScene3D
            cells={state.cells}
            size={size}
            won={state.status === "won"}
            onPress={handlePress}
            onFail={() => setWebglFailed(true)}
            fallback={board2d}
          />
        </div>
      )}

      <p className="muted" style={{ fontSize: 13, marginTop: 10 }}>
        端から攻めると解きやすいです。どの盤も必ず解けるように作られています。
      </p>

      {state.status === "won" && (
        <div style={{ marginTop: 16 }}>
          <EndScreen outcome="win" title="全消灯！" score={state.moves} scoreLabel="手数" onRetry={() => restart(size, difficulty)}>
            <p className="muted">
              {size}×{size}（{DIFFS.find((d) => d.key === difficulty)?.label}）を {formatTime(seconds)} で消し切りました。
            </p>
          </EndScreen>
        </div>
      )}
    </>
  );
}
