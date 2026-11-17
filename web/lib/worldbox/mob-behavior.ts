// AGO WORLD BOX のモブ行動（純粋ロジック、DOM 非依存）。
// 配置・HP・ダメージは従来どおり決定的配置＋サーバー検証が正で、ここは
// 「どう動くか」の見た目だけを担う: 移動様式（locomotion）、状態機械
// （idle→wander→alert→chase→windup→strike→recover、逃走・帰還）、
// 敵対パターン（予兆つき）とボス級の複合パターン＋怒り状態。
// ダメージの新しい経路は作らない: 突進・跳躍でモブ本体がプレイヤーに
// 接触すれば、既存の接触ダメージ（vitals）が自然に発火する。
// 範囲系パターンも着地/着弾の瞬間に本体がその場へ来るか、本体は動かず
// 見た目だけの投射物にし、接触以外のダメージは発生させない。
import type { MobDef } from "./mobs";

// ---------------------------------------------------------------- locomotion
export type Locomotion = "walk" | "hop" | "flutter" | "swim" | "slither" | "crawl";

/** 全種の移動様式。スプライトは1枚絵のまま、変形と移動の仕方で表現する。 */
export const MOB_LOCOMOTION: Readonly<Record<string, Locomotion>> = {
  mouse: "crawl", chicken: "walk", rabbit: "hop", frog: "hop", crab: "crawl",
  bee: "flutter", slime: "hop", cave_bat: "flutter",
  pig: "walk", sheep: "walk", cow: "walk", deer: "walk", horse: "walk",
  boar: "walk", wolf: "walk", spider: "crawl", skeleton: "walk", ghost: "flutter",
  bear: "walk", golem: "walk",
  treant: "walk", ogre: "walk", dungeon_dragon: "flutter", sea_serpent: "slither",
  spider_queen: "crawl", giant_golem: "walk", giant: "walk",
  ancient_turtle: "swim", world_dragon: "flutter",
  cat: "walk", dog: "walk", duck: "swim", goat: "walk", fox: "walk",
  tanuki: "walk", bird_blue: "flutter", crow: "flutter", owl: "flutter",
  penguin: "walk", butterfly: "flutter", ladybug: "crawl", snail: "crawl",
  fish_blue: "swim", fish_orange: "swim", jellyfish: "swim", octopus: "swim",
  mushroom: "hop", werewolf: "walk",
};

export function locomotionFor(mobId: string): Locomotion {
  return MOB_LOCOMOTION[mobId] ?? "walk";
}

/** locomotion ごとの基本速度係数（カタツムリは個別にさらに遅い）。 */
export const LOCOMOTION_SPEED: Readonly<Record<Locomotion, number>> = {
  walk: 1, hop: 0.9, flutter: 1.15, swim: 0.95, slither: 1.05, crawl: 0.55,
};

/** 種ごとの速度上書き（超低速など）。 */
export const MOB_SPEED_MUL: Readonly<Record<string, number>> = { snail: 0.35 };

/** 描画用の姿勢（純粋関数）: bob（タイル単位の上下）、squashY（縦つぶれ率）、tilt（ラジアン）、sway（タイル単位の横揺れ）。 */
export function locomotionPose(
  loco: Locomotion,
  phase: number,
  moving: boolean,
): { bob: number; squashY: number; tilt: number; sway: number } {
  const s = Math.sin(phase);
  const c = Math.cos(phase);
  if (!moving) {
    // 静止時も呼吸だけはする（ flutter は羽ばたきを止めない）
    if (loco === "flutter") return { bob: 0.05 + 0.03 * s, squashY: 1, tilt: 0.04 * s, sway: 0 };
    if (loco === "swim") return { bob: 0.02 * s, squashY: 1, tilt: 0.03 * s, sway: 0.02 * c };
    return { bob: 0.008 * s, squashY: 1, tilt: 0, sway: 0 };
  }
  switch (loco) {
    case "hop": {
      const jump = Math.abs(Math.sin(phase));
      return { bob: jump * 0.16, squashY: 1 - 0.18 * Math.max(0, 1 - jump * 3), tilt: 0, sway: 0 };
    }
    case "flutter":
      return { bob: 0.10 + 0.06 * s, squashY: 1, tilt: 0.10 * s, sway: 0.03 * c };
    case "swim":
      return { bob: 0.03 * s, squashY: 1, tilt: 0.06 * s, sway: 0.05 * c };
    case "slither":
      return { bob: 0.01, squashY: 1, tilt: 0.05 * s, sway: 0.10 * s };
    case "crawl":
      return { bob: 0.012 * Math.abs(s), squashY: 1 - 0.05 * Math.abs(s), tilt: 0, sway: 0.015 * c };
    default:
      return { bob: Math.abs(s) * 0.045, squashY: 1 - 0.04 * Math.abs(c), tilt: 0.02 * s, sway: 0 };
  }
}

// ---------------------------------------------------------------- patterns
export type MobPatternId =
  | "lunge_bite" | "hop_strike" | "swoop" | "sting_dart" | "bone_throw"
  | "phase_strike" | "web_shot" | "claw_snap" | "charge_line" | "swipe" | "slam"
  | "club_slam" | "roar" | "breath_cone" | "tail_sweep" | "dive_resurface"
  | "leap_strike" | "slam_big" | "shard_burst" | "rock_throw" | "gust" | "dive_charge"
  | "root_strike" | "leaf_burst";

export type TelegraphShape = "circle" | "line" | "cone" | "ring" | "none";

/** dash = strike 中に本体が目標点まで高速移動する（接触ダメージは既存経路）。
 *  projectile/burst = 本体は動かず見た目だけ。teleport = 本体が目標近くへ再出現する。 */
export type PatternKind = "dash" | "projectile" | "burst" | "teleport";

export type PatternDef = {
  windupMs: number; strikeMs: number; recoverMs: number; cooldownMs: number;
  /** 発動できるプレイヤーまでの距離（タイル）。 */
  range: number;
  telegraph: TelegraphShape;
  /** 予兆・効果の半径/長さ（タイル）。 */
  radius: number;
  kind: PatternKind;
};

export const PATTERN_DEF: Readonly<Record<MobPatternId, PatternDef>> = {
  lunge_bite: { windupMs: 420, strikeMs: 260, recoverMs: 650, cooldownMs: 2400, range: 3.4, telegraph: "line", radius: 3.2, kind: "dash" },
  hop_strike: { windupMs: 380, strikeMs: 340, recoverMs: 600, cooldownMs: 2200, range: 3.0, telegraph: "circle", radius: 1.6, kind: "dash" },
  swoop: { windupMs: 400, strikeMs: 300, recoverMs: 700, cooldownMs: 2600, range: 4.2, telegraph: "line", radius: 4.0, kind: "dash" },
  sting_dart: { windupMs: 300, strikeMs: 220, recoverMs: 550, cooldownMs: 2000, range: 3.2, telegraph: "line", radius: 3.0, kind: "dash" },
  bone_throw: { windupMs: 450, strikeMs: 200, recoverMs: 600, cooldownMs: 2600, range: 6.5, telegraph: "none", radius: 0.7, kind: "projectile" },
  phase_strike: { windupMs: 500, strikeMs: 240, recoverMs: 800, cooldownMs: 3400, range: 5.5, telegraph: "circle", radius: 1.4, kind: "teleport" },
  web_shot: { windupMs: 450, strikeMs: 200, recoverMs: 650, cooldownMs: 2800, range: 5.5, telegraph: "none", radius: 1.2, kind: "projectile" },
  claw_snap: { windupMs: 320, strikeMs: 200, recoverMs: 550, cooldownMs: 2000, range: 2.4, telegraph: "line", radius: 2.2, kind: "dash" },
  charge_line: { windupMs: 550, strikeMs: 420, recoverMs: 900, cooldownMs: 3200, range: 5.0, telegraph: "line", radius: 5.2, kind: "dash" },
  swipe: { windupMs: 400, strikeMs: 220, recoverMs: 650, cooldownMs: 2400, range: 2.2, telegraph: "cone", radius: 2.0, kind: "burst" },
  slam: { windupMs: 520, strikeMs: 200, recoverMs: 800, cooldownMs: 3000, range: 2.4, telegraph: "circle", radius: 1.8, kind: "burst" },
  club_slam: { windupMs: 700, strikeMs: 240, recoverMs: 1000, cooldownMs: 3600, range: 3.2, telegraph: "circle", radius: 2.8, kind: "burst" },
  roar: { windupMs: 600, strikeMs: 300, recoverMs: 800, cooldownMs: 6000, range: 6.0, telegraph: "ring", radius: 3.4, kind: "burst" },
  breath_cone: { windupMs: 650, strikeMs: 700, recoverMs: 900, cooldownMs: 4200, range: 6.5, telegraph: "cone", radius: 5.0, kind: "burst" },
  tail_sweep: { windupMs: 550, strikeMs: 260, recoverMs: 850, cooldownMs: 3400, range: 3.4, telegraph: "ring", radius: 3.0, kind: "burst" },
  dive_resurface: { windupMs: 450, strikeMs: 300, recoverMs: 800, cooldownMs: 4000, range: 6.0, telegraph: "circle", radius: 1.8, kind: "teleport" },
  leap_strike: { windupMs: 550, strikeMs: 420, recoverMs: 900, cooldownMs: 3600, range: 5.0, telegraph: "circle", radius: 2.0, kind: "dash" },
  slam_big: { windupMs: 750, strikeMs: 260, recoverMs: 1100, cooldownMs: 4000, range: 3.6, telegraph: "circle", radius: 3.2, kind: "burst" },
  shard_burst: { windupMs: 500, strikeMs: 300, recoverMs: 800, cooldownMs: 3800, range: 6.0, telegraph: "ring", radius: 3.6, kind: "burst" },
  rock_throw: { windupMs: 600, strikeMs: 260, recoverMs: 850, cooldownMs: 3600, range: 7.0, telegraph: "circle", radius: 1.8, kind: "projectile" },
  gust: { windupMs: 550, strikeMs: 400, recoverMs: 800, cooldownMs: 4200, range: 6.0, telegraph: "cone", radius: 4.6, kind: "burst" },
  dive_charge: { windupMs: 650, strikeMs: 480, recoverMs: 1000, cooldownMs: 4600, range: 7.5, telegraph: "line", radius: 7.0, kind: "dash" },
  root_strike: { windupMs: 600, strikeMs: 300, recoverMs: 850, cooldownMs: 3600, range: 5.5, telegraph: "circle", radius: 2.0, kind: "burst" },
  leaf_burst: { windupMs: 450, strikeMs: 300, recoverMs: 700, cooldownMs: 3200, range: 5.5, telegraph: "ring", radius: 3.0, kind: "burst" },
};

/** 種ごとのパターン表。敵対は無条件、中立は provoked（被弾）時にだけ使う。 */
export const MOB_PATTERNS: Readonly<Record<string, readonly MobPatternId[]>> = {
  wolf: ["lunge_bite"],
  werewolf: ["lunge_bite", "swipe"],
  spider: ["web_shot", "lunge_bite"],
  fox: ["lunge_bite"],
  slime: ["hop_strike"],
  cave_bat: ["swoop"],
  bee: ["sting_dart"],
  skeleton: ["bone_throw", "lunge_bite"],
  ghost: ["phase_strike"],
  crab: ["claw_snap"],
  boar: ["charge_line"],
  golem: ["charge_line", "slam"],
  bear: ["swipe", "slam"],
  jellyfish: ["sting_dart"],
  mushroom: ["hop_strike"],
  goat: ["charge_line"],
  octopus: ["swipe"],
  ogre: ["club_slam", "charge_line", "roar"],
  dungeon_dragon: ["breath_cone", "lunge_bite", "tail_sweep"],
  sea_serpent: ["lunge_bite", "tail_sweep", "dive_resurface"],
  spider_queen: ["web_shot", "leap_strike", "lunge_bite"],
  giant_golem: ["slam_big", "charge_line", "shard_burst"],
  giant: ["slam_big", "rock_throw", "charge_line"],
  world_dragon: ["breath_cone", "tail_sweep", "gust", "dive_charge"],
  treant: ["root_strike", "leaf_burst", "slam"],
};

export function patternsFor(def: MobDef): readonly MobPatternId[] {
  return MOB_PATTERNS[def.id] ?? [];
}

/** ボス級: 大型（size>=4）の敵対＋トレント。複数パターンと豪華演出の対象。 */
export function isBossMob(def: MobDef): boolean {
  return def.size >= 4 && (def.temperament === "hostile" || def.id === "treant");
}

/** パターン表の整合チェック（テスト用）。 */
export function validateMobBehavior(mobs: readonly MobDef[]): string[] {
  const errors: string[] = [];
  const ids = new Set(mobs.map((m) => m.id));
  for (const id of Object.keys(MOB_LOCOMOTION)) if (!ids.has(id)) errors.push(`locomotion for unknown mob ${id}`);
  for (const m of mobs) if (!MOB_LOCOMOTION[m.id]) errors.push(`${m.id}: no locomotion`);
  for (const [id, pats] of Object.entries(MOB_PATTERNS)) {
    if (!ids.has(id)) errors.push(`patterns for unknown mob ${id}`);
    for (const p of pats) if (!PATTERN_DEF[p]) errors.push(`${id}: unknown pattern ${p}`);
  }
  for (const m of mobs) {
    const pats = patternsFor(m);
    if (m.temperament === "hostile" && pats.length === 0) errors.push(`${m.id}: hostile without pattern`);
    if (isBossMob(m) && pats.length < 3) errors.push(`${m.id}: boss needs >=3 patterns`);
  }
  return errors;
}

// ---------------------------------------------------------------- state machine
export type MobMode =
  | "idle" | "wander" | "alert" | "chase" | "windup" | "strike" | "recover" | "flee" | "return";

export type MobBehaviorState = {
  mode: MobMode;
  /** このモードが終わる時刻（ms）。 */
  until: number;
  pattern: MobPatternId | null;
  patternIndex: number;
  cooldowns: Record<string, number>;
  /** 現在の移動目標（タイル座標、中心基準）。 */
  tx: number; ty: number;
  /** strike の向き（予兆・投射物用）。 */
  dirX: number; dirY: number;
  enraged: boolean;
  /** 凍結し始めた時刻（ms、行動時計基準）。0 は凍結していない。 */
  frozenSince: number;
};

export function createBehaviorState(x: number, y: number): MobBehaviorState {
  return {
    mode: "idle", until: 0, pattern: null, patternIndex: 0,
    cooldowns: {}, tx: x, ty: y, dirX: 1, dirY: 0, enraged: false, frozenSince: 0,
  };
}

export type BehaviorEvent = {
  kind: "telegraph" | "strike" | "enrage";
  pattern: MobPatternId | null;
  x: number; y: number; dirX: number; dirY: number;
};

export type BehaviorInput = {
  def: MobDef;
  now: number;
  pos: { x: number; y: number };
  anchor: { x: number; y: number };
  player: { x: number; y: number } | null;
  /** 被弾直後などで逃走中か（非敵対用）。 */
  fleeing: boolean;
  /** 中立が挑発されているか（被弾後しばらく true）。 */
  provoked: boolean;
  /** 凍結中か（アイスランス）。true の間は状態機械を進めない。 */
  frozen?: boolean;
  hpFrac: number;
  rng: () => number;
};

export type BehaviorOutput = {
  state: MobBehaviorState;
  target: { x: number; y: number };
  /** タイル/秒。0 は静止。 */
  speed: number;
  teleport: { x: number; y: number } | null;
  events: BehaviorEvent[];
};

export const AGGRO_RANGE = 5;
export const BOSS_AGGRO_RANGE = 7;
export const LEASH_DISTANCE = 11;

function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** 大型ほど遅い（占有が広いぶん圧迫感は速度でなく予兆と演出で出す）。 */
export function sizeSpeedFactor(size: number): number {
  return Math.max(0.4, 1 - Math.max(0, size - 1) * 0.045);
}

export function mobBaseSpeed(def: MobDef): number {
  const loco = LOCOMOTION_SPEED[locomotionFor(def.id)] * (MOB_SPEED_MUL[def.id] ?? 1);
  return loco * sizeSpeedFactor(def.size);
}

export function stepMobBehavior(prev: MobBehaviorState, input: BehaviorInput): BehaviorOutput {
  const { def, now, pos, anchor, player } = input;
  const st: MobBehaviorState = { ...prev, cooldowns: { ...prev.cooldowns } };
  const events: BehaviorEvent[] = [];
  let teleport: { x: number; y: number } | null = null;
  const boss = isBossMob(def);
  const hostileActive = def.temperament === "hostile" || (def.temperament === "neutral" && input.provoked);
  const aggroRange = boss ? BOSS_AGGRO_RANGE : AGGRO_RANGE;
  const distPlayer = player ? dist(pos, player) : Infinity;
  const distAnchor = dist(pos, anchor);

  // 凍結ゲート: 凍結中は追跡・予兆・突進を含む一切の行動を止める。
  // 凍結していた時間は解除時に until / クールダウンへ繰り越すため、
  // 解けた瞬間に予兆や突進が飛ばし読みされることもない。
  if (input.frozen) {
    if (!st.frozenSince) st.frozenSince = now;
    return { state: st, target: pos, speed: 0, teleport: null, events: [] };
  }
  if (st.frozenSince) {
    const shift = Math.max(0, now - st.frozenSince);
    st.frozenSince = 0;
    if (shift > 0) {
      st.until += shift;
      for (const key of Object.keys(st.cooldowns)) st.cooldowns[key] += shift;
    }
  }

  // 怒り（ボス級・HP30%未満）: パターン間隔を縮める
  if (boss && !st.enraged && input.hpFrac < 0.3) {
    st.enraged = true;
    events.push({ kind: "enrage", pattern: null, x: pos.x, y: pos.y, dirX: st.dirX, dirY: st.dirY });
  }
  const cdScale = st.enraged ? 0.6 : 1;

  const out = (target: { x: number; y: number }, speed: number): BehaviorOutput => ({
    state: st, target, speed, teleport, events,
  });
  const base = mobBaseSpeed(def);

  // リーシュ: アンカーから離れすぎたら帰還（strike 中は除く）
  if (st.mode !== "return" && st.mode !== "strike" && distAnchor > LEASH_DISTANCE + def.size) {
    st.mode = "return"; st.pattern = null; st.until = now + 4000;
  }

  switch (st.mode) {
    case "return": {
      if (distAnchor < 1.2 || now > st.until) { st.mode = "idle"; st.until = now + 600; return out(anchor, 0); }
      return out(anchor, base * 1.9);
    }
    case "flee": {
      if (!input.fleeing || !player) { st.mode = "wander"; st.until = now + 500; return out(pos, 0); }
      const dx = pos.x - player.x; const dy = pos.y - player.y;
      const len = Math.hypot(dx, dy) || 1;
      return out({ x: anchor.x + (dx / len) * 2.5, y: anchor.y + (dy / len) * 2.5 }, base * 3.0);
    }
    case "windup": {
      if (now < st.until) return out(pos, 0);
      // strike 開始
      const pat = st.pattern;
      st.mode = "strike";
      st.until = now + (pat ? PATTERN_DEF[pat].strikeMs : 200);
      if (pat) {
        const pd = PATTERN_DEF[pat];
        st.cooldowns[pat] = now + pd.cooldownMs * cdScale;
        events.push({ kind: "strike", pattern: pat, x: pos.x, y: pos.y, dirX: st.dirX, dirY: st.dirY });
        if (pd.kind === "teleport" && player) {
          // プレイヤーの少し手前に再出現（本体が来るので接触判定は正直）
          teleport = { x: player.x - st.dirX * 1.1, y: player.y - st.dirY * 1.1 };
          return out(teleport, 0);
        }
        if (pd.kind === "dash") return out({ x: st.tx, y: st.ty }, base * 7.5);
      }
      return out(pos, 0);
    }
    case "strike": {
      if (now < st.until) {
        const pat = st.pattern;
        if (pat && PATTERN_DEF[pat].kind === "dash") return out({ x: st.tx, y: st.ty }, base * 7.5);
        return out(pos, 0);
      }
      st.mode = "recover";
      st.until = now + (st.pattern ? PATTERN_DEF[st.pattern].recoverMs * cdScale : 500);
      return out(pos, 0);
    }
    case "recover": {
      if (now < st.until) return out(pos, base * 0.25);
      st.pattern = null;
      st.mode = hostileActive && player && distPlayer <= aggroRange + 1.5 ? "chase" : "idle";
      st.until = now + 300;
      return out(pos, 0);
    }
    case "alert": {
      if (now < st.until) return out(pos, 0);
      st.mode = "chase"; st.until = now + 300;
      return out(player ?? pos, base * 2.0);
    }
    case "chase": {
      if (!hostileActive || !player || distPlayer > aggroRange + 2.5) {
        st.mode = "return"; st.until = now + 4000; return out(anchor, base * 1.9);
      }
      // パターン選択: クールダウン明けのものを巡回順に探す
      const pats = patternsFor(def);
      for (let i = 0; i < pats.length; i++) {
        const idx = (st.patternIndex + i) % pats.length;
        const pat = pats[idx];
        const pd = PATTERN_DEF[pat];
        if ((st.cooldowns[pat] ?? 0) > now) continue;
        if (distPlayer > pd.range) continue;
        // skeleton は距離を保つ: 骨投げが使える間は近づかない
        st.pattern = pat;
        st.patternIndex = idx + 1;
        const dx = player.x - pos.x; const dy = player.y - pos.y;
        const len = Math.hypot(dx, dy) || 1;
        st.dirX = dx / len; st.dirY = dy / len;
        st.tx = player.x; st.ty = player.y;
        st.mode = "windup";
        st.until = now + pd.windupMs * cdScale;
        events.push({ kind: "telegraph", pattern: pat, x: pos.x, y: pos.y, dirX: st.dirX, dirY: st.dirY });
        return out(pos, 0);
      }
      // 投射物型しか持たない/クールダウン中は間合いを保つ種（skeleton/ghost系は少し離れる）
      const keepAway = def.id === "skeleton" && distPlayer < 3;
      if (keepAway && player) {
        const dx = pos.x - player.x; const dy = pos.y - player.y;
        const len = Math.hypot(dx, dy) || 1;
        return out({ x: pos.x + dx / len * 2, y: pos.y + dy / len * 2 }, base * 1.6);
      }
      return out(player, base * 2.0);
    }
    default: {
      // idle / wander
      if (input.fleeing && !hostileActive && player) {
        st.mode = "flee";
        const dx = pos.x - player.x; const dy = pos.y - player.y;
        const len = Math.hypot(dx, dy) || 1;
        return out({ x: anchor.x + (dx / len) * 2.5, y: anchor.y + (dy / len) * 2.5 }, base * 3.0);
      }
      if (hostileActive && player && distPlayer <= aggroRange) {
        st.mode = "alert"; st.until = now + (boss ? 450 : 300);
        return out(pos, 0);
      }
      if (now >= st.until) {
        if (st.mode === "idle") {
          st.mode = "wander";
          const ang = input.rng() * Math.PI * 2;
          const rad = input.rng() * 1.3;
          st.tx = anchor.x + Math.cos(ang) * rad;
          st.ty = anchor.y + Math.sin(ang) * rad;
          st.until = now + 2600;
        } else {
          st.mode = "idle";
          st.until = now + 1200 + input.rng() * 1800;
          return out(pos, 0);
        }
      }
      if (st.mode === "wander") return out({ x: st.tx, y: st.ty }, base * 0.95);
      return out(pos, 0);
    }
  }
}
