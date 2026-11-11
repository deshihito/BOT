"use client";
// ラッシュアワー。ロジックは lib/rushhour.ts（解けた配置から崩す生成で
// 必ず解ける）。車を選ぶと動かせる方向と距離がボタンで出る。
// 1回のスライド（距離を問わず）を1手として数える。
import Link from "next/link";
import { useEffect, useState } from "react";
import {
  RUSH_EXIT_ROW,
  createRushHour,
  rushSlide,
  rushSlideOptions,
  type RushState,
} from "@/lib/rushhour";
import { useGamesNav } from "../GamesShell";

const BEST_KEY = "ago-rushhour-best";
const CAR_COLORS = [
  "#3b82f6", "#22c55e", "#a855f7", "#f59e0b", "#06b6d4",
  "#84cc16", "#ec4899", "#6366f1", "#f97316", "#14b8a6", "#eab308",
];

export default function RushHourClient() {
  const { prefix } = useGamesNav();
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
  };

  const options = selected !== null ? rushSlideOptions(state, selected) : [];
  const selectedCar = state.cars.find((c) => c.id === selected) ?? null;

  const statusText =
    state.status === "won"
      ? `脱出成功！${state.moves}手でクリアです。`
      : selectedCar
        ? "動かす方向と距離を選んでください。"
        : "車をタップして選んでください。赤い車を右端の出口へ出せばクリアです。";

  return (
    <div>
      <p className="classic-status" role="status">
        手数 {state.moves}
        {best !== null ? ` ・ ベスト ${best} 手` : ""} ・ {statusText}
      </p>

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
              onClick={() => setSelected(isSel ? null : car.id)}
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
              {car.target ? "🚗" : ""}
            </button>
          );
        })}
      </div>

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
                  onClick={() => setState((s) => rushSlide(s, selectedCar.id, delta))}
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
    </div>
  );
}
