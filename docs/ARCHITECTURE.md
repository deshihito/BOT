# ARCHITECTURE — 構成と既定

このリポジトリの「どこに何を置くか」「どう書くか」の正。新しい機能は
この既定に従い、既存コードは触る箇所から順に寄せる (一斉変換はしない)。

## 境界

- **Bot 本体 (Python)**: `main.py` が `cogs/` を自動ロードする。
  `cogs/<genre>.py` は入口 (集約・再エクスポート) で、実ロジックは
  `core/<genre>/<feature>/` に置く。ジャンル軸は general / game /
  support / vc / help の5つ (+ quick 入口)。
- **Bot 用 DB API (Python/FastAPI)**: `api/`。Bot は DB に直接触らず
  この API 経由。Web 側の `web/app/api/` とは別物なので混同しない。
- **Web (Next.js)**: `web/`。ページは `web/app/`、ロジックは `web/lib/`。
  `web/lib/` の中身: 単体ゲームのロジックは `games/`、ドメイン単位は
  `worldbox/` `balku/` `lll/` `one-prompter/` `viewslopper/` `bgcut/`
  `online/` `three-kit/`、平置きは共通基盤 (auth / bot-api / site /
  games-catalog / gesture / sfx 等) とワーカービルド入力
  (compute-* / chess-* — `scripts/build-workers.mjs` がパスで参照する
  ため平置きを維持) のみ。新規ロジックは平置きに足さず、属する
  ドメインのフォルダへ。
- **データ**: 実行時データの置き場は `<repo>/data/` のみ。
  `core/data/` 等は保存先ずれ期間の旧保存先 (stray) で、移行読み取り
  専用。新規書き込みで作らない。

## 既定 (規約)

### パス解決は `core/paths.py` のみ

- リポジトリルート、アセット、フォント、データ保存先は
  `core.paths` (`REPO_ROOT` / `data_path()` / `asset_path()` /
  `font_path()` / `shared_asset_path()` / `DEFAULT_FONT_PATH`) 経由。
- `Path(__file__).parents[N]` でルートを数える書き方は新規禁止。
  モジュールを移すたびに壊れるため (過去に盤面描画が silently
  フォールバックする事故あり)。例外は stray 再現専用の
  `core/support/data_paths.stray_path()` 系だけ。
- 保存先の解決と stray 移行読み取りは `core/support/data_paths.py`
  (`data_path` / `load_migrated`) に集約する。各機能で再実装しない。

### 1機能 = 1ディレクトリ

- `core/<genre>/<feature>/` を単位とし、入口ファイルは `cog.py`、
  純ロジックは役割名のモジュールに分ける。
- 単ファイルで置かれている既存機能は、次に触るときにフォルダ化する。
- 同名の二重階層 (例: 旧 `core/game/game/` のような genre 名の反復)
  を新規に作らない。

### 命名

- ディレクトリ・モジュールは小文字 snake_case。
- 例外 (現行の正として維持): `Assets/` (大文字) は Python 側アセット、
  `assets/` (小文字) は共有バイナリ。統合はパス参照を `core.paths`
  に寄せ切ってから別途行う。
- 表示名と内部 ID は分離する (既存裁定)。リネームは表示名側だけ。

### ドキュメント

- 恒久仕様は `docs/`。調査メモ・作業計画はルート直下に置かず、
  終わったら `docs/archive/` へ送る。
- 機能固有の決定事項は、その機能の `docs/<feature>.md` か
  共有ノート (例: `docs/world-box-shared.md`) に集約する。

### テスト

- Python: `tests/test_<feature>.py`。テスト同士が `from tests.xxx
  import` で相互参照する構造のため、テストファイルの移動は
  import 付け替えとセットでのみ行う。
- Web: `web/tests/`、`npm test` が CI 必須チェック。

## 動かしてはいけないもの (外部参照あり)

- `deploy/`: Pi の systemd ユニットが `/home/luna/BOT/deploy/...`
  を絶対パスで ExecStart する。移動・リネームは Pi 側のユニット
  書き換えとセットでない限り禁止。
- `tools/pr_overwrite_guard.py`: `.github/workflows/pr-guard.yml`
  がこのパスで呼ぶ。
- `main.py` / `keep_alive.py` / `config.py`: Pi の起動経路
  (`venv/bin/python main.py --deployed`) が前提とする配置。

## 再構成の進め方

1. 基底 (`core/paths.py` 等) を先に作り、参照を寄せる。
2. 移動は `git mv` で差分として残し、1 PR の範囲を小さく保つ
   (overwrite-guard と Pi 自動デプロイのため)。
3. 各 PR は Python テスト + Web テストの両方を緑にしてからマージする。
