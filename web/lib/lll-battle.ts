// LLL の 3v3 ターン制バトルエンジン（仕様 §4）。lib/lll-game.ts の
// カードを受け取り、seeded PRNG で決定的に進行する純粋ロジック。
// サーバー（lib/lll-server.ts）がこの状態遷移だけを使って進行し、
// CPU 行動も同じエンジンで実行する（クライアント申告の結果は信用しない）。
//
// 手番の約束:
// - createBattle / applyAction が返す状態は、必ず「プレイヤーの手番」
//   か「終局」。途中の CPU 手番は内部で自動消化する。そのため
//   phase === "battle" の間、currentActor(state).side === "player"。
// - 行動順はラウンド制: 生存者全員が SPD 降順に1回ずつ行動する
//   （同速は seeded PRNG で決定）。
// - ターン開始処理（CD 減算・やけど・再生・防御解除）→ 行動 →
//   ターン終了処理（状態の残りターン減算）の順で進める。

import {
  affinityMultiplier,
  effectiveStats,
  type LllCard,
  type LllElement,
  type LllSkill,
  type LllTier,
  type LllTrait,
} from "./lll-game";
import {
  TACTIC_CARD_BY_ID,
  TACTIC_CHAIN_DEPTH_CAP,
  TACTIC_DRAW_PER_ROUND,
  TACTIC_HAND_LIMIT,
  TACTIC_INITIAL_HAND,
  TACTIC_RESERVE_LIMIT,
  TACTIC_TP_PER_ROUND,
  type TacticCardDef,
  type TacticCond,
  type TacticEffect,
} from "./lll-tactics";

export type BattleStatusKind = "burn" | "stun" | "guard_break" | "overdrive";
export type BattleActor = {
  key: string;
  side: "player" | "cpu";
  cardId: string;
  name: string;
  element: LllElement;
  tier: LllTier;
  level: number;
  glyph?: string;
  imageDataUrl?: string;
  maxHp: number;
  hp: number;
  atk: number;
  def: number;
  spd: number;
  skills: [LllSkill, LllSkill];
  trait: LllTrait;
  cooldowns: [number, number];
  statuses: { kind: BattleStatusKind; turns: number }[];
  shield: number;
  defending: boolean;
  alive: boolean;
  /** 戦術カード A9 の強化（残りターンと倍率）。高密度化でのみ使う。 */
  buffTurns?: number;
  buffMult?: number;
  /** 戦術カード C10 の構え（次の被弾1回で反射する固定値、被弾で消費）。 */
  counterStance?: number;
};

/** 戦術カード層の片側ぶんの状態（手札・山札はカードIDの列）。 */
export type TacticSideState = {
  deck: string[];
  hand: string[];
  discard: string[];
  tp: number;
  /** 設置中のカードID（上限 TACTIC_RESERVE_LIMIT）。 */
  reserves: string[];
  lastPlayedEffects: TacticEffect[] | null;
};
/** 「このターンの出来事」の記録。連鎖条件・プレイ条件の参照先。 */
export type TacticTurnEvents = {
  actorKey: string;
  side: "player" | "cpu";
  dmgCount: number;
  statusesApplied: BattleStatusKind[];
  tagsPlayed: string[];
  cardsPlayed: number;
  tpUsed: string[];
};
/** スタック上の誘発効果（LIFOで解決、深度上限つき）。 */
export type TacticStackItem = {
  depth: number;
  side: "player" | "cpu";
  linkedKey: string;
  attackerKey?: string;
  label: string;
  effects: TacticEffect[];
};
export type TacticsState = {
  player: TacticSideState;
  cpu: TacticSideState;
  turn: TacticTurnEvents;
  stack: TacticStackItem[];
  /** 現在解決中の効果の深度（0 = カード／行動の直接効果）。 */
  effectDepth: number;
};
export type BattleEvent = {
  type: "damage" | "heal" | "shield" | "status" | "death" | "info" | "trait" | "win";
  text: string;
  actorKey?: string;
  targetKey?: string;
  amount?: number;
  /** 表示用メタ（計算には使わない）: このイベント適用直後の対象のHP。クライアントの逐次再生が中間状態を再構成するために使う。 */
  hpAfter?: number;
  /** 表示用メタ: このイベント適用直後の対象のシールド残量。 */
  shieldAfter?: number;
  /** 表示用メタ（damage のみ）: 属性相性倍率（1.25 / 1.0 / 0.8）。 */
  affinity?: number;
  /** 表示用メタ（status の付与イベントのみ）: 付与した状態の種類。 */
  statusKind?: BattleStatusKind;
};
export type BattleState = {
  id: string;
  tierIndex: number;
  round: number;
  actors: BattleActor[];
  queue: string[];
  queuePos: number;
  phase: "battle" | "finished";
  winner?: "player" | "cpu" | "draw";
  log: BattleEvent[];
  seed: number;
  rngState: number;
  turnCount: number;
  /** 高密度化（戦術カード）が有効な対戦でのみ存在する。旧形式の対戦には無い。 */
  tactics?: TacticsState;
};
export type PlayerAction = { skill: 0 | 1 | "basic" | "defend"; targetKey?: string };

/** 通常攻撃の威力（仕様 §4）。 */
const BASIC_POWER = 40;
/** ラウンド上限。到達したら残HP割合で判定する。 */
const MAX_ROUNDS = 30;

/* --- seeded PRNG（状態に rngState を持たせて直列化可能にする） --- */

function nextRandom(state: BattleState): number {
  state.rngState = (state.rngState + 0x6d2b79f5) >>> 0;
  let t = state.rngState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/* --- アクター参照・派生ステータス --- */

function actorByKey(state: BattleState, key: string): BattleActor | undefined {
  return state.actors.find((actor) => actor.key === key);
}

export function currentActor(state: BattleState): BattleActor | null {
  if (state.phase !== "battle") return null;
  const key = state.queue[state.queuePos];
  if (!key) return null;
  return actorByKey(state, key) ?? null;
}

function hasStatus(actor: BattleActor, kind: BattleStatusKind): boolean {
  return actor.statuses.some((status) => status.kind === kind);
}

function addStatus(actor: BattleActor, kind: BattleStatusKind, turns: number): void {
  const existing = actor.statuses.find((status) => status.kind === kind);
  if (existing) existing.turns = Math.max(existing.turns, turns);
  else actor.statuses.push({ kind, turns });
}

/** 特性 haste を含めた行動順用の実効 SPD。 */
function queueSpeed(actor: BattleActor): number {
  return actor.spd * (actor.trait.kind === "haste" ? 1.1 : 1);
}

/** 特性 focus と overdrive、戦術カードの強化を含めた実効 ATK。 */
function effectiveAtk(actor: BattleActor): number {
  let atk = actor.atk;
  if (actor.trait.kind === "focus") atk *= 1.1;
  if (hasStatus(actor, "overdrive")) atk *= 1.3;
  if ((actor.buffTurns ?? 0) > 0) atk *= actor.buffMult ?? 1;
  return atk;
}

/** guard_break 中の実効 DEF。 */
function effectiveDef(actor: BattleActor): number {
  return actor.def * (hasStatus(actor, "guard_break") ? 0.6 : 1);
}

function pushLog(state: BattleState, event: BattleEvent): void {
  state.log.push(event);
}

/* --- 勝敗 --- */

function sideAlive(state: BattleState, side: "player" | "cpu"): boolean {
  return state.actors.some((actor) => actor.side === side && actor.alive);
}

function finishBattle(state: BattleState, winner: "player" | "cpu" | "draw"): void {
  if (state.phase === "finished") return;
  state.phase = "finished";
  state.winner = winner;
  const text = winner === "draw" ? "引き分けで対戦終了。" : winner === "player" ? "敵チームを全滅させた。勝利！" : "自チームが全滅した。敗北。";
  pushLog(state, { type: "win", text });
}

/** 片方の全滅を判定し、終わっていれば終局にする。 */
function checkFinish(state: BattleState): boolean {
  if (state.phase === "finished") return true;
  const playerAlive = sideAlive(state, "player");
  const cpuAlive = sideAlive(state, "cpu");
  if (!playerAlive && !cpuAlive) {
    finishBattle(state, "draw");
    return true;
  }
  if (!cpuAlive) {
    finishBattle(state, "player");
    return true;
  }
  if (!playerAlive) {
    finishBattle(state, "cpu");
    return true;
  }
  return false;
}

/** ラウンド上限到達時: 残HP割合の高い側の勝ち。同率は引き分け。 */
function finishByHpFraction(state: BattleState): void {
  const fraction = (side: "player" | "cpu") => {
    const actors = state.actors.filter((actor) => actor.side === side);
    const max = actors.reduce((sum, actor) => sum + actor.maxHp, 0);
    const hp = actors.reduce((sum, actor) => sum + Math.max(0, actor.hp), 0);
    return max > 0 ? hp / max : 0;
  };
  const player = fraction("player");
  const cpu = fraction("cpu");
  pushLog(state, { type: "info", text: `${MAX_ROUNDS}ラウンド到達。残HP割合で判定する。` });
  finishBattle(state, player > cpu ? "player" : cpu > player ? "cpu" : "draw");
}

/* --- 戦術カード: スタックと誘発（高密度化） ---
   誘発（特性 thorns、 C10 の構え、設置カード）は発生順にスタックへ積み、
   カード1枚／行動1回の解決が終わった時点で LIFO で解決する。
   深度は直接効果を0とし、深度上限を超える誘発は積まない（仕様 §3.6）。 */

function pushTrigger(
  state: BattleState,
  item: Omit<TacticStackItem, "depth"> & { fromDepth: number },
): void {
  const tactics = state.tactics;
  if (!tactics) return;
  const depth = item.fromDepth + 1;
  if (depth > TACTIC_CHAIN_DEPTH_CAP) {
    pushLog(state, { type: "info", text: `連鎖の上限に達したため「${item.label}」は発動しない。` });
    return;
  }
  const { fromDepth: _fromDepth, ...rest } = item;
  tactics.stack.push({ ...rest, depth });
}

/** スタックを上から1件ずつ解決し切る。解決は drainStack の呼び出し元（深度0）でのみ行う。 */
function drainStack(state: BattleState): void {
  const tactics = state.tactics;
  if (!tactics) return;
  let guard = 0;
  while (tactics.stack.length > 0 && guard++ < 200) {
    const item = tactics.stack.pop()!;
    tactics.effectDepth = item.depth;
    pushLog(state, { type: "info", text: `${item.label}が発動。`, actorKey: item.linkedKey, targetKey: item.attackerKey });
    const linked =
      actorByKey(state, item.linkedKey) ??
      state.actors.filter((a) => a.side === item.side && a.alive).sort((a, b) => a.hp - b.hp)[0];
    if (linked) {
      resolveTacticEffects(state, item.effects, {
        side: item.side,
        linked,
        attackerKey: item.attackerKey,
        cardId: undefined,
      });
    }
    tactics.effectDepth = 0;
    if (state.phase === "finished") {
      tactics.stack.length = 0;
      return;
    }
    if (checkFinish(state)) {
      tactics.stack.length = 0;
      return;
    }
  }
}

/** 設置カードのうち trigger が一致するものを消費し、スタックへ積む。 */
function fireReserves(
  state: BattleState,
  ownerSide: "player" | "cpu",
  trigger: "allyDamaged" | "allyDamagedBySkill" | "allyDeath",
  ctx: { attacker: BattleActor; sourcePower?: number; linkedKey: string },
): void {
  const tactics = state.tactics;
  if (!tactics) return;
  const sideState = tactics[ownerSide];
  for (let i = sideState.reserves.length - 1; i >= 0; i--) {
    const cardId = sideState.reserves[i];
    const def = TACTIC_CARD_BY_ID.get(cardId);
    if (!def?.reserve || def.reserve.trigger !== trigger) continue;
    if (trigger === "allyDamagedBySkill" && (ctx.sourcePower ?? 0) < (def.reserve.minPower ?? 55)) continue;
    sideState.reserves.splice(i, 1);
    sideState.discard.push(cardId);
    pushTrigger(state, {
      fromDepth: tactics.effectDepth,
      side: ownerSide,
      linkedKey: ctx.linkedKey,
      attackerKey: ctx.attacker.key,
      label: `設置「${def.name}」`,
      effects: def.reserve.effects.map((effect) =>
        effect.k === "dmgToAttacker" ? { ...effect, targetKey: ctx.attacker.key } : effect,
      ),
    });
  }
}

/* --- ダメージ・回復 --- */

function markDead(state: BattleState, target: BattleActor): void {
  if (target.hp > 0 || !target.alive) return;
  target.hp = 0;
  target.alive = false;
  target.shield = 0;
  target.statuses = [];
  target.defending = false;
  target.counterStance = 0;
  pushLog(state, { type: "death", text: `${target.name}は倒れた。`, targetKey: target.key });
  // 設置 C12（最後の反撃）: 味方の死亡で発動する
  if (state.tactics) {
    const tactics = state.tactics;
    const sideState = tactics[target.side];
    const index = sideState.reserves.findIndex(
      (cardId) => TACTIC_CARD_BY_ID.get(cardId)?.reserve?.trigger === "allyDeath",
    );
    if (index >= 0) {
      const [cardId] = sideState.reserves.splice(index, 1);
      const def = TACTIC_CARD_BY_ID.get(cardId);
      sideState.discard.push(cardId);
      if (def?.reserve) {
        pushTrigger(state, {
          fromDepth: tactics.effectDepth,
          side: target.side,
          linkedKey: target.key,
          label: `設置「${def.name}」`,
          effects: def.reserve.effects,
        });
      }
    }
  }
}

/**
 * ダメージ計算（仕様 §4）:
 * floor(威力 × ATK/(ATK+DEF) × 乱数0.8〜1.2 × 属性倍率 × 防御倍率)、最低1。
 * シールドが先に吸収する。特性 thorns は与ダメの一部を反射する。
 */
function dealDamage(
  state: BattleState,
  attacker: BattleActor,
  target: BattleActor,
  power: number,
  sourcePower?: number,
): number {
  const atk = effectiveAtk(attacker);
  const def = effectiveDef(target);
  const randomFactor = 0.8 + nextRandom(state) * 0.4;
  let damage = Math.floor(
    power *
      (atk / (atk + def)) *
      randomFactor *
      affinityMultiplier(attacker.element, target.element) *
      (target.defending ? 0.5 : 1) *
      (target.trait.kind === "guard" ? 0.9 : 1),
  );
  damage = Math.max(1, damage);
  const affinity = affinityMultiplier(attacker.element, target.element);
  // 設置 C4（庇う盾）はダメージ確定前に割り込む唯一の例外（仕様 §3.7）。
  // スタック解決中の反射など間接ダメージには割り込まない。
  const tactics = state.tactics;
  if (tactics && tactics.effectDepth === 0) {
    const defender = tactics[target.side];
    const index = defender.reserves.findIndex(
      (cardId) => TACTIC_CARD_BY_ID.get(cardId)?.reserve?.trigger === "allyDamagedReduce",
    );
    if (index >= 0) {
      const [cardId] = defender.reserves.splice(index, 1);
      const reserveDef = TACTIC_CARD_BY_ID.get(cardId);
      defender.discard.push(cardId);
      const reduced = Math.min(reserveDef?.reserve?.amount ?? 0, damage);
      damage -= reduced;
      pushLog(state, {
        type: "info",
        text: `設置「${reserveDef?.name ?? cardId}」が ${target.name}へのダメージを ${reduced} 軽減。`,
        targetKey: target.key,
      });
      if (damage <= 0) return 0;
    }
  }
  const absorbed = Math.min(target.shield, damage);
  if (absorbed > 0) {
    target.shield -= absorbed;
    pushLog(state, { type: "shield", text: `${target.name}のシールドが ${absorbed} を吸収。`, actorKey: attacker.key, targetKey: target.key, amount: absorbed, shieldAfter: target.shield });
  }
  const dealt = damage - absorbed;
  target.hp -= dealt;
  pushLog(state, {
    type: "damage",
    text: `${attacker.name}の攻撃。${target.name}に ${dealt} ダメージ。`,
    actorKey: attacker.key,
    targetKey: target.key,
    amount: dealt,
    hpAfter: Math.max(0, target.hp),
    affinity,
  });
  // 「このターンの出来事」への記録（直接効果による与ダメージのみ数える）
  if (tactics && tactics.effectDepth === 0 && attacker.side === tactics.turn.side && dealt > 0) {
    tactics.turn.dmgCount += 1;
  }
  markDead(state, target);
  if (tactics) {
    // 高密度化では誘発をスタックに積む（仕様 §3.6）
    if (dealt > 0 && target.alive && attacker.alive) {
      if (target.trait.kind === "thorns") {
        pushTrigger(state, {
          fromDepth: tactics.effectDepth,
          side: target.side,
          linkedKey: target.key,
          attackerKey: attacker.key,
          label: `${target.name}の特性「${target.trait.name}」`,
          effects: [{ k: "dmgDirect", power: Math.max(1, Math.floor(dealt * 0.2)) }],
        });
      }
      if ((target.counterStance ?? 0) > 0) {
        const amount = target.counterStance ?? 0;
        target.counterStance = 0; // 構えは次の被弾1回で消費される
        pushTrigger(state, {
          fromDepth: tactics.effectDepth,
          side: target.side,
          linkedKey: target.key,
          attackerKey: attacker.key,
          label: `${target.name}の反撃準備`,
          effects: [{ k: "dmgDirect", power: amount }],
        });
      }
      fireReserves(state, target.side, "allyDamaged", { attacker, sourcePower, linkedKey: target.key });
      fireReserves(state, target.side, "allyDamagedBySkill", { attacker, sourcePower, linkedKey: target.key });
    }
    return dealt;
  }
  // 特性 thorns: 生き残った被弾者が与ダメの20%を返す
  if (dealt > 0 && target.alive && target.trait.kind === "thorns" && attacker.alive) {
    const reflected = Math.max(1, Math.floor(dealt * 0.2));
    attacker.hp -= reflected;
    pushLog(state, { type: "trait", text: `${target.name}の特性で ${attacker.name}に ${reflected} 反射。`, actorKey: target.key, targetKey: attacker.key, amount: reflected, hpAfter: Math.max(0, attacker.hp) });
    markDead(state, attacker);
  }
  return dealt;
}

function healActor(state: BattleState, source: BattleActor, target: BattleActor, amount: number): number {
  const healed = Math.max(0, Math.min(amount, target.maxHp - target.hp));
  target.hp += healed;
  pushLog(state, { type: "heal", text: `${target.name}のHPが ${healed} 回復。`, actorKey: source.key, targetKey: target.key, amount: healed, hpAfter: target.hp });
  return healed;
}

/* --- 行動の実行 --- */

const OFFENSIVE_KINDS = new Set(["damage", "burn", "stun", "guard_break", "drain"]);

function defaultEnemyTarget(state: BattleState, actor: BattleActor): BattleActor | undefined {
  return state.actors
    .filter((candidate) => candidate.side !== actor.side && candidate.alive)
    .sort((a, b) => a.hp - b.hp || a.key.localeCompare(b.key))[0];
}

function defaultAllyTarget(state: BattleState, actor: BattleActor): BattleActor {
  return (
    state.actors
      .filter((candidate) => candidate.side === actor.side && candidate.alive)
      .sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp || a.key.localeCompare(b.key))[0] ?? actor
  );
}

function resolveTarget(state: BattleState, actor: BattleActor, targetKey: string | undefined, side: "ally" | "enemy"): BattleActor {
  if (targetKey) {
    const target = actorByKey(state, targetKey);
    if (!target || !target.alive) throw new Error("対象が見つかりません。");
    if (side === "enemy" && target.side === actor.side) throw new Error("敵を対象にしてください。");
    if (side === "ally" && target.side !== actor.side) throw new Error("味方を対象にしてください。");
    return target;
  }
  const fallback = side === "enemy" ? defaultEnemyTarget(state, actor) : defaultAllyTarget(state, actor);
  if (!fallback) throw new Error("対象が見つかりません。");
  return fallback;
}

/** 1回の行動（技・通常攻撃・防御）を実行する。手番の進行はしない。 */
function executeAction(state: BattleState, actor: BattleActor, action: PlayerAction): void {
  if (action.skill === "defend") {
    actor.defending = true;
    pushLog(state, { type: "info", text: `${actor.name}は防御した。次の自分のターンまで被ダメージ半減。`, actorKey: actor.key });
    return;
  }
  if (action.skill === "basic") {
    const target = resolveTarget(state, actor, action.targetKey, "enemy");
    pushLog(state, { type: "info", text: `${actor.name}の通常攻撃。`, actorKey: actor.key, targetKey: target.key });
    dealDamage(state, actor, target, BASIC_POWER, BASIC_POWER);
    if (state.tactics) drainStack(state);
    return;
  }
  const skill = actor.skills[action.skill];
  if (!skill) throw new Error("技が見つかりません。");
  if (actor.cooldowns[action.skill] > 0) throw new Error("この技はクールダウン中です。");
  actor.cooldowns[action.skill] = skill.cooldown;

  if (skill.kind === "heal") {
    const target = resolveTarget(state, actor, action.targetKey, "ally");
    const atk = effectiveAtk(actor);
    const amount = Math.max(1, Math.floor(skill.power * (atk / (atk + effectiveDef(target))) * (0.8 + nextRandom(state) * 0.4)));
    pushLog(state, { type: "info", text: `${actor.name}の「${skill.name}」。`, actorKey: actor.key, targetKey: target.key });
    healActor(state, actor, target, amount);
    return;
  }
  if (skill.kind === "shield") {
    const target = resolveTarget(state, actor, action.targetKey, "ally");
    target.shield += skill.power;
    pushLog(state, { type: "shield", text: `${actor.name}の「${skill.name}」。${target.name}にシールド ${skill.power}。`, actorKey: actor.key, targetKey: target.key, amount: skill.power, shieldAfter: target.shield });
    return;
  }
  if (skill.kind === "overdrive") {
    // 自分への強化技。対象指定（クライアントの敵タップ等）は無視して自分に付与する
    addStatus(actor, "overdrive", 2);
    pushLog(state, { type: "status", text: `${actor.name}の「${skill.name}」。攻撃力が上がった。`, actorKey: actor.key, targetKey: actor.key, statusKind: "overdrive" });
    return;
  }
  // 攻撃系（damage / burn / stun / guard_break / drain）
  const target = resolveTarget(state, actor, action.targetKey, "enemy");
  pushLog(state, { type: "info", text: `${actor.name}の「${skill.name}」。`, actorKey: actor.key, targetKey: target.key });
  const dealt = dealDamage(state, actor, target, skill.power, skill.power);
  if (target.alive) {
    if (skill.kind === "burn") {
      addStatus(target, "burn", 2);
      pushLog(state, { type: "status", text: `${target.name}はやけどを負った。`, actorKey: actor.key, targetKey: target.key, statusKind: "burn" });
    } else if (skill.kind === "stun") {
      addStatus(target, "stun", 1);
      pushLog(state, { type: "status", text: `${target.name}はスタンした。`, actorKey: actor.key, targetKey: target.key, statusKind: "stun" });
    } else if (skill.kind === "guard_break") {
      addStatus(target, "guard_break", 2);
      pushLog(state, { type: "status", text: `${target.name}の防御が崩れた。`, actorKey: actor.key, targetKey: target.key, statusKind: "guard_break" });
    }
  }
  if (skill.kind === "drain" && dealt > 0 && actor.alive) {
    healActor(state, actor, actor, Math.floor(dealt / 2));
  }
  if (state.tactics) drainStack(state);
}

/* --- 戦術カード: 条件・効果の解決とプレイ --- */

type TacticCtx = {
  side: "player" | "cpu";
  linked: BattleActor;
  attackerKey?: string;
  cardId?: string;
};

function tacticSide(state: BattleState, side: "player" | "cpu"): TacticSideState {
  return state.tactics![side];
}

function lowestEnemyOf(state: BattleState, side: "player" | "cpu"): BattleActor | undefined {
  return state.actors
    .filter((a) => a.side !== side && a.alive)
    .sort((a, b) => a.hp - b.hp || a.key.localeCompare(b.key))[0];
}

function lowestAllyOf(state: BattleState, side: "player" | "cpu"): BattleActor | undefined {
  return state.actors
    .filter((a) => a.side === side && a.alive)
    .sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp || a.key.localeCompare(b.key))[0];
}

function drawTacticCards(state: BattleState, side: "player" | "cpu", count: number): void {
  const tactics = state.tactics;
  if (!tactics) return;
  const sideState = tactics[side];
  for (let i = 0; i < count; i++) {
    if (sideState.deck.length === 0) {
      if (sideState.discard.length === 0) return;
      // 山札が尽きたら捨札をシャッフルして戻す（疲労ペナルティは無い）
      const shuffled = [...sideState.discard];
      for (let j = shuffled.length - 1; j > 0; j--) {
        const k = Math.floor(nextRandom(state) * (j + 1));
        [shuffled[j], shuffled[k]] = [shuffled[k], shuffled[j]];
      }
      sideState.deck = shuffled;
      sideState.discard = [];
    }
    sideState.hand.push(sideState.deck.pop()!);
  }
  while (sideState.hand.length > TACTIC_HAND_LIMIT) {
    sideState.discard.push(sideState.hand.pop()!);
  }
}

/** 連鎖条件・プレイ条件の評価。 */
export function evalTacticCond(state: BattleState, side: "player" | "cpu", cond: TacticCond): boolean {
  const tactics = state.tactics;
  if (!tactics) return false;
  const sideState = tactics[side];
  const turn = tactics.turn;
  switch (cond.k) {
    case "dmgThisTurn": return turn.side === side && turn.dmgCount >= cond.n;
    case "cardsThisTurn": return turn.side === side && turn.cardsPlayed >= cond.n;
    case "statusThisTurn": return turn.side === side && turn.statusesApplied.includes(cond.status);
    case "tagThisTurn": return turn.side === side && turn.tagsPlayed.includes(cond.tag);
    case "discardAtLeast": return sideState.discard.length >= cond.n;
    case "handAtLeast": return sideState.hand.length >= cond.n;
    case "enemyAnyStatus":
      return state.actors.some((a) => a.side !== side && a.alive && a.statuses.length > 0);
    default: return false;
  }
}

/** 戦術カードを今プレイできるか（コスト・設置枠・プレイ条件）。 */
export function canPlayTactic(state: BattleState, side: "player" | "cpu", cardId: string): boolean {
  const tactics = state.tactics;
  const def = TACTIC_CARD_BY_ID.get(cardId);
  if (!tactics || !def) return false;
  const sideState = tactics[side];
  if (!sideState.hand.includes(cardId)) return false;
  if (sideState.tp < def.cost) return false;
  if (def.reserve && sideState.reserves.length >= TACTIC_RESERVE_LIMIT) return false;
  if (def.requires && !evalTacticCond(state, side, def.requires)) return false;
  return true;
}

function pickTacticTarget(state: BattleState, ctx: TacticCtx, effect: TacticEffect): BattleActor | undefined {
  const targetKind: string | undefined =
    effect.k === "dmg" ? effect.target : effect.k === "status" ? effect.target : undefined;
  if (targetKind === "enemyStatused") {
    return (
      state.actors
        .filter((a) => a.side !== ctx.side && a.alive && a.statuses.length > 0)
        .sort((a, b) => a.hp - b.hp || a.key.localeCompare(b.key))[0] ?? lowestEnemyOf(state, ctx.side)
    );
  }
  if (targetKind === "linked") return ctx.linked;
  if (targetKind === "allyLowest") return lowestAllyOf(state, ctx.side);
  return lowestEnemyOf(state, ctx.side);
}

function resolveTacticEffects(state: BattleState, effects: TacticEffect[], ctx: TacticCtx): void {
  for (const effect of effects) {
    if (state.phase === "finished") return;
    resolveTacticEffect(state, effect, ctx);
  }
}

function resolveTacticEffect(state: BattleState, effect: TacticEffect, ctx: TacticCtx): void {
  const tactics = state.tactics;
  if (!tactics) return;
  const sideState = tactics[ctx.side];
  const linked = ctx.linked;
  switch (effect.k) {
    case "dmg": {
      const target = pickTacticTarget(state, ctx, effect);
      if (target && target.alive) {
        const dealt = dealDamage(state, linked, target, effect.power, effect.power);
        if (dealt > 0 && !target.alive && effect.onKill) {
          resolveTacticEffects(state, effect.onKill, ctx);
        }
      }
      break;
    }
    case "dmgAll": {
      for (const target of state.actors.filter((a) => a.side !== ctx.side && a.alive)) {
        dealDamage(state, linked, target, effect.power, effect.power);
        if (state.phase === "finished") return;
      }
      break;
    }
    case "dmgEcho": {
      const target = lowestEnemyOf(state, ctx.side);
      if (target) {
        const power = Math.min(effect.cap, effect.base + effect.per * sideState.discard.length);
        dealDamage(state, linked, target, power, power);
      }
      break;
    }
    case "dmgWounded": {
      const target = lowestEnemyOf(state, ctx.side);
      if (target) {
        const wounded = state.actors.some((a) => a.side === ctx.side && a.alive && a.hp / a.maxHp < effect.pct);
        const power = wounded ? effect.wounded : effect.normal;
        dealDamage(state, linked, target, power, power);
      }
      break;
    }
    case "dmgPerStatus": {
      const target = lowestEnemyOf(state, ctx.side);
      if (target) {
        const power = Math.min(effect.cap, effect.base + effect.per * target.statuses.length);
        dealDamage(state, linked, target, power, power);
      }
      break;
    }
    case "dmgExecute": {
      const target = lowestEnemyOf(state, ctx.side);
      if (target) {
        const power = effect.power + (target.hp / target.maxHp < effect.pct ? effect.bonus : 0);
        dealDamage(state, linked, target, power, power);
      }
      break;
    }
    case "dmgIfStatus": {
      const target = lowestEnemyOf(state, ctx.side);
      if (target) {
        if (hasStatus(target, effect.status)) {
          dealDamage(state, linked, target, effect.power, effect.power);
        } else {
          addStatus(target, effect.elseStatus, 2);
          pushLog(state, { type: "status", text: `${target.name}は${effect.elseStatus === "burn" ? "やけどを負った" : "状態異常を負った"}。`, actorKey: linked.key, targetKey: target.key, statusKind: effect.elseStatus });
          if (tactics.turn.side === ctx.side) tactics.turn.statusesApplied.push(effect.elseStatus);
        }
      }
      break;
    }
    case "dmgToAttacker": {
      const target = actorByKey(state, effect.targetKey ?? ctx.attackerKey ?? "");
      if (target && target.alive && linked.alive) {
        dealDamage(state, linked, target, effect.power, effect.power);
      }
      break;
    }
    case "dmgDirect": {
      // 反射などの固定ダメージ。式を通さず、防御・シールドも無視する
      const target = actorByKey(state, ctx.attackerKey ?? "");
      if (target && target.alive) {
        target.hp -= effect.power;
        pushLog(state, { type: "trait", text: `${target.name}に ${effect.power} の反射ダメージ。`, actorKey: linked.key, targetKey: target.key, amount: effect.power, hpAfter: Math.max(0, target.hp) });
        markDead(state, target);
      }
      break;
    }
    case "extraAttack": {
      const target = lowestEnemyOf(state, ctx.side);
      if (target && linked.alive) {
        pushLog(state, { type: "info", text: `${linked.name}の追加攻撃。`, actorKey: linked.key, targetKey: target.key });
        const dealt = dealDamage(state, linked, target, effect.power, effect.power);
        if (dealt > 0 && !target.alive && effect.killDraw > 0) drawTacticCards(state, ctx.side, effect.killDraw);
      }
      break;
    }
    case "echoLast": {
      const last = sideState.lastPlayedEffects;
      if (!last) {
        drawTacticCards(state, ctx.side, 1);
        break;
      }
      const halved = last
        .filter((e) => e.k === "dmg" || e.k === "dmgAll" || e.k === "status")
        .map((e) => (e.k === "status" ? e : { ...e, power: Math.max(1, Math.floor((e as { power: number }).power / 2)) }));
      if (halved.length === 0) drawTacticCards(state, ctx.side, 1);
      else resolveTacticEffects(state, halved as TacticEffect[], ctx);
      break;
    }
    case "draw": drawTacticCards(state, ctx.side, effect.n); break;
    case "drawEcho":
      drawTacticCards(state, ctx.side, effect.base + (sideState.discard.length >= effect.bonusAt ? effect.bonus : 0));
      break;
    case "discardRandom": {
      for (let i = 0; i < effect.n && sideState.hand.length > 0; i++) {
        const index = Math.floor(nextRandom(state) * sideState.hand.length);
        sideState.discard.push(sideState.hand.splice(index, 1)[0]);
      }
      break;
    }
    case "tp": {
      // TP獲得は同一カード名につき1ターン1回まで（キル報酬などの exempt は対象外）
      if (!effect.exemptTpLimit) {
        if (ctx.cardId && tactics.turn.tpUsed.includes(ctx.cardId)) {
          pushLog(state, { type: "info", text: `TP獲得は同じカード名では1ターンに1回まで。`, actorKey: linked.key });
          break;
        }
        if (ctx.cardId) tactics.turn.tpUsed.push(ctx.cardId);
      }
      sideState.tp += effect.n;
      pushLog(state, { type: "info", text: `TPが ${effect.n} 増えた（残り ${sideState.tp}）。`, actorKey: linked.key });
      break;
    }
    case "status": {
      const target = pickTacticTarget(state, ctx, effect);
      if (target && target.alive) {
        addStatus(target, effect.status, effect.status === "stun" ? 1 : 2);
        pushLog(state, {
          type: "status",
          text: `${target.name}に${effect.status === "burn" ? "やけど" : effect.status === "stun" ? "スタン" : effect.status === "guard_break" ? "防御崩し" : "攻撃上昇"}を付与。`,
          actorKey: linked.key, targetKey: target.key, statusKind: effect.status,
        });
        if (tactics.turn.side === ctx.side) tactics.turn.statusesApplied.push(effect.status);
      }
      break;
    }
    case "shield": {
      const target = effect.target === "allyLowest" ? lowestAllyOf(state, ctx.side) : effect.target === "linked" ? linked : lowestAllyOf(state, ctx.side);
      if (target && target.alive) {
        target.shield += effect.n;
        pushLog(state, { type: "shield", text: `${target.name}にシールド ${effect.n}。`, actorKey: linked.key, targetKey: target.key, amount: effect.n, shieldAfter: target.shield });
      }
      break;
    }
    case "shieldEcho": {
      const target = lowestAllyOf(state, ctx.side);
      if (target && target.alive) {
        const amount = Math.min(effect.cap, effect.base + effect.per * sideState.discard.length);
        target.shield += amount;
        pushLog(state, { type: "shield", text: `${target.name}にシールド ${amount}。`, actorKey: linked.key, targetKey: target.key, amount, shieldAfter: target.shield });
      }
      break;
    }
    case "heal": {
      const target = lowestAllyOf(state, ctx.side);
      if (target && target.alive) {
        const atk = effectiveAtk(linked);
        const amount = Math.max(1, Math.floor(effect.power * (atk / (atk + effectiveDef(target))) * (0.8 + nextRandom(state) * 0.4)));
        healActor(state, linked, target, amount);
      }
      break;
    }
    case "buff": {
      linked.buffMult = effect.mult;
      linked.buffTurns = Math.max(linked.buffTurns ?? 0, effect.turns);
      pushLog(state, { type: "info", text: `${linked.name}の攻撃力が上がった（×${effect.mult}、${effect.turns}ターン）。`, actorKey: linked.key, targetKey: linked.key });
      break;
    }
    case "stance": {
      linked.counterStance = Math.max(linked.counterStance ?? 0, effect.reflect);
      pushLog(state, { type: "info", text: `${linked.name}は反撃の構えを取った。`, actorKey: linked.key, targetKey: linked.key });
      break;
    }
    case "recall": {
      const index = sideState.discard.findIndex((cardId) => cardId !== ctx.cardId);
      if (index >= 0) {
        const [cardId] = sideState.discard.splice(index, 1);
        sideState.hand.push(cardId);
        pushLog(state, { type: "info", text: `捨札から「${TACTIC_CARD_BY_ID.get(cardId)?.name ?? cardId}」を手札に戻した。`, actorKey: linked.key });
      }
      break;
    }
    default: break;
  }
}

/** 戦術カード1枚のプレイを解決する（検証は呼び出し側）。手番は進めない。 */
function playTacticCard(state: BattleState, side: "player" | "cpu", linked: BattleActor, cardId: string): void {
  const tactics = state.tactics;
  const def = TACTIC_CARD_BY_ID.get(cardId);
  if (!tactics || !def) return;
  const sideState = tactics[side];
  const handIndex = sideState.hand.indexOf(cardId);
  if (handIndex < 0) return;
  sideState.hand.splice(handIndex, 1);
  sideState.tp -= def.cost;
  tactics.turn.cardsPlayed += 1;
  tactics.turn.tagsPlayed.push(...def.tags);
  pushLog(state, { type: "info", text: `${linked.name}は戦術カード「${def.name}」を使った。`, actorKey: linked.key });
  if (def.reserve) {
    sideState.reserves.push(cardId);
    pushLog(state, { type: "info", text: `「${def.name}」を設置した。`, actorKey: linked.key });
    return;
  }
  const ctx: TacticCtx = { side, linked, cardId };
  resolveTacticEffects(state, def.effects, ctx);
  if (def.chain && state.phase === "battle" && evalTacticCond(state, side, def.chain.cond)) {
    pushLog(state, { type: "info", text: `「${def.name}」の連鎖効果。`, actorKey: linked.key });
    resolveTacticEffects(state, def.chain.effects, ctx);
  }
  sideState.lastPlayedEffects = def.effects;
  sideState.discard.push(cardId);
  drainStack(state);
}

/**
 * プレイヤーの戦術カードプレイを適用する。現在の手番アクターの
 * 戦術フェイズとして解決し、手番自体は進めない（行動は applyAction）。
 * 使用アクターが解決中に倒れた場合は、その手番を終えて次へ進める。
 */
export function applyTacticPlay(state: BattleState, cardId: string): BattleState {
  if (state.phase !== "battle") throw new Error("この対戦は終了しています。");
  if (!state.tactics) throw new Error("この対戦では戦術カードは使えません。");
  const actor = currentActor(state);
  if (!actor) throw new Error("行動できるアクターがいません。");
  if (actor.side !== "player") throw new Error("いまはプレイヤーの手番ではありません。");
  const def = TACTIC_CARD_BY_ID.get(cardId);
  if (!def) throw new Error("戦術カードが見つかりません。");
  const sideState = state.tactics.player;
  if (!sideState.hand.includes(cardId)) throw new Error("そのカードは手札にありません。");
  if (sideState.tp < def.cost) throw new Error("TPが足りません。");
  if (def.reserve && sideState.reserves.length >= TACTIC_RESERVE_LIMIT) throw new Error("設置は2枚までです。");
  if (def.requires && !evalTacticCond(state, "player", def.requires)) {
    throw new Error("このカードは今は使えません（条件を満たしていません）。");
  }
  playTacticCard(state, "player", actor, cardId);
  if (!actor.alive && state.phase === "battle") {
    // 使用アクターが反撃などで倒れたら手番を終える
    state.turnCount += 1;
    state.queuePos += 1;
    advanceToPlayerTurn(state);
  } else {
    checkFinish(state);
  }
  return state;
}

/* --- 戦術フェイズの CPU ポリシー（プロトタイプ検証時の方策を移植） --- */

function cpuTacticScore(state: BattleState, side: "player" | "cpu", def: TacticCardDef): number {
  const tactics = state.tactics!;
  const sideState = tactics[side];
  const allies = state.actors.filter((a) => a.side === side && a.alive);
  const enemies = state.actors.filter((a) => a.side !== side && a.alive);
  const hasKind = (kind: TacticEffect["k"]) => def.effects.some((e) => e.k === kind);
  if (def.reserve) return sideState.reserves.length === 0 && state.round <= 5 ? 50 : 12;
  if (hasKind("draw") && sideState.hand.length <= 3) return 46;
  if (def.cost === 0) return 44;
  if (hasKind("tp") && sideState.tp <= 1) return 40;
  if (hasKind("heal")) return allies.some((a) => a.hp / a.maxHp < 0.6) ? 38 : 8;
  if (hasKind("shield") || hasKind("shieldEcho")) return allies.some((a) => a.hp / a.maxHp < 0.5) ? 36 : 14;
  if (hasKind("status")) return enemies.some((e) => e.statuses.length === 0) ? 35 : 26;
  if (hasKind("buff")) return 33;
  if (hasKind("dmgExecute")) {
    const target = lowestEnemyOf(state, side);
    return target && target.hp / target.maxHp < 0.5 ? 37 : 28;
  }
  if (def.effects.some((e) => ["dmg", "dmgAll", "dmgEcho", "dmgWounded", "dmgPerStatus", "extraAttack", "dmgIfStatus"].includes(e.k))) return 30;
  if (hasKind("recall") || hasKind("echoLast")) return sideState.discard.length >= 3 ? 27 : 15;
  if (hasKind("stance")) return 29;
  return 20;
}

/** CPU（およびシミュレーション用ポリシー）が戦術フェイズにカードを切る。 */
export function cpuPlayTactics(state: BattleState, actor: BattleActor): void {
  if (!state.tactics || state.phase !== "battle") return;
  const sideState = state.tactics[actor.side];
  let guard = 0;
  while (guard++ < 20 && state.phase === "battle" && actor.alive) {
    let best: { cardId: string; score: number } | null = null;
    for (const cardId of new Set(sideState.hand)) {
      const def = TACTIC_CARD_BY_ID.get(cardId);
      if (!def || !canPlayTactic(state, actor.side, cardId)) continue;
      const score = cpuTacticScore(state, actor.side, def);
      if (score >= 24 && (!best || score > best.score)) best = { cardId, score };
    }
    if (!best) return;
    playTacticCard(state, actor.side, actor, best.cardId);
  }
}

/** アクターの手番開始時に「このターンの出来事」を初期化する。 */
function beginTurnEvents(state: BattleState, actor: BattleActor): void {
  if (!state.tactics) return;
  state.tactics.turn = {
    actorKey: actor.key,
    side: actor.side,
    dmgCount: 0,
    statusesApplied: [],
    tagsPlayed: [],
    cardsPlayed: 0,
    tpUsed: [],
  };
}

/** ラウンド開始: 両者ドローと TP リセット（高密度化のみ）。 */
function startRoundTactics(state: BattleState): void {
  if (!state.tactics) return;
  for (const side of ["player", "cpu"] as const) {
    const sideState = state.tactics[side];
    if (sideState.deck.length === 0 && sideState.hand.length === 0 && sideState.discard.length === 0) continue;
    drawTacticCards(state, side, TACTIC_DRAW_PER_ROUND);
    sideState.tp = TACTIC_TP_PER_ROUND;
  }
}

/* --- ターン開始・終了処理 --- */

/** ターン開始: CD減算、防御解除、やけど、特性 regen。死亡したら true。 */
function processTurnStart(state: BattleState, actor: BattleActor): boolean {
  actor.cooldowns = [Math.max(0, actor.cooldowns[0] - 1), Math.max(0, actor.cooldowns[1] - 1)] as [number, number];
  actor.defending = false;
  if (hasStatus(actor, "burn")) {
    const burnDamage = Math.max(1, Math.floor(actor.maxHp * 0.06));
    actor.hp -= burnDamage;
    pushLog(state, { type: "status", text: `${actor.name}はやけどで ${burnDamage} ダメージ。`, targetKey: actor.key, amount: burnDamage, hpAfter: Math.max(0, actor.hp), statusKind: "burn" });
    markDead(state, actor);
    if (!actor.alive) return true;
  }
  if (actor.trait.kind === "regen" && actor.hp > 0 && actor.hp < actor.maxHp) {
    healActor(state, actor, actor, Math.max(1, Math.floor(actor.maxHp * 0.06)));
  }
  return false;
}

/** ターン終了: 自分の状態の残りターンを減らす。 */
function processTurnEnd(actor: BattleActor): void {
  actor.statuses = actor.statuses
    .map((status) => ({ ...status, turns: status.turns - 1 }))
    .filter((status) => status.turns > 0);
  if ((actor.buffTurns ?? 0) > 0) {
    actor.buffTurns = (actor.buffTurns ?? 0) - 1;
    if (actor.buffTurns <= 0) actor.buffMult = undefined;
  }
}

/* --- 行動順 --- */

function buildQueue(state: BattleState): void {
  const tieBreakers = new Map<string, number>();
  for (const actor of state.actors) {
    if (actor.alive) tieBreakers.set(actor.key, nextRandom(state));
  }
  state.queue = state.actors
    .filter((actor) => actor.alive)
    .sort((a, b) => queueSpeed(b) - queueSpeed(a) || (tieBreakers.get(a.key) ?? 0) - (tieBreakers.get(b.key) ?? 0))
    .map((actor) => actor.key);
  state.queuePos = 0;
}

/**
 * 現在の手番から、プレイヤーの手番か終局まで自動で進める。
 * CPU の手番・スタン・やけど死などをここで消化する。
 * 呼び出し時点の queuePos のアクターは「ターン開始処理が未実施」が前提。
 */
function advanceToPlayerTurn(state: BattleState): void {
  let guard = 0;
  while (state.phase === "battle" && guard++ < 10000) {
    if (checkFinish(state)) return;
    if (state.queuePos >= state.queue.length) {
      if (state.round >= MAX_ROUNDS) {
        finishByHpFraction(state);
        return;
      }
      state.round += 1;
      startRoundTactics(state);
      buildQueue(state);
      continue;
    }
    const actor = currentActor(state);
    if (!actor || !actor.alive) {
      state.queuePos += 1;
      continue;
    }
    const diedAtStart = processTurnStart(state, actor);
    if (diedAtStart) {
      state.turnCount += 1;
      state.queuePos += 1;
      continue;
    }
    if (checkFinish(state)) return;
    beginTurnEvents(state, actor);
    if (hasStatus(actor, "stun")) {
      // 高密度化では、スタン中のプレイヤーにも戦術フェイズだけは渡す
      // （行動は applyAction がパスとして処理する）。CPU は従来どおりスキップ。
      if (actor.side === "player" && state.tactics) return;
      pushLog(state, { type: "status", text: `${actor.name}はスタンで動けない。`, actorKey: actor.key, statusKind: "stun" });
      processTurnEnd(actor);
      state.turnCount += 1;
      state.queuePos += 1;
      continue;
    }
    if (actor.side === "player") return;
    // CPU の手番: 戦術フェイズ → 行動
    if (state.tactics) cpuPlayTactics(state, actor);
    if (!actor.alive || checkFinish(state)) {
      state.turnCount += 1;
      state.queuePos += 1;
      continue;
    }
    const action = cpuChooseAction(state, actor);
    executeAction(state, actor, action);
    processTurnEnd(actor);
    state.turnCount += 1;
    if (checkFinish(state)) return;
    state.queuePos += 1;
  }
}

/* --- 公開 API --- */

function toActor(card: LllCard, side: "player" | "cpu", index: number): BattleActor {
  const stats = effectiveStats(card);
  return {
    key: `${side}_${index}`,
    side,
    cardId: card.id,
    name: card.name,
    element: card.element,
    tier: card.tier,
    level: card.level,
    ...(card.glyph ? { glyph: card.glyph } : {}),
    ...(card.imageDataUrl ? { imageDataUrl: card.imageDataUrl } : {}),
    maxHp: stats.hp,
    hp: stats.hp,
    atk: stats.atk,
    def: stats.def,
    spd: stats.spd,
    skills: card.skills.map((skill) => ({ ...skill })) as [LllSkill, LllSkill],
    trait: { ...card.trait },
    cooldowns: [0, 0],
    statuses: [],
    shield: 0,
    defending: false,
    alive: true,
  };
}

/**
 * バトルを生成する。生成直後に CPU の手番が続く場合は自動で進め、
 * 「プレイヤーの手番」か「終局」の状態で返す。
 */
export function createBattle(
  id: string,
  playerTeam: LllCard[],
  enemyTeam: LllCard[],
  tierIndex: number,
  seed: number,
  options?: { tacticDecks?: { player: string[] | null; cpu: string[] | null } },
): BattleState {
  const state: BattleState = {
    id,
    tierIndex,
    round: 1,
    actors: [
      ...playerTeam.map((card, index) => toActor(card, "player", index)),
      ...enemyTeam.map((card, index) => toActor(card, "cpu", index)),
    ],
    queue: [],
    queuePos: 0,
    phase: "battle",
    log: [],
    seed,
    rngState: seed >>> 0,
    turnCount: 0,
  };
  pushLog(state, { type: "info", text: "対戦開始。" });
  if (options?.tacticDecks) {
    // 高密度化: 戦術デッキを seeded 乱数でシャッフルし、初期手札を配る
    const freshSide = (deckList: string[] | null): TacticSideState => {
      const deck = [...(deckList ?? [])];
      for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(nextRandom(state) * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
      }
      return { deck, hand: [], discard: [], tp: TACTIC_TP_PER_ROUND, reserves: [], lastPlayedEffects: null };
    };
    state.tactics = {
      player: freshSide(options.tacticDecks.player),
      cpu: freshSide(options.tacticDecks.cpu),
      turn: { actorKey: "", side: "player", dmgCount: 0, statusesApplied: [], tagsPlayed: [], cardsPlayed: 0, tpUsed: [] },
      stack: [],
      effectDepth: 0,
    };
    for (const side of ["player", "cpu"] as const) {
      if (state.tactics[side].deck.length > 0) drawTacticCards(state, side, TACTIC_INITIAL_HAND);
    }
  }
  buildQueue(state);
  advanceToPlayerTurn(state);
  return state;
}

/** その技で合法な対象の key 一覧。防御は対象なし（空配列）。 */
export function legalTargets(state: BattleState, actor: BattleActor, skillIndex: 0 | 1 | "basic" | "defend"): string[] {
  if (skillIndex === "defend") return [];
  const enemies = state.actors.filter((candidate) => candidate.side !== actor.side && candidate.alive).map((candidate) => candidate.key);
  if (skillIndex === "basic") return enemies;
  const skill = actor.skills[skillIndex];
  if (!skill) return [];
  if (skill.kind === "heal" || skill.kind === "shield") {
    return state.actors.filter((candidate) => candidate.side === actor.side && candidate.alive).map((candidate) => candidate.key);
  }
  return enemies;
}

/**
 * プレイヤーの行動を適用し、次のプレイヤー手番か終局まで進めた状態を返す
 * （state を直接変更する）。
 */
export function applyAction(state: BattleState, action: PlayerAction): BattleState {
  if (state.phase !== "battle") throw new Error("この対戦は終了しています。");
  const actor = currentActor(state);
  if (!actor) throw new Error("行動できるアクターがいません。");
  if (actor.side !== "player") throw new Error("いまはプレイヤーの手番ではありません。");
  if (state.tactics && hasStatus(actor, "stun")) {
    // スタン中は戦術フェイズのみ（applyTacticPlay）。行動指定はパスとして処理する
    pushLog(state, { type: "status", text: `${actor.name}はスタンで動けない。`, actorKey: actor.key, statusKind: "stun" });
    processTurnEnd(actor);
    state.turnCount += 1;
    if (!checkFinish(state)) {
      state.queuePos += 1;
      advanceToPlayerTurn(state);
    }
    return state;
  }
  if (typeof action.skill === "number" && actor.cooldowns[action.skill] > 0) {
    throw new Error("この技はクールダウン中です。");
  }
  executeAction(state, actor, action);
  processTurnEnd(actor);
  state.turnCount += 1;
  if (!checkFinish(state)) {
    state.queuePos += 1;
    advanceToPlayerTurn(state);
  }
  return state;
}

/**
 * CPU の決定的ポリシー（仕様 §4）:
 * 回復は味方HP<50%で、状態異常は未付与の対象へ、強技はCD明け即使用、
 * 攻撃対象は最もHPの低い敵。防御はしない。
 */
export function cpuChooseAction(state: BattleState, actor: BattleActor): PlayerAction {
  const allies = state.actors.filter((candidate) => candidate.side === actor.side && candidate.alive);
  const enemies = state.actors.filter((candidate) => candidate.side !== actor.side && candidate.alive);
  const lowestEnemy = enemies.slice().sort((a, b) => a.hp - b.hp || a.key.localeCompare(b.key))[0];
  const ready = (index: 0 | 1) => actor.cooldowns[index] === 0;

  // 回復: HP割合が50%未満の味方がいれば最も割合の低い味方へ
  for (const index of [0, 1] as const) {
    if (!ready(index) || actor.skills[index].kind !== "heal") continue;
    const wounded = allies
      .filter((ally) => ally.hp / ally.maxHp < 0.5)
      .sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp || a.key.localeCompare(b.key))[0];
    if (wounded) return { skill: index, targetKey: wounded.key };
  }
  // 状態異常・支援の強技（技2優先）: 未付与の対象へ
  for (const index of [1, 0] as const) {
    if (!ready(index)) continue;
    const kind = actor.skills[index].kind;
    if (kind === "burn" || kind === "stun" || kind === "guard_break") {
      const target = enemies
        .filter((enemy) => !enemy.statuses.some((status) => status.kind === kind))
        .sort((a, b) => a.hp - b.hp || a.key.localeCompare(b.key))[0];
      if (target) return { skill: index, targetKey: target.key };
      if (lowestEnemy) return { skill: index, targetKey: lowestEnemy.key };
    }
    if (kind === "overdrive" && !hasStatus(actor, "overdrive") && lowestEnemy) {
      return { skill: index, targetKey: lowestEnemy.key };
    }
    if (kind === "shield") {
      const unshielded = allies
        .filter((ally) => ally.shield === 0)
        .sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp || a.key.localeCompare(b.key))[0];
      if (unshielded) return { skill: index, targetKey: unshielded.key };
    }
  }
  // 強技（技2）→ 技1 の順に攻撃技を使う
  for (const index of [1, 0] as const) {
    if (!ready(index)) continue;
    const kind = actor.skills[index].kind;
    if (OFFENSIVE_KINDS.has(kind) && lowestEnemy) return { skill: index, targetKey: lowestEnemy.key };
  }
  if (lowestEnemy) return { skill: "basic", targetKey: lowestEnemy.key };
  return { skill: "defend" };
}

/** テスト用: プレイヤー側も CPU ポリシーで操作し、終局まで進める。 */
export function simulateBattle(state: BattleState): BattleState {
  let guard = 0;
  while (state.phase === "battle" && guard++ < 1000) {
    const actor = currentActor(state);
    if (!actor) break;
    if (actor.side !== "player") break; // 通常は起きない（生成・適用時点でプレイヤー手番まで進んでいる）
    applyAction(state, cpuChooseAction(state, actor));
  }
  return state;
}

/** simulateBattle の別名（プレイヤーポリシーを差し替えたい呼び出し向け）。 */
export function runCpuBattleToEnd(
  state: BattleState,
  playerPolicy: (state: BattleState, actor: BattleActor) => PlayerAction = cpuChooseAction,
): BattleState {
  let guard = 0;
  while (state.phase === "battle" && guard++ < 1000) {
    const actor = currentActor(state);
    if (!actor || actor.side !== "player") break;
    applyAction(state, playerPolicy(state, actor));
  }
  return state;
}
