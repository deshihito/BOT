// AGO WORLD BOX の音響基盤（BGM + SE、全て Web Audio 合成・アセットなし）。
// 計算とデータ（曲の譜面・SE の対応表・場面の選択）は純粋ロジックとしてここに寄せ、
// 再生エンジンも同じファイルの後半に置く（balku-sound と同じ分担）。
//
// 音作りの方針（ユーザー指示 2026-11-15:「opus っぽい音はやめて」）:
// - 音声ファイルは使わない（.opus / .mp3 等のコーデック音源は滲み・劣化が
//   「opus っぽさ」の正体なので、最初から合成のみで作る）。
// - BALKU のようなサイン波パッドの wash（ローパスで曇らせた環境音）も使わない。
//   BGM は短く減衰する打鍵音（マリンバ風プラック）＋細い矩形波リード＋
//   ノイズのハットで組む、乾いたゲーム音にする。BGM バスにローパスは掛けない。
// - SE は素材の音（木・石・土・水）をノイズ＋短トーンで作り分ける。
// - BGM の譜面は決定的（乱数で生成しない）。同じ場面では常に同じループが流れる。

import type { FxBurstKind } from "./fx";

/* ================= 純粋ロジック: BGM の譜面 ================= */

/** BGM の場面。ワールド昼/夜、ロビー、カジノで曲が切り替わる。 */
export type WbBgmScene = "field-day" | "field-night" | "lobby" | "casino" | "cave" | "dungeon" | "ruins";

/**
 * 現在の状況から BGM の場面を決める。優先順位は カジノ > 屋内 > 夜 > 昼。
 * 屋内（ロビーとテント内装）は時刻に左右されずロビー曲にする。
 * night は daynight.ts の nightAmount（0=昼、1=真夜中）。
 */
export function bgmSceneFor(input: {
  space: string;
  night: number;
  casinoOpen: boolean;
}): WbBgmScene {
  if (input.casinoOpen) return "casino";
  if (input.space.startsWith("cave:")) return "cave";
  if (input.space.startsWith("dungeon:")) return "dungeon";
  if (input.space.startsWith("ruins:")) return "ruins";
  if (input.space !== "world") return "lobby";
  return input.night > 0.5 ? "field-night" : "field-day";
}

/** 1 曲の譜面。steps は 4 小節 × 8 ステップ（8 分音符）= 32。null は休符。 */
export type WbBgmTrack = {
  bpm: number;
  /** リード/ベースの基準音（度数 0 の周波数 Hz）。 */
  root: number;
  /** 音階（半音オフセット）。度数はこの配列へのインデックス。 */
  scale: number[];
  /** ベースライン（半音オフセット、root の 1 オクターブ下で鳴らす）。 */
  bass: (number | null)[];
  /** リード旋律（音階の度数インデックス）。 */
  lead: (number | null)[];
  /** ハットを打つステップ。 */
  hat: boolean[];
  /** キックを打つステップ。 */
  kick: boolean[];
};

export const BGM_STEPS = 32;

/** 半音オフセットから周波数を出す。 */
export function semitoneFreq(root: number, semitone: number): number {
  return root * Math.pow(2, semitone / 12);
}

/** 音階の度数インデックスから周波数を出す（範囲外は端に丸める）。 */
export function degreeFreq(track: WbBgmTrack, degree: number, octave = 0): number {
  const idx = Math.max(0, Math.min(track.scale.length - 1, Math.floor(degree)));
  return semitoneFreq(track.root, track.scale[idx] + octave * 12);
}

const MAJOR_PENT = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24];
const MINOR_PENT = [0, 3, 5, 7, 10, 12, 15, 17, 19, 22, 24];

function hatEvery(...steps: number[]): boolean[] {
  const hat = new Array<boolean>(BGM_STEPS).fill(false);
  for (const s of steps) hat[s % BGM_STEPS] = true;
  return hat;
}

function barSteps(perBar: number[]): boolean[] {
  const out = new Array<boolean>(BGM_STEPS).fill(false);
  for (let bar = 0; bar < 4; bar++) for (const s of perBar) out[bar * 8 + s] = true;
  return out;
}

/** バーごとに根音が変わるベースライン（各バー step0 と step4 に根音、step6 は 5 度）。 */
function bassLine(barRoots: number[]): (number | null)[] {
  const bass = new Array<number | null>(BGM_STEPS).fill(null);
  barRoots.forEach((rootSemi, bar) => {
    bass[bar * 8] = rootSemi;
    bass[bar * 8 + 4] = rootSemi;
    bass[bar * 8 + 6] = rootSemi + 7;
  });
  return bass;
}

export const BGM_TRACKS: Record<WbBgmScene, WbBgmTrack> = {
  // ワールド・昼: C メジャーペンタの明るいループ。進行 C–F–C–G。
  "field-day": {
    bpm: 104,
    root: 261.63, // C4
    scale: MAJOR_PENT,
    bass: bassLine([0, 5, 0, 7]),
    lead: [
      4, null, 2, null, 3, null, 2, null,
      1, null, 2, null, 3, null, null, null,
      4, null, 5, null, 4, 3, 2, null,
      3, null, 2, null, 1, null, 0, null,
    ],
    hat: barSteps([2, 6]),
    kick: barSteps([0, 4]),
  },
  // ワールド・夜: A マイナーペンタ。旋律は疎らに、ハットなし、キックなし。
  "field-night": {
    bpm: 76,
    root: 220.0, // A3
    scale: MINOR_PENT,
    bass: bassLine([0, 8, 3, 10]),
    lead: [
      4, null, null, null, 3, null, null, null,
      2, null, null, null, null, null, null, null,
      4, null, null, null, 5, null, 4, null,
      3, null, null, null, 2, null, null, null,
    ],
    hat: hatEvery(),
    kick: hatEvery(),
  },
  // ロビー: F メジャーペンタ。昼より少し落ち着いて、導線の邪魔をしない密度。
  lobby: {
    bpm: 96,
    root: 174.61, // F3（リードは 1 オクターブ上で鳴らす想定の基準）
    scale: MAJOR_PENT,
    bass: bassLine([0, 5, 0, 7]),
    lead: [
      2, null, 3, null, 4, null, null, null,
      3, null, 2, null, 1, null, 2, null,
      2, null, 3, null, 4, null, 5, null,
      4, null, 3, null, 2, null, null, null,
    ],
    hat: barSteps([1, 3, 5, 7]),
    kick: barSteps([0, 4]),
  },
  // 洞窟: A マイナーペンタの低音・疎な打音。深さの静けさ（ハット/キック無し）。
  cave: {
    bpm: 72,
    root: 220.0, // A3
    scale: MINOR_PENT,
    bass: bassLine([0, 3]),
    lead: [
      4, null, null, null, 3, null, null, null,
      null, null, 2, null, null, null, null, null,
      3, null, null, null, 4, null, null, 5,
      null, null, null, null, 2, null, null, null,
    ],
    hat: hatEvery(),
    kick: hatEvery(),
  },
  // ダンジョン: D マイナーペンタ。洞窟より速く、キックで緊張を刻む。
  dungeon: {
    bpm: 96,
    root: 146.83, // D3
    scale: MINOR_PENT,
    bass: bassLine([0, 0, 5, 3]),
    lead: [
      4, null, 4, null, 3, null, 2, null,
      4, null, null, null, 5, null, 4, 3,
      2, null, 2, null, 3, null, 4, null,
      null, null, 3, null, 2, null, null, null,
    ],
    hat: hatEvery(),
    kick: barSteps([0, 4]),
  },
  // 遺跡: E マイナーペンタ。洞窟より少し明るく、謎めいた疎な打音。キックなし。
  ruins: {
    bpm: 84,
    root: 164.81, // E3
    scale: MINOR_PENT,
    bass: bassLine([0, 10, 5, 8]),
    lead: [
      4, null, null, null, null, null, 3, null,
      null, null, 2, null, null, null, null, null,
      5, null, null, null, 4, null, null, null,
      3, null, null, null, 2, null, null, null,
    ],
    hat: barSteps([3, 7]),
    kick: hatEvery(),
  },
  // カジノ: D メジャーペンタ。速く跳ねるベースと毎ステップのハット。
  casino: {
    bpm: 132,
    root: 293.66, // D4
    scale: MAJOR_PENT,
    bass: (() => {
      const bass = new Array<number | null>(BGM_STEPS).fill(null);
      [0, 5, 7, 5].forEach((rootSemi, bar) => {
        for (const s of [0, 2, 4, 6]) bass[bar * 8 + s] = rootSemi + (s % 4 === 2 ? 12 : 0);
      });
      return bass;
    })(),
    lead: [
      4, 3, 4, null, 5, 4, 3, null,
      2, 3, 4, null, 3, 2, 1, null,
      4, 3, 4, null, 5, 6, 5, 4,
      3, null, 2, null, 1, null, 0, null,
    ],
    hat: barSteps([0, 1, 2, 3, 4, 5, 6, 7]),
    kick: barSteps([0, 2, 4, 6]),
  },
};

/** 場面ごとの「賑やかさ」（リードの音数）。夜が一番静かであることの検証用。 */
export function leadNoteCount(track: WbBgmTrack): number {
  return track.lead.filter((n) => n !== null).length;
}

/** 緊張レイヤーの条件（B3）: 敵対モブが近くにいるか、HP が 25% 以下。曲は変えず心拍だけ重ねる。 */
export function tensionFor(input: { hostileNear: boolean; hpFrac: number }): boolean {
  return input.hostileNear || input.hpFrac <= 0.25;
}

/* ================= 純粋ロジック: SE の語彙と対応表 ================= */

export type WbSeName =
  | "chop" | "mine" | "till" | "plant" | "harvest"
  | "place" | "build" | "debris" | "splash" | "step" | "dash" | "warp" | "poof"
  | "swing" | "hit" | "kill" | "hurt"
  | "coin" | "buy" | "sell" | "craft"
  | "open" | "close" | "click" | "error" | "success";

/** SE の優先度階層（sfx.ts と同じ配分: 勝敗・撃破 > ヒット > 行為 > 移動 > 刻み）。 */
export type WbSeTier = 1 | 2 | 3 | 4 | 5;

export const WB_SE_TIER_GAIN: Record<WbSeTier, number> = {
  1: 0.22, 2: 0.16, 3: 0.12, 4: 0.08, 5: 0.04,
};

export const WB_SE_TIERS: Record<WbSeName, WbSeTier> = {
  kill: 1, success: 1,
  hit: 2, hurt: 2, coin: 2, error: 2,
  chop: 3, mine: 3, till: 3, plant: 3, harvest: 3,
  place: 3, build: 3, debris: 3, splash: 3, warp: 3,
  buy: 3, sell: 3, craft: 3,
  swing: 4, dash: 4, poof: 4, open: 4, close: 4, click: 4,
  step: 5,
};

/** 同じ SE を連打しないための最小間隔（ms）。足音などの暴発防止。 */
export const WB_SE_MIN_INTERVAL_MS: Partial<Record<WbSeName, number>> = {
  step: 110,
  dash: 140,
  swing: 90,
  splash: 120,
};

/** fx.ts のバースト種別 → SE。演出の粒と音は同じイベントから出す。 */
export function seForFxBurst(kind: FxBurstKind): WbSeName {
  switch (kind) {
    case "death":
      return "kill";
    case "spawn":
      return "poof";
    case "hit":
      return "hit";
    default:
      return kind;
  }
}

/* ================= 設定（localStorage） ================= */

export type WbSoundSettings = { bgm: boolean; se: boolean };

const STORAGE_KEY = "worldbox-sound";
const SE_VOLUME = 0.9;
const BGM_VOLUME = 0.5;

let settings: WbSoundSettings = { bgm: true, se: true };
let settingsLoaded = false;

export function loadWbSoundSettings(): WbSoundSettings {
  if (settingsLoaded) return settings;
  settingsLoaded = true;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<WbSoundSettings>;
      settings = { bgm: parsed.bgm !== false, se: parsed.se !== false };
    }
  } catch {
    // 読めなければデフォルト（両方 ON）のまま
  }
  return settings;
}

export function saveWbSoundSettings(next: WbSoundSettings): void {
  settings = next;
  settingsLoaded = true;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // 保存できなくても再生は続けられる
  }
  applySettings();
}

/* ================= 再生エンジン（クライアント専用） ================= */

let ctx: AudioContext | null = null;
let seBus: GainNode | null = null;
/** マスターバス（B3）: SE と BGM（各声）をここで統一してから出力へ出す。 */
let masterBus: GainNode | null = null;

/** 場面遷移のクロスフェード時間（ms）。旧声を絞りつつ新声を上げる。 */
export const BGM_CROSSFADE_MS = 1200;

function ensureCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    masterBus = ctx.createGain();
    masterBus.gain.value = 1;
    masterBus.connect(ctx.destination);
    seBus = ctx.createGain();
    seBus.gain.value = settings.se ? SE_VOLUME : 0;
    seBus.connect(masterBus);
  }
  if (ctx.state === "suspended") void ctx.resume().catch(() => {});
  return ctx;
}

/** 最初のユーザー操作で呼ぶ。Context を作り、場面が決まっていれば BGM を回し始める。 */
export function unlockWbAudio(): void {
  loadWbSoundSettings();
  if (!ensureCtx()) return;
  if (settings.bgm && currentScene && !activeVoice) startVoice(currentScene);
}

function applySettings(): void {
  if (!ctx || !seBus) return;
  seBus.gain.setTargetAtTime(settings.se ? SE_VOLUME : 0, ctx.currentTime, 0.03);
  if (settings.bgm) {
    if (currentScene && !activeVoice) startVoice(currentScene);
  } else {
    // 場面は覚えたまま止める（再び ON にしたら同じ場面から再開できる）
    fadeOutVoice(activeVoice);
    activeVoice = null;
  }
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
  osc.type = opts.type ?? "triangle";
  osc.frequency.setValueAtTime(Math.max(20, opts.freq), t);
  if (opts.freqEnd) osc.frequency.exponentialRampToValueAtTime(Math.max(20, opts.freqEnd), t + opts.dur);
  const peak = opts.gain ?? 0.2;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t + opts.dur);
  osc.connect(g);
  g.connect(opts.dest ?? seBus);
  osc.start(t);
  osc.stop(t + opts.dur + 0.05);
}

let noiseBuffer: AudioBuffer | null = null;

function noise(opts: {
  dur: number;
  gain?: number;
  at?: number;
  type?: BiquadFilterType;
  filterFrom?: number;
  filterTo?: number;
  dest?: AudioNode;
}): void {
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
  filter.type = opts.type ?? "bandpass";
  filter.Q.value = 0.9;
  filter.frequency.setValueAtTime(opts.filterFrom ?? 1800, t);
  if (opts.filterTo) filter.frequency.exponentialRampToValueAtTime(Math.max(30, opts.filterTo), t + opts.dur);
  const g = ctx.createGain();
  const peak = opts.gain ?? 0.16;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t + opts.dur);
  src.connect(filter);
  filter.connect(g);
  g.connect(opts.dest ?? seBus);
  src.start(t, Math.random() * 0.4);
  src.stop(t + opts.dur + 0.05);
}

/** 打鍵音（マリンバ風）: 三角波＋倍音の短い減衰。BGM のリードは全部これで鳴らす。 */
function pluck(freq: number, at: number, gain: number, dest: AudioNode, dur = 0.32): void {
  if (!ctx) return;
  tone({ freq, dur, type: "triangle", gain, at, dest });
  tone({ freq: freq * 2, dur: dur * 0.5, type: "sine", gain: gain * 0.35, at, dest });
}

/* --- SE レシピ（素材の音を作り分ける） --- */

function tierGain(name: WbSeName, local = 1): number {
  return WB_SE_TIER_GAIN[WB_SE_TIERS[name]] * local;
}

const SE_RECIPES: Record<WbSeName, (t: number) => void> = {
  // 木を打つ: 低い木の響き＋繊維のバリッというノイズ
  chop: (t) => {
    tone({ freq: 190, freqEnd: 90, dur: 0.1, type: "triangle", gain: tierGain("chop", 1.4), at: t });
    noise({ dur: 0.09, gain: tierGain("chop"), at: t, type: "lowpass", filterFrom: 1100 });
  },
  // 石を打つ: 金属っぽい高音の欠け＋硬いノック
  mine: (t) => {
    tone({ freq: 2350, dur: 0.05, type: "square", gain: tierGain("mine", 0.5), at: t });
    tone({ freq: 320, freqEnd: 140, dur: 0.07, type: "triangle", gain: tierGain("mine", 1.2), at: t });
    noise({ dur: 0.05, gain: tierGain("mine", 0.8), at: t, type: "highpass", filterFrom: 2800 });
  },
  // 土を耕す: 柔らかい低域ノイズのこすれ
  till: (t) => {
    noise({ dur: 0.16, gain: tierGain("till", 1.3), at: t, type: "lowpass", filterFrom: 620, filterTo: 300 });
    tone({ freq: 120, freqEnd: 70, dur: 0.12, type: "sine", gain: tierGain("till"), at: t });
  },
  // 植える: 土の小さな音＋若葉の2音
  plant: (t) => {
    noise({ dur: 0.08, gain: tierGain("plant"), at: t, type: "lowpass", filterFrom: 800 });
    tone({ freq: 660, dur: 0.09, type: "triangle", gain: tierGain("plant", 0.8), at: t + 0.05 });
    tone({ freq: 880, dur: 0.12, type: "triangle", gain: tierGain("plant", 0.8), at: t + 0.11 });
  },
  // 収穫: ペンタの3音アルペジオ（実りの払い戻し）
  harvest: (t) => {
    [523.25, 659.25, 783.99].forEach((f, i) =>
      tone({ freq: f, dur: 0.14, type: "triangle", gain: tierGain("harvest"), at: t + i * 0.055 }));
  },
  // 設置: 収まるドスッ＋土煙
  place: (t) => {
    tone({ freq: 165, freqEnd: 80, dur: 0.11, type: "sine", gain: tierGain("place", 1.5), at: t });
    noise({ dur: 0.09, gain: tierGain("place", 0.8), at: t, type: "lowpass", filterFrom: 900 });
  },
  // 建築: 木/石のノック2発＋確定音
  build: (t) => {
    tone({ freq: 210, freqEnd: 110, dur: 0.07, type: "triangle", gain: tierGain("build", 1.2), at: t });
    tone({ freq: 180, freqEnd: 95, dur: 0.08, type: "triangle", gain: tierGain("build", 1.2), at: t + 0.09 });
    tone({ freq: 523, dur: 0.12, type: "triangle", gain: tierGain("build", 0.7), at: t + 0.18 });
  },
  // 破壊: 破片の散り＋落下
  debris: (t) => {
    noise({ dur: 0.18, gain: tierGain("debris", 1.2), at: t, filterFrom: 1600, filterTo: 400 });
    tone({ freq: 240, freqEnd: 60, dur: 0.2, type: "triangle", gain: tierGain("debris"), at: t + 0.02 });
  },
  // 水: バンドパスのうねり＋水滴2つ
  splash: (t) => {
    noise({ dur: 0.22, gain: tierGain("splash", 1.2), at: t, filterFrom: 900, filterTo: 2400 });
    tone({ freq: 740, freqEnd: 1180, dur: 0.07, type: "sine", gain: tierGain("splash", 0.6), at: t + 0.06 });
    tone({ freq: 620, freqEnd: 990, dur: 0.07, type: "sine", gain: tierGain("splash", 0.5), at: t + 0.13 });
  },
  // 足音: ごく小さい土ぼこりの音（tier5）
  step: (t) => {
    noise({ dur: 0.05, gain: tierGain("step", 1.4), at: t, type: "lowpass", filterFrom: 700 });
  },
  // ダッシュ: 風の筋
  dash: (t) => {
    noise({ dur: 0.16, gain: tierGain("dash", 1.4), at: t, filterFrom: 500, filterTo: 2100 });
  },
  // ワープ: 矩形波の速い上昇アルペジオ（乾いた電子音）
  warp: (t) => {
    [440, 587, 880, 1175].forEach((f, i) =>
      tone({ freq: f, dur: 0.09, type: "square", gain: tierGain("warp", 0.45), at: t + i * 0.045 }));
  },
  // 消滅: 煙のプフ
  poof: (t) => {
    noise({ dur: 0.14, gain: tierGain("poof", 1.2), at: t, type: "lowpass", filterFrom: 1000, filterTo: 300 });
  },
  // 振り: 風切り（下がるスイープ）
  swing: (t) => {
    noise({ dur: 0.11, gain: tierGain("swing", 1.6), at: t, filterFrom: 3200, filterTo: 700 });
  },
  // 命中: 芯のある打撃
  hit: (t) => {
    tone({ freq: 210, freqEnd: 65, dur: 0.12, type: "triangle", gain: tierGain("hit", 1.3), at: t });
    noise({ dur: 0.06, gain: tierGain("hit", 0.8), at: t, filterFrom: 2400 });
  },
  // 撃破: 打撃＋下降フレーズ＋きらめき
  kill: (t) => {
    tone({ freq: 160, freqEnd: 40, dur: 0.3, type: "sine", gain: tierGain("kill", 1.2), at: t });
    noise({ dur: 0.2, gain: tierGain("kill", 0.8), at: t, type: "lowpass", filterFrom: 900 });
    tone({ freq: 784, dur: 0.1, type: "triangle", gain: tierGain("kill", 0.6), at: t + 0.08 });
    tone({ freq: 1047, dur: 0.16, type: "triangle", gain: tierGain("kill", 0.6), at: t + 0.15 });
  },
  // 被弾: 低い矩形のうなり
  hurt: (t) => {
    tone({ freq: 150, freqEnd: 90, dur: 0.16, type: "square", gain: tierGain("hurt", 0.7), at: t });
  },
  // コイン: 定番の2音
  coin: (t) => {
    tone({ freq: 2093, dur: 0.08, type: "sine", gain: tierGain("coin", 0.8), at: t });
    tone({ freq: 2637, dur: 0.14, type: "sine", gain: tierGain("coin", 0.8), at: t + 0.05 });
  },
  buy: (t) => {
    tone({ freq: 2093, dur: 0.08, type: "sine", gain: tierGain("buy", 0.8), at: t });
    tone({ freq: 2637, dur: 0.14, type: "sine", gain: tierGain("buy", 0.8), at: t + 0.05 });
    tone({ freq: 784, dur: 0.12, type: "triangle", gain: tierGain("buy", 0.7), at: t + 0.12 });
  },
  sell: (t) => {
    tone({ freq: 784, dur: 0.1, type: "triangle", gain: tierGain("sell", 0.8), at: t });
    tone({ freq: 2093, dur: 0.08, type: "sine", gain: tierGain("sell", 0.7), at: t + 0.09 });
    tone({ freq: 2637, dur: 0.13, type: "sine", gain: tierGain("sell", 0.7), at: t + 0.14 });
  },
  // 合成: ノック＋完成のプラック
  craft: (t) => {
    tone({ freq: 200, freqEnd: 110, dur: 0.07, type: "triangle", gain: tierGain("craft", 1.2), at: t });
    tone({ freq: 659, dur: 0.12, type: "triangle", gain: tierGain("craft", 0.8), at: t + 0.09 });
    tone({ freq: 880, dur: 0.16, type: "triangle", gain: tierGain("craft", 0.8), at: t + 0.17 });
  },
  open: (t) => {
    tone({ freq: 587, dur: 0.07, type: "triangle", gain: tierGain("open"), at: t });
    tone({ freq: 880, dur: 0.1, type: "triangle", gain: tierGain("open", 0.9), at: t + 0.05 });
  },
  close: (t) => {
    tone({ freq: 880, dur: 0.06, type: "triangle", gain: tierGain("close"), at: t });
    tone({ freq: 587, dur: 0.09, type: "triangle", gain: tierGain("close", 0.9), at: t + 0.04 });
  },
  click: (t) => {
    tone({ freq: 1050, dur: 0.035, type: "square", gain: tierGain("click", 0.7), at: t });
  },
  error: (t) => {
    tone({ freq: 165, dur: 0.11, type: "square", gain: tierGain("error", 0.6), at: t });
    tone({ freq: 165, dur: 0.15, type: "square", gain: tierGain("error", 0.6), at: t + 0.14 });
  },
  // 成功ジングル: ペンタ4音
  success: (t) => {
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) =>
      tone({ freq: f, dur: 0.18, type: "triangle", gain: tierGain("success", 0.8), at: t + i * 0.07 }));
  },
};

const lastPlayedAt = new Map<WbSeName, number>();

export function playWbSe(name: WbSeName): void {
  loadWbSoundSettings();
  if (!settings.se || !ctx || !seBus) return;
  const minInterval = WB_SE_MIN_INTERVAL_MS[name];
  if (minInterval) {
    const now = performance.now();
    const last = lastPlayedAt.get(name) ?? 0;
    if (now - last < minInterval) return;
    lastPlayedAt.set(name, now);
  }
  try {
    if (ctx.state === "suspended") void ctx.resume().catch(() => {});
    SE_RECIPES[name](ctx.currentTime + 0.01);
  } catch {
    // 音が出ない環境でもゲームは止めない
  }
}

/* --- BGM シーケンサ（決定的ループ、ルックアヘッド方式） --- */

/** 再生すべき場面（希望）。AudioContext が無くても保持する。 */
let currentScene: WbBgmScene | null = null;
/** BGM の1声: 場面ごとのバス＋シーケンサ。クロスフェード中は2声が重なる。 */
type BgmVoice = {
  scene: WbBgmScene;
  gain: GainNode;
  timer: ReturnType<typeof setInterval> | null;
  step: number;
  nextStepAt: number;
};
let activeVoice: BgmVoice | null = null;
/** 緊張レイヤー（心拍）の ON/OFF。クライアントが 1 秒ごとに更新する。 */
let tensionOn = false;
let bgmWasPlayingBeforeHidden = false;

/** 緊張レイヤーの ON/OFF。次のステップから心拍が重なる。 */
export function setWbBgmTension(on: boolean): void {
  tensionOn = on;
}

/** 緊張レイヤーが今 ON か（テスト/表示用）。 */
export function currentWbBgmTension(): boolean {
  return tensionOn;
}

function scheduleStep(track: WbBgmTrack, step: number, at: number, dest: AudioNode, tension: boolean): void {
  if (!ctx) return;
  const bassSemi = track.bass[step];
  if (bassSemi !== null) {
    tone({ freq: semitoneFreq(track.root / 2, bassSemi), dur: 0.34, type: "triangle", gain: 0.16, at, dest });
  }
  const leadDegree = track.lead[step];
  if (leadDegree !== null) {
    pluck(degreeFreq(track, leadDegree), at, 0.14, dest);
  }
  if (track.hat[step]) {
    noise({ dur: 0.03, gain: 0.028, at, type: "highpass", filterFrom: 6500, dest });
  }
  if (track.kick[step]) {
    tone({ freq: 120, freqEnd: 42, dur: 0.12, type: "sine", gain: 0.2, at, dest });
  }
  // 緊張レイヤー: 1小節に2打の低い心拍（lub-dub）。曲そのものは変えない。
  // 短い減衰のサイン波サンプで、パッド wash でもローパスでもない。
  if (tension) {
    if (step % 8 === 0) {
      tone({ freq: 92, freqEnd: 44, dur: 0.16, type: "sine", gain: 0.2, at, dest });
    } else if (step % 8 === 3) {
      tone({ freq: 82, freqEnd: 40, dur: 0.13, type: "sine", gain: 0.14, at, dest });
    }
  }
}

function startVoice(scene: WbBgmScene): void {
  if (!ctx || !masterBus) return;
  const track = BGM_TRACKS[scene];
  const gain = ctx.createGain();
  gain.gain.value = 0;
  gain.connect(masterBus);
  const voice: BgmVoice = { scene, gain, timer: null, step: 0, nextStepAt: ctx.currentTime + 0.06 };
  const stepSec = 60 / track.bpm / 2;
  voice.timer = setInterval(() => {
    if (!ctx) return;
    // タイマーが遅れた分は飛ばす（過去のステップを束で鳴らさない）。
    // step を進めて位相を保つので、ループの継ぎ目で段差が出ない。
    if (voice.nextStepAt < ctx.currentTime - stepSec) {
      const missed = Math.ceil((ctx.currentTime - voice.nextStepAt) / stepSec);
      voice.step += missed;
      voice.nextStepAt += missed * stepSec;
    }
    while (voice.nextStepAt < ctx.currentTime + 0.28) {
      scheduleStep(track, voice.step % BGM_STEPS, voice.nextStepAt, voice.gain, tensionOn);
      voice.step += 1;
      voice.nextStepAt += stepSec;
    }
  }, 110);
  // 新声は 0 から立ち上げる（クロスフェードの上がり側。BGM バスにローパスは掛けない）。
  gain.gain.setTargetAtTime(BGM_VOLUME, ctx.currentTime, BGM_CROSSFADE_MS / 3000);
  activeVoice = voice;
}

function fadeOutVoice(voice: BgmVoice | null): void {
  if (!voice || !ctx) return;
  if (voice.timer) {
    clearInterval(voice.timer);
    voice.timer = null;
  }
  voice.gain.gain.setTargetAtTime(0, ctx.currentTime, BGM_CROSSFADE_MS / 3000);
  // フェードが終わったらバスを外す（次の切替で古い声が残らない）。
  const gain = voice.gain;
  setTimeout(() => {
    try {
      gain.disconnect();
    } catch {
      // 既に外れていてもよい
    }
  }, BGM_CROSSFADE_MS + 400);
}

export function stopWbBgm(): void {
  fadeOutVoice(activeVoice);
  activeVoice = null;
  currentScene = null;
}

/** 場面を切り替える。同じ場面なら何もしない。null で停止。旧声を絞りつつ新声を上げるクロスフェード。 */
export function setWbBgmScene(scene: WbBgmScene | null): void {
  loadWbSoundSettings();
  if (scene === currentScene) return;
  if (scene === null) {
    stopWbBgm();
    return;
  }
  currentScene = scene;
  if (!settings.bgm || !ctx || !masterBus) return;
  fadeOutVoice(activeVoice);
  activeVoice = null;
  startVoice(scene);
}

/** 現在の BGM 場面（テスト/表示用）。 */
export function currentWbBgmScene(): WbBgmScene | null {
  return currentScene;
}

// 非表示タブでは BGM を止め、戻ったらミュートでなければ再開する
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      bgmWasPlayingBeforeHidden = activeVoice !== null;
      fadeOutVoice(activeVoice);
      activeVoice = null;
    } else if (bgmWasPlayingBeforeHidden) {
      bgmWasPlayingBeforeHidden = false;
      if (settings.bgm && currentScene && ctx) startVoice(currentScene);
    }
  });
}
