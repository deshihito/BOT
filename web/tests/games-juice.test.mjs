// 共通演出キット（lib/sfx.ts の汎用 SE 語彙 + app/games/GameJuice.tsx）の検証。
// - 汎用語彙の export が揃い、既存 export（bowling/crocodile 用）が維持されていること
// - 全 SE が音響環境のない場所（Node）でも例外なく no-op すること
// - ミュート状態がモジュール内で保持され、localStorage `ago-sfx-muted` を使う構造であること
// - GameJuice の公開コンポーネント/フックと globals.css の juice-* が揃っていること
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const webDir = path.join(import.meta.dirname, "..");

async function loadSfx() {
  const src = fs.readFileSync(path.join(webDir, "lib", "sfx.ts"), "utf8");
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));
}

const sfx = await loadSfx();

const GENERIC_VOCAB = [
  "sfxTap",
  "sfxPlace",
  "sfxFlip",
  "sfxDeal",
  "sfxDice",
  "sfxCorrect",
  "sfxWrong",
  "sfxWin",
  "sfxLose",
  "sfxTick",
  "sfxSpawn",
  "sfxSlide",
];

const EXISTING_EXPORTS = [
  "sfxPop",
  "sfxSafePress",
  "sfxJawSnap",
  "sfxRollStart",
  "sfxPinHit",
  "sfxPinsDown",
  "sfxGutter",
  "sfxJingle",
  "isSfxMuted",
  "setSfxMuted",
];

test("sfx: 汎用 SE 語彙の export が全て関数として存在する", () => {
  for (const name of GENERIC_VOCAB) {
    assert.equal(typeof sfx[name], "function", `${name} が export されていない`);
  }
});

test("sfx: 既存 export（bowling/crocodile 用と ミュート API）が維持されている", () => {
  for (const name of EXISTING_EXPORTS) {
    assert.equal(typeof sfx[name], "function", `${name} が失われている`);
  }
});

test("sfx: 汎用 SE は音響環境がなくても例外を投げず no-op になる", () => {
  for (const name of GENERIC_VOCAB) {
    assert.doesNotThrow(() => sfx[name](), `${name} が例外を投げた`);
  }
  assert.doesNotThrow(() => sfx.sfxPinsDown(10));
  assert.doesNotThrow(() => sfx.sfxJingle(true));
  const stop = sfx.sfxRollStart();
  assert.equal(typeof stop, "function");
  assert.doesNotThrow(() => stop());
});

test("sfx: ミュートは localStorage `ago-sfx-muted` を共通キーとして保持される", () => {
  const src = fs.readFileSync(path.join(webDir, "lib", "sfx.ts"), "utf8");
  assert.match(src, /ago-sfx-muted/);
  assert.match(src, /localStorage\.setItem\(MUTE_KEY/);
  sfx.setSfxMuted(true);
  assert.equal(sfx.isSfxMuted(), true);
  // ミュート中は汎用 SE も全て no-op（例外なし）
  for (const name of GENERIC_VOCAB) assert.doesNotThrow(() => sfx[name]());
  sfx.setSfxMuted(false);
  assert.equal(sfx.isSfxMuted(), false);
});

test("GameJuice: 公開コンポーネントとフックが export されている", () => {
  const src = fs.readFileSync(path.join(webDir, "app", "games", "GameJuice.tsx"), "utf8");
  assert.match(src, /^"use client";/);
  assert.match(src, /export function EndScreen\(/);
  assert.match(src, /export function ScorePop\(/);
  assert.match(src, /export function useAnimatedNumber\(/);
  assert.match(src, /export type EndScreenProps/);
  // 終了画面はハブ導線と「もう一度」を持ち、紙吹雪は絵文字でなく div/span で描く
  assert.match(src, /ゲーム一覧へ/);
  assert.match(src, /juice-confetti-piece/);
});

test("globals.css: juice-* の keyframes とクラスが揃っている", () => {
  const css = fs.readFileSync(path.join(webDir, "app", "globals.css"), "utf8");
  for (const name of [
    "@keyframes juice-pop-in",
    "@keyframes juice-flip-in",
    "@keyframes juice-slide-in",
    "@keyframes juice-shake-x",
    "@keyframes juice-pulse-soft",
    "@keyframes juice-confetti-fall",
    ".juice-pop",
    ".juice-flip",
    ".juice-slide",
    ".juice-shake",
    ".juice-pulse",
    ".juice-end",
    ".juice-confetti",
    ".juice-score-pop",
  ]) {
    assert.ok(css.includes(name), `${name} が globals.css にない`);
  }
});
