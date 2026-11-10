import type { Metadata } from "next";
import OnePrompterClient from "./OnePrompterClient";

const OP_DESCRIPTION =
  "雑な一文を投げて、二択の質問に答えるだけ。空欄を埋めて細かく詰め切り、AIあるあるを消す条件まで入れた完成プロンプトを返します。";

// 独立サービス化を前提にした別サービスのデモのため、メタ情報も AGO BOT の
// 名義（ルートの title テンプレート「%s | AGOBOT」、OGP、サイト名、既定
// アイコン）を継がず、One Prompter 単独名義で完結させる。
const OP_ICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect width='100' height='100' rx='18' fill='%2329221e'/%3E%3Ctext x='50' y='71' font-size='52' text-anchor='middle' fill='%23f3ead9' font-family='monospace' font-weight='bold'%3E%26gt%3B_%3C/text%3E%3C/svg%3E";

export const metadata: Metadata = {
  title: { absolute: "One Prompter" },
  description: OP_DESCRIPTION,
  keywords: ["One Prompter", "プロンプト", "プロンプト生成", "AI"],
  alternates: { canonical: "/one-prompter" },
  openGraph: {
    type: "website",
    url: "/one-prompter",
    siteName: "One Prompter",
    title: "One Prompter",
    description: OP_DESCRIPTION,
    images: [],
  },
  twitter: {
    card: "summary",
    title: "One Prompter",
    description: OP_DESCRIPTION,
    images: [],
  },
  icons: { icon: OP_ICON },
};

export default function OnePrompterPage() {
  return (
    <div className="op-page">
      <div className="page-heading">
        <p className="eyebrow">ONE PROMPTER</p>
        <h1>One Prompter</h1>
        <p className="muted">
          雑なプロンプトは、足りない部分をAIが無難な平均で埋めるため、無難な結果になります。
          ここでは先に二択で空欄を埋めて条件を細かく詰め切り、定型表現や誇張などの「AIあるある」を消す指定まで入れた完成プロンプトに仕上げます。
        </p>
      </div>
      <OnePrompterClient />
    </div>
  );
}
