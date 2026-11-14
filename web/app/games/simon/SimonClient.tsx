"use client";
// サイモン（色と音の記憶ゲーム）。光る順番を覚えて同じ順に押す。
// 音は WebAudio で色ごとに変える。音が出せない環境でも色の点滅だけで成立させる。
// 端末内で完結し、ベストラウンドは localStorage の ago-simon-best に保存する。
import Link from "next/link";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";

const SimonScene3D = dynamic(() => import("./SimonScene3D"), { ssr: false });
import { sfxCorrect, sfxTap } from "@/lib/sfx";
import { EndScreen, GoalBand } from "../GameJuice";
import { useGamesNav } from "../GamesShell";

const BEST_KEY = "ago-simon-best";

type Phase = "idle" | "showing" | "input" | "gameover";

const PADS = [
  { name: "みどり", color: "#2fbf71", dark: "#1e7f4c", freq: 329.63 },
  { name: "あか", color: "#ef476f", dark: "#a12c49", freq: 261.63 },
  { name: "きいろ", color: "#f2c531", dark: "#a8861a", freq: 392.0 },
  { name: "あお", color: "#4361ee", dark: "#2b3f9e", freq: 440.0 },
] as const;

function loadBest(): number {
  try {
    const raw = localStorage.getItem(BEST_KEY);
    const n = raw === null ? 0 : Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

function randomPad(): number {
  return Math.floor(Math.random() * PADS.length);
}

export default function SimonClient() {
  const { prefix } = useGamesNav();
  const [phase, setPhase] = useState<Phase>("idle");
  const [webglFailed, setWebglFailed] = useState(false);
  const [sequence, setSequence] = useState<number[]>([]);
  const [lit, setLit] = useState<number | null>(null);
  const [pressed, setPressed] = useState<number | null>(null);
  const [best, setBest] = useState(0);
  const [message, setMessage] = useState("スタートを押すと、光る順番が流れます。");
  const [result, setResult] = useState<{ cleared: number; newBest: boolean; prevBest: number } | null>(null);
  const inputIndexRef = useRef(0);
  const timersRef = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  const audioRef = useRef<AudioContext | null>(null);
  const runIdRef = useRef(0);
  const sequenceRef = useRef<number[]>([]);
  sequenceRef.current = sequence;

  useEffect(() => {
    setBest(loadBest());
    return () => {
      runIdRef.current++;
      for (const t of timersRef.current) clearTimeout(t);
      timersRef.current = [];
    };
  }, []);

  const schedule = useCallback((fn: () => void, ms: number) => {
    const id = setTimeout(fn, ms);
    timersRef.current.push(id);
  }, []);

  const playTone = useCallback((pad: number, durationMs = 320) => {
    try {
      const AC: typeof AudioContext | undefined =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      if (!audioRef.current) audioRef.current = new AC();
      const ctx = audioRef.current;
      if (ctx.state === "suspended") void ctx.resume();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = PADS[pad]?.freq ?? 330;
      const now = ctx.currentTime;
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.22, now + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + durationMs / 1000);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + durationMs / 1000 + 0.05);
    } catch {
      // 音が出せなくても点滅だけでゲームは成立させる
    }
  }, []);

  const playErrorTone = useCallback(() => {
    try {
      const AC: typeof AudioContext | undefined =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      if (!audioRef.current) audioRef.current = new AC();
      const ctx = audioRef.current;
      if (ctx.state === "suspended") void ctx.resume();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sawtooth";
      osc.frequency.value = 130;
      const now = ctx.currentTime;
      gain.gain.setValueAtTime(0.15, now);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.5);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.55);
    } catch {
      // 無音でもよい
    }
  }, []);

  const showSequence = useCallback(
    (seq: number[]) => {
      const runId = ++runIdRef.current;
      setPhase("showing");
      setLit(null);
      setMessage(`ラウンド ${seq.length}: 光る順番を覚えてください…`);
      const onMs = Math.max(320, 560 - seq.length * 12);
      const gapMs = 170;
      seq.forEach((pad, i) => {
        schedule(() => {
          if (runIdRef.current !== runId) return;
          setLit(pad);
          playTone(pad, onMs);
        }, 550 + i * (onMs + gapMs));
        schedule(() => {
          if (runIdRef.current !== runId) return;
          setLit((cur) => (cur === pad ? null : cur));
        }, 550 + i * (onMs + gapMs) + onMs);
      });
      schedule(
        () => {
          if (runIdRef.current !== runId) return;
          setLit(null);
          inputIndexRef.current = 0;
          setPhase("input");
          setMessage(`ラウンド ${seq.length}: 同じ順番で押してください（0 / ${seq.length}）`);
        },
        550 + seq.length * (onMs + gapMs) + 120,
      );
    },
    [playTone, schedule],
  );

  const start = useCallback(() => {
    sfxTap();
    for (const t of timersRef.current) clearTimeout(t);
    timersRef.current = [];
    // 押下表示の消灯タイマーも消えるため、pressed を明示的にリセットする（常時点灯防止）。
    setPressed(null);
    setLit(null);
    setResult(null);
    const seq = [randomPad()];
    setSequence(seq);
    inputIndexRef.current = 0;
    showSequence(seq);
  }, [showSequence]);

  const saveBest = useCallback((clearedRounds: number) => {
    setBest((prev) => {
      const next = Math.max(prev, clearedRounds);
      if (next !== prev) {
        try {
          localStorage.setItem(BEST_KEY, String(next));
        } catch {
          // 保存できなくてもよい
        }
      }
      return next;
    });
  }, []);

  const onPad = (pad: number) => {
    if (phase !== "input") return;
    const seq = sequenceRef.current;
    playTone(pad, 260);
    setPressed(pad);
    schedule(() => setPressed((cur) => (cur === pad ? null : cur)), 220);
    const expected = seq[inputIndexRef.current];
    if (pad !== expected) {
      runIdRef.current++;
      playErrorTone();
      const cleared = Math.max(0, seq.length - 1);
      // 保存（saveBest）前のベストで更新判定を控える。
      setResult({ cleared, newBest: cleared > best, prevBest: best });
      saveBest(cleared);
      setPhase("gameover");
      setMessage(
        `まちがいです。ラウンド ${seq.length} で終了しました（正解は「${PADS[expected]?.name ?? ""}」でした）。`,
      );
      return;
    }
    inputIndexRef.current++;
    if (inputIndexRef.current >= seq.length) {
      sfxCorrect();
      saveBest(seq.length);
      setPhase("showing");
      setMessage(`ラウンド ${seq.length} クリア！ 次のラウンドへ…`);
      const nextSeq = [...seq, randomPad()];
      schedule(() => {
        setSequence(nextSeq);
        showSequence(nextSeq);
      }, 800);
    } else {
      setMessage(`ラウンド ${seq.length}: 同じ順番で押してください（${inputIndexRef.current} / ${seq.length}）`);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const map: Record<string, number> = { "1": 0, "2": 1, "3": 2, "4": 3 };
      const pad = map[e.key];
      if (pad === undefined) return;
      e.preventDefault();
      onPad(pad);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // onPad はフェーズとシーケンス参照に依存するが、キーは最新の状態で判定させたいため毎レンダー張り替える
    // eslint-disable-next-line react-hooks/exhaustive-deps
  });

  const round = sequence.length;
  const padStyle = (index: number): CSSProperties => {
    const pad = PADS[index];
    const isLit = lit === index || pressed === index;
    return {
      aspectRatio: "1",
      width: "100%",
      border: "none",
      borderRadius: index === 0 ? "120px 18px 18px 18px" : index === 1 ? "18px 120px 18px 18px" : index === 2 ? "18px 18px 18px 120px" : "18px 18px 120px 18px",
      background: isLit ? pad.color : pad.dark,
      opacity: isLit ? 1 : 0.82,
      transform: isLit ? "scale(1.03)" : "scale(1)",
      transition: "background 80ms ease, opacity 80ms ease, transform 80ms ease",
      boxShadow: isLit ? `0 0 0 4px #fff, 0 0 28px ${pad.color}` : "inset 0 0 0 2px rgba(0,0,0,0.2)",
      cursor: phase === "input" ? "pointer" : "default",
      touchAction: "manipulation",
      fontSize: 15,
      fontWeight: 800,
      color: "#fff",
      textShadow: "0 1px 3px rgba(0,0,0,0.5)",
    };
  };

  const board2d = (
    <>
      <div
        className={phase === "gameover" ? "juice-shake" : undefined}
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
          gap: 12,
          width: "min(88vw, 380px)",
          margin: "8px auto 0",
          padding: 14,
          borderRadius: "50%",
          background: "#20242e",
          boxShadow: "0 8px 28px rgba(0,0,0,0.25)",
        }}
        role="group"
        aria-label="サイモンのボタン"
      >
        {PADS.map((pad, i) => (
          <button
            key={pad.name}
            type="button"
            style={padStyle(i)}
            disabled={phase !== "input"}
            aria-label={`${pad.name}（${i + 1}）`}
            onClick={() => onPad(i)}
          >
            {pad.name}
          </button>
        ))}
      </div>

    </>
  );

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>サイモン</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>サイモン</h1>
        <p className="muted">光る色と音の順番を覚えて、同じ順番で押していく記憶ゲーム。ラウンドごとに1つずつ長くなります。</p>
      </div>

      <p className="classic-status" role="status">
        ラウンド {round === 0 ? "—" : round} ・ ベスト {best} ラウンド ・ {message}
      </p>
      <div style={{ maxWidth: 420, margin: "8px auto 0" }}>
        <GoalBand current={phase === "gameover" && result ? result.cleared : Math.max(0, round - 1)} best={best} unit=" ラウンド" />
      </div>

{webglFailed ? board2d : (
        <div style={{ maxWidth: 420, margin: "0 auto" }}>
          <SimonScene3D
            lit={lit}
            pressed={pressed}
            onPad={onPad}
            onFail={() => setWebglFailed(true)}
            fallback={board2d}
          />
        </div>
      )}
      <div className="classic-controls" style={{ justifyContent: "center" }}>
        <button type="button" className="classic-btn classic-btn-active" onClick={start}>
          {phase === "idle" ? "スタート" : "もう一度"}
        </button>
      </div>
      {phase === "input" ? (
        <p className="classic-status" style={{ justifyContent: "center" }}>
          キー 1〜4 でも押せます。
        </p>
      ) : phase === "idle" ? (
        <p className="classic-status" style={{ justifyContent: "center" }}>
          音が出ない環境でも、色の点滅だけで遊べます。
        </p>
      ) : null}

      {phase === "gameover" && result ? (
        <div style={{ maxWidth: 420, margin: "16px auto 0" }}>
          <EndScreen
            outcome="lose"
            sound
            title="まちがい…"
            score={result.cleared}
            scoreLabel="クリアしたラウンド"
            newBest={result.newBest}
            previousBest={result.newBest ? null : result.prevBest > 0 ? result.prevBest : null}
            onRetry={start}
          >
            <p className="muted">ラウンド {round} まで進みました。</p>
          </EndScreen>
        </div>
      ) : null}
    </>
  );
}
