// 櫻井流バッチ3「テンポ監査・詰み救済・CPU の人間らしさ」の検証。
// - A テンポ: numbermemory の正解→次問の待ち 1100→650ms、simon の再生
//   リードイン 550→350ms。ゲーム性のある演出（slot のリール停止）は
//   対象外として不変を固定する。
// - B 救済: lib にソルバー/解データがあるのに導線が無かった lightsout へ
//   ヒントを追加。remainingPresses の正しさとクライアント配線を検証する。
//   （同時に追加した shikaku のヒントは、2026-11-15 のカタログ削減で
//   shikaku 自体を削除したため、このファイルからも検証ごと外した。
//   roulette の回転時間の固定も同様に削除した。）
// - C 人間らしさ: chess CPU に最小思考時間 280〜450ms（手の選択は不変）。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const webDir = path.join(import.meta.dirname, "..");

async function loadLib(name) {
  const src = fs.readFileSync(path.join(webDir, "lib", name), "utf8");
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));
}

function read(rel) {
  return fs.readFileSync(path.join(webDir, rel), "utf8");
}

const lights = await loadLib("lightsout.ts");

// ---- B: lightsout remainingPresses ----

test("ライツアウト: 残り解は初期盤では solutionPresses と一致する", () => {
  for (const seed of [1, 42, 777]) {
    const state = lights.createLightsOutGame(5, seed, "normal");
    assert.deepEqual(lights.remainingPresses(state, []), [...lights.solutionPresses(state)].sort((a, b) => a - b));
  }
});

test("ライツアウト: 残り解を順に押せば必ず全消灯する（偶奇の対称差）", () => {
  for (const seed of [3, 99, 12345]) {
    let state = lights.createLightsOutGame(4, seed, "hard");
    const parity = new Set();
    // 途中で解に無いマスを1つ押して寄り道しても、残り解がそれを打ち消しに戻す。
    const stray = state.cells.findIndex((_, i) => !lights.solutionPresses(state).includes(i));
    state = lights.pressCell(state, stray);
    parity.add(stray);
    let guard = 0;
    while (!lights.isComplete(state) && guard++ < 40) {
      const rest = lights.remainingPresses(state, parity);
      assert.ok(rest.length > 0, "未完成なのに残り解が空");
      const idx = rest[0];
      state = lights.pressCell(state, idx);
      if (parity.has(idx)) parity.delete(idx);
      else parity.add(idx);
    }
    assert.equal(lights.isComplete(state), true, `seed=${seed} で全消灯に到達`);
    assert.equal(lights.remainingPresses(state, parity).length, 0);
  }
});

test("ライツアウト: クライアントに回数制限つきヒント導線がある", () => {
  const lo = read("app/games/lightsout/LightsOutClient.tsx");
  assert.match(lo, /remainingPresses/);
  assert.match(lo, /ヒント（残り/);
  assert.match(lo, /HINT_LIMIT = 3/);
});

// ---- A: テンポ ----

test("テンポ: numbermemory の正解→次問は 650ms、simon のリードインは 350ms", () => {
  const nm = read("app/games/numbermemory/NumberMemoryClient.tsx");
  assert.match(nm, /showNumber\(next\), 650\)/);
  assert.ok(!nm.includes("showNumber(next), 1100"), "旧 1100ms が残っていない");
  const simon = read("app/games/simon/SimonClient.tsx");
  assert.match(simon, /leadInMs = 350/);
  assert.ok(!simon.includes("550 +"), "旧 550ms リードインが残っていない");
});

test("テンポ: ゲーム性の演出時間は対象外として不変（slot リール）", () => {
  const slot = read("app/games/slot/SlotClient.tsx");
  assert.match(slot, /\[650, 1150, 1650\]/);
});

// ---- C: chess CPU の最小思考時間 ----

test("chess: CPU に最小思考時間があり、手の選択ロジックは従来どおり", () => {
  const chess = read("app/games/chess/ChessClient.tsx");
  assert.match(chess, /minThinkMs = 280 \+ Math\.random\(\) \* 170/);
  assert.match(chess, /findBestMove\(parseFen\(fen\)/);
  assert.match(chess, /applyUciMove\(current, uci\)/);
});
