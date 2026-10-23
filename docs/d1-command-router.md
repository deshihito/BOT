# ClefによるBOT機能代理実行

これはAIチャット機能とは別の機能です。ユーザーが明示的にBOTへメンションした場合、許可済みの既存パネル機能から1つを選ぶため、Logfareのdecision endpointへClefの構造化判定を依頼します。自由文生成や`/chat/completions`ではなく、`POST https://logfare.ai/v1/decisions`にSystem One形式の`model: "clef"`、`state`、`questions`を送り、`result.answers.action.choice`を読み取ります。

## `.env`

```dotenv
D1_COMMAND_ROUTER_ENABLED=true
LOGFARE_API_KEY=<Logfare API key>
D1_COMMAND_TIMEOUT=30
D1_COMMAND_RETRIES=1
```

ClefはLogfareの公開モデル一覧でpremium tier（tier 2）かつトレーニング利用へのオプトインが必要なモデルとして掲載されています。APIキーに利用権限がない場合、判定は失敗しアクションを実行しません。モデルカタログの問い合わせや別モデルへのフォールバックは行わず、既定ではメンション1件につき判定リクエストを1回だけ送ります。

`D1_ENDPOINT`はダンジョンD1など既存のローカルD1機能用であり、この代理実行ルーターでは使用しません。

```text
!d1ping
```

## ユーザー設定

初期状態は無効かつ許可機能なしです。個別のDiscordコマンドではなく、既存パネルの機能アクションを許可します。

```text
!d1tools status
!d1tools allow vc:join
!d1tools allow vc:status
!d1tools allow general:status
!d1tools prompt 依頼が明確な場合だけ選び、判断できなければnoneを返す
!d1tools on
```

VCジャンルの安全な機能をまとめて許可する場合は、`!d1tools allow vc`と指定できます。例えば「VCに入って」とメンションすると、D1は許可済みの`vc:join`を選び、既存のVC参加処理を実行します。

その後、BOTへのメンションで依頼します。

```text
@BOT ステータスを確認して
```

## 安全な失敗動作

LogfareのHTTPエラー、タイムアウト、JSON形式不正、`answers`や`choice`の欠落、許可リスト外の選択、実行対象が不明な場合は、機能を実行しません。別モデルやローカルD1へのフォールバックも行いません。

実行は既存のショートカット用機能ディスパッチャーを再利用します。したがって、VC参加、VC退出、VC状態、一般のステータスなど、すでにパネルから実行できる機能単位へ接続できます。引数入力や確認モーダルが必要な機能、送金・削除・権限操作、AI系機能は代理実行対象から除外しています。

## API仕様の根拠

- [Logfare API仕様](https://logfare.ai/docs) と [公開OpenAPI](https://logfare.ai/openapi.json): `POST /v1/decisions`はモデルのdecision requestを転送し、Cloudflare形式の`result` envelopeを返します。
- [Cloudflare Clef仕様](https://developers.cloudflare.com/workers-ai/models/clef/): `choice`質問は固定候補を採点し、選択結果と候補別確率を返します。
- [Logfareモデル一覧](https://logfare.ai/v1/models): `clef`は`decisions`対応として掲載され、premium tierは推論前にトレーニング利用へのオプトインが必要です。
