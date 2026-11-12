"use client";

// ヘッダー右端のハンバーガーメニュー（クライアント）。
// 中身はアカウント（ログイン）セクションだけを持つ。
// 未ログイン: Discord / Google のログインボタン（Google はサーバー側で
// 資格情報が設定されている場合だけ出す）。ログイン中: ユーザー表示とログアウト。
// ログインは任意で、未ログインでも全機能が従来どおり使える。
// ログイン導線は共通の OAuth ルートを使い、完了後はこの画面へ戻る（next 指定）。
import { useEffect, useRef, useState } from "react";
import type { OpMenuUser } from "./OpHeader";

const NEXT = "/one-prompter";

export default function OpMenu({
  user,
  googleEnabled,
}: {
  user: OpMenuUser | null;
  googleEnabled: boolean;
}) {
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
          <div className="op-menu-section">
            {user ? (
              <>
                <p className="op-menu-user">
                  {user.avatarUrl && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img className="op-menu-avatar" src={user.avatarUrl} alt="" width={28} height={28} />
                  )}
                  <span className="op-menu-username">{user.name}</span>
                </p>
                <form action={`/api/auth/logout?next=${NEXT}`} method="post">
                  <button type="submit" className="op-menu-logout">
                    ログアウト
                  </button>
                </form>
              </>
            ) : (
              <>
                <a className="op-menu-login" href={`/api/auth/discord/authorize?next=${NEXT}`}>
                  Discord でログイン
                </a>
                {googleEnabled && (
                  <a className="op-menu-login" href={`/api/auth/google/authorize?next=${NEXT}`}>
                    Google でログイン
                  </a>
                )}
                <p className="op-menu-note">ログインしなくても使えます。</p>
              </>
            )}
          </div>
        </nav>
      )}
    </div>
  );
}
