// 「dreaming」専用の簡易シンセ効果音（Web Audio API・外部ファイルなし）。
// ミュート設定は lib/sfx.ts の共通キー（ago-sfx-muted）をそのまま参照し、
// AudioContext が使えない環境では例外を投げず no-op にする。

import { isSfxMuted } from "@/lib/sfx";
import type { DomainId } from "@/lib/games/dreaming-model";

let audioCtx: AudioContext | null = null;
let softNoiseBuf: AudioBuffer | null = null;

function getCtx(): AudioContext | null {
  if (isSfxMuted()) return null;
  if (typeof window === "undefined") return null;
  try {
    if (!audioCtx) {
      const AC =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return null;
      audioCtx = new AC();
    }
    if (audioCtx.state === "suspended") void audioCtx.resume();
    return audioCtx;
  } catch {
    return null;
  }
}

function getNoiseBuffer(c: AudioContext): AudioBuffer {
  if (softNoiseBuf && softNoiseBuf.sampleRate === c.sampleRate) return softNoiseBuf;
  const len = Math.floor(c.sampleRate * 0.45);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  softNoiseBuf = buf;
  return buf;
}

function softTone(
  freq: number,
  dur: number,
  vol: number,
  type: OscillatorType = "sine",
  delay = 0,
  slideTo?: number,
): void {
  const c = getCtx();
  if (!c) return;
  try {
    const t0 = c.currentTime + delay;
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (slideTo) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(30, slideTo), t0 + dur);
    }
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.linearRampToValueAtTime(vol, t0 + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain).connect(c.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.04);
  } catch {
    // 音響再生不可時は黙って継続
  }
}

function softNoise(dur: number, vol: number, freq: number, q = 1.4, delay = 0): void {
  const c = getCtx();
  if (!c) return;
  try {
    const t0 = c.currentTime + delay;
    const src = c.createBufferSource();
    src.buffer = getNoiseBuffer(c);
    src.loop = true;
    const filter = c.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = freq;
    filter.Q.value = q;
    const gain = c.createGain();
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.linearRampToValueAtTime(vol, t0 + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(filter).connect(gain).connect(c.destination);
    src.start(t0);
    src.stop(t0 + dur + 0.04);
  } catch {
    // no-op
  }
}

// 領域ごとの足音トーン（現在の夢の滲みに合わせて響きが変わる）
const STEP_PITCH: Record<DomainId, { freq: number; noiseFreq: number; wave: OscillatorType }> = {
  station: { freq: 210, noiseFreq: 1650, wave: "triangle" },
  school: { freq: 185, noiseFreq: 980, wave: "sine" },
  library: { freq: 162, noiseFreq: 760, wave: "sine" },
  arcade: { freq: 235, noiseFreq: 2200, wave: "triangle" },
  harbor: { freq: 148, noiseFreq: 640, wave: "sine" },
  meadow: { freq: 196, noiseFreq: 1320, wave: "sine" },
};

/** 歩行の足音。領域と温度で音程が少し揺らぐ。 */
export function sfxDreamStep(domain: DomainId, temperature: number): void {
  const cfg = STEP_PITCH[domain];
  const drift = 0.94 + Math.random() * 0.12 + (temperature - 0.92) * 0.04;
  softTone(cfg.freq * drift, 0.075, 0.045, cfg.wave, 0, cfg.freq * drift * 0.82);
  softNoise(0.055, 0.028, cfg.noiseFreq * drift, 1.8);
}

/** 壁・障害物に当たったときの柔らかい鈍い音。 */
export function sfxDreamBump(): void {
  softTone(112, 0.085, 0.06, "sine", 0, 74);
}

/** モチーフ採集・変質再会の倍音チャイム。世代が深いほど豊かな和音になる。 */
export function sfxDreamCollect(generation: number): void {
  // 落ち着いたペンタトニック（D4, F4, A4, C5, E5, G5）
  const scale = [293.66, 349.23, 440.0, 523.25, 659.25, 783.99];
  const baseIdx = (generation - 1) % 3;
  const f1 = scale[baseIdx];
  const f2 = scale[baseIdx + 2];
  const f3 = scale[Math.min(scale.length - 1, baseIdx + 3)];
  softTone(f1, 0.42, 0.075, "sine", 0);
  softTone(f2, 0.48, 0.065, "triangle", 0.075);
  if (generation >= 2) {
    softTone(f3, 0.62, 0.06, "sine", 0.15);
    softTone(f3 * 1.5, 0.42, 0.03, "sine", 0.22);
  }
}

/** 記憶のしおりを挟む／外す／押し出す音。 */
export function sfxDreamAnchor(mode: "place" | "remove" | "evict"): void {
  if (mode === "place") {
    softTone(587.33, 0.14, 0.06, "triangle", 0);
    softTone(880.0, 0.24, 0.055, "sine", 0.06);
  } else if (mode === "evict") {
    softTone(523.25, 0.16, 0.055, "triangle", 0, 392.0);
    softTone(783.99, 0.22, 0.05, "sine", 0.06);
    softNoise(0.18, 0.032, 1100, 1.2, 0.08);
  } else {
    softTone(440.0, 0.18, 0.05, "sine", 0, 311.13);
  }
}

/** 記憶パルスの波紋音。 */
export function sfxDreamPulse(): void {
  softTone(220, 0.36, 0.065, "sine", 0, 330);
  softTone(330, 0.42, 0.045, "triangle", 0.05, 440);
  softNoise(0.22, 0.024, 920, 2.2, 0.02);
}

/** 深層へ潜行するときの低いドローンと沈み込むアルペジオ。 */
export function sfxDreamDescend(): void {
  softTone(146.83, 0.85, 0.085, "sine", 0, 98.0);
  softTone(293.66, 0.55, 0.055, "triangle", 0.08, 220.0);
  softTone(440.0, 0.48, 0.045, "sine", 0.18, 293.66);
  softNoise(0.45, 0.03, 520, 0.9, 0.04);
}
