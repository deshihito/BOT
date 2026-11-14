// A21フェーズ新規3本のロジック検証（lib のみ、UI 非依存）。
// - lib/cube.ts: 回転の性質（4回で戻る・逆回転）・完成判定・スクランブルの可解性
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

const cube = await loadLib("cube.ts");

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
