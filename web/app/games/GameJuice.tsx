"use client";
// 全ゲーム共通の演出コンポーネント（終了画面・スコア演出・数字アニメーション）。
// 見た目の動きは globals.css の juice-* クラス（keyframes）に寄せ、ここは構造と
// 動的な値（紙吹雪の配置、カウントアップ）だけを持つ。絵文字は使わない。
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  hitmarkLifetimeMs,
  juiceFlash,
  juiceHit,
  juiceHitmark,
  juiceHitstop,
  juiceShake,
  juiceSquash,
  type HitmarkOptions,
  type JuiceIntensity,
} from "@/lib/juice";
import { useGamesNav } from "./GamesShell";

export type { JuiceIntensity } from "@/lib/juice";

/**
 * 数字を前回の値から目標値へ滑らかに数えるフック。
 * 表示側で Math.round して使う（小数を持つ値なら桁に合わせて整形する）。
 */
export function useAnimatedNumber(value: number, durationMs = 600): number {
  const [display, setDisplay] = useState(value);
  const fromRef = useRef(value);

  useEffect(() => {
    const from = fromRef.current;
    const to = value;
    if (from === to || durationMs <= 0) {
      fromRef.current = to;
      setDisplay(to);
      return;
    }
    let raf = 0;
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplay(from + (to - from) * eased);
      if (t < 1) {
        raf = requestAnimationFrame(step);
      } else {
        fromRef.current = to;
      }
    };
    raf = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(raf);
      fromRef.current = to;
    };
  }, [value, durationMs]);

  return display;
}

/**
 * 手応え層（lib/juice.ts）への React フック。ref を対象要素へ付け、
 * hit / hitstop / shake / flash / hitmark / squash を呼ぶ。
 * 「当たった瞬間」に hit(intensity) を呼ぶのが基本形（#003/#047/#130）。
 */
export function useJuice<T extends HTMLElement = HTMLDivElement>() {
  const ref = useRef<T | null>(null);
  const hit = useCallback((intensity: JuiceIntensity = 2, opts?: HitmarkOptions & { power?: number }) => {
    juiceHit(ref.current, intensity, opts);
  }, []);
  const hitstop = useCallback((intensity: JuiceIntensity = 2, power = 1) => {
    juiceHitstop(ref.current, intensity, power);
  }, []);
  const shake = useCallback((intensity: JuiceIntensity = 2) => {
    juiceShake(ref.current, intensity);
  }, []);
  const flash = useCallback(() => {
    juiceFlash(ref.current);
  }, []);
  const hitmark = useCallback((intensity: JuiceIntensity = 2, opts?: HitmarkOptions) => {
    juiceHitmark(ref.current, intensity, opts);
  }, []);
  const squash = useCallback((amount = 0.22) => {
    juiceSquash(ref.current, amount);
  }, []);
  return { ref, hit, hitstop, shake, flash, hitmark, squash };
}

export type JuiceHitProps = {
  /** 値を変える（増やす）とその位置にヒットマークを1回出す。0 は無効。 */
  burstKey: number;
  /** 強さ 1..3。 */
  intensity?: JuiceIntensity;
  /** 親要素内での位置（%、0〜100）。親は position: relative にすること。 */
  xPct?: number;
  yPct?: number;
  /** 連続ヒット中なら寿命を短くする。 */
  continuous?: boolean;
};

/**
 * ヒットマークの宣言的コンポーネント。burstKey が変わるたびに
 * 衝撃波＋火花（div/span のみ、絵文字なし）を出し、寿命が来たら消える。
 */
export function JuiceHit({ burstKey, intensity = 2, xPct = 50, yPct = 50, continuous = false }: JuiceHitProps) {
  const [visibleKey, setVisibleKey] = useState(0);
  useEffect(() => {
    if (burstKey === 0) return;
    setVisibleKey(burstKey);
    const t = setTimeout(() => setVisibleKey(0), hitmarkLifetimeMs(continuous) + 40);
    return () => clearTimeout(t);
  }, [burstKey, continuous]);
  if (visibleKey === 0) return null;
  return (
    <span
      className={`juice-hitmark juice-hitmark-${intensity}`}
      style={{ "--juice-mark-x": `${xPct}%`, "--juice-mark-y": `${yPct}%` } as React.CSSProperties}
      aria-hidden="true"
    >
      <span className="juice-hitmark-ring" />
      {[24, 114, 204, 294].map((deg) => (
        <span key={deg} className="juice-hitmark-spark" style={{ "--juice-spark-angle": `${deg}deg` } as React.CSSProperties} />
      ))}
    </span>
  );
}

/** スコア加算時に「+N」が浮かんで消える表示。key を変えて再マウントすると再演する。 */
export function ScorePop({ amount }: { amount: number }) {
  return (
    <span className="juice-score-pop" aria-hidden="true">
      {amount >= 0 ? `+${amount}` : `${amount}`}
    </span>
  );
}

export type EndScreenOutcome = "win" | "lose" | "draw" | "finish";

const OUTCOME_TITLES: Record<EndScreenOutcome, string> = {
  win: "勝利！",
  lose: "敗北…",
  draw: "引き分け",
  finish: "終了",
};

const CONFETTI_COLORS = ["#e6b93d", "#39bfe8", "#e36a61", "#5dbb63", "#9b7ede", "#f2f6f9"];

type ConfettiPiece = {
  left: number;
  delay: number;
  duration: number;
  color: string;
  rotate: number;
  width: number;
};

function makeConfetti(count: number): ConfettiPiece[] {
  return Array.from({ length: count }, (_, i) => ({
    left: (i + Math.random()) * (100 / count),
    delay: Math.random() * 0.45,
    duration: 1.7 + Math.random() * 1.1,
    color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
    rotate: Math.floor(Math.random() * 360),
    width: 6 + Math.floor(Math.random() * 4),
  }));
}

export type EndScreenProps = {
  /** 結果の種類。タイトルの既定文と紙吹雪（win のみ）を決める。 */
  outcome: EndScreenOutcome;
  /** 結果タイトルを上書きしたいときだけ指定する。 */
  title?: string;
  /** スコア（任意）。表示時はカウントアップする。 */
  score?: number;
  /** スコアのラベル。既定は「スコア」。 */
  scoreLabel?: string;
  /** ベスト更新かどうか。true なら「ベスト更新」バッジを出す。 */
  newBest?: boolean;
  /** 前回ベスト（任意）。newBest でないときに「これまでのベスト」として出す。 */
  previousBest?: number | null;
  /** 「もう一度」ボタンの動作。 */
  onRetry: () => void;
  /** 「もう一度」ボタンの文言を変えたいときだけ指定する。 */
  retryLabel?: string;
  /** ゲーム固有の詳細（内訳・統計など）。 */
  children?: ReactNode;
};

/** 全ゲーム共通の終了画面。勝利時のみ紙吹雪（色付き div の落下）を出す。 */
export function EndScreen({
  outcome,
  title,
  score,
  scoreLabel = "スコア",
  newBest,
  previousBest,
  onRetry,
  retryLabel = "もう一度",
  children,
}: EndScreenProps) {
  const { prefix } = useGamesNav();
  const animatedScore = useAnimatedNumber(score ?? 0, 700);
  const [confetti] = useState<ConfettiPiece[]>(() => (outcome === "win" ? makeConfetti(26) : []));

  return (
    <section className="juice-end juice-slide" aria-label="結果">
      {confetti.length > 0 && (
        <div className="juice-confetti" aria-hidden="true">
          {confetti.map((p, i) => (
            <span
              key={i}
              className="juice-confetti-piece"
              style={{
                left: `${p.left}%`,
                width: p.width,
                background: p.color,
                transform: `rotate(${p.rotate}deg)`,
                animationDelay: `${p.delay}s`,
                animationDuration: `${p.duration}s`,
              }}
            />
          ))}
        </div>
      )}
      <h2 className="juice-end-title">{title ?? OUTCOME_TITLES[outcome]}</h2>
      {score !== undefined && (
        <p className="juice-end-score">
          <span className="juice-end-score-label">{scoreLabel}</span>
          {Math.round(animatedScore)}
        </p>
      )}
      {newBest ? (
        <p className="juice-end-best juice-pulse">ベスト更新</p>
      ) : (
        previousBest !== undefined &&
        previousBest !== null && <p className="muted">これまでのベスト: {previousBest}</p>
      )}
      {children}
      <div className="juice-end-actions">
        <button type="button" className="classic-btn" onClick={onRetry}>
          {retryLabel}
        </button>
        <Link className="classic-btn" href={`${prefix}/games`}>
          ゲーム一覧へ
        </Link>
      </div>
    </section>
  );
}
