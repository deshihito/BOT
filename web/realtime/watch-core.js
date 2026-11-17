"use strict";
// AGO WORLD BOX リアルタイム中継の watch 純粋ロジック（ソケット・IO 非依存）。
// relay が bot_kv の名前空間をサーバー側で一括ポーリングし、差分だけを
// 購読者へ配る（Phase 1）。従来はクライアント全員が各自に REST で
// 全件取得していた（chat 3s / party 4s / board 10s / tiles・mobs・
// nations 15s）。watch は名前空間ごとに1回だけ読み、N→1 に集約する。
//
// 配信の形は対象ごとに違う:
// - tiles / mobs / board: 値そのものを差分配信し、クライアントが既存の
//   parse 関数で適用する（REST 応答と同じデータが正）。
// - chat / party / nations: 応答が本人向けに加工される（近距離フィルタ・
//   partyView・Discord ギルド情報）ため、relay は「変わった」ことだけを
//   対象クライアントへ通知（poke）し、クライアントは従来の REST 取得を
//   1回だけ走らせて再同期する。ポーリングの定常負荷は消え、変更時の
//   1回だけになる。

/** watch 対象と間隔。速い系（遊びの同期に効く）は 2 秒、遅い系は 5 秒。 */
const WATCH_PLAN = [
  { namespace: "worldbox_chat", kind: "chat", intervalMs: 2_000 },
  { namespace: "worldbox_union_board", kind: "unionChat", intervalMs: 2_000 },
  { namespace: "worldbox_party", kind: "party", intervalMs: 2_000 },
  // ギルド依頼は単一ドキュメントで応答が本人向け加工（所属ギルドで
  // 絞る）を含むため、nations と同じ全体 poke 方式にする
  { namespace: "worldbox_requests", kind: "requests", intervalMs: 2_000 },
  { namespace: "worldbox_tiles", kind: "tiles", intervalMs: 2_000 },
  { namespace: "worldbox_mobs", kind: "mobs", intervalMs: 2_000 },
  { namespace: "worldbox_board", kind: "board", intervalMs: 5_000 },
  { namespace: "worldbox_nations", kind: "nations", intervalMs: 5_000 },
  // インスタンス状態（洞窟の枯渇・遺跡の個人状態・ダンジョンのセッション
  // 進行）は遊びの同期に効くため速い系。応答が本人向け加工を含むので
  // party と同じ poke 方式で、宛先はキーから解決する（instanceKeyScope）
  { namespace: "worldbox_instances", kind: "instances", intervalMs: 2_000 },
  // 経済オプの確定は体感遅延に直結するため速い系（2秒）で watch する
  { namespace: "worldbox_economy", kind: "economy", intervalMs: 2_000 },
  // 地表オブジェクトの枯渇と釣りの釣果は、値そのもの（座標→時刻）が
  // 表示状態そのものなので tiles / mobs と同じ差分配信にする
  { namespace: "worldbox_objects", kind: "objects", intervalMs: 2_000 },
  { namespace: "worldbox_fishing", kind: "fishing", intervalMs: 2_000 },
  // ギルドショップは単一ドキュメントで応答に本人向け加工（役職・mine）
  // を含むため、nations と同じ全体 poke 方式にする（地図の区画名表示と
  // パネルの追随が用途）
  { namespace: "worldbox_guild_shop", kind: "guildShop", intervalMs: 5_000 },
];

/** 差分比較用の正規化（文字列はそのまま、オブジェクトは JSON 化）。 */
function normalizeValue(value) {
  if (typeof value === "string") return `s:${value}`;
  return `j:${JSON.stringify(value) ?? "null"}`;
}

/**
 * kv スナップショット同士の差分。返り値は [{ key, value }] で、
 * value === null は削除。prev が null（初回）はベースラインとして空を返す。
 */
function diffKv(prev, next) {
  if (!prev) return [];
  const changes = [];
  for (const [key, value] of next) {
    if (!prev.has(key) || normalizeValue(prev.get(key)) !== normalizeValue(value)) {
      changes.push({ key, value });
    }
  }
  for (const key of prev.keys()) {
    if (!next.has(key)) changes.push({ key, value: null });
  }
  return changes;
}

/** 所有者キー → プレゼンス ID（lib/worldbox/presence.ts の presenceIdFor と同じ FNV-1a）。 */
function presenceIdFor(ownerKey) {
  let h = 0x811c9dc5;
  for (let i = 0; i < ownerKey.length; i++) {
    h ^= ownerKey.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function parseJsonLoose(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * パーティ名前空間の1変更について、通知すべき相手のプレゼンス ID 集合。
 * - 索引キー（member:<ownerKey> / invite:<ownerKey>）はその本人のみ。
 * - パーティ本体はリーダー・メンバー・招待先全員（値は変更前後どちらでも
 *   拾うため、呼び出し側は prev/next 両方の値で呼ぶ）。
 */
function partyTargetPids(key, value) {
  const pids = new Set();
  if (key.startsWith("member:") || key.startsWith("invite:")) {
    pids.add(presenceIdFor(key.slice(key.indexOf(":") + 1)));
    return pids;
  }
  const party = parseJsonLoose(value);
  if (!party || typeof party !== "object") return pids;
  const keys = new Set();
  if (typeof party.leaderKey === "string") keys.add(party.leaderKey);
  for (const m of Array.isArray(party.members) ? party.members : []) {
    if (m && typeof m.ownerKey === "string") keys.add(m.ownerKey);
  }
  for (const inv of Array.isArray(party.invites) ? party.invites : []) {
    if (inv && typeof inv.toKey === "string") keys.add(inv.toKey);
  }
  for (const k of keys) pids.add(presenceIdFor(k));
  return pids;
}

/** チャット名前空間のキー → { channel, space }。対象外は null。 */
function chatKeyScope(key) {
  const m = /^(proximity|global):(.+)$/.exec(key);
  if (!m) return null;
  return { channel: m[1], space: m[2] };
}

/** ユニオン掲示名前空間のキー → ギルド ID。対象外は null。 */
function unionBoardGuildId(key) {
  const m = /^union:(.+)$/.exec(key);
  return m ? m[1] : null;
}

/**
 * 経済オプの状態変化について、通知すべき相手のプレゼンス ID 集合。
 * pending → done/failed の遷移だけを対象にし、宛先は「残高が動いた本人」
 * のみ（オプの userKey 本人 + 適用先 discordId + 送金先 toDiscordId +
 * steal の奪い元 fromDiscordId）。push には金額もオプ内容も載せない
 * （クライアントは合図で自分の REST を取り直す）。全体 broadcast は厳禁。
 */
function economyTargetPids(prevValue, nextValue) {
  const pids = new Set();
  const next = parseJsonLoose(nextValue);
  if (!next || typeof next !== "object") return pids;
  if (next.status !== "done" && next.status !== "failed") return pids;
  const prev = parseJsonLoose(prevValue);
  if (prev && typeof prev === "object" && prev.status === next.status) return pids;
  const ownerKeys = new Set();
  if (typeof next.userKey === "string") ownerKeys.add(next.userKey);
  if (typeof next.discordId === "string") ownerKeys.add(`discord:${next.discordId}`);
  if (typeof next.toDiscordId === "string") ownerKeys.add(`discord:${next.toDiscordId}`);
  if (typeof next.fromDiscordId === "string") ownerKeys.add(`discord:${next.fromDiscordId}`);
  for (const k of ownerKeys) pids.add(presenceIdFor(k));
  return pids;
}

/**
 * インスタンス名前空間のキー → 通知スコープ。対象外は null。
 * - "<space>"（洞窟/遺跡の共有状態）: その空間にいる全員へ { space }
 * - "dungeon:<x>,<y>:<layer>#<partyKey>"（ダンジョンのセッション）:
 *   その入口のダンジョンにいる全員へ（フロア不問） { spacePrefix }
 * - "<space>#<ownerKey>"（遺跡の個人状態）: 本人だけへ { pid }
 * - "dungeonclear:<ownerKey>"（週次クリア記録）: 同期不要のため null
 */
function instanceKeyScope(key) {
  if (typeof key !== "string" || key.startsWith("dungeonclear:")) return null;
  const hash = key.indexOf("#");
  const head = hash >= 0 ? key.slice(0, hash) : key;
  const tail = hash >= 0 ? key.slice(hash + 1) : "";
  const dm = /^dungeon:(-?\d+),(-?\d+):\d+$/.exec(head);
  if (dm) return { spacePrefix: `dungeon:${dm[1]},${dm[2]}:` };
  if (tail) return { pid: presenceIdFor(tail) };
  if (/^(cave|ruins):-?\d+,-?\d+:\d+$/.test(head)) return { space: head };
  return null;
}

module.exports = {
  WATCH_PLAN,
  normalizeValue,
  diffKv,
  presenceIdFor,
  partyTargetPids,
  chatKeyScope,
  unionBoardGuildId,
  economyTargetPids,
  instanceKeyScope,
};
