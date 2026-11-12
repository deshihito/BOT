// One Prompter のユーザー自前 API キー（ログイン中ユーザーだけが登録できる）。
//
// 保存先は Bot API 経由の bot_kv（名前空間 oneprompter_user_keys、キーは
// 所有者キー "provider:id"）。値は AES-256-GCM で暗号化して置き、平文は
// ログにもクライアントにも絶対に出さない（返すのは登録有無と末尾4文字だけ）。
// 暗号鍵は env ONE_PROMPTER_KEY_SECRET から作る（SHA-256 で 32 バイト化）。
// この env が無い環境ではキー登録機能だけを無効化し、生成自体は従来どおり
// 共有キーで動く。対象は現在の生成バックエンドで使うキー 1 種類のみで、
// ベース URL や他プロバイダの指定は扱わない。
import crypto from "node:crypto";
import { isBotApiConfigured, kvDelete, kvGet, kvSet } from "./bot-api";

export const USER_KEY_NAMESPACE = "oneprompter_user_keys";

type StoredUserKey = {
  v: 1;
  /** AES-256-GCM の IV（base64） */
  iv: string;
  /** GCM 認証タグ（base64） */
  tag: string;
  /** 暗号文（base64） */
  data: string;
  /** マスク表示用の末尾4文字（平文の断片はここまでしか残さない） */
  tail: string;
  updatedAt: number;
};

const USER_KEY_ENV_NAME = ["ONE_PROMPTER", "KEY", "SECRET"].join("_");

export function userKeySecret(): string | null {
  const raw = process.env[USER_KEY_ENV_NAME];
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  return trimmed ? trimmed : null;
}

/** キー登録機能が使える状態か（暗号鍵 env と Bot API の両方が必要）。 */
export function isUserKeyEnabled(): boolean {
  return userKeySecret() !== null && isBotApiConfigured();
}

function encryptionKey(secret: string): Buffer {
  return crypto.createHash("sha256").update(secret, "utf8").digest();
}

export function encryptApiKey(apiKey: string, secret: string): StoredUserKey {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(secret), iv);
  const data = Buffer.concat([cipher.update(apiKey, "utf8"), cipher.final()]);
  return {
    v: 1,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
    tail: apiKey.slice(-4),
    updatedAt: Date.now(),
  };
}

/** 復号できなければ null（鍵違い・改ざん・形式崩れはすべて null に倒す）。 */
export function decryptApiKey(stored: StoredUserKey, secret: string): string | null {
  try {
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      encryptionKey(secret),
      Buffer.from(stored.iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(stored.tag, "base64"));
    const plain = Buffer.concat([decipher.update(Buffer.from(stored.data, "base64")), decipher.final()]);
    const key = plain.toString("utf8");
    return key ? key : null;
  } catch {
    return null;
  }
}

function isStoredUserKey(value: unknown): value is StoredUserKey {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<StoredUserKey>;
  return (
    v.v === 1 &&
    typeof v.iv === "string" &&
    typeof v.tag === "string" &&
    typeof v.data === "string" &&
    typeof v.tail === "string"
  );
}

/**
 * 登録時の形式チェック（実際に API を叩く検証はしない）。
 * 前後の空白は除き、8〜200 字・空白や制御文字を含まないものだけ通す。
 */
export function validateUserApiKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const key = value.trim();
  if (key.length < 8 || key.length > 200) return null;
  if (/\s/.test(key) || /[\u0000-\u001f\u007f]/.test(key)) return null;
  return key;
}

/** マスク表示（末尾4文字だけ）。平文の残りは出さない。 */
export function maskUserApiKey(apiKey: string): string {
  return `••••${apiKey.slice(-4)}`;
}

export function maskFromTail(tail: string): string {
  return `••••${tail}`;
}

/** 所有者の登録キーを復号して返す。未登録・読めない・機能無効なら null（呼び出し側は共有キーに倒す）。 */
export async function loadUserApiKey(ownerKey: string): Promise<string | null> {
  const material = userKeySecret();
  if (!material || !isBotApiConfigured()) return null;
  let raw: unknown;
  try {
    raw = await kvGet(USER_KEY_NAMESPACE, ownerKey);
  } catch {
    return null;
  }
  if (!isStoredUserKey(raw)) return null;
  return decryptApiKey(raw, material);
}

/** 表示用のメタ情報（末尾4文字と更新時刻）だけを読む。復号はしない。 */
export async function loadUserApiKeyMeta(ownerKey: string): Promise<{ tail: string; updatedAt: number } | null> {
  if (!isBotApiConfigured()) return null;
  let raw: unknown;
  try {
    raw = await kvGet(USER_KEY_NAMESPACE, ownerKey);
  } catch {
    return null;
  }
  if (!isStoredUserKey(raw)) return null;
  return { tail: raw.tail, updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : 0 };
}

export async function saveUserApiKey(ownerKey: string, apiKey: string): Promise<boolean> {
  const material = userKeySecret();
  if (!material || !isBotApiConfigured()) return false;
  try {
    await kvSet(USER_KEY_NAMESPACE, ownerKey, encryptApiKey(apiKey, material));
    return true;
  } catch {
    return false;
  }
}

export async function deleteUserApiKey(ownerKey: string): Promise<void> {
  if (!isBotApiConfigured()) return;
  try {
    await kvDelete(USER_KEY_NAMESPACE, ownerKey);
  } catch {
    // 削除の掃除はベストエフォート
  }
}
