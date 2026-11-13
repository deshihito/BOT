"use client";
// 2048 方式のスライドパズル。ロジックは lib/slider2048.ts。
// 矢印キー・盤面スワイプで操作する。盤面ダブルタップで1手もどす（U キーでも可）。
// タイルは絶対配置し、lib の moveSlideDetailed が返す移動情報で
// transform を遷移させてスライドアニメーションする（最終状態は lib の盤面と一致）。
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  continueSlide,
  createSlideGame,
  moveSlideDetailed,
  SLIDE_SIZE,
  type SlideDir,
  type SlideState,
} from "@/lib/slider2048";
import { sfxLose, sfxSlide, sfxSpawn, sfxWin } from "@/lib/sfx";
import { tappableProps, useGesture } from "@/lib/gesture";
import { EndScreen } from "../GameJuice";
import { useGamesNav } from "../GamesShell";

const KEY_DIRS: Record<string, SlideDir> = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
};

const BEST_KEY = "ago-2048-best";
const ANIM_MS = 150;

type VTile = { id: number; value: number; index: number; pop: boolean };

export default function SliderClient() {
  const { prefix } = useGamesNav();
  const [initial] = useState<SlideState>(() => createSlideGame(Date.now() % 2147483647));
  const [state, setState] = useState<SlideState>(initial);
  const [best, setBest] = useState(0);
  const historyRef = useRef<SlideState[]>([]);
  // このゲーム開始時点のベスト。終了画面のベスト更新判定に使う（ベスト自体はプレイ中も更新される）。
  const startBestRef = useRef(0);

  const idRef = useRef(1);
  const stateRef = useRef(state);
  const [visual, setVisual] = useState<VTile[]>(() =>
    initial.tiles.flatMap((v, i) => (v > 0 ? [{ id: idRef.current++, value: v, index: i, pop: true }] : [])),
  );
  const visualRef = useRef(visual);
  const animTimerRef = useRef<number | null>(null);
  const pendingDirRef = useRef<SlideDir | null>(null);

  const applyVisual = useCallback((tiles: VTile[]) => {
    visualRef.current = tiles;
    setVisual(tiles);
  }, []);

  const applyState = useCallback((next: SlideState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const cancelAnimation = useCallback(() => {
    if (animTimerRef.current !== null) {
      window.clearTimeout(animTimerRef.current);
      animTimerRef.current = null;
    }
    pendingDirRef.current = null;
  }, []);

  useEffect(() => cancelAnimation, [cancelAnimation]);

  useEffect(() => {
    try {
      const saved = Number(window.localStorage.getItem(BEST_KEY));
      if (Number.isFinite(saved) && saved > 0) {
        setBest(saved);
        startBestRef.current = saved;
      }
    } catch {
      // 保存できない環境ではベスト表示なしで続行する。
    }
  }, []);

  useEffect(() => {
    if (state.score <= best) return;
    setBest(state.score);
    try {
      window.localStorage.setItem(BEST_KEY, String(state.score));
    } catch {
      // 保存失敗はプレイに影響しない。
    }
  }, [state.score, best]);

  const doMove = useCallback(
    (dir: SlideDir) => {
      if (animTimerRef.current !== null) {
        // アニメーション中の入力は1手だけ受け付けて後で実行する
        pendingDirRef.current = dir;
        return;
      }
      const current = stateRef.current;
      const detail = moveSlideDetailed(current, dir);
      if (!detail.moved) return;
      historyRef.current = [...historyRef.current.slice(-49), current];
      // フェーズ1: 各タイルを移動先へスライドさせる
      const byFrom = new Map(visualRef.current.map((t) => [t.index, t]));
      const sliding: VTile[] = detail.motions.map((m) => {
        const src = byFrom.get(m.from);
        return { id: src ? src.id : idRef.current++, value: m.value, index: m.to, pop: false };
      });
      applyVisual(sliding);
      // フェーズ2: 遷移後に最終状態を確定し、合体タイルを1枚に畳んで出現タイルを足す
      animTimerRef.current = window.setTimeout(() => {
        animTimerRef.current = null;
        applyState(detail.state);
        const finalTiles: VTile[] = [];
        const seenTo = new Set<number>();
        for (const m of detail.motions) {
          if (seenTo.has(m.to)) continue;
          seenTo.add(m.to);
          const src = sliding.find((t) => t.index === m.to);
          finalTiles.push({
            id: src ? src.id : idRef.current++,
            value: detail.state.tiles[m.to],
            index: m.to,
            pop: m.merged,
          });
        }
        if (detail.spawned) {
          finalTiles.push({
            id: idRef.current++,
            value: detail.spawned.value,
            index: detail.spawned.index,
            pop: true,
          });
        }
        applyVisual(finalTiles);
        const pending = pendingDirRef.current;
        pendingDirRef.current = null;
        if (pending) doMove(pending);
      }, ANIM_MS);
    },
    [applyState, applyVisual],
  );

  const undo = useCallback(() => {
    cancelAnimation();
    const prev = historyRef.current[historyRef.current.length - 1];
    if (!prev) return;
    historyRef.current = historyRef.current.slice(0, -1);
    applyState(prev);
    applyVisual(
      prev.tiles.flatMap((v, i) => (v > 0 ? [{ id: idRef.current++, value: v, index: i, pop: false }] : [])),
    );
  }, [applyState, applyVisual, cancelAnimation]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const dir = KEY_DIRS[e.key];
      if (dir) {
        e.preventDefault();
        doMove(dir);
        return;
      }
      // タップ対象物は Enter / Space しか受けないため U との二重発火はない。
      if (e.key === "u" || e.key === "U") undo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [doMove, undo]);

  // 盤面スワイプ = 移動、ダブルタップ = 1手もどす。旧来の TouchEvent 直書きを
  // 共通ヘルパー useGesture に寄せた（touchAction: "none" は盤面に既存）。
  const boardGesture = useGesture({
    onSwipe: (dir) => doMove(dir),
    onDoubleTap: () => undo(),
  });

  // 状態変化を見て効果音を鳴らす: 移動=スライド、最大タイル更新=出現、終局=ジングル。
  const prevStateRef = useRef(state);
  useEffect(() => {
    const prev = prevStateRef.current;
    prevStateRef.current = state;
    if (state.moves > prev.moves) {
      sfxSlide();
      if (Math.max(...state.tiles) > Math.max(...prev.tiles)) sfxSpawn();
    }
    if (state.status !== prev.status) {
      if (state.status === "won") sfxWin();
      if (state.status === "lost") sfxLose();
    }
  }, [state]);

  const restart = () => {
    cancelAnimation();
    historyRef.current = [];
    startBestRef.current = best;
    const next = createSlideGame(Date.now() % 2147483647);
    applyState(next);
    applyVisual(
      next.tiles.flatMap((v, i) => (v > 0 ? [{ id: idRef.current++, value: v, index: i, pop: true }] : [])),
    );
  };

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>2048</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>2048</h1>
        <p className="muted">同じ数字をぶつけて大きくしていくスライドパズル。盤面をスワイプして動かします。ダブルタップ（U キー）で1手もどします。2048 のタイルを目指そう。</p>
      </div>

      <p className="classic-status" role="status">
        スコア {state.score} ・ {state.moves} 手
        {best > 0 ? ` ・ ベスト ${best}` : ""}
        {state.status === "won" ? " ・ 2048 達成！" : ""}
        {state.status === "lost" ? " ・ もう動けません" : ""}
      </p>

      <div
        role="grid"
        aria-label="2048 の盤（スワイプで移動・ダブルタップで1手もどす）"
        {...boardGesture}
        style={{
          position: "relative",
          width: "100%",
          maxWidth: 420,
          aspectRatio: "1",
          margin: "0 auto",
          background: "#e9e4da",
          borderRadius: 12,
          touchAction: "none",
          boxSizing: "border-box",
        }}
      >
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            inset: 8,
            display: "grid",
            gridTemplateColumns: `repeat(${SLIDE_SIZE}, minmax(0, 1fr))`,
            gap: 8,
          }}
        >
          {Array.from({ length: SLIDE_SIZE * SLIDE_SIZE }, (_, i) => (
            <div key={i} className="slide-tile" />
          ))}
        </div>
        <div style={{ position: "absolute", inset: 8 }}>
          {visual.map((t) => {
            const row = Math.floor(t.index / SLIDE_SIZE);
            const col = t.index % SLIDE_SIZE;
            return (
              <div
                key={t.id}
                role="gridcell"
                aria-label={String(t.value)}
                style={{
                  position: "absolute",
                  left: 0,
                  top: 0,
                  width: `calc((100% - ${(SLIDE_SIZE - 1) * 8}px) / ${SLIDE_SIZE})`,
                  height: `calc((100% - ${(SLIDE_SIZE - 1) * 8}px) / ${SLIDE_SIZE})`,
                  transform: `translate(calc(${col} * (100% + 8px)), calc(${row} * (100% + 8px)))`,
                  transition: `transform ${ANIM_MS}ms ease-in-out`,
                  willChange: "transform",
                }}
              >
                <div
                  className={`slide-tile${t.pop ? " juice-pop" : ""}`}
                  data-v={t.value > 2048 ? "super" : String(t.value)}
                  style={{ width: "100%", height: "100%" }}
                >
                  {t.value}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {state.status === "won" ? (
        <EndScreen
          outcome="win"
          score={state.score}
          scoreLabel="スコア"
          newBest={state.score > startBestRef.current}
          previousBest={startBestRef.current > 0 ? startBestRef.current : null}
          onRetry={restart}
        >
          <p className="muted">2048 のタイルができました。</p>
          <div {...tappableProps(() => applyState(continueSlide(stateRef.current)))} className="classic-btn">
            このまま続ける
          </div>
        </EndScreen>
      ) : null}
      {state.status === "lost" ? (
        <EndScreen
          outcome="finish"
          score={state.score}
          scoreLabel="スコア"
          newBest={state.score > startBestRef.current}
          previousBest={startBestRef.current > 0 ? startBestRef.current : null}
          onRetry={restart}
        >
          <p className="muted">詰んでしまいました。{state.moves} 手で終了です。</p>
        </EndScreen>
      ) : null}

      <div className="classic-controls" role="group" aria-label="操作">
        <button type="button" className="classic-btn" onClick={restart}>
          もう一度
        </button>
      </div>
    </>
  );
}
