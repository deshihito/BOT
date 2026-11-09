import { notFound, redirect } from "next/navigation";
import { getCurrentSession } from "@/lib/auth";
import { isOwner, ownerDiscordId } from "@/lib/ads";
import AdminAdsClient from "./AdminAdsClient";

export const metadata = { title: "広告申請の審査 | AGOBOT", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

// オーナー専用の審査ページ（ナビには出さない）。
// OWNER_DISCORD_ID 未設定、またはオーナー本人でなければ存在しないものとして扱う。
export default async function AdminAdsPage() {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (!ownerDiscordId() || !isOwner(session.id)) notFound();

  if (!session.sid) {
    return (
      <section className="dashboard-page">
        <div className="dashboard-header"><h1>広告申請の審査</h1></div>
        <div className="simple-panel">
          <h2>審査には再ログインが必要です</h2>
          <p>サーバー一覧の表示に必要な許可が、今回のログインには含まれていません。</p>
          <p><a className="discord-login-button" href="/api/auth/discord/authorize">Discordでログインし直す</a></p>
        </div>
      </section>
    );
  }

  return (
    <section className="dashboard-page">
      <div className="dashboard-header">
        <h1>広告申請の審査</h1>
        <span className="user-chip">{session.username}</span>
      </div>
      <AdminAdsClient />
    </section>
  );
}
