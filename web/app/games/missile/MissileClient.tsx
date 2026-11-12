"use client";
// ミサイル防衛。ロジックは lib/missile.ts（固定ステップ・シード決定的）。
// フィールドをタップした地点へ一番近い基地から迎撃弾を撃ち、爆風で敵ミサイルを壊す。
// 端末内で完結し、サーバーへ送信しない。
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  FIELD_H,
  FIELD_W,
  GROUND_Y,
  MISSILE_STEP_MS,
  aliveBases,
  aliveCities,
  blastRadius,
  createMissileGame,
  enemyPosition,
  fireAt,
  interceptorPosition,
  stepMissile,
  totalAmmo,
  type MissileState,
} from "@/lib/missile";
import { sfxCorrect, sfxLose, sfxPop, sfxTap } from "@/lib/sfx";
import { EndScreen } from "../GameJuice";
import { useGamesNav } from "../GamesShell";

function newGame(): MissileState {
  return createMissileGame(Date.now() % 2147483647);
}

export default function MissileClient() {
  const { prefix } = useGamesNav();
  const [state, setState] = useState<MissileState>(() => newGame());
  const [best, setBest] = useState<number | null>(null);
  const [endInfo, setEndInfo] = useState<{ newBest: boolean; prevBest: number | null } | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const savedRef = useRef<string | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const prevKillsRef = useRef(0);

  // 固定ステップでシミュレーションを進める。
  useEffect(() => {
    const id = setInterval(() => setState((s) => stepMissile(s)), MISSILE_STEP_MS);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    try {
      const saved = Number(window.localStorage.getItem("ago-missile-best"));
      setBest(Number.isFinite(saved) && saved > 0 ? saved : null);
    } catch {
      setBest(null);
    }
  }, []);

  // ウェーブクリア／ゲームオーバーの遷移音（フェーズ変化時のみ）
  useEffect(() => {
    if (state.phase === "waveclear") sfxCorrect();
    else if (state.phase === "over") sfxLose();
  }, [state.phase]);

  // 敵ミサイルを破壊した瞬間の爆発音（キル数の変化時のみ）
  useEffect(() => {
    if (state.kills > prevKillsRef.current && state.phase === "playing") sfxPop();
    prevKillsRef.current = state.kills;
  }, [state.kills, state.phase]);

  useEffect(() => {
    if (state.phase !== "over") return;
    const key = `${state.seed}:${state.wave}:${state.score}`;
    if (savedRef.current === key) return;
    savedRef.current = key;
    setEndInfo({ newBest: best === null || state.score > best, prevBest: best });
    if (best !== null && state.score <= best) return;
    setBest(state.score);
    try {
      window.localStorage.setItem("ago-missile-best", String(state.score));
    } catch {
      // 保存失敗はプレイに影響しない。
    }
  }, [state.phase, state.seed, state.wave, state.score, best]);

  const onFire = (e: React.PointerEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const x = ((e.clientX - rect.left) / rect.width) * FIELD_W;
    const y = ((e.clientY - rect.top) / rect.height) * FIELD_H;
    const cur = stateRef.current;
    const next = fireAt(cur, x, y);
    if (next.interceptors.length > cur.interceptors.length) sfxTap();
    setState(next);
  };

  const restart = () => {
    sfxTap();
    savedRef.current = null;
    prevKillsRef.current = 0;
    setEndInfo(null);
    setState(newGame());
  };

  const statusText =
    state.phase === "over"
      ? "都市が全滅しました。ゲームオーバー。"
      : state.phase === "waveclear"
        ? `ウェーブ${state.wave}を防ぎきった！ボーナス加算。次のウェーブに備えよう。`
        : totalAmmo(state) === 0
          ? "迎撃弾が尽きた…このウェーブは耐えるしかない。"
          : "空をタップして迎撃しよう。";

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>ミサイル防衛</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>ミサイル防衛</h1>
        <p className="muted">
          爆風は少し残るので、ミサイルの少し先を狙って撃つのがコツです。
        </p>
      </div>

      <div className="classic-controls" role="group" aria-label="操作">
        <button type="button" className="classic-btn" onClick={restart}>
          もう一度
        </button>
      </div>

      <p className="classic-status" role="status">
        ウェーブ {state.wave} ・ スコア <span key={state.score} className="juice-pulse" style={{ display: "inline-block" }}>{state.score}</span>
        {best !== null ? ` ・ ベスト ${best}` : ""} ・ 都市 {aliveCities(state)}/6 ・ 基地{" "}
        {aliveBases(state)}/3 ・ 残弾 {totalAmmo(state)} ・ 破壊 {state.kills} ・ {statusText}
      </p>

      <svg
        ref={svgRef}
        viewBox={`0 0 ${FIELD_W} ${FIELD_H}`}
        role="img"
        aria-label="ミサイル防衛のフィールド。タップした地点へ迎撃弾を撃ちます"
        onPointerDown={onFire}
        style={{
          width: "100%",
          maxWidth: 760,
          display: "block",
          margin: "0 auto",
          background: "linear-gradient(#0b1026, #1b2a4a)",
          borderRadius: 12,
          touchAction: "manipulation",
          cursor: state.phase === "playing" ? "crosshair" : "default",
        }}
      >
        {/* 地面 */}
        <rect x={0} y={GROUND_Y} width={FIELD_W} height={FIELD_H - GROUND_Y} fill="#2e4a2f" />
        {/* 敵ミサイルの軌跡と弾頭 */}
        {state.enemies.map((m) => {
          const p = enemyPosition(m);
          return (
            <g key={m.id} aria-hidden>
              <line x1={m.sx} y1={m.sy} x2={p.x} y2={p.y} stroke="#ff9d5c" strokeWidth={2} opacity={0.7} />
              <circle cx={p.x} cy={p.y} r={5} fill="#ff5c5c" />
            </g>
          );
        })}
        {/* 迎撃弾 */}
        {state.interceptors.map((it, i) => {
          const p = interceptorPosition(it);
          return (
            <g key={i} aria-hidden>
              <line x1={it.sx} y1={it.sy} x2={p.x} y2={p.y} stroke="#9fd8ff" strokeWidth={2} opacity={0.7} />
              <circle cx={p.x} cy={p.y} r={4} fill="#cfeaff" />
            </g>
          );
        })}
        {/* 爆風 */}
        {state.blasts.map((b, i) => (
          <circle
            key={i}
            cx={b.x}
            cy={b.y}
            r={Math.max(0, blastRadius(b.ageSteps))}
            fill="#ffb347"
            opacity={0.45}
            aria-hidden
          />
        ))}
        {/* 構造物 */}
        {state.structures.map((s, i) =>
          s.kind === "city" ? (
            <g key={i} aria-hidden>
              {s.alive ? (
                <>
                  <rect x={s.x - 22} y={GROUND_Y - 34} width={44} height={34} fill="#8fa8c8" />
                  <rect x={s.x - 14} y={GROUND_Y - 46} width={28} height={46} fill="#aebfd8" />
                </>
              ) : (
                <rect x={s.x - 22} y={GROUND_Y - 8} width={44} height={8} fill="#555" />
              )}
              <text x={s.x} y={GROUND_Y + 24} textAnchor="middle" fontSize={15} fill="#dce8f5">
                {s.alive ? "都市" : "壊滅"}
              </text>
            </g>
          ) : (
            <g key={i} aria-hidden>
              {s.alive ? (
                <polygon
                  points={`${s.x - 24},${GROUND_Y} ${s.x},${GROUND_Y - 30} ${s.x + 24},${GROUND_Y}`}
                  fill="#c8b06a"
                />
              ) : (
                <rect x={s.x - 24} y={GROUND_Y - 8} width={48} height={8} fill="#555" />
              )}
              <text x={s.x} y={GROUND_Y + 24} textAnchor="middle" fontSize={15} fill="#dce8f5">
                {s.alive ? "基地" : "壊滅"}
              </text>
            </g>
          ),
        )}
        {state.phase === "over" && (
          <text
            x={FIELD_W / 2}
            y={FIELD_H / 2}
            textAnchor="middle"
            fontSize={44}
            fontWeight={700}
            fill="#fff"
          >
            ゲームオーバー（ウェーブ{state.wave}・{state.score}点）
          </text>
        )}
        {state.phase === "waveclear" && (
          <text
            x={FIELD_W / 2}
            y={FIELD_H / 2}
            textAnchor="middle"
            fontSize={36}
            fontWeight={700}
            fill="#ffe28a"
          >
            ウェーブ{state.wave} クリア!
          </text>
        )}
      </svg>
      <p className="muted" style={{ textAlign: "center", marginTop: 8 }}>
        残弾はウェーブごとに補充されます。分裂したミサイルは爆風でまとめて壊せます。
      </p>

      {state.phase === "over" && (
        <div style={{ maxWidth: 520, margin: "14px auto 0" }}>
          <EndScreen
            outcome="lose"
            title="ゲームオーバー"
            score={state.score}
            newBest={endInfo?.newBest ?? false}
            previousBest={endInfo ? endInfo.prevBest : undefined}
            onRetry={restart}
          >
            <p className="muted" style={{ margin: 0 }}>
              ウェーブ {state.wave} まで防衛 ・ 破壊 {state.kills} ・ 都市 {aliveCities(state)}/6
            </p>
          </EndScreen>
        </div>
      )}
    </>
  );
}
