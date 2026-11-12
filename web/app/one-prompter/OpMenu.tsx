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

type KeyStatus = { registered: boolean; masked: string | null };

export default function OpMenu({
  user,
  googleEnabled,
  userKeyEnabled,
}: {
  user: OpMenuUser | null;
  googleEnabled: boolean;
  userKeyEnabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  /** 自前 API キーの登録状態（開いたときに取得する。null は未取得）。 */
  const [keyStatus, setKeyStatus] = useState<KeyStatus | null>(null);
  const [keyDraft, setKeyDraft] = useState("");
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyNote, setKeyNote] = useState("");

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

  // ログイン中でキー機能が有効なときだけ、開いたタイミングで登録状態を取りに行く
  useEffect(() => {
    if (!open || !user || !userKeyEnabled || keyStatus !== null) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/one-prompter/key");
        if (!response.ok) return;
        const data = (await response.json()) as { registered?: unknown; masked?: unknown };
        if (cancelled) return;
        setKeyStatus({
          registered: data.registered === true,
          masked: typeof data.masked === "string" ? data.masked : null,
        });
      } catch {
        // 取得できなければ未登録表示のまま（登録操作はサーバー側で弾かれる）
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, user, userKeyEnabled, keyStatus]);

  const registerKey = async () => {
    const apiKey = keyDraft.trim();
    if (!apiKey || keyBusy) return;
    setKeyBusy(true);
    setKeyNote("");
    try {
      const response = await fetch("/api/one-prompter/key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey }),
      });
      const data = (await response.json().catch(() => null)) as { masked?: unknown } | null;
      if (!response.ok) throw new Error("register failed");
      setKeyStatus({ registered: true, masked: typeof data?.masked === "string" ? data.masked : null });
      setKeyDraft("");
    } catch {
      setKeyNote("登録できませんでした。キーを確認してください。");
    } finally {
      setKeyBusy(false);
    }
  };

  const removeKey = async () => {
    if (keyBusy) return;
    setKeyBusy(true);
    setKeyNote("");
    try {
      const response = await fetch("/api/one-prompter/key", { method: "DELETE" });
      if (!response.ok) throw new Error("delete failed");
      setKeyStatus({ registered: false, masked: null });
    } catch {
      setKeyNote("削除できませんでした。");
    } finally {
      setKeyBusy(false);
    }
  };

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
                {userKeyEnabled && (
                  <div className="op-menu-key">
                    <p className="op-menu-key-label">自分のAPIキー</p>
                    {keyStatus?.registered ? (
                      <>
                        <p className="op-menu-key-masked">{keyStatus.masked}（登録済み）</p>
                        <button type="button" className="op-menu-logout" onClick={() => void removeKey()} disabled={keyBusy}>
                          削除
                        </button>
                      </>
                    ) : (
                      <>
                        <input
                          type="password"
                          className="op-menu-key-input"
                          value={keyDraft}
                          onChange={(e) => setKeyDraft(e.target.value)}
                          placeholder="APIキーを入力"
                          autoComplete="off"
                        />
                        <button
                          type="button"
                          className="op-menu-logout"
                          onClick={() => void registerKey()}
                          disabled={keyBusy || !keyDraft.trim()}
                        >
                          登録
                        </button>
                        <p className="op-menu-note">登録すると、生成はあなたのキーで動きます。</p>
                      </>
                    )}
                    {keyNote && <p className="op-menu-note">{keyNote}</p>}
                  </div>
                )}
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
