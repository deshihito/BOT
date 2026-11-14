// 簡易シンセ効果音（Web Audio API、外部ファイルなし）。
// AudioContext はモジュール内で1つだけ共有する。ミュート状態は
// localStorage `ago-sfx-muted` に保存し、他ゲームとは干渉しない。
// すべての関数は失敗しても例外を投げない（音が出ないだけ）。

const MUTE_KEY = "ago-sfx-muted";

let ctx: AudioContext | null = null;
let noiseBuffer: AudioBuffer | null = null;
let mutedCache: boolean | null = null;

export function isSfxMuted(): boolean {
  if (mutedCache !== null) return mutedCache;
  try {
    mutedCache = localStorage.getItem(MUTE_KEY) === "1";
  } catch {
    mutedCache = false;
  }
  return mutedCache;
}

export function setSfxMuted(muted: boolean): void {
  mutedCache = muted;
  try {
    localStorage.setItem(MUTE_KEY, muted ? "1" : "0");
  } catch {
    // 保存できなくてもミュート自体は効かせる。
  }
}

function ac(): AudioContext | null {
  if (isSfxMuted()) return null;
  try {
    if (!ctx) {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

function getNoise(c: AudioContext): AudioBuffer {
  if (noiseBuffer && noiseBuffer.sampleRate === c.sampleRate) return noiseBuffer;
  const len = Math.floor(c.sampleRate * 0.5);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  noiseBuffer = buf;
  return buf;
}

/** 短いトーン（サイン波＋指数減衰）。 */
function tone(freq: number, dur: number, vol: number, type: OscillatorType = "sine", delay = 0, slideTo?: number): void {
  const c = ac();
  if (!c) return;
  try {
    const t0 = c.currentTime + delay;
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), t0 + dur);
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(vol, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(c.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  } catch {
    // 音が出ないだけ。
  }
}

/** ノイズバースト（フィルタ付き）。 */
function noise(dur: number, vol: number, filterFreq: number, type: BiquadFilterType = "lowpass", delay = 0): void {
  const c = ac();
  if (!c) return;
  try {
    const t0 = c.currentTime + delay;
    const src = c.createBufferSource();
    src.buffer = getNoise(c);
    src.loop = true;
    const f = c.createBiquadFilter();
    f.type = type;
    f.frequency.value = filterFreq;
    const g = c.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(vol, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f).connect(g).connect(c.destination);
    src.start(t0);
    src.stop(t0 + dur + 0.05);
  } catch {
    // 音が出ないだけ。
  }
}

/** 歯やボタンの軽いクリック/ポップ。 */
export function sfxPop(pitch = 1): void {
  tone(340 * pitch, 0.09, 0.11, "triangle");
  noise(0.05, 0.04, 2400, "bandpass");
}

/** 安全な歯を押したときの柔らかい音。 */
export function sfxSafePress(): void {
  tone(520, 0.08, 0.08, "sine");
  tone(760, 0.1, 0.06, "sine", 0.05);
}

/** ワニの顎が閉じる音（低いドン＋カチッ）。 */
export function sfxJawSnap(): void {
  tone(140, 0.22, 0.3, "sine", 0, 55);
  noise(0.12, 0.22, 900, "lowpass");
  tone(1900, 0.05, 0.12, "square", 0.01);
  noise(0.06, 0.15, 3200, "highpass", 0.02);
}

/** ボールがレーンを転がる音。止める関数を返す（不要なら空関数）。 */
export function sfxRollStart(): () => void {
  const c = ac();
  if (!c) return () => undefined;
  try {
    const src = c.createBufferSource();
    src.buffer = getNoise(c);
    src.loop = true;
    const f = c.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.value = 420;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, c.currentTime);
    g.gain.linearRampToValueAtTime(0.07, c.currentTime + 0.15);
    src.connect(f).connect(g).connect(c.destination);
    src.start();
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      try {
        g.gain.cancelScheduledValues(c.currentTime);
        g.gain.setValueAtTime(Math.max(0.0001, g.gain.value), c.currentTime);
        g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + 0.12);
        src.stop(c.currentTime + 0.15);
      } catch {
        // 停止済みなら何もしない。
      }
    };
  } catch {
    return () => undefined;
  }
}

/** ボールがピンに当たった瞬間の木の当たる音。 */
export function sfxPinHit(): void {
  tone(210, 0.09, 0.2, "triangle");
  noise(0.07, 0.14, 1600, "bandpass");
}

/** 倒れたピンのカラカラという連鎖音。本数が多いほど長く鳴らす。 */
export function sfxPinsDown(count: number): void {
  const n = Math.max(1, Math.min(6, count));
  for (let i = 0; i < n; i++) {
    const delay = i * 0.055;
    tone(1500 + Math.random() * 900, 0.06, 0.07, "triangle", delay);
    noise(0.05, 0.06, 2600, "bandpass", delay);
  }
  if (count >= 8) {
    // ストライク級は少し派手に。
    tone(880, 0.16, 0.08, "triangle", 0.05);
    tone(1320, 0.2, 0.08, "triangle", 0.14);
  }
}

/** ガターに落ちたときの鈍い音。 */
export function sfxGutter(): void {
  tone(120, 0.18, 0.14, "sine", 0, 70);
  noise(0.14, 0.08, 500, "lowpass");
}

// ---------------------------------------------------------------------------
// 汎用 SE 語彙（全ゲーム共通）。意味ベースの名前で、ゲーム側は素材ではなく
// 「何が起きたか」で選ぶ。すべて上の tone/noise ヘルパー経由なので、
// ミュート時・AudioContext が無い環境では自動的に no-op になる。
// ---------------------------------------------------------------------------

// SE 優先度階層（sakurai #032「重要度で効果音バランスを取る」/#165
// 「アタック強め、残響ほどほど」）。プレイヤーへの影響度で音量を配分する:
// tier1 撃墜・勝敗 ＞ tier2 ヒット・正解 ＞ tier3 配置・配布・めくり ＞
// tier4 タップ・出現・移動 ＞ tier5 刻み・環境。アタック 8ms は tone 側で維持。
export type SfxTier = 1 | 2 | 3 | 4 | 5;

/** tier ごとの基準ゲイン（単調に下がること）。 */
export const SFX_TIER_GAIN: Record<SfxTier, number> = { 1: 0.19, 2: 0.145, 3: 0.115, 4: 0.07, 5: 0.035 };

/** 語彙ごとの tier 対応表（テストと監査用）。 */
export const SFX_VOCAB_TIERS: Record<string, SfxTier> = {
  sfxWin: 1,
  sfxLose: 1,
  sfxKo: 1,
  sfxJingle: 1,
  sfxCorrect: 2,
  sfxHit: 2,
  sfxWrong: 2,
  sfxPlace: 3,
  sfxDeal: 3,
  sfxDice: 3,
  sfxFlip: 3,
  sfxPop: 3,
  sfxTap: 4,
  sfxSpawn: 4,
  sfxSlide: 4,
  sfxTick: 5,
};

/** tier の基準ゲインに局所係数を掛けた音量を返す。 */
function tierVol(tier: SfxTier, local = 1): number {
  return SFX_TIER_GAIN[tier] * local;
}

/** 選択・タップの軽いクリック。 */
export function sfxTap(): void {
  tone(880, 0.05, tierVol(4), "triangle");
  noise(0.03, 0.025, 3000, "highpass");
}

/** 駒やタイルを置く・確定する音。 */
export function sfxPlace(): void {
  tone(210, 0.09, tierVol(3, 1.2), "triangle");
  noise(0.06, 0.08, 700, "lowpass");
  tone(340, 0.06, 0.05, "sine", 0.02);
}

/** カードやタイルをめくる音。 */
export function sfxFlip(): void {
  noise(0.09, 0.085, 1900, "bandpass");
  tone(540, 0.1, 0.05, "sine", 0, 940);
}

/** カードを配る音（1枚分）。連続配布は呼び出し側で間隔を空けて呼ぶ。 */
export function sfxDeal(): void {
  noise(0.07, 0.08, 2600, "bandpass");
  tone(1200, 0.04, 0.03, "triangle", 0.01);
}

/** サイコロを振る音（転がって止まるまで）。 */
export function sfxDice(): void {
  for (let i = 0; i < 5; i++) {
    const delay = i * 0.06 + Math.random() * 0.02;
    tone(300 + Math.random() * 240, 0.05, 0.08, "triangle", delay);
    noise(0.04, 0.06, 1500, "bandpass", delay);
  }
  tone(240, 0.08, tierVol(3), "triangle", 0.34);
  noise(0.05, 0.07, 900, "lowpass", 0.34);
}

/** 正解・成功の2音。 */
export function sfxCorrect(): void {
  tone(659, 0.1, tierVol(2, 0.9), "triangle");
  tone(880, 0.16, tierVol(2, 0.9), "triangle", 0.08);
}

/** 不正解・失敗の低い音。 */
export function sfxWrong(): void {
  tone(196, 0.16, tierVol(2, 0.9), "square", 0, 147);
  noise(0.1, 0.04, 500, "lowpass");
}

/** ヒット音（強さ 1..3）。アタックを強く、残響は短く（#165）。 */
export function sfxHit(intensity: 1 | 2 | 3 = 2): void {
  const v = tierVol(2, intensity === 1 ? 0.8 : intensity === 2 ? 1 : 1.25);
  tone(200 - (intensity - 1) * 30, 0.1 + intensity * 0.02, v, "triangle", 0, 70);
  noise(0.05 + intensity * 0.015, v * 0.7, 2600, "bandpass");
  if (intensity >= 2) tone(740, 0.06, v * 0.45, "square", 0.01);
  if (intensity >= 3) tone(90, 0.22, tierVol(1, 0.8), "sine", 0, 45);
}

/** 撃墜・大勝ちの止め音（tier1）。ヒットストップ＋フラッシュと同期させる。 */
export function sfxKo(): void {
  tone(150, 0.38, tierVol(1), "sine", 0, 38);
  noise(0.28, tierVol(1, 0.8), 800, "lowpass");
  noise(0.12, tierVol(2, 0.7), 3000, "highpass", 0.02);
  tone(784, 0.14, tierVol(1, 0.7), "triangle", 0.09);
  tone(1175, 0.24, tierVol(1, 0.75), "triangle", 0.18);
}

/** 勝利ジングル（汎用）。 */
export function sfxWin(): void {
  tone(523, 0.13, tierVol(1, 0.75), "triangle");
  tone(659, 0.13, tierVol(1, 0.75), "triangle", 0.1);
  tone(784, 0.13, tierVol(1, 0.75), "triangle", 0.2);
  tone(1047, 0.26, tierVol(1, 0.8), "triangle", 0.3);
  noise(0.2, 0.03, 4000, "highpass", 0.3);
}

/** 敗北ジングル（汎用）。 */
export function sfxLose(): void {
  tone(392, 0.15, tierVol(1, 0.75), "triangle");
  tone(330, 0.15, tierVol(1, 0.75), "triangle", 0.13);
  tone(262, 0.3, tierVol(1, 0.8), "triangle", 0.26);
}

/** カウント・タイマーの刻み音。 */
export function sfxTick(): void {
  tone(1050, 0.03, tierVol(5), "square");
}

/** 出現（ポップイン）の音。 */
export function sfxSpawn(): void {
  tone(480, 0.1, tierVol(4), "sine", 0, 990);
  noise(0.05, 0.03, 2800, "bandpass");
}

/** スライド・移動の風切り音。 */
export function sfxSlide(): void {
  noise(0.14, 0.06, 1100, "bandpass");
  tone(320, 0.14, 0.04, "sine", 0, 190);
}

/** 勝敗ジングル（3音だけの簡易版）。 */
export function sfxJingle(win: boolean): void {
  if (win) {
    tone(523, 0.14, tierVol(1, 0.7), "triangle");
    tone(659, 0.14, tierVol(1, 0.7), "triangle", 0.11);
    tone(784, 0.24, tierVol(1, 0.75), "triangle", 0.22);
  } else {
    tone(392, 0.16, tierVol(1, 0.7), "triangle");
    tone(311, 0.16, tierVol(1, 0.7), "triangle", 0.13);
    tone(233, 0.3, tierVol(1, 0.75), "triangle", 0.26);
  }
}
