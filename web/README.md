# AGOBOT Web

AGOBOT の紹介・コマンド一覧・ゲームのルール・ランキングのサイトです（Next.js、Vercel にデプロイ）。

## データ

コマンド一覧とルールは、Bot のコードから書き出した `data/commands.json` から作ります。

```bash
# リポジトリのルートで（Bot 側の書き出し）
python -m tools.export_commands --out web/data/commands.json
```

`data/commands.json` が無いあいだは `data/commands.sample.json`（サンプル）を表示し、画面にもサンプルであることを出します。

## 開発

```bash
cd web
npm install
npm run dev    # http://localhost:3000
npm test       # commands.json の形を確認
npm run build
```

## Vercel

プロジェクトの Root Directory を `web` にしてください。main に push されるたびに本番が更新されます。

## AGO Coderの環境変数

LogfareのAPIキーはブラウザへ公開せず、VercelのServer Environment Variablesへ登録してください。

```text
LOGFARE_API_KEY=...
LOGFARE_BASE_URL=https://logfare.ai/v1
LOGFARE_DEFAULT_MODEL=logfare/auto
DISCORD_CLIENT_ID=...
DISCORD_CLIENT_SECRET=...
DISCORD_REDIRECT_URI=https://<公開ドメイン>/api/auth/discord/callback
```

Discord Developer PortalでOAuth2のRedirect URIに、`DISCORD_REDIRECT_URI`と同じURLを登録します。スコープは現在の実装では`identify`だけです。ローカル開発時は`http://localhost:3000/api/auth/discord/callback`を別のRedirect URIとして登録してください。

GitHubコネクタは、Manusの設定画面で「Connectors / Integrations」からGitHubを検索し、公式コネクタを選択してアカウントを接続します。まず対象リポジトリの読み取りだけを許可し、PR作成などの書き込み権限は必要になった段階で追加してください。GitHubのアクセストークンをチャットやソースコード、`.env`へ直接貼り付ける手順は採用しません。
