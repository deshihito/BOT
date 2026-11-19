// WEB ゲーム「dreaming」の純粋ゲームロジック（React / DOM 非依存）。
//
// Transformer 以前の LLM（小型 LSTM + 文字レベル n-gram + 2D 条件付きマルコフ場）による
// 終わりなき夢の歩行・調律ゲーム。勝ち負けやクリアで閉じることはなく、どこまでも深く漂える。
//
// ゲームメカニクスに効く4つの夢の特徴:
// 1. 忘却: 記憶窓から外れた背後タイルはマップから忘却（evict）され、戻ると現在の隠れ状態から
//    再サンプルされて別の空間に書き換わる。「記憶を留める（Anchor・最大3枠 FIFO）」で局所保護できる。
// 2. 変質反復: 共鳴したモチーフはエコーキューに入り、数歩先で文字 n-gram により名前と領域色が
//    少しずつ変質した姿（Gen 2, 3, ...）として再出現する。再会を重ねると共鳴チェインが伸びる。
// 3. 滲み: RNN の領域確率分布 P(domain | h_t, T) に応じて地形・色・語彙が境目なく混合し、
//    アンカーの古い領域と新しい領域が衝突する境界では滲みが強まって深層への裂け目（rift）が開く。
// 4. 崩れ: 温度 T を操ることで、明晰（道が繋がり言葉が整う）<-> 深夢（言葉と空間が崩れるが
//    希少な変質や裂け目が生まれやすい）をリアルタイムに調律できる。

import {
  DOMAIN_IDS,
  DOMAIN_PALETTES,
  clampTemperature,
  createRnnState,
  createRng,
  dominantDomainOf,
  domainProbsFromRnn,
  generateDreamFragment,
  generateDreamPlaceName,
  getDreamLanguageModels,
  isWalkableTile,
  mutateDreamName,
  normalizedEntropy,
  sampleCharSequence,
  sampleNextTile,
  stepRnn,
  type DomainId,
  type DreamRnnState,
  type Rng,
  type TileKind,
} from "./dreaming-model";

export type DreamDir = "up" | "down" | "left" | "right";

export type MotifId =
  | "payphone"
  | "clock"
  | "vending"
  | "aquarium"
  | "crossing"
  | "chalkboard"
  | "bookshelf"
  | "umbrella"
  | "ticketgate"
  | "lighthouse"
  | "mirror"
  | "stairwell";

export type MotifSpec = {
  id: MotifId;
  /** 標本帳で束ねる原型ラベル。 */
  archetypeLabel: string;
  /** 第 1 世代の文字 n-gram 基準語。 */
  seedWord: string;
  /** 親和性の高い夢領域。 */
  homeDomain: DomainId;
  /** 共鳴時に RNN 隠れ状態へ注入される 8 次元入力ベクトル。 */
  impulse: readonly [number, number, number, number, number, number, number, number];
};

export const DREAM_MOTIFS: readonly MotifSpec[] = [
  {
    id: "payphone",
    archetypeLabel: "公衆電話",
    seedWord: "あかいでんわ",
    homeDomain: "arcade",
    impulse: [0.35, 0.0, 0.05, 0.85, 0.2, 0.0, 0.35, 0.25],
  },
  {
    id: "clock",
    archetypeLabel: "止まった時計",
    seedWord: "とまったとけい",
    homeDomain: "station",
    impulse: [0.85, 0.35, 0.2, 0.0, 0.0, 0.05, -0.2, -0.1],
  },
  {
    id: "vending",
    archetypeLabel: "光る自販機",
    seedWord: "ひかるじはんき",
    homeDomain: "arcade",
    impulse: [0.3, 0.0, 0.0, 0.9, 0.1, 0.25, 0.5, 0.3],
  },
  {
    id: "aquarium",
    archetypeLabel: "水槽",
    seedWord: "くらいすいそう",
    homeDomain: "school",
    impulse: [0.0, 0.75, 0.15, 0.1, 0.55, 0.0, -0.35, 0.75],
  },
  {
    id: "crossing",
    archetypeLabel: "踏切",
    seedWord: "あめのふみきり",
    homeDomain: "meadow",
    impulse: [0.55, 0.05, 0.0, 0.1, 0.05, 0.85, 0.2, 0.3],
  },
  {
    id: "chalkboard",
    archetypeLabel: "黒板",
    seedWord: "こくばんのうた",
    homeDomain: "school",
    impulse: [0.0, 0.9, 0.35, 0.0, 0.0, 0.15, -0.3, -0.2],
  },
  {
    id: "bookshelf",
    archetypeLabel: "無限の書架",
    seedWord: "ふるいほんだな",
    homeDomain: "library",
    impulse: [0.1, 0.25, 0.92, 0.0, 0.0, 0.0, -0.45, -0.25],
  },
  {
    id: "umbrella",
    archetypeLabel: "置き傘",
    seedWord: "あかいおきがさ",
    homeDomain: "arcade",
    impulse: [0.25, 0.25, 0.0, 0.75, 0.4, 0.2, 0.1, 0.65],
  },
  {
    id: "ticketgate",
    archetypeLabel: "無人改札",
    seedWord: "むじんかいさつ",
    homeDomain: "station",
    impulse: [0.92, 0.05, 0.1, 0.3, 0.1, 0.15, 0.3, 0.05],
  },
  {
    id: "lighthouse",
    archetypeLabel: "霧の灯台",
    seedWord: "きりのとうだい",
    homeDomain: "harbor",
    impulse: [0.1, 0.0, 0.1, 0.15, 0.95, 0.25, -0.2, 0.7],
  },
  {
    id: "mirror",
    archetypeLabel: "歪んだ鏡",
    seedWord: "ゆがんだかがみ",
    homeDomain: "library",
    impulse: [0.15, 0.45, 0.7, 0.2, 0.25, 0.0, -0.25, 0.15],
  },
  {
    id: "stairwell",
    archetypeLabel: "踊り場の階段",
    seedWord: "おわりないかいだん",
    homeDomain: "school",
    impulse: [0.25, 0.75, 0.55, 0.1, 0.15, 0.0, -0.15, 0.0],
  },
] as const;

export const MOTIF_BY_ID: Record<MotifId, MotifSpec> = Object.fromEntries(
  DREAM_MOTIFS.map((m) => [m.id, m]),
) as Record<MotifId, MotifSpec>;

export const MAX_ANCHORS = 3;
export const ANCHOR_RADIUS = 2;
export const VIEW_RADIUS = 7;
export const MAX_ECHO_QUEUE = 5;
export const MAX_ARCHIVE_ENTRIES = 60;

export type TileMotif = {
  id: MotifId;
  /** 変質世代（1 = 原型に近い、2+ = 変質反復で戻ってきた個体）。 */
  generation: number;
  /** 文字レベル n-gram モデルが生成した崩れた名前。 */
  name: string;
  /** 前回出会った領域（混交色・滲み演出に使う）。 */
  originDomain: DomainId;
  /** 出現した時点の支配領域。 */
  domain: DomainId;
};

export type DreamTile = {
  x: number;
  y: number;
  kind: TileKind;
  domain: DomainId;
  /** タイル生成時点の領域確率分布スナップショット（滲み色描画・境界干渉判定に使用）。 */
  domainBlend: Record<DomainId, number>;
  /** 記憶残量 0..1（1 = 鮮明、0 に近づくと霧に溶け忘却される）。 */
  memory: number;
  bornStep: number;
  /** 忘却しかけたときに浮かび上がる文字残滓（char-LM 由来）。 */
  glyph: string;
  /** 境界干渉度 0..1（アンカー保護域と新領域の衝突など）。 */
  bleedShock: number;
  motif: TileMotif | null;
};

export type DreamAnchor = {
  id: number;
  x: number;
  y: number;
  domain: DomainId;
  label: string;
  placedStep: number;
};

export type EchoSeed = {
  motifId: MotifId;
  generation: number;
  prevName: string;
  prevDomain: DomainId;
  dueStep: number;
};

export type ArchiveEntry = {
  motifId: MotifId;
  archetypeLabel: string;
  generation: number;
  name: string;
  domain: DomainId;
  originDomain: DomainId;
  depth: number;
  step: number;
  fragment: string;
};

export type DreamStalker = {
  id: number;
  x: number;
  y: number;
  /** char-RNN が変質生成した不気味な呼び名。 */
  name: string;
  originMotifId: MotifId | null;
  generation: number;
  domain: DomainId;
  /** 懐中電灯の光錐内に捉えられているか（目が合うと静止する）。 */
  seen: boolean;
  /** 見つめ合い続けている累積ティック。 */
  stareTicks: number;
};

export type DreamEventKind =
  | "init"
  | "move"
  | "blocked"
  | "collect"
  | "reunion"
  | "anchor"
  | "anchor_evict"
  | "anchor_remove"
  | "pulse"
  | "descend"
  | "consumed"
  | "temp"
  | "drift";

export type DreamEvent = {
  kind: DreamEventKind;
  step: number;
  x: number;
  y: number;
  detail?: string;
  generation?: number;
};

export type DreamWhisper = {
  text: string;
  sub?: string;
  step: number;
};

export type DreamState = {
  /** ゲームに終わりはないため常に "drifting"。影に呑まれても終わらずさらに深い悪夢層へ落ちる。 */
  status: "drifting";
  seed: number;
  rngTick: number;
  step: number;
  depth: number;
  stepsSinceDescend: number;
  player: { x: number; y: number; facing: DreamDir };
  temperature: number;
  rnn: DreamRnnState;
  domainWeights: Record<DomainId, number>;
  dominantDomain: DomainId;
  bleedEntropy: number;
  placeName: string;
  tiles: Map<string, DreamTile>;
  anchors: DreamAnchor[];
  nextAnchorId: number;
  /** 視線の裏から忍び寄り、光を当てると静止する変質残響の影。 */
  stalkers: DreamStalker[];
  nextStalkerId: number;
  /** 現在の恐怖・狂気度（0..1）。温度 T・空間歪み・心音・言語崩壊へ直結する。 */
  dread: number;
  /** 影に呑み込まれて深層へ引きずり込まれた累計回数。 */
  consumedCount: number;
  echoQueue: EchoSeed[];
  echoChain: number;
  maxGeneration: number;
  forgottenCount: number;
  archive: ArchiveEntry[];
  discoveredMotifs: MotifId[];
  whisper: DreamWhisper | null;
  lastEvent: DreamEvent;
};

export function tileKey(x: number, y: number): string {
  return `${x},${y}`;
}

export function chebyshev(ax: number, ay: number, bx: number, by: number): number {
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by));
}

/** 深度に応じた記憶窓（歩数）。深いほど過去の景色を早く忘れる。 */
export function memoryWindowForDepth(depth: number): number {
  return Math.max(8, Math.round(21 - (Math.max(1, depth) - 1) * 1.4));
}

function nextStepRng(seed: number, tick: number): { rng: Rng; nextTick: number } {
  const mixed = (seed ^ Math.imul(tick + 1, 2654435761)) >>> 0;
  return { rng: createRng(mixed || 1), nextTick: tick + 1 };
}

function isProtectedByAnchor(x: number, y: number, anchors: readonly DreamAnchor[]): DreamAnchor | null {
  for (const a of anchors) {
    if (chebyshev(x, y, a.x, a.y) <= ANCHOR_RADIUS) return a;
  }
  return null;
}

const DIR_ANGLE: Record<DreamDir, number> = {
  right: 0,
  down: Math.PI * 0.5,
  left: Math.PI,
  up: -Math.PI * 0.5,
};

/** プレイヤーの懐中電灯光錐（距離 5.8 以内・角度 ±0.64 rad）に対象が入っているか。 */
export function isInVisionCone(
  px: number,
  py: number,
  facingOrAngle: DreamDir | number,
  tx: number,
  ty: number,
): boolean {
  const dx = tx - px;
  const dy = ty - py;
  const dist = Math.hypot(dx, dy);
  if (dist < 0.01) return true;
  if (dist > 5.8) return false;
  const look = typeof facingOrAngle === "number" ? facingOrAngle : DIR_ANGLE[facingOrAngle];
  let diff = Math.atan2(dy, dx) - look;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return Math.abs(diff) <= 0.64;
}

/** 影との距離・見つめ合い・深度・しおり保護から現在の恐怖度 dread（0..1）を算出する。 */
export function computeDread(
  px: number,
  py: number,
  depth: number,
  stalkers: readonly DreamStalker[],
  anchors: readonly DreamAnchor[],
): number {
  const base = Math.min(0.28, Math.max(0, depth - 1) * 0.065);
  let peak = 0;
  for (const st of stalkers) {
    const dist = Math.hypot(st.x - px, st.y - py);
    if (dist > 7.5) continue;
    const prox = Math.max(0, 1 - dist / 7.0);
    const stareBonus = st.seen ? Math.min(0.28, 0.08 + st.stareTicks * 0.04) : 0;
    const local = Math.pow(prox, 1.35) * 0.86 + stareBonus;
    if (local > peak) peak = local;
  }
  const inSanctuary = isProtectedByAnchor(px, py, anchors) !== null;
  const raw = Math.min(1, base + peak);
  return Math.round((inSanctuary ? raw * 0.48 : raw) * 1000) / 1000;
}

const STALKER_SEED_NAMES = ["うしろのかげ", "だれかのあしおと", "みているひと", "かえれないかげ"] as const;

/**
 * 残響の影（DreamStalker）の出現・視線凍結・背後接近・しおり境界ブロックを 1 ステップ進める。
 * - 視線光錐内（seen = true）の影はピタッと静止し、見つめ合いが続くほど名前が崩れて dread が高まる
 * - 視線光錐外（背中側・闇）の影は静かに 1 マスずつ忍び寄る（ただしアンカー保護域 5×5 へは侵入できない）
 * - プレイヤーと重なった場合は consumedBy にその影を返す
 */
function advanceStalkers(
  prevStalkers: readonly DreamStalker[],
  nextStalkerIdStart: number,
  tiles: Map<string, DreamTile>,
  anchors: readonly DreamAnchor[],
  px: number,
  py: number,
  facingOrAngle: DreamDir | number,
  depth: number,
  step: number,
  domainWeights: Record<DomainId, number>,
  dominant: DomainId,
  temperature: number,
  archive: readonly ArchiveEntry[],
  mode: "move" | "drift",
  rng: Rng,
): { stalkers: DreamStalker[]; nextStalkerId: number; consumedBy: DreamStalker | null } {
  const models = getDreamLanguageModels();
  let nextId = nextStalkerIdStart;
  const result: DreamStalker[] = [];
  let consumedBy: DreamStalker | null = null;

  const occupied = new Set<string>();
  const playerProtected = isProtectedByAnchor(px, py, anchors) !== null;

  // 1. 既存の影を更新（遠すぎるものは霧へ忘却）
  for (const raw of prevStalkers) {
    if (chebyshev(px, py, raw.x, raw.y) > VIEW_RADIUS + 2) continue;

    const st: DreamStalker = { ...raw };
    const seenNow = isInVisionCone(px, py, facingOrAngle, st.x, st.y);
    st.seen = seenNow;

    if (st.x === px && st.y === py) {
      if (!playerProtected) {
        consumedBy = st;
      }
      result.push(st);
      continue;
    }

    if (seenNow) {
      // 光を向けられている間はピタッと静止し、見つめ合い続けると言葉が崩れる
      st.stareTicks += 1;
      if (st.stareTicks % 3 === 0) {
        st.name = mutateDreamName(models, domainWeights, st.name, st.generation + 1, Math.min(1.8, temperature + 0.25), rng);
      }
    } else {
      st.stareTicks = 0;
      const moveChance =
        mode === "drift"
          ? Math.min(0.88, 0.64 + (depth - 1) * 0.06)
          : Math.min(0.84, 0.56 + (depth - 1) * 0.06);

      if (rng() < moveChance) {
        const dirs: readonly [number, number][] = [
          [0, -1],
          [1, 0],
          [0, 1],
          [-1, 0],
        ];
        let bestX = st.x;
        let bestY = st.y;
        let bestDist = Math.hypot(px - st.x, py - st.y);

        for (const [dx, dy] of dirs) {
          const nx = st.x + dx;
          const ny = st.y + dy;
          const nKey = tileKey(nx, ny);
          if (occupied.has(nKey)) continue;
          // しおり（Anchor）の 5×5 記憶結界には絶対に踏み込めない
          if (isProtectedByAnchor(nx, ny, anchors) !== null) continue;
          const tile = tiles.get(nKey);
          const walkable = tile ? isWalkableTile(tile.kind) && tile.kind !== "rift" : false;
          // 第 3 層以降では非アンカー壁を低確率ですり抜けて不気味さを増す
          const canPhase = depth >= 3 && tile && !walkable && rng() < 0.28;
          if (!walkable && !canPhase) continue;

          const d = Math.hypot(px - nx, py - ny) + (rng() - 0.5) * 0.14;
          if (d < bestDist) {
            bestDist = d;
            bestX = nx;
            bestY = ny;
          }
        }
        st.x = bestX;
        st.y = bestY;
        st.seen = isInVisionCone(px, py, facingOrAngle, st.x, st.y);
      }
    }

    occupied.add(tileKey(st.x, st.y));
    result.push(st);

    if (st.x === px && st.y === py && !playerProtected && !consumedBy) {
      consumedBy = st;
    }
  }

  // 2. 視線の裏（光錐の外・距離 5..7・非アンカー）から新たな残響の影が滲み出る
  const maxStalkers = depth === 1 ? 1 : depth <= 3 ? 2 : 3;
  const eligible = step >= 4 || depth >= 2 || archive.length >= 1;
  const spawnChance = mode === "drift" ? 0.26 : 0.22;

  if (!consumedBy && eligible && result.length < maxStalkers && rng() < spawnChance) {
    const candidates: DreamTile[] = [];
    for (const tile of tiles.values()) {
      const dist = chebyshev(px, py, tile.x, tile.y);
      if (dist < 5 || dist > VIEW_RADIUS) continue;
      if (!isWalkableTile(tile.kind) || tile.kind === "rift") continue;
      if (isProtectedByAnchor(tile.x, tile.y, anchors) !== null) continue;
      if (isInVisionCone(px, py, facingOrAngle, tile.x, tile.y)) continue;
      if (occupied.has(tileKey(tile.x, tile.y))) continue;
      candidates.push(tile);
    }
    if (candidates.length > 0) {
      const spot = candidates[Math.floor(rng() * candidates.length)];
      const recent = archive[0];
      const baseWord =
        recent?.name ?? STALKER_SEED_NAMES[Math.floor(rng() * STALKER_SEED_NAMES.length)];
      const gen = (recent?.generation ?? 1) + Math.max(0, depth - 1);
      const mutated = mutateDreamName(models, domainWeights, baseWord, gen, Math.min(1.8, temperature + 0.2), rng);
      result.push({
        id: nextId++,
        x: spot.x,
        y: spot.y,
        name: mutated,
        originMotifId: recent?.motifId ?? null,
        generation: gen,
        domain: dominant,
        seen: false,
        stareTicks: 0,
      });
    }
  }

  return { stalkers: result, nextStalkerId: nextId, consumedBy };
}

/** リアルタイムで懐中電灯の向きが変わった瞬間、影の可視状態と恐怖度 dread を即時同期する。 */
export function syncStalkerVisibility(
  state: DreamState,
  lookAngle: number,
): { state: DreamState; newlySpotted: boolean } {
  if (state.stalkers.length === 0) return { state, newlySpotted: false };
  let changed = false;
  let newlySpotted = false;
  const nextStalkers = state.stalkers.map((st) => {
    const seen = isInVisionCone(state.player.x, state.player.y, lookAngle, st.x, st.y);
    if (seen !== st.seen) {
      changed = true;
      if (seen) newlySpotted = true;
      return { ...st, seen };
    }
    return st;
  });
  if (!changed) return { state, newlySpotted: false };
  const nextDread = computeDread(state.player.x, state.player.y, state.depth, nextStalkers, state.anchors);
  return {
    state: { ...state, stalkers: nextStalkers, dread: nextDread },
    newlySpotted,
  };
}

/** 指定座標の近傍に別領域（特にアンカー保護された過去領域）が接している強度（0..1）。 */
function computeBoundaryShock(
  x: number,
  y: number,
  currentDomain: DomainId,
  tiles: Map<string, DreamTile>,
  anchors: readonly DreamAnchor[],
): number {
  const dirs = [
    [0, -1],
    [0, 1],
    [1, 0],
    [-1, 0],
  ];
  let shock = 0;
  for (const [dx, dy] of dirs) {
    const nb = tiles.get(tileKey(x + dx, y + dy));
    if (!nb) continue;
    if (nb.domain !== currentDomain) {
      const anchored = isProtectedByAnchor(nb.x, nb.y, anchors) !== null;
      shock += anchored ? 0.45 : 0.18;
    }
  }
  return Math.min(1, shock);
}

function hasNearbyRift(x: number, y: number, tiles: Map<string, DreamTile>, radius = 5): boolean {
  for (const t of tiles.values()) {
    if (t.kind === "rift" && chebyshev(x, y, t.x, t.y) <= radius) return true;
  }
  return false;
}

function hasNearbyMotif(x: number, y: number, tiles: Map<string, DreamTile>, radius = 3): boolean {
  for (const t of tiles.values()) {
    if (t.motif && chebyshev(x, y, t.x, t.y) <= radius) return true;
  }
  return false;
}

/** 現在の領域混合に合わせて、原型モチーフを確率選択する。 */
function pickMotifSpec(
  domainWeights: Record<DomainId, number>,
  discovered: readonly MotifId[],
  rng: Rng,
): MotifSpec {
  const discoveredSet = new Set(discovered);
  const weights = DREAM_MOTIFS.map((m) => {
    const affinity = 0.25 + (domainWeights[m.homeDomain] ?? 0) * 1.9;
    // 未発見の原型はわずかに引き寄せて、探索の喜びを途切れさせない
    const novelty = discoveredSet.has(m.id) ? 1.0 : 1.55;
    return affinity * novelty;
  });
  let total = 0;
  for (const w of weights) total += w;
  let u = rng() * total;
  for (let i = 0; i < DREAM_MOTIFS.length; i++) {
    u -= weights[i];
    if (u <= 0) return DREAM_MOTIFS[i];
  }
  return DREAM_MOTIFS[DREAM_MOTIFS.length - 1];
}

function sampleGlyph(
  domainWeights: Record<DomainId, number>,
  temperature: number,
  rng: Rng,
): string {
  const models = getDreamLanguageModels();
  const s = sampleCharSequence(models.words, domainWeights, temperature, rng, {
    minLen: 1,
    maxLen: 2,
  });
  const chars = Array.from(s);
  return chars[0] ?? "の";
}

function buildFreshMotif(
  spec: MotifSpec,
  domainWeights: Record<DomainId, number>,
  dominant: DomainId,
  temperature: number,
  rng: Rng,
): TileMotif {
  const models = getDreamLanguageModels();
  // 低温なら原型語に近く、高温や他領域が滲んでいると文字 n-gram で崩れる
  const keep = temperature < 0.7 ? 4 : temperature < 1.15 ? 3 : 2;
  const seedChars = Array.from(spec.seedWord);
  const name =
    temperature <= 0.55 && dominant === spec.homeDomain
      ? spec.seedWord
      : sampleCharSequence(models.words, domainWeights, clampTemperature(temperature * 0.95), rng, {
          seedPrefix: seedChars.slice(0, Math.min(keep, seedChars.length)).join(""),
          minLen: 5,
          maxLen: 10,
        });
  return {
    id: spec.id,
    generation: 1,
    name: name.length >= 3 ? name : spec.seedWord,
    originDomain: spec.homeDomain,
    domain: dominant,
  };
}

/** プレイヤー周囲の未生成タイルを、近い順に自己回帰（2D マルコフ逐次生成）で埋める。 */
function populateVisionTiles(
  tiles: Map<string, DreamTile>,
  px: number,
  py: number,
  step: number,
  stepsSinceDescend: number,
  domainWeights: Record<DomainId, number>,
  dominant: DomainId,
  bleedEntropy: number,
  temperature: number,
  anchors: readonly DreamAnchor[],
  discovered: readonly MotifId[],
  rng: Rng,
): void {
  const coords: Array<{ x: number; y: number; dist: number }> = [];
  for (let dy = -VIEW_RADIUS; dy <= VIEW_RADIUS; dy++) {
    for (let dx = -VIEW_RADIUS; dx <= VIEW_RADIUS; dx++) {
      const x = px + dx;
      const y = py + dy;
      if (tiles.has(tileKey(x, y))) continue;
      coords.push({ x, y, dist: Math.abs(dx) + Math.abs(dy) });
    }
  }
  // プレイヤーに近い既知領域の縁から外側へ向けて逐次サンプリング（自己回帰生成）
  coords.sort((a, b) => a.dist - b.dist || a.y - b.y || a.x - b.x);

  const blendCopy = { ...domainWeights };
  const riftAlready = hasNearbyRift(px, py, tiles, VIEW_RADIUS);
  let spawnedRiftThisStep = riftAlready;

  for (const { x, y, dist } of coords) {
    const north = tiles.get(tileKey(x, y - 1))?.kind;
    const south = tiles.get(tileKey(x, y + 1))?.kind;
    const east = tiles.get(tileKey(x + 1, y))?.kind;
    const west = tiles.get(tileKey(x - 1, y))?.kind;
    const shock = computeBoundaryShock(x, y, dominant, tiles, anchors);

    let kind: TileKind;
    if (dist <= 1) {
      // プレイヤー直近は最低限の移動余地を保つ
      kind = "floor";
    } else {
      kind = sampleNextTile(
        domainWeights,
        {
          north,
          south,
          east,
          west,
          boundaryShock: shock,
          bleedEntropy,
          stepsSinceDescend,
          hasNearbyRift: spawnedRiftThisStep || dist <= 2,
        },
        temperature,
        rng,
      );
    }

    if (kind === "rift") {
      spawnedRiftThisStep = true;
    }

    let motif: TileMotif | null = null;
    if (
      isWalkableTile(kind) &&
      kind !== "rift" &&
      dist >= 3 &&
      dist <= VIEW_RADIUS - 1 &&
      !hasNearbyMotif(x, y, tiles, 4)
    ) {
      // 温度と境界干渉が高いほどモチーフが滲み出やすい
      const spawnChance = 0.042 + bleedEntropy * 0.03 + shock * 0.08 + (temperature - 0.8) * 0.015;
      if (rng() < Math.max(0.025, Math.min(0.18, spawnChance))) {
        const spec = pickMotifSpec(domainWeights, discovered, rng);
        motif = buildFreshMotif(spec, domainWeights, dominant, temperature, rng);
      }
    }

    tiles.set(tileKey(x, y), {
      x,
      y,
      kind,
      domain: dominant,
      domainBlend: blendCopy,
      memory: 1,
      bornStep: step,
      glyph: sampleGlyph(domainWeights, temperature, rng),
      bleedShock: shock,
      motif,
    });
  }
}

const DIR_DELTA: Record<DreamDir, [number, number]> = {
  up: [0, -1],
  down: [0, 1],
  left: [-1, 0],
  right: [1, 0],
};

/**
 * 忘却処理：記憶窓から外れた非アンカー保護タイルを減衰させ、0 以下になったものを忘却（evict）する。
 * また、進行方向の「背後」にあるタイルほど早く薄れ、薄れたまま再び視界の縁へ戻った非保護タイルは
 * 現在の LSTM 状態から密かに再サンプルされて別の景色へ書き換わる（夢の記憶違い）。
 */
function applyForgetting(
  tiles: Map<string, DreamTile>,
  px: number,
  py: number,
  facing: DreamDir,
  step: number,
  depth: number,
  anchors: readonly DreamAnchor[],
  domainWeights: Record<DomainId, number>,
  dominant: DomainId,
  bleedEntropy: number,
  stepsSinceDescend: number,
  temperature: number,
  rng: Rng,
): number {
  const windowSteps = memoryWindowForDepth(depth);
  const [fx, fy] = DIR_DELTA[facing];
  let forgotten = 0;
  let misremembered = 0;

  for (const [key, tile] of tiles) {
    const dist = chebyshev(px, py, tile.x, tile.y);
    const anchored = isProtectedByAnchor(tile.x, tile.y, anchors) !== null;

    if (anchored) {
      tile.memory = 1;
      continue;
    }

    const dx = tile.x - px;
    const dy = tile.y - py;
    const behindDot = dx * fx + dy * fy;

    if (dist <= 3) {
      // 薄れかけていた非保護タイルを振り返って見直すと、現在の夢状態に引っ張られて密かに記憶違いを起こす
      if (
        dist >= 2 &&
        tile.memory < 0.56 &&
        !tile.motif &&
        tile.kind !== "rift" &&
        misremembered < 2
      ) {
        const shiftProb = Math.max(
          0.08,
          Math.min(0.65, 0.16 + (temperature - 0.65) * 0.28 + bleedEntropy * 0.22),
        );
        if (rng() < shiftProb) {
          const resampled = sampleNextTile(
            domainWeights,
            {
              north: tiles.get(tileKey(tile.x, tile.y - 1))?.kind,
              south: tiles.get(tileKey(tile.x, tile.y + 1))?.kind,
              east: tiles.get(tileKey(tile.x + 1, tile.y))?.kind,
              west: tiles.get(tileKey(tile.x - 1, tile.y))?.kind,
              bleedEntropy,
              stepsSinceDescend,
              hasNearbyRift: true,
            },
            temperature,
            rng,
          );
          tile.kind = resampled;
          tile.domain = dominant;
          tile.domainBlend = { ...domainWeights };
          tile.glyph = sampleGlyph(domainWeights, temperature, rng);
          tile.bornStep = step;
          tile.memory = 0.84;
          misremembered++;
          continue;
        }
      }
      // 足元の直接視界は鮮明さを取り戻す
      tile.memory = Math.min(1, tile.memory + 0.16);
      continue;
    }

    const age = step - tile.bornStep;
    let decay = 0;
    if (dist > VIEW_RADIUS) {
      // 視界外に押し出された記憶は急速に薄れる（有限コンテキスト窓の忘却）
      decay = 0.3 + Math.min(0.24, (depth - 1) * 0.035) + (dist - VIEW_RADIUS) * 0.08;
    } else if (dist >= 5) {
      // 視界の縁・背後はじわじわ滲み始める
      decay = (age > windowSteps ? 0.16 : 0.06) + (behindDot < 0 ? 0.07 : 0);
    } else if (behindDot < 0 && dist >= 4) {
      // 背中側（視線の裏）は前よりも早く曖昧になる
      decay = age > windowSteps * 0.7 ? 0.13 : 0.07;
    } else if (age > windowSteps * 1.2) {
      decay = 0.04;
    }

    if (decay > 0) {
      tile.memory = Math.max(0, tile.memory - decay);
    }

    // 視界外かつ記憶ゼロ、または記憶窓を大きく超えた遠方タイルを忘却（evict）
    if ((dist > VIEW_RADIUS && tile.memory <= 0.02) || (dist >= 6 && tile.memory <= 0.01)) {
      tiles.delete(key);
      forgotten++;
    }
  }
  return forgotten;
}

/** 反響キューに待機中の変質モチーフを、進行方向の視界内へ再出現させる。 */
function manifestDueEchoes(
  echoQueue: EchoSeed[],
  tiles: Map<string, DreamTile>,
  px: number,
  py: number,
  facing: DreamDir,
  step: number,
  domainWeights: Record<DomainId, number>,
  dominant: DomainId,
  temperature: number,
  rng: Rng,
): { remaining: EchoSeed[]; manifestedName: string | null } {
  const remaining: EchoSeed[] = [];
  let manifestedName: string | null = null;
  const models = getDreamLanguageModels();
  const [fx, fy] = DIR_DELTA[facing];

  for (const echo of echoQueue) {
    if (echo.dueStep > step || manifestedName !== null) {
      remaining.push(echo);
      continue;
    }
    // 進行方向前方（距離 3..6）の通行可能＆モチーフ無しタイルを優先探索
    const candidates: Array<{ tile: DreamTile; score: number }> = [];
    for (const tile of tiles.values()) {
      if (!isWalkableTile(tile.kind) || tile.kind === "rift" || tile.motif) continue;
      const dx = tile.x - px;
      const dy = tile.y - py;
      const dist = chebyshev(px, py, tile.x, tile.y);
      if (dist < 3 || dist > VIEW_RADIUS - 1) continue;
      const dot = dx * fx + dy * fy;
      const score = dot * 1.4 - Math.abs(dist - 4.5) + tile.bleedShock * 2.0 + rng() * 0.6;
      candidates.push({ tile, score });
    }
    if (candidates.length === 0) {
      // まだ空きが無ければ次歩へ持ち越し
      remaining.push(echo);
      continue;
    }
    candidates.sort((a, b) => b.score - a.score);
    const target = candidates[0].tile;
    const mutated = mutateDreamName(
      models,
      domainWeights,
      echo.prevName,
      echo.generation,
      temperature,
      rng,
    );
    target.motif = {
      id: echo.motifId,
      generation: echo.generation,
      name: mutated,
      originDomain: echo.prevDomain,
      domain: dominant,
    };
    target.memory = 1;
    manifestedName = mutated;
  }

  return { remaining, manifestedName };
}

/** 歩行 1 ステップ分の RNN 外部入力ベクトルを構築する。 */
function buildWalkInput(
  dir: DreamDir,
  tile: DreamTile,
  bleedEntropy: number,
  rng: Rng,
): number[] {
  const vec = new Array<number>(8).fill(0);
  const domIdx = DOMAIN_IDS.indexOf(tile.domain);
  if (domIdx >= 0) vec[domIdx] += 0.22;

  // 歩く方角と緩やかな確率揺らぎが隠れ状態をじわっと押す（同じ場所に停滞し続けない）
  const [dx, dy] = DIR_DELTA[dir];
  for (let i = 0; i < 6; i++) {
    const phase = (i * 1.05 + dx * 0.7 + dy * 1.1) * 1.3;
    vec[i] += Math.sin(phase) * 0.14 + (rng() - 0.48) * 0.36;
  }
  // 踏んだタイル種別が補助次元（喧騒・湿り）と領域へ反映
  if (tile.kind === "rail") {
    vec[0] += 0.28; // station
    vec[5] += 0.16; // meadow
  } else if (tile.kind === "lamp") {
    vec[6] += 0.28;
    vec[3] += 0.16;
  } else if (tile.bleedShock > 0.2) {
    vec[7] += 0.22 * tile.bleedShock;
  }
  vec[6] += (rng() - 0.5) * 0.24;
  vec[7] += (rng() - 0.5) * 0.24 + bleedEntropy * 0.08;
  return vec;
}

/** モチーフ採集の共通処理（歩行で踏んだとき・記憶パルスで共鳴したとき両方）。 */
function collectMotifOnTile(
  state: DreamState,
  tiles: Map<string, DreamTile>,
  tile: DreamTile,
  rng: Rng,
  nextTick: number,
): DreamState {
  const motif = tile.motif;
  if (!motif) return state;
  const spec = MOTIF_BY_ID[motif.id];
  const models = getDreamLanguageModels();

  // モチーフを消費
  tile.motif = null;
  tile.memory = 1;

  // モチーフ固有ベクトル＋元領域と現領域の混交を RNN 隠れ状態へ強く注入
  const impulse = [...spec.impulse];
  const curIdx = DOMAIN_IDS.indexOf(state.dominantDomain);
  const origIdx = DOMAIN_IDS.indexOf(motif.originDomain);
  if (curIdx >= 0) impulse[curIdx] += 0.25;
  if (origIdx >= 0 && origIdx !== curIdx) impulse[origIdx] += 0.35;

  const nextRnn = stepRnn(state.rnn, impulse, state.depth, state.temperature);
  const nextWeights = domainProbsFromRnn(nextRnn, state.temperature);
  const nextDom = dominantDomainOf(nextWeights);
  const nextEntropy = normalizedEntropy(DOMAIN_IDS.map((d) => nextWeights[d]));

  const isReunion = motif.generation >= 2;
  const nextEchoChain = isReunion ? state.echoChain + 1 : state.echoChain;
  const nextMaxGen = Math.max(state.maxGeneration, motif.generation);
  const discovered = state.discoveredMotifs.includes(motif.id)
    ? state.discoveredMotifs
    : [...state.discoveredMotifs, motif.id];

  const fragment = generateDreamFragment(models, nextWeights, state.temperature, rng);
  const entry: ArchiveEntry = {
    motifId: motif.id,
    archetypeLabel: spec.archetypeLabel,
    generation: motif.generation,
    name: motif.name,
    domain: motif.domain,
    originDomain: motif.originDomain,
    depth: state.depth,
    step: state.step,
    fragment,
  };
  const nextArchive = [entry, ...state.archive].slice(0, MAX_ARCHIVE_ENTRIES);

  // 変質反復キューへ次の世代を積む（最大件数を超えたら古い残響から忘却）
  const nextSeed: EchoSeed = {
    motifId: motif.id,
    generation: motif.generation + 1,
    prevName: motif.name,
    prevDomain: nextDom,
    dueStep: state.step + 6 + Math.floor(rng() * 6),
  };
  const nextEchoQueue = [...state.echoQueue, nextSeed].slice(-MAX_ECHO_QUEUE);

  // 変質再会の瞬間、地名もモチーフ語の断片に引きずられて微変質する
  const nextPlaceName = isReunion
    ? mutateDreamName(models, nextWeights, state.placeName, motif.generation, state.temperature, rng)
    : state.placeName;

  const sub = isReunion
    ? `${spec.archetypeLabel} · 第${motif.generation}変質「${motif.name}」（再会 ${nextEchoChain}）`
    : `${spec.archetypeLabel}「${motif.name}」を記憶に刻んだ`;

  return {
    ...state,
    rngTick: nextTick,
    rnn: nextRnn,
    domainWeights: nextWeights,
    dominantDomain: nextDom,
    bleedEntropy: nextEntropy,
    placeName: nextPlaceName,
    tiles,
    echoQueue: nextEchoQueue,
    echoChain: nextEchoChain,
    maxGeneration: nextMaxGen,
    archive: nextArchive,
    discoveredMotifs: discovered,
    whisper: { text: fragment, sub, step: state.step },
    lastEvent: {
      kind: isReunion ? "reunion" : "collect",
      step: state.step,
      x: tile.x,
      y: tile.y,
      detail: motif.name,
      generation: motif.generation,
    },
  };
}

/** 初期の夢世界を生成する。初回から視界内に 2 つのモチーフを置き、すぐ手応えを味わえるようにする。 */
export function createDreamGame(seed = 20261119): DreamState {
  const safeSeed = (seed | 0) || 1;
  const rng = createRng(safeSeed);
  const startDomainIdx = Math.floor(rng() * DOMAIN_IDS.length);
  const rnn = createRnnState(startDomainIdx, rng);
  const temperature = 0.92;
  const domainWeights = domainProbsFromRnn(rnn, temperature);
  const dominantDomain = dominantDomainOf(domainWeights);
  const bleedEntropy = normalizedEntropy(DOMAIN_IDS.map((d) => domainWeights[d]));
  const models = getDreamLanguageModels();
  const placeName = generateDreamPlaceName(models, domainWeights, temperature, rng);
  const tiles = new Map<string, DreamTile>();

  // 開始地点 (0, 0) は必ず通行可能な床
  tiles.set(tileKey(0, 0), {
    x: 0,
    y: 0,
    kind: "floor",
    domain: dominantDomain,
    domainBlend: { ...domainWeights },
    memory: 1,
    bornStep: 0,
    glyph: sampleGlyph(domainWeights, temperature, rng),
    bleedShock: 0,
    motif: null,
  });

  populateVisionTiles(
    tiles,
    0,
    0,
    0,
    0,
    domainWeights,
    dominantDomain,
    bleedEntropy,
    temperature,
    [],
    [],
    rng,
  );

  // 最初の視界内に少なくとも 1〜2 個のモチーフを保証配置（初動の導線）
  let motifCount = 0;
  for (const t of tiles.values()) {
    if (t.motif) motifCount++;
  }
  const ringCandidates = Array.from(tiles.values()).filter(
    (t) => isWalkableTile(t.kind) && t.kind !== "rift" && !t.motif && chebyshev(0, 0, t.x, t.y) >= 2 && chebyshev(0, 0, t.x, t.y) <= 4,
  );
  while (motifCount < 2 && ringCandidates.length > 0) {
    const pickIdx = Math.floor(rng() * ringCandidates.length);
    const chosen = ringCandidates.splice(pickIdx, 1)[0];
    if (hasNearbyMotif(chosen.x, chosen.y, tiles, 2)) continue;
    const spec = pickMotifSpec(domainWeights, [], rng);
    chosen.motif = buildFreshMotif(spec, domainWeights, dominantDomain, temperature, rng);
    motifCount++;
  }

  const openingLine = generateDreamFragment(models, domainWeights, temperature, rng);

  return {
    status: "drifting",
    seed: safeSeed,
    rngTick: 1,
    step: 0,
    depth: 1,
    stepsSinceDescend: 0,
    player: { x: 0, y: 0, facing: "right" },
    temperature,
    rnn,
    domainWeights,
    dominantDomain,
    bleedEntropy,
    placeName,
    tiles,
    anchors: [],
    nextAnchorId: 1,
    stalkers: [],
    nextStalkerId: 1,
    dread: 0,
    consumedCount: 0,
    echoQueue: [],
    echoChain: 0,
    maxGeneration: 0,
    forgottenCount: 0,
    archive: [],
    discoveredMotifs: [],
    whisper: {
      text: openingLine,
      sub: `第1層「${placeName}」— ${DOMAIN_PALETTES[dominantDomain].label}`,
      step: 0,
    },
    lastEvent: { kind: "init", step: 0, x: 0, y: 0, detail: placeName },
  };
}

/** 境界の裂け目（rift）から 1 つ深い夢層へ潜行する。隠れ状態と反響キューは引き継がれる。 */
export function descendDream(state: DreamState): DreamState {
  const { rng, nextTick } = nextStepRng(state.seed, state.rngTick);
  const nextDepth = state.depth + 1;
  const models = getDreamLanguageModels();

  // 潜行ショックを隠れ状態へ注入（別の領域へ滲みやすくする）
  const shock = new Array<number>(8).fill(0).map((_, i) => (i < 6 ? (rng() - 0.42) * 0.95 : (rng() - 0.5) * 0.5));
  const nextRnn = stepRnn(state.rnn, shock, nextDepth, state.temperature);
  const nextWeights = domainProbsFromRnn(nextRnn, state.temperature);
  const nextDom = dominantDomainOf(nextWeights);
  const nextEntropy = normalizedEntropy(DOMAIN_IDS.map((d) => nextWeights[d]));

  // 前の層の未保護・保護タイルはすべて背後に忘却される
  const forgottenHere = state.tiles.size;
  const tiles = new Map<string, DreamTile>();
  tiles.set(tileKey(0, 0), {
    x: 0,
    y: 0,
    kind: "floor",
    domain: nextDom,
    domainBlend: { ...nextWeights },
    memory: 1,
    bornStep: state.step,
    glyph: sampleGlyph(nextWeights, state.temperature, rng),
    bleedShock: 0,
    motif: null,
  });

  populateVisionTiles(
    tiles,
    0,
    0,
    state.step,
    0,
    nextWeights,
    nextDom,
    nextEntropy,
    state.temperature,
    [],
    state.discoveredMotifs,
    rng,
  );

  // 前の層から引き継いだエコーキューがあれば、新しい層の歩数でも早めに出会えるよう dueStep を調整
  const adjustedEchoes = state.echoQueue.map((e, idx) => ({
    ...e,
    dueStep: Math.min(e.dueStep, state.step + 3 + idx * 3),
  }));

  const nextPlaceName = mutateDreamName(
    models,
    nextWeights,
    state.placeName,
    nextDepth,
    state.temperature,
    rng,
  );
  const line = generateDreamFragment(models, nextWeights, state.temperature, rng);
  const baseDread = computeDread(0, 0, nextDepth, [], []);

  return {
    ...state,
    rngTick: nextTick,
    depth: nextDepth,
    stepsSinceDescend: 0,
    player: { x: 0, y: 0, facing: state.player.facing },
    rnn: nextRnn,
    domainWeights: nextWeights,
    dominantDomain: nextDom,
    bleedEntropy: nextEntropy,
    placeName: nextPlaceName,
    tiles,
    anchors: [],
    stalkers: [],
    dread: baseDread,
    echoQueue: adjustedEchoes,
    forgottenCount: state.forgottenCount + forgottenHere,
    whisper: {
      text: line,
      sub: `第${nextDepth}層「${nextPlaceName}」へ潜行（忘却がさらに速まる）`,
      step: state.step,
    },
    lastEvent: {
      kind: "descend",
      step: state.step,
      x: 0,
      y: 0,
      detail: nextPlaceName,
    },
  };
}

/**
 * 残響の影に呑み込まれたときの処理。
 * 終わらない悪夢なので終了画面にはならず、しおりを砕いて一段深い層へ引きずり込まれる。
 */
function consumeByStalker(state: DreamState, stalker: DreamStalker): DreamState {
  const dropped = descendDream(state);
  const { rng, nextTick } = nextStepRng(dropped.seed, dropped.rngTick);
  const models = getDreamLanguageModels();
  const eerieLine = mutateDreamName(
    models,
    dropped.domainWeights,
    stalker.name,
    stalker.generation + 1,
    1.65,
    rng,
  );
  const frag = generateDreamFragment(models, dropped.domainWeights, 1.58, rng);
  return {
    ...dropped,
    rngTick: nextTick,
    temperature: clampTemperature(Math.max(dropped.temperature, 1.38)),
    dread: Math.max(dropped.dread, 0.72),
    consumedCount: state.consumedCount + 1,
    whisper: {
      text: `${eerieLine} …… ${frag}`,
      sub: `影に呑まれ第${dropped.depth}層へ落ちた`,
      step: dropped.step,
    },
    lastEvent: {
      kind: "consumed",
      step: dropped.step,
      x: 0,
      y: 0,
      detail: stalker.name,
      generation: stalker.generation,
    },
  };
}

/** 1 歩移動する。移動 → RNN 更新 → 視界の逐次マルコフ生成 → 変質反復出現 → 忘却。 */
export function moveDream(state: DreamState, dir: DreamDir): DreamState {
  const [dx, dy] = DIR_DELTA[dir];
  const nx = state.player.x + dx;
  const ny = state.player.y + dy;
  const target = state.tiles.get(tileKey(nx, ny));

  if (!target || !isWalkableTile(target.kind)) {
    // 壁・水・書架などにぶつかった場合も向きだけ変えて明確な手応えイベントを返す
    return {
      ...state,
      player: { ...state.player, facing: dir },
      lastEvent: { kind: "blocked", step: state.step, x: nx, y: ny },
    };
  }

  const { rng, nextTick } = nextStepRng(state.seed, state.rngTick);
  const nextStep = state.step + 1;
  const nextSinceDescend = state.stepsSinceDescend + 1;

  // マップの浅いコピー＋タイル本体も更新対象を複製（純粋性を保つ）
  const nextTiles = new Map<string, DreamTile>();
  for (const [k, v] of state.tiles) {
    nextTiles.set(k, { ...v });
  }
  const steppedTile = nextTiles.get(tileKey(nx, ny))!;

  // 1. 小型 LSTM 隠れ状態を 1 ステップ更新
  const walkInput = buildWalkInput(dir, steppedTile, state.bleedEntropy, rng);
  const nextRnn = stepRnn(state.rnn, walkInput, state.depth, state.temperature);
  const nextWeights = domainProbsFromRnn(nextRnn, state.temperature);
  const nextDom = dominantDomainOf(nextWeights);
  const nextEntropy = normalizedEntropy(DOMAIN_IDS.map((d) => nextWeights[d]));

  // 2. 進行方向の新規視界を 2D 条件付きマルコフ場で逐次生成
  populateVisionTiles(
    nextTiles,
    nx,
    ny,
    nextStep,
    nextSinceDescend,
    nextWeights,
    nextDom,
    nextEntropy,
    state.temperature,
    state.anchors,
    state.discoveredMotifs,
    rng,
  );

  // 3. 記憶窓から外れた背後タイルを忘却（evict）＋薄れた記憶の密かな書き換わり
  const forgottenNow = applyForgetting(
    nextTiles,
    nx,
    ny,
    dir,
    nextStep,
    state.depth,
    state.anchors,
    nextWeights,
    nextDom,
    nextEntropy,
    nextSinceDescend,
    state.temperature,
    rng,
  );

  // 4. 反響キューの満期モチーフを変質させて進行方向に出現させる
  const { remaining: nextEchoQueue, manifestedName } = manifestDueEchoes(
    state.echoQueue,
    nextTiles,
    nx,
    ny,
    dir,
    nextStep,
    nextWeights,
    nextDom,
    state.temperature,
    rng,
  );

  // 5. 領域が変わったり一定歩数進んだら、現在地名を文字 n-gram でじわっと変質させる
  const models = getDreamLanguageModels();
  let nextPlaceName = state.placeName;
  let nextWhisper = state.whisper;
  const domainShifted = nextDom !== state.dominantDomain;
  if (domainShifted || nextStep % 14 === 0) {
    nextPlaceName = mutateDreamName(
      models,
      nextWeights,
      state.placeName,
      domainShifted ? 2 : 1,
      state.temperature,
      rng,
    );
    if (domainShifted) {
      nextWhisper = {
        text: generateDreamFragment(models, nextWeights, state.temperature, rng),
        sub: `景色が「${DOMAIN_PALETTES[nextDom].label}」へ滲む — ${nextPlaceName}`,
        step: nextStep,
      };
    }
  } else if (manifestedName) {
    nextWhisper = {
      text: `どこかで見覚えのある気配 — 「${manifestedName}」`,
      sub: "変質した記憶が近くに現れた",
      step: nextStep,
    };
  }

  // 6. 残響の影（Stalker）の背後接近・視線凍結・接触判定
  const stalkRes = advanceStalkers(
    state.stalkers,
    state.nextStalkerId,
    nextTiles,
    state.anchors,
    nx,
    ny,
    dir,
    state.depth,
    nextStep,
    nextWeights,
    nextDom,
    state.temperature,
    state.archive,
    "move",
    rng,
  );
  const nextDread = computeDread(nx, ny, state.depth, stalkRes.stalkers, state.anchors);

  const moved: DreamState = {
    ...state,
    rngTick: nextTick,
    step: nextStep,
    stepsSinceDescend: nextSinceDescend,
    player: { x: nx, y: ny, facing: dir },
    rnn: nextRnn,
    domainWeights: nextWeights,
    dominantDomain: nextDom,
    bleedEntropy: nextEntropy,
    placeName: nextPlaceName,
    tiles: nextTiles,
    stalkers: stalkRes.stalkers,
    nextStalkerId: stalkRes.nextStalkerId,
    dread: nextDread,
    echoQueue: nextEchoQueue,
    forgottenCount: state.forgottenCount + forgottenNow,
    whisper: nextWhisper,
    lastEvent: { kind: "move", step: nextStep, x: nx, y: ny },
  };

  // 7. 残響の影に呑まれた場合：ゲームオーバーではなく一段深い悪夢層へ引きずり込まれる
  if (stalkRes.consumedBy) {
    return consumeByStalker(moved, stalkRes.consumedBy);
  }

  // 8. 踏んだマスが境界の裂け目（rift）ならそのまま深層へ潜行
  if (steppedTile.kind === "rift") {
    return descendDream(moved);
  }

  // 9. 踏んだマスにモチーフがあれば共鳴採集
  if (steppedTile.motif) {
    return collectMotifOnTile(moved, nextTiles, steppedTile, rng, nextTick);
  }

  return moved;
}

/**
 * 記憶パルス（Space / Enter / 足元タップ）。
 * - 隣接 1 マスにモチーフがあれば共鳴採集
 * - 隣接 1 マスに裂け目（rift）があれば潜行
 * - そうでなければ周囲の非アンカー障害物を低温で局所再サンプルして道を開き、
 *   周囲にモチーフが無いときは視界内に 1 つ呼び寄せる（永遠に詰まない保証）。
 */
export function pulseDream(state: DreamState): DreamState {
  const { rng, nextTick } = nextStepRng(state.seed, state.rngTick);
  const { x: px, y: py } = state.player;
  const nextTiles = new Map<string, DreamTile>();
  for (const [k, v] of state.tiles) nextTiles.set(k, { ...v });

  // 1. 周囲 1 マスのモチーフに共鳴
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const t = nextTiles.get(tileKey(px + dx, py + dy));
      if (t?.motif) {
        return collectMotifOnTile(state, nextTiles, t, rng, nextTick);
      }
    }
  }

  // 2. 周囲 1 マスの境界裂け目（rift）へ潜行
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const t = nextTiles.get(tileKey(px + dx, py + dy));
      if (t?.kind === "rift") {
        return descendDream({ ...state, rngTick: nextTick });
      }
    }
  }

  // 3. 周囲の壁・障害物を局所再サンプルして道を拓く（詰まり防止 & 手応え）
  let reshaped = 0;
  const cardinalDirs: readonly [number, number][] = [
    [0, -1],
    [1, 0],
    [0, 1],
    [-1, 0],
  ];
  const blockedCardinals: DreamTile[] = [];
  for (const [dx, dy] of cardinalDirs) {
    const t = nextTiles.get(tileKey(px + dx, py + dy));
    if (t && !isWalkableTile(t.kind)) {
      blockedCardinals.push(t);
    }
  }

  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      if (dx === 0 && dy === 0) continue;
      const t = nextTiles.get(tileKey(px + dx, py + dy));
      if (!t || isWalkableTile(t.kind)) continue;
      if (isProtectedByAnchor(t.x, t.y, state.anchors)) continue;
      const resampled = sampleNextTile(
        state.domainWeights,
        {
          north: nextTiles.get(tileKey(t.x, t.y - 1))?.kind,
          south: nextTiles.get(tileKey(t.x, t.y + 1))?.kind,
          east: nextTiles.get(tileKey(t.x + 1, t.y))?.kind,
          west: nextTiles.get(tileKey(t.x - 1, t.y))?.kind,
          bleedEntropy: state.bleedEntropy,
          stepsSinceDescend: state.stepsSinceDescend,
          hasNearbyRift: true,
        },
        0.52,
        rng,
      );
      if (resampled !== t.kind) {
        t.kind = resampled;
        t.domain = state.dominantDomain;
        t.domainBlend = { ...state.domainWeights };
        t.memory = 1;
        reshaped++;
      }
    }
  }

  // 4近傍が 3 方向以上塞がっていたら、そのうち 1 方向は確実に床へ開く（詰みゼロ保証）
  if (blockedCardinals.length >= 3) {
    const openTarget = blockedCardinals[Math.floor(rng() * blockedCardinals.length)];
    openTarget.kind = "floor";
    openTarget.memory = 1;
    reshaped++;
  }

  // 周囲の視界内にモチーフが 1 つも無ければ、距離 3..5 の床に 1 つ滲み出させる
  let anyVisibleMotif = false;
  for (const t of nextTiles.values()) {
    if (t.motif && chebyshev(px, py, t.x, t.y) <= VIEW_RADIUS) {
      anyVisibleMotif = true;
      break;
    }
  }
  let calledMotifName: string | null = null;
  if (!anyVisibleMotif) {
    const candidates = Array.from(nextTiles.values()).filter(
      (t) =>
        isWalkableTile(t.kind) &&
        t.kind !== "rift" &&
        !t.motif &&
        chebyshev(px, py, t.x, t.y) >= 3 &&
        chebyshev(px, py, t.x, t.y) <= 5,
    );
    if (candidates.length > 0) {
      const target = candidates[Math.floor(rng() * candidates.length)];
      const spec = pickMotifSpec(state.domainWeights, state.discoveredMotifs, rng);
      target.motif = buildFreshMotif(spec, state.domainWeights, state.dominantDomain, state.temperature, rng);
      calledMotifName = target.motif.name;
    }
  }

  // 周囲 4 マス以内の残響の影を波紋で 2 マス押し返す（追い詰められた際の微かな抵抗）
  const nextStalkers = state.stalkers.map((st) => {
    const dist = chebyshev(px, py, st.x, st.y);
    if (dist > 4) return st;
    const dx = Math.sign(st.x - px) || (rng() < 0.5 ? 1 : -1);
    const dy = Math.sign(st.y - py);
    return {
      ...st,
      x: st.x + dx * 2,
      y: st.y + dy * 2,
      stareTicks: 0,
    };
  });
  const nextDread = computeDread(px, py, state.depth, nextStalkers, state.anchors);

  const models = getDreamLanguageModels();
  const fragment = calledMotifName
    ? `遠くで「${calledMotifName}」の輪郭が結ばれた`
    : reshaped > 0
      ? "記憶の波紋が周囲の輪郭を編み直した"
      : generateDreamFragment(models, state.domainWeights, state.temperature, rng);

  return {
    ...state,
    rngTick: nextTick,
    tiles: nextTiles,
    stalkers: nextStalkers,
    dread: nextDread,
    whisper: {
      text: fragment,
      sub: reshaped > 0 ? `周囲の地形 ${reshaped} マスを再想起` : "波紋が静かに広がった",
      step: state.step,
    },
    lastEvent: { kind: "pulse", step: state.step, x: px, y: py, detail: calledMotifName ?? undefined },
  };
}

/**
 * 記憶のしおり（Anchor）を足元に打つ／外す。
 * 最大 3 枠まで保持でき、4 つ目を打つと最も古いしおりが FIFO で忘却されて押し出される。
 */
export function toggleAnchor(state: DreamState): DreamState {
  const { x: px, y: py } = state.player;
  const nextTiles = new Map<string, DreamTile>();
  for (const [k, v] of state.tiles) nextTiles.set(k, { ...v });

  // すでに足元（距離 1 以内）にしおりがあれば外す
  const existingIdx = state.anchors.findIndex((a) => chebyshev(a.x, a.y, px, py) <= 1);
  if (existingIdx >= 0) {
    const removed = state.anchors[existingIdx];
    const nextAnchors = state.anchors.filter((_, i) => i !== existingIdx);
    return {
      ...state,
      tiles: nextTiles,
      anchors: nextAnchors,
      dread: computeDread(px, py, state.depth, state.stalkers, nextAnchors),
      whisper: {
        text: `「${removed.label}」のしおりを外した`,
        sub: "この場所はふたたび忘却へ溶けていく",
        step: state.step,
      },
      lastEvent: { kind: "anchor_remove", step: state.step, x: removed.x, y: removed.y, detail: removed.label },
    };
  }

  const newAnchor: DreamAnchor = {
    id: state.nextAnchorId,
    x: px,
    y: py,
    domain: state.dominantDomain,
    label: state.placeName,
    placedStep: state.step,
  };

  let evicted: DreamAnchor | null = null;
  let nextAnchors = [...state.anchors, newAnchor];
  if (nextAnchors.length > MAX_ANCHORS) {
    evicted = nextAnchors[0];
    nextAnchors = nextAnchors.slice(1);
  }

  // 新しいアンカー保護域の記憶を 1.0 に固定し、結界内に入りかけていた影を外縁へ押し出す
  for (const tile of nextTiles.values()) {
    if (chebyshev(tile.x, tile.y, px, py) <= ANCHOR_RADIUS) {
      tile.memory = 1;
    }
  }
  const pushedStalkers = state.stalkers.map((st) => {
    if (chebyshev(st.x, st.y, px, py) > ANCHOR_RADIUS) return st;
    const dx = Math.sign(st.x - px) || 1;
    const dy = Math.sign(st.y - py);
    return {
      ...st,
      x: px + dx * (ANCHOR_RADIUS + 1),
      y: py + dy * (ANCHOR_RADIUS + 1),
    };
  });

  // FIFO で押し出された最古のしおりが遠くにあれば即座に忘却を開始
  let forgottenNow = 0;
  if (evicted) {
    for (const [key, tile] of nextTiles) {
      if (
        chebyshev(tile.x, tile.y, evicted.x, evicted.y) <= ANCHOR_RADIUS &&
        chebyshev(tile.x, tile.y, px, py) > VIEW_RADIUS &&
        !isProtectedByAnchor(tile.x, tile.y, nextAnchors)
      ) {
        nextTiles.delete(key);
        forgottenNow++;
      }
    }
  }

  return {
    ...state,
    tiles: nextTiles,
    anchors: nextAnchors,
    stalkers: pushedStalkers,
    dread: computeDread(px, py, state.depth, pushedStalkers, nextAnchors),
    nextAnchorId: state.nextAnchorId + 1,
    forgottenCount: state.forgottenCount + forgottenNow,
    whisper: evicted
      ? {
          text: `「${newAnchor.label}」を留め、「${evicted.label}」の記憶が押し出された`,
          sub: `記憶のしおり ${nextAnchors.length}/${MAX_ANCHORS}（最古のしおりを忘却）`,
          step: state.step,
        }
      : {
          text: `「${newAnchor.label}」にしおりを挟んだ`,
          sub: `記憶のしおり ${nextAnchors.length}/${MAX_ANCHORS}（周囲5×5は忘却されない）`,
          step: state.step,
        },
    lastEvent: {
      kind: evicted ? "anchor_evict" : "anchor",
      step: state.step,
      x: px,
      y: py,
      detail: newAnchor.label,
    },
  };
}

/** サンプリング温度 T を変更し、現在隠れ状態からの領域確率分布を再計算する。 */
export function setDreamTemperature(state: DreamState, temperature: number): DreamState {
  const nextTemp = Math.round(clampTemperature(temperature) * 100) / 100;
  const nextWeights = domainProbsFromRnn(state.rnn, nextTemp);
  const nextDom = dominantDomainOf(nextWeights);
  const nextEntropy = normalizedEntropy(DOMAIN_IDS.map((d) => nextWeights[d]));
  return {
    ...state,
    temperature: nextTemp,
    domainWeights: nextWeights,
    dominantDomain: nextDom,
    bleedEntropy: nextEntropy,
    lastEvent: { kind: "temp", step: state.step, x: state.player.x, y: state.player.y },
  };
}

/** 深度・LSTM 経過ステップ・恐怖度 dread から、夢が自然に呼吸し歪むサンプリング温度 T を算出する。 */
export function ambientTemperatureFor(depth: number, rnnSteps: number, dread = 0): number {
  const base = 0.82 + Math.min(0.42, Math.max(0, depth - 1) * 0.08);
  const wave = Math.sin(rnnSteps * 0.16) * 0.22 + Math.cos(rnnSteps * 0.07) * 0.07;
  const fearBoost = Math.max(0, Math.min(1, dread)) * 0.62;
  return Math.round(clampTemperature(base + wave + fearBoost) * 100) / 100;
}

/**
 * リアルタイム自律夢遊ティック（立ち止まっていても夢がうねり・滲み・書き換わり、背後の影も忍び寄る）。
 * - 小型 LSTM を微細な自律波動入力で 1 ステップ揺らし、領域確率分布を連続漂流させる
 * - 非アンカー保護・非プレイヤー足元の周辺タイルを 1〜3 マス局所再サンプルし、空間をリアルタイム変容させる
 * - 視線光錐の外（背中側）にいる残響の影が静かに歩み寄り、光を当てていれば静止する
 * - 高温時や領域移り変わり時に地名・未採集モチーフ名も文字 n-gram で微かに揺らぐ
 * プレイヤーの歩数（step）やアンカー保護域は一切変えない。
 */
export function driftDreamTick(state: DreamState, lookAngle?: number): DreamState {
  const { rng, nextTick } = nextStepRng(state.seed, state.rngTick);
  const { x: px, y: py } = state.player;
  const temp = state.temperature;

  // 1. 隠れ状態へ微かな自律ゆらぎ入力を与え、立ち止まっていても潜在空間が漂い続ける
  const waveScale = 0.14 + Math.max(0, temp - 0.5) * 0.22;
  const phase = state.rnn.steps * 0.37;
  const driftInput = new Array<number>(8);
  for (let i = 0; i < 6; i++) {
    const gentleWave = Math.sin(phase + i * 1.15) * 0.45 + (rng() - 0.48) * 0.9;
    driftInput[i] = gentleWave * waveScale;
  }
  driftInput[6] = (rng() - 0.5) * waveScale * 0.8;
  driftInput[7] = (state.bleedEntropy - 0.5) * 0.25 + (rng() - 0.5) * waveScale;

  const nextRnn = stepRnn(state.rnn, driftInput, state.depth, temp);
  const nextWeights = domainProbsFromRnn(nextRnn, temp);
  const nextDom = dominantDomainOf(nextWeights);
  const nextEntropy = normalizedEntropy(DOMAIN_IDS.map((d) => nextWeights[d]));

  // 2. タイルを浅く複製し、視界内の非アンカー周辺タイルを 1〜3 マス確率再サンプルして空間をうねらせる
  const nextTiles = new Map<string, DreamTile>();
  for (const [k, v] of state.tiles) {
    nextTiles.set(k, { ...v, motif: v.motif ? { ...v.motif } : null });
  }

  const candidates: DreamTile[] = [];
  const motifCandidates: DreamTile[] = [];
  for (const tile of nextTiles.values()) {
    const dist = chebyshev(px, py, tile.x, tile.y);
    if (dist < 2 || dist > VIEW_RADIUS) continue;
    if (isProtectedByAnchor(tile.x, tile.y, state.anchors)) continue;
    if (tile.motif) {
      motifCandidates.push(tile);
      continue;
    }
    if (tile.kind === "rift") continue;
    candidates.push(tile);
  }

  const morphBudget = temp >= 1.3 ? 3 : temp >= 0.78 ? 2 : 1;
  const hasRift = hasNearbyRift(px, py, nextTiles, VIEW_RADIUS);

  for (let m = 0; m < morphBudget && candidates.length > 0; m++) {
    const idx = Math.floor(rng() * candidates.length);
    const target = candidates.splice(idx, 1)[0];
    const shock = computeBoundaryShock(target.x, target.y, nextDom, nextTiles, state.anchors);
    const resampled = sampleNextTile(
      nextWeights,
      {
        north: nextTiles.get(tileKey(target.x, target.y - 1))?.kind,
        south: nextTiles.get(tileKey(target.x, target.y + 1))?.kind,
        east: nextTiles.get(tileKey(target.x + 1, target.y))?.kind,
        west: nextTiles.get(tileKey(target.x - 1, target.y))?.kind,
        boundaryShock: shock,
        bleedEntropy: nextEntropy,
        stepsSinceDescend: state.stepsSinceDescend,
        hasNearbyRift: hasRift || chebyshev(px, py, target.x, target.y) <= 2,
      },
      temp,
      rng,
    );
    target.kind = resampled;
    target.domain = nextDom;
    target.domainBlend = { ...nextWeights };
    target.glyph = sampleGlyph(nextWeights, temp, rng);
    target.bleedShock = shock;
    target.memory = Math.max(0.55, Math.min(1, target.memory));
  }

  // 3. 高温時または領域変遷時、未採集モチーフ名や地名が文字 n-gram でじわっと揺らぐ
  const models = getDreamLanguageModels();
  if (motifCandidates.length > 0 && rng() < Math.max(0.05, (temp - 0.72) * 0.28)) {
    const mt = motifCandidates[Math.floor(rng() * motifCandidates.length)];
    if (mt.motif) {
      mt.motif = {
        ...mt.motif,
        name: mutateDreamName(models, nextWeights, mt.motif.name, mt.motif.generation, temp, rng),
        domain: nextDom,
      };
    }
  }

  const domainShifted = nextDom !== state.dominantDomain;
  let nextPlaceName = state.placeName;
  let nextWhisper = state.whisper;

  if (domainShifted || (temp >= 1.18 && rng() < 0.24)) {
    nextPlaceName = mutateDreamName(
      models,
      nextWeights,
      state.placeName,
      domainShifted ? 2 : 1,
      temp,
      rng,
    );
  }
  if (domainShifted) {
    nextWhisper = {
      text: generateDreamFragment(models, nextWeights, temp, rng),
      sub: `佇むうちに「${DOMAIN_PALETTES[nextDom].label}」へ滲んでいく — ${nextPlaceName}`,
      step: state.step,
    };
  }

  // 4. 立ち止まっている間も、視線光錐の外にいる残響の影が背後から忍び寄る
  const stalkRes = advanceStalkers(
    state.stalkers,
    state.nextStalkerId,
    nextTiles,
    state.anchors,
    px,
    py,
    lookAngle ?? state.player.facing,
    state.depth,
    state.step,
    nextWeights,
    nextDom,
    temp,
    state.archive,
    "drift",
    rng,
  );
  const nextDread = computeDread(px, py, state.depth, stalkRes.stalkers, state.anchors);

  const drifted: DreamState = {
    ...state,
    rngTick: nextTick,
    rnn: nextRnn,
    domainWeights: nextWeights,
    dominantDomain: nextDom,
    bleedEntropy: nextEntropy,
    placeName: nextPlaceName,
    tiles: nextTiles,
    stalkers: stalkRes.stalkers,
    nextStalkerId: stalkRes.nextStalkerId,
    dread: nextDread,
    whisper: nextWhisper,
    lastEvent: { kind: "drift", step: state.step, x: px, y: py },
  };

  if (stalkRes.consumedBy) {
    return consumeByStalker(drifted, stalkRes.consumedBy);
  }

  return drifted;
}

/** 現在の標本帳・記録を保ったまま、別シードの浅い夢へ漂い直す（終了ではなく連続した転寝）。 */
export function redriftDream(state: DreamState, newSeed: number): DreamState {
  const fresh = createDreamGame(newSeed);
  return {
    ...fresh,
    archive: state.archive,
    discoveredMotifs: state.discoveredMotifs,
    maxGeneration: state.maxGeneration,
    forgottenCount: state.forgottenCount + state.tiles.size,
  };
}

/** 視界内にある最も近い変質モチーフまたは裂け目への方向気配を返す（描画コンパス用）。 */
export function findNearestSignal(
  state: DreamState,
): { kind: "reunion" | "rift" | "motif"; dx: number; dy: number; label: string } | null {
  const { x: px, y: py } = state.player;
  let best: { kind: "reunion" | "rift" | "motif"; dx: number; dy: number; dist: number; prio: number; label: string } | null = null;
  for (const t of state.tiles.values()) {
    const dist = Math.hypot(t.x - px, t.y - py);
    if (dist < 0.5) continue;
    if (t.motif && t.motif.generation >= 2) {
      const cand = { kind: "reunion" as const, dx: t.x - px, dy: t.y - py, dist, prio: 3, label: t.motif.name };
      if (!best || cand.prio > best.prio || (cand.prio === best.prio && cand.dist < best.dist)) best = cand;
    } else if (t.kind === "rift") {
      const cand = { kind: "rift" as const, dx: t.x - px, dy: t.y - py, dist, prio: 2, label: "深層への裂け目" };
      if (!best || cand.prio > best.prio || (cand.prio === best.prio && cand.dist < best.dist)) best = cand;
    } else if (t.motif) {
      const cand = { kind: "motif" as const, dx: t.x - px, dy: t.y - py, dist, prio: 1, label: t.motif.name };
      if (!best || cand.prio > best.prio || (cand.prio === best.prio && cand.dist < best.dist)) best = cand;
    }
  }
  return best ? { kind: best.kind, dx: best.dx, dy: best.dy, label: best.label } : null;
}

export type AdjacentContext = {
  motif: TileMotif | null;
  hasRift: boolean;
  hasAnchor: boolean;
};

/** プレイヤー周囲 1 マスの共鳴対象・裂け目・しおり有無を返す（文脈連動 UI 用）。 */
export function getAdjacentContext(state: DreamState): AdjacentContext {
  const { x: px, y: py } = state.player;
  let motif: TileMotif | null = null;
  let hasRift = false;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const t = state.tiles.get(tileKey(px + dx, py + dy));
      if (!t) continue;
      if (!motif && t.motif) motif = t.motif;
      if (t.kind === "rift") hasRift = true;
    }
  }
  const hasAnchor = state.anchors.some((a) => chebyshev(a.x, a.y, px, py) <= 1);
  return { motif, hasRift, hasAnchor };
}

// ============================================================
// 端末内永続記録（緩い指標：最深深度・累計歩数・忘却数・標本）
// ============================================================

export const DREAMING_RECORD_KEY = "ago-dreaming-record";

export type DreamRecord = {
  maxDepth: number;
  totalSteps: number;
  totalForgotten: number;
  maxGeneration: number;
  maxEchoChain: number;
  discoveredMotifs: MotifId[];
  recentArchive: ArchiveEntry[];
};

export function emptyDreamRecord(): DreamRecord {
  return {
    maxDepth: 1,
    totalSteps: 0,
    totalForgotten: 0,
    maxGeneration: 0,
    maxEchoChain: 0,
    discoveredMotifs: [],
    recentArchive: [],
  };
}

const VALID_MOTIF_SET = new Set<string>(DREAM_MOTIFS.map((m) => m.id));
const VALID_DOMAIN_SET = new Set<string>(DOMAIN_IDS);

export function parseDreamRecord(raw: unknown): DreamRecord {
  if (!raw || typeof raw !== "object") return emptyDreamRecord();
  const obj = raw as Record<string, unknown>;
  const num = (v: unknown, min: number) =>
    typeof v === "number" && Number.isFinite(v) && v >= min ? Math.floor(v) : min;

  const discovered: MotifId[] = [];
  if (Array.isArray(obj.discoveredMotifs)) {
    for (const item of obj.discoveredMotifs) {
      if (typeof item === "string" && VALID_MOTIF_SET.has(item) && !discovered.includes(item as MotifId)) {
        discovered.push(item as MotifId);
      }
    }
  }

  const recentArchive: ArchiveEntry[] = [];
  if (Array.isArray(obj.recentArchive)) {
    for (const item of obj.recentArchive.slice(0, MAX_ARCHIVE_ENTRIES)) {
      if (!item || typeof item !== "object") continue;
      const e = item as Record<string, unknown>;
      if (
        typeof e.motifId === "string" &&
        VALID_MOTIF_SET.has(e.motifId) &&
        typeof e.name === "string" &&
        typeof e.fragment === "string" &&
        typeof e.domain === "string" &&
        VALID_DOMAIN_SET.has(e.domain) &&
        typeof e.originDomain === "string" &&
        VALID_DOMAIN_SET.has(e.originDomain)
      ) {
        recentArchive.push({
          motifId: e.motifId as MotifId,
          archetypeLabel: MOTIF_BY_ID[e.motifId as MotifId].archetypeLabel,
          generation: Math.max(1, num(e.generation, 1)),
          name: e.name.slice(0, 32),
          domain: e.domain as DomainId,
          originDomain: e.originDomain as DomainId,
          depth: Math.max(1, num(e.depth, 1)),
          step: num(e.step, 0),
          fragment: e.fragment.slice(0, 64),
        });
      }
    }
  }

  return {
    maxDepth: Math.max(1, num(obj.maxDepth, 1)),
    totalSteps: num(obj.totalSteps, 0),
    totalForgotten: num(obj.totalForgotten, 0),
    maxGeneration: num(obj.maxGeneration, 0),
    maxEchoChain: num(obj.maxEchoChain, 0),
    discoveredMotifs: discovered,
    recentArchive,
  };
}

export function mergeRecordWithSession(
  base: DreamRecord,
  state: DreamState,
  sessionStepDelta: number,
  sessionForgottenDelta: number,
): DreamRecord {
  const discoveredSet = new Set<MotifId>([...base.discoveredMotifs, ...state.discoveredMotifs]);
  // 標本ログは新しい順、同一 (motifId, name, depth) の重複だけ省く
  const seen = new Set<string>();
  const mergedArchive: ArchiveEntry[] = [];
  for (const entry of [...state.archive, ...base.recentArchive]) {
    const sig = `${entry.motifId}:${entry.generation}:${entry.name}:${entry.depth}`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    mergedArchive.push(entry);
    if (mergedArchive.length >= MAX_ARCHIVE_ENTRIES) break;
  }
  return {
    maxDepth: Math.max(base.maxDepth, state.depth),
    totalSteps: base.totalSteps + Math.max(0, sessionStepDelta),
    totalForgotten: base.totalForgotten + Math.max(0, sessionForgottenDelta),
    maxGeneration: Math.max(base.maxGeneration, state.maxGeneration),
    maxEchoChain: Math.max(base.maxEchoChain, state.echoChain),
    discoveredMotifs: Array.from(discoveredSet),
    recentArchive: mergedArchive,
  };
}
