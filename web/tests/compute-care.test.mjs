// 端末への配慮（負荷の度合い）の設定が、使用率100%にならないことと、
// 度合いに応じて単調に変化することを確かめる。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

const source = fs.readFileSync(new URL("../lib/compute-care.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const care = await import("data:text/javascript;base64," + Buffer.from(outputText).toString("base64"));
const { careSettings, CARE_LEVELS } = care;

test("使用率は最大でも75%で、100%の設定は存在しない", () => {
  assert.deepEqual(CARE_LEVELS.map((l) => l.usagePercent), [25, 50, 75]);
  for (const level of ["high", "medium", "low"]) {
    assert.ok(careSettings(level, 8).usagePercent < 100);
  }
});

test("8コアでのワーカー数と休止・GPU設定", () => {
  assert.equal(careSettings("high", 8).workerCount, 2);
  assert.equal(careSettings("medium", 8).workerCount, 4);
  assert.equal(careSettings("low", 8).workerCount, 6);
  assert.equal(careSettings("high", 8).restMs, 600);
  assert.equal(careSettings("medium", 8).restMs, 300);
  assert.equal(careSettings("low", 8).restMs, 150);
  assert.equal(careSettings("high", 8).gpuTargetSubs, 4096);
  assert.equal(careSettings("medium", 8).gpuTargetSubs, 16384);
  assert.equal(careSettings("low", 8).gpuTargetSubs, 32768);
});

test("どのコア数でも全コアは使わない（最低1コア空ける）", () => {
  for (let cores = 1; cores <= 32; cores++) {
    for (const level of ["high", "medium", "low"]) {
      const s = careSettings(level, cores);
      assert.ok(s.workerCount >= 1, `${level}/${cores}`);
      if (cores > 1) assert.ok(s.workerCount <= cores - 1, `${level}/${cores}: ${s.workerCount}`);
      if (cores >= 4) assert.ok(s.workerCount / cores <= 0.75, `${level}/${cores}`);
    }
  }
  assert.equal(careSettings("low", 2).workerCount, 1);
  assert.equal(careSettings("low", 1).workerCount, 1);
});

test("配慮を弱めるほどワーカーは増え、休止は短くなる", () => {
  for (const cores of [2, 4, 8, 16]) {
    const h = careSettings("high", cores);
    const m = careSettings("medium", cores);
    const l = careSettings("low", cores);
    assert.ok(h.workerCount <= m.workerCount && m.workerCount <= l.workerCount);
    assert.ok(h.restMs > m.restMs && m.restMs > l.restMs);
    assert.ok(h.gpuTargetSubs < m.gpuTargetSubs && m.gpuTargetSubs < l.gpuTargetSubs);
  }
});
