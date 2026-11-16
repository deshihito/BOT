# AGO BOT

Discord ボット「AGO BOT」と公式サイト (agobot.app) のモノレポ。
構成の正は [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 地図

| 場所 | 中身 |
|---|---|
| `main.py` | Bot 本体の入口。`cogs/` を自動ロードし、復旧処理を持つ |
| `cogs/<genre>.py` | ジャンル別の入口 (general / game / support / vc / help / quick)。実ロジックは持たず `core/` へ集約する |
| `core/<genre>/<feature>/` | Bot の実ロジック。1機能 = 1ディレクトリが既定 |
| `core/paths.py` | **パス解決の基底**。ルート / データ / アセット / フォントはここ経由で取る。新規コードで `Path(__file__).parents[N]` を書かない |
| `core/support/data_paths.py` | データ保存先と旧保存先 (stray) の移行読み取り |
| `api/` | Bot 用 DB API (FastAPI)。Web 側の API は `web/app/api/` で、別物 |
| `web/` | 公式サイト + Web ゲーム (Next.js)。`web/lib/` にロジック、ドメイン別フォルダあり。WORLD BOX は別レポ分離候補として1ジャンル扱い (詳細は `docs/ARCHITECTURE.md`) |
| `Assets/` | Python 側の画像・音声アセット (大文字が現行の正) |
| `assets/` | 共有バイナリ (fonts / hrtf / spatial) |
| `data/` | 実行時データの唯一の置き場 (git 管理外) |
| `tests/` | Python テスト (フラット配置、`from tests.xxx import` の相互参照あり) |
| `web/tests/` | Web テスト (`cd web && npm test`) |
| `docs/` | 恒久仕様。作業メモの置き場ではない |
| `docs/archive/` | 過去の調査メモ (FINDINGS 等)。現在の仕様ではない |
| `deploy/` | Pi デプロイ一式。**Pi の systemd が絶対パスで参照するため移動禁止** |
| `scripts/` `tools/` | 運用・移行用の一回性スクリプト |

## 機能を追加するとき

1. 置き場所は `core/<genre>/<feature>/` (Bot) か `web/app/` + `web/lib/` (Web)。
2. パスは `core.paths` 経由。保存先は `data_path()` の1形式のみ。
3. 入口 (`cogs/`) は薄く保ち、実ロジックは `core/` 側に置く。
4. テストは `tests/test_<feature>.py` (Python) / `web/tests/` (Web) に追加する。

## 実行・テスト

```bash
# Bot (要 .env: BOT_API_BASE_URL / BOT_API_KEY 等)
python main.py

# Python テスト
python -m pytest tests -q

# Web
cd web && npm ci && npm test
```

## デプロイ

Raspberry Pi が GitHub をポーリングして自動デプロイする (Bot 本体と Web は別経路、詳細は `web/README.md` と `deploy/`)。マージ = 数分後に本番反映なので、パス変更を含む PR は特に小さく切ること。
