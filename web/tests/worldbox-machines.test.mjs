// WORLD BOX バッチ10a: 機械基盤（プログラム/共有コード/自動収穫の評価）のテスト。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const rootDir = path.join(import.meta.dirname, "..");
const libDir = path.join(rootDir, "lib");

function transpile(name, base = libDir) {
  const src = fs.readFileSync(path.join(base, name), "utf8");
  return ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}

function stripModuleSyntax(code) {
  const lines = code.split("\n");
  const out = [];
  let skippingImport = false;
  for (const line of lines) {
    if (skippingImport) {
      if (line.includes(";")) skippingImport = false;
      continue;
    }
    if (/^import\s/.test(line)) {
      if (!line.includes(";")) skippingImport = true;
      continue;
    }
    out.push(
      line
        .replace(/^export\s+(?=(const|let|var|function|class)\s)/, "")
        .replace(/^export\s+(?=async\s+function)/, "")
        .replace(/^export\s*\{[^}]*\};?\s*$/, ""),
    );
  }
  return out.join("\n");
}

function dataUrl(js) {
  return "data:text/javascript;base64," + Buffer.from(js).toString("base64");
}

async function loadBundle(files, exportNames) {
  const code =
    files.map((name) => stripModuleSyntax(transpile(name))).join("\n") +
    `\nexport { ${exportNames.join(", ")} };\n`;
  return import(dataUrl(code));
}

const M = await loadBundle(
  ["worldbox/items.ts", "worldbox/machines.ts"],
  [
    "isMachineItem", "defaultProgram", "parseProgram", "encodeProgram", "decodeProgram",
    "DEVICE_PRESETS", "parseMachineState", "machineBufferCount", "evaluateMachine",
  ],
);

test("machines: program parse clamps to known choices", () => {
  const p = M.parseProgram({ intervalSec: 999, enabled: false });
  assert.equal(p.intervalSec, 60);
  assert.equal(p.enabled, false);
  assert.equal(M.parseProgram({ intervalSec: 30 }).intervalSec, 30);
  assert.deepEqual(M.parseProgram(null), M.defaultProgram());
  assert.deepEqual(M.parseProgram("junk"), M.defaultProgram());
});

test("machines: share code roundtrip and junk rejection", () => {
  const program = { ...M.defaultProgram(), intervalSec: 300, enabled: false };
  const code = M.encodeProgram(program);
  assert.ok(code.startsWith("WB1."));
  assert.deepEqual(M.decodeProgram(code), program);
  assert.equal(M.decodeProgram("WB1.!!!"), null);
  assert.equal(M.decodeProgram("hello"), null);
  assert.equal(M.decodeProgram(42), null);
  for (const preset of M.DEVICE_PRESETS) {
    assert.deepEqual(M.decodeProgram(M.encodeProgram(preset.program)), preset.program);
  }
});

test("machines: state parse keeps only valid buffer entries", () => {
  const st = M.parseMachineState({
    ownerId: "p1", buffer: { wheat: 3, bad: -1, nope: "x" }, lastEvalAt: 5,
  });
  assert.deepEqual(st.buffer, { wheat: 3 });
  assert.equal(M.machineBufferCount(st), 3);
  assert.equal(M.parseMachineState({ buffer: {} }), null);
  assert.equal(M.parseMachineState("{"), null);
});

test("machines: evaluation harvests only own mature crops, respects interval", () => {
  const now = 1_000_000;
  const state = {
    ownerId: "p1",
    program: M.defaultProgram(),
    buffer: {},
    lastEvalAt: 0,
    updatedAt: 0,
  };
  const neighbors = new Map([
    ["0,1", { ownerId: "p1", farmland: true, crop: { cropId: "wheat", plantedAt: 0, readyAt: now - 1 } }],
    ["1,0", { ownerId: "p1", farmland: true, crop: { cropId: "carrot", plantedAt: 0, readyAt: now + 60_000 } }],
    ["1,1", { ownerId: "p2", farmland: true, crop: { cropId: "wheat", plantedAt: 0, readyAt: now - 1 } }],
  ]);
  const r = M.evaluateMachine(state, neighbors, now);
  assert.equal(r.evaluated, true);
  assert.equal(r.harvested, 2); // wheat produceCount = 2
  assert.deepEqual(r.state.buffer, { wheat: 2 });
  assert.equal(r.changed.size, 1);
  assert.equal(r.changed.get("0,1").crop, null);
  // 間隔内は評価しない
  const r2 = M.evaluateMachine(r.state, neighbors, now + 30_000);
  assert.equal(r2.evaluated, false);
  // 停止中は評価しない
  const stopped = { ...state, program: { ...M.defaultProgram(), enabled: false } };
  assert.equal(M.evaluateMachine(stopped, neighbors, now).evaluated, false);
});

test("machines: item is registered as a machine facility", () => {
  assert.equal(M.isMachineItem("auto_harvester"), true);
  assert.equal(M.isMachineItem("workbench"), false);
});
