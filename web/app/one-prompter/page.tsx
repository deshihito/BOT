import type { Metadata } from "next";
import OnePrompterClient from "./OnePrompterClient";

const OP_DESCRIPTION = "雑な意見を、神プロンプトに。漠然とした『やりたいこと』を二択の質問で詰め切り、完成プロンプトに仕上げるサービスです。";

// 独立サービス化を前提にした別サービスのデモのため、メタ情報も AGO BOT の
// 名義（ルートの title テンプレート「%s | AGOBOT」、OGP、サイト名、既定
// アイコン）を継がず、One Prompter 単独名義で完結させる。
// ファビコンはロゴA「プロンプト記号」そのもの（layout.tsx の OpLogoMark と
// 同一形状: 黒い角丸スクエアに白抜きの「>_」）。
const OP_ICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect x='6' y='6' width='52' height='52' rx='14' fill='%2317191c'/%3E%3Cpath d='M21 23 L31 32 L21 41' stroke='%23ffffff' stroke-width='5.5' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3Crect x='35' y='38.5' width='11' height='5' rx='2.5' fill='%23ffffff'/%3E%3C/svg%3E";

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
        {/* サービス名の常時表示はヘッダーの1箇所だけにするため、見出しはキャッチフレーズにする */}
        <h1 className="op-lead">雑な意見を、神プロンプトに。</h1>
      </div>
      <OnePrompterClient />
    </div>
  );
}
