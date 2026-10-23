# `!ai` の API 自動切替

DSH を使わず、AGO BOT が複数の OpenAI Chat Completions 互換 API を直接呼びます。
`/general` →「カスタム・AI設定」→「チャットAIモデルを設定」に
`自動切替: <モデル>` が一つ表示されます。`!generate` の画像生成モデルは対象外です。

## 設定例

AGO BOT の `.env` に、使う接続先の順番、共通モデル、各社の API キーを設定します。

```dotenv
AI_PROVIDER_ORDER=groq,cerebras
AI_ROUTED_MODEL=openai/gpt-oss-120b
GROQ_API_KEY=<Groq のキー>
CEREBRAS_API_KEY=<Cerebras のキー>
AI_CEREBRAS_MODEL=gpt-oss-120b
```

上の例では同じ GPT-OSS 120B を使います。各社でモデル ID の書き方が違う場合だけ
`AI_<PROVIDER>_MODEL` でその接続先の ID を指定します。実際に使えるモデル ID と
料金・無料枠は各社のダッシュボードで確認してください。登録したキーでも
`AI_PROVIDER_ORDER` にない接続先は使用しません。

組み込みの接続先は `groq`, `gemini`, `openrouter`, `cerebras`, `sambanova`,
`deepseek`, `mistral`, `together`, `fireworks`, `nvidia_nim`, `openai`, `logfare`, `apinex` です。
各社のキーは `<PROVIDER>_API_KEY` または `AI_<PROVIDER>_API_KEY` を使います。
`logfare` は従来の `LOGFARE_API_KEY` を使います。

KiosAPI は汎用の OpenAI 互換プロバイダーとして追加できます。KiosAPI のモデル一覧は
`/general` の「チャットAIモデルを設定」を開いたときに API キーで取得し、一覧から選んだモデルは KiosAPI に直接送ります。

```dotenv
AI_PROVIDER_ORDER=logfare,kiosapi
AI_KIOSAPI_BASE_URL=https://kiosapi.com/v1
AI_KIOSAPI_API_KEY=<KiosAPI のキー>
```

モデル一覧の取得には `GET https://kiosapi.com/v1/models` を使います。
Logfare を既定のまま使う場合は、KiosAPI モデルを選択しない限り従来の動作は変わりません。

APInex はチャットモデル選択画面に `free/` で始まるモデルだけを表示します。
モデル一覧には `GET https://api.apinex.bond/v1/models` を使います。選択したモデルは APInex に直接送信します。
Free モデルはAPIのモデルIDで識別し、課金モデルは候補に含めません。

```dotenv
AI_APINEX_BASE_URL=https://api.apinex.bond/v1
AI_APINEX_API_KEY=<APInex のキー>
```

思考強度は選択中のモデルと接続先が明示的に対応する場合だけ送信します。
APInexでは公式に思考強度が案内されているモデルファミリーに限り `low` / `medium` / `high` を反映します。
未対応のAPInexモデルとKiosAPIモデルには送信しません。

`!ai` はUTF-8テキスト、PDF、DOCXの内容を取り込めます。画像はJPG/PNG/WEBPを扱い、
Logfare/KiosAPIのモデルメタデータ、またはAPInex公式の画像対応モデルであることを確認してから送信します。
能力情報を確認できないモデルは画像を受け付けません。添付は1回4件、各8MB、合計12MBまでです。

OmniRushはHTTP APIではなく、Bot上のチャットモデル選択から認証済みCLIを呼び出します。
CLIがBot実行ユーザーから見つかった場合、GPT 6 Astra（OmniRush既定）、GPT 6.1 Sol、GPT 6 Solを表示します。
初回はBotと同じLinuxユーザーで `omnirush login` を行ってください。systemdなどでPATHから見つからない場合は
`.env` の `OMNIRUSH_CLI_PATH` にCLI実行ファイルの絶対パスを指定します。

CLIは空の一時作業ディレクトリで `careful` 権限を使い、BOTのAPIキー等を子プロセスへ渡しません。
画像はOmniRush選択時には受け付けず、リクエストは90秒で打ち切ります。日次利用枠はBotアカウントで共有です。
思考強度はOmniRush CLIの `--thinking` に `minimal` / `low` / `medium` / `high` / `xhigh` / `max` を渡します。
OmniRushへの質問は同サービスへ送信され、
[OmniRushのプライバシー条件](https://omnirush.ai/privacy)に従って処理されます。

上記以外の OpenAI 互換 API も、名前を順番に追加し、URL とキーを指定できます。

```dotenv
AI_PROVIDER_ORDER=groq,my_provider,logfare
AI_MY_PROVIDER_BASE_URL=https://example.com/v1
AI_MY_PROVIDER_API_KEY=<キー>
AI_MY_PROVIDER_MODEL=<同じモデルの提供先 ID>
```

Base URL は `/chat/completions` の手前までを指定します。認証方式は Bearer キーです。
OpenAI 互換ではない API はこの経路に入れられません。

## 動作

設定後に AGO BOT を再起動し、`/general` の「チャットAIモデルを設定」から
「自動切替」を選ぶと `!ai 質問` で利用できます。未選択のユーザーは従来どおり
Logfare の既定モデルを使います。

プロバイダーがエラー・タイムアウト・空回答を返すと、次の接続先を試します。
HTTP 429 は `Retry-After`（なければ60秒）の間、その接続先を飛ばします。
1回の `!ai` は全接続先を合わせて最大90秒待ちます。
回答欄には成功した接続先とモデル ID が表示されます。
プロバイダーごとのモデル名を別の系統へ設定すればモデルも変わりますが、
同じモデルを維持したい場合は各接続先の ID を同じモデルに合わせてください。

従来の Logfare モデルを個別に選んだ場合の Web 検索と、`!generate` の画像生成は
今までの経路を使います。自動切替経路はテキストの通常回答のみです。
