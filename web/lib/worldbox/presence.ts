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
export const EXTRAPOLATE_CAP_SEC = 2;
/** 描画位置が予測位置からこの距離（タイル）以上ずれたら即座に合わせる。 */
export const SNAP_DISTANCE = 6;
/** 速度の絶対値上限（タイル/秒）。歩行速度 4.4 の十分な余裕分だけ許可する。 */
const MAX_VELOCITY = 16;
/** 表示名の上限文字数。 */
export const PRESENCE_NAME_MAX = 24;
/** 移動連続性: 正規の最大移動速度（タイル/秒）。ダッシュ 7.0 + 約40%の余裕。 */
export const MAX_MOVE_SPEED = 10;
/** 移動連続性: 許容距離に足す余裕（タイル）。ノックバック（最大2〜3）と埋没救済の小幅なずれを吸収する。 */
export const MOVEMENT_MARGIN_TILES = 3;
/** 移動連続性: 保管位置がこの時間（ミリ秒）より古ければ新規入室として受け入れる。 */
export const MOVEMENT_RESET_MS = 30_000;
/** 移動連続性: プレゼンスが無いときのセーブ基準の許容距離（タイル）。初期スポーンの findFreeNear 最大 8 + 余裕。 */
export const SAVE_FALLBACK_MAX_TILES = 12;
/** 登録済みワープ対: 着地点の許容誤差（タイル）。着地は findFreeNear でずれることがあるため点ではなく近傍で照合する。 */
export const WARP_LANDING_TOLERANCE_TILES = 2.5;
/** 登録済みワープ対: セーブ基準でのワープ元タイルへの到達範囲（タイル）。
 * セーブには時刻が無いため、元タイルの間近にいた記録がある場合だけ認める
 * （広場など離れた場所のセーブから着地点へ直接跳べないようにする）。
 * 往復の着地点⇔反対側の元タイルは 2 タイルしか離れていないため 5 で覆える。 */
export const WARP_FALLBACK_SOURCE_REACH_TILES = 5;

/**
 * 同一空間内のクライアント駆動ワープ（登録済みワープ対）。
 * 空間が変わる遷移（階層階段・テント出入り・インスタンス入口）は空間変更で
 * 常に受け入れるため、ここには「同じ空間の中で位置だけが跳ぶ」ものだけを置く。
 * 現在はロビーの擬似2F階段の往復のみ。値の正は lobby.ts の LOBBY_STAIRS_UP /
 * LOBBY_STAIRS_DOWN / LOBBY_UP_LANDING / LOBBY_DOWN_LANDING で、このファイルは
 * 単体でトランスパイルされるため複製して明示する（worldbox-warp-continuity
 * テストが両者の一致を固定する）。ロビーのワープパッド (28,34) は world への
 * 空間変更ワープなので対象外。
 */
export const SAME_SPACE_WARPS: readonly {
  space: string;
  sources: readonly { x: number; y: number }[];
  landing: { x: number; y: number };
}[] = [
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
 * 登録済みワープ対による正当な不連続か: 保管位置から到達可能な範囲
 * （reachTiles 以内）にワープ元タイルがあり、申告位置がそのワープの
 * 着地点の近傍にある場合だけ true。元と着地は同じワープ対で結ばれる
 * 必要があり、対になっていないジャンプは通らない。到達範囲には時刻基準
 * では通常移動の許容距離（保管位置から元タイルまで歩いて届く場合だけ
 * 認める）、セーブ基準では WARP_FALLBACK_SOURCE_REACH_TILES を渡す。
 */
export function isRegisteredWarpJump(
  baseline: PositionLike,
  next: PositionLike,
  reachTiles: number,
): boolean {
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

/** 移動連続性の判定対象（空間つき位置）。 */
export type PositionLike = { x: number; y: number; space: PresenceSpace };
/** 移動連続性の基準（保管位置＋保管時刻）。 */
export type MovementBaseline = PositionLike & { ts: number };

/**
 * 移動連続性の判定（時刻基準）: 保管位置から、経過時間で移動可能な
 * 距離（MAX_MOVE_SPEED × 経過秒 + 余裕）を超えるジャンプを却下する。
 * 基準が無い・空間が変わった・保管が古い（RESET_MS 超）場合は受け入れる。
 * 空間の変化は入退室・階段・テント・階層移動の正当な不連続なので常に許可する。
 * 同一空間内の跳躍は原則却下だが、登録済みワープ対（SAME_SPACE_WARPS。
 * ロビー擬似2F階段の往復）の元→着地に一致するものだけは正当な不連続として
 * 受け入れる（isRegisteredWarpJump）。
 */
export function checkMovementContinuity(
  baseline: MovementBaseline | null,
  next: PositionLike,
  now: number,
): { ok: true } | { ok: false; reason: "position_jump" } {
  if (!baseline) return { ok: true };
  if (baseline.space !== next.space) return { ok: true };
  if (now - baseline.ts >= MOVEMENT_RESET_MS) return { ok: true };
  const elapsedSec = Math.max(0, (now - baseline.ts) / 1000);
  const allowed = MAX_MOVE_SPEED * elapsedSec + MOVEMENT_MARGIN_TILES;
  const dist = Math.hypot(next.x - baseline.x, next.y - baseline.y);
  if (dist <= allowed) return { ok: true };
  // 登録済みワープ対（同一空間内の階段など）: 保管位置からワープ元タイルへ
  // 歩いて届き、申告位置がその着地点なら正当な不連続として受け入れる。
  if (isRegisteredWarpJump(baseline, next, allowed)) return { ok: true };
  return { ok: false, reason: "position_jump" };
}

/**
 * 移動連続性の判定（セーブ基準・固定距離）: プレゼンスが無いときに
 * サーバー保存のセーブを基準にし、固定 SAVE_FALLBACK_MAX_TILES 以内だけ受け入れる。
 * セーブにはタイムスタンプが無いため、固定距離だと連続 PUT で少しずつ
 * 寄せられる（残る抜け穴として共有ノートに記録）。空間が変われば受け入れる。
 */
export function checkSaveFallbackContinuity(
  saved: PositionLike | null,
  next: PositionLike,
): { ok: true } | { ok: false; reason: "position_jump" } {
  if (!saved) return { ok: true };
  if (saved.space !== next.space) return { ok: true };
  const dist = Math.hypot(next.x - saved.x, next.y - saved.y);
  if (dist <= SAVE_FALLBACK_MAX_TILES) return { ok: true };
  // 登録済みワープ対（同一空間内の階段など）: セーブ位置がワープ元タイルの
  // 間近にあり、申告位置がその着地点なら受け入れる。
  if (isRegisteredWarpJump(saved, next, WARP_FALLBACK_SOURCE_REACH_TILES)) return { ok: true };
  return { ok: false, reason: "position_jump" };
}

/** プレイヤーがいる空間。ワールドとロビーでプレゼンスは混ざらない。 */
/** 既存3空間 + インスタンス空間 ID（"cave:x,y:層" 等）。 */
export type PresenceSpace = string;

/** 空間の指定として解釈する。不正な値はワールドに寄せる。 */
const PRESENCE_INSTANCE_SPACE_RE = /^(cave|ruins|dungeon):(-?\d+),(-?\d+):(\d+)$/;

export function sanitizePresenceSpace(raw: unknown): PresenceSpace {
  if (raw === "lobby" || raw === "lobby2" || raw === "lobby3" || raw === "tent") return raw;
  if (typeof raw === "string" && PRESENCE_INSTANCE_SPACE_RE.test(raw)) return raw;
  return "world";
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
  /** 冒険役職（ネームプレートと守護オーラ用。未送信は free）。 */
  role?: string;
  /** 冒険役職の熟練ランク（1〜5）。 */
  rank?: number;
  /** パーティ ID（バッチ5、ダンジョン内の他者フィルタ用）。未所属は ""。 */
  party?: string;
  /** 椅子・ベンチ・ソファに座っているか（見た目だけの申告）。 */
  sit?: boolean;
  /**
   * 本人のユーザーアイコン（Discord アバター）の URL。アバター描画用。
   * クライアント申告では受け付けず、サーバーがセッションから付与する
   * （REST はプレゼンスルート、WS は中継トークンの av クレーム経由）。
   * sanitizeHeartbeat は入力から読まない。保存値の復元は parsePresenceEntry。
   */
  avatar?: string;
  /** 開いているタブの識別子（同一アカウントの分身防止用。同アカウントでは最新のタブだけが有効）。 */
  tab?: string;
  /** そのタブを開いた時刻（ミリ秒）。タブ世代の新旧判定に使う。 */
  tabAt?: number;
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
    role: typeof v.role === "string" && ["blade", "guard", "scout", "miner", "medic", "teleporter"].includes(v.role) ? v.role : "free",
    rank: typeof v.rank === "number" && Number.isFinite(v.rank) ? Math.max(1, Math.min(5, Math.floor(v.rank))) : 1,
    party: typeof v.party === "string" ? v.party.slice(0, 48) : "",
    ...(v.sit === true ? { sit: true } : {}),
    ...(typeof v.tab === "string" && v.tab.length > 0 ? { tab: v.tab.slice(0, 64) } : {}),
    ...(typeof v.tabAt === "number" && Number.isFinite(v.tabAt) && v.tabAt > 0 ? { tabAt: v.tabAt } : {}),
  };
}

/**
 * タブ世代の判定（同一アカウントの分身防止）。
 * 保存済みエントリ（stored）と新しいハートビート（incoming）を見て、
 * incoming を受理してよいかを返す。規則:
 * - stored が無い/鮮度切れ、incoming にタブ申告が無い、stored にタブ記録が無い → 受理（世代は incoming で初期化/維持）
 * - 同じタブ → 受理
 * - incoming の開始時刻が新しい → 受理（世代交代。旧タブは以後 rejected になる）
 * - incoming の開始時刻が古い → 拒否（旧タブからの書き込み）
 * - 開始時刻が同値ならタブ ID の辞書順で大きい方を受理（決定的にするため）
 */
export function tabVerdict(
  stored: PresenceEntry | null,
  incoming: { tab?: string; tabAt?: number },
  now: number,
): "accept" | "reject" {
  if (!incoming.tab || typeof incoming.tabAt !== "number") return "accept";
  if (!stored || !isFreshPresence(stored, now)) return "accept";
  if (!stored.tab || typeof stored.tabAt !== "number") return "accept";
  if (stored.tab === incoming.tab) return "accept";
  if (incoming.tabAt !== stored.tabAt) return incoming.tabAt > stored.tabAt ? "accept" : "reject";
  return incoming.tab > stored.tab ? "accept" : "reject";
}

/**
 * 保存済みアバター URL の検証（サーバーが付与した値の復元用）。
 * https の URL で、空白・引用符・制御文字を含まないものだけを通す。
 */
export function sanitizeAvatarUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  if (raw.length === 0 || raw.length > 256) return null;
  if (!raw.startsWith("https://")) return null;
  if (/[\s"'<>\\\u0000-\u001f\u007f]/.test(raw)) return null;
  return raw;
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
  const avatar = sanitizeAvatarUrl(v.avatar);
  return { ...hb, ...(avatar ? { avatar } : {}), id, ts: v.ts };
}

/**
 * サーバー時刻とクライアント時刻のずれ（ミリ秒）の推定。
 * エントリの ts はサーバー受信時刻なので、受信側の時計がずれていると
 * 外挿の dt がそのまま狂う。往復の中点を受信時刻とみなす（NTP と同じ考え方）:
 * 戻り値をクライアントの Date.now() に足すとサーバー時刻に近づく。
 */
export function clockOffsetEstimate(serverNow: number, clientBefore: number, clientAfter: number): number {
  return serverNow - (clientBefore + clientAfter) / 2;
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

/** 近傍限定の間引き半径（タイル）。ワールドのスケール対策（バッチ6）。 */
export const PRESENCE_NEAR_RADIUS = 48;

/**
 * ワールド空間では自分の近傍だけを返す（スケール時の帯域と描画の節約）。
 * 自分のエントリが無い（未ログイン等）場合は間引かず従来どおり。
 * 近い順に並べ、上限を超えたら近いものから残す。
 */
export function thinPresenceNear(
  entries: PresenceEntry[],
  self: PresenceEntry | null,
  radius: number = PRESENCE_NEAR_RADIUS,
  limit: number = PRESENCE_MAX_PLAYERS,
): PresenceEntry[] {
  if (!self) return entries.slice(0, limit);
  return entries
    .map((e) => ({ e, d: Math.hypot(e.x - self.x, e.y - self.y) }))
    .filter(({ d }) => d <= radius)
    .sort((a, b) => a.d - b.d || b.e.ts - a.e.ts)
    .slice(0, limit)
    .map(({ e }) => e);
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
