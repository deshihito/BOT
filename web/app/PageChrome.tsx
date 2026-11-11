"use client";

import { usePathname } from "next/navigation";
import { SUPPORT_SERVER_URL } from "@/lib/site";
import { showsCtaBand } from "@/lib/site-chrome";
import { InviteButton } from "./InviteCta";

/**
 * 公開ページ共通の最終CTA帯（フッター直前）とスマホ下部固定CTAバー。
 * 主CTAは「Botを導入」（InviteButton）、副CTAはサポートサーバーの1種類だけ。
 * 出し分けは lib/site-chrome.ts の純粋関数に寄せてある。
 * アクティビティ埋め込み時は globals.css の :has() 規則でも消える（二重の担保）。
 */
export default function PageChrome() {
  const pathname = usePathname() ?? "/";
  if (!showsCtaBand(pathname)) return null;
  return (
    <>
      <aside className="final-cta-band" aria-label="導入のご案内">
        <div className="final-cta-inner">
          <p className="final-cta-copy">使いたいこと、全部このボットでいい。</p>
          <div className="final-cta-actions">
            <InviteButton />
            <a
              className="sub-cta-link"
              href={SUPPORT_SERVER_URL}
              target="_blank"
              rel="noreferrer"
            >
              サポートサーバー
            </a>
          </div>
        </div>
      </aside>
      <div className="mobile-cta-bar">
        <InviteButton />
      </div>
    </>
  );
}
