"use client";
// ラッシュアワー。ロジックは lib/rushhour.ts（解けた配置から崩す生成で
// 必ず解ける）。車を選ぶと動かせる方向と距離がボタンで出る。
// 1回のスライド（距離を問わず）を1手として数える。
import Link from "next/link";
import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import { sfxSlide, sfxTap, sfxWin } from "@/lib/sfx";
import { EndScreen } from "../GameJuice";
import {
  RUSH_EXIT_ROW,
  createRushHour,
  rushSlide,
  rushSlideOptions,
  rushSlideRange,
  type RushState,
} from "@/lib/rushhour";

// 3D シーンは three を含むため遅延読み込み（このページ専用チャンクに閉じる）。
const RushHourScene3D = dynamic(() => import("./RushHourScene3D"), { ssr: false });
import { useGamesNav } from "../GamesShell";

const BEST_KEY = "ago-rushhour-best";
const CAR_COLORS = [
  "#3b82f6", "#22c55e", "#a855f7", "#f59e0b", "#06b6d4",
  "#84cc16", "#ec4899", "#6366f1", "#f97316", "#14b8a6", "#eab308",
];

export default function RushHourClient() {
  const { prefix } = useGamesNav();
  const [webglFailed, setWebglFailed] = useState(false);
  const [state, setState] = useState<RushState>(() =>
    createRushHour(Date.now() % 2147483647),
  );
  const [selected, setSelected] = useState<number | null>(null);
  const [best, setBest] = useState<number | null>(null);

  useEffect(() => {
    try {
      const saved = Number(window.localStorage.getItem(BEST_KEY));
      setBest(Number.isFinite(saved) && saved > 0 ? saved : null);
    } catch {
      setBest(null);
    }
  }, []);

  const prevStatusRef = useRef(state.status);
  const [winPrevBest, setWinPrevBest] = useState<number | null>(null);
  const [winNewBest, setWinNewBest] = useState(false);

  // 終局遷移の捕捉はベスト保存 effect より前に置き、保存前のベストを記録する。
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = state.status;
    if (prev !== "won" && state.status === "won") {
      setWinPrevBest(best);
      setWinNewBest(best === null || state.moves < best);
      sfxWin();
    }
  }, [state.status, state.moves, best]);

  useEffect(() => {
    if (state.status !== "won") return;
    if (best !== null && state.moves >= best) return;
    setBest(state.moves);
    try {
      window.localStorage.setItem(BEST_KEY, String(state.moves));
    } catch {
      // 保存失敗はプレイに影響しない。
    }
  }, [state.status, state.moves, best]);

  const restart = () => {
    setState(createRushHour(Date.now() % 2147483647));
    setSelected(null);
    setWinPrevBest(null);
    setWinNewBest(false);
  };

  const options = selected !== null ? rushSlideOptions(state, selected) : [];
  const selectedCar = state.cars.find((c) => c.id === selected) ?? null;

  // 車タップ（2D の車ボタンと 3D の車タップで共用する現行ハンドラ）。
  const onCarTap = (carId: number) => {
    sfxTap();
    setSelected(selected === carId ? null : carId);
  };

  // スライド実行（2D の移動ボタンと 3D のドラッグ確定で共用）。
  // 1回のスライド（距離を問わず）を1手として数える現行仕様のまま。
  const slideCar = (carId: number, delta: number) => {
    sfxSlide();
    setState((s) => rushSlide(s, carId, delta));
  };

  // 3D ドラッグ用: 車ごとのスライド可能範囲（合法判定は lib が持つ）。
  const ranges: Record<number, { min: number; max: number }> = {};
  for (const car of state.cars) ranges[car.id] = rushSlideRange(state, car.id);

  const statusText =
    state.status === "won"
      ? `脱出成功！${state.moves}手でクリアです。`
      : selectedCar
        ? "動かす方向と距離を選んでください。"
        : "車をタップして選んでください。赤い車を右端の出口へ出せばクリアです。";

  // 2D 盤（WebGL が使えない場合のフォールバックとしてそのまま使う）。
  const board2d = (
      <div
        role="grid"
        aria-label="ラッシュアワーの盤面"
        style={{
          position: "relative",
          width: "100%",
          maxWidth: 480,
          aspectRatio: "1 / 1",
          margin: "0 auto",
          background: "#f1f5f9",
          border: "2px solid #94a3b8",
          borderRadius: 10,
          overflow: "hidden",
        }}
      >
        {/* マス目の背景 */}
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            inset: 0,
            display: "grid",
            gridTemplateColumns: "repeat(6, 1fr)",
            gridTemplateRows: "repeat(6, 1fr)",
          }}
        >
          {Array.from({ length: 36 }, (_, i) => (
            <div key={i} style={{ border: "1px solid #e2e8f0" }} />
          ))}
        </div>
        {/* 出口マーカー */}
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            top: `${(RUSH_EXIT_ROW / 6) * 100}%`,
            right: 0,
            width: "3.5%",
            height: `${100 / 6}%`,
            background: "#ef4444",
            opacity: 0.85,
          }}
        />
        {state.cars.map((car) => {
          const isSel = selected === car.id;
          const color = car.target ? "#dc2626" : CAR_COLORS[car.id % CAR_COLORS.length];
          return (
            <button
              key={car.id}
              type="button"
              role="gridcell"
              aria-pressed={isSel}
              aria-label={
                car.target
                  ? "赤い車（出口へ出す車）"
                  : `${car.dir === "h" ? "横" : "縦"}の車（長さ${car.len}）`
              }
              className={isSel ? "juice-pulse" : undefined}
              onClick={() => onCarTap(car.id)}
              style={{
                position: "absolute",
                left: `${(car.col / 6) * 100 + 0.6}%`,
                top: `${(car.row / 6) * 100 + 0.6}%`,
                width: `${((car.dir === "h" ? car.len : 1) / 6) * 100 - 1.2}%`,
                height: `${((car.dir === "v" ? car.len : 1) / 6) * 100 - 1.2}%`,
                background: color,
                border: isSel ? "3px solid #f59e0b" : "2px solid rgba(0,0,0,0.25)",
                borderRadius: 8,
                color: "#fff",
                fontSize: 18,
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: 0,
              }}
            >
              {car.target ? "★" : ""}
            </button>
          );
        })}
      </div>
  );

  return (
    <div>
      <p className="classic-status" role="status">
        手数 {state.moves}
        {best !== null ? ` ・ ベスト ${best} 手` : ""} ・ {statusText}
      </p>

      {webglFailed ? board2d : (
        <div style={{ width: "100%", maxWidth: 480, margin: "0 auto" }}>
          <RushHourScene3D
            cars={state.cars}
            selected={selected}
            status={state.status}
            ranges={ranges}
            onTapCar={onCarTap}
            onGrabCar={(carId) => setSelected(carId)}
            onSlide={slideCar}
            onFail={() => setWebglFailed(true)}
            fallback={board2d}
          />
        </div>
      )}

      <div
        className="classic-controls"
        role="group"
        aria-label="車を動かす"
        style={{ marginTop: 12, minHeight: 40 }}
      >
        {selectedCar && state.status === "playing" ? (
          options.length > 0 ? (
            options.map((delta) => {
              const vertical = selectedCar.dir === "v";
              const arrow = vertical ? (delta < 0 ? "↑" : "↓") : delta < 0 ? "←" : "→";
              return (
                <button
                  key={delta}
                  type="button"
                  className="classic-btn classic-btn-active"
                  onClick={() => slideCar(selectedCar.id, delta)}
                >
                  {arrow} {Math.abs(delta)}マス
                </button>
              );
            })
          ) : (
            <span style={{ fontSize: 14, color: "#64748b" }}>
              この車は今は動けません。ほかの車をどかしましょう。
            </span>
          )
        ) : (
          <span style={{ fontSize: 14, color: "#64748b" }}>車を選ぶと移動ボタンが出ます。</span>
        )}
      </div>

      <div className="classic-controls" role="group" aria-label="その他" style={{ marginTop: 8 }}>
        <button type="button" className="classic-btn" onClick={restart}>
          もう一度
        </button>
        <Link className="classic-btn" href={`${prefix}/games`}>
          ゲーム一覧へ
        </Link>
      </div>

      {state.status === "won" && (
        <div style={{ maxWidth: 480, margin: "14px auto 0" }}>
          <EndScreen
            outcome="win"
            title="脱出成功！"
            score={state.moves}
            scoreLabel="手数"
            newBest={winNewBest}
            previousBest={winPrevBest}
            onRetry={restart}
          >
            <p className="muted" style={{ margin: 0 }}>
              {state.moves}手でクリアです。
            </p>
          </EndScreen>
        </div>
      )}
    </div>
  );
}
