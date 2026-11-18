"use client";
import { useEffect, useRef, useState } from "react";

type JukeboxPreset = {
  id: string;
  title: string;
  subtitle: string;
  bpm: number;
  wave: OscillatorType;
  grid: boolean[][]; // [pitch 0..4 (high->low)][step 0..7]
};

const PITCH_NAMES = ["C5", "A4", "G4", "E4", "C4"];
const PITCH_FREQS = [523.25, 440.0, 392.0, 329.63, 261.63];

const PRESETS: readonly JukeboxPreset[] = [
  {
    id: "parade",
    title: "スターライト・パレード",
    subtitle: "遊園地＆中央アトリウムの華やかなテーマ曲",
    bpm: 128,
    wave: "triangle",
    grid: [
      [false, false, true, false, false, true, false, true],
      [false, true, false, false, true, false, true, false],
      [true, false, false, true, false, false, false, false],
      [false, false, false, false, false, false, true, false],
      [true, false, false, false, true, false, false, false],
    ],
  },
  {
    id: "carousel",
    title: "時計仕掛けのメリーゴーランド",
    subtitle: "デパート吹抜に響くオルゴール調ワルツ",
    bpm: 110,
    wave: "sine",
    grid: [
      [false, false, true, false, false, false, true, false],
      [false, true, false, true, false, true, false, false],
      [true, false, false, false, true, false, false, true],
      [false, false, true, false, false, false, false, false],
      [true, false, false, false, false, false, true, false],
    ],
  },
  {
    id: "underground",
    title: "深夜の地下モール",
    subtitle: "バックヤードと秘密通路のミステリアスなビート",
    bpm: 102,
    wave: "square",
    grid: [
      [false, false, false, true, false, false, false, false],
      [false, false, true, false, false, true, false, false],
      [false, true, false, false, false, false, true, false],
      [true, false, false, false, true, false, false, true],
      [true, false, true, false, true, false, false, false],
    ],
  },
  {
    id: "mystery",
    title: "霧の秘宝迷宮",
    subtitle: "VIPラウンジ＆秘密書庫で流れるレトロ電子音",
    bpm: 140,
    wave: "sawtooth",
    grid: [
      [true, false, false, true, false, true, false, true],
      [false, true, false, false, true, false, true, false],
      [false, false, true, false, false, false, false, true],
      [true, false, false, false, false, true, false, false],
      [false, false, true, false, true, false, false, false],
    ],
  },
];

function cloneGrid(g: boolean[][]): boolean[][] {
  return g.map((row) => [...row]);
}

const wrap: React.CSSProperties = {
  position: "absolute",
  left: "50%",
  top: "50%",
  transform: "translate(-50%, -50%)",
  width: "min(540px, calc(100% - 20px))",
  maxHeight: "calc(100% - 24px)",
  overflowY: "auto",
  padding: 14,
  borderRadius: 14,
  background: "rgba(12,14,22,0.95)",
  border: "1px solid rgba(130,190,255,0.3)",
  color: "#f4f6fc",
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

export default function WorldBoxJukeboxPanel({ onClose }: { onClose: () => void }) {
  const [presetIdx, setPresetIdx] = useState(0);
  const [bpm, setBpm] = useState(PRESETS[0].bpm);
  const [wave, setWave] = useState<OscillatorType>(PRESETS[0].wave);
  const [grid, setGrid] = useState<boolean[][]>(() => cloneGrid(PRESETS[0].grid));
  const [playing, setPlaying] = useState(false);
  const [step, setStep] = useState(0);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const gridRef = useRef(grid);
  gridRef.current = grid;
  const waveRef = useRef(wave);
  waveRef.current = wave;

  const ensureCtx = () => {
    if (typeof window === "undefined") return null;
    if (!audioCtxRef.current) {
      const Ctor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (Ctor) audioCtxRef.current = new Ctor();
    }
    if (audioCtxRef.current && audioCtxRef.current.state === "suspended") {
      void audioCtxRef.current.resume().catch(() => {});
    }
    return audioCtxRef.current;
  };

  const playNote = (pitchIdx: number) => {
    const ctx = ensureCtx();
    if (!ctx) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = waveRef.current;
    osc.frequency.setValueAtTime(PITCH_FREQS[pitchIdx] ?? 440, t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.08, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    osc.connect(g);
    g.connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.22);
  };

  useEffect(() => {
    if (!playing) return;
    const intervalMs = Math.max(90, Math.round(60_000 / bpm / 2));
    const id = window.setInterval(() => {
      setStep((prev) => {
        const next = (prev + 1) % 8;
        const g = gridRef.current;
        for (let r = 0; r < g.length; r++) {
          if (g[r][next]) playNote(r);
        }
        return next;
      });
    }, intervalMs);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, bpm]);

  useEffect(() => {
    return () => {
      const ctx = audioCtxRef.current;
      audioCtxRef.current = null;
      if (ctx) void ctx.close().catch(() => {});
    };
  }, []);

  const selectPreset = (idx: number) => {
    const p = PRESETS[idx];
    setPresetIdx(idx);
    setBpm(p.bpm);
    setWave(p.wave);
    setGrid(cloneGrid(p.grid));
    setStep(0);
  };

  const toggleCell = (r: number, c: number) => {
    setGrid((prev) => {
      const copy = cloneGrid(prev);
      copy[r][c] = !copy[r][c];
      if (copy[r][c]) playNote(r);
      return copy;
    });
  };

  return (
    <div style={wrap} className="wb-panel">
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
        <strong style={{ fontSize: 15 }}>🎵 スターライト・ジュークボックス</strong>
        <span style={{ flex: 1 }} />
        <button type="button" style={btn} onClick={onClose}>
          閉じる
        </button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginBottom: 10 }}>
        {PRESETS.map((p, idx) => (
          <button
            key={p.id}
            type="button"
            onClick={() => selectPreset(idx)}
            style={{
              ...btn,
              textAlign: "left",
              padding: "6px 10px",
              background: presetIdx === idx ? "rgba(95,165,255,0.28)" : "rgba(255,255,255,0.06)",
              borderColor: presetIdx === idx ? "#7cc0ff" : "rgba(255,255,255,0.16)",
            }}
          >
            <div style={{ fontWeight: 700, fontSize: 12 }}>{p.title}</div>
            <div style={{ fontSize: 10, color: "#bcc5dc" }}>{p.subtitle}</div>
          </button>
        ))}
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 10,
          flexWrap: "wrap",
        }}
      >
        <button
          type="button"
          onClick={() => {
            ensureCtx();
            setPlaying((v) => !v);
          }}
          style={{
            ...btn,
            background: playing ? "rgba(235,85,105,0.85)" : "rgba(70,185,125,0.85)",
            fontWeight: 700,
          }}
        >
          {playing ? "⏹ 停止" : "▶ 再生"}
        </button>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
          <span>BPM {bpm}</span>
          <input
            type="range"
            min={84}
            max={168}
            value={bpm}
            onChange={(e) => setBpm(Number(e.target.value))}
          />
        </label>
        <select
          aria-label="音色"
          value={wave}
          onChange={(e) => setWave(e.target.value as OscillatorType)}
          style={{
            background: "rgba(255,255,255,0.1)",
            color: "#fff",
            border: "1px solid rgba(255,255,255,0.25)",
            borderRadius: 7,
            padding: "4px 8px",
            fontSize: 12,
          }}
        >
          <option value="triangle" style={{ color: "#111" }}>
            オルゴール (Triangle)
          </option>
          <option value="sine" style={{ color: "#111" }}>
            ベル (Sine)
          </option>
          <option value="square" style={{ color: "#111" }}>
            レトロ8bit (Square)
          </option>
          <option value="sawtooth" style={{ color: "#111" }}>
            シンセ (Sawtooth)
          </option>
        </select>
        <button
          type="button"
          style={btn}
          onClick={() => setGrid(Array.from({ length: 5 }, () => Array(8).fill(false)))}
        >
          クリア
        </button>
      </div>

      <div style={{ fontSize: 11, color: "#b7c0d8", marginBottom: 6 }}>
        ライブ・8ステップ・シーケンサー（マスをクリックして自由にアレンジ可能）
      </div>
      <div style={{ display: "grid", gap: 4 }}>
        {grid.map((row, r) => (
          <div
            key={PITCH_NAMES[r]}
            style={{
              display: "grid",
              gridTemplateColumns: "34px repeat(8, 1fr)",
              gap: 4,
              alignItems: "center",
            }}
          >
            <span style={{ fontSize: 11, color: "#9eb2d6", fontWeight: 700 }}>
              {PITCH_NAMES[r]}
            </span>
            {row.map((active, c) => (
              <button
                key={c}
                type="button"
                aria-label={`${PITCH_NAMES[r]} ステップ ${c + 1}`}
                onClick={() => toggleCell(r, c)}
                style={{
                  height: 28,
                  borderRadius: 6,
                  cursor: "pointer",
                  border:
                    playing && step === c
                      ? "2px solid #ffd23e"
                      : "1px solid rgba(255,255,255,0.16)",
                  background: active
                    ? playing && step === c
                      ? "#ffd23e"
                      : "#56b4ff"
                    : playing && step === c
                      ? "rgba(255,210,62,0.16)"
                      : "rgba(255,255,255,0.06)",
                }}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
