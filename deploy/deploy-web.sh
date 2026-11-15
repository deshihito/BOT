#!/usr/bin/env bash
# AGOBOT Web をラズパイ上でビルドしてリリースを切り替える。
# 使い方: Pi 上でユーザー luna として `bash deploy/deploy-web.sh` を実行する。
# 前提: systemd ユニット agobot-web（deploy/agobot-web.service.example）が
#       インストール済みで、/etc/agobot-web.env に環境変数が置いてあること。
set -euo pipefail

SRC="$HOME/BOT"
ROOT="/srv/supabase-data/agobot-web"
RELEASE="$ROOT/releases/$(date +%Y%m%d%H%M%S)"
BUILD="$ROOT/build"

mkdir -p "$ROOT/releases"

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

# コマンド一覧データは Bot コードから再生成する
cd "$SRC"
venv/bin/python -m tools.export_commands --out web/data/commands.json
# コマンド解説（/commands）の機能一覧もレジストリから再生成する（自動追従）
venv/bin/python -m tools.export_action_guides --out web/data/action-guides.json

# ビルド用コピー（node_modules / .next は持ち込まない）
rm -rf "$BUILD"
mkdir -p "$BUILD"
cp -a "$SRC/web/." "$BUILD/"
rm -rf "$BUILD/node_modules" "$BUILD/.next"
cd "$BUILD"
npm ci
npm run build

# リリースを組み立てる（standalone 本体 + .next/static + public）
mkdir -p "$RELEASE"
cp -a "$BUILD/.next/standalone/." "$RELEASE/"
mkdir -p "$RELEASE/.next/static"
cp -a "$BUILD/.next/static/." "$RELEASE/.next/static/"
cp -a "$BUILD/public" "$RELEASE/public"

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
