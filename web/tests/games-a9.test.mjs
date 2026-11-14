// A9フェーズの新規4本のロジック検証。
// - lib/freecell.ts: 決定的配布・移動検証・まとめて動かせる枚数・自動送り・勝利
// - lib/online/games/majority.ts: 秘匿（締切まで他人の回答が見えない）・多数決の採点・tick 締切
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

const fc = await loadLib("freecell.ts");
const mj = await loadOnline("majority.ts", [ "gameModule", "MAJORITY_QUESTIONS", "MJ_TOTAL_QUESTIONS", "MJ_POINTS_PER_VOTE", "mjScoreFor", ]);

const rngStub = () => 0.5;
const seats = (n) => Array.from({ length: n }, (_, i) => ({ seat: i, name: `P${i + 1}` }));

// ---------------------------------------------------------------- フリーセル

const card = (suit, rank) => ({ id: `${suit}-${rank}`, suit, rank });
const emptyFcState = () => ({
  columns: Array.from({ length: 8 }, () => []),
  freeCells: [null, null, null, null],
  foundations: [[], [], [], []],
  moves: 0,
  status: "playing",
  seed: 0,
});

test("フリーセル: 配布は決定的で、前4列7枚・後4列6枚・全52枚ユニーク", () => {
  const a = fc.createFreecell(42);
  const b = fc.createFreecell(42);
  assert.deepEqual(a.columns, b.columns);
  assert.deepEqual(
    a.columns.map((c) => c.length),
    [7, 7, 7, 7, 6, 6, 6, 6],
  );
  const ids = a.columns.flat().map((c) => c.id);
  assert.equal(new Set(ids).size, 52);
});

test("フリーセル: まとめて動かせる枚数は (1+空きセル) × 2^空列（移動先の空列は除く）", () => {
  const full = emptyFcState();
  for (let i = 0; i < 8; i++) full.columns[i] = [card("spades", 5)];
  // 全フリーセル使用中・空列なし → 1枚。
  for (let i = 0; i < 4; i++) full.freeCells[i] = card("hearts", 3);
  assert.equal(fc.maxMovableCards(full), 1);
  // 空きセル3つ → (1+3)*1 = 4
  full.freeCells[1] = null;
  full.freeCells[2] = null;
  full.freeCells[3] = null;
  assert.equal(fc.maxMovableCards(full), 4);
  full.columns[3] = [];
  // 空列1つ（移動先でない）→ 4*2 = 8
  assert.equal(fc.maxMovableCards(full), 8);
  // 移動先がその空列 → 倍率に含めない → 4
  assert.equal(fc.maxMovableCards(full, 3), 4);
});

test("フリーセル: 並び検証と列への移動（色交互・降順のみ可）", () => {
  assert.equal(fc.isValidStack([card("spades", 13), card("hearts", 12), card("spades", 11)]), true);
  assert.equal(fc.isValidStack([card("spades", 13), card("clubs", 12)]), false);
  assert.equal(fc.isValidStack([card("spades", 13), card("hearts", 11)]), false);

  const s = emptyFcState();
  s.columns[0] = [card("hearts", 5)];
  s.columns[1] = [card("spades", 6)];
  s.columns[2] = [card("hearts", 6)];
  const moved = fc.moveFreecell(s, { kind: "column", column: 0 }, { kind: "column", column: 1 }, 1);
  assert.notEqual(moved, s);
  assert.equal(moved.columns[1].length, 2);
  assert.equal(moved.columns[0].length, 0);
  // 同色の6には重ねられない。
  const denied = fc.moveFreecell(s, { kind: "column", column: 0 }, { kind: "column", column: 2 }, 1);
  assert.equal(denied, s);
});

test("フリーセル: 移動可能枚数を超えるまとめ移動はできない", () => {
  const s = emptyFcState();
  for (let i = 0; i < 8; i++) s.columns[i] = [card("clubs", 2)];
  for (let i = 0; i < 4; i++) s.freeCells[i] = card("diamonds", 4);
  // Q♥ の上に J♠ が乗った正しい2枚スタック。移動先は K♣（黒）で重ねる条件は満たす。
  s.columns[0] = [card("hearts", 12), card("spades", 11)];
  s.columns[1] = [card("clubs", 13)];
  // 空きセル0・空列0 → 1枚まで。2枚まとめは枚数制限で不可。
  assert.equal(fc.maxMovableCards(s), 1);
  const denied = fc.moveFreecell(s, { kind: "column", column: 0 }, { kind: "column", column: 1 }, 2);
  assert.equal(denied, s);
  // フリーセルを1つ空けると (1+1)=2枚まで動かせる。
  s.freeCells[0] = null;
  const moved = fc.moveFreecell(s, { kind: "column", column: 0 }, { kind: "column", column: 1 }, 2);
  assert.notEqual(moved, s);
  assert.equal(moved.columns[1].length, 3);
  assert.equal(moved.columns[0].length, 0);
});

test("フリーセル: 組札は同スート昇順のみ・自動送りは安全なカードだけ送る", () => {
  const s = emptyFcState();
  s.columns[0] = [card("spades", 1)];
  s.columns[1] = [card("spades", 2)];
  s.columns[2] = [card("spades", 3)];
  // spades の組札は index 0。
  let cur = fc.moveFreecell(s, { kind: "column", column: 0 }, { kind: "foundation", index: 0 }, 1);
  assert.equal(cur.foundations[0].length, 1);
  // 違うスートの組札（hearts=index1）には送れない。
  const denied = fc.moveFreecell(cur, { kind: "column", column: 1 }, { kind: "foundation", index: 1 }, 1);
  assert.equal(denied, cur);
  // 自動送り: A,2 は送られるが、3 は相手色（赤）の組札が進んでいないので送られない。
  const auto = fc.autoMoveFreecell(s);
  assert.equal(auto.foundations[0].length, 2);
  assert.equal(auto.columns[2].length, 1);
});

test("フリーセル: 全52枚を組札にそろえると勝利", () => {
  const s = emptyFcState();
  const suits = ["spades", "hearts", "diamonds", "clubs"];
  suits.forEach((suit, i) => {
    for (let r = 1; r <= 12; r++) s.foundations[i].push(card(suit, r));
    s.columns[i] = [card(suit, 13)];
  });
  let cur = s;
  for (let i = 0; i < 4; i++) {
    cur = fc.moveFreecell(cur, { kind: "column", column: i }, { kind: "foundation", index: i }, 1);
  }
  assert.equal(cur.status, "won");
});

test("フリーセル: undo で1手戻り、手数が戻る／履歴がなければ同一参照", () => {
  const s = emptyFcState();
  s.columns[0] = [card("hearts", 5)];
  s.columns[1] = [card("spades", 6)];
  // 履歴のない状態（テスト用リテラル等）では undo は同一参照を返す。
  assert.equal(fc.undoFreecell(s), s);
  const moved = fc.moveFreecell(s, { kind: "column", column: 0 }, { kind: "column", column: 1 }, 1);
  assert.equal(moved.moves, s.moves + 1);
  const back = fc.undoFreecell(moved);
  assert.notEqual(back, moved);
  assert.deepEqual(back.columns, s.columns);
  assert.deepEqual(back.freeCells, s.freeCells);
  assert.deepEqual(back.foundations, s.foundations);
  assert.equal(back.moves, s.moves);
  assert.equal(back.status, s.status);
  // もう一度 undo しても戻り先はない（同一参照）。
  assert.equal(fc.undoFreecell(back), back);
});

test("フリーセル: 連続移動は1手ずつ戻れる／自動送りは undo 1ステップで戻る", () => {
  const s = emptyFcState();
  s.columns[0] = [card("spades", 1)];
  s.columns[1] = [card("spades", 2)];
  s.columns[2] = [card("spades", 3)];
  const auto = fc.autoMoveFreecell(s);
  assert.equal(auto.foundations[0].length, 2);
  const back = fc.undoFreecell(auto);
  assert.deepEqual(back.columns, s.columns);
  assert.deepEqual(back.foundations, s.foundations);
  assert.equal(back.moves, s.moves);
  // 手動の2手は2回 undo で初期状態へ。
  const m1 = fc.moveFreecell(s, { kind: "column", column: 0 }, { kind: "foundation", index: 0 }, 1);
  const m2 = fc.moveFreecell(m1, { kind: "column", column: 1 }, { kind: "foundation", index: 0 }, 1);
  const b1 = fc.undoFreecell(m2);
  assert.deepEqual(b1.columns, m1.columns);
  assert.deepEqual(b1.foundations, m1.foundations);
  const b2 = fc.undoFreecell(b1);
  assert.deepEqual(b2.columns, s.columns);
  assert.equal(b2.moves, s.moves);
});

// ---------------------------------------------------------------- 多数決ゲーム

test("多数決: お題は20問以上・各4択、人数は2〜8人", () => {
  assert.ok(mj.MAJORITY_QUESTIONS.length >= 20);
  for (const q of mj.MAJORITY_QUESTIONS) assert.equal(q.choices.length, 4);
  assert.throws(() => mj.gameModule.createState(seats(1), rngStub, {}));
  assert.throws(() => mj.gameModule.createState(seats(9), rngStub, {}));
  const s = mj.gameModule.createState(seats(8), rngStub, {});
  assert.equal(s.questions.length, mj.MJ_TOTAL_QUESTIONS);
});

test("多数決: 得点は最多得票の回答者だけに 最多票×10点", () => {
  assert.equal(mj.mjScoreFor(3, 3), 30);
  assert.equal(mj.mjScoreFor(1, 3), 0);
  assert.equal(mj.mjScoreFor(0, 0), 0);
});

test("多数決: 締切までは他人の回答が秘匿され、締切後に開示される", () => {
  let s = mj.gameModule.createState(seats(3), rngStub, {});
  s = mj.gameModule.applyAction(s, 0, { type: "answer", choice: 1 }, rngStub);
  // まだ全員回答していないので question のまま。
  assert.equal(s.phase, "question");
  const viewFor1 = mj.gameModule.viewFor(s, 1);
  const other = viewFor1.players.find((p) => p.seat === 0);
  assert.equal(other.answered, true);
  assert.ok(!("choice" in other), "締切前に他人の回答が見えてはいけない");
  assert.equal(viewFor1.tally, null);
  // 自分の回答は自分に見える。
  const viewFor0 = mj.gameModule.viewFor(s, 0);
  assert.equal(viewFor0.you.yourChoice, 1);
  // 全員回答で締切→reveal で開示。
  s = mj.gameModule.applyAction(s, 1, { type: "answer", choice: 1 }, rngStub);
  s = mj.gameModule.applyAction(s, 2, { type: "answer", choice: 0 }, rngStub);
  assert.equal(s.phase, "reveal");
  const revealed = mj.gameModule.viewFor(s, 2);
  assert.deepEqual(revealed.tally, [1, 2, 0, 0]);
  assert.equal(revealed.topVotes, 2);
  const p0 = revealed.players.find((p) => p.seat === 0);
  assert.equal(p0.choice, 1);
  assert.equal(p0.gained, 20); // 最多票2票 × 10
  const p2 = revealed.players.find((p) => p.seat === 2);
  assert.equal(p2.gained, 0);
});

test("多数決: 得票が同点なら並んだ選択肢の回答者全員が得点する", () => {
  let s = mj.gameModule.createState(seats(4), rngStub, {});
  s = mj.gameModule.applyAction(s, 0, { type: "answer", choice: 0 }, rngStub);
  s = mj.gameModule.applyAction(s, 1, { type: "answer", choice: 0 }, rngStub);
  s = mj.gameModule.applyAction(s, 2, { type: "answer", choice: 2 }, rngStub);
  s = mj.gameModule.applyAction(s, 3, { type: "answer", choice: 2 }, rngStub);
  assert.equal(s.phase, "reveal");
  for (const seat of [0, 1, 2, 3]) {
    assert.equal(s.scores[seat], 20);
  }
});

test("多数決: tick の時間切れで締め切り、未回答は0点・全8問で順位が出る", () => {
  let s = mj.gameModule.createState(seats(2), rngStub, {});
  s = mj.gameModule.applyAction(s, 0, { type: "answer", choice: 0 }, rngStub);
  // 時間切れで締切。
  s = mj.gameModule.tick(s, Date.now() + 21000);
  assert.equal(s.phase, "reveal");
  const hist = s.history[0];
  assert.equal(hist.results.find((r) => r.seat === 1).choice, null);
  // 1人だけ回答→その選択肢が最多（1票）→ +10点。
  assert.equal(s.scores[0], 10);
  assert.equal(s.scores[1], 0);
  // 残りを合成時計の tick で進めて完走させる（1回 +30秒で reveal→次問→締切が進む）。
  let clock = Date.now() + 21000;
  for (let i = 0; i < 40 && s.phase !== "finished"; i++) {
    clock += 30000;
    s = mj.gameModule.tick(s, clock);
  }
  assert.equal(s.phase, "finished");
  const view = mj.gameModule.viewFor(s, 0);
  assert.ok(Array.isArray(view.standings));
  assert.equal(view.standings.find((x) => x.seat === 0).rank, 1);
  assert.equal(view.standings.find((x) => x.seat === 1).rank, 2);
});

test("多数決: 退出者は脱落扱いで、残り全員の回答で締め切られる／parseAction の形式検証", () => {
  let s = mj.gameModule.createState(seats(3), rngStub, {});
  s = mj.gameModule.onPlayerLeft(s, 2);
  s = mj.gameModule.applyAction(s, 0, { type: "answer", choice: 3 }, rngStub);
  assert.equal(s.phase, "question");
  s = mj.gameModule.applyAction(s, 1, { type: "answer", choice: 3 }, rngStub);
  assert.equal(s.phase, "reveal");
  // 退出者は得点対象外、回答した2人は最多2票で +20。
  assert.equal(s.scores[0], 20);
  assert.equal(s.scores[2], 0);
  assert.deepEqual(mj.gameModule.parseAction({ type: "answer", choice: 2 }), { type: "answer", choice: 2 });
  assert.equal(mj.gameModule.parseAction({ type: "answer", choice: 4 }), null);
  assert.equal(mj.gameModule.parseAction({ type: "nope" }), null);
  assert.equal(mj.gameModule.parseAction(null), null);
});
