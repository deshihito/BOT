import type { ReactNode } from "react";
import OpHeader, { type OpMenuUser } from "./OpHeader";
import { getCurrentSession, isGoogleConfigured } from "@/lib/auth";
import { userAvatarUrl } from "@/lib/dashboard-core";
import { isUserKeyEnabled } from "@/lib/one-prompter-user-key";

// One Prompter 単独の外枠。
// このページでは AGO BOT サイト共通のヘッダー/フッターを出さない
// （ルート側の SiteChrome がパスで判定して省く）ため、最小限のヘッダーと
// フッターをここで持つ。AGO BOT のロゴ・名称・サイト内リンクは置かない。
// サービス名の常時表示はヘッダー（OpHeader）の1箇所だけ。フッターには
// 名前を出さない。利用規約・プライバシーポリシーへのリンクは画面の
// どこにも置かない（ハンバーガーメニューの中身はアカウント導線のみ）。
// ログイン状態は共通セッション（lib/auth）をここで読み、ヘッダー経由で
// メニューへ渡す。未ログインでも全機能が使える（ログインは任意）。
export default async function OnePrompterLayout({ children }: { children: ReactNode }) {
  const session = await getCurrentSession();
  const user: OpMenuUser | null = session
    ? {
        name: session.username,
        // Discord の avatar はハッシュなので CDN URL を組み立てる。Google は完全な URL が入っている
        avatarUrl: session.provider === "google" ? (session.avatar ?? null) : userAvatarUrl(session.id, session.avatar),
      }
    : null;
  return (
    <div className="op-shell">
      <OpHeader user={user} googleEnabled={isGoogleConfigured()} userKeyEnabled={isUserKeyEnabled()} />
      {children}
      <footer className="op-footer" aria-hidden="true" />
    </div>
  );
}
