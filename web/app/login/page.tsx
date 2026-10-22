import Link from "next/link";

export const metadata = { title: "ログイン | AGOBOT" };

export default function LoginPage() {
  const configured = Boolean(process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_SECRET && process.env.DISCORD_REDIRECT_URI);
  return (
    <div className="login-page">
      <div className="page-heading"><p className="eyebrow">ACCOUNT / DISCORD</p><h1>Discordでログイン</h1><p className="muted">AGO CoderのセッションとGitHub接続を、Discordアカウントに紐づけます。</p></div>
      <div className="login-panel">
        <div className="login-mark">◎</div>
        <h2>{configured ? "Discordアカウントで続ける" : "Discord OAuthの準備が必要です"}</h2>
        <p>{configured ? "Discordの認証画面へ移動します。AGOBOTは必要最小限の識別情報だけを利用します。" : "下の環境変数をWebサーバーへ設定すると、ログインボタンが有効になります。ブラウザやGitHubへ秘密鍵を入力しないでください。"}</p>
        {configured ? <a className="discord-login-button" href="/api/auth/discord/authorize">Discordでログイン</a> : <div className="oauth-env-list"><code>DISCORD_CLIENT_ID</code><code>DISCORD_CLIENT_SECRET</code><code>DISCORD_REDIRECT_URI</code></div>}
      </div>
      <div className="login-panel" id="github"><p className="eyebrow">GITHUB CONNECTOR</p><h2>GitHubコネクタの手順</h2><p>GitHub連携はDiscordログインとは別に、Manusのコネクタ設定で認証します。コネクタ作成後はAGO CoderのInspectorからリポジトリ選択とPR操作を追加できます。</p><ol className="setup-steps"><li>Manusの設定から「Connectors / Integrations」を開く。</li><li>GitHubを検索して公式GitHubコネクタを選ぶ。</li><li>GitHubアカウントを接続し、対象リポジトリだけを許可する。</li><li>AGO Coderで読み取り権限を確認してから、PR作成などの書き込み権限を必要時だけ許可する。</li></ol><p className="quiet-note">アクセストークンをチャット、ソースコード、`.env`へ直接貼り付ける必要はありません。</p></div>
      <Link href="/coder" className="back-link">← AGO Coderへ戻る</Link>
    </div>
  );
}
