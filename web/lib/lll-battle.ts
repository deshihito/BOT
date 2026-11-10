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
};
export type BattleEvent = {
  type: "damage" | "heal" | "shield" | "status" | "death" | "info" | "trait" | "win";
  text: string;
  actorKey?: string;
  targetKey?: string;
  amount?: number;
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

/** 特性 focus と overdrive を含めた実効 ATK。 */
function effectiveAtk(actor: BattleActor): number {
  let atk = actor.atk;
  if (actor.trait.kind === "focus") atk *= 1.1;
  if (hasStatus(actor, "overdrive")) atk *= 1.3;
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

/* --- ダメージ・回復 --- */

function markDead(state: BattleState, target: BattleActor): void {
  if (target.hp > 0 || !target.alive) return;
  target.hp = 0;
  target.alive = false;
  target.shield = 0;
  target.statuses = [];
  target.defending = false;
  pushLog(state, { type: "death", text: `${target.name}は倒れた。`, targetKey: target.key });
}

/**
 * ダメージ計算（仕様 §4）:
 * floor(威力 × ATK/(ATK+DEF) × 乱数0.8〜1.2 × 属性倍率 × 防御倍率)、最低1。
 * シールドが先に吸収する。特性 thorns は与ダメの一部を反射する。
 */
function dealDamage(state: BattleState, attacker: BattleActor, target: BattleActor, power: number): number {
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
  const absorbed = Math.min(target.shield, damage);
  if (absorbed > 0) {
    target.shield -= absorbed;
    pushLog(state, { type: "shield", text: `${target.name}のシールドが ${absorbed} を吸収。`, actorKey: attacker.key, targetKey: target.key, amount: absorbed });
  }
  const dealt = damage - absorbed;
  target.hp -= dealt;
  pushLog(state, {
    type: "damage",
    text: `${attacker.name}の攻撃。${target.name}に ${dealt} ダメージ。`,
    actorKey: attacker.key,
    targetKey: target.key,
    amount: dealt,
  });
  markDead(state, target);
  // 特性 thorns: 生き残った被弾者が与ダメの20%を返す
  if (dealt > 0 && target.alive && target.trait.kind === "thorns" && attacker.alive) {
    const reflected = Math.max(1, Math.floor(dealt * 0.2));
    attacker.hp -= reflected;
    pushLog(state, { type: "trait", text: `${target.name}の特性で ${attacker.name}に ${reflected} 反射。`, actorKey: target.key, targetKey: attacker.key, amount: reflected });
    markDead(state, attacker);
  }
  return dealt;
}

function healActor(state: BattleState, source: BattleActor, target: BattleActor, amount: number): number {
  const healed = Math.max(0, Math.min(amount, target.maxHp - target.hp));
  target.hp += healed;
  pushLog(state, { type: "heal", text: `${target.name}のHPが ${healed} 回復。`, actorKey: source.key, targetKey: target.key, amount: healed });
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
    dealDamage(state, actor, target, BASIC_POWER);
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
    pushLog(state, { type: "shield", text: `${actor.name}の「${skill.name}」。${target.name}にシールド ${skill.power}。`, actorKey: actor.key, targetKey: target.key, amount: skill.power });
    return;
  }
  if (skill.kind === "overdrive") {
    // 自分への強化技。対象指定（クライアントの敵タップ等）は無視して自分に付与する
    addStatus(actor, "overdrive", 2);
    pushLog(state, { type: "status", text: `${actor.name}の「${skill.name}」。攻撃力が上がった。`, actorKey: actor.key, targetKey: actor.key });
    return;
  }
  // 攻撃系（damage / burn / stun / guard_break / drain）
  const target = resolveTarget(state, actor, action.targetKey, "enemy");
  pushLog(state, { type: "info", text: `${actor.name}の「${skill.name}」。`, actorKey: actor.key, targetKey: target.key });
  const dealt = dealDamage(state, actor, target, skill.power);
  if (target.alive) {
    if (skill.kind === "burn") {
      addStatus(target, "burn", 2);
      pushLog(state, { type: "status", text: `${target.name}はやけどを負った。`, actorKey: actor.key, targetKey: target.key });
    } else if (skill.kind === "stun") {
      addStatus(target, "stun", 1);
      pushLog(state, { type: "status", text: `${target.name}はスタンした。`, actorKey: actor.key, targetKey: target.key });
    } else if (skill.kind === "guard_break") {
      addStatus(target, "guard_break", 2);
      pushLog(state, { type: "status", text: `${target.name}の防御が崩れた。`, actorKey: actor.key, targetKey: target.key });
    }
  }
  if (skill.kind === "drain" && dealt > 0 && actor.alive) {
    healActor(state, actor, actor, Math.floor(dealt / 2));
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
    pushLog(state, { type: "status", text: `${actor.name}はやけどで ${burnDamage} ダメージ。`, targetKey: actor.key, amount: burnDamage });
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
    if (hasStatus(actor, "stun")) {
      pushLog(state, { type: "status", text: `${actor.name}はスタンで動けない。`, actorKey: actor.key });
      processTurnEnd(actor);
      state.turnCount += 1;
      state.queuePos += 1;
      continue;
    }
    if (actor.side === "player") return;
    // CPU の手番
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
export function createBattle(id: string, playerTeam: LllCard[], enemyTeam: LllCard[], tierIndex: number, seed: number): BattleState {
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
