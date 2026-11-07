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

# コマンド一覧データは Bot コードから再生成する
cd "$SRC"
venv/bin/python -m tools.export_commands --out web/data/commands.json

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

# 古いリリースは新しい順に3つだけ残す（切り替え済みの current は削除対象にしない）
cd "$ROOT/releases"
ls -1dt */ | tail -n +4 | while read -r old; do
  old="${old%/}"
  if [ "$(readlink -f "$ROOT/current")" != "$ROOT/releases/$old" ]; then
    rm -rf -- "$ROOT/releases/$old"
  fi
done
