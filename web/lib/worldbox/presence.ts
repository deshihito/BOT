// AGO WORLD BOX の同時接続プレゼンス（純粋ロジック）。
// ハートビートの検証・整形、鮮度判定、デッドレコニング（速度による先読み）を
// ここに集約し、API ルートとクライアント描画はこの結果だけを使う。
// 座標境界は mapgen.ts の worldBounds と同じ値（このファイルは単体で
// トランスパイルされるため import せず複製して明示する。値の正は mapgen）。
export type CoordBounds = { minX: number; maxX: number; minY: number; maxY: number };

const PRESENCE_COORD_LIMIT = 1_000_000;

function fallbackBounds(): CoordBounds {
  return {
    minX: -PRESENCE_COORD_LIMIT,
    maxX: PRESENCE_COORD_LIMIT,
    minY: -PRESENCE_COORD_LIMIT,
    maxY: PRESENCE_COORD_LIMIT,
  };
}

/** ハートビートが「在席」とみなせる上限（ミリ秒）。送信間隔 約1秒 +  poll 約2秒 の余裕。 */
export const PRESENCE_FRESH_MS = 10_000;
/** 一度に返すプレイヤー数の上限。 */
export const PRESENCE_MAX_PLAYERS = 32;
/** デッドレコニングで外挿してよい上限（秒）。これ以上は止めて待つ。 */
export const EXTRAPOLATE_CAP_SEC = 1.5;
/** 描画位置が予測位置からこの距離（タイル）以上ずれたら即座に合わせる。 */
export const SNAP_DISTANCE = 6;
/** 速度の絶対値上限（タイル/秒）。歩行速度 4.4 の十分な余裕分だけ許可する。 */
const MAX_VELOCITY = 16;
/** 表示名の上限文字数。 */
export const PRESENCE_NAME_MAX = 24;

/** プレイヤーがいる空間。ワールドとロビーでプレゼンスは混ざらない。 */
export type PresenceSpace = "world" | "lobby";

/** 空間の指定として解釈する。不正な値はワールドに寄せる。 */
export function sanitizePresenceSpace(raw: unknown): PresenceSpace {
  return raw === "lobby" ? "lobby" : "world";
}

export type Heartbeat = {
  name: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** 向き: 左 -1 / 右 1（アバターの反転用）。 */
  face: 1 | -1;
  /** いる空間（ワールド / ロビー）。 */
  space: PresenceSpace;
};

export type PresenceEntry = Heartbeat & {
  /** 所有者キーから作る不透明な短い ID（生のユーザー ID は表に出さない）。 */
  id: string;
  /** サーバー受信時刻（ミリ秒）。 */
  ts: number;
};

/** 所有者キー → 不透明な短い ID（FNV-1a ハッシュ）。 */
export function presenceIdFor(ownerKey: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < ownerKey.length; i++) {
    h ^= ownerKey.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function clampNum(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function sanitizeName(raw: unknown): string {
  if (typeof raw !== "string") return "";
  // 制御文字と改行を落としてから整える（名前ラベルの描画を壊さない）
  return raw.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, PRESENCE_NAME_MAX);
}

/**
 * ハートビート body を検証・整形する。位置が数値でなければ null。
 * 範囲外の値は空間の範囲へ丸める（却下ではなく補正）。
 */
export function sanitizeHeartbeat(raw: unknown, bounds: CoordBounds): Heartbeat | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Record<string, unknown>;
  if (typeof v.x !== "number" || !Number.isFinite(v.x)) return null;
  if (typeof v.y !== "number" || !Number.isFinite(v.y)) return null;
  const vel = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? clampNum(n, -MAX_VELOCITY, MAX_VELOCITY) : 0);
  return {
    name: sanitizeName(v.name),
    x: clampNum(v.x, bounds.minX, bounds.maxX),
    y: clampNum(v.y, bounds.minY, bounds.maxY),
    vx: vel(v.vx),
    vy: vel(v.vy),
    face: v.face === -1 ? -1 : 1,
    space: sanitizePresenceSpace(v.space),
  };
}

/** bot_kv に保存された1件（JSON 文字列 or オブジェクト）をエントリへ戻す。壊れていれば null。 */
export function parsePresenceEntry(id: string, raw: unknown): PresenceEntry | null {
  let data: unknown = raw;
  if (typeof raw === "string") {
    try {
      data = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!data || typeof data !== "object") return null;
  const v = data as Record<string, unknown>;
  if (typeof v.ts !== "number" || !Number.isFinite(v.ts)) return null;
  const hb = sanitizeHeartbeat(v, fallbackBounds());
  if (!hb) return null;
  return { ...hb, id, ts: v.ts };
}

/** 鮮度判定（未来時刻の多少のずれは許容する）。 */
export function isFreshPresence(entry: PresenceEntry, now: number): boolean {
  return entry.ts <= now + 5_000 && now - entry.ts <= PRESENCE_FRESH_MS;
}

/** 表示対象の選別: 新鮮な他者だけを新しい順に並べ、上限で切る。space を渡すと同じ空間の者だけに絞る。 */
export function selectVisiblePlayers(
  entries: PresenceEntry[],
  selfId: string | null,
  now: number,
  limit: number = PRESENCE_MAX_PLAYERS,
  space?: PresenceSpace,
): PresenceEntry[] {
  return entries
    .filter((e) => e.id !== selfId && isFreshPresence(e, now) && (space === undefined || e.space === space))
    .sort((a, b) => b.ts - a.ts)
    .slice(0, limit);
}

/**
 * デッドレコニング: 最終ハートビート位置を速度で外挿する。
 * 外挿は EXTRAPOLATE_CAP_SEC で頭打ちにし、空間の範囲内に丸める。
 */
export function predictPosition(entry: PresenceEntry, now: number, bounds: CoordBounds): { x: number; y: number } {
  const dt = clampNum((now - entry.ts) / 1000, 0, EXTRAPOLATE_CAP_SEC);
  return {
    x: clampNum(entry.x + entry.vx * dt, bounds.minX, bounds.maxX),
    y: clampNum(entry.y + entry.vy * dt, bounds.minY, bounds.maxY),
  };
}
