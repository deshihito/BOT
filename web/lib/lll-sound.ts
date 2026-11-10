// LLL のサウンドエンジン（クライアント専用）。
// アセットファイルは使わず、SE も BGM も全て Web Audio で合成する。
// SE は「カードをめくる・鑑定スタンプ・被弾・回復」といった手触りの音を
// 短く作り、BGM は工房の静かな午後をイメージしたパッド＋プラックの
// 簡易シーケンサで回す。AudioContext は最初のユーザー操作で初期化し、
// 設定（BGM / SE の個別ミュート）は localStorage の "lll-sound" に保存する。

export type LllSeName =
  | "tap"
  | "flip"
  | "stamp"
  | "hit"
  | "heal"
  | "win"
  | "lose"
  | "levelup"
  | "error"
  | "coin";

export type SoundSettings = { bgm: boolean; se: boolean };

const STORAGE_KEY = "lll-sound";
const SE_VOLUME = 0.35;
const BGM_VOLUME = 0.15;

let settings: SoundSettings = { bgm: true, se: true };
let settingsLoaded = false;

export function loadSoundSettings(): SoundSettings {
  if (settingsLoaded) return settings;
  settingsLoaded = true;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<SoundSettings>;
      settings = { bgm: parsed.bgm !== false, se: parsed.se !== false };
    }
  } catch {
    // 読めなければデフォルト（両方 ON）のまま
  }
  return settings;
}

export function saveSoundSettings(next: SoundSettings): void {
  settings = next;
  settingsLoaded = true;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // 保存できなくても再生は続けられる
  }
  applySettings();
}

/* --- AudioContext と出力段 --- */

let ctx: AudioContext | null = null;
let seBus: GainNode | null = null;
let bgmBus: GainNode | null = null;
let bgmFilter: BiquadFilterNode | null = null;

function ensureCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    seBus = ctx.createGain();
    seBus.gain.value = settings.se ? SE_VOLUME : 0;
    seBus.connect(ctx.destination);
    bgmBus = ctx.createGain();
    bgmBus.gain.value = 0;
    bgmFilter = ctx.createBiquadFilter();
    bgmFilter.type = "lowpass";
    bgmFilter.frequency.value = 820;
    bgmFilter.connect(bgmBus);
    bgmBus.connect(ctx.destination);
  }
  if (ctx.state === "suspended") void ctx.resume().catch(() => {});
  return ctx;
}

/** 最初のユーザー操作で呼ぶ。Context を作り、BGM が有効なら回し始める。 */
export function unlockAudio(): void {
  loadSoundSettings();
  if (!ensureCtx()) return;
  if (settings.bgm) startBgm();
}

function applySettings(): void {
  if (!ctx || !seBus || !bgmBus) return;
  const t = ctx.currentTime;
  seBus.gain.setTargetAtTime(settings.se ? SE_VOLUME : 0, t, 0.03);
  if (settings.bgm) startBgm();
  else stopBgm();
}

/* --- 合成の部品 --- */

function tone(opts: {
  freq: number;
  freqEnd?: number;
  dur: number;
  type?: OscillatorType;
  gain?: number;
  at?: number;
  dest?: AudioNode;
}): void {
  if (!ctx || !seBus) return;
  const t = opts.at ?? ctx.currentTime;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = opts.type ?? "sine";
  osc.frequency.setValueAtTime(Math.max(20, opts.freq), t);
  if (opts.freqEnd) osc.frequency.exponentialRampToValueAtTime(Math.max(20, opts.freqEnd), t + opts.dur);
  const peak = opts.gain ?? 0.22;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t + opts.dur);
  osc.connect(g);
  g.connect(opts.dest ?? seBus);
  osc.start(t);
  osc.stop(t + opts.dur + 0.05);
}

let noiseBuffer: AudioBuffer | null = null;
function noise(opts: { dur: number; gain?: number; at?: number; filterFrom?: number; filterTo?: number }): void {
  if (!ctx || !seBus) return;
  const t = opts.at ?? ctx.currentTime;
  if (!noiseBuffer) {
    noiseBuffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer;
  src.loop = true;
  const filter = ctx.createBiquadFilter();
  filter.type = "bandpass";
  filter.Q.value = 0.9;
  filter.frequency.setValueAtTime(opts.filterFrom ?? 1800, t);
  if (opts.filterTo) filter.frequency.exponentialRampToValueAtTime(opts.filterTo, t + opts.dur);
  const g = ctx.createGain();
  const peak = opts.gain ?? 0.16;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, t + opts.dur);
  src.connect(filter);
  filter.connect(g);
  g.connect(seBus);
  src.start(t, Math.random() * 0.4);
  src.stop(t + opts.dur + 0.05);
}

/* --- SE レシピ --- */

const SE_RECIPES: Record<LllSeName, (t: number) => void> = {
  tap: (t) => tone({ freq: 980, dur: 0.045, type: "square", gain: 0.07, at: t }),
  flip: (t) => {
    noise({ dur: 0.12, gain: 0.15, at: t, filterFrom: 800, filterTo: 2800 });
    tone({ freq: 480, freqEnd: 920, dur: 0.1, type: "sine", gain: 0.07, at: t + 0.03 });
  },
  stamp: (t) => {
    tone({ freq: 150, freqEnd: 70, dur: 0.16, type: "sine", gain: 0.26, at: t });
    noise({ dur: 0.06, gain: 0.12, at: t, filterFrom: 1400, filterTo: 500 });
    tone({ freq: 1245, dur: 0.09, type: "sine", gain: 0.1, at: t + 0.09 });
    tone({ freq: 1865, dur: 0.12, type: "sine", gain: 0.08, at: t + 0.13 });
  },
  hit: (t) => {
    noise({ dur: 0.09, gain: 0.2, at: t, filterFrom: 2600, filterTo: 700 });
    tone({ freq: 190, freqEnd: 90, dur: 0.11, type: "triangle", gain: 0.2, at: t + 0.01 });
  },
  heal: (t) => {
    [523, 659, 784].forEach((f, i) => tone({ freq: f, dur: 0.18, type: "sine", gain: 0.11, at: t + i * 0.06 }));
    tone({ freq: 1047, dur: 0.26, type: "sine", gain: 0.08, at: t + 0.19 });
  },
  win: (t) => {
    [523, 659, 784, 1047].forEach((f, i) => tone({ freq: f, dur: 0.34, type: "triangle", gain: 0.15, at: t + i * 0.11 }));
    tone({ freq: 1319, dur: 0.5, type: "triangle", gain: 0.13, at: t + 0.46 });
    tone({ freq: 1568, dur: 0.7, type: "sine", gain: 0.09, at: t + 0.6 });
  },
  lose: (t) => {
    [392, 370, 349, 311].forEach((f, i) => tone({ freq: f, dur: 0.3, type: "triangle", gain: 0.12, at: t + i * 0.13 }));
    tone({ freq: 156, dur: 0.6, type: "sine", gain: 0.1, at: t + 0.55 });
  },
  levelup: (t) => {
    [523, 659, 784, 1047, 1319].forEach((f, i) => tone({ freq: f, dur: 0.16, type: "triangle", gain: 0.13, at: t + i * 0.055 }));
    tone({ freq: 2093, dur: 0.22, type: "sine", gain: 0.08, at: t + 0.3 });
  },
  error: (t) => {
    tone({ freq: 185, dur: 0.13, type: "square", gain: 0.1, at: t });
    tone({ freq: 185, dur: 0.18, type: "square", gain: 0.1, at: t + 0.17 });
  },
  coin: (t) => {
    tone({ freq: 2093, dur: 0.09, type: "sine", gain: 0.14, at: t });
    tone({ freq: 2637, dur: 0.12, type: "sine", gain: 0.12, at: t + 0.055 });
  },
};

export function playSe(name: LllSeName): void {
  loadSoundSettings();
  if (!settings.se || !ctx || !seBus) return;
  try {
    if (ctx.state === "suspended") void ctx.resume().catch(() => {});
    SE_RECIPES[name](ctx.currentTime + 0.01);
  } catch {
    // 音が出ない環境でもゲームは止めない
  }
}

/* --- BGM シーケンサ（穏やかなパッド＋sparse なプラック） --- */

const BAR_SEC = 5.2;
// Cmaj7 – Am7 – Dm7 – G7
const CHORDS: number[][] = [
  [130.81, 164.81, 196.0, 246.94],
  [110.0, 130.81, 164.81, 196.0],
  [146.83, 174.61, 220.0, 261.63],
  [98.0, 123.47, 146.83, 174.61],
];
const PLUCK_SCALE = [261.63, 293.66, 329.63, 392.0, 440.0, 523.25];

let bgmTimer: ReturnType<typeof setInterval> | null = null;
let bgmNextBarAt = 0;
let bgmChordIndex = 0;
let bgmWasPlayingBeforeHidden = false;

function pad(freq: number, at: number, dur: number): void {
  if (!ctx || !bgmFilter) return;
  for (const [type, detune] of [
    ["sine", 0],
    ["triangle", 4],
  ] as const) {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    osc.detune.value = detune;
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(0.03, at + 1.6);
    g.gain.setValueAtTime(0.03, at + dur - 1.7);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    osc.connect(g);
    g.connect(bgmFilter);
    osc.start(at);
    osc.stop(at + dur + 0.05);
  }
}

function pluck(freq: number, at: number): void {
  if (!ctx || !bgmFilter) return;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = "triangle";
  osc.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(0.04, at + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, at + 1.0);
  osc.connect(g);
  g.connect(bgmFilter);
  osc.start(at);
  osc.stop(at + 1.1);
}

function scheduleBar(): void {
  if (!ctx) return;
  const at = Math.max(ctx.currentTime + 0.06, bgmNextBarAt);
  const chord = CHORDS[bgmChordIndex % CHORDS.length];
  bgmChordIndex += 1;
  for (const freq of chord) pad(freq, at, BAR_SEC + 0.4);
  // 1.3秒グリッドで、たまにだけプラックを置く（C メジャーペンタトニック）
  for (let step = 0; step < 4; step++) {
    if (Math.random() < 0.3) {
      const freq = PLUCK_SCALE[Math.floor(Math.random() * PLUCK_SCALE.length)];
      pluck(freq, at + step * 1.3 + 0.1);
    }
  }
  bgmNextBarAt = at + BAR_SEC;
}

export function startBgm(): void {
  loadSoundSettings();
  if (!settings.bgm || !ctx || !bgmBus) return;
  if (bgmTimer) return;
  bgmBus.gain.setTargetAtTime(BGM_VOLUME, ctx.currentTime, 0.4);
  bgmNextBarAt = ctx.currentTime + 0.08;
  bgmChordIndex = 0;
  scheduleBar();
  bgmTimer = setInterval(() => {
    if (ctx && bgmNextBarAt < ctx.currentTime + 1.4) scheduleBar();
  }, 400);
}

export function stopBgm(): void {
  if (bgmTimer) {
    clearInterval(bgmTimer);
    bgmTimer = null;
  }
  if (ctx && bgmBus) bgmBus.gain.setTargetAtTime(0, ctx.currentTime, 0.15);
}

// 非表示タブでは BGM を止め、戻ったらミュートでなければ再開する
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      bgmWasPlayingBeforeHidden = bgmTimer !== null;
      stopBgm();
    } else if (bgmWasPlayingBeforeHidden) {
      bgmWasPlayingBeforeHidden = false;
      if (settings.bgm) startBgm();
    }
  });
}
