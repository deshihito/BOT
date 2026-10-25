# Web UI整理計画

## 目的

AGOBOT Webを、必要な案内と実装済みの操作だけに絞る。AGO Coderはダッシュボード内の1機能として扱い、モデル実行は既存Botサーバーに委譲する。

## 既存Webの実装方針

- トップの表題を「使いたいこと、全部このボットでいい。」にする。
- AGO Coderは入力、送信、回答だけを表示する。セッション、ファイル、権限、モデル選択、GitHub連携など未実装のUIは表示しない。
- Web APIはDiscordログインを検証後、共有シークレット付きでBotの`/internal/coder/run`へリクエストを送る。APIキーはWebやブラウザーに置かない。
- Botは既存の`AI_PROVIDER_ORDER`とLogfare設定を使い、実際に設定済みのプロバイダーで回答する。
- Discord OAuthのコールバックで署名付きのHTTP onlyセッションを作成し、ログイン完了後は`/dashboard`へ遷移する。
- `/dashboard`と`/coder`は有効なDiscordセッションがない場合`/login`へ遷移する。
- 未実装の画面は案内文を表示せず空欄にする。

## 既存Webのデザイン

白地、細い罫線、短いラベルのみで構成する。画面遷移と操作数を増やすためだけのパネル、状態表示、説明文は追加しない。

# Discord Activity: Music同期YouTube動画（承認済み範囲）

## 目的と仕様

Discord内で利用者がActivityを起動すると、そのActivityが同じボイスチャンネルでBotのミュージック機能が再生しているYouTube動画を無音で表示する。Activityに参加しない利用者の音声体験は従来どおりで、音楽音声はBotだけが担当する。Activity参加者は映像を見て、曲変更、再生、一時停止、シーク、スキップ、停止をBotの音楽再生状態に追従させる。

**変更はActivityと同期に必要な読み取り専用連携だけに限定する。** 既存のMusicパネル、コマンド、ボタン、その他のVC機能やそのUIは変更しない。ActivityはDiscordのActivity一覧から起動する。Music状態はBotを唯一の正とし、Activity側の操作からBotの再生を変更しない。YouTube以外の曲や埋め込み不可の動画では、その旨をActivity内で表示する。

## 実装方針

1. 既存Next.jsアプリ内にActivityルートを追加し、`@discord/embedded-app-sdk`と公式YouTube IFrame Player APIを使う。SDKの`patchUrlMappings`とDiscord Developer PortalのURL MappingでYouTube通信をプロキシ経由にする。Activityに初参加した利用者が「同期して再生」を押してから、常にミュートしたプレイヤーを再生する。ブラウザーの自動再生制限、利用者ごとのバッファリング、YouTubeの埋め込み・年齢・地域制限には従い、それらを回避しない。
2. Activity SDKの認証コードを既存Next.jsサーバーでDiscordに交換し、短寿命の署名済みActivityトークンを発行する。Activityからの状態取得ではそのトークンを検証し、既存のHMAC署名付きWeb-Bot連携パターンを再利用する。Discord/共有シークレットはサーバー環境に置き、Supabaseキー、YouTubeの音声ストリームURLやHTTPヘッダーはブラウザーへ返さない。
3. Botに読み取り専用のActivity状態APIを追加し、呼出者が対象guild・voice channelに参加していることを確認する。返却データはYouTube動画ID、タイトル、再生状態、現在位置、再生速度、サーバー時刻に限定する。既存の`VoiceCog`状態を利用し、新しいDBや外部LLM呼び出しは追加しない。
4. Activityは表示中のみ約2秒間隔で状態を取得し、動画／再生状態／位置をBotに追従させる。ネットワークやYouTubeのバッファリングにより完全なフレーム単位同期は保証せず、数秒程度のずれがあり得る。
5. 同期用スナップショットとYouTubeプレイヤー接続部を分離し、将来の拡張余地は残すが、今回の対象はYouTube動画のみとする。

## プロジェクト構造

- `web/app/activity/music/`: Discord Activityの画面、SDK初期化、YouTubeプレイヤー同期。
- `web/app/api/activity/`: Activity OAuthコード交換、短寿命トークン発行、Music状態取得のNext.js APIルート。
- `web/lib/activity-auth.ts`: Activity用短寿命トークンの署名と検証。
- `web/app/globals.css`: Activityルート内だけに適用する全画面・レスポンシブスタイル。既存ページの外観は変えない。
- `web/public/manus-routes.json`: Activityページのルート宣言。
- `cogs/sio_music.py`と`core/music_activity.py`: 既存Music状態から、秘密情報を含まないYouTube同期スナップショットを作成。
- `keep_alive.py`: HMAC検証済みのBot内部Music状態ルート。Webサーバーからのみ利用。
- `tests/`と`web/tests/`: 既存テスト環境に沿った同期データ／認証回帰カバレッジ。

## 必要な設定と注意点

既存DiscordアプリでEmbedded App/Activitiesを有効化し、既存Vercelドメインと、少なくとも`/youtube` → `www.youtube.com`、`/googlevideo/{subdomain}` → `{subdomain}.googlevideo.com`、`/ytimg` → `i.ytimg.com`のURL Mappingを登録する。利用するSupported Platformsも有効化する。既存のサーバー側`DISCORD_CLIENT_ID`をブラウザーへ公開可能なアプリIDとして渡し、DiscordクライアントシークレットとWeb-Bot共有シークレットはサーバー環境だけに保持する。Web側のNode依存は既存npm lockfileとnpm 10.9.2を使い、SDKの推移的なZodは修正済み`4.6.6`へ限定上書きする。既存Next.js/PostCSSの監査警告はActivityとは別の既存依存として変更していない。

Activityでは公式YouTubeプレイヤーを使い、動画・音声データの抽出、広告・地域・年齢・埋め込み制限の迂回は行わない。YouTube規約にはコンテンツ送信や公開上映に関する制限があるため、既存Bot音声再生と組み合わせたグループ利用の規約適合は保証しない。

## 参考資料

- Discord: [Building an Activity](https://docs.discord.com/developers/activities/building-an-activity)、[Activities overview](https://docs.discord.com/developers/activities/overview)
- YouTube: [IFrame Player API](https://developers.google.com/youtube/iframe_api_reference)、[Terms of Service](https://www.youtube.com/t/terms)
