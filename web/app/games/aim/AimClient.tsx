"use client";
// エイム（的あて）。スケジュール/判定/得点は lib/aim.ts。
// 30秒間、エリア内に現れては消える的をクリック/タップする。小さい的ほど高得点。
import Link from "next/link";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";

const AimScene3D = dynamic(() => import("./AimScene3D"), { ssr: false });
import {
  AIM_FIELD_HEIGHT,
  AIM_GAME_MS,
  activeTargetsAt,
  createAimSchedule,
  hitTest,
  pointsForHit,
  type AimTarget,
} from "@/lib/aim";
import { sfxLose, sfxTap, sfxWin } from "@/lib/sfx";
import { EndScreen, ScorePop } from "../GameJuice";
import { useGamesNav } from "../GamesShell";

const BEST_KEY = "ago-aim-best";

type Phase = "ready" | "playing" | "finished";

function loadBest(): number {
  try {
    return Number(localStorage.getItem(BEST_KEY) ?? 0) || 0;
  } catch {
    return 0;
  }
}

export default function AimClient() {
  const { prefix } = useGamesNav();
  const [phase, setPhase] = useState<Phase>("ready");
  const [score, setScore] = useState(0);
  const [hits, setHits] = useState(0);
  const [shots, setShots] = useState(0);
  const [best, setBest] = useState(0);
  const [remainSec, setRemainSec] = useState(30);
  const [targets, setTargets] = useState<AimTarget[]>([]);
  const [webglFailed, setWebglFailed] = useState(false);
  const [lastGain, setLastGain] = useState<{ id: number; gained: number; key: number } | null>(null);
  const [resultInfo, setResultInfo] = useState<{ newBest: boolean; prevBest: number } | null>(null);
  const prevPhaseRef = useRef<Phase>("ready");

  // 終局遷移の瞬間だけジングルを鳴らす。
  useEffect(() => {
    const prev = prevPhaseRef.current;
    prevPhaseRef.current = phase;
    if (prev === phase || phase !== "finished") return;
    if (resultInfo?.newBest) sfxWin();
    else sfxLose();
  }, [phase, resultInfo]);

  const areaRef = useRef<HTMLDivElement | null>(null);
  const mountedRef = useRef(true);
  const rafRef = useRef(0);
  const endTimerRef = useRef<number | null>(null);
  const startAtRef = useRef(0);
  const scheduleRef = useRef<AimTarget[]>([]);
  const hitIdsRef = useRef<Set<number>>(new Set());
  const scoreRef = useRef(0);
  const hitsRef = useRef(0);
  const shotsRef = useRef(0);
  const phaseRef = useRef<Phase>("ready");
  phaseRef.current = phase;

  const clearLoops = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    if (endTimerRef.current !== null) {
      window.clearTimeout(endTimerRef.current);
      endTimerRef.current = null;
    }
  }, []);

  const finish = useCallback(() => {
    clearLoops();
    if (!mountedRef.current) return;
    setTargets([]);
    // 保存前のベストで更新判定を控える。
    const prevBest = loadBest();
    setResultInfo({ newBest: scoreRef.current > 0 && scoreRef.current > prevBest, prevBest });
    setPhase("finished");
    setRemainSec(0);
    if (scoreRef.current > loadBest()) {
      setBest(scoreRef.current);
      try {
        localStorage.setItem(BEST_KEY, String(scoreRef.current));
      } catch {
        /* 保存できなくても遊べる */
      }
    }
  }, [clearLoops]);

  useEffect(() => {
    mountedRef.current = true;
    setBest(loadBest());
    return () => {
      mountedRef.current = false;
      clearLoops();
    };
  }, [clearLoops]);

  const start = useCallback(() => {
    clearLoops();
    scheduleRef.current = createAimSchedule(Date.now() % 2147483647, AIM_GAME_MS);
    hitIdsRef.current = new Set();
    scoreRef.current = 0;
    hitsRef.current = 0;
    shotsRef.current = 0;
    setScore(0);
    setHits(0);
    setShots(0);
    setTargets([]);
    setLastGain(null);
    setResultInfo(null);
    setRemainSec(30);
    setPhase("playing");
    startAtRef.current = performance.now();

    const tick = () => {
      if (!mountedRef.current || phaseRef.current !== "playing") return;
      const elapsed = performance.now() - startAtRef.current;
      setRemainSec(Math.max(0, Math.ceil((AIM_GAME_MS - elapsed) / 1000)));
      setTargets(activeTargetsAt(scheduleRef.current, elapsed, hitIdsRef.current));
      if (elapsed < AIM_GAME_MS) {
        rafRef.current = requestAnimationFrame(tick);
      }
    };
    rafRef.current = requestAnimationFrame(tick);
    endTimerRef.current = window.setTimeout(finish, AIM_GAME_MS + 60);
  }, [clearLoops, finish]);

  // 射撃の本体。座標は lib と同じ統一単位（横幅=100）で受け、判定は
  // 従来どおり activeTargetsAt + hitTest に委ねる（3D 側も同じここへ渡す）。
  const shootAt = (x: number, y: number) => {
    if (phase !== "playing") return;
    shotsRef.current += 1;
    setShots(shotsRef.current);
    const elapsed = performance.now() - startAtRef.current;
    // 重なっていたら一番新しく出た的を優先する
    const candidates = activeTargetsAt(scheduleRef.current, elapsed, hitIdsRef.current)
      .filter((t) => hitTest(t, x, y))
      .sort((a, b) => b.spawnAtMs - a.spawnAtMs);
    const target = candidates[0];
    if (!target) return;
    sfxTap();
    hitIdsRef.current.add(target.id);
    const gained = pointsForHit(target, elapsed);
    scoreRef.current += gained;
    hitsRef.current += 1;
    setScore(scoreRef.current);
    setHits(hitsRef.current);
    setLastGain({ id: target.id, gained, key: elapsed });
    setTargets(activeTargetsAt(scheduleRef.current, elapsed, hitIdsRef.current));
  };

  const shoot = (e: React.PointerEvent<HTMLDivElement>) => {
    if (phase !== "playing") return;
    const area = areaRef.current;
    if (!area) return;
    const rect = area.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    // lib と同じ統一単位（横幅=100）へ変換する。縦も幅で割ることで円判定と一致させる。
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.width) * 100;
    shootAt(x, y);
  };

  const btn: React.CSSProperties = {
    padding: "10px 14px", borderRadius: 10, border: "1px solid rgba(255,255,255,0.18)",
    background: "rgba(255,255,255,0.06)", color: "inherit", cursor: "pointer", fontWeight: 700, minHeight: 44, touchAction: "manipulation",
  };
  const activeBtn: React.CSSProperties = { ...btn, background: "#d8542e", color: "#fff", borderColor: "#d8542e" };

  const accuracy = shots > 0 ? Math.round((hits / shots) * 100) : 0;
  const statusText =
    phase === "finished"
      ? `終了！スコア ${score} ・ 命中 ${hits}/${shots}（${accuracy}%）でした。`
      : phase === "ready"
        ? "スタートを押すと30秒の的あてが始まります。"
        : `残り ${remainSec} 秒 ・ 的は時間が経つと小さく速くなります`;

  const board2d = (
    <>
      <div
        ref={areaRef}
        onPointerDown={shoot}
        role="application"
        aria-label="的あてエリア"
        style={{
          position: "relative", width: "100%", maxWidth: 560, margin: "0 auto",
          aspectRatio: "4 / 3", borderRadius: 16,
          border: "2px solid rgba(255,255,255,0.15)",
          background: "radial-gradient(circle at 50% 40%, rgba(216,84,46,0.10), rgba(255,255,255,0.03) 70%)",
          overflow: "hidden", touchAction: "manipulation",
          cursor: phase === "playing" ? "crosshair" : "default",
          userSelect: "none", WebkitTapHighlightColor: "transparent",
        }}
      >
        {phase === "ready" && (
          <p style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", margin: 0, fontWeight: 700, opacity: 0.75 }}>
            ここに的が現れます
          </p>
        )}
        {targets.map((t) => {
          // 横幅基準の % で円の大きさを決める（縦は aspect-ratio で追従させるため padding 方式は使わず width のみ）
          const sizePct = t.radius * 2;
          // 中心の縦位置は「高さ=75単位」から % へ換算し、判定空間と一致させる
          const topPct = (t.y / AIM_FIELD_HEIGHT) * 100;
          return (
            <div
              key={t.id}
              aria-hidden="true"
              style={{
                position: "absolute",
                left: `${t.x}%`, top: `${topPct}%`,
                width: `${sizePct}%`, aspectRatio: "1 / 1",
                transform: "translate(-50%, -50%)",
                borderRadius: "50%",
                background:
                  t.points >= 30
                    ? "radial-gradient(circle, #fff 0 18%, #ffd23e 19% 45%, #d8542e 46% 100%)"
                    : t.points >= 20
                      ? "radial-gradient(circle, #fff 0 22%, #ff9a3e 23% 55%, #b33a1e 56% 100%)"
                      : "radial-gradient(circle, #fff 0 26%, #e85d4a 27% 60%, #8f2d1a 61% 100%)",
                boxShadow: "0 2px 10px rgba(0,0,0,0.45)",
                pointerEvents: "none",
              }}
            />
          );
        })}
        {lastGain && phase === "playing" && (
          <span key={lastGain.key} style={{ position: "absolute", top: 8, right: 12, pointerEvents: "none" }}>
            <ScorePop amount={lastGain.gained} />
          </span>
        )}
      </div>
    </>
  );

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>エイム</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>エイム</h1>
        <p className="muted">現れた的を、消える前にクリック（タップ）します。30秒で何点稼げるか、命中率とあわせて競います。</p>
      </div>

      <p className="classic-status" role="status">
        スコア {score} ・ ベスト {best} ・ 命中 {hits}/{shots}{shots > 0 ? `（${accuracy}%）` : ""} ・ {statusText}
      </p>

      {/* タイムバー */}
      <div style={{ maxWidth: 560, margin: "0 auto 12px", height: 10, borderRadius: 999, background: "rgba(255,255,255,0.12)", overflow: "hidden" }} aria-hidden="true">
        <div
          style={{
            height: "100%",
            width: phase === "playing" ? `${(remainSec / 30) * 100}%` : phase === "finished" ? "0%" : "100%",
            background: remainSec <= 5 && phase === "playing" ? "#e85d4a" : "#d8542e",
            transition: "width 0.3s linear",
          }}
        />
      </div>

      {webglFailed ? board2d : (
        <div style={{ position: "relative", maxWidth: 560, margin: "0 auto" }}>
          <AimScene3D
            targets={targets}
            onShoot={shootAt}
            onFail={() => setWebglFailed(true)}
            fallback={board2d}
          />
          {lastGain && phase === "playing" && (
            <span key={lastGain.key} style={{ position: "absolute", top: 8, right: 12, pointerEvents: "none" }}>
              <ScorePop amount={lastGain.gained} />
            </span>
          )}
        </div>
      )}

      {phase === "finished" && (
        <div style={{ maxWidth: 560, margin: "16px auto 0" }}>
          <EndScreen
            outcome="finish"
            title="終了！"
            score={score}
            scoreLabel="スコア"
            newBest={resultInfo?.newBest ?? false}
            previousBest={resultInfo && !resultInfo.newBest && resultInfo.prevBest > 0 ? resultInfo.prevBest : null}
            onRetry={start}
            retryLabel="もう一度遊ぶ"
          >
            <p className="muted">
              命中 {hits}/{shots}（{accuracy}%）でした。
            </p>
          </EndScreen>
        </div>
      )}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center", marginTop: 16 }}>
        {phase !== "playing" ? (
          <button type="button" style={activeBtn} onClick={start}>
            {phase === "finished" ? "もう一度遊ぶ" : "スタート（30秒）"}
          </button>
        ) : (
          <button type="button" style={btn} onClick={finish}>やめる</button>
        )}
      </div>
      <p className="muted" style={{ textAlign: "center", fontSize: 13 }}>
        的をクリック / タップで撃つ。基本点は大きい的10点・中20点・小30点、速く当てるほど最大+10のボーナス。
      </p>
    </>
  );
}
