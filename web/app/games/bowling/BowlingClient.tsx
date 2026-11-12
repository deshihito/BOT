"use client";
// ボウリング（3D）。レーンと物理は BowlingScene3D（three.js、動的 import）、
// スコア進行は lib/bowling.ts の throwPins（物理で決まった倒ピンを受け取る）。
// 操作: ドラッグでボールの位置を決め、上へフリックすると速さ・方向・回転が決まる。
// ボタン投球（左右移動＋「投げる」）でも遊べる。
// ベスト記録: localStorage `ago-bowling-best` に最高スコアを保存する。
import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  createBowlingGame,
  frameScores,
  rollMark,
  scoreRolls,
  standingCount,
  throwPins,
  type BowlingState,
} from "@/lib/bowling";
import { isSfxMuted, setSfxMuted } from "@/lib/sfx";
import { useGamesNav } from "../GamesShell";
import type { BowlingSceneApi } from "./BowlingScene3D";

const BowlingScene3D = dynamic(() => import("./BowlingScene3D"), {
  ssr: false,
  loading: () => (
    <div
      style={{
        height: 470,
        borderRadius: 12,
        background: "#232b36",
        color: "#dfe7ef",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 14,
      }}
    >
      読み込み中…
    </div>
  ),
});

const BEST_KEY = "ago-bowling-best";

export default function BowlingClient() {
  const { prefix } = useGamesNav();
  const [state, setState] = useState<BowlingState>(() => createBowlingGame(Date.now() % 2147483647));
  const [rolling, setRolling] = useState(false);
  const [message, setMessage] = useState("ボールを左右に動かして、上へフリックで投げてください。");
  const [best, setBest] = useState<number | null>(null);
  const [muted, setMuted] = useState(false);
  const savedRef = useRef(false);
  const stateRef = useRef(state);
  stateRef.current = state;
  const sceneApiRef = useRef<BowlingSceneApi | null>(null);

  useEffect(() => {
    try {
      const v = Number(localStorage.getItem(BEST_KEY));
      setBest(Number.isFinite(v) && v > 0 ? v : null);
    } catch {
      setBest(null);
    }
    setMuted(isSfxMuted());
  }, []);

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
    if (rolling) return;
    setState(createBowlingGame(Date.now() % 2147483647));
    savedRef.current = false;
    setMessage("ボールを左右に動かして、上へフリックで投げてください。");
  };

  const toggleMute = () => {
    const next = !muted;
    setMuted(next);
    setSfxMuted(next);
  };

  const handleResult = (knockedPins: number[]) => {
    const prev = stateRef.current;
    const result = throwPins(prev, knockedPins);
    setState(result.state);
    if (result.state.finished) {
      setMessage(`ゲーム終了！ スコアは ${scoreRolls(result.state.rolls)} 点でした。`);
    } else if (result.knocked === 10 && prev.ballInFrame === 0) {
      setMessage("ストライク！");
    } else if (result.knocked === 0) {
      setMessage("ガター…1本も倒れませんでした。" + (result.state.ballInFrame > 0 ? "次の投球です。" : "次のフレームです。"));
    } else {
      setMessage(
        `${result.knocked} 本倒れました（${result.knockedPins.join("・")} 番）。` +
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
        <p className="muted">真ん中やや右（1番と3番の間）がストライクの狙い目です。フリックの横のブレがそのまま曲がりになります。</p>
      </div>

      <div className="classic-controls" role="group" aria-label="操作">
        <button type="button" className="classic-btn" onClick={restart} disabled={rolling}>
          もう一度
        </button>
        <button type="button" className="classic-btn" onClick={toggleMute} aria-pressed={muted}>
          音: {muted ? "オフ" : "オン"}
        </button>
      </div>

      <p className="classic-status" role="status">
        {state.finished
          ? `最終スコア ${totalScore}`
          : `第 ${state.frame + 1} フレーム ・ ${state.ballInFrame + 1} 投目 ・ 残り ${standingCount(state.standing)} 本`}
        {best !== null ? ` ・ ベスト ${best}` : ""} ・ {message}
      </p>

      <div style={{ maxWidth: 430, margin: "0 auto" }}>
        <BowlingScene3D
          standing={state.standing}
          interactive={!state.finished}
          onResult={handleResult}
          onBusyChange={setRolling}
          onReady={(api) => {
            sceneApiRef.current = api;
          }}
        />

        <div style={{ display: "flex", gap: 8, marginTop: 12 }} role="group" aria-label="ボタンで投げる">
          <button
            type="button"
            className="classic-btn"
            style={{ minWidth: 56, minHeight: 48 }}
            aria-label="左へ移動"
            disabled={rolling || state.finished}
            onClick={() => sceneApiRef.current?.adjustAim(-0.18)}
          >
            ◀
          </button>
          <button
            type="button"
            className="classic-btn classic-btn-active"
            style={{ flex: 1, minHeight: 48 }}
            disabled={rolling || state.finished}
            onClick={() => sceneApiRef.current?.throwStraight()}
          >
            投げる
          </button>
          <button
            type="button"
            className="classic-btn"
            style={{ minWidth: 56, minHeight: 48 }}
            aria-label="右へ移動"
            disabled={rolling || state.finished}
            onClick={() => sceneApiRef.current?.adjustAim(0.18)}
          >
            ▶
          </button>
        </div>
        <p className="muted" style={{ fontSize: 13, marginTop: 8 }}>
          レーンをドラッグでボールの位置、素早く上へフリックすると投球（横のブレで曲がります）。ボタンでも投げられます。
        </p>

        <table
          aria-label="スコアシート"
          style={{ width: "100%", borderCollapse: "collapse", marginTop: 12, fontSize: 13 }}
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
