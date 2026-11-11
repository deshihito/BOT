// A10フェーズの新規4本のロジック検証。
// - lib/hashi.ts: 解の存在する生成・橋の循環・交差拒否・過剰/連結の検証
// - lib/dicequest.ts: 候補・方向ルール・最後の数字の条件・失敗と集計
// - lib/pentomino.ts: 向き集合・回転/反転・配置検証・ソルバによる可解性
// - lib/online/games/texas.ts: 7枚役判定・秘匿ビュー・チップ増減・5ハンド完走
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

const hashi = await loadLib("hashi.ts");
const dq = await loadLib("dicequest.ts");
const pent = await loadLib("pentomino.ts");
const texas = await loadOnline("texas.ts", [
  "gameModule",
  "evaluateTexasHand",
  "compareTexasScores",
  "TX_START_CHIPS",
  "TX_ANTE",
  "TX_BET",
  "TX_TOTAL_HANDS",
  "TX_HAND_END_MS",
]);

const rngStub = () => 0.42;
const seats = (n) => Array.from({ length: n }, (_, i) => ({ seat: i, name: `P${i + 1}` }));

// ---------------------------------------------------------------- 橋をかけろ

test("橋をかけろ: 同じシードでは同じ問題になる", () => {
  const a = hashi.createHashiGame(123, 7);
  const b = hashi.createHashiGame(123, 7);
  assert.deepEqual(a.islands, b.islands);
  assert.deepEqual(a.solution, b.solution);
  assert.equal(a.status, "playing");
  assert.deepEqual(a.bridges, {});
});

test("橋をかけろ: 生成した問題は解を当てると必ずクリアになる（複数シード・両サイズ）", () => {
  for (const size of [7, 9]) {
    for (let seed = 1; seed <= 12; seed++) {
      let state = hashi.createHashiGame(seed * 977 + size, size);
      assert.ok(state.islands.length >= (size === 7 ? 8 : 11), `島の数 seed=${seed} size=${size}`);
      assert.ok(state.islands.every((i) => i.need >= 1 && i.need <= 8));
      assert.equal(hashi.isHashiComplete(state), false);
      // 解のとおりに橋をかける（解同士は交差しないので全て通るはず）。
      for (const [key, count] of Object.entries(state.solution)) {
        const [a, b] = key.split("-").map(Number);
        for (let k = 0; k < count; k++) {
          const next = hashi.cycleHashiBridge(state, a, b);
          assert.notEqual(next, state, `解の橋が置けない seed=${seed} size=${size} edge=${key}`);
          state = next;
        }
      }
      assert.equal(state.status, "won", `クリアにならない seed=${seed} size=${size}`);
      assert.equal(hashi.isHashiComplete(state), true);
      assert.deepEqual(hashi.hashiViolations(state, true), []);
      // 数字と実際の本数が一致している。
      const degrees = hashi.hashiDegrees(state);
      state.islands.forEach((island, i) => assert.equal(degrees[i], island.need));
    }
  }
});

test("橋をかけろ: 解を置いた後に余分な橋を足すと「数字超え」になる", () => {
  let state = hashi.createHashiGame(555, 7);
  for (const [key, count] of Object.entries(state.solution)) {
    const [a, b] = key.split("-").map(Number);
    for (let k = 0; k < count; k++) state = hashi.cycleHashiBridge(state, a, b);
  }
  assert.equal(state.status, "won");
  // won の後は操作できないので、解を1つ手前まで戻した盤面で試す。
  let s2 = hashi.createHashiGame(555, 7);
  const entries = Object.entries(s2.solution);
  const [lastKey, lastCount] = entries[entries.length - 1];
  for (const [key, count] of entries) {
    const [a, b] = key.split("-").map(Number);
    const times = key === lastKey ? count - 1 : count;
    for (let k = 0; k < times; k++) s2 = hashi.cycleHashiBridge(s2, a, b);
  }
  assert.equal(s2.status, "playing");
  // どこかの候補辺をさらに1本増やすと、解で飽和した島が数字を超える。
  let exceeded = null;
  for (const edge of hashi.hashiCandidateEdges(s2)) {
    const next = hashi.cycleHashiBridge(s2, edge.a, edge.b);
    if (next === s2) continue; // 交差で置けない辺は除く
    const overs = hashi.hashiViolations(next, false).filter((v) => v.type === "over");
    if (overs.length > 0) {
      exceeded = next;
      break;
    }
    // 解の最後の辺を正しく戻しただけなら超えないので次を探す
    if (hashi.hashiBridgeCount(next, edge.a, edge.b) === lastCount && hashi.hashiEdgeKey(edge.a, edge.b) === lastKey) {
      continue;
    }
  }
  assert.ok(exceeded, "数字超えになる辺が見つからない");
  void state;
});

test("橋をかけろ: 交差する橋は置けず、強制すると違反になる", () => {
  // 十字に島を置いた人工盤面。横の辺 (1-2) と縦の辺 (0-3) が中央で交差する。
  const islands = [
    { id: 0, index: 3, need: 2 }, // (0,3)
    { id: 1, index: 21, need: 2 }, // (3,0)
    { id: 2, index: 27, need: 2 }, // (3,6)
    { id: 3, index: 45, need: 2 }, // (6,3)
  ];
  const base = { size: 7, seed: 1, islands, solution: {}, bridges: {}, moves: 0, status: "playing" };
  const edges = hashi.hashiCandidateEdges(base);
  const horizontal = edges.find((e) => e.orientation === "h");
  const vertical = edges.find((e) => e.orientation === "v");
  assert.ok(horizontal && vertical, "候補辺が不足");
  // 中央セルは両辺の通り道。
  const center = 24; // (3,3)
  assert.ok(horizontal.cells.includes(center));
  assert.ok(vertical.cells.includes(center));
  const atCell = hashi.hashiEdgeAtCell(base, center);
  assert.ok(atCell);

  let state = hashi.cycleHashiBridge(base, horizontal.a, horizontal.b);
  assert.notEqual(state, base);
  assert.deepEqual(hashi.hashiCellBridge(state, center), { orientation: "h", count: 1 });
  // 交差する縦橋は置けない（同じ状態が返る）。
  const blocked = hashi.cycleHashiBridge(state, vertical.a, vertical.b);
  assert.equal(blocked, state);
  // 両方を強制的に置いた状態は交差違反。
  const forced = {
    ...base,
    bridges: {
      [hashi.hashiEdgeKey(horizontal.a, horizontal.b)]: 1,
      [hashi.hashiEdgeKey(vertical.a, vertical.b)]: 1,
    },
  };
  const violations = hashi.hashiViolations(forced, false);
  assert.ok(violations.some((v) => v.type === "crossing"));
  // 島でない・候補でないペアは無効。
  assert.equal(hashi.cycleHashiBridge(base, 0, 1), base);
});

// ---------------------------------------------------------------- ダイスクエスト

test("ダイスクエスト: ロールで choice になり、候補はすべてルール内", () => {
  let state = dq.createDiceQuestGame(42);
  assert.equal(state.phase, "roll");
  assert.equal(state.dice, null);
  assert.deepEqual(dq.dqCandidates(state), []);
  state = dq.rollDqDice(state);
  assert.equal(state.phase, "choice");
  assert.equal(state.rolls, 1);
  for (const v of [state.dice.white[0], state.dice.white[1], ...Object.values(state.dice.colored)]) {
    assert.ok(v >= 1 && v <= 6);
  }
  for (const c of dq.dqCandidates(state)) {
    assert.ok(dq.dqCanCheck(state, c.color, c.value));
  }
  // ロールし直しは choice では無効。
  assert.equal(dq.rollDqDice(state), state);
});

test("ダイスクエスト: 候補を選ぶとチェックされ、次のロールへ進む", () => {
  let found = null;
  for (let seed = 1; seed <= 60 && !found; seed++) {
    const s = dq.rollDqDice(dq.createDiceQuestGame(seed));
    const cands = dq.dqCandidates(s);
    if (cands.length > 0) found = { state: s, cand: cands[0] };
  }
  assert.ok(found, "候補のあるシードが見つからない");
  const after = dq.applyDqCheck(found.state, found.cand.color, found.cand.value);
  assert.notEqual(after, found.state);
  assert.ok(after.rows[found.cand.color].includes(found.cand.value));
  assert.equal(after.checks, 1);
  assert.equal(after.phase, "roll");
  // 候補に無い手は無効。
  assert.equal(dq.applyDqCheck(found.state, "red", 2) === found.state || dq.dqCandidates(found.state).some((c) => c.color === "red" && c.value === 2), true);
});

test("ダイスクエスト: 行の方向ルールと最後の数字の条件", () => {
  const base = dq.createDiceQuestGame(1);
  const withRows = (rows) => ({ ...base, rows: { ...base.rows, ...rows } });
  // 昇順（赤）: チェック済みより手前・重複は不可、先は可。
  const s1 = withRows({ red: [2, 3] });
  assert.equal(dq.dqCanCheck(s1, "red", 4), true);
  assert.equal(dq.dqCanCheck(s1, "red", 3), false);
  assert.equal(dq.dqCanCheck(s1, "red", 2), false);
  // 最後の数字 12 は 5チェック未満では不可。
  assert.equal(dq.dqCanCheck(s1, "red", 12), false);
  const s2 = withRows({ red: [2, 3, 4, 5, 6] });
  assert.equal(dq.dqCanCheck(s2, "red", 12), true);
  // 降順（緑）: 12→2 へ進む。
  const s3 = withRows({ green: [12, 11] });
  assert.equal(dq.dqCanCheck(s3, "green", 10), true);
  assert.equal(dq.dqCanCheck(s3, "green", 12), false);
  assert.equal(dq.dqCanCheck(s3, "green", 2), false);
  const s4 = withRows({ green: [12, 11, 10, 9, 8] });
  assert.equal(dq.dqCanCheck(s4, "green", 2), true);
  // 範囲外の数字は不可。
  assert.equal(dq.dqCanCheck(s1, "red", 1), false);
  assert.equal(dq.dqCanCheck(s1, "red", 13), false);
});

test("ダイスクエスト: 候補は白合計と色合計から作られる", () => {
  const base = dq.createDiceQuestGame(1);
  const state = {
    ...base,
    phase: "choice",
    dice: { white: [3, 4], colored: { red: 5, yellow: 1, green: 2, blue: 6 } },
  };
  const cands = dq.dqCandidates(state);
  const has = (color, value, via) =>
    cands.some((c) => c.color === color && c.value === value && (via === undefined || c.via === via));
  assert.ok(has("red", 7, "white")); // 白合計 7 は全行可
  assert.ok(has("blue", 7));
  assert.ok(has("red", 8)); // 3+5
  assert.ok(has("red", 9)); // 4+5
  assert.ok(has("blue", 9)); // 3+6
  assert.ok(has("blue", 10)); // 4+6
  assert.ok(!has("yellow", 12)); // 黄の色合計は 4/5 のみ。白合計7以外に12は作れない
});

test("ダイスクエスト: 失敗3回で終了し、スコアは失敗 -5 点で集計される", () => {
  let state = dq.createDiceQuestGame(7);
  for (let i = 0; i < 3; i++) {
    state = dq.rollDqDice(state);
    assert.equal(state.phase, "choice");
    state = dq.applyDqPass(state);
    assert.equal(state.failures, i + 1);
  }
  assert.equal(state.phase, "finished");
  // 集計: 赤3チェック=6点、緑1チェック=1点、失敗2回=-10点 → -3点。
  const crafted = {
    ...dq.createDiceQuestGame(1),
    rows: { red: [2, 3, 4], yellow: [], green: [12], blue: [] },
    failures: 2,
  };
  const score = dq.dqScore(crafted);
  assert.equal(score.perRow.red.points, 6);
  assert.equal(score.perRow.green.points, 1);
  assert.equal(score.penalty, 10);
  assert.equal(score.total, -3);
});

// ---------------------------------------------------------------- ペントミノ

test("ペントミノ: 12ピースは各5マスで、向きの総数は63", () => {
  assert.equal(pent.PENTOMINOES.length, 12);
  let total = 0;
  for (const def of pent.PENTOMINOES) {
    assert.equal(def.cells.length, 5);
    const orientations = pent.pentOrientations(def.id);
    total += orientations.length;
    for (const cells of orientations) assert.equal(cells.length, 5);
  }
  assert.equal(total, 63); // F8 I2 L8 N8 P8 T4 U4 V4 W4 X1 Y8 Z4
  assert.equal(pent.pentOrientations("X").length, 1);
  assert.equal(pent.pentOrientations("I").length, 2);
});

test("ペントミノ: 回転4回・反転2回で元に戻る", () => {
  for (const def of pent.PENTOMINOES) {
    let o = 0;
    for (let i = 0; i < 4; i++) o = pent.rotatePentOrientation(def.id, o);
    assert.equal(o, 0, `${def.id} の回転`);
    const f = pent.flipPentOrientation(def.id, 0);
    assert.equal(pent.flipPentOrientation(def.id, f), 0, `${def.id} の反転`);
  }
});

test("ペントミノ: 配置・重なり・盤外・取り外しの検証", () => {
  let state = pent.createPentGame("6x10");
  assert.equal(state.rows, 6);
  assert.equal(state.cols, 10);
  assert.equal(pent.isPentComplete(state), false);
  // X を (2,2) に置く。
  assert.equal(pent.canPlacePent(state, "X", 0, 2, 2), true);
  state = pent.placePent(state, "X", 0, 2, 2);
  assert.ok(state.placements.X);
  const occ = pent.pentOccupancy(state);
  assert.equal(occ.filter(Boolean).length, 5);
  assert.ok(occ.every((v) => v === null || v === "X"));
  // X と重なる I は置けない（横向きで (3,0) からは X のマスに触れる）。
  assert.equal(pent.canPlacePent(state, "I", 0, 3, 0), false);
  const blocked = pent.placePent(state, "I", 0, 3, 0);
  assert.equal(blocked, state);
  // 盤外には置けない。
  assert.equal(pent.canPlacePent(state, "I", 0, 0, 8), false);
  assert.equal(pent.canPlacePent(state, "I", 0, 6, 0), false);
  // 同じピースの置き直しは可能（X の先頭セルは (0,1) なので col 1 が盤内）。
  const moved = pent.placePent(state, "X", 0, 0, 1);
  assert.notEqual(moved, state);
  assert.equal(pent.pentOccupancy(moved).filter(Boolean).length, 5);
  // 外すと残りに戻る。
  const removed = pent.removePent(moved, "X");
  assert.equal(removed.placements.X, undefined);
  assert.ok(pent.pentRemaining(removed).includes("X"));
  assert.equal(pent.pentRemaining(state).length, 11);
});

test("ペントミノ: 6x10 はソルバで解け、lib の配置でも完成になる", () => {
  const ROWS = 6;
  const COLS = 10;
  const occ = new Array(ROWS * COLS).fill(null);
  const used = new Set();
  const solution = []; // { id, orientation, row, col }（row/col は向き先頭セルの位置）
  const order = ["X", "F", "T", "W", "Z", "U", "P", "V", "Y", "L", "N", "I"];
  const solve = () => {
    const idx = occ.indexOf(null);
    if (idx === -1) return used.size === 12;
    const r = Math.floor(idx / COLS);
    const c = idx % COLS;
    for (const id of order) {
      if (used.has(id)) continue;
      const orients = pent.pentOrientations(id);
      for (let o = 0; o < orients.length; o++) {
        const cells = orients[o];
        for (const [ar, ac] of cells) {
          const originR = r - ar;
          const originC = c - ac;
          let ok = true;
          const placedIdx = [];
          for (const [cr, cc] of cells) {
            const br = originR + cr;
            const bc = originC + cc;
            if (br < 0 || bc < 0 || br >= ROWS || bc >= COLS || occ[br * COLS + bc] !== null) {
              ok = false;
              break;
            }
            placedIdx.push(br * COLS + bc);
          }
          if (!ok) continue;
          for (const p of placedIdx) occ[p] = id;
          used.add(id);
          solution.push({
            id,
            orientation: o,
            row: originR + cells[0][0],
            col: originC + cells[0][1],
          });
          if (solve()) return true;
          solution.pop();
          for (const p of placedIdx) occ[p] = null;
          used.delete(id);
        }
      }
    }
    return false;
  };
  assert.equal(solve(), true, "6x10 の解が見つからない");
  // lib の placePent で再生して完成判定まで確認する。
  let state = pent.createPentGame("6x10");
  for (const step of solution) {
    const next = pent.placePent(state, step.id, step.orientation, step.row, step.col);
    assert.notEqual(next, state, `${step.id} が置けない`);
    state = next;
  }
  assert.equal(pent.isPentComplete(state), true);
  assert.equal(state.status, "won");
  assert.equal(pent.pentOccupancy(state).filter(Boolean).length, 60);
});

// ---------------------------------------------------------------- テキサスポーカー

// カード id: suit*13 + (rank-1)。♠=0, ♥=1, ♦=2, ♣=3。
const cid = (suit, rank) => suit * 13 + (rank - 1);

test("テキサス: 7枚からの役判定（ロイヤル/ホイール/フルハウス/キッカー）", () => {
  const royal = texas.evaluateTexasHand([cid(0, 10), cid(0, 11), cid(0, 12), cid(0, 13), cid(0, 1), cid(1, 2), cid(2, 3)]);
  assert.equal(royal.category, 8);
  assert.equal(royal.name, "ストレートフラッシュ");
  const wheel = texas.evaluateTexasHand([cid(0, 1), cid(1, 2), cid(2, 3), cid(3, 4), cid(0, 5), cid(1, 13), cid(2, 12)]);
  assert.equal(wheel.category, 4);
  assert.equal(wheel.score[1], 5); // ホイールのハイは5
  const full = texas.evaluateTexasHand([cid(0, 1), cid(1, 1), cid(2, 1), cid(0, 13), cid(1, 13), cid(2, 13), cid(3, 2)]);
  assert.equal(full.category, 6);
  assert.deepEqual(full.score, [6, 14, 13]); // A のスリーカード側が上
  const pairA = texas.evaluateTexasHand([cid(0, 1), cid(1, 1), cid(2, 13), cid(3, 9), cid(0, 5), cid(1, 3), cid(2, 2)]);
  const pairK = texas.evaluateTexasHand([cid(0, 13), cid(1, 13), cid(2, 1), cid(3, 9), cid(0, 5), cid(1, 3), cid(2, 2)]);
  assert.equal(pairA.category, 1);
  assert.ok(texas.compareTexasScores(pairA.score, pairK.score) > 0); // Aペア + Kキッカー > Kペア + Aキッカー
  assert.throws(() => texas.evaluateTexasHand([1, 2, 3, 4]));
});

test("テキサス: ビューでは他人の手札と山札が見えない", () => {
  const gm = texas.gameModule;
  const state = gm.createState(seats(3), rngStub, {});
  assert.equal(state.phase, "betting");
  assert.equal(state.pot, texas.TX_ANTE * 3);
  const view0 = gm.viewFor(state, 0);
  assert.equal(view0.yourCards.length, 2);
  assert.deepEqual(view0.yourCards, state.players[0].hole);
  assert.equal(view0.board.length, 0); // プリフロップは共通カードなし
  for (const p of view0.players) {
    assert.equal("hole" in p, false);
    assert.equal("cards" in p, false);
  }
  assert.equal(view0.players[1].cardCount, 2);
  assert.equal("decks" in view0, false);
  // 他人のビューでは手札が入れ替わる。
  const view1 = gm.viewFor(state, 1);
  assert.deepEqual(view1.yourCards, state.players[1].hole);
  assert.notDeepEqual(view1.yourCards, view0.yourCards);
});

test("テキサス: フォールド決着でポットが勝者へ移り、チップ総量が保存される", () => {
  const gm = texas.gameModule;
  let state = gm.createState(seats(2), rngStub, {});
  const turn = state.turn;
  const other = 1 - turn;
  assert.equal(state.players[turn].chips, texas.TX_START_CHIPS - texas.TX_ANTE);
  state = gm.applyAction(state, turn, { type: "act", move: "fold" }, rngStub);
  assert.equal(state.phase, "handEnd");
  assert.equal(state.lastResult.showdown, false);
  assert.deepEqual(state.lastResult.winners, [other]);
  assert.equal(state.players[other].chips, texas.TX_START_CHIPS + texas.TX_ANTE);
  assert.equal(state.players[turn].chips, texas.TX_START_CHIPS - texas.TX_ANTE);
  assert.equal(state.players.reduce((s, p) => s + p.chips, 0), texas.TX_START_CHIPS * 2);
  assert.equal(state.pot, 0);
});

test("テキサス: 全員参加でショーダウンになり、手札が開示される", () => {
  const gm = texas.gameModule;
  let state = gm.createState(seats(2), rngStub, {});
  let sawFlop = false;
  let guard = 0;
  while (state.phase === "betting" && guard++ < 60) {
    if (state.street === "flop") {
      assert.equal(gm.viewFor(state, 0).board.length, 3);
      sawFlop = true;
    }
    state = gm.applyAction(state, state.turn, { type: "act", move: "call" }, rngStub);
  }
  assert.ok(sawFlop);
  assert.equal(state.phase, "handEnd");
  assert.equal(state.lastResult.showdown, true);
  assert.ok(state.lastResult.winners.length >= 1);
  assert.ok(state.lastResult.hands[0] && state.lastResult.hands[1]);
  assert.equal(state.lastResult.hands[0].cards.length, 2);
  assert.equal(state.pot, 0);
  // アンティ10 + 4ストリート×10 = 1人50点ずつ、ポット100が分配される。
  assert.equal(state.players.reduce((s, p) => s + p.chips, 0), texas.TX_START_CHIPS * 2);
  const view = gm.viewFor(state, 0);
  assert.equal(view.board.length, 5);
});

test("テキサス: 5ハンド進めると終了し、順位がチップ順になる", () => {
  const gm = texas.gameModule;
  let state = gm.createState(seats(2), rngStub, {});
  let guard = 0;
  while (state.phase !== "finished" && guard++ < 500) {
    if (state.phase === "handEnd") {
      state = gm.applyAction(state, 0, { type: "next" }, rngStub);
      continue;
    }
    // ハンドごとに勝者を交代させる（奇数ハンドは seat0 が降り、偶数ハンドは seat0 が参加して seat1 が降りる）。
    const hand = state.handNumber;
    if (hand % 2 === 1) {
      state = gm.applyAction(state, state.turn, { type: "act", move: "fold" }, rngStub);
    } else if (state.street === "preflop" && state.acted.length === 0) {
      state = gm.applyAction(state, state.turn, { type: "act", move: "call" }, rngStub);
    } else {
      state = gm.applyAction(state, state.turn, { type: "act", move: "fold" }, rngStub);
    }
  }
  assert.equal(state.phase, "finished");
  assert.equal(state.handNumber, texas.TX_TOTAL_HANDS);
  assert.ok(state.standings);
  assert.equal(state.standings.length, 2);
  assert.equal(state.players.reduce((s, p) => s + p.chips, 0), texas.TX_START_CHIPS * 2);
  for (const s of state.standings) {
    assert.equal(s.rank, 1 + state.players.filter((q) => q.chips > s.chips).length);
  }
});

test("テキサス: 退出はフォールド扱いで、tick で次のハンドへ自動進行する", () => {
  const gm = texas.gameModule;
  let state = gm.createState(seats(3), rngStub, {});
  const leaver = state.turn === 0 ? 1 : 0;
  state = gm.onPlayerLeft(state, leaver);
  assert.equal(state.players[leaver].left, true);
  assert.equal(state.players[leaver].folded, true);
  assert.equal(state.phase, "betting");
  // 手番のプレイヤーが退出したら手番が移る。
  let s2 = gm.createState(seats(3), rngStub, {});
  const turnSeat = s2.turn;
  s2 = gm.onPlayerLeft(s2, turnSeat);
  assert.notEqual(s2.turn, turnSeat);
  assert.equal(s2.players[s2.turn].folded, false);
  // handEnd で tick が予約→自動で次ハンドへ。
  let s3 = gm.createState(seats(2), rngStub, {});
  s3 = gm.applyAction(s3, s3.turn, { type: "act", move: "fold" }, rngStub);
  assert.equal(s3.phase, "handEnd");
  const t0 = 1_000_000;
  const reserved = gm.tick(s3, t0);
  assert.equal(reserved.nextHandAt, t0 + texas.TX_HAND_END_MS);
  const advanced = gm.tick(reserved, t0 + texas.TX_HAND_END_MS);
  assert.equal(advanced.phase, "betting");
  assert.equal(advanced.handNumber, 2);
  // parseAction の形式検証。
  assert.deepEqual(gm.parseAction({ type: "act", move: "call" }), { type: "act", move: "call" });
  assert.deepEqual(gm.parseAction({ type: "next" }), { type: "next" });
  assert.equal(gm.parseAction({ type: "act", move: "raise" }), null);
  assert.equal(gm.parseAction(null), null);
  assert.equal(gm.parseAction("call"), null);
});
