import type { Metadata } from "next";
import ViewslopperClient from "./ViewslopperClient";

const VS_DESCRIPTION = "URLを入れると、ページの Slop Score（0–100）と、どこが slop かの診断を返します。";

// 独立サービスのため、メタ情報も AGO BOT の名義（ルートの title テンプレート、
// OGP、サイト名、既定アイコン）を継がず、viewslopper 単独名義で完結させる。
const VS_ICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect x='6' y='6' width='52' height='52' rx='14' fill='%2317191c'/%3E%3Crect x='18' y='36' width='7' height='12' rx='2' fill='%23ffffff'/%3E%3Crect x='29' y='28' width='7' height='20' rx='2' fill='%23ffffff'/%3E%3Crect x='40' y='18' width='7' height='30' rx='2' fill='%23e5484d'/%3E%3C/svg%3E";

export const metadata: Metadata = {
  title: { absolute: "viewslopper" },
  description: VS_DESCRIPTION,
  keywords: ["viewslopper", "Slop Score", "AI slop", "診断"],
  alternates: { canonical: "/viewslopper" },
  openGraph: {
    type: "website",
    url: "/viewslopper",
    siteName: "viewslopper",
    title: "viewslopper",
    description: VS_DESCRIPTION,
    images: [],
  },
  twitter: { card: "summary", title: "viewslopper", description: VS_DESCRIPTION, images: [] },
  icons: { icon: VS_ICON },
};

export default function ViewslopperPage() {
  return (
    <div style={{ maxWidth: 720, margin: "0 auto", padding: "28px 20px 0" }}>
      <h1 style={{ fontSize: 26, lineHeight: 1.35, margin: "0 0 8px" }}>そのページ、どれだけ slop か。</h1>
      <p style={{ color: "#b6bac2", margin: "0 0 20px", lineHeight: 1.7 }}>
        URLを1つ入れると Slop Score と診断が出ます。スコアは決まった計算で出し、診断文だけをAIが書きます。
      </p>
      <ViewslopperClient />
    </div>
  );
}
