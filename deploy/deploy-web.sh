#!/usr/bin/env bash
# AGOBOT Web をラズパイ上でビルドしてリリースを切り替える。
# 使い方: Pi 上でユーザー luna として `bash deploy/deploy-web.sh` を実行する。
# 前提: systemd ユニット agobot-web（deploy/agobot-web.service.example）が
#       インストール済みで、/etc/agobot-web.env に環境変数が置いてあること。
#
# 高速化（2026-11-15）: ビルドディレクトリを使い回し、入力が前回成功時と
# 同一なステップをスキップする。キャッシュが無い/壊れている場合は常に
# 従来どおり全部実行する（初回は従来と同コスト）。
# - package-lock.json が同一なら npm ci をスキップ（node_modules 再利用）
# - Bot 側ツリー（cogs/core/tools 等）が同一なら export 2本をスキップし、
#   前回生成した JSON をキャッシュから戻す（web のみの変更で効く）
# - .next/cache と public/models・public/ort（ビルド生成物）は保持し、
#   Next の増分ビルドと bgcut モデルの再ダウンロード回避に使う
# - ソース同期はマニフェスト方式: リポジトリで削除されたファイルは
#   ビルド側からも消す（古いファイルの残留・復活を防ぐ）
# 各ステップの所要時間は [deploy-timing] として出力され、自動デプロイ時は
# autodeploy.log に残る。全部やり直したい場合は $ROOT/build と $ROOT/cache を消す。
set -euo pipefail

SRC="${AGOBOT_SRC:-$HOME/BOT}"
ROOT="${AGOBOT_WEB_ROOT:-/srv/supabase-data/agobot-web}"
RELEASE="$ROOT/releases/$(date +%Y%m%d%H%M%S)"
BUILD="$ROOT/build"
CACHE="$ROOT/cache"
MANIFEST="$CACHE/source-manifest.txt"

mkdir -p "$ROOT/releases" "$CACHE/data" "$BUILD"

# ビルド状態（ビルド中の PR 番号）を実行中の Web が読める場所へ書き出す。
# 状態書き出しの失敗でビルド自体を落とさないよう、常に || true で包む。
STATUS_FILE="$ROOT/build-status.json"
STATUS_PY="$SRC/deploy/write_build_status.py"
PYBIN="$SRC/venv/bin/python"
[ -x "$PYBIN" ] || PYBIN="python3"
HEAD_SHA="$(git -C "$SRC" rev-parse HEAD 2>/dev/null || echo "")"
DEPLOYED_SHA="$(cat "$ROOT/deployed-head" 2>/dev/null || true)"
write_build_status() {
  "$PYBIN" "$STATUS_PY" --path "$STATUS_FILE" --repo "$SRC" --state "$1" \
    ${HEAD_SHA:+--head "$HEAD_SHA"} ${DEPLOYED_SHA:+--base "$DEPLOYED_SHA"} \
    >/dev/null 2>&1 || true
}
on_exit() {
  rc=$?
  if [ "$rc" -ne 0 ]; then
    write_build_status failed
  fi
}
trap on_exit EXIT
write_build_status building

T_START=$(date +%s)
T_STEP=$T_START
timing() {
  local now
  now=$(date +%s)
  echo "[deploy-timing] $1: $((now - T_STEP))s"
  T_STEP=$now
}

# --- ソース同期（削除を反映しつつ、生成物と依存は保持する） ---
(
  cd "$SRC/web"
  find . -type f \
    ! -path './node_modules/*' ! -path './.next/*' \
    ! -path './public/models/*' ! -path './public/ort/*' \
    | sed 's|^\./||' | LC_ALL=C sort >"$CACHE/source-manifest.new"
)
if [ -f "$MANIFEST" ]; then
  # 前回あったのに今回無いファイル = リポジトリで削除されたファイル
  LC_ALL=C comm -23 "$MANIFEST" "$CACHE/source-manifest.new" |
    while IFS= read -r f; do
      rm -f -- "$BUILD/$f"
    done
fi
cp -a "$SRC/web/." "$BUILD/"
mv "$CACHE/source-manifest.new" "$MANIFEST"
# Next のビルドキャッシュだけ残して前回の成果物を掃除する
if [ -d "$BUILD/.next" ]; then
  find "$BUILD/.next" -mindepth 1 -maxdepth 1 ! -name cache -exec rm -rf -- {} +
fi
timing "source-sync"

# --- コマンド一覧データ（Bot コードから再生成 / キャッシュ再利用） ---
# export の入力は Bot 側コード一式。git のツリーハッシュで同一判定する。
BOT_TREE_HASH="$(git -C "$SRC" ls-tree -r HEAD -- \
  cogs core tools api locales scripts Assets assets \
  config.py defining.py main.py global_channels.json requirements.txt font.ttf \
  | sha256sum | cut -d' ' -f1)"
mkdir -p "$BUILD/data"
if [ -f "$CACHE/bot-tree.sha" ] && [ "$(cat "$CACHE/bot-tree.sha")" = "$BOT_TREE_HASH" ] &&
  [ -f "$CACHE/data/commands.json" ] && [ -f "$CACHE/data/action-guides.json" ]; then
  cp -a "$CACHE/data/commands.json" "$CACHE/data/action-guides.json" "$BUILD/data/"
  timing "exports (skipped: bot tree unchanged)"
else
  # コマンド一覧データは Bot コードから再生成する
  (cd "$SRC" && venv/bin/python -m tools.export_commands --output "$BUILD/data/commands.json")
  # コマンド解説（/commands）の機能一覧もレジストリから再生成する（自動追従）
  (cd "$SRC" && venv/bin/python -m tools.export_action_guides --output "$BUILD/data/action-guides.json")
  cp -a "$BUILD/data/commands.json" "$BUILD/data/action-guides.json" "$CACHE/data/"
  echo "$BOT_TREE_HASH" >"$CACHE/bot-tree.sha"
  timing "exports"
fi

# --- 依存関係（lock が変わった時だけ npm ci） ---
cd "$BUILD"
LOCK_HASH="$(sha256sum package-lock.json | cut -d' ' -f1)"
if [ -f "$CACHE/lock.sha" ] && [ "$(cat "$CACHE/lock.sha")" = "$LOCK_HASH" ] &&
  [ -x "$BUILD/node_modules/.bin/next" ] && [ -f "$BUILD/node_modules/.package-lock.json" ]; then
  timing "npm-ci (skipped: package-lock unchanged)"
else
  npm ci
  echo "$LOCK_HASH" >"$CACHE/lock.sha"
  timing "npm-ci"
fi

# --- ビルド ---
npm run build
timing "next-build"

# --- リリース組み立て（standalone 本体 + .next/static + public） ---
mkdir -p "$RELEASE"
cp -a "$BUILD/.next/standalone/." "$RELEASE/"
mkdir -p "$RELEASE/.next/static"
cp -a "$BUILD/.next/static/." "$RELEASE/.next/static/"
cp -a "$BUILD/public" "$RELEASE/public"
timing "release-assemble"

# current を新しいリリースへ原子的に切り替えて再起動
ln -sfn "$RELEASE" "$ROOT/current"
sudo systemctl restart agobot-web
write_build_status deployed

# 古いリリースは新しい順に3つだけ残す（切り替え済みの current は削除対象にしない）
cd "$ROOT/releases"
ls -1dt */ | tail -n +4 | while read -r old; do
  old="${old%/}"
  if [ "$(readlink -f "$ROOT/current")" != "$ROOT/releases/$old" ]; then
    rm -rf -- "$ROOT/releases/$old"
  fi
done
echo "[deploy-timing] total: $(( $(date +%s) - T_START))s"
