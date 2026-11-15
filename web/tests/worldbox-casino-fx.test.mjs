// カジノ演出階級（casino-fx）の検証と、パネルの演出配線の確認。
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
function dataUrl(js) {
  return "data:text/javascript;base64," + Buffer.from(js).toString("base64");
}

const fx = await import(dataUrl(transpile("worldbox/casino-fx.ts")));

test("casino-fx: 配当倍率で階級が上がる", () => {
  assert.equal(fx.winTier(0, 100), 0);
  assert.equal(fx.winTier(-5, 100), 0);
  assert.equal(fx.winTier(100, 100), 1); // 等倍
  assert.equal(fx.winTier(120, 100), 1); // ペア 1.2 倍
  assert.equal(fx.winTier(200, 100), 2);
  assert.equal(fx.winTier(999, 100), 2);
  assert.equal(fx.winTier(1000, 100), 3);
  assert.equal(fx.winTier(4999, 100), 3);
  assert.equal(fx.winTier(5000, 100), 4);
  assert.equal(fx.winTier(30000, 100), 4); // 7 揃い ×300
  assert.equal(fx.winTier(100, 0), 0); // ベット不正は 0
});

test("casino-fx: 階級が上がるほど演出が強い（単調）", () => {
  let prev = fx.tierFx(0);
  for (const t of [1, 2, 3, 4]) {
    const cur = fx.tierFx(t);
    assert.ok(cur.confetti >= prev.confetti, `tier ${t} confetti`);
    assert.ok(cur.countUpMs >= prev.countUpMs, `tier ${t} countUp`);
    prev = cur;
  }
  assert.equal(fx.tierFx(0).confetti, 0);
  assert.equal(fx.tierFx(4).shake, true);
  assert.equal(fx.tierFx(1).shake, false);
});

test("casino-fx: カウントアップは単調増加で終端が一致", () => {
  assert.equal(fx.countUpValue(0, 1000, 0), 0);
  assert.equal(fx.countUpValue(0, 1000, 1), 1000);
  assert.equal(fx.countUpValue(0, 1000, 2), 1000); // クランプ
  let prev = -1;
  for (let t = 0; t <= 1.0001; t += 0.1) {
    const v = fx.countUpValue(0, 777, t);
    assert.ok(v >= prev && v <= 777);
    prev = v;
  }
});

test("casino-fx: リーチは先2つの一致だけ", () => {
  assert.equal(fx.isReach([3, 3, 1]), true);
  assert.equal(fx.isReach([3, 1, 3]), false);
  assert.equal(fx.isReach([1, 2, 3]), false);
  assert.equal(fx.isReach([5]), false);
});

test("casino-fx: 紙吹雪は個数どおりで色がパレット内", () => {
  let seed = 42;
  const rng = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const parts = fx.confettiParticles(50, rng);
  assert.equal(parts.length, 50);
  for (const p of parts) {
    assert.ok(fx.CONFETTI_COLORS.includes(p.color));
    assert.ok(p.size >= 4 && p.size <= 10);
    assert.ok(p.delay >= 0 && p.delay <= 0.25);
  }
  assert.equal(fx.confettiParticles(0, rng).length, 0);
});

test("casino-fx: パネルに演出が配線されている", () => {
  const panel = fs.readFileSync(path.join(rootDir, "app/games/worldbox/WorldBoxCasinoPanel.tsx"), "utf8");
  assert.match(panel, /casino-fx/);
  assert.match(panel, /ConfettiCanvas/);
  assert.match(panel, /CountUp/);
  assert.match(panel, /リーチ/);
  assert.match(panel, /sfxJingle/);
  assert.match(panel, /wb-casino-reach/);
  assert.match(panel, /rolling7/);
});
