import type { ReactNode } from "react";
import OpHeader from "./OpHeader";

// One Prompter 単独の外枠。
// このページでは AGO BOT サイト共通のヘッダー/フッターを出さない
// （ルート側の SiteChrome がパスで判定して省く）ため、最小限のヘッダーと
// フッターをここで持つ。AGO BOT のロゴ・名称・サイト内リンクは置かない。
// サービス名の常時表示はヘッダー（OpHeader）の1箇所だけ。フッターには
// 名前を出さない。利用規約・プライバシーポリシーへのリンクは画面の
// どこにも置かない（ハンバーガーメニューの中身はアカウント導線のみ）。
export default function OnePrompterLayout({ children }: { children: ReactNode }) {
  return (
    <div className="op-shell">
      <OpHeader />
      {children}
      <footer className="op-footer" aria-hidden="true" />
    </div>
  );
}
