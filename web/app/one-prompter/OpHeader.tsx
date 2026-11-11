"use client";

// One Prompter のヘッダー（クライアント）。
// 左にブランド（ロゴA＋サービス名。サービス名の常時表示はここの1箇所だけ）、
// 右に現在選択中のモデル名（小さく muted で）とハンバーガーメニュー。
// 選択中モデルの表示は、メニューを開かなくても今のモデルが分かるように置く。
// ブランドマークはロゴA「プロンプト記号」（黒い角丸スクエアに白抜きの
// ターミナルプロンプト「>_」）。ファビコン（page.tsx の OP_ICON）も同一形状。
import OpMenu from "./OpMenu";
import { useOpModel } from "./OpModelContext";
import { PROMPTER_MODEL_OPTIONS } from "../../lib/one-prompter-llm";

function OpLogoMark({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <rect x="6" y="6" width="52" height="52" rx="14" fill="#17191c" />
      <path
        d="M21 23 L31 32 L21 41"
        stroke="#ffffff"
        strokeWidth="5.5"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect x="35" y="38.5" width="11" height="5" rx="2.5" fill="#ffffff" />
    </svg>
  );
}

export default function OpHeader() {
  const { modelKey } = useOpModel();
  const current = PROMPTER_MODEL_OPTIONS.find((o) => o.key === modelKey);
  return (
    <header className="op-header">
      <p className="op-brand">
        <OpLogoMark size={28} />
        One Prompter
      </p>
      <div className="op-header-right">
        <span className="op-header-model">{current?.label}</span>
        <OpMenu />
      </div>
    </header>
  );
}
