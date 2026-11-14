// 櫻井流バッチ1「手応え層」の検証。
// - lib/juice.ts の純粋ロジック（ヒットストップ3段・振動パターン・体積保存
//   スカッシュ・ヒットマーク寿命・フラッシュ明暗）
// - 薄い DOM ヘルパーがフェイク要素でも動き、null/環境なしで例外を投げない
// - globals.css の juice-* 手応えクラスと GameJuice の React 公開面
// - sfx の優先度階層（#032）と新語彙 sfxHit / sfxKo
// - three-kit stage の hitstop / shake（オプトイン）
// - 代表5タイトル（snake/minesweeper/reversi/slot/chess）への配線
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const webDir = path.join(import.meta.dirname, "..");

function transpile(relPath) {
  const src = fs.readFileSync(path.join(webDir, relPath), "utf8");
  return ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}

async function loadModule(relPath) {
  const js = transpile(relPath);
  return import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));
}

const juice = await loadModule("lib/juice.ts");
const sfx = await loadModule("lib/sfx.ts");

function fakeElement() {
  const classes = new Set();
  const props = new Map();
  const children = [];
  return {
    classes,
    props,
    children,
    classList: {
      add: (...names) => names.forEach((n) => classes.add(n)),
      remove: (...names) => names.forEach((n) => classes.delete(n)),
    },
    style: { setProperty: (k, v) => props.set(k, v) },
    appendChild: (c) => {
      children.push(c);
      return c;
    },
  };
}

test("juice: ヒットストップは3段 40/70/120ms で、power 係数がクランプされる", () => {
  assert.deepEqual(juice.HITSTOP_MS, { 1: 40, 2: 70, 3: 120 });
  assert.equal(juice.hitstopDurationMs(1), 40);
  assert.equal(juice.hitstopDurationMs(2), 70);
  assert.equal(juice.hitstopDurationMs(3), 120);
  assert.equal(juice.hitstopDurationMs(3, 2), 240);
  assert.equal(juice.hitstopDurationMs(3, 100), 240);
  assert.equal(juice.hitstopDurationMs(1, 0), 20);
  assert.equal(juice.clampIntensity(0), 1);
  assert.equal(juice.clampIntensity(2), 2);
  assert.equal(juice.clampIntensity(9), 3);
});

test("juice: 微振動は受け側＞与え側（#047）で強さとともに増える", () => {
  for (const i of [1, 2, 3]) {
    assert.ok(juice.vibrateAmplitudePx(i, "target") > juice.vibrateAmplitudePx(i, "source"));
  }
  assert.ok(juice.vibrateAmplitudePx(3, "target") > juice.vibrateAmplitudePx(1, "target"));
});

test("juice: 振動パターンは強さで切り替わり、振幅は収束する（#103）", () => {
  assert.equal(juice.shakePattern(1), "vertical");
  assert.equal(juice.shakePattern(2), "both");
  assert.equal(juice.shakePattern(3), "random");
  // 小は縦のみ（x は常時 0）
  for (const p of [0, 0.25, 0.5, 0.75]) assert.equal(juice.shakeOffsetAt(1, p).x, 0);
  // 収束: 終端ではほぼ 0
  const end = juice.shakeOffsetAt(2, 1);
  assert.equal(end.x, 0);
  assert.equal(end.y, 0);
  // 序盤は終盤より大きい
  const early = Math.abs(juice.shakeOffsetAt(2, 0.1).y);
  const late = Math.abs(juice.shakeOffsetAt(2, 0.8).y);
  assert.ok(early > late);
  // random パターンでも振幅上限を超えない
  const off = juice.shakeOffsetAt(3, 0, () => 1);
  assert.ok(Math.abs(off.x) <= juice.shakeAmplitudePx(3));
  assert.ok(Math.abs(off.y) <= juice.shakeAmplitudePx(3));
});

test("juice: スカッシュは体積保存（sx*sy=1）でクランプされる（#120）", () => {
  for (const a of [-0.45, -0.2, 0, 0.22, 0.45]) {
    const { sx, sy } = juice.squashScales(a);
    assert.ok(Math.abs(sx * sy - 1) < 1e-9, `amount=${a} で体積が保存されていない`);
  }
  const squashed = juice.squashScales(0.3);
  assert.ok(squashed.sy < 1 && squashed.sx > 1);
  assert.deepEqual(juice.squashScales(10), juice.squashScales(0.45));
});

test("juice: ヒットマークは連続120ms/単発250ms、フラッシュは明暗交互（#130/#221）", () => {
  assert.equal(juice.hitmarkLifetimeMs(true), 120);
  assert.equal(juice.hitmarkLifetimeMs(false), 250);
  const steps = juice.flashBrightnessSteps();
  assert.ok(steps.some((v) => v > 1) && steps.some((v) => v < 1), "明と暗の両方が必要");
  assert.equal(steps[steps.length - 1], 1);
});

test("juice: DOM ヘルパーはフェイク要素にクラスと CSS 変数を付け、null では no-op", async () => {
  const el = fakeElement();
  juice.juiceHitstop(el, 2);
  assert.ok(el.classes.has("juice-hitstop"));
  assert.ok(el.classes.has("juice-vibrate"));
  assert.ok(Number(el.props.get("--juice-vibrate-px").replace("px", "")) > 0);
  juice.juiceShake(el, 3);
  assert.ok(el.classes.has("juice-shake-3"));
  juice.juiceFlash(el);
  assert.ok(el.classes.has("juice-flash"));
  juice.juiceSquash(el, 0.3);
  assert.ok(el.classes.has("juice-squash"));
  const { sx, sy } = juice.squashScales(0.3);
  assert.equal(Number(el.props.get("--juice-sx")), sx);
  assert.equal(Number(el.props.get("--juice-sy")), sy);
  // 凍結クラスは時間経過で外れる
  await new Promise((r) => setTimeout(r, 90));
  assert.ok(!el.classes.has("juice-hitstop"));
  assert.doesNotThrow(() => {
    juice.juiceHitstop(null);
    juice.juiceShake(undefined);
    juice.juiceFlash(null);
    juice.juiceSquash(undefined);
    juice.juiceHit(null);
  });
});

test("juice: ヒットマークは document が無い環境では null を返し例外を投げない", () => {
  const el = fakeElement();
  assert.equal(juice.juiceHitmark(el, 2), null);
  assert.doesNotThrow(() => juice.juiceHit(el, 3));
});

test("globals.css: 手応え層の keyframes とクラスが揃っている", () => {
  const css = fs.readFileSync(path.join(webDir, "app", "globals.css"), "utf8");
  for (const name of [
    ".juice-hitstop",
    "@keyframes juice-vibrate-kf",
    ".juice-vibrate",
    "@keyframes juice-shake-1-kf",
    "@keyframes juice-shake-2-kf",
    "@keyframes juice-shake-3-kf",
    ".juice-shake-1",
    ".juice-shake-2",
    ".juice-shake-3",
    "@keyframes juice-flash-kf",
    ".juice-flash",
    ".juice-hitmark",
    ".juice-hitmark-ring",
    ".juice-hitmark-spark",
    "@keyframes juice-squash-kf",
    ".juice-squash",
    ".juice-pressable",
    "prefers-reduced-motion",
  ]) {
    assert.ok(css.includes(name), `${name} が globals.css にない`);
  }
  // 押下フィードバックは :active のスケールで即時に返す（#049）
  assert.match(css, /\.juice-pressable:active\s*\{\s*transform:scale/);
});

test("GameJuice: useJuice フックと JuiceHit コンポーネントが公開されている", () => {
  const src = fs.readFileSync(path.join(webDir, "app", "games", "GameJuice.tsx"), "utf8");
  assert.match(src, /export function useJuice</);
  assert.match(src, /export function JuiceHit/);
  assert.match(src, /from "@\/lib\/juice"/);
  // ヒットマークは絵文字でなく span で描く
  assert.match(src, /juice-hitmark-ring/);
  assert.match(src, /juice-hitmark-spark/);
});

test("sfx: 優先度階層は tier1＞2＞3＞4＞5 で単調（#032）", () => {
  const gains = [1, 2, 3, 4, 5].map((t) => sfx.SFX_TIER_GAIN[t]);
  for (let i = 1; i < gains.length; i++) assert.ok(gains[i] < gains[i - 1], "tier が下がるほど小さく");
  const tiers = sfx.SFX_VOCAB_TIERS;
  assert.equal(tiers.sfxWin, 1);
  assert.equal(tiers.sfxKo, 1);
  assert.equal(tiers.sfxHit, 2);
  assert.equal(tiers.sfxCorrect, 2);
  assert.equal(tiers.sfxPlace, 3);
  assert.equal(tiers.sfxDeal, 3);
  assert.equal(tiers.sfxTap, 4);
  assert.equal(tiers.sfxTick, 5);
  assert.ok(tiers.sfxWin < tiers.sfxHit && tiers.sfxHit < tiers.sfxPlace && tiers.sfxPlace < tiers.sfxTap && tiers.sfxTap < tiers.sfxTick);
});

test("sfx: 新語彙 sfxHit / sfxKo が存在し、無音環境でも例外を投げない", () => {
  assert.equal(typeof sfx.sfxHit, "function");
  assert.equal(typeof sfx.sfxKo, "function");
  assert.doesNotThrow(() => {
    sfx.sfxHit();
    sfx.sfxHit(1);
    sfx.sfxHit(3);
    sfx.sfxKo();
  });
});

test("three-kit stage: hitstop / shake がオプトインで公開されている", () => {
  const src = fs.readFileSync(path.join(webDir, "lib", "three-kit", "stage.ts"), "utf8");
  assert.match(src, /hitstop: \(intensity/);
  assert.match(src, /shake: \(intensity/);
  assert.match(src, /from "\.\.\/juice"/);
  assert.match(src, /hitstopDurationMs/);
  assert.match(src, /shakeOffsetAt/);
  // 凍結中は dt=0 で onFrame を呼び続ける構造
  assert.match(src, /const dt = frozen \? 0 : rawDt/);
});

test("代表5タイトル: 手応え層（hitstop/hitmark/sfxHit 系）が配線されている", () => {
  const cases = [
    ["snake", "SnakeClient.tsx", ["sfxHit", "sfxKo", "juiceHitstop", "JuiceHit"]],
    ["minesweeper", "MinesweeperClient.tsx", ["sfxHit", "juiceHitstop", "juiceShake", "JuiceHit", "juice-pressable"]],
    ["reversi", "ReversiClient.tsx", ["sfxHit", "juiceHitstop", "JuiceHit", "juice-pressable"]],
    ["slot", "SlotClient.tsx", ["sfxHit", "sfxKo", "juiceHitstop", "JuiceHit", "juice-pressable"]],
    ["chess", "ChessClient.tsx", ["sfxHit", "sfxKo", "sfxPlace", "sfxTap", "juiceHitstop", "JuiceHit", "juice-pressable"]],
  ];
  for (const [dir, file, needles] of cases) {
    const src = fs.readFileSync(path.join(webDir, "app", "games", dir, file), "utf8");
    for (const needle of needles) {
      assert.ok(src.includes(needle), `${dir}/${file} に ${needle} の配線がない`);
    }
    assert.ok(src.includes("@/lib/juice"), `${dir}/${file} が lib/juice を使っていない`);
  }
});
