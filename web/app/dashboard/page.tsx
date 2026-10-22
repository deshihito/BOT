import Link from "next/link";

export const metadata = { title: "ダッシュボード | AGOBOT" };

export default function DashboardPage() {
  return (
    <>
      <div className="page-heading">
        <p className="eyebrow">DASHBOARD</p>
        <h1>ダッシュボード</h1>
        <p className="muted">AGOBOTを使い始めるための入口です。実際の操作はDiscord内で行います。</p>
      </div>
      <div className="dashboard-list">
        <Link href="/coder" className="dashboard-card dashboard-card-featured">
          <span className="dashboard-number">00</span>
          <div>
            <div className="dashboard-card-topline"><span className="status-dot status-dot-live" /> AGO Coder <span className="dashboard-chip">BETA</span></div>
            <h2>エージェントと一緒にコードを書く</h2>
            <p>Logfareのモデルで、計画・実装・レビューをひとつの作業画面から進めます。</p>
          </div>
          <span className="card-arrow">↗</span>
        </Link>
        <Link href="/commands" className="dashboard-card">
          <span className="dashboard-number">01</span>
          <div><h2>機能を探す</h2><p>5つのコマンドから、目的のジャンルと機能を確認します。</p></div>
        </Link>
        <Link href="/commands/help" className="dashboard-card">
          <span className="dashboard-number">02</span>
          <div><h2>Discordで調べる</h2><p><code>/help</code> を使うと、カテゴリやコマンド名から使い方を開けます。</p></div>
        </Link>
        <Link href="/ranking" className="dashboard-card">
          <span className="dashboard-number">03</span>
          <div><h2>成績を見る</h2><p>ゲームのランキングはリーダーボードから確認できます。</p></div>
        </Link>
      </div>
    </>
  );
}
