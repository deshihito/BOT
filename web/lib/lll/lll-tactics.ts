// LLL「高密度化」の戦術カード定義（仕様: lll-density-spec §3〜§4）。
// アクターカード（lll-game.ts）とは別の第2のカード種で、効果はすべて
// データ駆動のプリミティブで表す。解決ロジックは lll-battle.ts 側にあり、
// このファイルは定義とデッキ分布だけを持つ（エンジンからもサーバーからも
// クライアント表示からも参照される純データ）。
//
// 調整の原則（仕様 §0）: 勝率の調整は効果文ではなく収録コピー枚数で行う。
// TACTIC_DECKS の配分は本番エンジンで再検証した値（詳細は TACTIC_DECKS の
// コメント）。プロトタイプ検証時の分布とはコピー枚数だけが異なる。

import type { BattleStatusKind } from "./lll-battle";

/** 効果プリミティブ。k が判別子。数値の意味は lll-battle.ts の解決器が正。 */
export type TacticEffect =
  | { k: "dmg"; power: number; target?: "enemyLowest" | "enemyStatused"; onKill?: TacticEffect[] }
  | { k: "dmgAll"; power: number }
  | { k: "dmgEcho"; base: number; per: number; cap: number }
  | { k: "dmgWounded"; wounded: number; normal: number; pct: number }
  | { k: "dmgPerStatus"; base: number; per: number; cap: number }
  | { k: "dmgExecute"; power: number; bonus: number; pct: number }
  | { k: "dmgIfStatus"; status: BattleStatusKind; power: number; elseStatus: BattleStatusKind }
  | { k: "dmgToAttacker"; power: number; targetKey?: string }
  | { k: "dmgDirect"; power: number }
  | { k: "extraAttack"; power: number; killDraw: number }
  | { k: "echoLast" }
  | { k: "draw"; n: number }
  | { k: "drawEcho"; base: number; bonusAt: number; bonus: number }
  | { k: "discardRandom"; n: number }
  | { k: "tp"; n: number; exemptTpLimit?: boolean }
  | { k: "status"; status: BattleStatusKind; target?: "enemyLowest" | "linked" }
  | { k: "shield"; n: number; target?: "linked" | "allyLowest" }
  | { k: "shieldEcho"; base: number; per: number; cap: number }
  | { k: "heal"; power: number }
  | { k: "buff"; mult: number; turns: number }
  | { k: "stance"; reflect: number }
  | { k: "recall" };

/** 連鎖条件・プレイ条件。「このターンの出来事」と盤面状態を参照する。 */
export type TacticCond =
  | { k: "dmgThisTurn"; n: number }
  | { k: "cardsThisTurn"; n: number }
  | { k: "statusThisTurn"; status: BattleStatusKind }
  | { k: "tagThisTurn"; tag: string }
  | { k: "discardAtLeast"; n: number }
  | { k: "handAtLeast"; n: number }
  | { k: "enemyAnyStatus" };

export type TacticReserve = {
  trigger: "allyDamaged" | "allyDamagedBySkill" | "allyDamagedReduce" | "allyDeath";
  minPower?: number;
  amount?: number;
  effects: TacticEffect[];
};

export type TacticCardDef = {
  id: string;
  setId: "A" | "B" | "C";
  name: string;
  cost: number;
  tags: string[];
  /** プレイ自体の条件（プレイ前の出来事だけで判定する）。 */
  requires?: TacticCond;
  effects: TacticEffect[];
  /** 主効果の解決後に条件が真なら追加で解決する。連鎖は1段だけ。 */
  chain?: { cond: TacticCond; effects: TacticEffect[] };
  /** 設置カード。プレイしても解決されず場に伏せられる。 */
  reserve?: TacticReserve;
  /** プレイヤー向けの効果文（UI表示用）。 */
  text: string;
};

const T = (def: TacticCardDef): TacticCardDef => def;

export const TACTIC_CARDS: TacticCardDef[] = [
  /* --- セットA（仮称：連鎖の歯車） --- */
  T({ id: "A1", setId: "A", name: "追い風の小太刀", cost: 0, tags: ["連鎖", "攻撃"],
    requires: { k: "dmgThisTurn", n: 1 },
    effects: [{ k: "dmg", power: 25 }],
    chain: { cond: { k: "cardsThisTurn", n: 2 }, effects: [{ k: "draw", n: 1 }] },
    text: "このターンにダメージを与えている場合のみ使用可。威力25。連鎖：このターン2枚目以降なら1枚引く。" }),
  T({ id: "A2", setId: "A", name: "連鎖の火種", cost: 1, tags: ["連鎖", "状態"],
    effects: [{ k: "status", status: "burn" }],
    chain: { cond: { k: "cardsThisTurn", n: 2 }, effects: [{ k: "dmg", power: 20 }] },
    text: "敵1体にやけどを付与。連鎖：このターン2枚目以降なら威力20。" }),
  T({ id: "A3", setId: "A", name: "歯車の回転", cost: 0, tags: ["連鎖", "ドロー"],
    requires: { k: "cardsThisTurn", n: 1 },
    effects: [{ k: "draw", n: 1 }],
    text: "このターンに1枚以上プレイしている場合のみ使用可。1枚引く。" }),
  T({ id: "A4", setId: "A", name: "二度打ち", cost: 2, tags: ["連鎖", "攻撃"],
    effects: [{ k: "dmg", power: 30 }, { k: "dmg", power: 30 }],
    text: "威力30のダメージを2回。" }),
  T({ id: "A5", setId: "A", name: "勢いの継承", cost: 1, tags: ["連鎖", "TP"],
    effects: [{ k: "tp", n: 1 }],
    chain: { cond: { k: "cardsThisTurn", n: 3 }, effects: [{ k: "tp", n: 1 }] },
    text: "TP+1（同名は1ターン1回まで）。連鎖：このターン3枚目以降ならさらにTP+1。" }),
  T({ id: "A6", setId: "A", name: "連鎖防御網", cost: 1, tags: ["連鎖", "防御"],
    effects: [{ k: "shield", n: 40, target: "linked" }],
    chain: { cond: { k: "dmgThisTurn", n: 1 }, effects: [{ k: "shield", n: 20, target: "linked" }] },
    text: "行動中の味方にシールド40。連鎖：このターンにダメージを与えていれば追加でシールド20。" }),
  T({ id: "A7", setId: "A", name: "火花の連弾", cost: 2, tags: ["連鎖", "攻撃"],
    requires: { k: "dmgThisTurn", n: 1 },
    effects: [{ k: "dmg", power: 35 }],
    chain: { cond: { k: "cardsThisTurn", n: 3 }, effects: [{ k: "dmg", power: 35 }] },
    text: "このターンにダメージを与えている場合のみ使用可。威力35。連鎖：このターン3枚目以降ならもう一度威力35。" }),
  T({ id: "A8", setId: "A", name: "小さな歯車", cost: 0, tags: ["連鎖", "攻撃"],
    effects: [{ k: "dmg", power: 15 }],
    chain: { cond: { k: "cardsThisTurn", n: 1 }, effects: [{ k: "draw", n: 1 }] },
    text: "威力15。連鎖：このターン1枚以上プレイしていれば1枚引く。" }),
  T({ id: "A9", setId: "A", name: "増幅歯車", cost: 1, tags: ["連鎖", "強化"],
    effects: [{ k: "buff", mult: 1.2, turns: 2 }],
    chain: { cond: { k: "tagThisTurn", tag: "連鎖" }, effects: [{ k: "draw", n: 1 }] },
    text: "行動中の味方のATK×1.2（2ターン）。連鎖：このターン「連鎖」タグを使っていれば1枚引く。" }),
  T({ id: "A10", setId: "A", name: "連鎖の楔", cost: 1, tags: ["連鎖", "状態"],
    effects: [{ k: "status", status: "guard_break" }],
    chain: { cond: { k: "statusThisTurn", status: "guard_break" }, effects: [{ k: "dmg", power: 25 }] },
    text: "敵1体に防御崩しを付与。連鎖：このターン防御崩しを付与していれば威力25。" }),
  T({ id: "A11", setId: "A", name: "回転加速", cost: 2, tags: ["連鎖", "ドロー"],
    effects: [{ k: "draw", n: 2 }],
    chain: { cond: { k: "cardsThisTurn", n: 2 }, effects: [{ k: "tp", n: 1 }] },
    text: "2枚引く。連鎖：このターン2枚目以降ならTP+1。" }),
  T({ id: "A12", setId: "A", name: "大歯車の噛み合い", cost: 2, tags: ["連鎖", "攻撃"],
    requires: { k: "cardsThisTurn", n: 2 },
    effects: [{ k: "dmgAll", power: 20 }],
    chain: { cond: { k: "cardsThisTurn", n: 4 }, effects: [{ k: "dmgAll", power: 20 }] },
    text: "このターン2枚以上プレイしている場合のみ使用可。敵全体に威力20。連鎖：4枚目以降ならもう一度全体に威力20。" }),

  /* --- セットB（仮称：残響） --- */
  T({ id: "B1", setId: "B", name: "残響の一撃", cost: 1, tags: ["残響", "攻撃"],
    effects: [{ k: "dmgEcho", base: 15, per: 5, cap: 40 }],
    text: "威力 = 15＋自分の捨札1枚につき5（上限40）。" }),
  T({ id: "B2", setId: "B", name: "墓標の参照", cost: 1, tags: ["残響", "ドロー"],
    effects: [{ k: "drawEcho", base: 1, bonusAt: 5, bonus: 1 }],
    text: "1枚引く。自分の捨札が5枚以上なら追加で1枚引く。" }),
  T({ id: "B3", setId: "B", name: "残響回復", cost: 2, tags: ["残響", "回復"],
    effects: [{ k: "heal", power: 45 }],
    chain: { cond: { k: "discardAtLeast", n: 8 }, effects: [{ k: "heal", power: 30 }] },
    text: "最も傷ついた味方を回復45。連鎖：自分の捨札8枚以上なら追加で回復30。" }),
  T({ id: "B4", setId: "B", name: "過去の炎", cost: 1, tags: ["残響", "状態"],
    effects: [{ k: "dmgIfStatus", status: "burn", power: 40, elseStatus: "burn" }],
    text: "対象がやけど状態なら威力40。そうでなければやけどを付与。" }),
  T({ id: "B5", setId: "B", name: "静かな観測", cost: 1, tags: ["残響", "ドロー"],
    effects: [{ k: "draw", n: 1 }],
    text: "1枚引く。" }),
  T({ id: "B6", setId: "B", name: "手札の残響", cost: 0, tags: ["残響", "TP"],
    requires: { k: "handAtLeast", n: 5 },
    effects: [{ k: "draw", n: 2 }, { k: "discardRandom", n: 1 }, { k: "tp", n: 1 }],
    text: "手札5枚以上の場合のみ使用可。2枚引いて1枚捨て、TP+1（同名は1ターン1回まで）。" }),
  T({ id: "B7", setId: "B", name: "残響の盾", cost: 1, tags: ["残響", "防御"],
    effects: [{ k: "shieldEcho", base: 20, per: 5, cap: 60 }],
    text: "最も傷ついた味方にシールド = 20＋自分の捨札1枚につき5（上限60）。" }),
  T({ id: "B8", setId: "B", name: "血の残響", cost: 1, tags: ["残響", "攻撃"],
    effects: [{ k: "dmgWounded", wounded: 45, normal: 20, pct: 0.5 }],
    text: "味方のいずれかがHP50%未満なら威力45、そうでなければ威力20。" }),
  T({ id: "B9", setId: "B", name: "呼び戻し", cost: 2, tags: ["残響", "回収"],
    effects: [{ k: "recall" }],
    chain: { cond: { k: "discardAtLeast", n: 6 }, effects: [{ k: "tp", n: 1 }] },
    text: "自分の捨札から戦術カード1枚（このカード以外）を手札に戻す。連鎖：捨札6枚以上ならTP+1。" }),
  T({ id: "B10", setId: "B", name: "残響連鎖", cost: 1, tags: ["残響", "複写"],
    effects: [{ k: "echoLast" }],
    text: "このターン最後に使った自分の戦術カードの攻撃・状態効果を、威力半分で再実行する。前例がなければ1枚引く。" }),
  T({ id: "B11", setId: "B", name: "深い残響", cost: 2, tags: ["残響", "攻撃"],
    requires: { k: "discardAtLeast", n: 4 },
    effects: [{ k: "dmgAll", power: 25 }],
    text: "自分の捨札4枚以上の場合のみ使用可。敵全体に威力25。" }),
  T({ id: "B12", setId: "B", name: "終末の残響", cost: 2, tags: ["残響", "攻撃"],
    effects: [{ k: "dmg", power: 30 }],
    chain: { cond: { k: "discardAtLeast", n: 10 }, effects: [{ k: "dmg", power: 30 }] },
    text: "威力30。連鎖：自分の捨札10枚以上ならもう一度威力30。" }),

  /* --- セットC（仮称：追撃と反撃） --- */
  T({ id: "C1", setId: "C", name: "追撃の矢", cost: 0, tags: ["追撃", "攻撃"],
    requires: { k: "enemyAnyStatus" },
    effects: [{ k: "dmg", power: 30, target: "enemyStatused" }],
    text: "状態異常の敵がいる場合のみ使用可。状態異常の敵のうち最もHPが低い相手に威力30。" }),
  T({ id: "C2", setId: "C", name: "痛手への追撃", cost: 1, tags: ["追撃", "攻撃"],
    effects: [{ k: "dmgExecute", power: 25, bonus: 25, pct: 0.5 }],
    text: "威力25。対象のHPが50%未満なら威力が+25。" }),
  T({ id: "C3", setId: "C", name: "反撃の構え", cost: 1, tags: ["設置"],
    effects: [],
    reserve: { trigger: "allyDamaged", effects: [{ k: "dmgToAttacker", power: 30 }] },
    text: "設置：味方がダメージを受けたら、攻撃者に威力30で反撃する。" }),
  T({ id: "C4", setId: "C", name: "庇う盾", cost: 1, tags: ["設置"],
    effects: [],
    reserve: { trigger: "allyDamagedReduce", amount: 30, effects: [] },
    text: "設置：味方が受ける次のダメージを30軽減する。" }),
  T({ id: "C5", setId: "C", name: "追撃命令", cost: 1, tags: ["追撃", "攻撃"],
    effects: [{ k: "extraAttack", power: 40, killDraw: 2 }],
    text: "行動中の味方が即座に威力40で追加攻撃する。これで敵を倒したら2枚引く。" }),
  T({ id: "C6", setId: "C", name: "状態追撃", cost: 1, tags: ["追撃", "攻撃"],
    effects: [{ k: "dmgPerStatus", base: 20, per: 15, cap: 65 }],
    text: "威力 = 20＋対象の状態異常1種につき15（上限65）。" }),
  T({ id: "C7", setId: "C", name: "逆襲の牙", cost: 2, tags: ["設置"],
    effects: [],
    reserve: { trigger: "allyDamagedBySkill", minPower: 55, effects: [{ k: "dmgToAttacker", power: 50 }] },
    text: "設置：味方が威力55以上の技でダメージを受けたら、攻撃者に威力50で反撃する。" }),
  T({ id: "C8", setId: "C", name: "追撃の連鎖", cost: 0, tags: ["追撃", "連鎖", "攻撃"],
    requires: { k: "dmgThisTurn", n: 2 },
    effects: [{ k: "dmg", power: 25 }],
    text: "このターンに2回以上ダメージを与えている場合のみ使用可。威力25。" }),
  T({ id: "C9", setId: "C", name: "止めの宣告", cost: 2, tags: ["追撃", "攻撃"],
    effects: [{ k: "dmg", power: 35, onKill: [{ k: "tp", n: 2, exemptTpLimit: true }, { k: "draw", n: 1 }] }],
    text: "威力35。これで敵を倒したらTP+2、1枚引く。" }),
  T({ id: "C10", setId: "C", name: "反撃準備", cost: 1, tags: ["追撃", "防御"],
    effects: [{ k: "draw", n: 1 }, { k: "stance", reflect: 20 }],
    text: "1枚引く。行動中の味方は、次の被弾1回につき威力20を反射する構えを得る（被弾で消費）。" }),
  T({ id: "C11", setId: "C", name: "追い討ちの雨", cost: 2, tags: ["追撃", "攻撃"],
    effects: [{ k: "dmgAll", power: 15 }, { k: "dmg", power: 25 }],
    text: "敵全体に威力15、その後で敵1体に威力25。" }),
  T({ id: "C12", setId: "C", name: "最後の反撃", cost: 2, tags: ["設置"],
    effects: [],
    reserve: { trigger: "allyDeath", effects: [{ k: "dmgAll", power: 30 }, { k: "draw", n: 2 }] },
    text: "設置：味方が倒れたら、敵全体に威力30、自分は2枚引く。" }),
];

export const TACTIC_CARD_BY_ID: ReadonlyMap<string, TacticCardDef> = new Map(
  TACTIC_CARDS.map((card) => [card.id, card]),
);

/**
 * プリセットデッキ（各30枚）。id のキーは TacticCardDef.id。
 * 分布は本番エンジン（lll-battle.ts）上で再検証した最終値: スターター同士の
 * ミラー戦・担当サイド交互・各対戦1,000試合で、総合勝率 chain 0.508 /
 * echo 0.490 / pursuit 0.498（帯域0.45〜0.55）、平均プレイ/ターンは
 * 2.06〜2.21。プロトタイプ検証時の分布から、本番のアクターCPU方策に
 * 合わせてコピー枚数のみで再調整した（効果文は仕様どおり不変）。
 */
export const TACTIC_DECKS: Record<string, { name: string; description: string; counts: Record<string, number> }> = {
  chain: {
    name: "連鎖の歯車",
    description: "切った枚数がそのまま火力に返る連鎖型。まず触るならこれ。",
    counts: { A1: 1, A2: 2, A3: 3, A4: 2, A5: 2, A6: 1, A7: 2, A8: 2, A9: 2, A10: 3, A11: 2, A12: 1, B5: 5, C8: 2 },
  },
  echo: {
    name: "残響",
    description: "捨札が貯まるほど伸びる蓄積型。後半の伸びで押し返す。",
    counts: { B1: 2, B2: 3, B3: 1, B4: 3, B5: 3, B6: 2, B7: 2, B8: 3, B9: 2, B10: 2, B11: 3, B12: 1, A3: 2, A8: 1 },
  },
  pursuit: {
    name: "追撃と反撃",
    description: "状態異常への追撃と設置の自動反撃で相手の行動に食らいつく。",
    counts: { C1: 1, C2: 2, C3: 2, C4: 2, C5: 1, C6: 2, C7: 1, C8: 3, C9: 3, C10: 3, C11: 1, C12: 1, A1: 2, B5: 6 },
  },
};

export function tacticDeckList(deckId: string): string[] | null {
  const deck = TACTIC_DECKS[deckId];
  if (!deck) return null;
  const out: string[] = [];
  for (const [cardId, count] of Object.entries(deck.counts)) {
    for (let i = 0; i < count; i++) out.push(cardId);
  }
  return out;
}

/** ラダー敵の戦術デッキ（仕様 §9 の既定: Tier0〜3は無し、Tier4以上が持つ）。 */
export const ENEMY_TACTIC_DECK_BY_TIER: (string | null)[] = [
  null, null, null, null, "chain", "echo", "pursuit", "echo",
];

export const TACTIC_INITIAL_HAND = 4;
export const TACTIC_DRAW_PER_ROUND = 2;
export const TACTIC_HAND_LIMIT = 8;
export const TACTIC_TP_PER_ROUND = 5;
export const TACTIC_RESERVE_LIMIT = 2;
export const TACTIC_CHAIN_DEPTH_CAP = 3;
