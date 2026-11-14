// Discord Activity 連携の純粋ロジック（環境・fetch・SDK に触れない）。
// クライアント（GamesShell / OnlineShell / BALKU）とサーバー
// （games-auth ルート）、middleware の3か所から共通で使う。
// 招待リンクの正は公開オリジン（lib/site.ts の SITE_URL）で、
// Discord プロキシ配下でも共有先が壊れない URL を作る。
import { SITE_URL } from "./site";

/** オンライン対戦で使う Discord 本人の表示情報。 */
export type DiscordIdentity = {
  id: string;
  /** 表示名（global_name 優先、2〜24文字に丸める）。 */
  name: string;
  avatarUrl: string;
};

const SNOWFLAKE = /^\d{1,30}$/;
const ROOM_CODE_PATTERN = /^[A-Z2-9]{6}$/;
const GAME_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,40}$/;

/** Discord のアバター CDN URL。ハッシュが無ければデフォルトアバター。 */
export function discordAvatarUrl(userId: string, avatarHash?: string | null): string {
  if (avatarHash) {
    return `https://cdn.discordapp.com/avatars/${userId}/${avatarHash}.png?size=64`;
  }
  // デフォルトアバターの番号は (user_id >> 22) % 6（新ユーザー名制の仕様）。
  let index = 0;
  try {
    index = Number((BigInt(userId) >> 22n) % 6n);
  } catch {
    index = 0;
  }
  return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}

export type DiscordUserLike = {
  id?: unknown;
  username?: unknown;
  global_name?: unknown;
  avatar?: unknown;
};

/**
 * SDK の authenticate 応答 / Discord API の /users/@me から
 * オンライン対戦の既定プロフィールを作る。不正な形は null。
 * 名前はオンライン基盤の入力規則（2〜24文字）に合わせて丸める。
 */
export function buildDiscordIdentity(user: DiscordUserLike | null | undefined): DiscordIdentity | null {
  if (!user || typeof user.id !== "string" || !SNOWFLAKE.test(user.id)) return null;
  const username = typeof user.username === "string" ? user.username.trim() : "";
  const globalName = typeof user.global_name === "string" ? user.global_name.trim() : "";
  let name = globalName.length >= 2 ? globalName : username;
  if (name.length > 24) name = name.slice(0, 24);
  if (name.length < 2) return null;
  const avatarHash = typeof user.avatar === "string" && user.avatar ? user.avatar : null;
  return { id: user.id, name, avatarUrl: discordAvatarUrl(user.id, avatarHash) };
}

/** ルームコードを正規形（大文字6文字）にする。不正は null。 */
export function normalizeRoomCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const code = raw.trim().toUpperCase();
  return ROOM_CODE_PATTERN.test(code) ? code : null;
}

/** ゲーム ID として妥当なスラッグか。 */
export function isGameSlug(raw: unknown): raw is string {
  return typeof raw === "string" && GAME_ID_PATTERN.test(raw);
}

/**
 * 招待リンク（公開 URL）。開くとそのまま参加フローに入る。
 * Discord プロキシ配下のオリジンではなく SITE_URL を使うので、
 * チャットに貼ってもブラウザでも Discord 内でも同じ形になる。
 */
export function inviteUrlForGame(gameId: string, code: string): string | null {
  const normalized = normalizeRoomCode(code);
  if (!normalized || !isGameSlug(gameId)) return null;
  return `${SITE_URL}/games/${gameId}?room=${normalized}`;
}

/** URL クエリ（?room=）から招待コードを取り出す。無ければ null。 */
export function roomCodeFromSearch(search: string): string | null {
  try {
    return normalizeRoomCode(new URLSearchParams(search).get("room"));
  } catch {
    return null;
  }
}

/**
 * SDK の shareLink に渡す custom_id。共有リンクを開いた側の
 * Activity 起動パラメータに同名で届く前提で、ルーム宛先を運ぶ。
 */
export function shareCustomIdForRoom(gameId: string, code: string): string | null {
  const normalized = normalizeRoomCode(code);
  if (!normalized || !isGameSlug(gameId)) return null;
  return `room:${gameId}:${normalized}`;
}

/** shareLink の custom_id をルーム宛先に戻す。不正は null。 */
export function roomFromShareCustomId(raw: string | null | undefined): { gameId: string; code: string } | null {
  if (typeof raw !== "string") return null;
  const parts = raw.split(":");
  if (parts.length !== 3 || parts[0] !== "room") return null;
  const code = normalizeRoomCode(parts[2]);
  if (!code || !isGameSlug(parts[1])) return null;
  return { gameId: parts[1], code };
}

/**
 * Activity 起動（ルート＋ frame_id / instance_id）の着地先。
 * 既定はゲーム（/games）。activity=music が明示された起動だけ
 * 従来どおり音楽ページへ送り、音楽側の導線は壊さない。
 * Activity 起動でなければ null（通常表示）。
 */
export function activityLandingPath(args: {
  frameId: string | null | undefined;
  instanceId: string | null | undefined;
  activity: string | null | undefined;
}): string | null {
  if (!args.frameId || !args.instanceId) return null;
  return args.activity === "music" ? "/activity/music" : "/games";
}
