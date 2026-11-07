#!/usr/bin/env bash
# AGOBOT Web の自動デプロイ判定。
# systemd タイマー（agobot-web-deploy.timer、5分間隔）から呼ばれる。
# Bot 本体のチェックアウト（update.sh が main へ追従させる）が進んでいて、
# まだ Web に反映していないコミットがあれば deploy-web.sh を実行する。
# update.sh 本体には触らない（Bot のデプロイ経路とは疎結合に保つ）。
# 失敗したコミットは failed-head に記録し、次のコミットが来るまで再試行しない。
set -uo pipefail

SRC="$HOME/BOT"
ROOT="/srv/supabase-data/agobot-web"
MARKER="$ROOT/deployed-head"
FAILED="$ROOT/failed-head"
LOG="$ROOT/autodeploy.log"

mkdir -p "$ROOT"

# 前回のビルドがまだ走っていれば何もしない
exec 9>"$ROOT/autodeploy.lock"
flock -n 9 || exit 0

log() { echo "[$(date '+%F %T')] $*" >>"$LOG"; }

HEAD_NOW="$(git -C "$SRC" rev-parse HEAD 2>/dev/null)" || exit 0
[ -n "$HEAD_NOW" ] || exit 0
DEPLOYED="$(cat "$MARKER" 2>/dev/null || true)"

# 反映済みなら何もしない
[ "$HEAD_NOW" = "$DEPLOYED" ] && exit 0
# このコミットで一度失敗していたら、次のコミットまで再試行しない
[ "$HEAD_NOW" = "$(cat "$FAILED" 2>/dev/null || true)" ] && exit 0

# Bot 側デプロイ（reset --hard）の最中かもしれないので、HEAD が安定していることを確認する
sleep 10
HEAD_AGAIN="$(git -C "$SRC" rev-parse HEAD 2>/dev/null)" || exit 0
if [ "$HEAD_AGAIN" != "$HEAD_NOW" ]; then
  log "HEAD が変動中（$HEAD_NOW → $HEAD_AGAIN）。次回に回す"
  exit 0
fi

log "Web再デプロイ開始: ${DEPLOYED:-none} → $HEAD_NOW"
if bash "$SRC/deploy/deploy-web.sh" >>"$LOG" 2>&1; then
  echo "$HEAD_NOW" >"$MARKER"
  rm -f "$FAILED"
  log "Web再デプロイ完了: $HEAD_NOW"
else
  echo "$HEAD_NOW" >"$FAILED"
  log "Web再デプロイ失敗: $HEAD_NOW（このコミットでは再試行しない）"
  exit 1
fi
