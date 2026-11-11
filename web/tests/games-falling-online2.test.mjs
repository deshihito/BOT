// 追加ゲーム第2弾の検証。
// - lib/falling.ts: 回転（壁蹴り含む）・ライン消去・固定・ゲームオーバー
// - lib/online/games/tictactoe.ts: 勝敗・引き分け・CPU が負け筋を防ぐこと（全探索で裏付け）
// - lib/online/games/checkers.ts: 強制取り・連続取り・キング昇格
// online モジュールは online-board.test.mjs と同じ transpile＋連結方式で読む。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const webDir = path.join(import.meta.dirname, "..");
const libDir = path.join(webDir, "lib");
const gamesDir = path.join(libDir, "online", "games");

async function loadLib(name) {
  const src = fs.readFileSync(path.join(libDir, name), "utf8");
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));
}

function transpileFile(file) {
  const src = fs.readFileSync(path.join(gamesDir, file), "utf8");
  return ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
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

async function loadOnlineGames() {
  const parts = [
    ["tictactoe.ts", "tictactoeModule"],
    ["checkers.ts", "checkersModule"],
  ].map(([file, name]) =>
    stripModuleSyntax(transpileFile(file)).replace(/\bgameModule\b/g, name),
  );
  const code =
    parts.join("\n") +
    `\nexport { tictactoeModule, checkersModule, checkersLegalMoves };\n`;
  return import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
}

const falling = await loadLib("falling.ts");
const { tictactoeModule: tictactoe, checkersModule: checkers, checkersLegalMoves } =
  await loadOnlineGames();

const players = () => [
  { seat: 0, name: "先手" },
  { seat: 1, name: "後手" },
];
function makeRng(seed = 42) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
const rng = makeRng();

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

/* ---------------- tictactoe ---------------- */

test("tictactoe: メタ情報と parseAction の検証", () => {
  assert.equal(tictactoe.id, "tictactoe");
  assert.equal(tictactoe.minPlayers, 2);
  assert.equal(tictactoe.maxPlayers, 2);
  assert.equal(tictactoe.cpuSupported, true);
  assert.equal(tictactoe.chatEnabled, true);
  assert.equal(tictactoe.parseAction(null), null);
  assert.equal(tictactoe.parseAction({ type: "place", index: 9 }), null);
  assert.equal(tictactoe.parseAction({ type: "place", index: 1.5 }), null);
  assert.deepEqual(tictactoe.parseAction({ type: "place", index: 4 }), { type: "place", index: 4 });
});

function playTictactoe(moves) {
  let s = tictactoe.createState(players(), rng, {});
  moves.forEach((index, i) => {
    s = tictactoe.applyAction(s, i % 2, { type: "place", index }, rng);
  });
  return s;
}

test("tictactoe: 横3つで先手の勝ちになり winCells が入る（元の状態は不変）", () => {
  const s0 = tictactoe.createState(players(), rng, {});
  const end = playTictactoe([0, 3, 1, 4, 2]);
  assert.equal(end.finished, true);
  assert.equal(end.winner, 0);
  assert.deepEqual(end.winCells, [0, 1, 2]);
  assert.equal(tictactoe.isFinished(end), true);
  assert.equal(tictactoe.phaseOf(end), "finished");
  assert.ok(s0.board.every((v) => v === 0));
  assert.throws(() => tictactoe.applyAction(end, 1, { type: "place", index: 8 }, rng), /終了しています/);
});

test("tictactoe: 斜め3つで後手が勝ち、埋まれば引き分けになる", () => {
  const diag = playTictactoe([0, 2, 1, 4, 3, 6]);
  assert.equal(diag.finished, true);
  assert.equal(diag.winner, 1);
  assert.deepEqual(diag.winCells, [2, 4, 6]);
  const draw = playTictactoe([0, 1, 2, 4, 3, 5, 7, 6, 8]);
  assert.equal(draw.finished, true);
  assert.equal(draw.winner, "draw");
  assert.deepEqual(draw.winCells, []);
});

test("tictactoe: 違法な手は throw する（手番違い・占有・範囲外）", () => {
  const s = tictactoe.createState(players(), rng, {});
  assert.throws(() => tictactoe.applyAction(s, 1, { type: "place", index: 0 }, rng), /手番ではありません/);
  const a = tictactoe.applyAction(s, 0, { type: "place", index: 4 }, rng);
  assert.throws(() => tictactoe.applyAction(a, 1, { type: "place", index: 4 }, rng), /既に印があります/);
  assert.throws(() => tictactoe.applyAction(a, 1, { type: "place", index: 9 }, rng), /範囲外/);
});

test("tictactoe: CPU は自分の勝ち手を取り、相手の勝ち筋を必ず防ぐ", () => {
  const base = tictactoe.createState(players(), rng, {});
  // 後手（CPU）が 0,1 と並び、2 で勝てる局面。
  const winBoard = [2, 2, 0, 1, 0, 0, 1, 0, 0];
  const winState = { ...base, board: winBoard, turn: 1 };
  assert.deepEqual(tictactoe.cpuAction(winState, 1, makeRng(1)), { type: "place", index: 2 });
  // 先手が 0,1 と並び、後手（CPU）が 2 を置かなければ負ける局面。
  const threatBoard = [1, 1, 0, 0, 2, 0, 0, 0, 0];
  const threatState = { ...base, board: threatBoard, turn: 1 };
  assert.deepEqual(tictactoe.cpuAction(threatState, 1, makeRng(1)), { type: "place", index: 2 });
  // 隅を取られたら中央を返す（古典的な負け筋回避）。
  const cornerBoard = [1, 0, 0, 0, 0, 0, 0, 0, 0];
  const cornerState = { ...base, board: cornerBoard, turn: 1 };
  assert.deepEqual(tictactoe.cpuAction(cornerState, 1, makeRng(1)), { type: "place", index: 4 });
});

test("tictactoe: CPU は先手でも後手でも全分岐で絶対に負けない", () => {
  const cpuRng = makeRng(99);
  const verify = (state, cpuSeat) => {
    if (state.finished) {
      assert.notEqual(state.winner, 1 - cpuSeat, "CPU が負ける分岐が存在する");
      return;
    }
    if (state.turn === cpuSeat) {
      const act = tictactoe.cpuAction(state, cpuSeat, cpuRng);
      assert.ok(act, "CPU の手があるはず");
      verify(tictactoe.applyAction(state, cpuSeat, act, cpuRng), cpuSeat);
      return;
    }
    for (let i = 0; i < 9; i++) {
      if (state.board[i] !== 0) continue;
      verify(tictactoe.applyAction(state, state.turn, { type: "place", index: i }, cpuRng), cpuSeat);
    }
  };
  verify(tictactoe.createState(players(), rng, {}), 1);
  verify(tictactoe.createState(players(), rng, {}), 0);
});

test("tictactoe: onPlayerLeft は相手の勝ちで終了させる", () => {
  const s = tictactoe.createState(players(), rng, {});
  const left = tictactoe.onPlayerLeft(s, 0);
  assert.equal(left.finished, true);
  assert.equal(left.winner, 1);
  assert.equal(tictactoe.onPlayerLeft(s, 1).winner, 0);
});

/* ---------------- checkers ---------------- */

function checkersState(board, overrides = {}) {
  const base = checkers.createState(players(), rng, {});
  return { ...base, board, ...overrides };
}

function boardWith(entries) {
  const board = new Array(64).fill(0);
  for (const [index, value] of entries) board[index] = value;
  return board;
}

test("checkers: メタ情報と parseAction の検証", () => {
  assert.equal(checkers.id, "checkers");
  assert.equal(checkers.minPlayers, 2);
  assert.equal(checkers.maxPlayers, 2);
  assert.equal(checkers.cpuSupported, true);
  assert.equal(checkers.chatEnabled, true);
  assert.equal(checkers.parseAction(null), null);
  assert.equal(checkers.parseAction({ type: "move", from: 0, to: 64 }), null);
  assert.equal(checkers.parseAction({ type: "place", index: 1 }), null);
  assert.deepEqual(checkers.parseAction({ type: "move", from: 40, to: 33 }), { type: "move", from: 40, to: 33 });
});

test("checkers: 初期配置は両軍12個ずつで、先手の合法手は7つ（取り手なし）", () => {
  const s = checkers.createState(players(), rng, {});
  assert.deepEqual(checkers.viewFor(s, 0).counts, [12, 12]);
  assert.equal(s.turn, 0);
  assert.equal(s.mustCaptureFrom, null);
  const view = checkers.viewFor(s, 0);
  assert.equal(view.yourMoves.length, 7);
  assert.ok(view.yourMoves.every((m) => m.captured === null));
  assert.deepEqual(checkers.viewFor(s, 1).yourMoves, [], "手番でない側には合法手を見せない");
  // 通常コマは前進のみ: 先手（下段）の手はすべて行が減る方向
  assert.ok(view.yourMoves.every((m) => Math.floor(m.to / 8) === Math.floor(m.from / 8) - 1));
});

test("checkers: 取れる手がある局面では取り手のみ合法で、通常移動は throw する（強制取り）", () => {
  // 先手コマ (5,2)=42 は (4,3)=35 の後手コマを (3,4)=28 へ飛んで取れる。
  // もう1つの先手コマ (5,6)=46 には通常移動があるが、強制取りのため使えない。
  const board = boardWith([
    [42, 1],
    [35, 2],
    [46, 1],
    [8, 2],
  ]);
  const s = checkersState(board);
  const view = checkers.viewFor(s, 0);
  assert.equal(view.yourMoves.length, 1);
  assert.deepEqual(view.yourMoves[0], { from: 42, to: 28, captured: 35, promote: false });
  assert.throws(
    () => checkers.applyAction(s, 0, { type: "move", from: 46, to: 37 }, rng),
    /取らなければなりません/,
  );
  const next = checkers.applyAction(s, 0, { type: "move", from: 42, to: 28 }, rng);
  assert.equal(next.board[28], 1);
  assert.equal(next.board[35], 0, "取ったコマは消える");
  assert.equal(next.board[42], 0);
  assert.equal(next.turn, 1, "続けて取れないので手番が交代する");
  assert.equal(next.mustCaptureFrom, null);
  assert.equal(s.board[42], 1, "元の state を破壊しない");
});

test("checkers: 連続取りでは手番が継続し、同じコマの取り手だけが合法になる", () => {
  // 先手コマ (5,0)=40 → (4,1)=33 を取って (3,2)=26 → (2,3)=19 を取って (1,4)=12。
  const board = boardWith([
    [40, 1],
    [33, 2],
    [19, 2],
    [46, 1],
  ]);
  const s = checkersState(board);
  const mid = checkers.applyAction(s, 0, { type: "move", from: 40, to: 26 }, rng);
  assert.equal(mid.turn, 0, "連続取り中は手番が移らない");
  assert.equal(mid.mustCaptureFrom, 26);
  assert.equal(mid.board[33], 0);
  const midView = checkers.viewFor(mid, 0);
  assert.deepEqual(midView.yourMoves, [{ from: 26, to: 12, captured: 19, promote: false }]);
  assert.throws(
    () => checkers.applyAction(mid, 0, { type: "move", from: 46, to: 37 }, rng),
    /同じコマ/,
  );
  const end = checkers.applyAction(mid, 0, { type: "move", from: 26, to: 12 }, rng);
  assert.deepEqual(checkers.viewFor(end, 0).counts, [2, 0]);
  assert.equal(end.finished, true, "相手のコマが無くなれば勝ち");
  assert.equal(end.winner, 0);
});

test("checkers: checkersLegalMoves は連続取り指定でそのコマの取り手だけを返す", () => {
  const board = boardWith([
    [40, 1],
    [33, 2],
    [19, 2],
  ]);
  const first = checkersLegalMoves(board, 0, null);
  assert.deepEqual(first, [{ from: 40, to: 26, captured: 33, promote: false }]);
  const afterBoard = boardWith([
    [26, 1],
    [19, 2],
  ]);
  assert.deepEqual(checkersLegalMoves(afterBoard, 0, 26), [
    { from: 26, to: 12, captured: 19, promote: false },
  ]);
  assert.deepEqual(checkersLegalMoves(afterBoard, 0, 40), [], "存在しないコマ指定では空");
});

test("checkers: 最奥列への到達でキングに昇格し、キングは後方へも動ける", () => {
  // 先手コマ (1,2)=10 が (0,1)=1 へ進んで昇格する。後手コマは (6,1)=49 に置く。
  const board = boardWith([
    [10, 1],
    [49, 2],
  ]);
  const s = checkersState(board);
  const promoted = checkers.applyAction(s, 0, { type: "move", from: 10, to: 1 }, rng);
  assert.equal(promoted.board[1], 3, "seat0 のキングは 3");
  assert.equal(promoted.turn, 1);
  assert.equal(promoted.finished, false);
  const oppMoved = checkers.applyAction(promoted, 1, { type: "move", from: 49, to: 56 }, rng);
  assert.equal(oppMoved.turn, 0);
  // キングは後方（下方向）へも移動できる。通常コマではありえない手。
  const back = checkers.applyAction(oppMoved, 0, { type: "move", from: 1, to: 8 }, rng);
  assert.equal(back.board[8], 3);
  assert.equal(back.board[1], 0);
});

test("checkers: 取り手で最奥列に届いた場合も昇格し、その手番は終わる", () => {
  // 先手コマ (2,1)=17 が (1,2)=10 を取って (0,3)=3 へ。昇格するので連続取りにはならない。
  const board = boardWith([
    [17, 1],
    [10, 2],
    [49, 2],
  ]);
  const s = checkersState(board);
  const next = checkers.applyAction(s, 0, { type: "move", from: 17, to: 3 }, rng);
  assert.equal(next.board[3], 3);
  assert.equal(next.board[10], 0);
  assert.equal(next.turn, 1, "昇格したら手番は終わる");
  assert.equal(next.mustCaptureFrom, null);
});

test("checkers: 違法な手は throw する（手番違い・他人のコマ・届かないマス）", () => {
  const s = checkers.createState(players(), rng, {});
  assert.throws(() => checkers.applyAction(s, 1, { type: "move", from: 8, to: 17 }, rng), /手番ではありません/);
  assert.throws(() => checkers.applyAction(s, 0, { type: "move", from: 8, to: 17 }, rng), /自分のコマ/);
  assert.throws(() => checkers.applyAction(s, 0, { type: "move", from: 40, to: 24 }, rng), /動けません/);
  assert.throws(() => checkers.applyAction(s, 0, { type: "move", from: 40, to: 64 }, rng), /範囲外/);
});

test("checkers: CPU は合法手を返し、取れる場面では取り手を選ぶ", () => {
  const s = checkers.createState(players(), rng, {});
  const first = checkers.cpuAction(s, 0, makeRng(3));
  assert.ok(first && first.type === "move");
  const legal = checkersLegalMoves(s.board, 0, null);
  assert.ok(legal.some((m) => m.from === first.from && m.to === first.to));

  const board = boardWith([
    [42, 1],
    [35, 2],
    [46, 1],
  ]);
  const captureState = checkersState(board);
  assert.deepEqual(checkers.cpuAction(captureState, 0, makeRng(3)), { type: "move", from: 42, to: 28 });
  assert.equal(checkers.cpuAction(captureState, 1, makeRng(3)), null, "手番でない seat には手を返さない");
});

test("checkers: onPlayerLeft は相手の勝ちで終了させる", () => {
  const s = checkers.createState(players(), rng, {});
  const left = checkers.onPlayerLeft(s, 1);
  assert.equal(left.finished, true);
  assert.equal(left.winner, 0);
  assert.equal(checkers.onPlayerLeft(s, 0).winner, 1);
});
