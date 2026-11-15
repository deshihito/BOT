// A7フェーズの新規4本のロジック検証。
// - lib/sokoban.ts: 箱押し・クリア判定・アンドゥ・全6面の可解性
// - lib/anagram.ts: シャッフル保証・タイル操作・ヒントと採点
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


const sk = await loadLib("sokoban.ts");
const an = await loadLib("anagram.ts");

// ---------------------------------------------------------------- 倉庫番

/** 箱押し単位の BFS で面が解けるかを確認する（プレイヤー到達可能性込み）。 */
function sokobanSolvable(levelIdx) {
  const s0 = sk.createSokobanGame(levelIdx);
  const W = s0.width;
  const H = s0.height;
  const { walls, goals } = s0;
  const reach = (player, boxes) => {
    const boxSet = new Set(boxes);
    const seen = new Set([player]);
    const q = [player];
    while (q.length) {
      const p = q.pop();
      const r = Math.floor(p / W);
      const c = p % W;
      for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const nr = r + dr;
        const nc = c + dc;
        if (nr < 0 || nc < 0 || nr >= H || nc >= W) continue;
        const n = nr * W + nc;
        if (walls[n] || boxSet.has(n) || seen.has(n)) continue;
        seen.add(n);
        q.push(n);
      }
    }
    return seen;
  };
  const seen = new Set([s0.boxes.join(",")]);
  const queue = [{ boxes: s0.boxes, player: s0.player }];
  let head = 0;
  while (head < queue.length && head < 200000) {
    const cur = queue[head++];
    if (cur.boxes.every((b) => goals[b])) return true;
    const rs = reach(cur.player, cur.boxes);
    for (const b of cur.boxes) {
      const r = Math.floor(b / W);
      const c = b % W;
      for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const stand = (r - dr) * W + (c - dc);
        const dest = (r + dr) * W + (c + dc);
        if (!rs.has(stand)) continue;
        if (walls[dest] || cur.boxes.includes(dest)) continue;
        const nb = cur.boxes.map((x) => (x === b ? dest : x)).sort((a, b2) => a - b2);
        const k = nb.join(",");
        if (!seen.has(k)) {
          seen.add(k);
          queue.push({ boxes: nb, player: b });
        }
      }
    }
  }
  return false;
}

test("倉庫番: 内蔵6面すべてが解ける（箱押しBFS）", () => {
  assert.equal(sk.sokobanLevelCount(), 6);
  for (let i = 0; i < 6; i++) {
    assert.equal(sokobanSolvable(i), true, `第${i + 1}面が解けない`);
  }
});

test("倉庫番: 第1面を実際に解くとクリアになる", () => {
  // 第1面: 箱を上から押してゴールへ。@ の右が箱、箱の右下がゴール。
  let s = sk.createSokobanGame(0);
  // プレイヤーは箱の左。まず上へ回り込む: up, right, right? 盤: 6列
  // 行1(内部): "    " 行2: " @$ " 行3: "  . "
  // プレイヤー(2,2) 箱(2,3) ゴール(3,3)（0始まり: 行は map の index）
  s = sk.moveSokoban(s, "up"); // (1,2)
  s = sk.moveSokoban(s, "right"); // (1,3) 箱の上
  s = sk.moveSokoban(s, "down"); // 箱を押してゴールへ
  assert.equal(s.status, "won");
  assert.equal(s.pushes, 1);
  assert.equal(sk.isSokobanCleared(s), true);
});

test("倉庫番: 壁には進めず、箱は壁や別の箱の先へ押せない", () => {
  let s = sk.createSokobanGame(0);
  const before = s;
  s = sk.moveSokoban(s, "up");
  assert.notEqual(s, before); // 上は空いているので進める
  s = sk.moveSokoban(s, "up");
  assert.equal(s.moves, 1); // 2回目の上は壁で無効

  // 箱を壁際まで押したら、それ以上は押せない（第2面で検証）
  let t = sk.createSokobanGame(1);
  // 箱(2,2)を上へ押し続ける手順: プレイヤー(3,4)→(3,3)? ゴールがあるだけなので歩ける
  t = sk.moveSokoban(t, "left"); // (3,3)
  t = sk.moveSokoban(t, "left"); // (3,2) 箱の下
  t = sk.moveSokoban(t, "up"); // 箱を (1,2) へ押す
  assert.equal(t.pushes, 1);
  const stuck = sk.moveSokoban(t, "up"); // 箱の先は壁
  assert.equal(stuck.moves, t.moves);
  assert.equal(stuck.pushes, 1);
});

test("倉庫番: アンドゥで手数と配置が戻る／履歴なしでは何も起きない", () => {
  let s = sk.createSokobanGame(0);
  assert.equal(sk.undoSokoban(s), s);
  s = sk.moveSokoban(s, "up");
  assert.equal(s.moves, 1);
  const back = sk.undoSokoban(s);
  assert.equal(back.moves, 0);
  assert.equal(back.player, sk.createSokobanGame(0).player);
  assert.equal(back.history.length, 0);
});

// ---------------------------------------------------------------- アナグラム

test("アナグラム: バンクは30語以上で、シャッフルは元の並びにならない", () => {
  assert.ok(an.ANAGRAM_WORDS.length >= 30);
  for (const word of an.ANAGRAM_WORDS) {
    for (let seed = 0; seed < 40; seed++) {
      const { text } = an.shuffleWord(word, seed * 31 + 7);
      assert.notEqual(text, word, `${word} のシャッフルが元と同一 (seed=${seed})`);
      assert.deepEqual([...text].sort(), [...word].sort());
    }
  }
});

test("アナグラム: 出題は10問で決定的、タイルは単語の文字の並べ替え", () => {
  const a = an.createAnagramGame(99);
  const b = an.createAnagramGame(99);
  assert.deepEqual(a.words, b.words);
  assert.equal(a.words.length, 10);
  assert.equal(new Set(a.words).size, 10);
  const word = an.currentWord(a);
  assert.deepEqual(a.tiles.map((t) => t.char).sort(), [...word].sort());
  assert.notEqual(a.tiles.map((t) => t.char).join(""), word);
});

test("アナグラム: 正しく並べると正解で100点、間違えると0点", () => {
  let s = an.createAnagramGame(5);
  const word = an.currentWord(s);
  // 正解の順にタイルを選ぶ（同文字は未使用タイルから）
  const used = new Set();
  for (const ch of [...word]) {
    const tile = s.tiles.find((t) => t.char === ch && !used.has(t.id));
    used.add(tile.id);
    s = an.pickTile(s, tile.id);
  }
  assert.equal(an.currentAnswer(s), word);
  s = an.submitAnswer(s);
  assert.equal(s.status, "answered");
  assert.equal(s.lastCorrect, true);
  assert.equal(s.score, 100);
  assert.equal(s.correctCount, 1);

  // 不正解ケース（提示順のまま＝シャッフル済みで正解と異なる並びを提出する）
  let t = an.createAnagramGame(5);
  for (const tile of t.tiles) t = an.pickTile(t, tile.id);
  assert.notEqual(an.currentAnswer(t), word);
  t = an.submitAnswer(t);
  assert.equal(t.lastCorrect, false);
  assert.equal(t.score, 0);
});

test("アナグラム: ヒントは位置を開示し、得点が下がる／タイルの付け外し", () => {
  let s = an.createAnagramGame(11);
  const word = an.currentWord(s);
  s = an.useHint(s);
  assert.deepEqual(s.hintPositions, [0]);
  assert.equal(an.hintCharAt(s, 0), [...word][0]);
  assert.equal(an.hintCharAt(s, 1), null);
  assert.equal(an.anagramScoreFor(1), 80);
  assert.equal(an.anagramScoreFor(10), 40); // 下限

  const id0 = s.tiles[0].id;
  s = an.pickTile(s, id0);
  assert.equal(an.pickTile(s, id0), s); // 二重選択は無効
  assert.equal(s.picked.length, 1);
  s = an.unpickTile(s, 0);
  assert.equal(s.picked.length, 0);
  s = an.pickTile(s, id0);
  s = an.clearPicks(s);
  assert.equal(s.picked.length, 0);

  // 全タイル並べる前は判定できない
  const partial = an.pickTile(an.createAnagramGame(11), an.createAnagramGame(11).tiles[0].id);
  assert.equal(an.submitAnswer(partial), partial);
});

test("アナグラム: 10問進めると終了する", () => {
  let s = an.createAnagramGame(21);
  let guard = 0;
  while (s.status !== "finished" && guard < 50) {
    guard++;
    // 適当に全タイル並べて提出→次へ
    for (const tile of s.tiles) s = an.pickTile(s, tile.id);
    s = an.submitAnswer(s);
    assert.equal(s.status, "answered");
    s = an.nextQuestion(s);
  }
  assert.equal(s.status, "finished");
  assert.equal(s.index, 10);
});
