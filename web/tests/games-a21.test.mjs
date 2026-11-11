// A21フェーズ新規3本のロジック検証（lib のみ、UI 非依存）。
// - lib/kakuro.ts: 生成妥当性（ラン・ヒント合計・解の重複禁止）・決定性・検証・完成
// - lib/cube.ts: 回転の性質（4回で戻る・逆回転）・完成判定・スクランブルの可解性
// - lib/online/games/dartsbattle.ts: 得点計算・手番とラウンド進行・決着・退出
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
  const body = stripModuleSyntax(js) + `\n;return { ${exportsList.join(", ")} };`;
  return new Function(body)();
}

const kakuro = await loadLib("kakuro.ts");
const cube = await loadLib("cube.ts");
const db = await loadOnline("dartsbattle.ts", ["gameModule", "dbScoreDart", "DB_TOTAL_ROUNDS"]);

function makeRng(seed) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- カックロ ----

test("カックロ: 解は全ランで重複なし・ヒント合計と一致する", () => {
  for (const seed of [1, 7, 42, 12345]) {
    const state = kakuro.createKakuroGame(seed);
    assert.equal(state.size, 9);
    assert.ok(state.runs.length > 0);
    for (const run of state.runs) {
      assert.ok(run.cells.length >= 2, "ランは2マス以上");
      const vals = run.cells.map((i) => state.solution[i]);
      assert.equal(new Set(vals).size, vals.length, "ラン内に重複がない");
      assert.ok(vals.every((v) => v >= 1 && v <= 9));
      assert.equal(
        vals.reduce((a, b) => a + b, 0),
        run.sum,
        "ヒント合計が解と一致",
      );
      // ヒントは黒マスに正しく載っている。
      const clueCell = state.cells[run.clue];
      assert.equal(clueCell.kind, "black");
      assert.equal(run.dir === "down" ? clueCell.down : clueCell.across, run.sum);
    }
    // 全ての白マスは across / down 両方のランに属する。
    const covered = new Map();
    for (const run of state.runs) {
      for (const i of run.cells) covered.set(i, (covered.get(i) ?? 0) + 1);
    }
    state.cells.forEach((cell, i) => {
      if (cell.kind === "white") assert.equal(covered.get(i), 2, `マス ${i} は両方向のランに属する`);
    });
    // 与え数字は解と一致する。
    state.cells.forEach((cell, i) => {
      if (cell.kind === "white" && cell.given) assert.equal(state.values[i], state.solution[i]);
    });
  }
});

test("カックロ: 同じシードでは同じ盤面になる", () => {
  const a = kakuro.createKakuroGame(99);
  const b = kakuro.createKakuroGame(99);
  assert.deepEqual(a.solution, b.solution);
  assert.deepEqual(a.cells, b.cells);
  assert.deepEqual(a.runs, b.runs);
});

test("カックロ: 解を入力すると完成し、与え数字は変更できない", () => {
  let state = kakuro.createKakuroGame(5);
  const givenIndex = state.cells.findIndex((c) => c.kind === "white" && c.given);
  if (givenIndex >= 0) {
    const before = kakuro.setKakuroValue(state, givenIndex, (state.solution[givenIndex] % 9) + 1);
    assert.equal(before, state, "与え数字のマスは変更できない");
  }
  const blackIndex = state.cells.findIndex((c) => c.kind === "black");
  assert.equal(kakuro.setKakuroValue(state, blackIndex, 5), state, "黒マスには入力できない");
  state.cells.forEach((cell, i) => {
    if (cell.kind === "white" && !cell.given) {
      state = kakuro.setKakuroValue(state, i, state.solution[i]);
    }
  });
  assert.equal(state.status, "won");
  assert.equal(kakuro.checkKakuro(state).complete, true);
});

test("カックロ: 重複と合計違いを違反として検出する", () => {
  let state = kakuro.createKakuroGame(11);
  const run = state.runs.find((r) => r.cells.length >= 2);
  assert.ok(run);
  const [a, b] = run.cells;
  const editable = (i) => state.cells[i].kind === "white" && !state.cells[i].given;
  if (editable(a) && editable(b)) {
    state = kakuro.setKakuroValue(state, a, 3);
    state = kakuro.setKakuroValue(state, b, 3);
    const violations = kakuro.kakuroViolations(state);
    assert.ok(violations.some((v) => v.type === "runDup"), "重複が検出される");
  }
  // 解と1マスだけ違う入力は、そのランで合計違反（または重複）になる。
  let s2 = kakuro.createKakuroGame(11);
  const target = s2.cells.findIndex((c, i) => c.kind === "white" && !c.given && s2.solution[i] !== 9);
  s2.cells.forEach((cell, i) => {
    if (cell.kind === "white" && !cell.given) {
      s2 = kakuro.setKakuroValue(s2, i, i === target ? s2.solution[i] + 1 : s2.solution[i]);
    }
  });
  assert.notEqual(s2.status, "won");
  assert.ok(kakuro.kakuroViolations(s2).length > 0);
});

// ---- 2x2キューブ ----

test("キューブ: 完成状態は解けていて、各面の回転を4回すると戻る", () => {
  const solved = cube.createSolvedCube();
  assert.equal(cube.isCubeSolved(solved.stickers), true);
  for (const face of cube.CUBE_FACES) {
    let s = solved;
    for (let i = 0; i < 4; i++) s = cube.applyCubeMove(s, face);
    assert.deepEqual(s.stickers, solved.stickers, `${face} を4回で元に戻る`);
    assert.equal(s.moves, 4);
  }
});

test("キューブ: 回転の逆を適用すると元に戻る／そろうと won になる", () => {
  let s = cube.createSolvedCube();
  s = cube.applyCubeMove(s, "R");
  assert.equal(cube.isCubeSolved(s.stickers), false);
  assert.equal(s.status, "playing");
  s = cube.applyCubeMove(s, "R'");
  assert.deepEqual(s.stickers, cube.solvedStickers());
  assert.equal(s.status, "won");
  assert.equal(s.moves, 2);
  // 性質確認: R U のような列も逆列で戻る。
  let t = cube.createSolvedCube();
  for (const m of ["R", "U", "F'", "D"]) t = cube.applyCubeMove(t, m);
  for (const m of ["D'", "F", "U'", "R'"]) t = cube.applyCubeMove(t, m);
  assert.deepEqual(t.stickers, cube.solvedStickers());
});

test("キューブ: スクランブルは解けておらず、逆手順で必ず解ける", () => {
  for (const seed of [1, 42, 777]) {
    const state = cube.createCubeGame(seed);
    assert.equal(cube.isCubeSolved(state.stickers), false);
    assert.ok(state.scramble.length >= cube.CUBE_SCRAMBLE_LENGTH);
    let s = state;
    const inverse = [...state.scramble].reverse().map((m) => cube.inverseCubeMove(m));
    for (const m of inverse) s = cube.applyCubeMove(s, m);
    assert.deepEqual(s.stickers, cube.solvedStickers(), `シード ${seed} の逆手順で完成`);
    assert.equal(s.status, "won");
  }
  const a = cube.createCubeGame(31);
  const b = cube.createCubeGame(31);
  assert.deepEqual(a.stickers, b.stickers, "同じシードでは同じスクランブル");
  assert.deepEqual(a.scramble, b.scramble);
});

// ---- ダーツ対戦 ----

const PLAYERS2 = [
  { seat: 0, name: "A" },
  { seat: 1, name: "B" },
];

test("ダーツ対戦: エリア判定（中心はブル、外周外はミス）", () => {
  assert.equal(db.dbScoreDart(0, 0).score, 50);
  assert.equal(db.dbScoreDart(0, 0.12).score, 25);
  assert.equal(db.dbScoreDart(0, 1.2).score, 0);
  // 真上は 20 のシングル。
  const top = db.dbScoreDart(0, 0.8);
  assert.equal(top.number, 20);
  assert.equal(top.score, 20);
  // 真上のトリプルリング。
  assert.equal(db.dbScoreDart(0, 0.55).score, 60);
});

test("ダーツ対戦: 中心への投擲はブレ込みでもブルになり、手番が回る", () => {
  const rng = makeRng(3);
  let s = db.gameModule.createState(PLAYERS2, rng, {});
  assert.throws(() => db.gameModule.applyAction(s, 1, { type: "throw", x: 500, y: 500 }, rng), /手番ではありません/);
  for (let i = 0; i < 3; i++) {
    s = db.gameModule.applyAction(s, 0, { type: "throw", x: 500, y: 500 }, rng);
  }
  const view0 = db.gameModule.viewFor(s, 0);
  assert.equal(view0.players[0].total, 150, "ブル3投で150点（ブレは最大0.05でインブル内）");
  assert.equal(s.turn, 1, "3投で手番が移る");
  assert.equal(view0.throwsThisTurn, 0);
});

test("ダーツ対戦: 全ラウンドを投げ切ると終了し、合計で順位が付く", () => {
  const rng = makeRng(9);
  let s = db.gameModule.createState(PLAYERS2, rng, {});
  const totalThrows = 2 * db.DB_TOTAL_ROUNDS * 3;
  for (let i = 0; i < totalThrows; i++) {
    const seat = s.turn;
    // seat0 は中心（ブル）、seat1 は隅（ミス）を狙う。
    const at = seat === 0 ? { x: 500, y: 500 } : { x: 0, y: 0 };
    s = db.gameModule.applyAction(s, seat, { type: "throw", ...at }, rng);
  }
  assert.equal(db.gameModule.isFinished(s), true);
  const view = db.gameModule.viewFor(s, 0);
  assert.equal(view.players[0].total, 150 * db.DB_TOTAL_ROUNDS);
  assert.equal(view.players[1].total, 0);
  assert.equal(view.players[0].rank, 1);
  assert.equal(view.players[1].rank, 2);
  assert.throws(() => db.gameModule.applyAction(s, 0, { type: "throw", x: 500, y: 500 }, rng), /終了/);
});

test("ダーツ対戦: parseAction の検証と退出処理", () => {
  assert.equal(db.gameModule.parseAction({ type: "throw", x: 0, y: 1000 })?.x, 0);
  assert.equal(db.gameModule.parseAction({ type: "throw", x: -1, y: 0 }), null);
  assert.equal(db.gameModule.parseAction({ type: "throw", x: 1.5, y: 0 }), null);
  assert.equal(db.gameModule.parseAction({ type: "move", x: 0, y: 0 }), null);
  assert.equal(db.gameModule.parseAction(null), null);

  const rng = makeRng(4);
  const players3 = [
    { seat: 0, name: "A" },
    { seat: 1, name: "B" },
    { seat: 2, name: "C" },
  ];
  let s = db.gameModule.createState(players3, rng, {});
  s = db.gameModule.applyAction(s, 0, { type: "throw", x: 500, y: 500 }, rng);
  // 手番の途中で seat0 が退出すると手番は seat1 へ移る。
  s = db.gameModule.onPlayerLeft(s, 0);
  assert.equal(s.turn, 1);
  assert.equal(s.finished, false);
  // 残り1人になるまで退出すると終了する。
  s = db.gameModule.onPlayerLeft(s, 1);
  assert.equal(s.finished, true);
  const view = db.gameModule.viewFor(s, 2);
  assert.equal(view.players[2].rank, 1);
  assert.equal(view.players[0].rank, null, "退出者は順位なし");
});
