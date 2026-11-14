"use client";
// 3D シーン共通の外枠。WebGL が使えない場合は fallback（既存 2D 表示）を
// そのまま描く。読み込み中はステージ内に「読み込み中…」を重ねる。
// 各ゲームの Scene3D はこの枠を使い、createStage の container として
// containerRef を渡すこと。
import type { ReactNode, RefObject } from "react";

interface Props {
  height: number | string;
  label: string;
  ready: boolean;
  failed: boolean;
  fallback: ReactNode;
  containerRef: RefObject<HTMLDivElement | null>;
  background?: string;
  radius?: number;
}

export default function SceneBox({ height, label, ready, failed, fallback, containerRef, background = "#20262e", radius = 12 }: Props) {
  if (failed) return <>{fallback}</>;
  return (
    <div
      ref={containerRef}
      role="img"
      aria-label={label}
      style={{
        position: "relative",
        width: "100%",
        height,
        borderRadius: radius,
        overflow: "hidden",
        background,
        touchAction: "none",
      }}
    >
      {!ready && (
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "#dfe7ef", fontSize: 14, pointerEvents: "none" }}>
          読み込み中…
        </div>
      )}
    </div>
  );
}
