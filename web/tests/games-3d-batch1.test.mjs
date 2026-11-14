// 3D化 第1期（three-kit 共通基盤＋第1バッチ9本）の回帰テスト（静的検査）。
// - three-kit の公開APIが揃っていること
// - 対象ゲームが dynamic import (ssr:false) でシーンを遅延読み込みしていること
//   （three を共通 First Load JS に混ぜない）
// - クライアント側に three の直接 import がないこと（シーン側だけに閉じる）
// - <button> 数が PR #796 時点から増えていないこと
// - ロジック（lib/*.ts）へ three が混入していないこと
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const webDir = path.join(import.meta.dirname, "..");
const read = (...p) => fs.readFileSync(path.join(webDir, ...p), "utf8");
const countButtons = (dir) => {
  let n = 0;
  for (const f of fs.readdirSync(path.join(webDir, "app", "games", dir))) {
    if (f.endsWith(".tsx")) n += (read("app", "games", dir, f).match(/<button/g) ?? []).length;
  }
  return n;
};

const BATCH = [
  { dir: "chinchiro", client: "ChinchiroClient.tsx", scene: "ChinchiroScene3D.tsx", buttons: 1 },
  { dir: "yahtzee", client: "YahtzeeClient.tsx", scene: "YahtzeeScene3D.tsx", buttons: 1 },
  { dir: "roulette", client: "RouletteClient.tsx", scene: "RouletteScene3D.tsx", buttons: 0 },
  { dir: "hanoi", client: "HanoiClient.tsx", scene: "HanoiScene3D.tsx", buttons: 1 },
  { dir: "reversi", client: "ReversiClient.tsx", scene: "ReversiScene3D.tsx", buttons: 2 },
  { dir: "2048", client: "SliderClient.tsx", scene: "SliderScene3D.tsx", buttons: 1 },
  { dir: "gomoku", client: "GomokuClient.tsx", scene: "GomokuScene3D.tsx", buttons: 1 },
  { dir: "connect4", client: "Connect4Client.tsx", scene: "Connect4Scene3D.tsx", buttons: 2 },
  { dir: "slot", client: "SlotClient.tsx", scene: "SlotScene3D.tsx", buttons: 0 },
];

test("three-kit: 共通基盤の公開APIが揃っている", () => {
  const stage = read("lib", "three-kit", "stage.ts");
  assert.match(stage, /export function createStage/);
  assert.match(stage, /export const CAMERA_PRESETS/);
  assert.match(stage, /boardTilt/);
  assert.match(stage, /pixelRatioCap/);
  const prim = read("lib", "three-kit", "primitives.ts");
  for (const name of ["createDie", "quaternionForDieValue", "createDisc", "createStone", "createChip", "createCard", "createTileCube", "createBall", "createPeg", "createRingDisc", "canvasTexture"]) {
    assert.match(prim, new RegExp(`export (function|const) ${name}`), name);
  }
  const dice = read("lib", "three-kit", "dice.ts");
  assert.match(dice, /export class DiceSet/);
  assert.match(dice, /roll\(/);
  const pointer = read("lib", "three-kit", "pointer.ts");
  assert.match(pointer, /export function attachPickPointer/);
  assert.match(pointer, /swipeDirection/); // 方向判定は lib/gesture の再利用
  const box = read("lib", "three-kit", "SceneBox.tsx");
  assert.match(box, /fallback/);
});

test("three-kit: サイコロの面配置は向かい合う面の合計が7", async () => {
  const src = read("lib", "three-kit", "primitives.ts");
  const m = src.match(/DIE_FACE_VALUES = \[([0-9, ]+)\]/);
  assert.ok(m, "DIE_FACE_VALUES が見つかる");
  const values = m[1].split(",").map((s) => Number(s.trim()));
  assert.equal(values.length, 6);
  for (const [a, b] of [[0, 1], [2, 3], [4, 5]]) {
    assert.equal(values[a] + values[b], 7, `face ${a}+${b}`);
  }
});

for (const g of BATCH) {
  test(`3D ${g.dir}: シーンは dynamic import で遅延読み込みされ、three はシーン側だけ`, () => {
    const client = read("app", "games", g.dir, g.client);
    assert.match(client, new RegExp(`dynamic\\(\\(\\) => import\\("\\./${g.scene.replace(".tsx", "")}"\\), \\{ ssr: false \\}\\)`), "dynamic import");
    assert.doesNotMatch(client, /from "three"/, "クライアントに three を直接 import しない");
    const scene = read("app", "games", g.dir, g.scene);
    assert.match(scene, /from "three"/);
    assert.match(scene, /three-kit/, "共通基盤を使う");
    assert.match(scene, /createStage/, "ステージは共通基盤から作る");
    assert.match(client, /onFail|webglFailed/, "WebGL 失敗時のフォールバックがある");
  });

  test(`3D ${g.dir}: <button> 数が PR #796 時点（${g.buttons}）から増えていない`, () => {
    assert.ok(countButtons(g.dir) <= g.buttons, `${g.dir} buttons=${countButtons(g.dir)}`);
  });
}

test("3D: ロジック層（lib/*.ts 本体）に three が混入していない", () => {
  for (const f of fs.readdirSync(path.join(webDir, "lib"))) {
    if (!f.endsWith(".ts")) continue;
    const src = read("lib", f);
    assert.doesNotMatch(src, /from "three"/, `lib/${f}`);
  }
});

test("3D: 先行2本（bowling/crocodile）は従来どおり dynamic import のまま", () => {
  for (const [dir, client] of [["bowling", "BowlingClient.tsx"], ["crocodile", "CrocodileClient.tsx"]]) {
    const src = read("app", "games", dir, client);
    assert.match(src, /dynamic\(/, dir);
  }
});
