// ビルド状態ファイルの読み込み（サーバー専用）。
// デプロイスクリプトが /srv/supabase-data/agobot-web/build-status.json に書いた
// 状態を、実行中の（旧リリースの）Web がリクエストごとに読み直す。
// ファイルが無い環境（ローカル開発など）では null を返す。
import fs from "node:fs";
import {
  BUILD_STATUS_DEFAULT_PATH,
  parseBuildStatus,
  type BuildStatus,
} from "@/lib/build-status";

export function buildStatusPath(): string {
  return process.env.AGOBOT_BUILD_STATUS_PATH || BUILD_STATUS_DEFAULT_PATH;
}

export function loadBuildStatus(): BuildStatus | null {
  try {
    const raw = JSON.parse(fs.readFileSync(buildStatusPath(), "utf8"));
    return parseBuildStatus(raw);
  } catch {
    return null;
  }
}
