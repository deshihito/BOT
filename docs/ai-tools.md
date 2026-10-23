# AI tools

BOTへのメンションに続く依頼をLogfare Clefが判定し、既存機能のツール呼び出しを行う単一機能です。ユーザー別の設定、追加プロンプト、操作ごとの許可リストはありません。危険な操作や明示同意・引数が必要な操作を除いた安全な操作は、既定で全て選択候補です。

人間からのメンションに加え、GPT-6 Lunaなど別BotからBOTへの明示メンションも処理します。別Bot起点の場合は、Discordのinteraction/reply情報、人間の明示メンション、またはVC参加者が人間1人だけのときに呼び出し元を特定します。主体が曖昧な場合は判定APIを呼ばず、理由を返信します。

例:

```text
@BOT VCに入って
```

## 診断

```text
!aitools status
```

このコマンドは全体スイッチ、Logfare APIキー設定有無、利用可能なツール数を表示します。メンション処理の失敗時は、Botは理由を返信します。APIキー未設定、全体無効、API応答エラーを無言で無視しません。

## 運用環境

```dotenv
LOGFARE_API_KEY=<Logfare API key>
AITOOLS_ENABLED=true
AITOOLS_TIMEOUT=30
AITOOLS_RETRIES=1
```

`AITOOLS_ENABLED`は既定で`true`です。全サーバーで停止したい場合だけ`false`を設定します。既定ではメンション1件につきdecisionリクエスト1回で、別モデルへのフォールバックはありません。

ClefはLogfareの公開モデル一覧でpremium tier（tier 2）かつトレーニング利用へのオプトインが必要なモデルとして掲載されています。APIキーに利用権限がない場合、判定失敗の理由を返信し、操作は実行しません。

## 安全境界

Clefは固定候補から1つを選ぶだけで、任意のコマンド文字列やプログラムを実行しません。削除・送金・ロール変更・サーバー設定、VC録音・文字起こし・やまびこ・カラオケ開始、ランダム通話開始、参加先指定が必要なグローバルVC開始などは候補外です。呼び出し元ユーザーの権限を既存の各機能で再検査します。`none`、許可外の回答、APIエラー、タイムアウト、応答不正の場合も何も実行しません。

## API仕様の根拠

- [Logfare API仕様](https://logfare.ai/docs) と [公開OpenAPI](https://logfare.ai/openapi.json): `POST /v1/decisions`はモデルのdecision requestを転送し、Cloudflare形式の`result` envelopeを返します。
- [Cloudflare Clef仕様](https://developers.cloudflare.com/workers-ai/models/clef/): `choice`質問は固定候補を採点し、選択結果と候補別確率を返します。
- [Logfareモデル一覧](https://logfare.ai/v1/models): `clef`は`decisions`対応として掲載され、premium tierは推論前にトレーニング利用へのオプトインが必要です。
