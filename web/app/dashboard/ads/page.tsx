import { redirect } from "next/navigation";
import { getCurrentSession } from "@/lib/auth";
import { getDashboardContext } from "@/lib/dashboard";
import AdsClient from "./AdsClient";

export const metadata = { title: "サーバー広告の申請 | AGOBOT", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default async function DashboardAdsPage() {
  const session = await getCurrentSession();
  if (!session) redirect("/login");

  if (!session.sid) {
    return (
      <section className="dashboard-page">
        <div className="dashboard-header"><h1>サーバー広告の申請</h1></div>
        <div className="simple-panel">
          <h2>申請には再ログインが必要です</h2>
          <p>サーバー一覧の表示に必要な許可が、今回のログインには含まれていません。</p>
          <p><a className="discord-login-button" href="/api/auth/discord/authorize">Discordでログインし直す</a></p>
        </div>
      </section>
    );
  }

  const context = await getDashboardContext(session);
  if (!context) {
    return (
      <section className="dashboard-page">
        <div className="dashboard-header"><h1>サーバー広告の申請</h1></div>
        <div className="simple-panel">
          <h2>サーバー一覧を取得できませんでした</h2>
          <p>Discordとの通信に失敗したか、ログインの有効期限が切れています。ログインし直してください。</p>
          <p><a className="discord-login-button" href="/api/auth/discord/authorize">Discordでログインし直す</a></p>
        </div>
      </section>
    );
  }

  return (
    <section className="dashboard-page">
      <div className="dashboard-header">
        <h1>サーバー広告の申請</h1>
        <span className="user-chip">{context.user.username}</span>
      </div>
      <div className="page-heading compact-heading">
        <h2>連携広告枠への掲載申請</h2>
        <p className="muted">
          あなたが管理していてAGOBOTが導入されているサーバーは、boardNotify RTAの記録表示に出る連携広告枠へ掲載を申請できます。
          審査を通ると、他のサーバーの記録表示に順番で表示されます。掲載期限はないため、停止されるかAGOBOTがサーバーから退出するまで表示され続けます。
        </p>
      </div>
      <AdsClient />
    </section>
  );
}
