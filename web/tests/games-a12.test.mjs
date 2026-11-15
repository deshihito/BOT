// A12フェーズの新規4本のロジック検証。
// - lib/online/games/liarsdice.ts: 宣言検証・チャレンジ開示（ワイルド）・脱落と勝敗・秘匿
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

const ld = await loadOnline("liarsdice.ts", ["gameModule", "ldCountFace", "ldIsRaise", "LD_START_DICE"]);

const rngStub = () => 0.5;
const seats = (n) => Array.from({ length: n }, (_, i) => ({ seat: i, name: `P${i + 1}` }));

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
