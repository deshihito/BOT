"use client";
// クレーンゲーム。ロジックは lib/cranegame.ts（距離だけの決定的判定）。
// クレーンの往復は requestAnimationFrame で stepCrane を進めて描く。
// 取れた景品の累計は端末内（localStorage）にだけ保存する。
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  createCraneGame,
  stepCrane,
  stopCrane,
  CRANE_DROP_MS,
  type CraneState,
} from "@/lib/cranegame";
import { useGamesNav } from "../GamesShell";

const COLLECTION_KEY = "ago-cranegame-collection";

function newGame(): CraneState {
  return createCraneGame(Date.now() % 2147483647);
}

export default function CraneGameClient() {
  const { prefix } = useGamesNav();
  const [state, setState] = useState<CraneState>(() => newGame());
  const [collected, setCollected] = useState(0);
  const countedSeedRef = useRef<number | null>(null);

  // クレーンの往復・降下のアニメーション。
  useEffect(() => {
    if (state.phase === "done") return;
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = now - last;
      last = now;
      setState((s) => stepCrane(s, dt));
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [state.phase]);

  useEffect(() => {
    try {
      const saved = Number(window.localStorage.getItem(COLLECTION_KEY));
      setCollected(Number.isFinite(saved) && saved > 0 ? Math.floor(saved) : 0);
    } catch {
      setCollected(0);
    }
  }, []);

  // 取れたらコレクションを1回だけ加算する。
  useEffect(() => {
    if (state.phase !== "done" || !state.result || state.result.prizeId === null) return;
    if (countedSeedRef.current === state.seed) return;
    countedSeedRef.current = state.seed;
    setCollected((c) => {
      const next = c + 1;
      try {
        window.localStorage.setItem(COLLECTION_KEY, String(next));
      } catch {
        // 保存失敗はプレイに影響しない。
      }
      return next;
    });
  }, [state.phase, state.result, state.seed]);

  const restart = () => {
    countedSeedRef.current = null;
    setState(newGame());
  };

  const wonPrize =
    state.result && state.result.prizeId !== null
      ? state.prizes.find((p) => p.id === state.result?.prizeId) ?? null
      : null;

  const statusText =
    state.phase === "aimX"
      ? "クレーンが左右に動いています。「とめる」で横の位置を決めよう。"
      : state.phase === "aimY"
        ? "次は奥行き。「とめる」で止めた場所に降りていきます。"
        : state.phase === "dropping"
          ? "クレーンが降りていきます…。"
          : wonPrize
            ? `🎉 ${wonPrize.emoji} ${wonPrize.name} が取れた！`
            : `残念、あと少し（中心まで ${state.result?.dist ?? "—"} ）でした。`;

  // クレーンの表示位置。aimX の間は上のレール上、aimY 以降は奥行きに合わせる。
  // dropping の間は爪が景品の高さまで降りて戻る。
  const dropRatio = state.phase === "dropping" ? state.dropElapsedMs / CRANE_DROP_MS : 0;
  const dropDip = state.phase === "dropping" ? Math.sin(dropRatio * Math.PI) * 7 : 0;
  const craneTopPct = (state.phase === "aimX" ? 4 : state.craneY) + dropDip;
  const clawOpen = state.phase === "dropping" && dropRatio > 0.7 ? 4 : 18;

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>クレーンゲーム</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>クレーンゲーム</h1>
        <p className="muted">
          「とめる」ボタンで、クレーンの横の動きと奥行きの動きを1回ずつ止めます。
        </p>
      </div>

      <div className="classic-controls" role="group" aria-label="操作">
        <button
          type="button"
          className="classic-btn classic-btn-active"
          disabled={state.phase !== "aimX" && state.phase !== "aimY"}
          onClick={() => setState((s) => stopCrane(s))}
          style={{ minWidth: 140, minHeight: 48, fontSize: 17, fontWeight: 700 }}
        >
          {state.phase === "aimX" ? "とめる（横）" : state.phase === "aimY" ? "とめる（奥行き）" : "とめる"}
        </button>
        <button type="button" className="classic-btn" onClick={restart}>
          もう一度
        </button>
      </div>

      <p className="classic-status" role="status">
        取れた景品の累計 {collected} 個 ・ {statusText}
      </p>

      <div
        role="img"
        aria-label="クレーンゲームの台"
        style={{
          position: "relative",
          width: "100%",
          maxWidth: 560,
          aspectRatio: "5 / 4",
          margin: "0 auto",
          borderRadius: 14,
          border: "3px solid #8a6d3b",
          background: "linear-gradient(180deg, #fdf3d8 0%, #f7e3ae 100%)",
          overflow: "hidden",
          touchAction: "manipulation",
        }}
      >
        {/* 奥行きのガイド */}
        <div
          aria-hidden
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: "50%",
            borderTop: "2px dashed rgba(138,109,59,0.35)",
          }}
        />
        {/* 景品 */}
        {state.prizes.map((p) => {
          const got = state.phase === "done" && wonPrize?.id === p.id;
          return (
            <div
              key={p.id}
              aria-hidden
              style={{
                position: "absolute",
                left: `${p.x}%`,
                top: `${p.y}%`,
                transform: `translate(-50%, -50%) scale(${got ? 1.25 : 1})`,
                width: `${p.radius * 2}%`,
                aspectRatio: "1",
                borderRadius: "50%",
                background: got ? "#ffe082" : "rgba(255,255,255,0.65)",
                border: "2px solid rgba(138,109,59,0.45)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: "clamp(18px, 6vw, 30px)",
                transition: "transform 200ms ease",
              }}
            >
              {p.emoji}
            </div>
          );
        })}
        {/* クレーンのレール */}
        <div
          aria-hidden
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: "3%",
            height: 6,
            background: "#6b543a",
            borderRadius: 3,
          }}
        />
        {/* 照準の縦線（aimY 以降） */}
        {state.phase !== "aimX" && (
          <div
            aria-hidden
            style={{
              position: "absolute",
              top: 0,
              bottom: 0,
              left: `${state.craneX}%`,
              borderLeft: "2px dashed rgba(198,40,40,0.5)",
            }}
          />
        )}
        {/* クレーン本体（キャリッジ＋爪を CSS で描く） */}
        <div
          aria-hidden
          style={{
            position: "absolute",
            left: `${state.craneX}%`,
            top: `${craneTopPct}%`,
            transform: "translate(-50%, -50%)",
            zIndex: 2,
            width: 36,
          }}
        >
          <div
            style={{
              width: 36,
              height: 12,
              background: "#37474f",
              borderRadius: 4,
              border: "2px solid #263238",
            }}
          />
          <div style={{ display: "flex", justifyContent: "space-between", width: 30, margin: "0 auto" }}>
            <div
              style={{
                width: 5,
                height: 17,
                background: "#37474f",
                borderRadius: 3,
                transform: `rotate(${clawOpen}deg)`,
                transformOrigin: "top center",
                transition: "transform 150ms ease",
              }}
            />
            <div
              style={{
                width: 5,
                height: 17,
                background: "#37474f",
                borderRadius: 3,
                transform: `rotate(${-clawOpen}deg)`,
                transformOrigin: "top center",
                transition: "transform 150ms ease",
              }}
            />
          </div>
        </div>
        {/* 降下位置のマーカー */}
        {state.phase === "done" && state.grabX !== null && state.grabY !== null && (
          <div
            aria-hidden
            style={{
              position: "absolute",
              left: `${state.grabX}%`,
              top: `${state.grabY}%`,
              transform: "translate(-50%, -50%)",
              fontSize: 20,
              color: "#c62828",
              fontWeight: 900,
              zIndex: 3,
            }}
          >
            ✕
          </div>
        )}
      </div>

      <p className="muted" style={{ textAlign: "center", marginTop: 10 }}>
        景品は全部で{state.prizes.length}個です。
      </p>
    </>
  );
}
