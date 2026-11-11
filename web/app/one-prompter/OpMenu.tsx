"use client";

// ヘッダー右端のハンバーガーメニュー（クライアント）。
// 中身はモデル選択専用: 生成モデルの一覧から1つを選ぶリスト。
// 現在の選択にはチェックを付け、選んだらその場で切り替えて閉じる。
// モデルの状態は OpModelContext 経由で操作UI（OnePrompterClient）と共有する。
// 表示名のどこにもプロバイダ名は出さない。
import { useEffect, useRef, useState } from "react";
import { PROMPTER_MODEL_OPTIONS } from "../../lib/one-prompter-llm";
import { useOpModel } from "./OpModelContext";

export default function OpMenu() {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const { modelKey, setModelKey } = useOpModel();

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
        <nav className="op-menu-panel" aria-label="モデル選択">
          <div className="op-menu-head">
            <span>モデル</span>
            <button type="button" className="op-menu-close" aria-label="メニューを閉じる" onClick={() => setOpen(false)}>
              ×
            </button>
          </div>
          <ul className="op-menu-models">
            {PROMPTER_MODEL_OPTIONS.map((opt) => {
              const selected = opt.key === modelKey;
              return (
                <li key={opt.key}>
                  <button
                    type="button"
                    className={selected ? "op-menu-model selected" : "op-menu-model"}
                    aria-pressed={selected}
                    onClick={() => {
                      setModelKey(opt.key);
                      setOpen(false);
                    }}
                  >
                    <span className="op-menu-check" aria-hidden="true">
                      {selected ? "✓" : ""}
                    </span>
                    {opt.label}
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>
      )}
    </div>
  );
}
