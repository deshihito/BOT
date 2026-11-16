// ハーツ（4人トリックテイキング、自分＋CPU3人）の純粋ロジック。
// UI 非依存・シード決定的。カードは id 0〜51（suit = floor(id/13): 0=スペード,
// 1=ハート, 2=ダイヤ, 3=クラブ、rank = (id % 13) + 1、1=A）で表す（texas と同じ作法）。
//
// ルール:
// - 各ハンド開始時に3枚パスする。方向はハンドごとに 左→右→向かい→パスなし の順で回る。
// - クラブの2を持つ人が最初のトリックをリードし、必ずクラブの2を出す。
// - リードされたスートを持っていれば必ずフォローする（出さなければならない）。
// - 最初のトリックでは、クラブが無くてもハートとスペードのQは捨てられない
//   （他の捨て札がある限り）。
// - ハートは「切れる」（他のスートにハートが捨てられる）までリードできない。
//   ただし手札がハートだけの場合はリードできる。
// - トリックはリードスートの最強カードを出した人が取り、次のリードになる。
// - 得点（悪い点）: ハート各1点、スペードのQが13点。1ハンド合計26点。
// - シュート・ザ・ムーン: 1人で26点全部を取ると、その人は0点・他全員が26点。
// - ゲーム終了: ハンド終了時点で誰かが100点以上になったら終了（安全のため
//   16ハンドで打ち切り）。最終スコアが一番小さい人が勝ち（同点は複数優勝）。
//
// CPU の方針（決定的・単純）:
// - パス: スペードのA/K（Qを被る危険）を優先して手放し、スペードが3枚以下なら
//   Qも手放す。次に高いハート、短いスートの高い札の順に3枚選ぶ。
// - リード: ハート以外の最長スートの最小札（ハートしか無い/切れた場合は全体の最小）。
// - フォロー: トリックに点がある場合は勝たない範囲で一番高い札を捨て、
//   勝ってしまう場合は一番低い札。点が無い場合は勝たない範囲で一番高い札、
//   無ければ一番低い札で安く取る。スペードのA/Kが出ているトリックではQを捨てる。
// - 切り札的に捨てる場合（ボイド）: Q♠ → A♠ → K♠ → 一番高いハート →
//   最長スートの一番高い札 の順。

export const HEARTS_TARGET_SCORE = 100;
export const HEARTS_MAX_HANDS = 16;
export const HEARTS_PASS_COUNT = 3;

export type HeartsSuit = "spade" | "heart" | "diamond" | "club";
export type HeartsPhase = "pass" | "play" | "handEnd" | "finished";

const SUITS: HeartsSuit[] = ["spade", "heart", "diamond", "club"];

export function cardSuit(id: number): HeartsSuit {
  return SUITS[Math.floor(id / 13)] ?? "spade";
}

/** 1=A, 2〜10, 11=J, 12=Q, 13=K。 */
export function cardRank(id: number): number {
  return (id % 13) + 1;
}

/** 強さ（A が最強 = 14）。 */
export function cardStrength(id: number): number {
  const r = cardRank(id);
  return r === 1 ? 14 : r;
}

export function cardId(suit: HeartsSuit, rank: number): number {
  return SUITS.indexOf(suit) * 13 + (rank - 1);
}

export const QUEEN_OF_SPADES = cardId("spade", 12);
export const TWO_OF_CLUBS = cardId("club", 2);

/** そのカードのマイナス点（ハート1点、スペードのQは13点、それ以外0）。 */
export function pointsOfCard(id: number): number {
  if (id === QUEEN_OF_SPADES) return 13;
  return cardSuit(id) === "heart" ? 1 : 0;
}

export function pointsOfCards(cards: readonly number[]): number {
  return cards.reduce((sum, c) => sum + pointsOfCard(c), 0);
}

export interface HeartsPlayer {
  seat: number;
  name: string;
  isCpu: boolean;
  /** 手札（スート・強さ順にソート済み）。 */
  hand: number[];
  /** このハンドで取ったカード。 */
  taken: number[];
  score: number;
}

export interface HeartsTrickPlay {
  seat: number;
  card: number;
}

export interface HeartsState {
  seed: number;
  rng: number;
  /** 0 始まり。 */
  handNumber: number;
  /** 0=左(+1), 1=右(-1), 2=向かい(+2), 3=パスなし。handNumber % 4 と一致。 */
  passDir: number;
  phase: HeartsPhase;
  players: HeartsPlayer[];
  /** pass フェーズ中に CPU が出す予定のパス（seat -> カード）。人間は含まない。 */
  cpuPasses: Record<number, number[]>;
  heartsBroken: boolean;
  /** 現在のトリックの出札（順番どおり）。 */
  trick: HeartsTrickPlay[];
  leader: number;
  turn: number;
  tricksPlayed: number;
  lastTrick: { plays: HeartsTrickPlay[]; winner: number } | null;
  /** このハンドで各プレイヤーに加算された点（ムーン調整後）。handEnd 以降のみ。 */
  handPoints: number[] | null;
  /** ムーンを決めた seat。無ければ null。 */
  moonShooter: number | null;
  /** finished 時の優勝者 seat 群。 */
  winners: number[] | null;
  message: string;
}

// ---------------------------------------------------------------- utilities

/** mulberry32。状態を数値で持ち回る。 */
function nextRandom(rng: number): { value: number; rng: number } {
  let t = (rng + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, rng: t | 0 };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function sortHand(hand: number[]): number[] {
  return [...hand].sort((a, b) => {
    const s = Math.floor(a / 13) - Math.floor(b / 13);
    if (s !== 0) return s;
    return cardStrength(a) - cardStrength(b);
  });
}

function passOffset(passDir: number): number {
  if (passDir === 0) return 1;
  if (passDir === 1) return 3; // 右 = -1
  if (passDir === 2) return 2;
  return 0;
}

export const PASS_DIR_LABELS = ["左の人へ", "右の人へ", "向かいの人へ", "パスなし"] as const;

// ---------------------------------------------------------------- CPU

/** CPU（およびテスト用の自動操作）がパスする3枚を決める。hand は13枚想定。 */
export function chooseCpuPass(hand: readonly number[]): number[] {
  const spades = hand.filter((c) => cardSuit(c) === "spade");
  const suitCount = (suit: HeartsSuit) => hand.filter((c) => cardSuit(c) === suit).length;
  const priority = (card: number): number => {
    const suit = cardSuit(card);
    const strength = cardStrength(card);
    if (card === cardId("spade", 1)) return 90; // A♠ は Q を被る危険が大きい
    if (card === cardId("spade", 13)) return 85; // K♠ も同様
    if (card === QUEEN_OF_SPADES) return spades.length <= 3 ? 95 : 10; // 守りが薄いなら手放す
    if (suit === "heart" && strength >= 11) return 60 + strength; // 高いハート
    // 短いスートの高い札から手放してボイドを作る
    return (4 - suitCount(suit)) * 20 + strength;
  };
  return [...hand]
    .sort((a, b) => priority(b) - priority(a) || a - b)
    .slice(0, HEARTS_PASS_COUNT)
    .sort((a, b) => a - b);
}

/** seat が今出せるカード一覧（ルールで許可されるものだけ）。 */
export function legalPlaysFor(state: HeartsState, seat: number): number[] {
  const player = state.players[seat];
  if (!player || state.phase !== "play") return [];
  const hand = player.hand;
  if (hand.length === 0) return [];
  if (state.trick.length === 0) {
    // リード
    if (state.tricksPlayed === 0) {
      return hand.includes(TWO_OF_CLUBS) ? [TWO_OF_CLUBS] : [];
    }
    if (state.heartsBroken) return [...hand];
    const nonHearts = hand.filter((c) => cardSuit(c) !== "heart");
    return nonHearts.length > 0 ? nonHearts : [...hand];
  }
  const ledSuit = cardSuit(state.trick[0].card);
  const follow = hand.filter((c) => cardSuit(c) === ledSuit);
  if (follow.length > 0) return follow;
  // ボイド: 最初のトリックだけ点札を捨てられない（他に捨て札がある限り）
  if (state.tricksPlayed === 0) {
    const nonPoints = hand.filter((c) => pointsOfCard(c) === 0);
    if (nonPoints.length > 0) return nonPoints;
  }
  return [...hand];
}

/** 人間（seat 0）が今出せるカード。手番でなければ空。 */
export function legalPlays(state: HeartsState): number[] {
  if (state.phase !== "play" || state.turn !== 0) return [];
  return legalPlaysFor(state, 0);
}

/** CPU の1手。legalPlaysFor の中から方針（ファイル冒頭の記述）で決定的に選ぶ。 */
export function chooseCpuPlay(state: HeartsState, seat: number): number {
  const legal = legalPlaysFor(state, seat);
  if (legal.length === 0) throw new Error("出せるカードがありません");
  if (legal.length === 1) return legal[0];
  const byStrength = (a: number, b: number) => cardStrength(a) - cardStrength(b) || a - b;

  if (state.trick.length === 0) {
    // リード: ハート以外があれば、その最長スートの最小札。
    const nonHearts = legal.filter((c) => cardSuit(c) !== "heart");
    const pool = nonHearts.length > 0 ? nonHearts : legal;
    const counts = new Map<HeartsSuit, number>();
    for (const c of pool) counts.set(cardSuit(c), (counts.get(cardSuit(c)) ?? 0) + 1);
    let bestSuit: HeartsSuit = cardSuit(pool[0]);
    for (const [suit, n] of counts) {
      if (n > (counts.get(bestSuit) ?? 0)) bestSuit = suit;
    }
    const inSuit = pool.filter((c) => cardSuit(c) === bestSuit).sort(byStrength);
    return inSuit[0];
  }

  const ledSuit = cardSuit(state.trick[0].card);
  const follow = legal.filter((c) => cardSuit(c) === ledSuit);
  const trickHasPoints = state.trick.some((p) => pointsOfCard(p.card) > 0);
  if (follow.length > 0) {
    // スペードで Q を持っていて、A/K が場に出ていたら Q を捨てる。
    if (ledSuit === "spade" && follow.includes(QUEEN_OF_SPADES)) {
      const highSpadeOut = state.trick.some(
        (p) => cardSuit(p.card) === "spade" && cardStrength(p.card) > 12,
      );
      if (highSpadeOut) return QUEEN_OF_SPADES;
    }
    const winnerStrength = Math.max(
      ...state.trick.filter((p) => cardSuit(p.card) === ledSuit).map((p) => cardStrength(p.card)),
    );
    const below = follow.filter((c) => cardStrength(c) < winnerStrength).sort(byStrength);
    const sorted = [...follow].sort(byStrength);
    if (below.length > 0) return below[below.length - 1]; // 勝たない範囲で一番高い札を捨てる
    return sorted[0]; // 勝ってしまう場合は一番低い札
  }

  // ボイド: 危険札・点札から捨てる。
  if (legal.includes(QUEEN_OF_SPADES)) return QUEEN_OF_SPADES;
  const aceSpade = cardId("spade", 1);
  if (legal.includes(aceSpade)) return aceSpade;
  const kingSpade = cardId("spade", 13);
  if (legal.includes(kingSpade)) return kingSpade;
  const hearts = legal.filter((c) => cardSuit(c) === "heart").sort(byStrength);
  if (hearts.length > 0) return hearts[hearts.length - 1];
  const counts = new Map<HeartsSuit, number>();
  for (const c of legal) counts.set(cardSuit(c), (counts.get(cardSuit(c)) ?? 0) + 1);
  let bestSuit: HeartsSuit = cardSuit(legal[0]);
  for (const [suit, n] of counts) {
    if (n > (counts.get(bestSuit) ?? 0)) bestSuit = suit;
  }
  const inSuit = legal.filter((c) => cardSuit(c) === bestSuit).sort(byStrength);
  return inSuit[inSuit.length - 1];
}

// ---------------------------------------------------------------- internals

function dealHand(rng: number, handNumber: number, scores: number[]): HeartsState {
  let r = rng | 0;
  const deck = Array.from({ length: 52 }, (_, i) => i);
  for (let i = deck.length - 1; i > 0; i--) {
    const n = nextRandom(r);
    r = n.rng;
    const j = Math.floor(n.value * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  const names = ["あなた", "CPU 1", "CPU 2", "CPU 3"];
  const players: HeartsPlayer[] = names.map((name, seat) => ({
    seat,
    name,
    isCpu: seat !== 0,
    hand: sortHand(deck.slice(seat * 13, seat * 13 + 13)),
    taken: [],
    score: scores[seat] ?? 0,
  }));
  const passDir = handNumber % 4;
  const cpuPasses: Record<number, number[]> = {};
  if (passDir !== 3) {
    for (const p of players) {
      if (p.isCpu) cpuPasses[p.seat] = chooseCpuPass(p.hand);
    }
  }
  const leader = players.find((p) => p.hand.includes(TWO_OF_CLUBS))?.seat ?? 0;
  const state: HeartsState = {
    seed: 0,
    rng: r,
    handNumber,
    passDir,
    phase: passDir === 3 ? "play" : "pass",
    players,
    cpuPasses,
    heartsBroken: false,
    trick: [],
    leader,
    turn: leader,
    tricksPlayed: 0,
    lastTrick: null,
    handPoints: null,
    moonShooter: null,
    winners: null,
    message:
      passDir === 3
        ? "このハンドはパスなしです。クラブの2から始まります。"
        : `${PASS_DIR_LABELS[passDir]}パスする3枚を選んでください。`,
  };
  if (state.phase === "play") advanceCpu(state);
  return state;
}

function finishHand(draft: HeartsState): void {
  const raw = draft.players.map((p) => pointsOfCards(p.taken));
  const shooter = raw.findIndex((v) => v === 26);
  let handPoints: number[];
  if (shooter >= 0) {
    handPoints = raw.map((_, i) => (i === shooter ? 0 : 26));
    draft.moonShooter = shooter;
  } else {
    handPoints = raw;
    draft.moonShooter = null;
  }
  draft.handPoints = handPoints;
  draft.players.forEach((p, i) => {
    p.score += handPoints[i];
  });
  draft.phase = "handEnd";
  draft.message =
    shooter >= 0
      ? `${draft.players[shooter].name} がシュート・ザ・ムーン！ 他全員に26点です。`
      : "ハンド終了。スコアを確認してください。";
}

/** draft を破壊的に進める: seat の card を場に出す（検証済み前提）。 */
function applyPlay(draft: HeartsState, seat: number, card: number): void {
  const player = draft.players[seat];
  player.hand = player.hand.filter((c) => c !== card);
  if (draft.trick.length > 0 && cardSuit(card) === "heart" && cardSuit(draft.trick[0].card) !== "heart") {
    draft.heartsBroken = true;
  }
  if (cardSuit(card) === "heart" && draft.trick.length === 0) {
    draft.heartsBroken = true;
  }
  draft.trick.push({ seat, card });
  if (draft.trick.length < 4) {
    draft.turn = (seat + 1) % 4;
    return;
  }
  // トリック確定
  const ledSuit = cardSuit(draft.trick[0].card);
  let winner = draft.trick[0].seat;
  let best = -1;
  for (const play of draft.trick) {
    if (cardSuit(play.card) === ledSuit && cardStrength(play.card) > best) {
      best = cardStrength(play.card);
      winner = play.seat;
    }
  }
  draft.players[winner].taken.push(...draft.trick.map((p) => p.card));
  draft.lastTrick = { plays: [...draft.trick], winner };
  draft.trick = [];
  draft.tricksPlayed += 1;
  draft.leader = winner;
  draft.turn = winner;
  if (draft.tricksPlayed >= 13) {
    finishHand(draft);
  }
}

/** CPU の手番を、人間の手番になるかフェーズが変わるまで進める（draft を破壊的に更新）。 */
function advanceCpu(draft: HeartsState): void {
  let guard = 0;
  while (draft.phase === "play" && draft.players[draft.turn].isCpu && guard < 60) {
    guard++;
    const card = chooseCpuPlay(draft, draft.turn);
    applyPlay(draft, draft.turn, card);
  }
  if (draft.phase === "play") {
    draft.message =
      draft.trick.length === 0
        ? draft.turn === 0
          ? "あなたのリードです。"
          : `${draft.players[draft.turn].name} のリードです。`
        : "あなたの番です。出せるカードが光っています。";
  }
}

// ---------------------------------------------------------------- public API

export function createHeartsGame(seed: number): HeartsState {
  const state = dealHand(seed | 0, 0, [0, 0, 0, 0]);
  state.seed = seed | 0;
  return state;
}

/** 人間（seat 0）のパスを確定し、全員の交換を同時に行う。 */
export function submitPass(state: HeartsState, cardIds: readonly number[]): HeartsState {
  if (state.phase !== "pass") throw new Error("今はパスできません");
  if (cardIds.length !== HEARTS_PASS_COUNT) throw new Error("パスは3枚です");
  if (new Set(cardIds).size !== cardIds.length) throw new Error("同じカードは2枚選べません");
  const myHand = state.players[0].hand;
  for (const c of cardIds) {
    if (!myHand.includes(c)) throw new Error("手札にないカードはパスできません");
  }
  const draft = clone(state);
  const offset = passOffset(draft.passDir);
  const passing: Record<number, number[]> = { ...draft.cpuPasses, 0: [...cardIds] };
  const received: Record<number, number[]> = { 0: [], 1: [], 2: [], 3: [] };
  for (let seat = 0; seat < 4; seat++) {
    const target = (seat + offset) % 4;
    received[target] = passing[seat] ?? [];
  }
  for (const p of draft.players) {
    const out = new Set(passing[p.seat] ?? []);
    p.hand = sortHand([...p.hand.filter((c) => !out.has(c)), ...received[p.seat]]);
  }
  draft.cpuPasses = {};
  draft.phase = "play";
  draft.leader = draft.players.find((p) => p.hand.includes(TWO_OF_CLUBS))?.seat ?? 0;
  draft.turn = draft.leader;
  draft.message = "パスが終わりました。クラブの2から始まります。";
  advanceCpu(draft);
  return draft;
}

/** 人間（seat 0）がカードを出す。 */
export function playCard(state: HeartsState, card: number): HeartsState {
  if (state.phase !== "play") throw new Error("今はカードを出せません");
  if (state.turn !== 0) throw new Error("あなたの手番ではありません");
  if (!legalPlaysFor(state, 0).includes(card)) throw new Error("そのカードは出せません");
  const draft = clone(state);
  applyPlay(draft, 0, card);
  advanceCpu(draft);
  return draft;
}

/** 次のハンドへ進む（handEnd のときだけ）。終了条件を満たせば finished になる。 */
export function nextHand(state: HeartsState): HeartsState {
  if (state.phase !== "handEnd") throw new Error("ハンドが終わっていません");
  const someoneOver = state.players.some((p) => p.score >= HEARTS_TARGET_SCORE);
  const reachedCap = state.handNumber + 1 >= HEARTS_MAX_HANDS;
  if (someoneOver || reachedCap) {
    const draft = clone(state);
    const min = Math.min(...draft.players.map((p) => p.score));
    draft.winners = draft.players.filter((p) => p.score === min).map((p) => p.seat);
    draft.phase = "finished";
    draft.message = draft.winners.includes(0)
      ? "ゲーム終了！ あなたの勝ちです。"
      : `ゲーム終了。勝者は ${draft.winners.map((s) => draft.players[s].name).join("・")} です。`;
    return draft;
  }
  const scores = state.players.map((p) => p.score);
  const next = dealHand(state.rng, state.handNumber + 1, scores);
  next.seed = state.seed;
  return next;
}
