import type { ReactNode } from "react";
import OpHeader from "./OpHeader";
import { OpModelProvider } from "./OpModelContext";

// One Prompter 単独の外枠。
// このページでは AGO BOT サイト共通のヘッダー/フッターを出さない
// （ルート側の SiteChrome がパスで判定して省く）ため、最小限のヘッダーと
// フッターをここで持つ。AGO BOT のロゴ・名称・サイト内リンクは置かない。
// サービス名の常時表示はヘッダー（OpHeader）の1箇所だけ。フッターには
// 名前を出さない。利用規約・プライバシーポリシーへのリンクは画面の
// どこにも置かない（ハンバーガーメニューの中身はモデル選択専用）。
// 生成モデルの選択状態は OpModelProvider でヘッダーと操作UIに共有する。
export default function OnePrompterLayout({ children }: { children: ReactNode }) {
  return (
    <div className="op-shell">
      <OpModelProvider>
        <OpHeader />
        {children}
      </OpModelProvider>
      <footer className="op-footer" aria-hidden="true" />
    </div>
  );
}
