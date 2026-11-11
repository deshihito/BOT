// A12フェーズの新規4本のロジック検証。
// - lib/wordsearch.ts: 配置の妥当性・決定性・発見判定（逆順含む）・直線検証
// - lib/baccarat.ts: 第3カードのルール表・配当・配布フロー
// - lib/online/games/liarsdice.ts: 宣言検証・チャレンジ開示（ワイルド）・脱落と勝敗・秘匿
// - lib/online/games/minority.ts: 少数派の残存ルール・同数/無回答の扱い・秘匿・ラウンド上限
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const webDir = path.join(import.meta.dirname, "..");
const libDir = path.join(webDir, "lib");

async function loadLib(name) {
  const src = fs.readFileSync(path.join(libDir, name), "utf8");
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));
}

function stripModuleSyntax(code) {
  return code
    .split("\n")
    .filter((line) => !/^import\s/.test(line))
    .map((line) =>
      line
        .replace(/^export\s+(?=(const|let|var|function|class)\s)/, "")
        .replace(/^export\s+(?=async\s+function)/, "")
        .replace(/^export\s*\{[^}]*\};?\s*$/, ""),
    )
    .join("\n");
}

async function loadOnline(name, exportsList) {
  const src = fs.readFileSync(path.join(libDir, "online", "games", name), "utf8");
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const code = stripModuleSyntax(js) + `\nexport { ${exportsList.join(", ")} };\n`;
  return import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
}

const ws = await loadLib("wordsearch.ts");
const bc = await loadLib("baccarat.ts");
const ld = await loadOnline("liarsdice.ts", ["gameModule", "ldCountFace", "ldIsRaise", "LD_START_DICE"]);
const mn = await loadOnline("minority.ts", ["gameModule", "MINORITY_QUESTIONS", "MN_MAX_ROUNDS"]);

const rngStub = () => 0.5;
const seats = (n) => Array.from({ length: n }, (_, i) => ({ seat: i, name: `P${i + 1}` }));

// ---------------------------------------------------------------- ワードサーチ

test("ワードサーチ: バンクは20語以上で全て4〜7文字、配置は8語でグリッドと一致する", () => {
  assert.ok(ws.WS_WORD_BANK.length >= 20);
  for (const w of ws.WS_WORD_BANK) {
    const len = [...w].length;
    assert.ok(len >= 4 && len <= 7, `${w} は ${len} 文字`);
  }
  for (const seed of [1, 7, 42, 999]) {
    const state = ws.createWordSearch(seed);
    assert.equal(state.grid.length, 81);
    assert.equal(state.placements.length, ws.WS_WORD_COUNT);
    for (const p of state.placements) {
      assert.ok(ws.WS_WORD_BANK.includes(p.word));
      assert.equal(p.cells.length, [...p.word].length);
      // 配置セルをグリッドでたどると単語になる。
      assert.equal(p.cells.map((i) => state.grid[i]).join(""), p.word);
    }
  }
});

test("ワードサーチ: 同じシードでは同じ盤面になる", () => {
  const a = ws.createWordSearch(123);
  const b = ws.createWordSearch(123);
  assert.deepEqual(a.grid, b.grid);
  assert.deepEqual(a.placements, b.placements);
});

test("ワードサーチ: 配置どおりの直線を選ぶと発見になり、逆向きでも発見になる", () => {
  let state = ws.createWordSearch(42);
  const [p0, p1] = state.placements;
  state = ws.selectLine(state, p0.cells[0], p0.cells[p0.cells.length - 1]);
  assert.deepEqual(state.found, [p0.word]);
  // 逆向き（終点→始点）でも見つかる。
  state = ws.selectLine(state, p1.cells[p1.cells.length - 1], p1.cells[0]);
  assert.deepEqual(state.found, [p0.word, p1.word]);
  assert.equal(state.status, "playing");
});

test("ワードサーチ: 直線でない選択は無効で、同じ単語の再選択はミスになる", () => {
  let state = ws.createWordSearch(7);
  // (0,0) → (1,2) は直線ではない。
  const same = ws.selectLine(state, 0, 11);
  assert.equal(same, state);
  const p0 = state.placements[0];
  state = ws.selectLine(state, p0.cells[0], p0.cells[p0.cells.length - 1]);
  assert.equal(state.mistakes, 0);
  state = ws.selectLine(state, p0.cells[0], p0.cells[p0.cells.length - 1]);
  assert.equal(state.mistakes, 1);
  assert.deepEqual(state.found, [p0.word]);
});

test("ワードサーチ: 全部見つけると won になる", () => {
  let state = ws.createWordSearch(2024);
  for (const p of state.placements) {
    state = ws.selectLine(state, p.cells[0], p.cells[p.cells.length - 1]);
  }
  assert.equal(state.found.length, state.placements.length);
  assert.equal(state.status, "won");
});

// ---------------------------------------------------------------- バカラ

test("バカラ: カード値と手札合計（一の位）", () => {
  const c = (rank) => ({ suit: 0, rank });
  assert.equal(bc.baccaratHandValue([c(9), c(8)]), 7);
  assert.equal(bc.baccaratHandValue([c(13), c(5)]), 5); // K は 0
  assert.equal(bc.baccaratHandValue([c(1), c(9)]), 0);
  assert.equal(bc.baccaratHandValue([c(11), c(12)]), 0); // J・Q は 0
});

test("バカラ: 第3カードのルール表（バンカー）", () => {
  // プレイヤーが止まった場合: バンカーは 0〜5 で引く。
  assert.equal(bc.baccaratBankerDraws(5, null), true);
  assert.equal(bc.baccaratBankerDraws(6, null), false);
  assert.equal(bc.baccaratBankerDraws(0, null), true);
  // バンカー3: プレイヤーの3枚目が 8 のときだけ止まる。
  assert.equal(bc.baccaratBankerDraws(3, 8), false);
  assert.equal(bc.baccaratBankerDraws(3, 9), true);
  // バンカー4: 2〜7 で引く。
  assert.equal(bc.baccaratBankerDraws(4, 1), false);
  assert.equal(bc.baccaratBankerDraws(4, 2), true);
  assert.equal(bc.baccaratBankerDraws(4, 7), true);
  assert.equal(bc.baccaratBankerDraws(4, 8), false);
  // バンカー5: 4〜7 で引く。
  assert.equal(bc.baccaratBankerDraws(5, 3), false);
  assert.equal(bc.baccaratBankerDraws(5, 4), true);
  // バンカー6: 6・7 で引く。7 は常に止まる。0〜2 は常に引く。
  assert.equal(bc.baccaratBankerDraws(6, 5), false);
  assert.equal(bc.baccaratBankerDraws(6, 6), true);
  assert.equal(bc.baccaratBankerDraws(6, 7), true);
  assert.equal(bc.baccaratBankerDraws(7, 6), false);
  assert.equal(bc.baccaratBankerDraws(2, 8), true);
  // プレイヤー: 0〜5 で引く。
  assert.equal(bc.baccaratPlayerDraws(5), true);
  assert.equal(bc.baccaratPlayerDraws(6), false);
});

test("バカラ: 配当（バンカー勝利は5%コミッション、タイは8倍、押しは返金）", () => {
  assert.equal(bc.baccaratPayout("player", 100, "player"), 100);
  assert.equal(bc.baccaratPayout("banker", 100, "banker"), 95);
  assert.equal(bc.baccaratPayout("banker", 50, "banker"), 47); // 47.5 → 切り捨て
  assert.equal(bc.baccaratPayout("tie", 100, "tie"), 800);
  assert.equal(bc.baccaratPayout("player", 100, "tie"), 0);
  assert.equal(bc.baccaratPayout("banker", 100, "tie"), 0);
  assert.equal(bc.baccaratPayout("player", 100, "banker"), -100);
  assert.equal(bc.baccaratPayout("tie", 100, "player"), -100);
});

/** 配布順（P1,P2,B1,B2,追加分…）の rank 列から、pop 順になる deck を作る。 */
function craftedState(ranksInDealOrder) {
  const fillers = Array.from({ length: 12 }, (_, i) => ({ suit: 3, rank: (i % 13) + 1 }));
  const dealCards = ranksInDealOrder.map((rank) => ({ suit: 0, rank }));
  const deck = [...fillers, ...dealCards.reverse()];
  return { ...bc.createBaccarat(1, 1000), deck };
}

test("バカラ: プレイヤーが止まればバンカーは5以下で3枚目を引く", () => {
  // P: 10(0)+6=6 で止まる。B: 2+3=5 → 引いて 9 → 合計4。プレイヤーの勝ち。
  let state = craftedState([10, 6, 2, 3, 9]);
  state = bc.placeBaccaratBet(state, "player", 100);
  assert.equal(state.playerCards.length, 2);
  assert.equal(state.bankerCards.length, 3);
  assert.equal(state.winner, "player");
  assert.equal(state.chips, 1100);
  assert.deepEqual(state.history, ["player"]);
});

test("バカラ: ナチュラル9では誰も引かない", () => {
  // P: 9+K(0)=9（ナチュラル）。B: 5+2=7。
  let state = craftedState([9, 13, 5, 2]);
  state = bc.placeBaccaratBet(state, "banker", 100);
  assert.equal(state.playerCards.length, 2);
  assert.equal(state.bankerCards.length, 2);
  assert.equal(state.winner, "player");
  assert.equal(state.chips, 900);
});

test("バカラ: プレイヤーの3枚目が8ならバンカー3は止まり、タイになる", () => {
  // P: 2+3=5 → 3枚目 8 → 合計3。B: A+2=3、3枚目が8なので止まる → 合計3でタイ。
  let state = craftedState([2, 3, 1, 2, 8]);
  state = bc.placeBaccaratBet(state, "tie", 10);
  assert.equal(state.playerCards.length, 3);
  assert.equal(state.bankerCards.length, 2);
  assert.equal(state.winner, "tie");
  assert.equal(state.chips, 1000 + 80);
});

test("バカラ: 不正な賭けは throw し、次ラウンドで手札が消え、再支給が効く", () => {
  const state = bc.createBaccarat(5, 100);
  assert.throws(() => bc.placeBaccaratBet(state, "player", 1000)); // チップ不足
  assert.throws(() => bc.placeBaccaratBet(state, "player", 5)); // 最低賭け金未満
  let s2 = bc.placeBaccaratBet(state, "player", 10);
  assert.equal(s2.phase, "result");
  s2 = bc.nextBaccaratRound(s2);
  assert.equal(s2.phase, "betting");
  assert.deepEqual(s2.playerCards, []);
  assert.deepEqual(s2.bankerCards, []);

  const broke = bc.createBaccarat(5, 0);
  assert.equal(bc.refillBaccarat(broke).chips, bc.BACCARAT_START_CHIPS);
  const rich = bc.createBaccarat(5, 500);
  assert.equal(bc.refillBaccarat(rich), rich); // 残っていれば何もしない
});

// ---------------------------------------------------------------- ライアーズダイス

test("ライアーズダイス: 初期状態は全員ダイス5個で、ビューでは他人のダイスが見えない", () => {
  const state = ld.gameModule.createState(seats(3), rngStub, {});
  assert.equal(state.phase, "bidding");
  assert.equal(state.currentSeat, 0);
  assert.equal(state.currentBid, null);
  for (const p of state.players) assert.equal(state.diceCounts[p.seat], ld.LD_START_DICE);

  const view = ld.gameModule.viewFor(state, 1);
  assert.deepEqual(view.you.dice, [4, 4, 4, 4, 4]); // rng 0.5 → 全て4
  for (const p of view.players) {
    assert.ok(!("dice" in p), "他人のダイスがビューに含まれている");
    assert.equal(typeof p.diceCount, "number");
  }
  assert.equal(view.lastReveal, null);
});

test("ライアーズダイス: 宣言は前より強くなければならず、手番が回る", () => {
  let state = ld.gameModule.createState(seats(3), rngStub, {});
  assert.throws(() => ld.gameModule.applyAction(state, 0, { type: "challenge" }, rngStub)); // 宣言なしでは不可
  state = ld.gameModule.applyAction(state, 0, { type: "bid", count: 2, face: 4 }, rngStub);
  assert.equal(state.currentSeat, 1);
  assert.throws(() => ld.gameModule.applyAction(state, 1, { type: "bid", count: 2, face: 4 }, rngStub)); // 同じ宣言
  assert.throws(() => ld.gameModule.applyAction(state, 1, { type: "bid", count: 1, face: 6 }, rngStub)); // 個数が下がる
  assert.throws(() => ld.gameModule.applyAction(state, 1, { type: "bid", count: 2, face: 1 }, rngStub)); // 1は宣言不可
  state = ld.gameModule.applyAction(state, 1, { type: "bid", count: 2, face: 5 }, rngStub);
  assert.equal(state.currentSeat, 2);
  assert.equal(ld.ldIsRaise(null, 1, 2), true);
  assert.equal(ld.ldIsRaise({ count: 2, face: 5, seat: 1 }, 3, 2), true);
  assert.equal(ld.ldIsRaise({ count: 2, face: 5, seat: 1 }, 2, 5), false);
});

test("ライアーズダイス: ワイルド（1）の数え方とチャレンジの開示・敗者のダイス減少", () => {
  assert.equal(ld.ldCountFace({ 0: [1, 5, 2], 1: [5, 1] }, 5), 4); // 5が2個 + ワイルド2個
  assert.equal(ld.ldCountFace({ 0: [2, 3] }, 6), 0);

  let state = ld.gameModule.createState(seats(3), rngStub, {});
  state = ld.gameModule.applyAction(state, 0, { type: "bid", count: 2, face: 4 }, rngStub);
  state = ld.gameModule.applyAction(state, 1, { type: "bid", count: 2, face: 5 }, rngStub);
  // 全ダイスが4なので「5が2個」は嘘 → 宣言者（seat1）が負ける。
  state = ld.gameModule.applyAction(state, 2, { type: "challenge" }, rngStub);
  assert.equal(state.lastReveal.actual, 0);
  assert.equal(state.lastReveal.loserSeat, 1);
  assert.equal(state.lastReveal.challengerSeat, 2);
  assert.equal(state.diceCounts[1], 4);
  assert.equal(state.round, 2);
  assert.equal(state.currentSeat, 1); // 負けた人から次のラウンド
  assert.equal(state.currentBid, null);
  // 開示ビューには前ラウンドの全ダイスが含まれる。
  const view = ld.gameModule.viewFor(state, 0);
  assert.equal(view.lastReveal.dice[2].length, 5);
});

test("ライアーズダイス: ダイスを失い切ると脱落し、最後の1人が勝つ", () => {
  let state = ld.gameModule.createState(seats(2), rngStub, {});
  state = {
    ...state,
    diceCounts: { 0: 1, 1: 1 },
    dice: { 0: [2], 1: [3] },
    currentSeat: 0,
    currentBid: null,
    round: 5,
  };
  state = ld.gameModule.applyAction(state, 0, { type: "bid", count: 1, face: 2 }, rngStub);
  // 実際は2が1個（+ワイルド0）で宣言どおり → チャレンジャーが負ける。
  state = ld.gameModule.applyAction(state, 1, { type: "challenge" }, rngStub);
  assert.equal(state.diceCounts[1], 0);
  assert.equal(state.phase, "finished");
  assert.equal(state.winner, 0);
  const view = ld.gameModule.viewFor(state, 0);
  assert.equal(view.standings.find((s) => s.seat === 0).rank, 1);
  assert.equal(view.standings.find((s) => s.seat === 1).rank, 2);
  assert.throws(() => ld.gameModule.applyAction(state, 0, { type: "bid", count: 1, face: 2 }, rngStub));
});

test("ライアーズダイス: 退出者は脱落扱いで手番とダイスが外れる／parseAction", () => {
  let state = ld.gameModule.createState(seats(3), rngStub, {});
  state = ld.gameModule.applyAction(state, 0, { type: "bid", count: 1, face: 3 }, rngStub);
  assert.equal(state.currentSeat, 1);
  state = ld.gameModule.onPlayerLeft(state, 1);
  assert.deepEqual(state.leftSeats, [1]);
  assert.deepEqual(state.dice[1], []);
  assert.equal(state.currentSeat, 2);

  assert.deepEqual(ld.gameModule.parseAction({ type: "challenge" }), { type: "challenge" });
  assert.deepEqual(ld.gameModule.parseAction({ type: "bid", count: 3, face: 6 }), { type: "bid", count: 3, face: 6 });
  assert.equal(ld.gameModule.parseAction({ type: "bid", count: 3, face: 1 }), null);
  assert.equal(ld.gameModule.parseAction({ type: "bid", count: 0, face: 3 }), null);
  assert.equal(ld.gameModule.parseAction("bid"), null);
});

// ---------------------------------------------------------------- 少数決ゲーム

test("少数決: お題は15問以上で2択、3人未満は作成できない", () => {
  assert.ok(mn.MINORITY_QUESTIONS.length >= 15);
  for (const q of mn.MINORITY_QUESTIONS) assert.equal(q.choices.length, 2);
  assert.throws(() => mn.gameModule.createState(seats(2), rngStub, {}));
  assert.throws(() => mn.gameModule.createState(seats(9), rngStub, {}));
});

test("少数決: 締切まで回答内容は秘匿され、回答済みだけが分かる", () => {
  let state = mn.gameModule.createState(seats(4), rngStub, {});
  state = mn.gameModule.applyAction(state, 0, { type: "answer", choice: 1 }, rngStub);
  const view = mn.gameModule.viewFor(state, 1);
  const p0 = view.players.find((p) => p.seat === 0);
  assert.equal(p0.answered, true);
  assert.ok(!("choice" in p0), "締切前に他人の回答が見えている");
  assert.equal(view.tally, null);
  assert.equal(view.you.yourChoice, null);
  const myView = mn.gameModule.viewFor(state, 0);
  assert.equal(myView.you.yourChoice, 1);
});

function answerAll(state, choicesBySeat) {
  let s = state;
  for (const [seat, choice] of Object.entries(choicesBySeat)) {
    s = mn.gameModule.applyAction(s, Number(seat), { type: "answer", choice }, rngStub);
  }
  return s;
}

test("少数決: 少数派だけが残り、1人になれば優勝で終了する", () => {
  let state = mn.gameModule.createState(seats(4), rngStub, {});
  state = answerAll(state, { 0: 0, 1: 0, 2: 0, 3: 1 });
  assert.equal(state.phase, "reveal");
  const last = state.history[state.history.length - 1];
  assert.deepEqual(last.tally, [3, 1]);
  assert.deepEqual([...last.eliminatedSeats].sort(), [0, 1, 2]);
  assert.deepEqual(state.winners, [3]);
  state = mn.gameModule.tick(state, state.revealEndsAt + 1);
  assert.equal(state.phase, "finished");
  const view = mn.gameModule.viewFor(state, 3);
  assert.equal(view.standings.find((s) => s.seat === 3).rank, 1);
  assert.equal(view.standings.find((s) => s.seat === 3).winner, true);
  assert.equal(view.standings.find((s) => s.seat === 0).winner, false);
});

test("少数決: 同数なら全員残り、全員同じ選択肢でも全員残る", () => {
  let state = mn.gameModule.createState(seats(4), rngStub, {});
  state = answerAll(state, { 0: 0, 1: 0, 2: 1, 3: 1 });
  assert.equal(state.phase, "reveal");
  assert.deepEqual(state.history[0].eliminatedSeats, []);
  assert.equal(state.winners, null);
  state = mn.gameModule.tick(state, state.revealEndsAt + 1);
  assert.equal(state.phase, "question");
  assert.equal(state.index, 1);
  // 全員同じ選択肢 → 少数派が存在しないので全員残る。
  state = answerAll(state, { 0: 1, 1: 1, 2: 1, 3: 1 });
  assert.deepEqual(state.history[1].eliminatedSeats, []);
  assert.equal(state.winners, null);
});

test("少数決: 無回答は脱落し、tick の時間切れで締め切られる", () => {
  let state = mn.gameModule.createState(seats(4), rngStub, {});
  state = mn.gameModule.applyAction(state, 0, { type: "answer", choice: 0 }, rngStub);
  state = mn.gameModule.applyAction(state, 1, { type: "answer", choice: 0 }, rngStub);
  state = mn.gameModule.applyAction(state, 2, { type: "answer", choice: 1 }, rngStub);
  // seat3 は無回答のまま時間切れ。
  state = mn.gameModule.tick(state, state.questionEndsAt);
  assert.equal(state.phase, "reveal");
  const last = state.history[state.history.length - 1];
  assert.deepEqual(last.tally, [2, 1]);
  assert.deepEqual([...last.eliminatedSeats].sort(), [0, 1, 3]);
  assert.deepEqual(state.winners, [2]);
});

test("少数決: 全員無回答なら例外として全員残る", () => {
  let state = mn.gameModule.createState(seats(3), rngStub, {});
  state = mn.gameModule.tick(state, state.questionEndsAt);
  assert.equal(state.phase, "reveal");
  assert.deepEqual(state.history[0].eliminatedSeats, []);
  assert.equal(state.winners, null);
});

test("少数決: 生存者2人以下で優勝が決まり、退出でも決着する", () => {
  let state = mn.gameModule.createState(seats(3), rngStub, {});
  state = mn.gameModule.onPlayerLeft(state, 2);
  assert.equal(state.phase, "finished");
  assert.deepEqual([...state.winners].sort(), [0, 1]);
});

test(`少数決: 同数が続いてもラウンド上限（${mn.MN_MAX_ROUNDS}）で生存者全員が優勝する`, () => {
  let state = mn.gameModule.createState(seats(3), rngStub, {});
  for (let round = 0; round < mn.MN_MAX_ROUNDS + 2 && state.phase !== "finished"; round++) {
    if (state.phase === "question") {
      state = answerAll(state, { 0: 0, 1: 0, 2: 0 }); // 全員同じ → 全員残る
    }
    if (state.phase === "reveal") {
      state = mn.gameModule.tick(state, state.revealEndsAt + 1);
    }
  }
  assert.equal(state.phase, "finished");
  assert.deepEqual([...state.winners].sort(), [0, 1, 2]);
});

test("少数決: parseAction は 0/1 のみ許可する", () => {
  assert.deepEqual(mn.gameModule.parseAction({ type: "answer", choice: 1 }), { type: "answer", choice: 1 });
  assert.equal(mn.gameModule.parseAction({ type: "answer", choice: 2 }), null);
  assert.equal(mn.gameModule.parseAction({ type: "answer" }), null);
  assert.equal(mn.gameModule.parseAction(null), null);
});
