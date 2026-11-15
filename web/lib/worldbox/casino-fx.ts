// カジノの演出階級（純粋ロジック）。
// 配当の大きさを階級に分け、紙吹雪・カウントアップ・フラッシュ・
// 画面シェイクの強さを階級で決める。リーチ判定（スロットの先2つ一致）もここ。

/** 0=はずれ、1=小当たり、2=中当たり、3=大当たり、4=超大当たり。 */
export type WinTier = 0 | 1 | 2 | 3 | 4;

export function winTier(payout: number, bet: number): WinTier {
  if (payout <= 0 || bet <= 0) return 0;
  const ratio = payout / bet;
  if (ratio >= 50) return 4;
  if (ratio >= 10) return 3;
  if (ratio >= 2) return 2;
  return 1;
}

export interface TierFx {
  confetti: number;
  countUpMs: number;
  flash: boolean;
  shake: boolean;
}

export function tierFx(tier: WinTier): TierFx {
  switch (tier) {
    case 1: return { confetti: 24, countUpMs: 500, flash: false, shake: false };
    case 2: return { confetti: 60, countUpMs: 900, flash: true, shake: false };
    case 3: return { confetti: 130, countUpMs: 1500, flash: true, shake: true };
    case 4: return { confetti: 240, countUpMs: 2400, flash: true, shake: true };
    default: return { confetti: 0, countUpMs: 0, flash: false, shake: false };
  }
}

/** カウントアップのイージング（最初速く、最後に減速して止まる）。 */
export function countUpValue(from: number, to: number, t: number): number {
  const clamped = Math.max(0, Math.min(1, t));
  const eased = 1 - Math.pow(1 - clamped, 3);
  return Math.round(from + (to - from) * eased);
}

/** スロットのリーチ: 先に止まった2つが同じ絵柄なら3つ目に期待がかかる。 */
export function isReach(reels: readonly number[]): boolean {
  return reels.length >= 2 && reels[0] === reels[1];
}

/** セブンスロットの見どころ判定（7 が多いほど熱い）。 */
export function sevenHeat(reels: readonly (number | null)[]): number {
  return reels.filter((d) => d === 7).length;
}

export interface ConfettiParticle {
  x: number; // 0..1（幅比）
  y: number; // 0..1（高さ比、開始位置）
  vx: number;
  vy: number;
  size: number;
  color: string;
  delay: number; // 秒
  spin: number;
}

export const CONFETTI_COLORS = ["#ffd23e", "#ff7a7a", "#7ac7ff", "#9dff70", "#e8e8f0"] as const;

/** 紙吹雪の初期配置（上部から噴き出す）。乱数は注入する。 */
export function confettiParticles(count: number, rng: () => number): ConfettiParticle[] {
  const out: ConfettiParticle[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      x: 0.5 + (rng() - 0.5) * 0.5,
      y: 0.28 + (rng() - 0.5) * 0.08,
      vx: (rng() - 0.5) * 1.6,
      vy: -(0.9 + rng() * 1.1),
      size: 4 + rng() * 6,
      color: CONFETTI_COLORS[Math.floor(rng() * CONFETTI_COLORS.length) % CONFETTI_COLORS.length],
      delay: rng() * 0.25,
      spin: (rng() - 0.5) * 12,
    });
  }
  return out;
}
