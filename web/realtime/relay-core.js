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
    // 座り（sit）も presence.ts と同じ規則で通す（落とすと他者に座り姿勢が伝わらず、bot_kv 集約書き込みでも欠落する）。
    ...(raw.sit === true ? { sit: true } : {}),
  };
}

/** 移動連続性（presence.ts と同じ値。B4）: 正規の最大移動速度（タイル/秒）。 */
const MAX_MOVE_SPEED = 10;
/** 移動連続性: 許容距離に足す余裕（タイル）。 */
const MOVEMENT_MARGIN_TILES = 3;
/** 移動連続性: 保管位置がこの時間より古ければ新規入室として受け入れる。 */
const MOVEMENT_RESET_MS = 30_000;
/** 移動連続性: プレゼンスが無いときのセーブ基準の許容距離（タイル）。 */
const SAVE_FALLBACK_MAX_TILES = 12;
/** 登録済みワープ対: 着地点の許容誤差（タイル。presence.ts の WARP_LANDING_TOLERANCE_TILES と一致）。 */
const WARP_LANDING_TOLERANCE_TILES = 2.5;
/** 登録済みワープ対: セーブ基準でのワープ元タイルへの到達範囲（タイル。presence.ts の WARP_FALLBACK_SOURCE_REACH_TILES と一致）。 */
const WARP_FALLBACK_SOURCE_REACH_TILES = 5;
/**
 * 同一空間内のクライアント駆動ワープ（登録済みワープ対。presence.ts の
 * SAME_SPACE_WARPS と一致。値の正は lobby.ts の LOBBY_STAIRS_UP /
 * LOBBY_STAIRS_DOWN / LOBBY_UP_LANDING / LOBBY_DOWN_LANDING）。
 * 現在はロビーの擬似2F階段の往復のみ。
 */
const SAME_SPACE_WARPS = [
  {
    space: "lobby",
    sources: [{ x: 17, y: 29 }, { x: 18, y: 29 }],
    landing: { x: 17.5, y: 60.5 },
  },
  {
    space: "lobby",
    sources: [{ x: 17, y: 62 }, { x: 18, y: 62 }],
    landing: { x: 17.5, y: 27.5 },
  },
];

/**
 * 登録済みワープ対による正当な不連続か（presence.ts の isRegisteredWarpJump
 * と同じ規則）: 保管位置から到達可能な範囲（reachTiles 以内）にワープ元
 * タイルがあり、申告位置がそのワープの着地点の近傍にある場合だけ true。
 */
function isRegisteredWarpJump(baseline, next, reachTiles) {
  if (baseline.space !== next.space) return false;
  for (const warp of SAME_SPACE_WARPS) {
    if (warp.space !== next.space) continue;
    if (Math.hypot(next.x - warp.landing.x, next.y - warp.landing.y) > WARP_LANDING_TOLERANCE_TILES) continue;
    for (const src of warp.sources) {
      if (Math.hypot(baseline.x - (src.x + 0.5), baseline.y - (src.y + 0.5)) <= reachTiles) return true;
    }
  }
  return false;
}

/**
 * 移動連続性の判定（時刻基準。presence.ts の checkMovementContinuity と同じ規則）。
 * baseline は { x, y, space, ts }、next は { x, y, space }。
 */
function checkMovementContinuity(baseline, next, now) {
  if (!baseline) return { ok: true };
  if (baseline.space !== next.space) return { ok: true };
  if (now - baseline.ts >= MOVEMENT_RESET_MS) return { ok: true };
  const elapsedSec = Math.max(0, (now - baseline.ts) / 1000);
  const allowed = MAX_MOVE_SPEED * elapsedSec + MOVEMENT_MARGIN_TILES;
  const dist = Math.hypot(next.x - baseline.x, next.y - baseline.y);
  if (dist <= allowed) return { ok: true };
  if (isRegisteredWarpJump(baseline, next, allowed)) return { ok: true };
  return { ok: false, reason: "position_jump" };
}

/**
 * 移動連続性の判定（セーブ基準・固定距離。presence.ts の checkSaveFallbackContinuity と同じ規則）。
 * baseline は { x, y, space }（ts 無し）。
 */
function checkSaveFallbackContinuity(saved, next) {
  if (!saved) return { ok: true };
  if (saved.space !== next.space) return { ok: true };
  const dist = Math.hypot(next.x - saved.x, next.y - saved.y);
  if (dist <= SAVE_FALLBACK_MAX_TILES) return { ok: true };
  if (isRegisteredWarpJump(saved, next, WARP_FALLBACK_SOURCE_REACH_TILES)) return { ok: true };
  return { ok: false, reason: "position_jump" };
}

/** 部屋: 空間ごとのプレイヤー表（id → エントリ）と、pid ごとの現行タブ世代。エントリは PresenceEntry と同じ形。 */
/** ピアノ音の共有メッセージ検証: 半音オフセット（C5=0）の配列だけを通す。 */
function sanitizePianoNotes(raw) {
  if (!Array.isArray(raw)) return null;
  const notes = [];
  for (const n of raw) {
    if (typeof n !== "number" || !Number.isInteger(n) || n < -24 || n > 24) return null;
    notes.push(n);
    if (notes.length > 8) return null;
  }
  return notes.length > 0 ? notes : null;
}

function createRoom() {
  return { spaces: new Map(), gens: new Map() };
}

/**
 * タブ世代の接続可否（presence.ts の tabVerdict と同じ規則）。
 * タブ申告が無い接続は常時 accept（evict なし）。
 * 戻り値: { verdict: "accept" | "reject", evict: boolean }
 * evict=true は「同じ pid の旧世代の接続を閉じるべき」という指示。
 */
function admitTab(room, pid, tab, tabAt) {
  if (typeof tab !== "string" || tab.length === 0 || typeof tabAt !== "number" || !Number.isFinite(tabAt)) {
    return { verdict: "accept", evict: false };
  }
  const cur = room.gens.get(pid);
  if (!cur) {
    room.gens.set(pid, { tab, tabAt });
    return { verdict: "accept", evict: false };
  }
  if (cur.tab === tab) return { verdict: "accept", evict: false };
  const newer = tabAt !== cur.tabAt ? tabAt > cur.tabAt : tab > cur.tab;
  if (!newer) return { verdict: "reject", evict: false };
  room.gens.set(pid, { tab, tabAt });
  return { verdict: "accept", evict: true };
}

/** 部屋の中からそのプレイヤーの直近エントリ（空間を問わず）を探す。無ければ null。 */
function findRoomEntry(room, id) {
  for (const table of room.spaces.values()) {
    const entry = table.get(id);
    if (entry) return entry;
  }
  return null;
}

/** ハートビートを受け付け、保存したエントリを返す。不正なら null。
 * 移動連続性を満たさない申告は { rejected: true, x, y, space }（保管位置つき）
 * を返し、部屋へは保存しない。externalBaseline は部屋に前回が無いときの
 * 基準（bot_kv のプレゼンス、無ければセーブ。ts 付きなら時刻基準、無ければ固定距離）。
 */
function acceptHeartbeat(room, id, name, raw, now, externalBaseline = null) {
  const hb = sanitizeHeartbeat(raw);
  if (!hb) return null;
  const prev = findRoomEntry(room, id);
  const baseline = prev ?? externalBaseline;
  const check = baseline && typeof baseline.ts === "number"
    ? checkMovementContinuity(baseline, hb, now)
    : checkSaveFallbackContinuity(baseline, hb);
  if (!check.ok) {
    return { rejected: true, x: baseline.x, y: baseline.y, space: baseline.space };
  }
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

/** プレイヤーを全空間から消し、消えた空間の配列を返す。タブ世代の記録も消す。 */
function removePlayer(room, id) {
  const removedFrom = [];
  for (const [space, table] of room.spaces) {
    if (table.delete(id)) removedFrom.push(space);
  }
  room.gens.delete(id);
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
  return {
    pid: payload.pid,
    name: typeof payload.name === "string" ? payload.name : "",
    // 所有者キー（Phase 2 の集約書き込み用）。旧トークンには無いため任意。
    ok: typeof payload.ok === "string" && payload.ok.length > 0 ? payload.ok : null,
  };
}

/**
 * bot_kv プレゼンスへ書く値（presence-online.ts の putPresence と完全互換）。
 * putPresence は kvSet(namespace, ownerKey, JSON.stringify({ ...heartbeat, ts }))
 * で、heartbeat は presence.ts の sanitizeHeartbeat の形（name を含む）。
 */
function presenceKvValue(entry) {
  const hb = {
    name: entry.name,
    x: entry.x,
    y: entry.y,
    vx: entry.vx,
    vy: entry.vy,
    face: entry.face,
    space: entry.space,
    role: entry.role ?? "free",
    rank: entry.rank ?? 1,
    party: entry.party ?? "",
    ...(entry.sit === true ? { sit: true } : {}),
  };
  return JSON.stringify({ ...hb, ts: entry.ts });
}

// ---- プレゼンス集約書き込みのスロットル（Phase 2） ----
// relay が WS で受けた位置を bot_kv へ書く頻度の純粋判定。検証側が読む
// 鮮度の目安: 移動中は最大1秒、静止時は2秒（従来の REST 併送と同じ）。
// 空間遷移・大きなジャンプ・初回は即時。
const AGG_MOVING_WRITE_MS = 1_000;
const AGG_IDLE_WRITE_MS = 2_000;
const AGG_JUMP_DISTANCE = 4;

function createAggregator() {
  return { players: new Map() };
}

/**
 * このエントリを今 bot_kv へ書くべきか。書く場合は内部状態も更新する
 * （書き込みの予約）。force は切断時の最終書き込み用。
 */
function planPresenceWrite(agg, pid, entry, now, force = false) {
  const st = agg.players.get(pid);
  if (force) {
    agg.players.set(pid, { at: now, x: entry.x, y: entry.y, space: entry.space });
    return true;
  }
  if (!st) {
    agg.players.set(pid, { at: now, x: entry.x, y: entry.y, space: entry.space });
    return true;
  }
  const dist = Math.hypot(entry.x - st.x, entry.y - st.y);
  const immediate = entry.space !== st.space || dist > AGG_JUMP_DISTANCE;
  const moving = dist > 0.05 || entry.vx !== 0 || entry.vy !== 0;
  const interval = moving ? AGG_MOVING_WRITE_MS : AGG_IDLE_WRITE_MS;
  if (immediate || now - st.at >= interval) {
    agg.players.set(pid, { at: now, x: entry.x, y: entry.y, space: entry.space });
    return true;
  }
  return false;
}

/** プレイヤーの集約状態を消す（切断時）。 */
function forgetPresenceWrite(agg, pid) {
  agg.players.delete(pid);
}

module.exports = {
  FRESH_MS,
  MAX_PLAYERS,
  SPACE_BOUNDS,
  WORLD_COORD_LIMIT,
  TOKEN_TTL_MS,
  MAX_MOVE_SPEED,
  MOVEMENT_MARGIN_TILES,
  MOVEMENT_RESET_MS,
  SAVE_FALLBACK_MAX_TILES,
  WARP_LANDING_TOLERANCE_TILES,
  WARP_FALLBACK_SOURCE_REACH_TILES,
  SAME_SPACE_WARPS,
  isRegisteredWarpJump,
  checkMovementContinuity,
  checkSaveFallbackContinuity,
  boundsForSpace,
  sanitizeSpace,
  sanitizeHeartbeat,
  createRoom,
  admitTab,
  acceptHeartbeat,
  snapshot,
  removePlayer,
  pruneRoom,
  signToken,
  verifyToken,
  presenceKvValue,
  AGG_MOVING_WRITE_MS,
  AGG_IDLE_WRITE_MS,
  createAggregator,
  planPresenceWrite,
  forgetPresenceWrite,
  sanitizePianoNotes,
};
