// AGO WORLD BOX リアルタイム中継（WebSocket）用の短期トークン発行（サーバー専用）。
// 中継ラッパー（realtime-server.js）は Next の外側で動くため、セッション Cookie を
// 直接読まず、この署名付きトークンで接続者を識別する。
// 形式は realtime/relay-core.js の verifyToken と一致させること:
//   "v1." + base64url(JSON payload) + "." + base64url(HMAC-SHA256("v1." + payload部))
// payload: { pid: プレゼンス ID, name: 表示名, ok: 所有者キー, av: アイコン URL（任意）, exp: 有効期限ミリ秒 }
// ok（所有者キー）は Phase 2 のプレゼンス集約書き込みで relay が bot_kv の
// キーとして使う本人の識別子。署名付きトークンの中だけにあり、中継の
// broadcast（pid のみ）には決して載せない。
// 署名鍵はセッションと同じ環境変数（DISCORD_SESSION_SECRET || DISCORD_CLIENT_SECRET）。
import crypto from "node:crypto";
import { sessionAvatarUrl, sessionOwnerKey, type SessionInfo } from "../auth";
import { PRESENCE_NAME_MAX, presenceIdFor } from "./presence";

/** 中継トークンの有効期限（ミリ秒）。realtime/relay-core.js の TOKEN_TTL_MS と一致させること。 */
export const REALTIME_TOKEN_TTL_MS = 10 * 60 * 1000;

function realtimeSecret(): string {
  return process.env.DISCORD_SESSION_SECRET || process.env.DISCORD_CLIENT_SECRET || "";
}

/** 中継トークンを発行する。鍵が未設定なら null。 */
export function issueRealtimeToken(session: SessionInfo, now: number): string | null {
  const secret = realtimeSecret();
  if (!secret) return null;
  const avatarUrl = sessionAvatarUrl(session);
  const payload = {
    pid: presenceIdFor(sessionOwnerKey(session)),
    name: (session.username ?? "").slice(0, PRESENCE_NAME_MAX),
    ok: sessionOwnerKey(session),
    // 本人のユーザーアイコン（アバター描画用）。中継がエントリへ付与して配信する。
    ...(avatarUrl ? { av: avatarUrl } : {}),
    exp: now + REALTIME_TOKEN_TTL_MS,
  };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const head = `v1.${body}`;
  const sig = crypto.createHmac("sha256", secret).update(head).digest("base64url");
  return `${head}.${sig}`;
}
