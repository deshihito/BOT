"use strict";
// AGO WORLD BOX リアルタイム中継の純粋ロジック（ソケット非依存）。
// ラッパー（web/realtime-server.js）が使い、テストもここを対象にする。
// 位置は REST プレゼンスと同じくクライアント申告制: ここでは範囲・速度の
// 整形と鮮度管理だけを行い、経済・戦闘など実害のある検証は各 API 側が担う。
const crypto = require("node:crypto");

/** ハートビートが「在席」とみなせる上限（ミリ秒）。presence.ts の PRESENCE_FRESH_MS と一致。 */
const FRESH_MS = 10_000;
/** 一度に返すプレイヤー数の上限。presence.ts の PRESENCE_MAX_PLAYERS と一致。 */
const MAX_PLAYERS = 32;
/** 速度の絶対値上限（タイル/秒）。presence.ts の MAX_VELOCITY と一致。 */
const MAX_VELOCITY = 16;
/** 表示名の上限文字数。presence.ts の PRESENCE_NAME_MAX と一致。 */
const NAME_MAX = 24;
/** 中継トークンの有効期限（ミリ秒）。 */
const TOKEN_TTL_MS = 10 * 60 * 1000;

/** 空間ごとの境界（lib/worldbox/mapgen.ts の MAP_W/MAP_H、lobby.ts の LOBBY_W/LOBBY_H）。 */
/** ワールドは実質無制限のため、ここには有限空間の矩形だけを置く。 */
const SPACE_BOUNDS = {
  lobby: { width: 126, height: 64 }, // 競馬場拡張で東へ拡大（lobby.ts の LOBBY_W/H）
  lobby2: { width: 40, height: 28 }, // ロビー2Fラウンジ（lobby-floors.ts の LOBBY2_W/H）
  lobby3: { width: 32, height: 24 }, // ロビー3F展望（lobby-floors.ts の LOBBY3_W/H）
  tent: { width: 22, height: 17 }, // テント拡張の最大段階（tier 2）に合わせる
};
/** ワールド座標の上限（presence.ts の PRESENCE_COORD_LIMIT / mapgen.ts の WORLD_COORD_LIMIT と一致）。 */
const WORLD_COORD_LIMIT = 1_000_000;
/** インスタンス空間 ID（presence.ts の PRESENCE_INSTANCE_SPACE_RE と同じ形式）。 */
const INSTANCE_SPACE_RE = /^(cave|ruins|dungeon):(-?\d+),(-?\d+):(\d+)$/;
/** インスタンス空間の辺（app/api/worldbox/presence/route.ts の境界と同じ値）。 */
const INSTANCE_BOUNDS = { cave: 64, ruins: 48, dungeon: 52 };
/** 冒険役職（presence.ts の sanitizeHeartbeat と同じ許可リスト）。 */
const ROLE_IDS = ["blade", "guard", "scout", "miner", "medic", "teleporter"];

/** 空間の座標範囲（min/max 形式）。ワールドは実質無制限。 */
function boundsForSpace(space) {
  if (SPACE_BOUNDS[space]) {
    const b = SPACE_BOUNDS[space];
    return { minX: 0, maxX: b.width, minY: 0, maxY: b.height };
  }
  const m = INSTANCE_SPACE_RE.exec(space || "");
  if (m) {
    const size = INSTANCE_BOUNDS[m[1]];
    return { minX: 0, maxX: size, minY: 0, maxY: size };
  }
  return {
    minX: -WORLD_COORD_LIMIT, maxX: WORLD_COORD_LIMIT,
    minY: -WORLD_COORD_LIMIT, maxY: WORLD_COORD_LIMIT,
  };
}

function sanitizeSpace(raw) {
  if (raw === "lobby" || raw === "lobby2" || raw === "lobby3" || raw === "tent") return raw;
  if (typeof raw === "string" && INSTANCE_SPACE_RE.test(raw)) return raw;
  return "world";
}

function clampNum(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

/** ハートビートを検証・整形する（presence.ts の sanitizeHeartbeat と同じ規則）。 */
function sanitizeHeartbeat(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.x !== "number" || !Number.isFinite(raw.x)) return null;
  if (typeof raw.y !== "number" || !Number.isFinite(raw.y)) return null;
  const space = sanitizeSpace(raw.space);
  const b = boundsForSpace(space);
  const vel = (n) => (typeof n === "number" && Number.isFinite(n) ? clampNum(n, -MAX_VELOCITY, MAX_VELOCITY) : 0);
  return {
    x: clampNum(raw.x, b.minX, b.maxX),
    y: clampNum(raw.y, b.minY, b.maxY),
    vx: vel(raw.vx),
    vy: vel(raw.vy),
    face: raw.face === -1 ? -1 : 1,
    space,
    // B6 の役職・ランク・パーティも REST と同じ規則で通す（ネームプレートと
    // ダンジョンのパーティ分離が WS 経由でも効くようにする）。
    role: typeof raw.role === "string" && ROLE_IDS.includes(raw.role) ? raw.role : "free",
    rank: typeof raw.rank === "number" && Number.isFinite(raw.rank) ? Math.max(1, Math.min(5, Math.floor(raw.rank))) : 1,
    party: typeof raw.party === "string" ? raw.party.slice(0, 48) : "",
    // 座り（sit）も presence.ts と同じ規則で通す（落とすと他者に座り姿勢が伝わらない）。
    ...(raw.sit === true ? { sit: true } : {}),
  };
}

/** 部屋: 空間ごとのプレイヤー表（id → エントリ）。エントリは PresenceEntry と同じ形。 */
function createRoom() {
  return { spaces: new Map() };
}

/** ハートビートを受け付け、保存したエントリを返す。不正なら null。 */
function acceptHeartbeat(room, id, name, raw, now) {
  const hb = sanitizeHeartbeat(raw);
  if (!hb) return null;
  // 空間が変わったら旧空間から消す
  for (const [space, table] of room.spaces) {
    if (space !== hb.space) table.delete(id);
  }
  let table = room.spaces.get(hb.space);
  if (!table) {
    table = new Map();
    room.spaces.set(hb.space, table);
  }
  const entry = { id, name: String(name ?? "").slice(0, NAME_MAX), ...hb, ts: now };
  table.set(id, entry);
  return entry;
}

/** 表示対象の選別: 新鮮な他者だけを新しい順に並べ、上限で切る（selectVisiblePlayers と同じ規則）。 */
function snapshot(room, space, selfId, now) {
  const table = room.spaces.get(sanitizeSpace(space));
  if (!table) return [];
  const out = [];
  for (const e of table.values()) {
    if (e.id === selfId) continue;
    if (e.ts > now + 5_000 || now - e.ts > FRESH_MS) continue;
    out.push(e);
  }
  out.sort((a, b) => b.ts - a.ts);
  return out.slice(0, MAX_PLAYERS);
}

/** プレイヤーを全空間から消し、消えた空間の配列を返す。 */
function removePlayer(room, id) {
  const removedFrom = [];
  for (const [space, table] of room.spaces) {
    if (table.delete(id)) removedFrom.push(space);
  }
  return removedFrom;
}

/** 鮮度切れのエントリを掃除し、消えた { id, space } の配列を返す。 */
function pruneRoom(room, now) {
  const removed = [];
  for (const [space, table] of room.spaces) {
    for (const e of [...table.values()]) {
      if (now - e.ts > FRESH_MS) {
        table.delete(e.id);
        removed.push({ id: e.id, space });
      }
    }
  }
  return removed;
}

// ---- 中継トークン（形式は lib/worldbox/realtime-token.ts と一致させること） ----
// 形式: "v1." + base64url(JSON payload) + "." + base64url(HMAC-SHA256("v1." + payload))
// payload: { pid: プレゼンス ID, name: 表示名, exp: 有効期限ミリ秒 }

function hmac(value, secret) {
  return crypto.createHmac("sha256", secret).update(value).digest("base64url");
}

function signToken(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const head = `v1.${body}`;
  return `${head}.${hmac(head, secret)}`;
}

function verifyToken(token, secret, now) {
  if (typeof token !== "string" || !secret) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return null;
  const head = `${parts[0]}.${parts[1]}`;
  const expected = Buffer.from(hmac(head, secret));
  const given = Buffer.from(parts[2]);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!payload || typeof payload.pid !== "string" || typeof payload.exp !== "number") return null;
  if (now > payload.exp) return null;
  return { pid: payload.pid, name: typeof payload.name === "string" ? payload.name : "" };
}

module.exports = {
  FRESH_MS,
  MAX_PLAYERS,
  SPACE_BOUNDS,
  WORLD_COORD_LIMIT,
  TOKEN_TTL_MS,
  boundsForSpace,
  sanitizeSpace,
  sanitizeHeartbeat,
  createRoom,
  acceptHeartbeat,
  snapshot,
  removePlayer,
  pruneRoom,
  signToken,
  verifyToken,
};
