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

Discord Developer Portalで既存アプリのActivities／Embedded Appを有効にし、Vercelの`bot`プロジェクトの本番ホスト`bot-deshihito.vercel.app`（URL MappingのTargetにはホスト名だけを指定）を`/`に登録してください。最新デプロイが成功するまではこのホストのActivityルートが未反映です。YouTubeプレイヤーの外部通信には、少なくとも`/youtube` → `www.youtube.com`、`/googlevideo/{subdomain}` → `{subdomain}.googlevideo.com`、`/ytimg` → `i.ytimg.com`のMappingを設定します。SDKの`patchUrlMappings`でYouTubeのスクリプトやiframeをDiscordプロキシ経由にします。YouTube側が別の外部ホストを要求する場合は、そのMappingも追加してDiscord実クライアントで検証してください。`/`は全パスに一致するため、より具体的なMappingより後（一覧の最後）に置きます。Developer PortalのSupported Platformsで利用するデスクトップ／Web／iOS／Androidも有効にします。

ActivityはMusicと同じサーバーのボイスチャンネルで起動します。Musicパネルへのボタン追加や、他のVC機能・UIの変更は行いません。Activityは表示中、約5秒ごとにBot側のMusic状態を取得します。受信した再生位置とサーバー時刻からブラウザー側で位置を補間するため、従来の2秒ポーリングよりAPI負荷を下げつつ同期を維持します。ブラウザーの自動再生制限を満たすため、参加者ごとに一度「同期して再生」を押してください。YouTube公式プレイヤーはミュートし、VCの音声は従来どおりBotが担当します。ネットワーク遅延・バッファリング、YouTube側の埋め込み不可／年齢／地域制限、ブラウザーの自動再生制限により、再生や同期ができない場合があります。

### Activity映像の分散Media Worker

Activity映像の`yt-dlp`、`ffmpeg`、HLS生成はBotプロセスから分離できます。Bot側に次の環境変数を設定すると、BotはVoiceチャンネル参加確認とHMAC認証だけを行い、映像生成・HLSキャッシュは`activity_media_worker.py`へ委譲します。

```dotenv
ACTIVITY_MEDIA_WORKER_URL=https://media-worker.example.com
ACTIVITY_MEDIA_WORKER_SECRET=<BotとMedia Workerで共有するランダムな値>
```

Media WorkerはBotリポジトリのルートで次のように起動できます。`ffmpeg`をインストールした別ホストまたは別コンテナで常駐させてください。

```bash
export ACTIVITY_MEDIA_WORKER_SECRET='<同じ共有シークレット>'
export ACTIVITY_MEDIA_WORKER_PORT=10001
python3 activity_media_worker.py
```

同じ動画IDへの同時要求はワーカー内で1本のFFmpegジョブに集約され、HLSセグメントはTTL後に削除されます。Media Workerが未設定の場合は後方互換のためBot内処理へフォールバックしますが、本番ではWorkerを設定してBot上の映像生成を無効化してください。


Discordの既定Entry PointはURL Mappingのルートを開きます。`web/middleware.ts`はDiscord SDKの`frame_id`と`instance_id`を含むルートアクセスだけを`/activity/music`へ転送し、クエリを保持します。通常のWebトップページは変わりません。
