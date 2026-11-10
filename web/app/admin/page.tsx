import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentSession } from "@/lib/auth";
import { isOwner, ownerDiscordId } from "@/lib/ads";

export const metadata = { title: "管理 | AGOBOT", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

// BOT管理者専用の入口（ナビやダッシュボードの通常導線には出さない）。
// ダッシュボード用ログイン＋セッションの Discord ID が OWNER_DISCORD_ID と
// 一致した場合だけ開ける。一致しない／未ログイン／環境変数未設定の場合は
// 存在自体を悟られないよう 404 にする（審査ページのオーナー判定と同じ流儀）。
export default async function AdminIndexPage() {
  const session = await getCurrentSession();
  if (!session) notFound();
  if (!ownerDiscordId() || !isOwner(session.id)) notFound();

  if (!session.sid) {
    return (
      <section className="dashboard-page">
        <div className="dashboard-header"><h1>管理</h1></div>
        <div className="simple-panel">
          <h2>管理には再ログインが必要です</h2>
          <p>サーバー一覧の表示に必要な許可が、今回のログインには含まれていません。</p>
          <p><a className="discord-login-button" href="/api/auth/discord/authorize">Discordでログインし直す</a></p>
        </div>
      </section>
    );
  }

  return (
    <section className="dashboard-page">
      <div className="dashboard-header">
        <h1>管理</h1>
        <span className="user-chip">{session.username}</span>
      </div>
      <div className="page-heading compact-heading">
        <h2>管理メニュー</h2>
        <p className="muted">連携広告枠への掲載申請を承認・却下・停止します。</p>
      </div>
      <nav className="dashboard-list" aria-label="管理メニュー">
        <Link href="/admin/ads" className="dashboard-card">広告申請の審査</Link>
      </nav>
    </section>
  );
}
