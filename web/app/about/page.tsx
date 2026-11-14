import type { Metadata } from "next";
import Link from "next/link";
import { SUPPORT_SERVER_URL } from "@/lib/site";

export const metadata: Metadata = {
  title: "運営者情報",
  description:
    "AGOBOTの運営者情報です。運営者、サービス概要、運営方針、お問い合わせ先を掲載しています。",
  alternates: { canonical: "/about" },
};

export default function AboutPage() {
  return (
    <article className="legal-page">
      <h1>運営者情報</h1>

      <h2>サービス概要</h2>
      <p>
        AGOBOTは、Discordサーバー向けの多機能Botと、その関連ウェブサイトからなるサービスです。
        ゲーム、音楽とボイスチャンネル、コイン経済、サーバー運営の支援、AIツールなど、
        Discordの中での活動に使う機能をひとつのBotにまとめ、無料で提供しています。
        本ページでは、本サービスの運営者と運営方針を公開しています。
      </p>

      <h2>運営者</h2>
      <p>運営者：Luna</p>
      <p>
        本サービスは、運営者 Luna が企画・開発・運営しています。利用者の情報の取り扱いに
        ついては<Link href="/privacy">プライバシーポリシー</Link>に、利用条件については
        <Link href="/terms">利用規約</Link>に定めています。
      </p>

      <h2>運営方針</h2>
      <ul>
        <li>使いたいことを、ひとつのBotでまかなえるようにすること</li>
        <li>機能は無料で提供し、Discordの中だけで完結する形を保つこと</li>
        <li>利用者からの報告や要望をもとに、継続的に改善すること</li>
        <li>利用者の情報を必要最小限の範囲で取り扱い、その内容を公開すること</li>
      </ul>

      <h2>お問い合わせ</h2>
      <p>
        本サービスに関するお問い合わせ、障害の報告、ご要望は、公式の
        <a href={SUPPORT_SERVER_URL} target="_blank" rel="noreferrer">サポートサーバー</a>
        （Discord）で受け付けています。導入や使い方については
        <Link href="/faq">よくある質問</Link>もあわせてご覧ください。
      </p>
    </article>
  );
}
