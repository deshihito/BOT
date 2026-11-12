"use client";
// バランスタワー。提示されたブロックを左右位置を選んで積み、重心が支持範囲を外れると崩れる。
// 安定判定は lib/balancestack.ts の決定的モデル（各段の重心と接触区間の検証）。
// 端末内で完結し、サーバーへ送信しない。
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  BALANCE_BASE,
  BALANCE_FIELD_WIDTH,
  clampCenter,
  createBalanceGame,
  overallCenterOfMass,
  placeBlock,
  previewStability,
  type BalanceState,
} from "@/lib/balancestack";
import { sfxLose, sfxPlace, sfxTap } from "@/lib/sfx";
import { EndScreen, ScorePop } from "../GameJuice";
import { useGamesNav } from "../GamesShell";

const BEST_KEY = "ago-balancestack-best";
const FIELD_HEIGHT = 460;
const BLOCK_COLORS = ["#e8a13a", "#5b8dd9", "#7bc47f", "#d975a8", "#9a7fd0", "#d96a5b"];
const WEIGHT_LABEL = ["", "軽い", "ふつう", "重い"];

function newGame(): BalanceState {
  return createBalanceGame(Date.now() % 2147483647);
}

export default function BalanceStackClient() {
  const { prefix } = useGamesNav();
  const [state, setState] = useState<BalanceState>(() => newGame());
  const [center, setCenter] = useState(50);
  const [best, setBest] = useState<number | null>(null);
  const fieldRef = useRef<HTMLDivElement | null>(null);
  const savedRef = useRef<string | null>(null);
  const gameBestRef = useRef<number | null>(null);

  useEffect(() => {
    try {
      const saved = Number(window.localStorage.getItem(BEST_KEY));
      const loaded = Number.isFinite(saved) && saved > 0 ? saved : null;
      setBest(loaded);
      gameBestRef.current = loaded;
    } catch {
      setBest(null);
    }
  }, []);

  useEffect(() => {
    if (state.score <= 0) return;
    if (savedRef.current === `${state.seed}:${state.score}`) return;
    if (best !== null && state.score <= best) return;
    savedRef.current = `${state.seed}:${state.score}`;
    setBest(state.score);
    try {
      window.localStorage.setItem(BEST_KEY, String(state.score));
    } catch {
      // 保存失敗はプレイに影響しない。
    }
  }, [state.score, state.seed, best]);

  const preview = state.status === "playing" ? previewStability(state, center) : null;
  const previewCenter = clampCenter(center, state.current.width);
  const previewBlocks =
    state.status === "playing"
      ? [...state.blocks, { ...state.current, center: previewCenter }]
      : state.blocks;
  const comX = overallCenterOfMass(previewBlocks);
  const marginRatio = preview ? Math.max(0, Math.min(1, preview.minMargin / 12)) : 0;

  const blockHeight = Math.max(
    12,
    Math.min(26, Math.floor((FIELD_HEIGHT - 70) / Math.max(8, state.blocks.length + 3))),
  );
  const towerHeight = (state.blocks.length + 1) * blockHeight;

  const onFieldTap = (e: React.PointerEvent<HTMLDivElement>) => {
    if (state.status !== "playing" || !fieldRef.current) return;
    sfxTap();
    const rect = fieldRef.current.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    setCenter(Math.round(ratio * BALANCE_FIELD_WIDTH * 2) / 2);
  };

  const restart = () => {
    sfxTap();
    gameBestRef.current = best;
    setState(newGame());
    setCenter(50);
  };

  const place = () => {
    if (state.status !== "playing") return;
    const next = placeBlock(state, center);
    if (next.status === "collapsed") sfxLose();
    else sfxPlace();
    setState(next);
  };

  const renderBlock = (
    block: { center: number; width: number; weight: number },
    level: number,
    opts: { ghost?: boolean; collapsed?: boolean; juiceClass?: string },
  ) => {
    const leftPct = ((block.center - block.width / 2) / BALANCE_FIELD_WIDTH) * 100;
    const widthPct = (block.width / BALANCE_FIELD_WIDTH) * 100;
    return (
      <div
        key={level}
        className={opts.juiceClass}
        aria-hidden
        style={{
          position: "absolute",
          left: `${leftPct}%`,
          width: `${widthPct}%`,
          bottom: 28 + level * blockHeight,
          height: blockHeight - 2,
          borderRadius: 4,
          background: opts.ghost
            ? preview?.stable
              ? "rgba(91,141,217,0.45)"
              : "rgba(217,60,60,0.45)"
            : BLOCK_COLORS[level % BLOCK_COLORS.length],
          border: opts.ghost
            ? "2px dashed #333"
            : opts.collapsed
              ? "2px solid #c0392b"
              : "1px solid rgba(0,0,0,0.35)",
          transform: opts.collapsed ? `rotate(${level % 2 === 0 ? 2.5 : -2.5}deg)` : undefined,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 11,
          color: "#fff",
          textShadow: "0 0 3px rgba(0,0,0,0.6)",
          transition: "left 0.08s linear",
        }}
      >
        {block.weight}
      </div>
    );
  };

  return (
    <div style={{ maxWidth: 560, margin: "0 auto", padding: 16 }}>
      <p style={{ fontSize: 13, margin: "0 0 8px" }}>
        <Link href={`${prefix}/games`}>ゲーム</Link> / バランスタワー
      </p>
      <h1 style={{ fontSize: 22, margin: "0 0 4px" }}>バランスタワー</h1>
      <p style={{ fontSize: 13, color: "#666", margin: "0 0 12px" }}>
        下のスライダーで置く位置を決め、「置く」ボタンで積みます。ブロックの数字は重さです。
      </p>

      <p role="status" style={{ fontSize: 14, margin: "0 0 8px", minHeight: 20 }}>
        {state.status === "collapsed"
          ? `${state.collapsedLevel !== null ? state.collapsedLevel + 1 : "?"} 段目でバランスを崩しました。記録は ${state.score} 個です。`
          : `積んだ数: ${state.score} 個 / 次のブロック: 幅 ${state.current.width}・重さ ${state.current.weight}（${WEIGHT_LABEL[state.current.weight]}）`}
        {best !== null ? ` / ベスト: ${best} 個` : ""}
        {state.status === "playing" && state.score > 0 ? <ScorePop key={state.score} amount={1} /> : null}
      </p>

      {state.status === "collapsed" && (
        <EndScreen
          outcome="lose"
          title="タワーが崩れました"
          score={state.score}
          scoreLabel="積んだ数"
          newBest={state.score > 0 && (gameBestRef.current === null || state.score > gameBestRef.current)}
          previousBest={
            state.score > 0 && gameBestRef.current !== null && state.score > gameBestRef.current
              ? null
              : gameBestRef.current
          }
          onRetry={restart}
        >
          <p className="muted" style={{ margin: 0 }}>
            {state.collapsedLevel !== null ? state.collapsedLevel + 1 : "?"} 段目でバランスを崩しました。
          </p>
        </EndScreen>
      )}

      <div
        ref={fieldRef}
        role="img"
        aria-label={`タワー。現在 ${state.score} 個積まれています`}
        onPointerDown={onFieldTap}
        style={{
          position: "relative",
          height: Math.max(FIELD_HEIGHT, towerHeight + 60),
          background: "linear-gradient(#eaf3fb, #f7fbff)",
          border: "1px solid #c9d8e6",
          borderRadius: 8,
          overflow: "hidden",
          touchAction: "manipulation",
          cursor: state.status === "playing" ? "crosshair" : "default",
        }}
      >
        {/* 重心マーカー */}
        <div
          aria-hidden
          style={{
            position: "absolute",
            left: `calc(${(comX / BALANCE_FIELD_WIDTH) * 100}% - 7px)`,
            bottom: 30 + previewBlocks.length * blockHeight,
            fontSize: 14,
            color: "#c0392b",
            transition: "left 0.08s linear",
          }}
        >
          ▼
        </div>
        {/* 土台 */}
        <div
          aria-hidden
          style={{
            position: "absolute",
            left: `${BALANCE_BASE.left}%`,
            width: `${BALANCE_BASE.right - BALANCE_BASE.left}%`,
            bottom: 14,
            height: 14,
            background: "#5b4632",
            borderRadius: 3,
          }}
        />
        <div aria-hidden style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 14, background: "#8a6d4f" }} />
        {state.blocks.map((b, i) =>
          renderBlock(b, i, {
            collapsed: state.status === "collapsed" && state.collapsedLevel === i,
            juiceClass:
              state.status === "collapsed"
                ? "juice-shake"
                : i === state.blocks.length - 1
                  ? "juice-pop"
                  : undefined,
          }),
        )}
        {state.status === "playing" &&
          renderBlock({ ...state.current, center: previewCenter }, state.blocks.length, {
            ghost: true,
            juiceClass: preview && !preview.stable ? "juice-shake" : undefined,
          })}
      </div>

      {state.status === "playing" && preview && (
        <div style={{ marginTop: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#555" }}>
            <span>この位置の安定度</span>
            <span>{preview.stable ? `余裕 ${preview.minMargin.toFixed(1)}` : "この位置では崩れます"}</span>
          </div>
          <div aria-hidden style={{ height: 10, background: "#eee", borderRadius: 5, overflow: "hidden" }}>
            <div
              style={{
                height: "100%",
                width: `${marginRatio * 100}%`,
                background: preview.stable ? "#4caf50" : "#e53935",
                transition: "width 0.08s linear",
              }}
            />
          </div>
        </div>
      )}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginTop: 12, alignItems: "center" }}>
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, flex: "1 1 240px" }}>
          置く位置
          <input
            type="range"
            min={0}
            max={100}
            step={0.5}
            value={center}
            aria-label="ブロックを置く位置"
            onChange={(e) => setCenter(Number(e.target.value))}
            disabled={state.status !== "playing"}
            style={{ flex: 1, minHeight: 40 }}
          />
        </label>
        <button
          type="button"
          className="classic-btn"
          style={{ minHeight: 44, minWidth: 110, fontWeight: 700 }}
          disabled={state.status !== "playing"}
          onClick={place}
        >
          置く
        </button>
        <button type="button" className="classic-btn" style={{ minHeight: 44 }} onClick={restart}>
          もう一度
        </button>
      </div>
      <p style={{ fontSize: 12, color: "#888", marginTop: 8 }}>
        ▼ はタワー全体の重心です。盤面をタップしても位置を決められます。
      </p>
    </div>
  );
}
