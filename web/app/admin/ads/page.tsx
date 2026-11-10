import { notFound } from "next/navigation";
import { getCurrentSession } from "@/lib/auth";
import { isOwner, ownerDiscordId } from "@/lib/ads";
import AdminAdsClient from "@/app/dashboard/admin/ads/AdminAdsClient";

export const metadata = { title: "広告申請の審査 | AGOBOT", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

// BOT管理者専用URL版の審査ページ。審査UI本体とAPIは /dashboard/admin/ads と
// 共用し、ここは入口（オーナー判定＋外枠）だけを持つ。
// ダッシュボード用ログイン＋ OWNER_DISCORD_ID 一致が必須で、未ログインでも
// リダイレクトせず 404 にする（存在自体を悟らせない）。
export default async function AdminAdsAliasPage() {
  const session = await getCurrentSession();
  if (!session) notFound();
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
