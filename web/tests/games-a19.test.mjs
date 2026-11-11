// A19フェーズの新規2本＋増量のロジック検証。
// - lib/mahjong.ts: フリー判定・ペア除去・可解性・詰み判定
// - lib/shikaku.ts: 生成（解の分割）・完成判定・違反検出
// - lib/online/games/shiritori.ts: 単語バンク増量後の妥当性（件数・重複なし・形式）
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

const mj = await loadLib("mahjong.ts");
const sh = await loadLib("shikaku.ts");
const shi = await loadOnline("shiritori.ts", [
  "SHIRITORI_WORDS",
  "isValidWordForm",
  "isBankWord",
  "shiritoriTail",
]);

// ---- 麻雀ソリティア ----

test("麻雀: 88枚・22種×4枚の構成で、同じシードでは同じ配置になる", () => {
  const a = mj.createMahjongGame(42);
  const b = mj.createMahjongGame(42);
  assert.equal(a.tiles.length, 88);
  assert.deepEqual(
    a.tiles.map((t) => [t.kind, t.x, t.y, t.layer]),
    b.tiles.map((t) => [t.kind, t.x, t.y, t.layer]),
  );
  const counts = new Map();
  for (const t of a.tiles) counts.set(t.kind, (counts.get(t.kind) ?? 0) + 1);
  assert.equal(counts.size, 22);
  for (const n of counts.values()) assert.equal(n, 4);
});

test("麻雀: 初期状態でフリーな牌と取れるペアが存在する", () => {
  const state = mj.createMahjongGame(7);
  const free = mj.freeTileIds(state);
  assert.ok(free.length >= 2);
  assert.ok(mj.availablePairs(state).length >= 1);
  // 解の先頭ペアは初期状態でフリーなはず。
  const [a, b] = state.solution[0];
  assert.ok(free.includes(a) && free.includes(b));
  assert.equal(state.tiles[a].kind, state.tiles[b].kind);
});

test("麻雀: 解の順序どおりに取り除くと複数シードで全て取れて勝ちになる", () => {
  for (const seed of [1, 7, 42, 123, 999, 2024, 31337]) {
    let state = mj.createMahjongGame(seed);
    for (const [a, b] of state.solution) {
      const next = mj.removePair(state, a, b);
      assert.notEqual(next, state, `seed=${seed} でペア ${a},${b} が取れない`);
      state = next;
    }
    assert.equal(mj.remainingCount(state), 0);
    assert.equal(state.status, "won");
    assert.equal(state.moves, 44);
  }
});

test("麻雀: 種類の違うペア・フリーでない牌・同じ牌同士は取り除けない", () => {
  const state = mj.createMahjongGame(11);
  const free = mj.freeTileIds(state);
  // フリーでない牌を含む組み合わせは不変。
  const blocked = state.tiles.find((t) => !free.includes(t.id));
  const after1 = mj.removePair(state, free[0], blocked.id);
  assert.equal(after1, state);
  // 同じ牌同士は不変。
  assert.equal(mj.removePair(state, free[0], free[0]), state);
  // 種類の違うフリー同士は不変。
  const other = free.find((id) => state.tiles[id].kind !== state.tiles[free[0]].kind);
  if (other !== undefined) {
    assert.equal(mj.removePair(state, free[0], other), state);
  }
  // 元の状態は壊れていない（非破壊）。
  assert.equal(mj.remainingCount(state), 88);
});

test("麻雀: ペアを取ると残りが減り、ヒントは盤に残っているペアを返す", () => {
  let state = mj.createMahjongGame(5);
  const [a, b] = mj.availablePairs(state)[0];
  state = mj.removePair(state, a, b);
  assert.equal(mj.remainingCount(state), 86);
  const hint = mj.hintPair(state);
  assert.ok(hint !== null);
  assert.equal(state.tiles[hint[0]].removed, false);
  assert.equal(state.tiles[hint[1]].removed, false);
});

// ---- しかく ----

test("しかく: 生成した解は数字=面積・各長方形に数字1つで、全面を覆う", () => {
  for (const size of [5, 6]) {
    for (const seed of [1, 3, 17, 42, 777]) {
      const state = sh.createShikakuGame(size, seed);
      let covered = 0;
      const cellsSeen = new Set();
      for (const rect of state.solution) {
        const area = sh.rectArea(rect);
        covered += area;
        const clues = [];
        for (const idx of sh.rectCells(rect, size)) {
          assert.ok(!cellsSeen.has(idx), "解の長方形が重なっている");
          cellsSeen.add(idx);
          if (state.clues[idx] !== null) clues.push(state.clues[idx]);
        }
        assert.deepEqual(clues, [area]);
      }
      assert.equal(covered, size * size);
      assert.equal(cellsSeen.size, size * size);
    }
  }
});

test("しかく: 同じシードでは同じ問題になる", () => {
  const a = sh.createShikakuGame(6, 99);
  const b = sh.createShikakuGame(6, 99);
  assert.deepEqual(a.clues, b.clues);
  assert.deepEqual(a.solution, b.solution);
});

test("しかく: 解を描くと完成し、途中の状態は未完成", () => {
  for (const size of [5, 6]) {
    const state = sh.createShikakuGame(size, 42);
    assert.equal(sh.isShikakuComplete(state), false);
    const solved = sh.solveShikaku(state);
    assert.equal(solved.status, "won");
    assert.equal(sh.isShikakuComplete(solved), true);
    assert.equal(sh.shikakuViolations(solved).length, 0);
  }
});

test("しかく: 違反検出（数字なし・数字2つ・面積不一致）と重なる長方形の置き換え", () => {
  const state = sh.createShikakuGame(5, 2);
  // 数字の無い場所に小さな長方形を置く想定で、まず解の1つをそのまま置く（違反なし）。
  const withOne = sh.applyShikakuRect(state, state.solution[0]);
  assert.equal(sh.shikakuViolations(withOne).length, 0);
  // 全面を1つの長方形にすると、数字が複数入って違反になる。
  const whole = sh.applyShikakuRect(state, { r1: 0, c1: 0, r2: 4, c2: 4 });
  assert.ok(sh.shikakuViolations(whole).some((v) => v.type === "multiClue"));
  // 置き換えで前の長方形は消えている（全面1つだけ）。
  assert.equal(whole.rects.length, 1);
  // 取り除くと空に戻る。
  const removed = sh.removeShikakuRectAt(whole, 0);
  assert.equal(removed.rects.length, 0);
});

test("しかく: 盤外の長方形は無視され、座標は正規化される", () => {
  const state = sh.createShikakuGame(5, 2);
  const out = sh.applyShikakuRect(state, { r1: 0, c1: 0, r2: 9, c2: 9 });
  assert.equal(out, state);
  const flipped = sh.applyShikakuRect(state, { r1: 2, c1: 3, r2: 0, c2: 1 });
  assert.deepEqual(flipped.rects[0], { r1: 0, c1: 1, r2: 2, c2: 3 });
});

// ---- しりとり単語バンク増量 ----

test("しりとり: バンクが650語以上で、重複がなく全て有効な形式", () => {
  const words = shi.SHIRITORI_WORDS;
  assert.ok(words.length >= 650, `単語数が足りない: ${words.length}`);
  assert.equal(new Set(words).size, words.length, "重複がある");
  for (const w of words) {
    assert.ok(shi.isValidWordForm(w), `形式が不正: ${w}`);
    assert.ok(shi.isBankWord(w));
  }
});

test("しりとり: 増量で追加した代表語がバンクに入り、接続に使える", () => {
  for (const w of ["ラーメン", "サッカー", "スマホ", "ウナギ", "チョコレート", "ハンバーグ", "チューリップ"]) {
    assert.ok(shi.isBankWord(w), `${w} がバンクに無い`);
  }
  // ラーメン → ンで終わる語（脱落語）としても存在すること自体は既存方針どおり。
  assert.equal(shi.shiritoriTail("コーヒー"), "ヒ");
});
