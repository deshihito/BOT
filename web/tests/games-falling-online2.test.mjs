// 追加ゲーム第2弾の検証。
// - lib/falling.ts: 回転（壁蹴り含む）・ライン消去・固定・ゲームオーバー
// （tictactoe / checkers の検証は、2026-11-15 のカタログ削減で両タイトルを
// 削除したため、このファイルからも外した。）
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

const falling = await loadLib("falling.ts");

/* ---------------- falling ---------------- */

function fallingState(overrides = {}) {
  const base = falling.createFallingGame(42);
  return { ...base, ...overrides };
}

function emptyBoard() {
  return new Array(falling.FALLING_CELLS).fill(null);
}

test("falling: 初期状態は空盤・レベル1・次ピースと落下ピースが有効な種別", () => {
  const s = falling.createFallingGame(7);
  assert.equal(s.board.length, 200);
  assert.ok(s.board.every((c) => c === null));
  assert.ok(falling.FALLING_PIECE_TYPES.includes(s.active.type));
  assert.ok(falling.FALLING_PIECE_TYPES.includes(s.next));
  assert.equal(s.score, 0);
  assert.equal(s.lines, 0);
  assert.equal(s.level, 1);
  assert.equal(s.status, "playing");
  assert.equal(s.hold, null);
  assert.equal(s.canHold, true);
});

test("falling: 回転は4回で元の形に戻り、Oピースは回転しても形が変わらない", () => {
  const key = (cells) => cells.map((c) => `${c.x},${c.y}`).sort().join("|");
  const t0 = falling.getPieceCells("T", 0);
  assert.equal(key(falling.getPieceCells("T", 4)), key(t0));
  assert.notEqual(key(falling.getPieceCells("T", 1)), key(t0));
  assert.equal(key(falling.getPieceCells("O", 1)), key(falling.getPieceCells("O", 0)));
  const s = fallingState({ active: { type: "T", rotation: 0, x: 4, y: 5 } });
  const rotated = falling.rotatePiece(s, 1);
  assert.equal(rotated.active.rotation, 1);
  assert.equal(s.active.rotation, 0, "元の state を破壊しない");
});

test("falling: 右壁際の縦Iピースは壁蹴りで横向きに回転できる", () => {
  // 縦I（rotation 1）はボックス内 x=2 の列。x=7 なら盤の右端（col9）に立つ。
  const s = fallingState({ active: { type: "I", rotation: 1, x: 7, y: 5 } });
  assert.equal(falling.canPlace(s.board, "I", 1, 7, 5), true);
  const rotated = falling.rotatePiece(s, 1);
  assert.equal(rotated.active.rotation, 2, "その場回転は右端をはみ出すので壁蹴りが要る");
  assert.equal(rotated.active.x, 6, "左へ1マス蹴られて収まる");
  assert.equal(falling.canPlace(rotated.board, "I", 2, rotated.active.x, rotated.active.y), true);
});

test("falling: clearLines はそろった行だけを消して上を下ろす", () => {
  const board = emptyBoard();
  for (let c = 0; c < 10; c++) board[19 * 10 + c] = "J";
  board[18 * 10 + 0] = "T";
  const { board: next, cleared } = falling.clearLines(board);
  assert.equal(cleared, 1);
  assert.equal(next.filter((c) => c !== null).length, 1);
  assert.equal(next[19 * 10 + 0], "T", "上のブロックは1段下りる");
  assert.equal(board[19 * 10 + 0], "J", "元の盤を破壊しない");
  const none = falling.clearLines(emptyBoard());
  assert.equal(none.cleared, 0);
});

test("falling: 最下段の穴を埋めて固定するとラインが消えて100点入る", () => {
  const board = emptyBoard();
  for (let c = 0; c < 10; c++) {
    if (c !== 4 && c !== 5) board[19 * 10 + c] = "J";
  }
  const s = fallingState({ board, active: { type: "O", rotation: 0, x: 4, y: 18 } });
  const locked = falling.hardDrop(s);
  assert.equal(locked.lines, 1);
  assert.equal(locked.score, 100, "落下距離0＋1ライン100点×レベル1");
  assert.equal(locked.board.filter((c) => c !== null).length, 2, "Oの上半分だけが1段下りて残る");
  assert.equal(locked.board[19 * 10 + 4], "O");
  assert.equal(locked.board[19 * 10 + 5], "O");
  assert.equal(locked.placed, 1);
  assert.equal(locked.status, "playing");
});

test("falling: ハードドロップでピースが底に固定され、次ピースが出現する", () => {
  const s = falling.createFallingGame(11);
  const type = s.active.type;
  const locked = falling.hardDrop(s);
  assert.equal(locked.placed, 1);
  assert.equal(locked.board.filter((c) => c === type).length, 4);
  // 固定された4マスはすべて盤の下半分にある（底まで落ちた）
  locked.board.forEach((c, i) => {
    if (c === type) assert.ok(Math.floor(i / 10) >= 16, `row=${Math.floor(i / 10)}`);
  });
  assert.ok(locked.score >= 0);
});

test("falling: 床の上のピースは moveDown で固定される", () => {
  const s = fallingState({ active: { type: "O", rotation: 0, x: 4, y: 18 } });
  const locked = falling.moveDown(s);
  assert.equal(locked.placed, 1);
  assert.equal(locked.board[19 * 10 + 4], "O");
});

test("falling: 出現位置が塞がっていると次の出現でゲームオーバーになる", () => {
  const board = emptyBoard();
  // Tピースの出現セル（row0 col4 / row1 col3,4,5）だけを塞ぐ。行はそろえない。
  board[0 * 10 + 4] = "J";
  board[1 * 10 + 3] = "J";
  board[1 * 10 + 4] = "J";
  board[1 * 10 + 5] = "J";
  const s = fallingState({
    board,
    active: { type: "O", rotation: 0, x: 0, y: 18 },
    next: "T",
  });
  const locked = falling.hardDrop(s);
  assert.equal(locked.status, "gameover");
  // ゲームオーバー後の操作は無効
  assert.equal(falling.moveLeft(locked), locked);
  assert.equal(falling.hardDrop(locked), locked);
});

test("falling: ホールドは1落下に1回までで、固定すると再び使える", () => {
  const s = falling.createFallingGame(5);
  const first = s.active.type;
  const held = falling.holdPiece(s);
  assert.equal(held.hold, first);
  assert.equal(held.canHold, false);
  assert.equal(falling.holdPiece(held), held, "連続ホールドはできない");
  const locked = falling.hardDrop(held);
  assert.equal(locked.canHold, true);
  const swapped = falling.holdPiece(locked);
  assert.equal(swapped.active.type, first, "ホールドしていたピースと入れ替わる");
});

test("falling: レベルが上がると落下間隔が短くなり、レベルはライン数から決まる", () => {
  assert.equal(falling.levelForLines(0), 1);
  assert.equal(falling.levelForLines(10), 2);
  assert.equal(falling.levelForLines(25), 3);
  assert.ok(falling.dropIntervalMs(2) < falling.dropIntervalMs(1));
  assert.ok(falling.dropIntervalMs(20) >= 80);
});