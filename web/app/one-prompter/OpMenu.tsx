"use client";

// ヘッダー右端のハンバーガーメニュー（クライアント）。
// 中身はアカウント（ログイン）セクションだけを持つ。
import { useEffect, useRef, useState } from "react";

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
            <span>メニュー</span>
            <button type="button" className="op-menu-close" aria-label="メニューを閉じる" onClick={() => setOpen(false)}>
              ×
            </button>
          </div>
        </nav>
      )}
    </div>
  );
}
