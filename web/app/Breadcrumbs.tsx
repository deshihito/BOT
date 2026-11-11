import Link from "next/link";

export type Crumb = { href?: string; label: string };

/**
 * パンくず（第2階層以下の公開ページ共通）。
 * 先頭は常にトップで、最後の要素は現在地（リンクなし）。
 * 既存の .breadcrumbs スタイルを使う。
 */
export default function Breadcrumbs({ items }: { items: Crumb[] }) {
  const trail: Crumb[] = [{ href: "/", label: "トップ" }, ...items];
  return (
    <nav className="breadcrumbs" aria-label="パンくず">
      {trail.map((item, index) => {
        const last = index === trail.length - 1;
        return (
          <span key={`${item.label}-${index}`}>
            {index > 0 ? <span> / </span> : null}
            {item.href && !last ? <Link href={item.href}>{item.label}</Link> : <span>{item.label}</span>}
          </span>
        );
      })}
    </nav>
  );
}
