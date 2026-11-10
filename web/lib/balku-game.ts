// BALKU（建築ブラフのカードゲーム）の純粋ロジック。自己完結モジュール
// （import なし）。元実装 server/balkuGame.ts のルールを、そのままの
// 仕様で AGO WEB に移植したもの。オンライン同期は lib/balku-server.ts が
// この状態遷移関数だけを使って行う。
//
// 核ループ:
// - ロビーに2〜4人が集まり、ホストが開始すると固定山札（人数×36枚）から
//   全員へ初期手札8枚・コイン3を配る。
// - 手番は60秒期限（TURN_LIMIT_MS）。開始時に2枚ドローし、企画提出で
//   手番が進む。調達市場の購入・カード売却（1枚1コイン）・BALKU・入札は
//   手番を消費しない。期限切れは expireTimedOutTurn が自動パスする。
// - 企画は素材条件を満たせば正規完成（公開時に効果発動）、不足なら
//   違法建築。伏せ企画は BALKU で暴かれるまで中身が見えない。
// - 一巡ごとに山札から1枚が自動オークションに出る。制限時間15秒
//   （AUCTION_LIMIT_MS）、入札のたびに15秒へ延長され、期限で決済する。
// - 山札が尽きたら最終精算（提出点＋ボーナス）。同点は共同勝利。
//
// 元実装からの意図的な変更は1点だけ:
// - randomMaterial 効果は amount 枚ぶん素材を与える。元実装はラベルが
//   「ランダム素材を2枚獲得」でも1枚しか与えていなかったバグの修正。

export type MaterialKind = "木材" | "鉄骨" | "コンクリート" | "ガラス" | "銅線" | "合金" | "超伝導体" | "ゴミ";
export type EffectType =
  | "coins"
  | "draw"
  | "gainMaterial"
  | "randomMaterial"
  | "randomProject"
  | "pointBoost"
  | "income"
  | "randomMaterialIncome"
  | "mysteryHouse"
  | "stealCoins"
  | "stealCard"
  | "discard"
  | "forceBulk";

export type MaterialCard = { id: string; kind: "material"; material: MaterialKind; name: string; value: number; rarity?: "premium" };
export type ProjectCard = {
  id: string;
  kind: "project";
  name: string;
  points: number;
  requirements: Partial<Record<MaterialKind, number>>;
  effect: { type: EffectType; amount: number; label: string; material?: MaterialKind };
  immediate: boolean;
};
export type GameCard = MaterialCard | ProjectCard;
export type Submission = {
  id: string;
  project: ProjectCard;
  materials: MaterialCard[];
  faceUp: boolean;
  legal: boolean;
  effectActivated: boolean;
  effectTargetSeat?: number;
};
export type ForceBulkCharge = { id: string; sourceProject: string; used: boolean };
export type GamePlayer = {
  seat: number;
  name: string;
  coins: number;
  hand: GameCard[];
  submitted: Submission[];
  eliminated: boolean;
  actionUsed: boolean;
  scoreBonus: number;
  forceBulkCharges: ForceBulkCharge[];
};
export type Auction = { card: GameCard; highestBid: number; highestBidderSeat: number | null; deadlineAt: number; roundOpened: number };
export type LogTone = "neutral" | "good" | "warning" | "danger";
export type GameLog = { id: string; text: string; tone: LogTone; createdAt: number };
export type FinalScore = { seat: number; name: string; points: number; submittedPoints: number; bonusPoints: number };
export type RoomGameState = {
  phase: "lobby" | "active" | "finished";
  turn: number;
  activeSeat: number;
  turnDeadlineAt: number | null;
  deck: GameCard[];
  deckInitialCount: number;
  turnsPerPlayer: number;
  players: GamePlayer[];
  logs: GameLog[];
  auction: Auction | null;
  winnerSeat: number | null;
  winnerSeats: number[];
  finalScores: FinalScore[];
  serial: number;
};
export type GameAction =
  | { type: "submit"; projectId: string; materialIds: string[]; faceUp: boolean; targetSeat?: number }
  | { type: "buyMaterial"; material: MaterialKind }
  | { type: "sellCards"; cardIds: string[] }
  | { type: "bid"; amount: number }
  | { type: "bulkCall"; targetSeat: number; submissionId: string }
  | { type: "forceBulk"; chargeId: string; targetSeat: number; submissionId: string }
  | { type: "endTurn" };

/** 調達市場で買える素材（表示順）。 */
export const MARKET_MATERIALS: MaterialKind[] = ["木材", "鉄骨", "コンクリート", "ガラス", "銅線", "合金", "超伝導体", "ゴミ"];
/** 提出時に対象の他社を選ぶ必要がある効果。 */
export const TARGETED_EFFECTS: EffectType[] = ["stealCoins", "discard"];

const materialKinds: MaterialKind[] = ["木材", "鉄骨", "コンクリート", "ガラス", "銅線", "合金", "ゴミ"];
const marketPrices: Record<MaterialKind, number> = { 木材: 5, 鉄骨: 5, コンクリート: 5, ガラス: 5, 銅線: 5, 合金: 7, 超伝導体: 10, ゴミ: 1 };
export const TURN_LIMIT_MS = 60_000;
export const AUCTION_LIMIT_MS = 15_000;

function makeProject(
  name: string,
  points: number,
  requirements: ProjectCard["requirements"],
  type: EffectType,
  amount: number,
  label: string,
  immediate = false,
  gainedMaterial?: MaterialKind,
): ProjectCard {
  return {
    id: "",
    kind: "project",
    name,
    points,
    requirements,
    effect: { type, amount, label, ...(gainedMaterial ? { material: gainedMaterial } : {}) },
    immediate,
  };
}

function makeMaterial(id: string, kind: MaterialKind): MaterialCard {
  return { id, kind: "material", material: kind, name: kind, value: 0, ...(kind === "超伝導体" ? { rarity: "premium" as const } : {}) };
}

/** 高級素材や継続効果を持つ後半の企画群（カードデータは元ゲームのプールと同一）。 */
export const NEW_PROJECT_DEFINITIONS: { card: ProjectCard; copies: number }[] = [
  { card: makeProject("ミステリーハウス", 5, { 超伝導体: 2, 銅線: 3, コンクリート: 2, 鉄骨: 2 }, "mysteryHouse", 1, "+3コイン / 毎ターン ランダム素材 +1"), copies: 1 },
  { card: makeProject("小屋", 6, { 木材: 3 }, "coins", 1, "コイン +1"), copies: 3 },
  { card: makeProject("光ファイバー", 1, { 銅線: 3 }, "gainMaterial", 1, "超伝導体を1枚獲得", false, "超伝導体"), copies: 2 },
  { card: makeProject("ミュージアム", 2, { コンクリート: 1, 鉄骨: 1, ガラス: 1 }, "randomProject", 1, "ランダムな企画カードを1枚獲得"), copies: 2 },
  { card: makeProject("ゴミ山", 1, { ゴミ: 3 }, "coins", 1, "コイン +1"), copies: 3 },
  { card: makeProject("解体工事", 3, { 木材: 1, 鉄骨: 1 }, "discard", 1, "指定会社の手札を1枚破棄", true), copies: 2 },
  { card: makeProject("環境アセス", 4, { ガラス: 2, 銅線: 1 }, "draw", 2, "カードを2枚引く", true), copies: 2 },
  { card: makeProject("地下シェルター", 9, { コンクリート: 3, 鉄骨: 2 }, "pointBoost", 3, "最終ポイント +3"), copies: 2 },
  { card: makeProject("スマート農場", 5, { 合金: 1, ガラス: 2 }, "income", 1, "毎ターン開始時 コイン +1"), copies: 2 },
  { card: makeProject("風力発電所", 7, { 鉄骨: 2, 合金: 2, 銅線: 1 }, "coins", 3, "コイン +3"), copies: 2 },
  { card: makeProject("水族館", 6, { ガラス: 3, コンクリート: 1 }, "randomMaterial", 2, "ランダム素材を2枚獲得"), copies: 2 },
  { card: makeProject("宇宙港", 14, { 超伝導体: 2, 合金: 2, 鉄骨: 2, コンクリート: 1 }, "pointBoost", 5, "最終ポイント +5"), copies: 1 },
  { card: makeProject("緊急補修", 2, {}, "randomMaterial", 2, "ランダム素材を2枚獲得", true), copies: 2 },
  { card: makeProject("独占契約", 5, { 銅線: 2, 合金: 1 }, "stealCard", 1, "ランダムに手札1枚を奪う"), copies: 2 },
  { card: makeProject("高層ビル", 10, { コンクリート: 3, 鉄骨: 3, ガラス: 2 }, "draw", 4, "カードを4枚引く"), copies: 1 },
  { card: makeProject("原子力施設", 13, { 超伝導体: 1, 合金: 3, コンクリート: 2 }, "coins", 8, "コイン +8"), copies: 1 },
  { card: makeProject("遊園地", 8, { 木材: 2, 鉄骨: 1, ガラス: 2, 銅線: 1 }, "pointBoost", 2, "最終ポイント +2"), copies: 1 },
];

const BASE_PROJECT_DEFINITIONS: { card: ProjectCard; copies: number }[] = [
  { card: makeProject("整地", 1, {}, "coins", 2, "コイン +2", true), copies: 3 },
  { card: makeProject("資材調達", 0, {}, "draw", 2, "カードを2枚引く", true), copies: 3 },
  { card: makeProject("コストカット", 1, {}, "pointBoost", 2, "最終ポイント +2", true), copies: 2 },
  { card: makeProject("文句", 1, {}, "stealCoins", 2, "指定会社から2コイン徴収", true), copies: 2 },
  { card: makeProject("産業スパイ", 1, {}, "stealCard", 1, "ランダムに手札1枚を奪う", true), copies: 2 },
  { card: makeProject("内部工作", 1, {}, "discard", 1, "指定会社の手札を1枚破棄", true), copies: 2 },
  { card: makeProject("木材調達", 0, {}, "gainMaterial", 2, "木材を2枚獲得", true, "木材"), copies: 2 },
  { card: makeProject("鉄骨調達", 0, {}, "gainMaterial", 2, "鉄骨を2枚獲得", true, "鉄骨"), copies: 2 },
  { card: makeProject("コンクリ調達", 0, {}, "gainMaterial", 2, "コンクリートを2枚獲得", true, "コンクリート"), copies: 2 },
  { card: makeProject("ガラス調達", 0, {}, "gainMaterial", 2, "ガラスを2枚獲得", true, "ガラス"), copies: 2 },
  { card: makeProject("銅線調達", 0, {}, "gainMaterial", 2, "銅線を2枚獲得", true, "銅線"), copies: 2 },
  { card: makeProject("ホール", 5, { 木材: 2, 鉄骨: 1 }, "coins", 4, "コイン +4"), copies: 3 },
  { card: makeProject("住宅街", 4, { 木材: 2, コンクリート: 1 }, "draw", 2, "カードを2枚引く"), copies: 3 },
  { card: makeProject("再開発", 7, { 鉄骨: 2, コンクリート: 1 }, "coins", 5, "コイン +5"), copies: 2 },
  { card: makeProject("巨大温室", 6, { 木材: 1, ガラス: 2, 銅線: 1 }, "coins", 4, "コイン +4"), copies: 2 },
  { card: makeProject("つり橋", 8, { 鉄骨: 2, コンクリート: 2 }, "draw", 3, "カードを3枚引く"), copies: 2 },
  { card: makeProject("オフィス", 7, { コンクリート: 2, 銅線: 2 }, "coins", 5, "コイン +5"), copies: 2 },
  { card: makeProject("ガラスドーム", 6, { 鉄骨: 1, ガラス: 2, 木材: 1 }, "coins", 4, "コイン +4"), copies: 2 },
  { card: makeProject("言いがかり", 5, { 鉄骨: 2, 銅線: 1 }, "forceBulk", 1, "強制BALKUを1回獲得"), copies: 3 },
  { card: makeProject("品質保証", 5, { 木材: 1, ガラス: 2 }, "pointBoost", 3, "最終ポイント +3"), copies: 2 },
  { card: makeProject("文句を言うもんく", 4, { 銅線: 2, コンクリート: 1 }, "stealCoins", 3, "指定会社から3コイン徴収"), copies: 2 },
  { card: makeProject("施工停止命令", 3, { 木材: 1, 鉄骨: 1, ガラス: 1 }, "discard", 2, "指定会社の手札を2枚破棄"), copies: 2 },
  { card: makeProject("通信制御棟", 7, { 合金: 2, 銅線: 1, ガラス: 1 }, "coins", 4, "コイン +4"), copies: 2 },
  { card: makeProject("高耐久ドーム", 8, { 合金: 2, コンクリート: 2, ガラス: 1 }, "draw", 3, "カードを3枚引く"), copies: 2 },
  { card: makeProject("都市物流港", 9, { 合金: 2, 鉄骨: 1, コンクリート: 1 }, "pointBoost", 2, "最終ポイント +2"), copies: 2 },
  { card: makeProject("深層研究区", 8, { 合金: 1, 銅線: 2, 鉄骨: 1 }, "coins", 5, "コイン +5"), copies: 2 },
  { card: makeProject("量子通信塔", 11, { 超伝導体: 2, 合金: 1, ガラス: 1 }, "coins", 7, "コイン +7"), copies: 1 },
  { card: makeProject("浮体都市中枢", 12, { 超伝導体: 1, 合金: 2, 鉄骨: 2 }, "pointBoost", 4, "最終ポイント +4"), copies: 1 },
  { card: makeProject("電力供給網", 6, { 銅線: 2, 合金: 1, コンクリート: 1 }, "income", 1, "毎ターン開始時 コイン +1"), copies: 3 },
];

function nextId(state: RoomGameState, prefix: string): string {
  state.serial += 1;
  return `${prefix}-${state.serial}`;
}

function pushLog(state: RoomGameState, text: string, tone: LogTone = "neutral"): void {
  state.logs.unshift({ id: nextId(state, "log"), text, tone, createdAt: Date.now() });
  state.logs = state.logs.slice(0, 24);
}

export function scoreBreakdown(player: GamePlayer): { submittedPoints: number; bonusPoints: number; points: number } {
  const submittedPoints = player.submitted.reduce((sum, item) => sum + item.project.points, 0);
  const bonusPoints = player.scoreBonus ?? 0;
  return { submittedPoints, bonusPoints, points: submittedPoints + bonusPoints };
}

export function getTotalPoints(player: GamePlayer): number {
  return scoreBreakdown(player).points;
}

export function getMarketPrice(kind: MaterialKind): number {
  return marketPrices[kind];
}

export function isLegalSubmission(plan: ProjectCard, materials: MaterialCard[]): boolean {
  return Object.entries(plan.requirements).every(
    ([kind, amount]) => materials.filter((card) => card.material === kind).length >= (amount ?? 0),
  );
}

/** 正規完成に必要な素材を手札からちょうど必要枚数だけ選ぶ。足りなければ null。 */
export function selectLegalMaterials(plan: ProjectCard, hand: GameCard[]): MaterialCard[] | null {
  const picked: MaterialCard[] = [];
  const used = new Set<string>();
  for (const [kind, amount] of Object.entries(plan.requirements)) {
    const need = amount ?? 0;
    const candidates = hand.filter(
      (card): card is MaterialCard => card.kind === "material" && card.material === kind && !used.has(card.id),
    );
    if (candidates.length < need) return null;
    for (let i = 0; i < need; i += 1) {
      picked.push(candidates[i]);
      used.add(candidates[i].id);
    }
  }
  return picked;
}

function drawCards(state: RoomGameState, player: GamePlayer, count: number): number {
  let drawn = 0;
  while (drawn < count && state.deck.length > 0) {
    const card = state.deck.shift();
    if (card) player.hand.push(card);
    drawn += 1;
  }
  return drawn;
}

function createDeck(state: RoomGameState, playerCount: number): GameCard[] {
  const library: GameCard[] = [];
  for (const kind of materialKinds) {
    for (let i = 0; i < 18; i += 1) library.push(makeMaterial(nextId(state, "mat"), kind));
  }
  for (let i = 0; i < 5; i += 1) library.push(makeMaterial(nextId(state, "rare"), "超伝導体"));
  for (const { card, copies } of [...BASE_PROJECT_DEFINITIONS, ...NEW_PROJECT_DEFINITIONS]) {
    for (let i = 0; i < copies; i += 1) library.push({ ...card, id: nextId(state, "prj"), effect: { ...card.effect } });
  }
  for (let i = library.length - 1; i > 0; i -= 1) {
    const swap = Math.floor(Math.random() * (i + 1));
    [library[i], library[swap]] = [library[swap], library[i]];
  }
  const fixedCount = playerCount * 36;
  if (library.length < fixedCount) throw new Error("固定山札の作成に必要なカードが不足しています。");
  return library.slice(0, fixedCount);
}

function blankPlayer(seat: number, name: string): GamePlayer {
  return { seat, name, coins: 3, hand: [], submitted: [], eliminated: false, actionUsed: false, scoreBonus: 0, forceBulkCharges: [] };
}

export function createLobbyState(hostName: string): RoomGameState {
  return {
    phase: "lobby",
    turn: 1,
    activeSeat: 0,
    turnDeadlineAt: null,
    deck: [],
    deckInitialCount: 0,
    turnsPerPlayer: 10,
    players: [blankPlayer(0, hostName)],
    logs: [],
    auction: null,
    winnerSeat: null,
    winnerSeats: [],
    finalScores: [],
    serial: 0,
  };
}

export function addLobbyPlayer(state: RoomGameState, displayName: string): RoomGameState {
  if (state.phase !== "lobby") throw new Error("対戦開始後の入室はできません。");
  if (state.players.length >= 4) throw new Error("このルームは満席です。");
  const next = structuredClone(state);
  next.players.push(blankPlayer(next.players.length, displayName));
  pushLog(next, `${displayName} が現場に合流。現在 ${next.players.length} 人。`, "good");
  return next;
}

export function startGame(state: RoomGameState): RoomGameState {
  if (state.phase !== "lobby") throw new Error("このルームはすでに開始されています。");
  if (state.players.length < 2) throw new Error("開始には2人以上の参加者が必要です。");
  const next = structuredClone(state);
  next.phase = "active";
  next.turn = 1;
  next.activeSeat = 0;
  next.turnDeadlineAt = Date.now() + TURN_LIMIT_MS;
  next.winnerSeat = null;
  next.winnerSeats = [];
  next.finalScores = [];
  next.auction = null;
  next.deck = createDeck(next, next.players.length);
  next.deckInitialCount = next.deck.length;
  next.players = next.players.map((player) => blankPlayer(player.seat, player.name));
  for (const player of next.players) drawCards(next, player, 8);
  pushLog(next, `固定山札 ${next.deckInitialCount} 枚で開始。山札が尽きると最終精算です。`, "good");
  pushLog(next, `全施工者へ初期手札8枚を配布。第1ターンは${next.players[0].name}の施工ターンです。`, "good");
  return next;
}

export function resetToLobby(state: RoomGameState): RoomGameState {
  const names = state.players.map((player) => player.name);
  let next = createLobbyState(names[0] ?? "施工者");
  names.slice(1).forEach((name) => {
    next = addLobbyPlayer(next, name);
  });
  pushLog(next, "同じ現場で再戦を準備中。作成者が開始すると新しい施工競争が始まる。", "neutral");
  return next;
}

function findPlayer(state: RoomGameState, seat: number): GamePlayer {
  const player = state.players.find((item) => item.seat === seat);
  if (!player || player.eliminated) throw new Error("操作できるプレイヤーが見つかりません。");
  return player;
}

function assertActiveTurn(state: RoomGameState, seat: number): void {
  if (state.phase !== "active") throw new Error("この対戦は開始されていません。");
  if (state.activeSeat !== seat) throw new Error("いまはあなたの施工ターンではありません。");
}

function resolveEffectTarget(state: RoomGameState, owner: GamePlayer, targetSeat?: number): GamePlayer {
  if (targetSeat === undefined) throw new Error("この企画は対象となる他社を選択してください。");
  const target = findPlayer(state, targetSeat);
  if (target.seat === owner.seat) throw new Error("自分自身を効果対象にはできません。");
  return target;
}

function activateEffect(state: RoomGameState, owner: GamePlayer, submission: Submission, source: string): void {
  if (submission.effectActivated) return;
  submission.effectActivated = true;
  const { type, amount, label } = submission.project.effect;
  if (type === "coins") owner.coins += amount;
  if (type === "mysteryHouse") owner.coins += 3;
  if (type === "draw") drawCards(state, owner, amount);
  if (type === "gainMaterial" && submission.project.effect.material) {
    for (let i = 0; i < amount; i += 1) owner.hand.push(makeMaterial(nextId(state, "supply"), submission.project.effect.material));
  }
  if (type === "randomMaterial") {
    // 意図的修正: amount 枚ぶん与える（元実装は1枚だけだった）
    for (let i = 0; i < amount; i += 1) {
      const kind = materialKinds[Math.floor(Math.random() * materialKinds.length)];
      owner.hand.push(makeMaterial(nextId(state, "random-supply"), kind));
    }
  }
  if (type === "randomProject") {
    const projectIndexes = state.deck.map((card, index) => (card.kind === "project" ? index : -1)).filter((index) => index >= 0);
    const projectIndex = projectIndexes[Math.floor(Math.random() * projectIndexes.length)];
    if (projectIndex !== undefined) {
      const [projectCard] = state.deck.splice(projectIndex, 1);
      if (projectCard) owner.hand.push(projectCard);
    }
  }
  if (type === "pointBoost") owner.scoreBonus = (owner.scoreBonus ?? 0) + amount;
  if (type === "forceBulk") owner.forceBulkCharges.push({ id: submission.id, sourceProject: submission.project.name, used: false });
  if (type === "stealCoins") {
    const target = resolveEffectTarget(state, owner, submission.effectTargetSeat);
    const stolen = Math.min(target.coins, amount);
    target.coins -= stolen;
    owner.coins += stolen;
  }
  if (type === "stealCard") {
    const candidates = state.players.filter((player) => player.seat !== owner.seat && !player.eliminated && player.hand.length > 0);
    const target = candidates[Math.floor(Math.random() * candidates.length)];
    if (target) {
      const [stolen] = target.hand.splice(Math.floor(Math.random() * target.hand.length), 1);
      if (stolen) owner.hand.push(stolen);
      pushLog(state, `${source}: ${owner.name}はランダム対象の${target.name}から手札1枚を奪取。`, "warning");
    } else {
      pushLog(state, `${source}: 奪取可能な他社の手札がなく、効果は不発。`, "neutral");
    }
  }
  if (type === "discard") {
    const target = resolveEffectTarget(state, owner, submission.effectTargetSeat);
    const discarded = target.hand.splice(0, amount);
    pushLog(state, `${source}: ${target.name}の手札 ${discarded.length} 枚を破棄。`, "danger");
  }
  pushLog(
    state,
    `${source}: ${owner.name}の「${submission.project.name}」が発動 — ${label}。`,
    type === "stealCoins" || type === "stealCard" || type === "discard" || type === "forceBulk" ? "warning" : "good",
  );
}

function resolveAutoAuction(state: RoomGameState): void {
  const auction = state.auction;
  if (!auction) return;
  if (auction.highestBidderSeat !== null) {
    const winner = findPlayer(state, auction.highestBidderSeat);
    winner.coins -= auction.highestBid;
    winner.hand.push(auction.card);
    pushLog(state, `自動オークション成立。「${auction.card.name}」を${winner.name}が${auction.highestBid}コインで落札。`, "good");
  } else {
    pushLog(state, `自動オークション不成立。「${auction.card.name}」は市場から取り下げ。`, "neutral");
  }
  state.auction = null;
}

function openAutoAuction(state: RoomGameState): void {
  const card = state.deck.shift();
  if (!card) return;
  state.auction = { card, highestBid: 0, highestBidderSeat: null, deadlineAt: Date.now() + AUCTION_LIMIT_MS, roundOpened: state.turn };
  pushLog(state, `自動オークション開始。市場に「${card.name}」が出品されました。残り15秒。入札が入るたびに期限が延長されます。`, "warning");
}

function finishByScore(state: RoomGameState): void {
  if (state.phase === "finished") return;
  if (state.auction) resolveAutoAuction(state);
  for (const player of state.players) {
    for (const submission of player.submitted) submission.faceUp = true;
  }
  state.finalScores = state.players
    .filter((player) => !player.eliminated)
    .map((player) => ({ seat: player.seat, name: player.name, ...scoreBreakdown(player) }))
    .sort((a, b) => b.points - a.points || b.submittedPoints - a.submittedPoints);
  const topScore = state.finalScores[0]?.points ?? 0;
  state.winnerSeats = state.finalScores.filter((score) => score.points === topScore).map((score) => score.seat);
  state.winnerSeat = state.winnerSeats.length === 1 ? state.winnerSeats[0] : null;
  state.phase = "finished";
  state.turnDeadlineAt = null;
  if (state.winnerSeats.length === 1) {
    pushLog(state, `山札消尽。最終精算の結果、${state.finalScores[0]?.name ?? "勝者"} が ${topScore} PT で勝利。`, "good");
  } else {
    pushLog(state, `山札消尽。最終精算は ${topScore} PT で共同勝利。`, "warning");
  }
}

function activateTurnIncome(state: RoomGameState, player: GamePlayer): void {
  const income = player.submitted
    .filter((s) => s.legal && s.effectActivated && s.project.effect.type === "income")
    .reduce((sum, s) => sum + s.project.effect.amount, 0);
  if (income > 0) {
    player.coins += income;
    pushLog(state, `${player.name}は継続収入により ${income} コインを獲得。`, "good");
  }
  const materialIncome = player.submitted
    .filter((s) => s.legal && s.effectActivated && (s.project.effect.type === "randomMaterialIncome" || s.project.effect.type === "mysteryHouse"))
    .reduce((sum, s) => sum + s.project.effect.amount, 0);
  for (let i = 0; i < materialIncome; i += 1) {
    const kind = materialKinds[Math.floor(Math.random() * materialKinds.length)];
    player.hand.push(makeMaterial(nextId(state, "mystery-supply"), kind));
  }
  if (materialIncome > 0) pushLog(state, `${player.name}はミステリーハウスからランダム素材 ${materialIncome}枚を獲得。`, "good");
}

function advanceTurn(state: RoomGameState): void {
  let cursor = state.activeSeat;
  for (let step = 0; step < state.players.length; step += 1) {
    cursor = (cursor + 1) % state.players.length;
    const nextPlayer = state.players.find((player) => player.seat === cursor);
    if (!nextPlayer || nextPlayer.eliminated) continue;
    const newRound = cursor === 0;
    if (newRound) {
      if (state.deck.length > 0 && !state.auction) openAutoAuction(state);
      if (state.deck.length === 0 && !state.auction) {
        finishByScore(state);
        return;
      }
    }
    state.activeSeat = cursor;
    state.turn += 1;
    state.turnDeadlineAt = Date.now() + TURN_LIMIT_MS;
    nextPlayer.actionUsed = false;
    activateTurnIncome(state, nextPlayer);
    const drawn = drawCards(state, nextPlayer, 2);
    pushLog(state, `第${state.turn}ターン。${nextPlayer.name}が${drawn}枚をドローし、施工ターンに入った。`, "good");
    if (state.deck.length === 0 && !state.auction) finishByScore(state);
    return;
  }
  finishByScore(state);
}

function finishActionAndAdvance(state: RoomGameState): void {
  if (state.deck.length === 0 && !state.auction) finishByScore(state);
  else advanceTurn(state);
}

/**
 * 期限切れの処理。何も変わらなければ元の state をそのまま返す
 * （呼び出し側は参照の同一性で「変化なし」を判定する）。
 * オークション期限が来ていれば決済し、手番期限が来ていれば自動パスする。
 */
export function expireTimedOutTurn(state: RoomGameState, now = Date.now()): RoomGameState {
  if (state.phase !== "active") return state;
  let next = state;
  if (state.auction?.deadlineAt !== undefined && state.auction.deadlineAt <= now) {
    next = structuredClone(state);
    resolveAutoAuction(next);
  }
  if (next.phase !== "active") return next;
  if (!next.turnDeadlineAt) {
    const initialized = next === state ? structuredClone(next) : next;
    initialized.turnDeadlineAt = now + TURN_LIMIT_MS;
    return initialized;
  }
  if (next.turnDeadlineAt > now) return next;
  if (next === state) next = structuredClone(state);
  const timedOutPlayer = findPlayer(next, next.activeSeat);
  pushLog(next, `${timedOutPlayer.name}の施工時間が終了。行動なしで自動パス。`, "warning");
  advanceTurn(next);
  return next;
}

function resolveBulk(state: RoomGameState, caller: GamePlayer, owner: GamePlayer, target: Submission): void {
  if (!target.legal) {
    owner.submitted = owner.submitted.filter((item) => item.id !== target.id);
    caller.hand.push(target.project, ...target.materials);
    pushLog(state, `BALKU成功。${caller.name}が違法建築「${target.project.name}」と添付素材を接収。`, "good");
    return;
  }
  target.faceUp = true;
  activateEffect(state, owner, target, "BALKU開示");
  const losses = caller.hand
    .filter((card): card is ProjectCard => card.kind === "project")
    .sort((a, b) => b.points - a.points);
  const lost: ProjectCard[] = [];
  let value = 0;
  for (const card of losses) {
    if (value >= target.project.points) break;
    value += card.points;
    lost.push(card);
  }
  if (value < target.project.points) {
    caller.hand = [];
    caller.submitted = [];
    caller.eliminated = true;
    pushLog(state, `BALKU失敗。${caller.name}は${target.project.points}点以上をロストできず、全ロストで脱落。`, "danger");
    return;
  }
  const lostIds = new Set(lost.map((card) => card.id));
  caller.hand = caller.hand.filter((card) => !lostIds.has(card.id));
  pushLog(state, `BALKU失敗。${caller.name}は合計${value}ポイントの企画をロスト。`, "danger");
}

function resolveForceBulk(state: RoomGameState, caller: GamePlayer, owner: GamePlayer, target: Submission, charge: ForceBulkCharge): void {
  charge.used = true;
  owner.submitted = owner.submitted.filter((item) => item.id !== target.id);
  caller.hand.push(target.project, ...target.materials);
  pushLog(state, `強制BALKU発動。${caller.name}は「${charge.sourceProject}」を使い、${owner.name}の「${target.project.name}」を強制違法建築として接収。`, "danger");
}

/** 行動を適用した新しい状態を返す。元の状態は変更しない。 */
export function applyGameAction(state: RoomGameState, seat: number, action: GameAction): RoomGameState {
  const next = structuredClone(state);
  const actor = findPlayer(next, seat);
  actor.forceBulkCharges ??= [];
  actor.scoreBonus ??= 0;

  // 手番外でもできる行動（入札・BALKU・強制BALKU）
  if (action.type === "bid") {
    if (!next.auction) throw new Error("進行中の自動オークションはありません。");
    if (action.amount <= next.auction.highestBid || action.amount > actor.coins) {
      throw new Error("入札額は現在額より高く、保有コイン以下にしてください。");
    }
    next.auction.highestBid = action.amount;
    next.auction.highestBidderSeat = seat;
    next.auction.deadlineAt = Date.now() + AUCTION_LIMIT_MS;
    pushLog(next, `${actor.name}が市場の「${next.auction.card.name}」に${action.amount}コインで入札。期限を15秒へ延長。`, "warning");
    return next;
  }
  if (action.type === "bulkCall") {
    if (next.phase !== "active") throw new Error("BALKUできるのは対戦中のみです。");
    const owner = findPlayer(next, action.targetSeat);
    if (owner.seat === actor.seat) throw new Error("自分の企画にはBALKUできません。");
    const target = owner.submitted.find((item) => item.id === action.submissionId);
    if (!target) throw new Error("対象となる企画が見つかりません。");
    resolveBulk(next, actor, owner, target);
    return next;
  }
  if (action.type === "forceBulk") {
    if (next.phase !== "active") throw new Error("強制BALKUできるのは対戦中のみです。");
    const charge = actor.forceBulkCharges.find((item) => item.id === action.chargeId && !item.used);
    if (!charge) throw new Error("使用可能な強制BALKU権がありません。");
    const owner = findPlayer(next, action.targetSeat);
    if (owner.seat === actor.seat) throw new Error("自分の企画には強制BALKUできません。");
    const target = owner.submitted.find((item) => item.id === action.submissionId);
    if (!target) throw new Error("対象となる企画が見つかりません。");
    resolveForceBulk(next, actor, owner, target, charge);
    return next;
  }

  assertActiveTurn(next, seat);

  if (action.type === "endTurn") {
    if (actor.actionUsed) throw new Error("行動後は自動で次の施工者へ移ります。");
    pushLog(next, `${actor.name}は行動権を残してターンを終了。`, "neutral");
    advanceTurn(next);
    return next;
  }

  // 調達市場の購入は手番を消費しない（コインの限り何度でも買える）
  if (action.type === "buyMaterial") {
    const price = marketPrices[action.material];
    if (actor.coins < price) throw new Error(`${action.material}の直接調達には${price}コイン必要です。`);
    actor.coins -= price;
    actor.hand.push(makeMaterial(nextId(next, "market"), action.material));
    pushLog(next, `${actor.name}は調達市場から「${action.material}」を${price}コインで直接獲得。`, "good");
    return next;
  }

  // 売却は手番を消費しない
  if (action.type === "sellCards") {
    const ids = new Set(action.cardIds);
    if (ids.size === 0) throw new Error("売却するカードを1枚以上選択してください。");
    const cards = actor.hand.filter((card) => ids.has(card.id));
    if (cards.length !== ids.size) throw new Error("売却できるのは手札にあるカードのみです。");
    actor.hand = actor.hand.filter((card) => !ids.has(card.id));
    actor.coins += cards.length;
    pushLog(next, `${actor.name}はカード ${cards.length} 枚を売却し、${cards.length}コインを獲得。`, "good");
    return next;
  }

  if (actor.actionUsed) throw new Error("今ターンの行動権は使用済みです。");

  if (action.type === "submit") {
    const plan = actor.hand.find((card): card is ProjectCard => card.id === action.projectId && card.kind === "project");
    if (!plan) throw new Error("提出する企画カードを選択してください。");
    if (TARGETED_EFFECTS.includes(plan.effect.type) && action.targetSeat === undefined) {
      throw new Error("この企画は対象となる他社を選択してください。");
    }
    if (action.targetSeat === actor.seat) throw new Error("自分自身を効果対象にはできません。");
    const ids = new Set(action.materialIds);
    const materials = actor.hand.filter((card): card is MaterialCard => card.kind === "material" && ids.has(card.id));
    actor.hand = actor.hand.filter((card) => card.id !== plan.id && !ids.has(card.id));
    const submission: Submission = {
      id: nextId(next, "sub"),
      project: plan,
      materials,
      faceUp: action.faceUp,
      legal: isLegalSubmission(plan, materials),
      effectActivated: false,
      effectTargetSeat: action.targetSeat,
    };
    actor.submitted.push(submission);
    actor.actionUsed = true;
    pushLog(
      next,
      `${actor.name}が${action.faceUp ? `公開で「${plan.name}」` : "伏せ企画"}を完成。添付素材 ${materials.length}枚。`,
      action.faceUp ? "good" : "warning",
    );
    if (action.faceUp && submission.legal) activateEffect(next, actor, submission, "公開提出");
    if (action.faceUp && !submission.legal) pushLog(next, `「${plan.name}」は素材不足。BALKUの対象になります。`, "danger");
    finishActionAndAdvance(next);
    return next;
  }
  return next;
}

/**
 * 退出処理。
 * - ロビー時: 配列から完全に削除し、seatを振り直して整合性を保つ
 * - ゲーム中: eliminated = true に設定。activeSeatが退出者だった場合は
 *   次のターンへ自動進行し、全員脱落か残り1社なら即座に終了判定する
 */
export function removePlayerFromState(state: RoomGameState, playerSeat: number): RoomGameState {
  const next = structuredClone(state);
  const playerIndex = next.players.findIndex((p) => p.seat === playerSeat);
  if (playerIndex === -1) throw new Error("プレイヤーが見つかりません。");
  const player = next.players[playerIndex];

  if (next.phase === "lobby") {
    next.players.splice(playerIndex, 1);
    next.players.forEach((p, i) => {
      p.seat = i;
    });
    pushLog(next, `${player.name}が退出しました。`, "warning");
    return next;
  }

  player.eliminated = true;
  player.hand = [];
  player.submitted = [];

  const wasActive = next.activeSeat === playerSeat;
  const activePlayers = next.players.filter((p) => !p.eliminated);

  if (activePlayers.length <= 1 && next.phase === "active") {
    finishByScore(next);
    pushLog(next, `${player.name}が退出。${activePlayers.length === 1 ? `残り1社で${activePlayers[0]?.name}の勝利。` : "全社脱落で対戦終了。"}`, "danger");
    return next;
  }

  if (wasActive && next.phase === "active") {
    pushLog(next, `${player.name}が退出し、ターンをスキップ。`, "danger");
    advanceTurn(next);
  } else {
    pushLog(next, `${player.name}が退出し、脱落しました。`, "danger");
  }
  return next;
}

// --- 情報秘匿（元の routers.ts の snapshotFor を踏襲） ---

export type SnapshotSubmission = Submission & { materialCount: number };
export type SnapshotPlayer = Omit<GamePlayer, "hand" | "submitted"> & {
  /** 自分だけ中身が見える。他人は空配列で、枚数は handCount に入る。 */
  hand: GameCard[];
  handCount: number;
  submitted: SnapshotSubmission[];
};
export type BalkuSnapshot = Omit<RoomGameState, "deck" | "players"> & {
  deckCount: number;
  players: SnapshotPlayer[];
};

/**
 * 閲覧者向けに秘匿したスナップショットを作る。
 * 山札は残り枚数だけ、他人の手札は枚数だけ、他人の伏せ企画は
 * プロジェクト名・点数・legal・発動状態を隠し、素材は枚数だけ残す。
 */
export function snapshotFor(state: RoomGameState, viewerSeat: number): BalkuSnapshot {
  const { deck, ...visibleState } = state;
  return {
    ...visibleState,
    deckCount: deck.length,
    players: state.players.map((player) => ({
      ...player,
      hand: player.seat === viewerSeat ? player.hand : [],
      handCount: player.hand.length,
      submitted: player.submitted.map((submission) => {
        const visible = submission.faceUp || player.seat === viewerSeat;
        return visible
          ? { ...submission, materialCount: submission.materials.length }
          : {
              ...submission,
              legal: false,
              effectActivated: false,
              project: {
                ...submission.project,
                name: "非開示企画",
                points: 0,
                requirements: {},
                effect: { type: "coins" as const, amount: 0, label: "BALKUで開示" },
              },
              materials: [],
              materialCount: submission.materials.length,
            };
      }),
    })),
  };
}
