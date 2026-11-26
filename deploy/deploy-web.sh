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

# ビルドが Bot 本体を圧迫しないための資源制限（2026-11-26 の応答不良対策）。
# Pi は 4 コア / RAM 3.7GB で、無制限の next build はワーカーだけで
# CPU 150% 超・メモリ約 1GB を使い、Bot（約 950MB）と合わせて
# スワップスラッシング（load 4.9・空きメモリ 92MB・iowait 24%）を起こした。
# 重いステップは run_limited 経由にし、競合時は Bot を優先する:
# - taskset でビルドを 2 コアに閉じ込める（残り 2 コアは常時 Bot 側に空く）
# - nice / ionice で CPU・IO の優先度を下げる
# - ワーカー数そのものは web/next.config.mjs の experimental.cpus=2 で
#   削り、並列分のメモリピークを下げる
# ハードなメモリ上限（MemoryMax 等）は systemd ユニット側の担当とし、
# deploy/agobot-web-deploy.service.example に置いた（Pi 側はユニットの
# 再インストールが必要）。systemd-run の user scope は Bot の実行環境に
# ユーザーバスが無く使えないことを 2026-11-26 に実測で確認済み。
# 制限機構が無い環境では素通しで続行し、制限の失敗でデプロイ自体を
# 失敗させない（失敗したコミットは再試行されないため）。
run_limited() {
  local -a cmd=("$@")
  if command -v ionice >/dev/null 2>&1; then
    cmd=(ionice -c 2 -n 7 "${cmd[@]}")
  fi
  if command -v taskset >/dev/null 2>&1; then
    cmd=(taskset -c 0,1 "${cmd[@]}")
  fi
  if command -v nice >/dev/null 2>&1; then
    cmd=(nice -n 10 "${cmd[@]}")
  fi
  "${cmd[@]}"
}

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

# ビルド入力が前回デプロイ成功時と同一なら、ビルド自体をスキップする。
# autodeploy はリポジトリ全体の HEAD で発火するため、Bot 側だけの変更でも
# 13 分のフルリビルドが走っていた（2026-11-26 の圧迫の一因）。ビルド入力は
# web/ のソース一式＋ Bot コードから再生成した data/*.json で、ここに
# （読める場合は）ビルド環境変数ファイルも加える。これがバイト単位で
# 同じなら生成物も同じになるため、現行リリースをそのまま正とし、
# deployed-head だけを進める（呼び出し側の web-autodeploy.sh が行う）。
# ハッシュの保存はビルド成功後にだけ行う。保存ファイルが無い初回は
# 通常どおりビルドして保存する。
INPUT_HASH_FILE="$ROOT/build-input.sha"
INPUT_HASH="$(
  {
    (cd "$BUILD" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum)
    if [ -r /etc/agobot-web.env ]; then sha256sum /etc/agobot-web.env; fi
  } | sha256sum | cut -d' ' -f1
)"
if [ -f "$INPUT_HASH_FILE" ] \
  && [ "$(cat "$INPUT_HASH_FILE")" = "$INPUT_HASH" ] \
  && [ -e "$ROOT/current" ]; then
  echo "Web ビルド入力に変更なし（input hash: $INPUT_HASH）。ビルドをスキップする"
  write_build_status deployed
  exit 0
fi

cd "$BUILD"
run_limited npm ci
run_limited npm run build

# リリースを組み立てる（standalone 本体 + .next/static + public）
mkdir -p "$RELEASE"
cp -a "$BUILD/.next/standalone/." "$RELEASE/"
mkdir -p "$RELEASE/.next/static"
cp -a "$BUILD/.next/static/." "$RELEASE/.next/static/"
cp -a "$BUILD/public" "$RELEASE/public"

# リアルタイム中継ラッパーを設置する（standalone の server.js を内包し、
# /api/worldbox/realtime の WebSocket だけをラッパーが受ける）。
# ラッパーが落ちても systemd が従来どおり再起動し、クライアントは
# REST プレゼンスのポーリングへ戻る。
mv "$RELEASE/server.js" "$RELEASE/next-server.js"
cp -a "$BUILD/realtime-server.js" "$RELEASE/server.js"
cp -a "$BUILD/realtime" "$RELEASE/realtime"
mkdir -p "$RELEASE/node_modules/ws"
cp -a "$BUILD/node_modules/ws/." "$RELEASE/node_modules/ws/"

# current を新しいリリースへ原子的に切り替えて再起動
ln -sfn "$RELEASE" "$ROOT/current"
sudo systemctl restart agobot-web
write_build_status deployed
# ビルド成功時にだけ入力ハッシュを保存する（次回のスキップ判定に使う）
echo "$INPUT_HASH" > "$INPUT_HASH_FILE"

# 古いリリースは新しい順に3つだけ残す（切り替え済みの current は削除対象にしない）
cd "$ROOT/releases"
ls -1dt */ | tail -n +4 | while read -r old; do
  old="${old%/}"
  if [ "$(readlink -f "$ROOT/current")" != "$ROOT/releases/$old" ]; then
    rm -rf -- "$ROOT/releases/$old"
  fi
done
