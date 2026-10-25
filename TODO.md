# TODO

## Web UIの削減

- [x] トップ表題を「使いたいこと、全部このボットでいい。」へ変更する。
- [x] AGO Coderを入力・送信・回答だけの画面へ縮小する。
- [x] 未実装の画面・案内を空欄または非表示にする。

## Discordログイン

- [x] Discord OAuth後に署名付きセッションを発行し、ダッシュボードへ遷移する。
- [x] 未ログイン時のダッシュボードとAGO Coderをログイン画面へ遷移させる。
- [x] ログアウト時にセッションを削除する。

## Bot側Coder連携

- [x] Webから共有シークレット付きでBot内部APIへ依頼する。
- [x] Botの既存AIプロバイダールーターで回答する。
- [x] Bot未起動・上流失敗・連続実行をサーバー側で制限する。

## Music同期Activity

- [x] **Activity画面と起動** — 既存Next.jsに`/activity/music`を追加し、DiscordのActivity一覧から起動する構成にする。Musicパネル、既存コマンド、既存ボタン、その他VC機能のUIは変更しない。Activity参加者はBotの現在曲のYouTube動画を公式プレイヤーで無音表示し、Activityに参加しない利用者は従来どおりBotの音楽音声だけを受け取る。初回再生は各利用者の明示操作後に開始する。
- [x] **安全なMusic状態同期** — Activityは再生中YouTube動画のID・タイトル・再生状態・現在位置に追従し、曲変更、再生、一時停止、シーク、スキップ、停止をBotの状態から反映する。ActivityからBotの音楽操作は行わない。YouTube以外、動画情報がない、または埋め込み不可の場合は再生せず説明を表示する。同期は表示中に約2秒間隔で行い、ネットワーク・YouTube側のバッファリングによる数秒のずれを許容し、完全なフレーム同期は保証しない。
- [x] **認証と情報保護** — Activity認証コードはPKCE付きでサーバー側交換し、短寿命署名トークンとHMAC署名付きWeb-Bot通信を使う。Botは呼出者が対象guild/voice channelに参加していることを確認する。ActivityのブラウザーにはDiscord/共有シークレット、Supabaseキー、YouTube音声ストリームURL、HTTPヘッダーを渡さず、返却状態は必要な動画・同期情報だけに限定する。新規DB・外部LLM呼び出しは追加しない。
- [ ] **Discord設定後の実機確認** — Discord Developer PortalでEmbedded App/Activities、本番WebホストとYouTube用URL Mapping、利用するSupported Platformsを設定した後、Discord内でActivityを起動し、複数参加者で無音動画とMusic同期を確認する。YouTubeの広告・年齢・地域・埋め込み制限は回避せず、規約適合を保証しない。

## Vercelビルド安定化

- [x] **`/map`のビルドブロック防止** — `/map`はSupabaseマップデータを使った表示を維持し、取得データは60秒キャッシュする。Supabaseへの取得はNext.jsの静的ページ生成時ではなくリクエスト時に行い、応答が遅い場合は有限時間で中止して既存の「準備中」表示へフォールバックする。そのため、Supabaseの応答待ちでVercelの本番ビルドが停止しない。

## Raspberry Pi / Cloudflare Tunnel

- [ ] **Bot APIのポートとVercel接続** — Raspberry Pi上のFlask APIは`BOT_API_PORT`（既定値`8081`）で待ち受け、Cloudflare Tunnelの公開ホストは`http://localhost:8081`へ転送する。Vercelの`BOT_CODER_BASE_URL`にはTunnelの公開HTTPSホストを設定し、`CODER_SERVICE_SHARED_SECRET`はPiとVercelで同じ値にする。ManusのCloudflare Tunnel設定とPi上でのサービス稼働確認後、Activity状態取得とAGO CoderがPiへ到達できることを確認する。
