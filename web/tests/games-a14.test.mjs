// A14フェーズ新規4本のロジック検証。
// - lib/backgammon.ts: 合法手・ブロック・ヒット・バー復帰・ベアオフ・勝敗・全対局シミュレーション
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

function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const seats = (n) => Array.from({ length: n }, (_, i) => ({ seat: i, name: `P${i + 1}` }));

const bg = await loadLib("backgammon.ts");

// ---------------------------------------------------------------- バックギャモン

function bgCraft(mutate) {
  const st = bg.bgCreateGame(1);
  st.points = new Array(24).fill(0);
  st.bar = [0, 0];
  st.off = [0, 0];
  st.phase = "move";
  st.turn = 0;
  st.dice = [];
  mutate(st);
  return st;
}

function bgTotals(st) {
  let p0 = st.bar[0] + st.off[0];
  let p1 = st.bar[1] + st.off[1];
  for (const v of st.points) {
    if (v > 0) p0 += v;
    else p1 += -v;
  }
  return [p0, p1];
}

test("バックギャモン: 初期配置は両者15個ずつ", () => {
  const st = bg.bgCreateGame(11);
  assert.deepEqual(bgTotals(st), [15, 15]);
  assert.equal(st.phase, "roll");
  assert.equal(st.turn, 0);
});

test("バックギャモン: ダイスは決定的で、ゾロ目は4回分になる", () => {
  // ゾロ目が出るシードを探して検証する
  let doublesSeed = -1;
  for (let seed = 1; seed < 200; seed++) {
    const rolled = bg.bgRollDice(bg.bgCreateGame(seed));
    if (rolled.lastRoll[0] === rolled.lastRoll[1]) {
      doublesSeed = seed;
      assert.equal(rolled.dice.length, 4);
      assert.ok(rolled.dice.every((d) => d === rolled.lastRoll[0]));
      break;
    }
    assert.equal(rolled.dice.length, 2);
  }
  assert.ok(doublesSeed > 0);
  const a = bg.bgRollDice(bg.bgCreateGame(77));
  const b = bg.bgRollDice(bg.bgCreateGame(77));
  assert.deepEqual(a.lastRoll, b.lastRoll);
  assert.deepEqual(a.dice, b.dice);
});

test("バックギャモン: 初期配置の合法手とブロック", () => {
  const st = bg.bgCreateGame(1);
  st.phase = "move";
  st.dice = [3, 1];
  const moves = bg.bgLegalMoves(st);
  const has = (from, die, to) =>
    moves.some((m) => m.from === from && m.die === die && m.to === to);
  assert.ok(has(23, 3, 20));
  assert.ok(has(12, 3, 9));
  assert.ok(has(7, 1, 6));
  // 12→11 は相手5個でブロックされる
  assert.ok(!moves.some((m) => m.to === 11));
  // 相手コマ2個の 0 にも入らない（7 からは届かないが、バー復帰でも同様）
  st.bar[0] = 1;
  st.points[23] = 1;
  st.dice = [6];
  const entries = bg.bgLegalMoves(st);
  assert.ok(entries.every((m) => m.from === "bar"));
  assert.ok(!entries.some((m) => m.to === 18)); // 相手5個
  assert.ok(entries.some((m) => m.to === 18) === false);
});

test("バックギャモン: ヒットで相手コマがバーへ行く", () => {
  const st = bgCraft((s) => {
    s.points[10] = 1;
    s.points[7] = -1;
    s.dice = [3];
  });
  const after = bg.bgApplyMove(st, { from: 10, die: 3, to: 7 });
  assert.equal(after.points[7], 1);
  assert.equal(after.points[10], 0);
  assert.equal(after.bar[1], 1);
  // ダイスを使い切ると自動で手番交代
  assert.equal(after.turn, 1);
  assert.equal(after.phase, "roll");
});

test("バックギャモン: バー復帰はヒットもでき、ブロック先には入れない", () => {
  const st = bgCraft((s) => {
    s.bar[0] = 1;
    s.points[21] = -1; // 目3の復帰先に相手ブロット
    s.points[22] = -2; // 目2の復帰先はブロック
    s.dice = [3, 2];
  });
  const moves = bg.bgLegalMoves(st);
  assert.ok(moves.some((m) => m.from === "bar" && m.die === 3 && m.to === 21));
  assert.ok(!moves.some((m) => m.to === 22));
  const after = bg.bgApplyMove(st, { from: "bar", die: 3, to: 21 });
  assert.equal(after.bar[0], 0);
  assert.equal(after.bar[1], 1);
  assert.equal(after.points[21], 1);
});

test("バックギャモン: ベアオフは全コマがホームのときだけ・大きい目の条件", () => {
  const st = bgCraft((s) => {
    s.points[5] = 5;
    s.points[3] = 5;
    s.points[0] = 5;
    s.dice = [6];
  });
  assert.equal(bg.bgAllInHome(st, 0), true);
  let moves = bg.bgLegalMoves(st);
  // 5（距離6）はぴったりで上がれる
  assert.ok(moves.some((m) => m.from === 5 && m.to === "off"));
  // 3（距離4）は奥にコマがあるので大きい目では上がれない
  assert.ok(!moves.some((m) => m.from === 3 && m.to === "off"));
  // 奥のコマを無くすと大きい目で上がれる
  st.points[3] = 10;
  st.points[5] = 0;
  moves = bg.bgLegalMoves(st);
  assert.ok(moves.some((m) => m.from === 3 && m.to === "off"));
  // ホーム外にコマがあると上がれない
  st.points[10] = 1;
  st.points[3] = 9;
  assert.equal(bg.bgAllInHome(st, 0), false);
  assert.ok(!bg.bgLegalMoves(st).some((m) => m.to === "off"));
});

test("バックギャモン: 15個上がると勝ち", () => {
  const st = bgCraft((s) => {
    s.off[0] = 14;
    s.points[0] = 1;
    s.dice = [1];
  });
  const after = bg.bgApplyMove(st, { from: 0, die: 1, to: "off" });
  assert.equal(after.phase, "finished");
  assert.equal(after.winner, 0);
});

test("バックギャモン: CPU の貪欲対局を最後まで回してもコマ数が保存される", () => {
  let st = bg.bgCreateGame(2024);
  let guard = 0;
  while (st.phase !== "finished" && guard < 3000) {
    guard++;
    if (st.phase === "roll") {
      st = bg.bgRollDice(st);
      continue;
    }
    const move = bg.bgChooseMove(st);
    if (!move) {
      st = bg.bgPassTurn(st);
      continue;
    }
    st = bg.bgApplyMove(st, move);
    assert.deepEqual(bgTotals(st), [15, 15]);
  }
  assert.equal(st.phase, "finished");
  assert.ok(st.winner === 0 || st.winner === 1);
  assert.equal(st.off[st.winner], 15);
});
