"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { isChromelessPath } from "@/lib/site-chrome";

/**
 * サイト共通クローム（ヘッダー/フッター）の出し分け。
 * One Prompter（独立サービス化予定の別サービスのデモ）のページでは共通枠を
 * 出さない。判定はパスだけを見る純粋関数（lib/site-chrome.ts）に寄せてあり、
 * 静的生成時もクライアント側も同じ結果になる。
 */
export default function SiteChrome({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? "/";
  if (isChromelessPath(pathname)) return null;
  return <>{children}</>;
}
