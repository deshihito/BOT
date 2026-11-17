"use client";
// AGO WORLD BOX のロビーピアノ鍵盤（カジノ翼のピアノ）。
// 打鍵は即ローカルに鳴り、リアルタイム中継でロビー全員に届く（受信側の
// 再生は WorldBoxClient の WS ハンドラ）。ここは鍵盤の表示と入力だけ。
import { useEffect, useRef, useState } from "react";

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
  const timerRef = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timerRef.current), []);

  const press = (semi: number) => {
    onPlay(semi);
    setPressed(semi);
    window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setPressed(null), 160);
  };

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
                padding: 0,
              }}
            />
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
          />
        ))}
      </div>
    </div>
  );
}
