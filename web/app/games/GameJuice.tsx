"use client";
// 全ゲーム共通の演出コンポーネント（終了画面・スコア演出・数字アニメーション）。
// 見た目の動きは globals.css の juice-* クラス（keyframes）に寄せ、ここは構造と
// 動的な値（紙吹雪の配置、カウントアップ）だけを持つ。絵文字は使わない。
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  endFanfare,
  goalBandState,
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
import { sfxCorrect, sfxJingle, sfxKo, sfxLose, sfxWin } from "@/lib/sfx";
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
  /**
   * 終了ファンファーレを EndScreen 側で鳴らすかどうか（v2、既定 false）。
   * 既存タイトルの大半は自前で勝敗ジングルを鳴らしているため、既定では
   * 鳴らさず、二重再生を避ける。自前ジングルが無いタイトルだけ true にする。
   * 種別は endFanfare() のルール（勝利+ベスト更新で KO 級に格上げ）。
   */
  sound?: boolean;
  /**
   * 敗北時にも紙吹雪を混ぜる（対戦系で勝者を祝う見せ方、#095）。
   * 既定 false（自滅系の敗北で祝わない）。
   */
  confettiOnLose?: boolean;
  /** ゲーム固有の詳細（内訳・統計など）。 */
  children?: ReactNode;
};

/** ファンファーレ種別 → 実際の SE 呼び出し。 */
function playEndFanfare(outcome: EndScreenOutcome, newBest: boolean): void {
  switch (endFanfare(outcome, newBest)) {
    case "ko":
      sfxKo();
      break;
    case "win":
      sfxWin();
      break;
    case "lose":
      sfxLose();
      break;
    case "draw":
      sfxJingle(false);
      break;
    case "finish":
      sfxCorrect();
      break;
  }
}

/**
 * 全ゲーム共通の終了画面（v2）。
 * - 勝利: 紙吹雪（ベスト更新時は増量）。敗北: 短く派手に、小シェイク＋
 *   フラッシュで「やられた」を即認識させる（演出は短く、冷める前に
 *   操作を返す #116）。confettiOnLose で敗北時も紙吹雪を混ぜられる。
 * - リトライ: ボタンに加え R キーでも即リトライ（入力欄フォーカス時は無効）。
 * - sound=true のときだけ終了ファンファーレを鳴らす（既定は二重再生防止で無音）。
 */
export function EndScreen({
  outcome,
  title,
  score,
  scoreLabel = "スコア",
  newBest,
  previousBest,
  onRetry,
  retryLabel = "もう一度",
  sound = false,
  confettiOnLose = false,
  children,
}: EndScreenProps) {
  const { prefix } = useGamesNav();
  const animatedScore = useAnimatedNumber(score ?? 0, 700);
  const sectionRef = useRef<HTMLElement | null>(null);
  const retryRef = useRef(onRetry);
  retryRef.current = onRetry;
  const [confetti] = useState<ConfettiPiece[]>(() => {
    if (outcome === "win") return makeConfetti(newBest ? 40 : 26);
    if (outcome === "lose" && confettiOnLose) return makeConfetti(14);
    return [];
  });

  // 敗北の第一印象: 小シェイク＋フラッシュを1回だけ（短く派手に）。
  useEffect(() => {
    if (outcome !== "lose") return;
    juiceShake(sectionRef.current, 1);
    juiceFlash(sectionRef.current);
  }, [outcome]);

  // 終了ファンファーレ（opt-in のときだけ、自前ジングルとの二重再生を避ける）。
  useEffect(() => {
    if (!sound) return;
    playEndFanfare(outcome, Boolean(newBest));
    // 初回マウント時に1回だけ鳴らす。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // R キーで即リトライ（#116）。入力欄・選択欄にフォーカスがあるときと
  // 修飾キー併用時は邪魔をしない。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "r" && e.key !== "R") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable) return;
      }
      e.preventDefault();
      retryRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <section ref={sectionRef} className="juice-end juice-slide" aria-label="結果">
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
      <p className="juice-end-hint">Rキーでもう一度</p>
    </section>
  );
}

export type GoalBandProps = {
  /** 現在のスコア/進捗。 */
  current: number;
  /** これまでのベスト。null/記録なしなら「記録なし」の表示になる。 */
  best: number | null | undefined;
  /** true なら小さいほど良い指標（タイム、反応速度など）。 */
  lowerIsBetter?: boolean;
  /** 数値の後ろに付ける単位（「点」「秒」など）。 */
  unit?: string;
  /** 目標の名前。既定は「ベスト」。 */
  label?: string;
  /** 数値の整形（ms→秒など）。既定はそのまま。 */
  format?: (n: number) => string;
};

/**
 * プレイ中のご褒美帯（#023 目の前に吊るされたご褒美 / #075）。
 * 「ベストまであと○」という手の届く目標をプレイ中ずっと1行で見せる。
 * 記録を超えている間は「ベスト更新中」として弾ませる。
 */
export function GoalBand({ current, best, lowerIsBetter = false, unit = "", label = "ベスト", format }: GoalBandProps) {
  const fmt = format ?? ((n: number) => `${Math.round(n)}`);
  const state = goalBandState(current, best, lowerIsBetter);
  if (state.kind === "none") {
    return (
      <p className="juice-goal-band" role="status">
        {label}記録はまだありません — 初記録を目指そう
      </p>
    );
  }
  if (state.kind === "beating") {
    return (
      <p className="juice-goal-band juice-goal-band-beating" role="status">
        {label}更新中（現在 {fmt(current)}
        {unit}）
      </p>
    );
  }
  return (
    <p className="juice-goal-band" role="status">
      {label} {fmt(best ?? 0)}
      {unit} まであと {fmt(state.remaining)}
      {unit}
    </p>
  );
}

/**
 * オンライン対戦系の共通手応えフック（バッチ2）。
 * OnlineShell が盤面を包む .og-game-area を対象に取るため、呼び出しは
 * 「状態から決まる moveKey と finished を渡す」だけで済む（基盤側の
 * OnlineShell 自体には触らない）。moveKey が変わるたびに小ヒットストップ、
 * finished の false→true で大ヒット＋フラッシュ＋中シェイクを掛ける。
 * 音は鳴らさない（対戦系の音響は balku-sound 側の担当で、二重化しない）。
 */
export function useRoomJuice(moveKey: unknown, finished: boolean): void {
  const moveRef = useRef<unknown>(moveKey);
  const finishedRef = useRef(finished);
  useEffect(() => {
    if (Object.is(moveRef.current, moveKey)) return;
    moveRef.current = moveKey;
    if (finishedRef.current) return;
    const el = document.querySelector(".og-game-area");
    if (el) juiceHitstop(el as unknown as HTMLElement, 1);
  }, [moveKey]);
  useEffect(() => {
    const was = finishedRef.current;
    finishedRef.current = finished;
    if (was || !finished) return;
    const el = document.querySelector(".og-game-area");
    if (!el) return;
    const target = el as unknown as HTMLElement;
    juiceHit(target, 3);
    juiceFlash(target);
    juiceShake(target, 2);
  }, [finished]);
}

/**
 * 盤面系（特に対戦系）の共通手応えフック（バッチ2）。
 * 返した ref を盤のラッパー要素へ付けるだけで:
 * - moveKey が変わるたび（=着手が盤に反映されるたび）に小ヒットストップ
 * - finished が false→true になった瞬間に大ヒットストップ＋フラッシュ＋中シェイク
 * を掛ける。初回マウントでは何もしない。音は鳴らさない（各タイトルの
 * 既存の音響系に任せ、二重再生を作らない）。
 */
export function useBoardJuice<T extends HTMLElement = HTMLDivElement>(moveKey: unknown, finished: boolean) {
  const { ref, hit, flash, shake } = useJuice<T>();
  const moveRef = useRef<unknown>(moveKey);
  const finishedRef = useRef(finished);
  useEffect(() => {
    if (Object.is(moveRef.current, moveKey)) return;
    moveRef.current = moveKey;
    if (!finishedRef.current) hit(1);
  }, [moveKey, hit]);
  useEffect(() => {
    const was = finishedRef.current;
    finishedRef.current = finished;
    if (!was && finished) {
      hit(3);
      flash();
      shake(2);
    }
  }, [finished, hit, flash, shake]);
  return ref;
}
