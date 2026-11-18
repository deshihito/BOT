"use client";
// AGO WORLD BOX のロビーピアノ鍵盤（カジノ翼のピアノ）。
// 打鍵は即ローカルに鳴り、リアルタイム中継でロビー全員に届く（受信側の
// 再生は WorldBoxClient の WS ハンドラ）。ここは鍵盤の表示と入力だけ。
import { useEffect, useRef, useState } from "react";
import { setPianoPedal } from "@/lib/worldbox/sound";

/** 白鍵（C4..C6、半音オフセットは C5=0）。 */
const WHITE_KEYS: number[] = [-12, -10, -8, -7, -5, -3, -1, 0, 2, 4, 5, 7, 9, 11, 12];
/** 黒鍵: 半音と、その左にある白鍵のインデックス。 */
const BLACK_KEYS: { semi: number; afterWhite: number }[] = [
  { semi: -11, afterWhite: 0 },
  { semi: -9, afterWhite: 1 },
  { semi: -6, afterWhite: 3 },
  { semi: -4, afterWhite: 4 },
  { semi: -2, afterWhite: 5 },
  { semi: 1, afterWhite: 7 },
  { semi: 3, afterWhite: 8 },
  { semi: 6, afterWhite: 10 },
  { semi: 8, afterWhite: 11 },
  { semi: 10, afterWhite: 12 },
];

/** PC キーボード → 半音（下段 Z 列 = C4 オクターブ、上段 Q 列 = C5 オクターブ）。 */
const KEY_TO_SEMI: Record<string, number> = {
  z: -12, s: -11, x: -10, d: -9, c: -8, v: -7, g: -6, b: -5, h: -4, n: -3, j: -2, m: -1, ",": 0,
  q: 0, "2": 1, w: 2, "3": 3, e: 4, r: 5, "5": 6, t: 7, "6": 8, y: 9, "7": 10, u: 11, i: 12,
};
/** 鍵盤上に出すキー名（半音 → 表示文字）。 */
const SEMI_TO_KEY_LABEL: Record<number, string> = {
  [-12]: "Z", [-11]: "S", [-10]: "X", [-9]: "D", [-8]: "C", [-7]: "V", [-6]: "G", [-5]: "B",
  [-4]: "H", [-3]: "N", [-2]: "J", [-1]: "M", 0: "Q", 1: "2", 2: "W", 3: "3", 4: "E", 5: "R",
  6: "5", 7: "T", 8: "6", 9: "Y", 10: "7", 11: "U", 12: "I",
};

const wrap: React.CSSProperties = {
  position: "absolute", left: "50%", bottom: "calc(10px + env(safe-area-inset-bottom, 0px))",
  transform: "translateX(-50%)",
  width: "min(560px, calc(100% - 16px))", boxSizing: "border-box",
  padding: "10px 12px 12px", borderRadius: 14,
  background: "rgba(12,14,22,0.94)", color: "#fff", zIndex: 6,
  boxShadow: "0 10px 32px rgba(0,0,0,0.5)",
};
const btn: React.CSSProperties = {
  minHeight: 36, padding: "4px 12px", borderRadius: 9, border: "1px solid rgba(255,255,255,0.25)",
  background: "rgba(255,255,255,0.1)", color: "#fff", fontSize: 13, cursor: "pointer",
};

export default function WorldBoxPianoPanel({ onClose, onPlay }: {
  onClose: () => void;
  onPlay: (semi: number) => void;
}) {
  const [pressed, setPressed] = useState<number | null>(null);
  const [pedal, setPedalState] = useState(false);
  const timerRef = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timerRef.current), []);

  const setPedal = (down: boolean) => {
    setPianoPedal(down);
    setPedalState(down);
  };
  const setPedalRef = useRef(setPedal);
  setPedalRef.current = setPedal;
  // パネルを閉じたらペダルは必ず離す（踏みっぱなしで残さない）。
  useEffect(() => () => setPianoPedal(false), []);

  const press = (semi: number) => {
    onPlay(semi);
    setPressed(semi);
    window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setPressed(null), 160);
  };
  const pressRef = useRef(press);
  pressRef.current = press;

  // PC キーボード演奏: パネル表示中だけ聞く。移動キーはクライアント側が
  // ピアノ優先で止めている（pianoOpenRef）。入力欄にフォーカスがある時は弾かない。
  // Space はサステインペダル（押している間だけ効く）。
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable) return;
      if (e.key === " " || e.code === "Space") {
        e.preventDefault();
        if (!e.repeat) setPedalRef.current(true);
        return;
      }
      if (e.repeat) return;
      const semi = KEY_TO_SEMI[e.key.toLowerCase()];
      if (semi === undefined) return;
      e.preventDefault();
      pressRef.current(semi);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === " " || e.code === "Space") setPedalRef.current(false);
    };
    const onBlur = () => setPedalRef.current(false);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  const whiteW = 100 / WHITE_KEYS.length;
  return (
    <div style={wrap} className="wb-panel">
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
        <strong style={{ fontSize: 14 }}>ピアノ</strong>
        <span style={{ flex: 1 }} />
        <button type="button" style={btn} onClick={onClose}>閉じる</button>
      </div>
      <div
        style={{ position: "relative", height: 148, touchAction: "none", userSelect: "none", WebkitUserSelect: "none" }}
        onContextMenu={(e) => e.preventDefault()}
      >
        <div style={{ display: "flex", height: "100%", gap: 2 }}>
          {WHITE_KEYS.map((semi) => (
            <button
              key={semi}
              type="button"
              aria-label={`鍵盤 ${semi}`}
              onPointerDown={(e) => { e.preventDefault(); press(semi); }}
              style={{
                flex: 1, height: "100%", borderRadius: "0 0 6px 6px", cursor: "pointer",
                border: "1px solid rgba(20,16,8,0.55)",
                background: pressed === semi ? "#ffd23e" : "#f4eedd",
                boxShadow: "inset 0 -6px 10px rgba(120,90,20,0.18)",
                padding: 0, position: "relative",
              }}
            >
              <span style={{
                position: "absolute", left: 0, right: 0, bottom: 5, textAlign: "center",
                fontSize: 10, fontWeight: 700, color: "rgba(90,70,20,0.55)", pointerEvents: "none",
              }}>
                {SEMI_TO_KEY_LABEL[semi]}
              </span>
            </button>
          ))}
        </div>
        {BLACK_KEYS.map(({ semi, afterWhite }) => (
          <button
            key={semi}
            type="button"
            aria-label={`鍵盤 ${semi}`}
            onPointerDown={(e) => { e.preventDefault(); press(semi); }}
            style={{
              position: "absolute", top: 0, height: "58%", zIndex: 2,
              left: `calc(${(afterWhite + 1) * whiteW}% - ${whiteW * 0.31}%)`,
              width: `${whiteW * 0.62}%`,
              borderRadius: "0 0 5px 5px", cursor: "pointer",
              border: "1px solid rgba(0,0,0,0.8)",
              background: pressed === semi ? "#ffd23e" : "#17171f",
              boxShadow: "0 4px 8px rgba(0,0,0,0.45)",
              padding: 0,
            }}
          >
            <span style={{
              position: "absolute", left: 0, right: 0, bottom: 4, textAlign: "center",
              fontSize: 9, fontWeight: 700, color: "rgba(255,255,255,0.5)", pointerEvents: "none",
            }}>
              {SEMI_TO_KEY_LABEL[semi]}
            </span>
          </button>
        ))}
      </div>
      <button
        type="button"
        aria-label="サステインペダル"
        aria-pressed={pedal}
        onPointerDown={(e) => { e.preventDefault(); setPedal(true); }}
        onPointerUp={() => setPedal(false)}
        onPointerLeave={() => setPedal(false)}
        onPointerCancel={() => setPedal(false)}
        onContextMenu={(e) => e.preventDefault()}
        style={{
          display: "block", width: "62%", margin: "10px auto 0", minHeight: 34,
          borderRadius: 9, cursor: "pointer", touchAction: "none", userSelect: "none", WebkitUserSelect: "none",
          border: pedal ? "1px solid #ffd23e" : "1px solid rgba(255,255,255,0.25)",
          background: pedal ? "rgba(255,210,62,0.85)" : "rgba(255,255,255,0.1)",
          color: pedal ? "#17171f" : "#fff", fontSize: 13, fontWeight: 700,
        }}
      >
        ペダル（Space）
      </button>
    </div>
  );
}
