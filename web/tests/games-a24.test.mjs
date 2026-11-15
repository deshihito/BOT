// A24フェーズ新規3本のロジック検証（lib のみ、UI 非依存）。
// - lib/river.ts: 最短手数（BFS）・最短手順での勝利・失敗判定・積み下ろし規則
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

const rv = await loadLib("river.ts");

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

// ---- 川渡り ----

test("川渡り: 問題は12題あり、全て解けて最短手数が既知の値と一致する", () => {
  assert.equal(rv.RIVER_PROBLEMS.length, 12);
  const expected = { classic: 7, fox: 7, bigboat: 3, pets: 3, catfish: 7, flower: 3, bear: 7, farmpets: 5, doublechain: 7, herd: 7, pasture: 7, foxhole: 7 };
  for (const p of rv.RIVER_PROBLEMS) {
    assert.equal(rv.riverMinCrossings(p), expected[p.id], p.id);
  }
});

test("川渡り: クラシック題は最短手順で7回渡って勝利する", () => {
  let s = rv.createRiverGame("classic");
  const carry = (id) => {
    s = rv.toggleRiverItem(s, id);
    s = rv.crossRiver(s);
  };
  const back = (id) => {
    if (id) s = rv.toggleRiverItem(s, id);
    s = rv.crossRiver(s);
  };
  carry("goat");
  back(null);
  carry("wolf");
  back("goat");
  carry("cabbage");
  back(null);
  carry("goat");
  assert.equal(s.status, "won");
  assert.equal(s.crossings, 7);
  assert.equal(s.crossings, rv.riverMinCrossings(rv.getRiverProblem("classic")));
  // 勝利後の操作は無効
  assert.equal(rv.crossRiver(s), s);
  assert.equal(rv.toggleRiverItem(s, "goat"), s);
});

test("川渡り: 危険なペアを残して渡ると失敗し理由が付く", () => {
  let s = rv.createRiverGame("classic");
  // 最初にオオカミを運ぶと、左岸にヤギとキャベツが残って失敗する
  s = rv.toggleRiverItem(s, "wolf");
  s = rv.crossRiver(s);
  assert.equal(s.status, "failed");
  assert.ok(s.failMessage?.includes("ヤギ"));
  assert.ok(s.failMessage?.includes("キャベツ"));
  assert.equal(s.crossings, 1);
  // 失敗後の操作は無効
  assert.equal(rv.crossRiver(s), s);
});

test("川渡り: 積み下ろしの規則（定員・向こう岸・降ろすと岸に戻る）", () => {
  let s = rv.createRiverGame("classic");
  // 定員1: 2つ目は乗せられない
  s = rv.toggleRiverItem(s, "goat");
  assert.equal(s.locations.goat, "boat");
  assert.equal(rv.toggleRiverItem(s, "wolf"), s);
  // ボートの荷物をタップすると農夫のいる岸に降りる
  s = rv.toggleRiverItem(s, "goat");
  assert.equal(s.locations.goat, "left");
  // ヤギだけ右岸に運んだあと、農夫だけ左岸へ戻ると、右岸のヤギは触れない
  s = rv.toggleRiverItem(s, "goat");
  s = rv.crossRiver(s);
  assert.equal(s.locations.goat, "right"); // 渡ると荷物は自動で岸に降りる
  s = rv.crossRiver(s); // 農夫だけ左岸へ戻る
  assert.equal(s.farmerSide, "left");
  assert.equal(s.locations.goat, "right");
  assert.equal(rv.toggleRiverItem(s, "goat"), s); // 向こう岸の荷物は触れない
  // 未知の荷物は無効
  assert.equal(rv.toggleRiverItem(s, "dragon"), s);
});
