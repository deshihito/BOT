"use client";

// ヘッダー右端のハンバーガーメニュー（クライアント）。
// 中身は情報・規約系だけに絞る: 使い方（3ステップ）と、利用規約・
// プライバシーポリシーへのリンク。法務リンクはこのメニュー内だけに置き、
// 画面の常設表示には出さない。リンク先は AGO BOT サイト側の文書ページで、
// 新規タブで開く。文面ではサービス名を繰り返さない。
import { useEffect, useRef, useState } from "react";

const STEPS = [
  "やりたいことを書く",
  "二択の質問に答える",
  "完成プロンプトをコピー／保存して、好きなAIに貼る",
];

export default function OpMenu() {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // 開いている間だけ、外側クリックと Esc で閉じる
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onPointerDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onPointerDown);
    };
  }, [open ]);

  return (
    <div className="op-menu" ref={wrapRef}>
      <button
        type="button"
        className="op-menu-button"
        aria-label="メニュー"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        ☰
      </button>
      {open && (
        <nav className="op-menu-panel" aria-label="メニュー">
          <div className="op-menu-head">
            <span>使い方</span>
            <button type="button" className="op-menu-close" aria-label="メニューを閉じる" onClick={() => setOpen(false)}>
              ×
            </button>
          </div>
          <ol className="op-menu-steps">
            {STEPS.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          <a className="op-menu-link" href="https://agobot.app/terms" target="_blank" rel="noreferrer">
            利用規約
          </a>
          <a className="op-menu-link" href="https://agobot.app/privacy" target="_blank" rel="noreferrer">
            プライバシーポリシー
          </a>
        </nav>
      )}
    </div>
  );
}
