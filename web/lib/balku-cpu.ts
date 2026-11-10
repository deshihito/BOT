// BALKU の CPU プレイヤーの方策（サーバー専用）。
// CPU は通常の着席プレイヤーとして扱い、行動は人間と同じ
// applyGameAction の経路で適用する。このモジュールは「合法手の中から
// 次の1手を選ぶ」純粋関数だけを持ち、状態の保持やタイミング制御は
// lib/balku-server.ts 側（cpuDueAt の予約と processCpu）が担う。
// 方針は「強さ」より「ゲームが成立し、詰まらず、噛み合う」ことを優先:
// - 揃っている企画は公開で提出する
// - あと少しで揃う企画は市場で買ってから提出する
// - 素材が少し足りない企画は低確率で伏せ提出（ブラフ）する
// - どれも無ければ余剰素材を売ってコインを整え、パスする
// - 他社の伏せ提出への BALKU は控えめな確率（約15%）でのみコールする
// - オークションは「自分の企画に必要な素材」が市場価格以下なら入札する
// - 強制BALKU権など任意行使の権利は使わない（安全側）
// 乱数は rng として注入できる形にし、テストで決定的に検証できるようにする。
import {
  applyGameAction,
  getMarketPrice,
  selectLegalMaterials,
  TARGETED_EFFECTS,
  type GameAction,
  type GamePlayer,
  type MaterialCard,
  type MaterialKind,
  type ProjectCard,
  type RoomGameState,
} from "./balku-game";

export type BalkuRng = () => number;

/** CPU の表示名プール（工事テーマ）。空席へこの順で割り当てる。 */
export const CPU_NAMES: string[] = ["CPU タクト", "CPU ハンマー", "CPU スコップ", "CPU ドリル", "CPU ヘルメット"];

/** 使われていない最初の CPU 名を返す（全部使われていたら番号付き）。 */
export function nextCpuName(usedNames: readonly string[]): string {
  for (const name of CPU_NAMES) {
    if (!usedNames.includes(name)) return name;
  }
  let n = 2;
  while (usedNames.includes(`CPU タクト${n}`)) n += 1;
  return `CPU タクト${n}`;
}

function playerAt(state: RoomGameState, seat: number): GamePlayer | undefined {
  return state.players.find((p) => p.seat === seat);
}

function aliveOpponents(state: RoomGameState, seat: number): GamePlayer[] {
  return state.players.filter((p) => p.seat !== seat && !p.eliminated);
}

function ownedCount(hand: readonly GamePlayer["hand"][number][] | GamePlayer["hand"], kind: MaterialKind): number {
  return hand.filter((c) => c.kind === "material" && c.material === kind).length;
}

/** 対象指定効果（コイン徴収/手札破棄）の狙い先。対象が居なければ undefined。 */
function pickEffectTarget(state: RoomGameState, actor: GamePlayer, project: ProjectCard): number | undefined {
  const opponents = aliveOpponents(state, actor.seat);
  if (opponents.length === 0) return undefined;
  if (project.effect.type === "stealCoins") {
    return [...opponents].sort((a, b) => b.coins - a.coins || a.seat - b.seat)[0].seat;
  }
  if (project.effect.type === "discard") {
    return [...opponents].sort((a, b) => b.hand.length - a.hand.length || a.seat - b.seat)[0].seat;
  }
  return opponents[0].seat;
}

function submitAction(state: RoomGameState, actor: GamePlayer, project: ProjectCard, materials: MaterialCard[], faceUp: boolean): GameAction | null {
  const base: Extract<GameAction, { type: "submit" }> = {
    type: "submit",
    projectId: project.id,
    materialIds: materials.map((c) => c.id),
    faceUp,
  };
  if (TARGETED_EFFECTS.includes(project.effect.type)) {
    const targetSeat = pickEffectTarget(state, actor, project);
    if (targetSeat === undefined) return null;
    return { ...base, targetSeat };
  }
  return base;
}

/** 企画の不足状況。kinds = 足りない種類数、total = 足りない総枚数、cost = 市場で揃える費用。 */
function shortage(actor: GamePlayer, project: ProjectCard): { kinds: number; total: number; cost: number; missingKinds: MaterialKind[] } {
  let kinds = 0;
  let total = 0;
  let cost = 0;
  const missingKinds: MaterialKind[] = [];
  for (const [kindRaw, needRaw] of Object.entries(project.requirements)) {
    const kind = kindRaw as MaterialKind;
    const missing = (needRaw ?? 0) - ownedCount(actor.hand, kind);
    if (missing > 0) {
      kinds += 1;
      total += missing;
      cost += missing * getMarketPrice(kind);
      missingKinds.push(kind);
    }
  }
  return { kinds, total, cost, missingKinds };
}

/** ブラフ用: 必要素材のうち手札にあるぶんだけ（種類ごとに必要数まで）を添付する。 */
function partialMaterials(actor: GamePlayer, project: ProjectCard): MaterialCard[] {
  const picked: MaterialCard[] = [];
  for (const [kindRaw, needRaw] of Object.entries(project.requirements)) {
    const kind = kindRaw as MaterialKind;
    const take = Math.min(ownedCount(actor.hand, kind), needRaw ?? 0);
    picked.push(...actor.hand.filter((c): c is MaterialCard => c.kind === "material" && c.material === kind).slice(0, take));
  }
  return picked;
}

/**
 * 自分の手番の主行動を1手だけ決める。手番でなければ null。
 * 「1手」はエンジンの1アクション単位（購入1回・売却1回・提出・パス）。
 * サーバー側が繰り返し呼ぶことで「買って→揃えて→提出」が段階的に進む。
 */
export function decideCpuTurnAction(state: RoomGameState, seat: number, rng: BalkuRng): GameAction | null {
  if (state.phase !== "active" || state.activeSeat !== seat) return null;
  const actor = playerAt(state, seat);
  if (!actor || actor.eliminated || actor.actionUsed) return null;
  const projects = actor.hand.filter((c): c is ProjectCard => c.kind === "project");

  // (1) 必要素材が全部揃っている企画があれば、最高点のものを公開で提出
  const legal = projects
    .map((project) => ({ project, materials: selectLegalMaterials(project, actor.hand) }))
    .filter((entry): entry is { project: ProjectCard; materials: MaterialCard[] } => entry.materials !== null)
    .sort((a, b) => b.project.points - a.project.points);
  for (const entry of legal) {
    const action = submitAction(state, actor, entry.project, entry.materials, true);
    if (action) return action;
  }

  // (2) 市場で買えば揃う企画があり、コインで賄えるなら不足素材を1枚買う
  const buyable = projects
    .map((project) => ({ project, short: shortage(actor, project) }))
    .filter((entry) => entry.short.kinds > 0 && entry.short.cost <= actor.coins)
    .sort((a, b) => a.short.cost - b.short.cost || b.project.points - a.project.points);
  if (buyable.length > 0) {
    return { type: "buyMaterial", material: buyable[0].short.missingKinds[0] };
  }

  // (3) 少し足りない企画を低確率で伏せ提出（ブラフ）。不足1種≈30%、2種以上≈10%
  const bluffs = projects
    .map((project) => ({ project, short: shortage(actor, project) }))
    .filter((entry) => entry.short.kinds > 0)
    .sort((a, b) => a.short.kinds - b.short.kinds || a.short.total - b.short.total || b.project.points - a.project.points);
  if (bluffs.length > 0) {
    const best = bluffs[0];
    const probability = best.short.kinds === 1 ? 0.3 : 0.1;
    if (rng() < probability) {
      const action = submitAction(state, actor, best.project, partialMaterials(actor, best.project), false);
      if (action) return action;
    }
  }

  // (4) 余剰素材（どの企画の必要数にも入っていないぶん）を売ってコインを整える
  const requiredByKind = new Map<MaterialKind, number>();
  for (const project of projects) {
    for (const [kindRaw, needRaw] of Object.entries(project.requirements)) {
      const kind = kindRaw as MaterialKind;
      requiredByKind.set(kind, (requiredByKind.get(kind) ?? 0) + (needRaw ?? 0));
    }
  }
  const surplusIds: string[] = [];
  const counted = new Map<MaterialKind, number>();
  for (const card of actor.hand) {
    if (card.kind !== "material") continue;
    const seen = (counted.get(card.material) ?? 0) + 1;
    counted.set(card.material, seen);
    // 企画が無いときはゴミだけを売る（将来の企画用に素材は残す）
    const keep = projects.length === 0 ? (card.material === "ゴミ" ? 0 : Number.POSITIVE_INFINITY) : (requiredByKind.get(card.material) ?? 0);
    if (seen > keep) surplusIds.push(card.id);
  }
  if (surplusIds.length > 0) return { type: "sellCards", cardIds: surplusIds };

  // (5) することが無ければパス
  return { type: "endTurn" };
}

/** オークションへの入札判断。入札するなら金額は最少（現在額+1）。 */
export function decideCpuBid(state: RoomGameState, seat: number): GameAction | null {
  if (state.phase !== "active" || !state.auction) return null;
  const actor = playerAt(state, seat);
  if (!actor || actor.eliminated) return null;
  const auction = state.auction;
  if (auction.highestBidderSeat === seat) return null;
  if (auction.card.kind !== "material") return null;
  const kind = auction.card.material;
  // 自分の手札の企画に必要な素材で、手持ちが不足しているときだけ欲しい
  const needs = actor.hand.some(
    (c) => c.kind === "project" && ((c.requirements[kind] ?? 0) > ownedCount(actor.hand, kind)),
  );
  if (!needs) return null;
  const amount = auction.highestBid + 1;
  if (amount > actor.coins) return null;
  if (amount > getMarketPrice(kind)) return null;
  return { type: "bid", amount };
}

/** 他社の伏せ提出（BALKU コール対象）を探す。新しい提出を優先する。 */
export function findBulkCallTarget(state: RoomGameState, seat: number): { targetSeat: number; submissionId: string } | null {
  if (state.phase !== "active") return null;
  const actor = playerAt(state, seat);
  if (!actor || actor.eliminated) return null;
  for (const owner of state.players) {
    if (owner.seat === seat || owner.eliminated) continue;
    for (let i = owner.submitted.length - 1; i >= 0; i -= 1) {
      const submission = owner.submitted[i];
      if (!submission.faceUp) return { targetSeat: owner.seat, submissionId: submission.id };
    }
  }
  return null;
}

/** CPU が「次に動くべき理由」を持っているか（タイミング予約の判定用、乱数なし）。 */
export function cpuActionPending(state: RoomGameState, cpuSeats: ReadonlySet<number>): boolean {
  if (state.phase !== "active" || cpuSeats.size === 0) return false;
  for (const seat of cpuSeats) {
    if (decideCpuBid(state, seat)) return true;
    if (findBulkCallTarget(state, seat)) return true;
  }
  if (cpuSeats.has(state.activeSeat)) {
    const actor = playerAt(state, state.activeSeat);
    if (actor && !actor.eliminated) return true;
  }
  return false;
}

/**
 * CPU 全体で次の1手を決める。優先順位: オークション入札 → BALKU
 * コール（約15%）→ 手番 CPU の主行動。何も無ければ null。
 */
export function decideCpuStep(state: RoomGameState, cpuSeats: ReadonlySet<number>, rng: BalkuRng): { seat: number; action: GameAction } | null {
  if (state.phase !== "active" || cpuSeats.size === 0) return null;
  const seats = [...cpuSeats].sort((a, b) => a - b);
  for (const seat of seats) {
    const bid = decideCpuBid(state, seat);
    if (bid) return { seat, action: bid };
  }
  for (const seat of seats) {
    const target = findBulkCallTarget(state, seat);
    if (target) {
      if (rng() < 0.15) return { seat, action: { type: "bulkCall", ...target } };
      break; // コール判断の抽選は1回だけ（外れたら主行動へ）
    }
  }
  if (cpuSeats.has(state.activeSeat)) {
    const action = decideCpuTurnAction(state, state.activeSeat, rng);
    if (action) return { seat: state.activeSeat, action };
  }
  return null;
}

/** 1手をエンジンへ適用した新しい状態を返す。適用できなければ null。 */
export function applyCpuStepToState(state: RoomGameState, cpuSeats: ReadonlySet<number>, rng: BalkuRng): RoomGameState | null {
  const step = decideCpuStep(state, cpuSeats, rng);
  if (!step) return null;
  try {
    return applyGameAction(state, step.seat, step.action);
  } catch {
    return null;
  }
}
