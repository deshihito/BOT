"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

type NavGroup = {
  label: string;
  items: { section: string; label: string }[];
};

export default function SidebarNav({ guildId, groups }: { guildId: string; groups: NavGroup[] }) {
  const pathname = usePathname();
  const base = `/dashboard/${guildId}`;
  return (
    <nav className="dash-sidebar" aria-label="モジュール一覧">
      <Link href={base} className={pathname === base ? "side-item side-item-active" : "side-item"}>
        概要
      </Link>
      {groups.map((group) => (
        <div className="side-group" key={group.label}>
          <p className="side-group-label">{group.label}</p>
          {group.items.map((item) => {
            const href = `${base}/${item.section}`;
            return (
              <Link key={item.section} href={href} className={pathname === href ? "side-item side-item-active" : "side-item"}>
                {item.label}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
