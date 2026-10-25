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

Botは`POST /internal/coder/run`を提供します。Webは時刻・nonce・本文ハッシュを含むHMAC署名を付けて呼び出します。このURLはVercelからHTTPSで到達可能にし、ブラウザーへ直接公開する用途には使いません。

## Discord Music Video Activity

読み取り専用ActivityのURLは`/activity/music`です。既存の`DISCORD_CLIENT_ID`、`DISCORD_CLIENT_SECRET`、`BOT_CODER_BASE_URL`、`CODER_SERVICE_SHARED_SECRET`を利用するため、Activity専用のAPIキーや再生状態用データベースは追加しません。OAuthスコープは`identify`のみです。短寿命でサーバー／チャンネルに結び付いたActivityトークンを発行し、Next.jsサーバーからHMAC署名付きでBotへ状態を問い合わせます。Botは呼出者がそのボイスチャンネルに参加中か確認してから、動画IDと最小限の再生状態を返します。

Discord Developer Portalで既存アプリのActivities／Embedded Appを有効にし、本番Webサイトのホストを`/`のURL Mappingに登録してください。YouTubeプレイヤーの外部通信には、少なくとも`/youtube` → `www.youtube.com`、`/googlevideo/{subdomain}` → `{subdomain}.googlevideo.com`、`/ytimg` → `i.ytimg.com`のMappingを設定します。SDKの`patchUrlMappings`でYouTubeのスクリプトやiframeをDiscordプロキシ経由にします。YouTube側が別の外部ホストを要求する場合は、そのMappingも追加してDiscord実クライアントで検証してください。`/`は全パスに一致するため、より具体的なMappingより後（一覧の最後）に置きます。Developer PortalのSupported Platformsで利用するデスクトップ／Web／iOS／Androidも有効にします。

ActivityはMusicと同じサーバーのボイスチャンネルで起動します。Musicパネルへのボタン追加や、他のVC機能・UIの変更は行いません。Activityは表示中、約2秒ごとにBot側のMusic状態を取得します。ブラウザーの自動再生制限を満たすため、参加者ごとに一度「同期して再生」を押してください。YouTube公式プレイヤーはミュートし、VCの音声は従来どおりBotが担当します。ネットワーク遅延・バッファリング、YouTube側の埋め込み不可／年齢／地域制限、ブラウザーの自動再生制限により、再生や同期ができない場合があります。


Discordの既定Entry PointはURL Mappingのルートを開きます。`web/middleware.ts`はDiscord SDKの`frame_id`と`instance_id`を含むルートアクセスだけを`/activity/music`へ転送し、クエリを保持します。通常のWebトップページは変わりません。
