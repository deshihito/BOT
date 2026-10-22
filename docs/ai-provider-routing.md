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
`deepseek`, `mistral`, `together`, `fireworks`, `nvidia_nim`, `openai`, `logfare` です。
各社のキーは `<PROVIDER>_API_KEY` または `AI_<PROVIDER>_API_KEY` を使います。
`logfare` は従来の `LOGFARE_API_KEY` を使います。

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

設定後に AGO BOT を再起動します。個別のモデル設定がないユーザーは `!ai 質問` で
自動切替を使います。以前に Logfare モデルを個別に選んだユーザーは、`/general` の
「チャットAIモデルを設定」から「自動切替」を選び直します。

プロバイダーがエラー・タイムアウト・空回答を返すと、次の接続先を試します。
HTTP 429 は `Retry-After`（なければ60秒）の間、その接続先を飛ばします。
1回の `!ai` は全接続先を合わせて最大90秒待ちます。
回答欄には成功した接続先とモデル ID が表示されます。
プロバイダーごとのモデル名を別の系統へ設定すればモデルも変わりますが、
同じモデルを維持したい場合は各接続先の ID を同じモデルに合わせてください。

従来の Logfare モデルを個別に選んだ場合の Web 検索と、`!generate` の画像生成は
今までの経路を使います。自動切替経路はテキストの通常回答のみです。
