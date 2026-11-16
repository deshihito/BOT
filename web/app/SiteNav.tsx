"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { InviteButton } from "./InviteCta";
import { PRIMARY_NAV, UTILITY_NAV, isNavActive, type SiteLink } from "@/lib/site";

type HeaderUser = { name: string; avatarUrl: string | null };

/** ログイン中ユーザー（ヘッダーのアイコン用）。未ログイン・取得失敗なら null のまま。 */
function useHeaderUser(): HeaderUser | null {
  const [user, setUser] = useState<HeaderUser | null>(null);
  useEffect(() => {
    let alive = true;
    fetch("/api/auth/me", { headers: { Accept: "application/json" } })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!alive || !data?.user) return;
        setUser({
          name: String(data.user.name ?? ""),
          avatarUrl: typeof data.user.avatarUrl === "string" ? data.user.avatarUrl : null,
        });
      })
      .catch(() => { /* 出さないだけ */ });
    return () => {
      alive = false;
    };
  }, []);
  return user;
}

function NavLink({ link, pathname }: { link: SiteLink; pathname: string }) {
  const active = !link.external && isNavActive(pathname, link.href);
  const current = active ? ({ "aria-current": "page" } as const) : {};
  if (link.external) {
    return (
      <a href={link.href} target="_blank" rel="noreferrer">
        {link.label}
      </a>
    );
  }
  return (
    <Link href={link.href} {...current}>
      {link.label}
    </Link>
  );
}

/** ヘッダーの導線。主導線（探索）と補助導線（運用・支援＋招待）を別々の塊で固定配置する。 */
export function SiteNav() {
  const pathname = usePathname() ?? "/";
  const user = useHeaderUser();
  return (
    <>
      <div className="nav-primary">
        {PRIMARY_NAV.map((link) => (
          <NavLink key={link.href} link={link} pathname={pathname} />
        ))}
      </div>
      <div className="nav-utility">
        {UTILITY_NAV.map((link) => (
          <NavLink key={link.href} link={link} pathname={pathname} />
        ))}
        <InviteButton />
        {user && (
          <Link
            href="/dashboard"
            className="nav-user-icon"
            aria-label={`${user.name} のダッシュボード`}
            title={user.name}
          >
            {user.avatarUrl ? (
              <img className="user-avatar" src={user.avatarUrl} alt="" width={28} height={28} />
            ) : (
              <span className="nav-user-fallback" aria-hidden>{(user.name || "?").slice(0, 1)}</span>
            )}
          </Link>
        )}
      </div>
    </>
  );
}
