# AGOBOT Web

AGOBOTのコマンド案内と、Discordログイン後に使えるAGO Coderを提供するNext.jsサイトです。

## データ

コマンド一覧はBotコードから出力します。

```bash
python -m tools.export_commands --out web/data/commands.json
```

## 開発

```bash
cd web
npm install
npm test
npm run build
```

## Webの環境変数

VercelのServer Environment Variablesに設定します。

```text
DISCORD_CLIENT_ID=...
DISCORD_CLIENT_SECRET=...
DISCORD_REDIRECT_URI=https://<公開ドメイン>/api/auth/discord/callback
BOT_CODER_BASE_URL=https://<Botサーバーの公開HTTPS URL>
CODER_SERVICE_SHARED_SECRET=<Botと同じランダムな値>
```

Discord Developer PortalのOAuth2 Redirect URIには`DISCORD_REDIRECT_URI`を登録します。スコープは`identify`です。ログイン後は`/dashboard`へ遷移します。

## Botの環境変数

Botサーバーには、Webと同じ`CODER_SERVICE_SHARED_SECRET`と、既存のAIプロバイダー設定を置きます。

```text
CODER_SERVICE_SHARED_SECRET=<Webと同じランダムな値>
AI_PROVIDER_ORDER=logfare
LOGFARE_API_KEY=...
```

Botは`POST /internal/coder/run`を提供します。Webは時刻・nonce・本文ハッシュを含むHMAC署名を付けて呼び出します。このURLはVercelからHTTPSで到達可能にし、ブラウザへ直接公開する用途には使いません。
