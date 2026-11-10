"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { InviteButton } from "./InviteCta";
import { PRIMARY_NAV, UTILITY_NAV, isNavActive, type SiteLink } from "@/lib/site";

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
      </div>
    </>
  );
}
