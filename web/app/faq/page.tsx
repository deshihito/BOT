import type { Metadata } from "next";
import Link from "next/link";
import { SUPPORT_SERVER_URL } from "@/lib/site";
import Breadcrumbs from "../Breadcrumbs";
import FaqAccordion, { type FaqItem } from "./FaqAccordion";

export const metadata: Metadata = {
  title: "よくある質問",
  description:
    "AGOBOTの導入方法、料金、必要な権限、ダッシュボードでできること、困ったときの確認先をまとめた、よくある質問ページです。",
  alternates: { canonical: "/faq" },
};

const ITEMS: FaqItem[] = [
  {
    question: "AGOBOT の導入方法を教えてください。",
    answer: (
      <p>
        このサイトの「Discordに追加」ボタンから、追加したいサーバーを選ぶだけで導入できます。
        招待リンクには Bot の動作に必要な権限が含まれているので、追加の画面でそのまま許可してください。
      </p>
    ),
  },
  {
    question: "料金はかかりますか？",
    answer: <p>無料で使えます。機能の利用に追加の課金はありません。</p>,
  },
  {
    question: "導入や設定には、どんな権限が必要ですか？",
    answer: (
      <p>
        Bot の追加には、そのサーバーの管理権限（サーバー管理または管理者）が必要です。
        サーバー設定を変更するダッシュボードも、同じく管理権限を持つメンバーだけが利用できます。
      </p>
    ),
  },
  {
    question: "ダッシュボードでは何ができますか？",
    answer: (
      <p>
        ブラウザから AGOBOT のサーバー設定を確認・変更できます。Discord
        アカウントでログインすると、管理権限を持つサーバーの一覧が表示され、
        サーバーごとに設定画面を開けます。
      </p>
    ),
  },
  {
    question: "コマンドの使い方を知りたいです。",
    answer: (
      <p>
        <Link href="/commands">コマンド</Link> のページに、コマンドごとの使い方ガイドがあります。
        全機能の紹介は <Link href="/features">機能紹介</Link> にまとめています。
        Discord の中では <code>/quick</code> から全機能を検索して、そのまま実行することもできます。
      </p>
    ),
  },
  {
    question: "ゲームは Discord の外でも遊べますか？",
    answer: (
      <p>
        <Link href="/games">ゲーム</Link> のページから、ブラウザでそのまま遊べます。
        Discord のボイスチャンネルでアクティビティとして起動して遊ぶこともできます。
      </p>
    ),
  },
  {
    question: "Bot が反応しないときは、どうすればいいですか？",
    answer: (
      <p>
        まず <Link href="/status">ステータス</Link> のページで、Bot
        の稼働状況を確認してください。稼働中に解決しない場合は、
        <a href={SUPPORT_SERVER_URL} target="_blank" rel="noreferrer">サポートサーバー</a>
        でお知らせください。
      </p>
    ),
  },
  {
    question: "サポートはどこで受けられますか？",
    answer: (
      <p>
        公式の <a href={SUPPORT_SERVER_URL} target="_blank" rel="noreferrer">サポートサーバー</a>（Discord）
        で受け付けています。このページで解決しない質問も、そちらでどうぞ。
      </p>
    ),
  },
  {
    question: "データの取り扱いについて知りたいです。",
    answer: (
      <p>
        取得する情報とその扱いは <Link href="/privacy">プライバシーポリシー</Link> に、
        利用条件は <Link href="/terms">利用規約</Link> にまとめています。
      </p>
    ),
  },
];

export default function FaqPage() {
  return (
    <section className="faq-page">
      <Breadcrumbs items={[{ label: "よくある質問" }]} />
      <div className="page-heading">
        <h1>よくある質問</h1>
        <p className="muted">
          導入と使い方についての、よくある質問をまとめました。ここで解決しない場合は
          サポートサーバーへどうぞ。
        </p>
      </div>
      <FaqAccordion items={ITEMS} />
    </section>
  );
}
