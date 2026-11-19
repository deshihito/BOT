// 「dreaming」専用の生成シンセ効果音＆夢環境音（Web Audio API・外部ファイルなし）。
// ミュート設定は lib/sfx.ts の共通キー（ago-sfx-muted）をそのまま参照し、
// AudioContext が使えない環境では例外を投げず no-op にする。

import { isSfxMuted } from "@/lib/sfx";
import { DOMAIN_IDS, type DomainId } from "@/lib/games/dreaming-model";

let audioCtx: AudioContext | null = null;
let softNoiseBuf: AudioBuffer | null = null;
let echoBus: GainNode | null = null;

type AmbienceNodes = {
  master: GainNode;
  filter: BiquadFilterNode;
  osc1: OscillatorNode;
  osc2: OscillatorNode;
  osc3: OscillatorNode;
  lfo: OscillatorNode;
  lfoGain: GainNode;
  noiseGain: GainNode;
  noiseFilter: BiquadFilterNode;
  noiseSrc: AudioBufferSourceNode;
};

let ambience: AmbienceNodes | null = null;

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

/** 深夜の廊下・ホームのような淡い残響（ディレイ帰還バス）を遅延初期化する。 */
function getEchoBus(c: AudioContext): AudioNode {
  if (echoBus && echoBus.context === c) return echoBus;
  try {
    const input = c.createGain();
    const dry = c.createGain();
    const delay = c.createDelay(1.0);
    const feedback = c.createGain();
    const damp = c.createBiquadFilter();
    const wet = c.createGain();

    dry.gain.value = 0.86;
    delay.delayTime.value = 0.275;
    feedback.gain.value = 0.3;
    damp.type = "lowpass";
    damp.frequency.value = 1350;
    wet.gain.value = 0.42;

    input.connect(dry).connect(c.destination);
    input.connect(delay);
    delay.connect(damp).connect(wet).connect(c.destination);
    damp.connect(feedback).connect(delay);

    echoBus = input;
    return input;
  } catch {
    return c.destination;
  }
}

function getNoiseBuffer(c: AudioContext): AudioBuffer {
  if (softNoiseBuf && softNoiseBuf.sampleRate === c.sampleRate) return softNoiseBuf;
  const len = Math.floor(c.sampleRate * 1.4);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const data = buf.getChannelData(0);
  // 柔らかいピンクノイズ寄りの 1 次フィルタノイズ（耳障りな高域を抑える）
  let b0 = 0;
  let b1 = 0;
  for (let i = 0; i < len; i++) {
    const white = Math.random() * 2 - 1;
    b0 = 0.96 * b0 + white * 0.04;
    b1 = 0.85 * b1 + white * 0.15;
    data[i] = Math.max(-1, Math.min(1, (b0 * 1.8 + b1 * 0.8) * 1.2));
  }
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
    const out = getEchoBus(c);
    const t0 = c.currentTime + delay;
    const osc = c.createOscillator();
    const filter = c.createBiquadFilter();
    const gain = c.createGain();

    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (slideTo) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(30, slideTo), t0 + dur);
    }

    filter.type = "lowpass";
    filter.frequency.setValueAtTime(Math.min(3400, freq * 4.5), t0);

    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.linearRampToValueAtTime(vol, t0 + 0.018);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    osc.connect(filter).connect(gain).connect(out);
    osc.start(t0);
    osc.stop(t0 + dur + 0.06);
  } catch {
    // 音響再生不可時は黙って継続
  }
}

function softNoise(dur: number, vol: number, freq: number, q = 1.4, delay = 0): void {
  const c = getCtx();
  if (!c) return;
  try {
    const out = getEchoBus(c);
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
    gain.gain.linearRampToValueAtTime(vol, t0 + 0.014);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(filter).connect(gain).connect(out);
    src.start(t0);
    src.stop(t0 + dur + 0.05);
  } catch {
    // no-op
  }
}

// 領域ごとの基本ドローン周波数（Hz）と霧ノイズの帯域
const DOMAIN_AMBIENCE: Record<
  DomainId,
  { root: number; fifth: number; upper: number; airFreq: number; airVol: number }
> = {
  station: { root: 73.42, fifth: 110.0, upper: 220.0, airFreq: 520, airVol: 0.007 },
  school: { root: 87.31, fifth: 130.81, upper: 293.66, airFreq: 740, airVol: 0.005 },
  library: { root: 65.41, fifth: 98.0, upper: 261.63, airFreq: 440, airVol: 0.004 },
  arcade: { root: 77.78, fifth: 116.54, upper: 233.08, airFreq: 1180, airVol: 0.012 },
  harbor: { root: 61.74, fifth: 92.5, upper: 185.0, airFreq: 380, airVol: 0.011 },
  meadow: { root: 98.0, fifth: 146.83, upper: 293.66, airFreq: 860, airVol: 0.007 },
};

/**
 * 現在の RNN 領域混合分布・温度・恐怖度 dread に応じて、夢の環境ドローンを連続調律する。
 * dread が高まるほど完全五度が増四度（トライトーン）へ不穏に歪み、テープ揺らぎと暗騒音が増す。
 */
export function updateDreamAmbience(
  domainWeights: Record<DomainId, number>,
  temperature: number,
  depth: number,
  dread = 0,
): void {
  if (isSfxMuted()) {
    stopDreamAmbience();
    return;
  }
  const c = getCtx();
  if (!c) return;
  try {
    if (!ambience) {
      const master = c.createGain();
      const filter = c.createBiquadFilter();
      const osc1 = c.createOscillator();
      const osc2 = c.createOscillator();
      const osc3 = c.createOscillator();
      const g1 = c.createGain();
      const g2 = c.createGain();
      const g3 = c.createGain();
      const lfo = c.createOscillator();
      const lfoGain = c.createGain();

      const noiseSrc = c.createBufferSource();
      noiseSrc.buffer = getNoiseBuffer(c);
      noiseSrc.loop = true;
      const noiseFilter = c.createBiquadFilter();
      noiseFilter.type = "bandpass";
      noiseFilter.Q.value = 0.85;
      const noiseGain = c.createGain();

      osc1.type = "sine";
      osc2.type = "triangle";
      osc3.type = "sine";
      g1.gain.value = 0.52;
      g2.gain.value = 0.24;
      g3.gain.value = 0.14;

      filter.type = "lowpass";
      filter.frequency.value = 340;
      filter.Q.value = 0.7;

      // テープのワウ・フラッターのような極緩い揺らぎ
      lfo.type = "sine";
      lfo.frequency.value = 0.14;
      lfoGain.gain.value = 1.4;
      lfo.connect(lfoGain);
      lfoGain.connect(osc2.detune);
      lfoGain.connect(osc3.detune);

      master.gain.setValueAtTime(0.0001, c.currentTime);
      noiseGain.gain.setValueAtTime(0.0001, c.currentTime);

      osc1.connect(g1).connect(filter);
      osc2.connect(g2).connect(filter);
      osc3.connect(g3).connect(filter);
      filter.connect(master).connect(c.destination);
      noiseSrc.connect(noiseFilter).connect(noiseGain).connect(c.destination);

      osc1.start();
      osc2.start();
      osc3.start();
      lfo.start();
      noiseSrc.start();

      ambience = {
        master,
        filter,
        osc1,
        osc2,
        osc3,
        lfo,
        lfoGain,
        noiseGain,
        noiseFilter,
        noiseSrc,
      };
    }

    // 領域確率分布から周波数を連続補間（境目なく音像も滲む）
    let root = 0;
    let fifth = 0;
    let upper = 0;
    let airFreq = 0;
    let airVol = 0;
    for (const d of DOMAIN_IDS) {
      const w = domainWeights[d] ?? 0;
      const cfg = DOMAIN_AMBIENCE[d];
      root += cfg.root * w;
      fifth += cfg.fifth * w;
      upper += cfg.upper * w;
      airFreq += cfg.airFreq * w;
      airVol += cfg.airVol * w;
    }

    // 深層ほど低く沈み、恐怖度 dread が上がるほど完全五度が不協和（増四度）へ軋む
    const clampedDread = Math.max(0, Math.min(1, dread));
    const depthShift = Math.max(0.82, 1 - (depth - 1) * 0.026);
    const tritoneBend = 1 - clampedDread * 0.062; // 1.5 -> ~1.407 (不穏なトライトーン)
    const upperBend = 1 + clampedDread * 0.036;
    const t = c.currentTime;
    ambience.osc1.frequency.setTargetAtTime(root * depthShift, t, 1.0);
    ambience.osc2.frequency.setTargetAtTime(fifth * depthShift * tritoneBend, t, 0.85);
    ambience.osc3.frequency.setTargetAtTime(upper * depthShift * upperBend, t, 0.9);

    const cutoff = Math.max(180, Math.min(680, 460 - (temperature - 0.6) * 120 + clampedDread * 190));
    ambience.filter.frequency.setTargetAtTime(cutoff, t, 0.7);
    ambience.lfoGain.gain.setTargetAtTime(
      1.4 + Math.max(0, temperature - 0.5) * 9.5 + clampedDread * 28,
      t,
      0.6,
    );
    ambience.lfo.frequency.setTargetAtTime(0.11 + temperature * 0.1 + clampedDread * 0.35, t, 0.6);

    ambience.master.gain.setTargetAtTime(0.025 + clampedDread * 0.018, t, 0.9);
    ambience.noiseFilter.frequency.setTargetAtTime(airFreq * (1 + clampedDread * 0.65), t, 0.8);
    ambience.noiseGain.gain.setTargetAtTime(airVol + clampedDread * 0.012, t, 0.8);
  } catch {
    // no-op
  }
}

/** 夢の環境ドローンを静かにフェードアウトして停止する。 */
export function stopDreamAmbience(): void {
  if (!ambience || !audioCtx) return;
  const nodes = ambience;
  ambience = null;
  try {
    const t = audioCtx.currentTime;
    nodes.master.gain.cancelScheduledValues(t);
    nodes.master.gain.setTargetAtTime(0.0001, t, 0.14);
    nodes.noiseGain.gain.cancelScheduledValues(t);
    nodes.noiseGain.gain.setTargetAtTime(0.0001, t, 0.14);
    setTimeout(() => {
      try {
        nodes.osc1.stop();
        nodes.osc2.stop();
        nodes.osc3.stop();
        nodes.lfo.stop();
        nodes.noiseSrc.stop();
        nodes.master.disconnect();
        nodes.noiseGain.disconnect();
      } catch {
        // already stopped
      }
    }, 450);
  } catch {
    // no-op
  }
}

// 領域ごとの足音トーン（現在の夢の滲みに合わせて響きが変わる）
const STEP_PITCH: Record<DomainId, { freq: number; noiseFreq: number; wave: OscillatorType }> = {
  station: { freq: 210, noiseFreq: 1450, wave: "triangle" },
  school: { freq: 185, noiseFreq: 920, wave: "sine" },
  library: { freq: 162, noiseFreq: 720, wave: "sine" },
  arcade: { freq: 230, noiseFreq: 1850, wave: "triangle" },
  harbor: { freq: 148, noiseFreq: 620, wave: "sine" },
  meadow: { freq: 196, noiseFreq: 1180, wave: "sine" },
};

/** 歩行の足音。領域と温度で音程が少し揺らぎ、淡い残響を引く。 */
export function sfxDreamStep(domain: DomainId, temperature: number): void {
  const cfg = STEP_PITCH[domain];
  const drift = 0.94 + Math.random() * 0.12 + (temperature - 0.92) * 0.05;
  softTone(cfg.freq * drift, 0.09, 0.038, cfg.wave, 0, cfg.freq * drift * 0.8);
  softNoise(0.06, 0.022, cfg.noiseFreq * drift, 1.8);
}

/** 壁・障害物に当たったときの柔らかい鈍い音。 */
export function sfxDreamBump(): void {
  softTone(108, 0.11, 0.05, "sine", 0, 72);
}

/** モチーフ採集・変質再会の倍音チャイム。世代が深いほど豊かな和音になる。 */
export function sfxDreamCollect(generation: number): void {
  const scale = [293.66, 349.23, 440.0, 523.25, 659.25, 783.99];
  const baseIdx = (generation - 1) % 3;
  const f1 = scale[baseIdx];
  const f2 = scale[baseIdx + 2];
  const f3 = scale[Math.min(scale.length - 1, baseIdx + 3)];
  softTone(f1, 0.56, 0.065, "sine", 0);
  softTone(f2, 0.64, 0.055, "triangle", 0.085);
  if (generation >= 2) {
    softTone(f3, 0.78, 0.05, "sine", 0.17);
    softTone(f3 * 1.5, 0.52, 0.026, "sine", 0.25);
  }
}

/** 記憶のしおりを挟む／外す／押し出す音。 */
export function sfxDreamAnchor(mode: "place" | "remove" | "evict"): void {
  if (mode === "place") {
    softTone(587.33, 0.22, 0.05, "triangle", 0);
    softTone(880.0, 0.34, 0.045, "sine", 0.07);
  } else if (mode === "evict") {
    softTone(523.25, 0.22, 0.048, "triangle", 0, 392.0);
    softTone(783.99, 0.3, 0.042, "sine", 0.07);
    softNoise(0.22, 0.024, 980, 1.2, 0.09);
  } else {
    softTone(440.0, 0.24, 0.045, "sine", 0, 311.13);
  }
}

/** 記憶パルスの波紋音。 */
export function sfxDreamPulse(): void {
  softTone(220, 0.44, 0.055, "sine", 0, 330);
  softTone(330, 0.52, 0.038, "triangle", 0.06, 440);
  softNoise(0.26, 0.02, 860, 2.0, 0.02);
}

/** 深層へ潜行するときの低いドローンと沈み込むアルペジオ。 */
export function sfxDreamDescend(): void {
  softTone(146.83, 1.05, 0.075, "sine", 0, 98.0);
  softTone(293.66, 0.72, 0.048, "triangle", 0.1, 220.0);
  softTone(440.0, 0.62, 0.038, "sine", 0.22, 293.66);
  softNoise(0.55, 0.024, 480, 0.9, 0.05);
}

/** 影が接近しているときの低い心音（ドクン…ドクン…）。 */
export function sfxDreamHeartbeat(intensity: number): void {
  const v = Math.max(0.015, Math.min(0.11, 0.02 + intensity * 0.085));
  softTone(64, 0.16, v, "sine", 0, 34);
  softTone(56, 0.2, v * 0.78, "sine", 0.165, 30);
}

/** 懐中電灯の光錐に残響の影を捉えた瞬間の、冷たい不協和スティンガー。 */
export function sfxDreamStalkerSpot(): void {
  softTone(466.16, 0.62, 0.045, "triangle", 0, 448.0);
  softTone(493.88, 0.68, 0.04, "sine", 0.02, 476.0);
  softTone(92.5, 0.55, 0.055, "sine", 0, 68.0);
  softNoise(0.32, 0.028, 1950, 3.2, 0);
}

/** 影に呑み込まれて一段深い悪夢層へ引きずり込まれるときのノイズと沈下音。 */
export function sfxDreamConsumed(): void {
  softNoise(0.85, 0.085, 760, 0.7, 0);
  softNoise(0.65, 0.055, 2200, 1.4, 0.04);
  softTone(185.0, 1.25, 0.085, "sawtooth", 0, 44.0);
  softTone(196.0, 1.15, 0.065, "triangle", 0.04, 46.5);
  softTone(62.0, 1.4, 0.095, "sine", 0.08, 32.0);
}
