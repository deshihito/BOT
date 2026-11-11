// A23フェーズ新規3本のロジック検証（lib のみ、UI 非依存）。
// - lib/akari.ts: 照射・衝突と数字の検証・解による完成・壁マスの不変性
// - lib/diceroll.ts: 向き遷移・反対面の和・可解性（解経路で勝利）・障害物の不変性
// - lib/online/games/bingobattle.ts: カード妥当性・抽選と決着・秘匿・退出
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

const ak = await loadLib("akari.ts");
const dr = await loadLib("diceroll.ts");
const bb = await loadOnline("bingobattle.ts", [
  "gameModule",
  "BB_MAX_NUMBER",
  "BB_DRAW_INTERVAL_MS",
  "bbCreateCard",
  "bbIsValidCard",
  "bbCardStatus",
]);

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

// ---- あかり ----

test("あかり: 同じシードでは同じ問題になる", () => {
  const a = ak.createAkariGame(42);
  const b = ak.createAkariGame(42);
  assert.deepEqual(a.walls, b.walls);
  assert.deepEqual(a.numbers, b.numbers);
  assert.deepEqual(a.solution, b.solution);
  assert.equal(a.rows, 7);
  assert.equal(a.cols, 7);
  // 壁に数字が付いていて、解は壁と重ならない
  assert.ok(Object.keys(a.numbers).length >= 3);
  for (const bulb of a.solution) assert.ok(!a.walls.includes(bulb));
});

test("あかり: 解の電球配置は全白マスを照らし、衝突も数字違いも無い", () => {
  for (const seed of [1, 7, 42, 777, 2024]) {
    const g = ak.createAkariGame(seed);
    let s = g;
    for (const bulb of g.solution) s = ak.toggleBulb(s, bulb);
    const ev = ak.evaluateAkari(s);
    assert.equal(ev.litCount, ev.whiteCount, `seed ${seed}`);
    assert.deepEqual(ev.conflictBulbs, []);
    assert.deepEqual(ev.numberErrors, []);
    assert.equal(ev.solved, true);
    assert.equal(s.status, "won");
    assert.equal(s.moves, g.solution.length);
  }
});

test("あかり: 電球同士が向かい合うと衝突として検出される", () => {
  const g = ak.createAkariGame(5);
  // 同じ行で壁を挟まず並ぶ白マス2つを探す
  const row = 0;
  const whites = [];
  for (let c = 0; c < g.cols; c++) {
    const idx = row * g.cols + c;
    if (!g.walls.includes(idx)) whites.push(idx);
  }
  assert.ok(whites.length >= 2);
  // 最初の白マスと同じ行セグメントにある次の白マスを探して置く
  const a = whites[0];
  let b = -1;
  for (let k = 1; k < whites.length; k++) {
    const cand = whites[k];
    let blocked = false;
    for (let c = (a % g.cols) + 1; c < cand % g.cols; c++) {
      if (g.walls.includes(row * g.cols + c)) blocked = true;
    }
    if (!blocked) {
      b = cand;
      break;
    }
  }
  assert.ok(b > 0, "同じ行セグメントの白マスが2つあること");
  let s = ak.toggleBulb(g, a);
  s = ak.toggleBulb(s, b);
  const ev = ak.evaluateAkari(s);
  assert.ok(ev.conflictBulbs.includes(a));
  assert.ok(ev.conflictBulbs.includes(b));
  assert.equal(ev.solved, false);
});

test("あかり: 数字付き黒マスの隣から電球を外すと不一致になる", () => {
  const g = ak.createAkariGame(9);
  // 数字>0 の壁と、それに接する解の電球を探す
  let wallIndex = -1;
  let bulbIndex = -1;
  for (const [key, expected] of Object.entries(g.numbers)) {
    if (expected <= 0) continue;
    const idx = Number(key);
    const r = Math.floor(idx / g.cols);
    const c = idx % g.cols;
    for (const [dr2, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const nr = r + dr2;
      const nc = c + dc;
      if (nr < 0 || nc < 0 || nr >= g.rows || nc >= g.cols) continue;
      const nIdx = nr * g.cols + nc;
      if (g.solution.includes(nIdx)) {
        wallIndex = idx;
        bulbIndex = nIdx;
        break;
      }
    }
    if (wallIndex >= 0) break;
  }
  assert.ok(wallIndex >= 0, "数字>0 の壁に接する解の電球が存在すること");
  // 解からその電球だけを除いた配置では、その壁が不一致になる
  const partial = { ...g, bulbs: g.solution.filter((b) => b !== bulbIndex) };
  const ev = ak.evaluateAkari(partial);
  const err = ev.numberErrors.find((e) => e.index === wallIndex);
  assert.ok(err, "数字の不一致が検出されること");
  assert.equal(err.actual, err.expected - 1);
  assert.equal(ev.solved, false);
});

test("あかり: 壁マスや盤外には電球を置けない／付け外しで手数が増える", () => {
  const g = ak.createAkariGame(3);
  const wall = g.walls[0];
  assert.equal(ak.toggleBulb(g, wall), g);
  assert.equal(ak.toggleBulb(g, -1), g);
  assert.equal(ak.toggleBulb(g, 9999), g);
  const white = g.solution[0];
  const on = ak.toggleBulb(g, white);
  assert.notEqual(on, g);
  assert.deepEqual(on.bulbs, [white]);
  assert.equal(on.moves, 1);
  const off = ak.toggleBulb(on, white);
  assert.deepEqual(off.bulbs, []);
  assert.equal(off.moves, 2);
});

// ---- ダイスロール ----

test("ダイスロール: 転がすと反対同士の和は7のまま保たれる", () => {
  let o = { ...dr.DICE_START_ORIENTATION };
  const seq = ["N", "E", "S", "W", "E", "N", "N", "W", "S", "E", "W", "S"];
  for (const dir of seq) {
    o = dr.rollOrientation(o, dir);
    assert.equal(o.top + o.bottom, 7);
    assert.equal(o.north + o.south, 7);
    assert.equal(o.east + o.west, 7);
    const faces = [o.top, o.bottom, o.north, o.south, o.east, o.west];
    assert.deepEqual([...faces].sort((x, y) => x - y), [1, 2, 3, 4, 5, 6]);
  }
});

test("ダイスロール: 逆向きに戻す／同じ方向4回で元の向きに戻る", () => {
  const start = { ...dr.DICE_START_ORIENTATION };
  assert.deepEqual(dr.rollOrientation(dr.rollOrientation(start, "N"), "S"), start);
  assert.deepEqual(dr.rollOrientation(dr.rollOrientation(start, "E"), "W"), start);
  for (const dir of ["N", "E", "S", "W"]) {
    let o = start;
    for (let i = 0; i < 4; i++) o = dr.rollOrientation(o, dir);
    assert.deepEqual(o, start, `方向 ${dir}`);
  }
  // 北へ転がすと南の面が上になる
  assert.equal(dr.rollOrientation(start, "N").top, start.south);
  assert.equal(dr.rollOrientation(start, "E").top, start.west);
});

test("ダイスロール: 解の経路どおり転がすとゴールで指定の目になり勝利する", () => {
  for (const seed of [1, 13, 42, 555]) {
    let s = dr.createDiceRollGame(seed);
    assert.ok(s.solution.length >= 8, `seed ${seed}`);
    assert.notEqual(s.goal, s.start);
    assert.ok(!s.blocked.includes(s.goal));
    assert.ok(!s.blocked.includes(s.start));
    for (const dir of s.solution) {
      const next = dr.rollDie(s, dir);
      assert.notEqual(next, s, `seed ${seed} 方向 ${dir} は有効な手であること`);
      s = next;
    }
    assert.equal(s.pos, s.goal);
    assert.equal(s.orientation.top, s.targetTop);
    assert.equal(s.status, "won");
    assert.equal(s.moves, s.solution.length);
    // 勝利後の移動は無効
    assert.equal(dr.rollDie(s, "N"), s);
  }
});

test("ダイスロール: 障害物や盤外へは転がらない", () => {
  const g = dr.createDiceRollGame(21);
  // 障害物に隣接する形に state を組み替えて検証する
  const blockedTarget = g.blocked[0];
  const r = Math.floor(blockedTarget / g.cols);
  const c = blockedTarget % g.cols;
  // 障害物の左隣にサイコロを置き、東へ転がそうとする
  if (c > 0) {
    const placed = { ...g, pos: r * g.cols + (c - 1) };
    assert.equal(dr.rollDie(placed, "E"), placed);
  }
  // 左端から西へは転がらない
  const edge = { ...g, pos: r * g.cols };
  assert.equal(dr.rollDie(edge, "W"), edge);
  // 同じシードでは同じ問題
  const again = dr.createDiceRollGame(21);
  assert.deepEqual(again.blocked, g.blocked);
  assert.equal(again.start, g.start);
  assert.equal(again.goal, g.goal);
  assert.equal(again.targetTop, g.targetTop);
});

// ---- ビンゴ対戦 ----

function seats(n) {
  return Array.from({ length: n }, (_, i) => ({ seat: i, name: `P${i}` }));
}

test("ビンゴ対戦: 人数は2〜8人、カードは全員分が妥当で中央フリー", () => {
  const m = bb.gameModule;
  assert.throws(() => m.createState(seats(1), makeRng(1), {}));
  assert.throws(() => m.createState(seats(9), makeRng(1), {}));
  const s = m.createState(seats(4), makeRng(7), {});
  assert.equal(s.phase, "drawing");
  assert.equal(s.drawn.length, 0);
  assert.equal(s.pool.length, bb.BB_MAX_NUMBER);
  for (let seat = 0; seat < 4; seat++) {
    assert.ok(bb.bbIsValidCard(s.cards[seat]), `seat ${seat} のカード`);
    assert.equal(s.cards[seat][12], 0);
  }
  // 自分のビューには自分のカードがそのまま入る
  const view = m.viewFor(s, 2);
  assert.deepEqual(view.you.card, s.cards[2]);
  assert.equal(view.you.markedCount, 1); // 中央フリーのみ
});

test("ビンゴ対戦: tick で抽選が進み、誰かのビンゴで決着する", () => {
  const m = bb.gameModule;
  let s = m.createState(seats(3), makeRng(11), {});
  // 締切前の tick は同一参照
  assert.equal(m.tick(s, (s.nextDrawAt ?? 0) - 1), s);
  let guard = 0;
  while (!m.isFinished(s) && guard < 200) {
    const before = s.drawn.length;
    s = m.tick(s, Date.now() + bb.BB_DRAW_INTERVAL_MS * 200);
    assert.ok(s.drawn.length > before || m.isFinished(s));
    guard++;
  }
  assert.ok(m.isFinished(s), "75球以内に決着すること");
  assert.equal(s.phase, "finished");
  assert.ok(Array.isArray(s.winners) && s.winners.length >= 1);
  assert.equal(s.bingoAtDraw, s.drawn.length);
  assert.ok(s.drawn.length <= bb.BB_MAX_NUMBER);
  // 抽選済みの数字に重複は無い
  assert.equal(new Set(s.drawn).size, s.drawn.length);
  // 優勝者のカードは最終抽選列でビンゴしている
  for (const w of s.winners) {
    assert.ok(bb.bbCardStatus(s.cards[w], s.drawn).bingo, `seat ${w}`);
  }
  // 優勝が決まった球の直前では、優勝者の誰もビンゴしていなかった
  const prevDrawn = s.drawn.slice(0, s.bingoAtDraw - 1);
  for (const w of s.winners) {
    assert.equal(bb.bbCardStatus(s.cards[w], prevDrawn).bingo, false, `seat ${w}`);
  }
  // 終了後の tick は同一参照
  assert.equal(m.tick(s, Date.now() + 1e9), s);
  // 順位表: 優勝者は1位
  assert.ok(s.standings);
  for (const w of s.winners) {
    assert.equal(s.standings.find((e) => e.seat === w).rank, 1);
  }
});

test("ビンゴ対戦: 他人のカードはビューに含まれない（秘匿）", () => {
  const m = bb.gameModule;
  let s = m.createState(seats(3), makeRng(23), {});
  s = m.tick(s, Date.now() + bb.BB_DRAW_INTERVAL_MS * 10);
  const view = m.viewFor(s, 0);
  // players の各エントリに card は無い
  for (const p of view.players) {
    assert.ok(!("card" in p), "進捗エントリにカードを含めないこと");
    assert.ok(!("cards" in p));
  }
  // 他人のカードの数字列が JSON 文字列として漏れていないこと
  const json = JSON.stringify(view);
  for (const other of [1, 2]) {
    const seq = JSON.stringify(s.cards[other]);
    assert.ok(!json.includes(seq), `seat ${other} のカード全体が漏れていないこと`);
  }
  // 進捗（開いた数）は公開情報として見える
  const other = view.players.find((p) => p.seat === 1);
  assert.equal(other.markedCount, bb.bbCardStatus(s.cards[1], s.drawn).markedCount);
  assert.equal(typeof other.reach, "boolean");
});

test("ビンゴ対戦: 退出は脱落扱いで、残り1人になると即終了する", () => {
  const m = bb.gameModule;
  let s = m.createState(seats(3), makeRng(31), {});
  s = m.tick(s, Date.now() + bb.BB_DRAW_INTERVAL_MS * 5);
  const drawnAtLeave = [...s.drawn];
  s = m.onPlayerLeft(s, 2);
  assert.ok(s.leftSeats.includes(2));
  // 退出時点の抽選列で数えたマス数で固定される
  assert.equal(s.frozenMarked[2], bb.bbCardStatus(s.cards[2], drawnAtLeave).markedCount);
  assert.equal(s.phase, "drawing"); // まだ2人残っている
  // さらにもう1人抜けると残り1人が勝者で終了
  s = m.onPlayerLeft(s, 1);
  assert.equal(s.phase, "finished");
  assert.deepEqual(s.winners, [0]);
  const standing0 = s.standings.find((e) => e.seat === 0);
  assert.equal(standing0.rank, 1);
  // 退出者は優勝者より下の順位
  assert.ok(s.standings.find((e) => e.seat === 2).rank > 1);
  assert.ok(s.standings.find((e) => e.seat === 1).rank > 1);
});

test("ビンゴ対戦: アクションは存在せず parseAction は常に null", () => {
  const m = bb.gameModule;
  assert.equal(m.parseAction({ type: "mark", index: 3 }), null);
  assert.equal(m.parseAction(null), null);
  assert.equal(m.parseAction("x"), null);
  const s = m.createState(seats(2), makeRng(3), {});
  assert.throws(() => m.applyAction(s, 0, { type: "none" }, makeRng(3)));
  assert.equal(m.phaseOf(s), "drawing");
  assert.equal(m.isFinished(s), false);
});
