# PostgreSQL単体 + BOT自前API 移行手順

このリポジトリは、Discord BOTとWebの国づくりマップがSupabase REST/RPCへ接続していた箇所を、プロジェクト管理下のHTTP API (`api/app.py`) に集約します。APIだけがローカルPostgreSQLへ接続し、BotとWebにはDBパスワードを配布しません。Bot側の小さな互換クライアント (`core/api_client.py`) は、既存の `.table(...).select()/insert()/update()/delete()/upsert()` と `.rpc()` の呼び出し形を保ちますが、Supabase SDKは使いません。

本手順は **PostgreSQL 17のpublicスキーマとアプリデータの移行** を対象にします。ユーザーが選択したとおりSupabase Authユーザー／セッションは移行しません。Supabase Storageのファイルも対象外です。Auth由来の外部キーが残っている場合の扱いは後述します。

## 0. 移行前に保全するもの

Botを停止する前に、SSD上の既存バックアップを保持し、`pg_restore --list` でdumpが読めることを再確認してください。既存の `/home/luna/BOT/bot_kv.json` は、名前空間データだけでなく `__pending__` があればその内容も重要です。別名コピーをSSD上に作り、移行完了を確認するまで削除・上書きしないでください。

```bash
sudo install -o luna -g luna -m 0600 /home/luna/BOT/bot_kv.json /srv/supabase-data/backups/bot_kv.before-api.json
sudo sha256sum /srv/supabase-data/backups/bot_kv.before-api.json
sudo pg_restore --list /srv/supabase-data/backups/botdb-restored-before-api-2026-11-03.dump >/tmp/botdb-toc.txt
```

このPRはデータdumpを作成・復元したり、本番DBを書き換えたりしません。すでに復元済みの `botdb` をAPIの接続先にする想定です。アプリを止めた状態で最終dumpを取ると、cutover直前の書き込みも取りこぼしません。

## 1. 移行先DBのSupabase Auth参照を確認する

`public` のテーブルに `auth.users` を参照する外部キーが残っていると、Authスキーマを含まない通常のPostgreSQLでは復元または後続のDDLが失敗する場合があります。Authを移行しない方針なので、該当制約がまだあるかを確認してください。

```sql
SELECT conrelid::regclass AS referencing_table, conname AS constraint_name
FROM pg_constraint
WHERE contype = 'f'
  AND confrelid = to_regclass('auth.users')
ORDER BY 1, 2;
```

結果が空なら何もしません。結果に `api_operation_audit_actor_id_fkey` / `api_operation_budgets_actor_id_fkey` が含まれ、Authユーザーの参照整合性を今後使わないことを確認した場合に限り、次のデータを消さないDDLを適用できます。

```bash
psql -v ON_ERROR_STOP=1 -d botdb -f docs/sql/remove_auth_user_foreign_keys.sql
```

このSQLは外部キー制約のみを削除し、`actor_id` やテーブル行は削除しません。Authデータを後から移す可能性がある場合は適用せず、Auth相当のスキーマを別途設計してください。

## 2. API専用DBロールを用意する

PostgreSQL上で、API専用のログインロールを作成します。APIプロセスはRLSポリシーを通さず許可済みBOT処理を行うため `BYPASSRLS` が必要です。権限はAPIコードのテーブル/RPC allowlistと共有APIキーによってさらに制限します。APIはインターネットへ直接公開せず、Piではloopbackのみにbindしてください。

```bash
sudo -u postgres psql -d botdb
```

```sql
CREATE ROLE bot_api LOGIN BYPASSRLS;
\password bot_api
GRANT CONNECT ON DATABASE botdb TO bot_api;
GRANT USAGE ON SCHEMA public TO bot_api;
```

既に `bot_api` ロールがある場合は `CREATE ROLE` を再実行せず、`ALTER ROLE bot_api LOGIN BYPASSRLS;` と `\password bot_api` を使います。利用テーブルへの権限を付与します。リスト中のテーブルがdumpに存在しない環境では、その要素を配列から外してください。`party_game_ranking` は読み取り専用ビューです。

```sql
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'bot_kv','users','transaction_history',
    'dungeon_maps','dungeon_players','dungeon_bases',
    'nation_guilds','nation_tiles','nation_players',
    'bump_rta_settings','bump_rta_records','bump_rta_events',
    'bump_rta_pending','bump_rta_reminders','jinrou_ratings',
    'fujo_users','fujo_activities','playlists','user_music_playlists'
  ] LOOP
    IF to_regclass(format('public.%I', t)) IS NOT NULL THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO bot_api', t);
    END IF;
  END LOOP;
END $$;

GRANT SELECT ON TABLE public.party_game_ranking TO bot_api;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO bot_api;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO bot_api;
```

将来 `postgres` ロールで新しいテーブルを追加する場合は、次も一度設定しておくとデフォルト権限が引き継がれます。

```sql
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO bot_api;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO bot_api;
```

APIコードは `public` のうち `api/app.py` の `TABLES` と `RPC_ARGUMENTS` に登録済みのものだけを公開します。新しいテーブル/RPCをBOTから使う際は、ここへ追加してテストも更新してください。

## 3. APIとBotの秘密設定

API用の共有鍵を一度生成し、APIとBotの両方に同じ値を、Gitに含めない環境ファイルで設定します。

```bash
openssl rand -hex 32
```

APIサービスの環境変数:

```dotenv
DATABASE_URL=postgresql://bot_api:<DB_PASSWORD>@127.0.0.1:5432/botdb
BOT_API_KEY=<GENERATED_RANDOM_KEY>
DB_POOL_MIN_SIZE=1
DB_POOL_MAX_SIZE=8
DB_POOL_TIMEOUT=5
```

API側は `/etc/bot-postgres-api.env` に保存し、`root:root`・mode `0600` にしてください（systemd unitとKV照合ツールがこのパスを使います）。

Botの環境変数:

```dotenv
BOT_API_BASE_URL=http://127.0.0.1:8787
BOT_API_KEY=<GENERATED_RANDOM_KEY>
```

Webアプリを別ホストで動かす場合も `BOT_API_KEY` はサーバー環境変数にだけ設定し、`NEXT_PUBLIC_` を付けたりクライアントJavaScriptに埋め込んだりしないでください。Vercel等のクラウドからPiへ接続する場合、`127.0.0.1` は使えません。Tailscale/WireGuard等のプライベート経路とHTTPSを用意し、APIを無認証で公開しないでください。

### Bot KV JSONを復元DBと照合する

Botを初めて自前APIにつなぐ前に、保存したJSONとローカル `botdb` をdry-run照合します。ツールは既定で読み取り専用で、`DATABASE_URL` またはroot専用 `/etc/bot-postgres-api.env` の値を使い、`botdb` のloopback接続以外を拒否します。通常のJSON値はDBに無いキーだけを追加し、既存DB値は上書きしません。`__pending__` の値は最新値としてupsertし、pending削除は削除として反映します。

```bash
sudo /home/luna/BOT/.venv/bin/python /home/luna/BOT/tools/import_bot_kv_json.py --file /home/luna/BOT/bot_kv.json
```

`differing existing values` が0より大きければ、適用せずSSD上のJSONコピーとdumpを使って差分を確認してください。pending削除数も意図した削除か確認します。内容を確認した後に限り、明示的な `--apply` で差分を反映します。

```bash
sudo /home/luna/BOT/.venv/bin/python /home/luna/BOT/tools/import_bot_kv_json.py --file /home/luna/BOT/bot_kv.json --apply
```

## 4. APIを起動・疎通確認する

プロジェクトのPython環境に `fastapi`、`uvicorn`、`psycopg[binary,pool]` をインストールし、リポジトリルートからAPIを起動します。Pi上の実際のvenv/作業ディレクトリに合わせてコマンドを調整してください。

```bash
cd /home/luna/BOT
.venv/bin/uvicorn api.app:app --host 127.0.0.1 --port 8787
```

別ターミナルでhealth checkを確認します。`/healthz` はDB接続可否と `ok` だけを返し、鍵やDB情報は返しません。

```bash
curl --fail http://127.0.0.1:8787/healthz
```

本番常駐には `deploy/bot-postgres-api.service.example` を環境に合わせて複製し、専用のEnvironmentFileをroot所有・mode `0600` にしてsystemd登録してください。APIログに接続URLや鍵を出さないでください。初回はBOTを起動せず、ユニットの起動・health check・PostgreSQLログを確認します。

## 5. Bot/Webを切り替える

1. APIが安定稼働し、`/healthz` が成功することを確認します。
2. Botを停止します。停止後、PostgreSQLの最終dumpをSSD上の別ファイルへ作成し、既存バックアップとは別名で保持します。
3. Botの環境に `BOT_API_BASE_URL` と `BOT_API_KEY` を設定し、旧Supabase URL/キーは削除します。
4. Botを起動し、wallet、nation、dungeon、bump RTA、人狼rating、fujo、生存設定、音楽プレイリストを読み書きする代表ケースを各1回確認します。
5. `bot_kv.json` の名前空間データがローカルDBと一致すること、`__pending__` があった場合はAPIへ再送されて空になったことを確認します。未送信データが残るときはファイルを消さず、API/DBエラーを調査してください。SSD上の退避コピーは確認完了まで保持します。
6. Web地図は `BOT_API_BASE_URL` / `BOT_API_KEY` をサーバー環境に設定して確認します。BotとWebの動作が確認できるまで、旧dump・JSONコピー・戻せる旧リリースを保持します。

APIクライアントは通信タイムアウトを「DB側でcommit済みか不明」と扱い、自動で同じ書き込みを再送しません。明示的にSQL開始前と分かるDBプール満杯の503だけを再試行します。`/pay` とDungeon経済処理は、RPC未登録が明示された場合だけ旧方式へ移ります。通信断など結果が不確定な場合は二重更新を避けて停止し、Dungeon RPCの明示的な `false` も旧方式で再実行しません。タイムアウト表示を見て手動で再実行する前に、対象データを読み直して二重処理を避けてください。

## 6. 切り戻し

不具合があればBotを停止し、旧バージョンと直前のPostgreSQL/JSONバックアップへ戻します。BotとAPIの設定変更だけではSupabase側データは消えません。切り替え完了後も、Supabase契約・プロジェクト削除など不可逆操作は、全機能とデータがローカルで確認できるまで行わないでください。

## 現在のAPI制約

- Bot/Webは直接PostgreSQLへ接続せず、全て `/v1/query` または `/v1/rpc` を経由します。
- SQL値はparameter binding、識別子はスキーマ列照合とquoted identifierを使います。`update`/`delete` は最低1つのfilterを要求します。
- APIは `public` allowlistのみ公開し、Supabase `auth` schema、任意SQL実行、任意関数呼び出しは公開しません。
- Selectの既定上限は1,000行、明示上限は10,000行です。ページングが必要な大きいデータは `.range()` を使います。
- これはBOT内部用の共有鍵APIで、一般公開APIやエンドユーザー認証基盤ではありません。
