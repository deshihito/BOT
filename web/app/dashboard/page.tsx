import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";

export const metadata = { title: "ダッシュボード | AGOBOT" };

export default async function DashboardPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  return (
    <section className="dashboard-page">
      <div className="dashboard-header">
        <h1>ダッシュボード</h1>
        <span>{user.username}</span>
        <form action="/api/auth/logout" method="post"><button type="submit">ログアウト</button></form>
      </div>
      <nav className="dashboard-list" aria-label="機能">
        <Link href="/coder" className="dashboard-card">AGO Coder</Link>
        <Link href="/commands" className="dashboard-card">コマンド</Link>
      </nav>
    </section>
  );
}
