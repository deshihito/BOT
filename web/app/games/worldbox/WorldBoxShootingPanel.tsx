"use client";
import { useEffect, useRef, useState } from "react";
import { playWbSe } from "@/lib/worldbox/sound";

type TargetKind = "crown" | "lantern" | "doll" | "duck" | "bomb";

type TargetItem = {
  id: number;
  rail: 0 | 1 | 2;
  x: number; // percentage 0..100
  dir: 1 | -1;
  speed: number; // pct per sec
  kind: TargetKind;
  emoji: string;
  points: number;
};

const TARGET_DEF: Record<TargetKind, { emoji: string; points: number }> = {
  crown: { emoji: "👑", points: 180 },
  lantern: { emoji: "🏮", points: 110 },
  doll: { emoji: "🧸", points: 90 },
  duck: { emoji: "🦆", points: 70 },
  bomb: { emoji: "💣", points: -120 },
};

const ROUND_SEC = 30;
const CLIP_SIZE = 6;

const wrap: React.CSSProperties = {
  position: "absolute",
  left: "50%",
  top: "50%",
  transform: "translate(-50%, -50%)",
  width: "min(560px, calc(100% - 20px))",
  maxHeight: "calc(100% - 24px)",
  overflowY: "auto",
  padding: 14,
  borderRadius: 14,
  background: "rgba(12,14,22,0.95)",
  border: "1px solid rgba(255,140,95,0.35)",
  color: "#f6f5f9",
  zIndex: 6,
  boxShadow: "0 14px 40px rgba(0,0,0,0.6)",
  boxSizing: "border-box",
};

const btn: React.CSSProperties = {
  minHeight: 34,
  padding: "4px 12px",
  borderRadius: 9,
  border: "1px solid rgba(255,255,255,0.25)",
  background: "rgba(255,255,255,0.1)",
  color: "#fff",
  fontSize: 12,
  cursor: "pointer",
};

function makeTarget(id: number, rail: 0 | 1 | 2): TargetItem {
  const roll = Math.random();
  let kind: TargetKind = "duck";
  if (rail === 0) kind = roll < 0.45 ? "crown" : roll < 0.8 ? "lantern" : "bomb";
  else if (rail === 1) kind = roll < 0.45 ? "doll" : roll < 0.82 ? "lantern" : "bomb";
  else kind = roll < 0.65 ? "duck" : roll < 0.85 ? "doll" : "bomb";

  const def = TARGET_DEF[kind];
  const dir: 1 | -1 = rail === 1 ? -1 : 1;
  const baseSpeed = rail === 0 ? 34 : rail === 1 ? 25 : 19;
  return {
    id,
    rail,
    x: dir === 1 ? -8 : 108,
    dir,
    speed: baseSpeed + Math.random() * 12,
    kind,
    emoji: def.emoji,
    points: def.points,
  };
}

export default function WorldBoxShootingPanel({
  bestScore,
  onRoundFinish,
  onClose,
}: {
  bestScore: number;
  onRoundFinish: (score: number) => void;
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<"ready" | "playing" | "done">("ready");
  const [timeLeft, setTimeLeft] = useState(ROUND_SEC);
  const [score, setScore] = useState(0);
  const [ammo, setAmmo] = useState(CLIP_SIZE);
  const [combo, setCombo] = useState(0);
  const [targets, setTargets] = useState<TargetItem[]>([]);
  const [feedback, setFeedback] = useState("「スタート」で30秒間の射的スタート！");

  const nextIdRef = useRef(1);
  const scoreRef = useRef(0);
  scoreRef.current = score;

  const startGame = () => {
    playWbSe("open");
    setScore(0);
    scoreRef.current = 0;
    setCombo(0);
    setAmmo(CLIP_SIZE);
    setTimeLeft(ROUND_SEC);
    setFeedback("的をクリック！ 💣爆弾は減点 / 弾切れ時はリロード！");
    const initial: TargetItem[] = [];
    for (const rail of [0, 1, 2] as const) {
      for (let k = 0; k < 2; k++) {
        const t = makeTarget(nextIdRef.current++, rail);
        t.x = 20 + k * 45;
        initial.push(t);
      }
    }
    setTargets(initial);
    setPhase("playing");
  };

  useEffect(() => {
    if (phase !== "playing") return;
    let last = performance.now();
    let spawnAcc = 0;
    let raf = 0;
    const step = (now: number) => {
      const dt = Math.min(0.08, (now - last) / 1000);
      last = now;
      spawnAcc += dt;
      setTargets((prev) => {
        const moved = prev
          .map((t) => ({ ...t, x: t.x + t.dir * t.speed * dt }))
          .filter((t) => t.x >= -14 && t.x <= 114);
        if (spawnAcc >= 0.65 && moved.length < 9) {
          spawnAcc = 0;
          const rail = Math.floor(Math.random() * 3) as 0 | 1 | 2;
          moved.push(makeTarget(nextIdRef.current++, rail));
        }
        return moved;
      });
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [phase]);

  useEffect(() => {
    if (phase !== "playing") return;
    const id = window.setInterval(() => {
      setTimeLeft((prev) => {
        if (prev <= 1) {
          setPhase("done");
          playWbSe("success");
          onRoundFinish(scoreRef.current);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => window.clearInterval(id);
  }, [phase, onRoundFinish]);

  const reload = () => {
    if (phase !== "playing") return;
    playWbSe("click");
    setAmmo(CLIP_SIZE);
    setFeedback("コルク弾をリロード！");
  };

  const shootTarget = (target: TargetItem) => {
    if (phase !== "playing") return;
    if (ammo <= 0) {
      playWbSe("error");
      setFeedback("弾切れ！リロードボタンを押してね");
      return;
    }
    setAmmo((a) => a - 1);
    setTargets((prev) => prev.filter((t) => t.id !== target.id));
    if (target.kind === "bomb") {
      playWbSe("error");
      setCombo(0);
      setScore((s) => Math.max(0, s + target.points));
      setFeedback("💥 爆弾に命中！ -120点 (コンボリセット)");
    } else {
      const nextCombo = combo + 1;
      const bonus = Math.min(100, (nextCombo - 1) * 15);
      const gained = target.points + bonus;
      playWbSe(target.kind === "crown" ? "coin" : "hit");
      setCombo(nextCombo);
      setScore((s) => s + gained);
      setFeedback(`${target.emoji} 命中！ +${gained}点 (${nextCombo}コンボ)`);
    }
  };

  const missShot = () => {
    if (phase !== "playing") return;
    if (ammo <= 0) {
      playWbSe("error");
      setFeedback("弾切れ！リロードボタンを押してね");
      return;
    }
    playWbSe("swing");
    setAmmo((a) => a - 1);
    setCombo(0);
    setFeedback("空振り…");
  };

  const rankLabel = score >= 2200 ? "S" : score >= 1400 ? "A" : score >= 750 ? "B" : "C";

  return (
    <div style={wrap} className="wb-panel">
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
        <strong style={{ fontSize: 15 }}>🎯 縁日カーニバル射的場</strong>
        <span style={{ fontSize: 12, color: "#ffd88a" }}>最高 {bestScore} 点</span>
        <span style={{ flex: 1 }} />
        <button type="button" style={btn} onClick={onClose}>
          閉じる
        </button>
      </div>

      <div
        style={{
          display: "flex",
          gap: 10,
          alignItems: "center",
          fontSize: 13,
          marginBottom: 8,
          flexWrap: "wrap",
        }}
      >
        <span>
          ⏱ 残り <strong>{timeLeft}s</strong>
        </span>
        <span>
          🏆 得点 <strong>{score}</strong>
        </span>
        <span>
          🔥 コンボ <strong>{combo}</strong>
        </span>
        <span>
          🍾 残弾{" "}
          <strong>
            {"●".repeat(ammo)}
            {"○".repeat(CLIP_SIZE - ammo)}
          </strong>
        </span>
        <span style={{ flex: 1 }} />
        {phase === "playing" && (
          <button
            type="button"
            onClick={reload}
            style={{
              ...btn,
              background: ammo === 0 ? "rgba(255,180,50,0.85)" : "rgba(255,255,255,0.14)",
              color: ammo === 0 ? "#111" : "#fff",
              fontWeight: 700,
            }}
          >
            🔄 リロード
          </button>
        )}
      </div>

      <div
        onClick={missShot}
        style={{
          position: "relative",
          height: 210,
          borderRadius: 12,
          overflow: "hidden",
          background: "linear-gradient(180deg, #271a1a 0%, #3a231c 100%)",
          border: "2px solid rgba(255,190,120,0.35)",
          cursor: phase === "playing" ? "crosshair" : "default",
          userSelect: "none",
        }}
      >
        {[0, 1, 2].map((rail) => (
          <div
            key={rail}
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              top: 52 + rail * 62,
              height: 6,
              background: "rgba(180,125,75,0.55)",
              borderTop: "1px solid rgba(255,220,170,0.25)",
            }}
          />
        ))}
        {targets.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              shootTarget(t);
            }}
            style={{
              position: "absolute",
              left: `${t.x}%`,
              top: 16 + t.rail * 62,
              transform: "translateX(-50%)",
              width: 40,
              height: 40,
              borderRadius: 10,
              border: "1px solid rgba(255,255,255,0.22)",
              background:
                t.kind === "crown"
                  ? "rgba(255,210,60,0.25)"
                  : t.kind === "bomb"
                    ? "rgba(220,60,60,0.22)"
                    : "rgba(255,255,255,0.12)",
              fontSize: 22,
              lineHeight: 1,
              cursor: "crosshair",
              padding: 0,
            }}
          >
            {t.emoji}
          </button>
        ))}

        {phase !== "playing" && (
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              position: "absolute",
              inset: 0,
              background: "rgba(8,10,16,0.78)",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 10,
              padding: 16,
              textAlign: "center",
            }}
          >
            {phase === "done" ? (
              <>
                <div style={{ fontSize: 18, fontWeight: 800 }}>
                  タイムアップ！ ランク <span style={{ color: "#ffd84d" }}>{rankLabel}</span>
                </div>
                <div style={{ fontSize: 14 }}>最終スコア：{score} 点</div>
              </>
            ) : (
              <div style={{ fontSize: 13, color: "#ffe3ba" }}>
                王冠👑=180 / 提灯🏮=110 / 人形🧸=90 / アヒル🦆=70 / 爆弾💣=-120
              </div>
            )}
            <button
              type="button"
              onClick={startGame}
              style={{
                ...btn,
                background: "linear-gradient(135deg, #f07b3f, #d94a38)",
                fontWeight: 800,
                padding: "8px 20px",
              }}
            >
              {phase === "done" ? "もう一回遊ぶ" : "スタート！"}
            </button>
          </div>
        )}
      </div>

      <div style={{ marginTop: 8, fontSize: 12, color: "#f6d7a7" }} role="status">
        {feedback}
      </div>
    </div>
  );
}
