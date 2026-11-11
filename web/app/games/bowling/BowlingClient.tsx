"use client";
// ボウリング。スコア計算とピンの倒れ方モデルは lib/bowling.ts（シード決定的）。
// 狙い（横位置）を決め、往復するパワーメーターを止めて投げる。
// ベスト記録: localStorage `ago-bowling-best` に最高スコアを保存する。
// 端末内で完結し、サーバーへ送信しない。
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  AIM_MAX,
  AIM_MIN,
  PIN_POSITIONS,
  createBowlingGame,
  frameScores,
  rollMark,
  scoreRolls,
  standingCount,
  throwBall,
  type BowlingState,
} from "@/lib/bowling";
import { useGamesNav } from "../GamesShell";

const BEST_KEY = "ago-bowling-best";

export default function BowlingClient() {
  const { prefix } = useGamesNav();
  const [state, setState] = useState<BowlingState>(() => createBowlingGame(Date.now() % 2147483647));
  const [aim, setAim] = useState(0.2);
  const [power, setPower] = useState(0);
  const [metering, setMetering] = useState(false);
  const [message, setMessage] = useState("狙いを決めて「パワーを決める」を押してください。");
  const [best, setBest] = useState<number | null>(null);
  const dirRef = useRef(1);
  const savedRef = useRef(false);

  useEffect(() => {
    try {
      const v = Number(localStorage.getItem(BEST_KEY));
      setBest(Number.isFinite(v) && v > 0 ? v : null);
    } catch {
      setBest(null);
    }
  }, []);

  useEffect(() => {
    if (!metering) return;
    const id = setInterval(() => {
      setPower((p) => {
        let next = p + dirRef.current * 2.4;
        if (next >= 100) { next = 100; dirRef.current = -1; }
        if (next <= 0) { next = 0; dirRef.current = 1; }
        return next;
      });
    }, 16);
    return () => clearInterval(id);
  }, [metering]);

  useEffect(() => {
    if (!state.finished || savedRef.current) return;
    savedRef.current = true;
    const score = scoreRolls(state.rolls);
    if (best === null || score > best) {
      setBest(score);
      try {
        localStorage.setItem(BEST_KEY, String(score));
      } catch {
        // 保存失敗はプレイに影響しない。
      }
    }
  }, [state.finished, state.rolls, best]);

  const restart = () => {
    setState(createBowlingGame(Date.now() % 2147483647));
    setAim(0.2);
    setPower(0);
    setMetering(false);
    savedRef.current = false;
    setMessage("狙いを決めて「パワーを決める」を押してください。");
  };

  const doThrow = () => {
    setMetering(false);
    const result = throwBall(state, aim, Math.round(power));
    setState(result.state);
    if (result.state.finished) {
      setMessage(`ゲーム終了！ スコアは ${scoreRolls(result.state.rolls)} 点でした。`);
    } else if (result.knocked === 10 && state.ballInFrame === 0) {
      setMessage("ストライク！ 🎳");
    } else {
      setMessage(
        `${result.knocked} 本倒れました（${result.knockedPins.join("・") || "なし"}）。` +
          (result.state.ballInFrame > 0 ? "次の投球です。" : "次のフレームです。"),
      );
    }
  };

  const scores = frameScores(state.rolls);
  const totalScore = scoreRolls(state.rolls);

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>ボウリング</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>ボウリング</h1>
        <p className="muted">真ん中やや右（1番と3番の間）がストライクの狙い目です。強すぎる球は荒れるので注意。</p>
      </div>

      <div className="classic-controls" role="group" aria-label="操作">
        <button type="button" className="classic-btn" onClick={restart}>
          もう一度
        </button>
      </div>

      <p className="classic-status" role="status">
        {state.finished
          ? `最終スコア ${totalScore}`
          : `第 ${state.frame + 1} フレーム ・ ${state.ballInFrame + 1} 投目 ・ 残り ${standingCount(state.standing)} 本`}
        {best !== null ? ` ・ ベスト ${best}` : ""} ・ {message}
      </p>

      <div style={{ maxWidth: 380, margin: "0 auto" }}>
        <div
          role="img"
          aria-label={`立っているピン ${standingCount(state.standing)} 本`}
          style={{
            position: "relative",
            height: 250,
            borderRadius: 12,
            background: "linear-gradient(#c9a15f, #a67c3d)",
            border: "2px solid #7d5a24",
            overflow: "hidden",
          }}
        >
          {PIN_POSITIONS.map((pin, i) => {
            const up = state.standing[i];
            return (
              <div
                key={i}
                aria-hidden
                style={{
                  position: "absolute",
                  left: `${((pin.x + 2) / 4) * 100}%`,
                  top: `${8 + pin.y * 17}%`,
                  transform: `translate(-50%, 0) ${up ? "" : "rotate(70deg)"}`,
                  width: 30,
                  height: 30,
                  borderRadius: "50%",
                  background: up ? "#fff" : "rgba(255,255,255,0.35)",
                  border: "2px solid #c0392b",
                  color: "#c0392b",
                  fontSize: 13,
                  fontWeight: 700,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  opacity: up ? 1 : 0.45,
                }}
              >
                {i + 1}
              </div>
            );
          })}
          <div
            aria-hidden
            style={{
              position: "absolute",
              bottom: 12,
              left: `${((aim * 1.7 + 2) / 4) * 100}%`,
              transform: "translateX(-50%)",
              width: 26,
              height: 26,
              borderRadius: "50%",
              background: "#37474f",
              border: "2px solid #10222b",
            }}
          />
          <div
            aria-hidden
            style={{
              position: "absolute",
              bottom: 44,
              left: `${((aim * 1.7 + 2) / 4) * 100}%`,
              transform: "translateX(-50%)",
              fontSize: 14,
            }}
          >
            ▲
          </div>
        </div>

        <div style={{ marginTop: 14 }}>
          <label htmlFor="bowling-aim" style={{ fontSize: 14 }}>
            狙い（横位置）: {aim.toFixed(2)}
          </label>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button
              type="button"
              className="classic-btn"
              aria-label="左へ"
              onClick={() => setAim((a) => Math.max(AIM_MIN, a - 0.1))}
            >
              ◀
            </button>
            <input
              id="bowling-aim"
              type="range"
              min={AIM_MIN}
              max={AIM_MAX}
              step={0.05}
              value={aim}
              onChange={(e) => setAim(Number(e.target.value))}
              style={{ flex: 1, minHeight: 40 }}
            />
            <button
              type="button"
              className="classic-btn"
              aria-label="右へ"
              onClick={() => setAim((a) => Math.min(AIM_MAX, a + 0.1))}
            >
              ▶
            </button>
          </div>
        </div>

        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 14, marginBottom: 4 }}>パワー: {Math.round(power)}</div>
          <div
            aria-hidden
            style={{ height: 14, borderRadius: 7, background: "var(--soft, #eee)", overflow: "hidden" }}
          >
            <div
              style={{
                height: "100%",
                width: `${power}%`,
                background: power > 95 ? "#c0392b" : power >= 55 ? "#2e9e5b" : "#d9a400",
              }}
            />
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            {!metering ? (
              <button
                type="button"
                className="classic-btn classic-btn-active"
                style={{ flex: 1, minHeight: 48 }}
                disabled={state.finished}
                onClick={() => {
                  dirRef.current = 1;
                  setPower(0);
                  setMetering(true);
                }}
              >
                パワーを決める
              </button>
            ) : (
              <button
                type="button"
                className="classic-btn classic-btn-active"
                style={{ flex: 1, minHeight: 48 }}
                onClick={doThrow}
              >
                投げる！
              </button>
            )}
          </div>
        </div>

        <table
          aria-label="スコアシート"
          style={{ width: "100%", borderCollapse: "collapse", marginTop: 16, fontSize: 13 }}
        >
          <thead>
            <tr>
              {Array.from({ length: 10 }, (_, f) => (
                <th key={f} style={{ border: "1px solid var(--line, #ccc)", padding: "3px 0" }}>
                  {f + 1}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              {Array.from({ length: 10 }, (_, f) => (
                <td key={f} style={{ border: "1px solid var(--line, #ccc)", padding: "3px 0", textAlign: "center" }}>
                  {f < 9
                    ? [rollMark(state.rolls, f, 0), rollMark(state.rolls, f, 1)].filter(Boolean).join(" ") || "・"
                    : [rollMark(state.rolls, f, 0), rollMark(state.rolls, f, 1), rollMark(state.rolls, f, 2)]
                        .filter(Boolean)
                        .join(" ") || "・"}
                </td>
              ))}
            </tr>
            <tr>
              {scores.map((s, f) => (
                <td
                  key={f}
                  style={{
                    border: "1px solid var(--line, #ccc)",
                    padding: "3px 0",
                    textAlign: "center",
                    fontWeight: 700,
                  }}
                >
                  {s ?? ""}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    </>
  );
}
