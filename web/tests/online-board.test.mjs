// 盤面3ゲーム（lib/online/games/{reversi,connect4,gomoku}.ts）のルール検証。
// balku.test.mjs と同じ loadBundle 方式（TS transpile＋import 除去＋連結）で読む。
// 3モジュールとも `export const gameModule` を持つため、連結時に名前を付け替える。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const gamesDir = path.join(import.meta.dirname, "..", "lib", "online", "games");

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

async function loadBoardGames() {
  const parts = [
    ["reversi.ts", "reversiModule"],
    ["connect4.ts", "connect4Module"],
    ["gomoku.ts", "gomokuModule"],
  ].map(([file, name]) =>
    stripModuleSyntax(transpileFile(file)).replace(/\bgameModule\b/g, name),
  );
  const code =
    parts.join("\n") +
    `\nexport { reversiModule, connect4Module, gomokuModule };\n`;
  return import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
}

const { reversiModule: reversi, connect4Module: connect4, gomokuModule: gomoku } =
  await loadBoardGames();

const players = () => [
  { seat: 0, name: "先手" },
  { seat: 1, name: "後手" },
];
// 決定的 rng（LCG）。
function makeRng(seed = 42) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
const rng = makeRng();

/* ---------------- 共通メタ ---------------- */

test("共通: 3モジュールとも2人固定・CPU対応・チャット有効で id が一致する", () => {
  for (const [mod, id] of [
    [reversi, "reversi"],
    [connect4, "connect4"],
    [gomoku, "gomoku"],
  ]) {
    assert.equal(mod.id, id);
    assert.equal(mod.minPlayers, 2);
    assert.equal(mod.maxPlayers, 2);
    assert.equal(mod.cpuSupported, true);
    assert.equal(mod.chatEnabled, true);
    assert.equal(typeof mod.cpuAction, "function");
    assert.equal(typeof mod.onPlayerLeft, "function");
  }
});

test("共通: parseAction は不正な入力に null を返す", () => {
  for (const mod of [reversi, connect4, gomoku]) {
    assert.equal(mod.parseAction(null), null);
    assert.equal(mod.parseAction("place"), null);
    assert.equal(mod.parseAction({}), null);
    assert.equal(mod.parseAction({ type: "unknown" }), null);
  }
  assert.equal(reversi.parseAction({ type: "place", index: 64 }), null);
  assert.equal(reversi.parseAction({ type: "place", index: 1.5 }), null);
  assert.deepEqual(reversi.parseAction({ type: "place", index: 19 }), { type: "place", index: 19 });
  assert.deepEqual(reversi.parseAction({ type: "pass" }), { type: "pass" });
  assert.equal(connect4.parseAction({ type: "drop", col: 7 }), null);
  assert.deepEqual(connect4.parseAction({ type: "drop", col: 3 }), { type: "drop", col: 3 });
  assert.equal(gomoku.parseAction({ type: "place", index: 225 }), null);
  assert.deepEqual(gomoku.parseAction({ type: "place", index: 112 }), { type: "place", index: 112 });
});

/* ---------------- reversi ---------------- */

test("reversi: 初期配置は中央4石・先手 seat0・合法手は4つ", () => {
  const s = reversi.createState(players(), rng, {});
  assert.equal(s.board.length, 64);
  assert.equal(s.board[27], 2);
  assert.equal(s.board[28], 1);
  assert.equal(s.board[35], 1);
  assert.equal(s.board[36], 2);
  assert.equal(s.board.filter((v) => v !== 0).length, 4);
  assert.equal(s.turn, 0);
  assert.equal(s.finished, false);
  assert.equal(s.winner, null);
  assert.equal(s.lastMove, null);
  assert.equal(s.lastPass, false);
  assert.equal(reversi.phaseOf(s), "playing");
  assert.equal(reversi.isFinished(s), false);
  const view = reversi.viewFor(s, 0);
  assert.deepEqual(view.yourLegalMoves, [19, 26, 37, 44]);
  assert.deepEqual(view.counts, [2, 2]);
  assert.deepEqual(view.players.map((p) => p.name), ["先手", "後手"]);
  // 手番でない側には合法手を見せない
  assert.deepEqual(reversi.viewFor(s, 1).yourLegalMoves, []);
});

test("reversi: 着手で挟んだ石が反転し、手番が交代する（元の状態は不変）", () => {
  const s = reversi.createState(players(), rng, {});
  const before = [...s.board];
  const next = reversi.applyAction(s, 0, { type: "place", index: 19 }, rng);
  assert.deepEqual(s.board, before, "元の state を破壊しない");
  assert.equal(next.board[19], 1);
  assert.equal(next.board[27], 1, "挟んだ白石が反転する");
  assert.equal(next.board[36], 2, "関係ない石はそのまま");
  assert.equal(next.turn, 1);
  assert.equal(next.lastMove, 19);
  assert.equal(next.lastPass, false);
  assert.deepEqual(reversi.viewFor(next, 1).counts, [4, 1]);
});

test("reversi: 違法な手は throw する（手番違い・占有・挟めない・範囲外）", () => {
  const s = reversi.createState(players(), rng, {});
  assert.throws(() => reversi.applyAction(s, 1, { type: "place", index: 19 }, rng), /手番ではありません/);
  assert.throws(() => reversi.applyAction(s, 0, { type: "place", index: 27 }, rng), /既に石があります/);
  assert.throws(() => reversi.applyAction(s, 0, { type: "place", index: 0 }, rng), /置けません/);
  assert.throws(() => reversi.applyAction(s, 0, { type: "place", index: 64 }, rng), /範囲外/);
  assert.throws(() => reversi.applyAction(s, 0, { type: "pass" }, rng), /パスできません/);
});

test("reversi: 合法手が無い側はパスし、相手が着手して終局する", () => {
  // 空きは隅(0)だけ。黒(1)は 1 の自石に阻まれて置けず、白(2)だけが 1 を挟める。
  const board = new Array(64).fill(2);
  board[0] = 0;
  board[1] = 1;
  const s = {
    players: players(),
    board,
    turn: 0,
    lastMove: null,
    lastPass: false,
    finished: false,
    winner: null,
  };
  assert.deepEqual(reversi.viewFor(s, 0).yourLegalMoves, []);
  assert.deepEqual(reversi.cpuAction(s, 0, rng), { type: "pass" });
  const passed = reversi.applyAction(s, 0, { type: "pass" }, rng);
  assert.equal(passed.turn, 1);
  assert.equal(passed.lastPass, true);
  assert.equal(passed.finished, false);
  const end = reversi.applyAction(passed, 1, { type: "place", index: 0 }, rng);
  assert.equal(end.finished, true);
  assert.equal(end.winner, 1);
  assert.deepEqual(reversi.viewFor(end, 0).counts, [0, 64]);
  assert.equal(reversi.phaseOf(end), "finished");
  assert.throws(() => reversi.applyAction(end, 1, { type: "pass" }, rng), /終了しています/);
});

test("reversi: 両者とも合法手が無い局面でパスすると石数で終局する", () => {
  // 空き(0)の周囲はすべて白。黒は石が無く、白も自石ばかりで挟めない。
  const board = new Array(64).fill(2);
  board[0] = 0;
  const s = {
    players: players(),
    board,
    turn: 0,
    lastMove: null,
    lastPass: false,
    finished: false,
    winner: null,
  };
  const end = reversi.applyAction(s, 0, { type: "pass" }, rng);
  assert.equal(end.finished, true);
  assert.equal(end.winner, 1);
});

test("reversi: 最終手で盤面が埋まると同数は引き分けになる", () => {
  // 空き(0)、白1つ(1)を黒(2)が挟む。着手後は黒32・白32。
  const board = new Array(64).fill(0);
  board[0] = 0;
  board[1] = 2;
  board[2] = 1;
  for (let i = 3; i <= 31; i++) board[i] = 1;
  for (let i = 32; i <= 63; i++) board[i] = 2;
  // 黒 = idx2 + 3..31(29) = 30、白 = idx1 + 32..63(32) = 33
  const s = {
    players: players(),
    board,
    turn: 0,
    lastMove: null,
    lastPass: false,
    finished: false,
    winner: null,
  };
  const end = reversi.applyAction(s, 0, { type: "place", index: 0 }, rng);
  assert.equal(end.finished, true);
  assert.equal(end.winner, "draw");
  assert.deepEqual(reversi.viewFor(end, 0).counts, [32, 32]);
});

test("reversi: 相手に合法手が無い着手では手番が戻り lastPass が立つ", () => {
  // 黒が 0 に置くと白の置ける場所が無くなり、黒が続けて打つ局面を作る。
  // 盤面: ほぼ白で埋め、黒の足場と空きを2つ残す。
  const board = new Array(64).fill(2);
  board[0] = 0; // 黒がここに置くと 1(白) を 2(黒) で挟む
  board[1] = 2;
  board[2] = 1;
  board[63] = 0; // もう一つの空き。白には挟めず、黒には後で置ける想定にする
  board[62] = 2;
  board[61] = 1;
  const s = {
    players: players(),
    board,
    turn: 0,
    lastMove: null,
    lastPass: false,
    finished: false,
    winner: null,
  };
  const next = reversi.applyAction(s, 0, { type: "place", index: 0 }, rng);
  // 白は 63 に置けない（62=自石／55,54 も白）ので、黒に手番が戻るはず。
  // ただし盤面の大半が白で、黒が 63 以外に置ける場所も無い前提の確認。
  if (next.finished) {
    // 両者とも置けず終局した場合は石数勝敗（白多数）でも可とする分岐は置かず、
    // この構成では黒が 63 に置けるので終局しないことを表明する。
    assert.fail("黒には 63 が残るので終局しない");
  }
  assert.equal(next.turn, 0, "白がパスして黒の手番に戻る");
  assert.equal(next.lastPass, true);
  assert.equal(next.lastMove, 0);
});

test("reversi: CPU は合法手を返し、隅が取れる局面では隅を選ぶ", () => {
  const s = reversi.createState(players(), rng, {});
  const act = reversi.cpuAction(s, 0, makeRng(7));
  assert.equal(act.type, "place");
  assert.ok([19, 26, 37, 44].includes(act.index));

  const board = new Array(64).fill(0);
  board[1] = 2;
  board[2] = 1; // 黒は 0（隅）に置ける
  board[27] = 2;
  board[28] = 1; // 別の合法手もある
  const cornerState = {
    players: players(),
    board,
    turn: 0,
    lastMove: null,
    lastPass: false,
    finished: false,
    winner: null,
  };
  const cornerAct = reversi.cpuAction(cornerState, 0, makeRng(3));
  assert.deepEqual(cornerAct, { type: "place", index: 0 });
});

test("reversi: onPlayerLeft は相手の勝ちで終了させる", () => {
  const s = reversi.createState(players(), rng, {});
  const left = reversi.onPlayerLeft(s, 0);
  assert.equal(left.finished, true);
  assert.equal(left.winner, 1);
  assert.equal(reversi.onPlayerLeft(s, 1).winner, 0);
});

/* ---------------- connect4 ---------------- */

test("connect4: 石は列の一番下に落ち、手番が交代する（元の状態は不変）", () => {
  const s = connect4.createState(players(), rng, {});
  assert.equal(s.board.length, 42);
  assert.ok(s.board.every((v) => v === 0));
  const a = connect4.applyAction(s, 0, { type: "drop", col: 3 }, rng);
  assert.equal(a.board[38], 1, "最下段 row5,col3 = 38");
  assert.equal(a.lastMove, 38);
  assert.equal(a.turn, 1);
  assert.equal(s.board[38], 0, "元の state を破壊しない");
  const b = connect4.applyAction(a, 1, { type: "drop", col: 3 }, rng);
  assert.equal(b.board[31], 2, "2段目 row4,col3 = 31");
  assert.equal(b.turn, 0);
});

test("connect4: 違法な手は throw する（手番違い・範囲外・満杯列）", () => {
  const s = connect4.createState(players(), rng, {});
  assert.throws(() => connect4.applyAction(s, 1, { type: "drop", col: 0 }, rng), /手番ではありません/);
  assert.throws(() => connect4.applyAction(s, 0, { type: "drop", col: 7 }, rng), /範囲外/);
  assert.throws(() => connect4.applyAction(s, 0, { type: "drop", col: -1 }, rng), /範囲外/);
  const board = new Array(42).fill(0);
  for (let row = 0; row < 6; row++) board[row * 7 + 0] = row % 2 === 0 ? 1 : 2;
  const full = { ...s, board };
  assert.throws(() => connect4.applyAction(full, 0, { type: "drop", col: 0 }, rng), /満杯/);
});

function playConnect4(moves) {
  let s = connect4.createState(players(), rng, {});
  moves.forEach((col, i) => {
    s = connect4.applyAction(s, i % 2, { type: "drop", col }, rng);
  });
  return s;
}

test("connect4: 縦4つで勝ち、winCells に4マスが入る", () => {
  const end = playConnect4([0, 1, 0, 1, 0, 1, 0]);
  assert.equal(end.finished, true);
  assert.equal(end.winner, 0);
  assert.deepEqual(end.winCells, [14, 21, 28, 35]);
  assert.equal(connect4.isFinished(end), true);
  assert.equal(connect4.phaseOf(end), "finished");
  assert.throws(() => connect4.applyAction(end, 1, { type: "drop", col: 2 }, rng), /終了しています/);
});

test("connect4: 横4つで勝ち、winCells に4マスが入る", () => {
  const end = playConnect4([0, 5, 1, 5, 2, 5, 3]);
  assert.equal(end.finished, true);
  assert.equal(end.winner, 0);
  assert.deepEqual(end.winCells, [35, 36, 37, 38]);
});

test("connect4: 斜め4つで勝ち、winCells に4マスが入る", () => {
  const end = playConnect4([0, 1, 1, 2, 3, 2, 2, 3, 4, 3, 3]);
  assert.equal(end.finished, true);
  assert.equal(end.winner, 0);
  assert.deepEqual([...end.winCells].sort((a, b) => a - b), [17, 23, 29, 35]);
});

test("connect4: 埋まった盤面（4つ並び無し）は引き分け", () => {
  // 横は2つずつ、縦は交互、斜めも4つ揃わないパターン。
  const evenRow = [1, 1, 2, 2, 1, 1, 2];
  const oddRow = [2, 2, 1, 1, 2, 2, 1];
  const board = [];
  for (let row = 0; row < 6; row++) board.push(...(row % 2 === 0 ? evenRow : oddRow));
  board[6] = 0; // 最上段右端だけ空き。パターン上このマスは 2（seat1）。
  const s = {
    players: players(),
    board,
    turn: 1,
    lastMove: null,
    winCells: [],
    finished: false,
    winner: null,
  };
  const end = connect4.applyAction(s, 1, { type: "drop", col: 6 }, rng);
  assert.equal(end.finished, true);
  assert.equal(end.winner, "draw");
  assert.deepEqual(end.winCells, []);
});

test("connect4: ビューは盤面と勝敗情報をそのまま返す", () => {
  const s = playConnect4([3, 3]);
  const view = connect4.viewFor(s, 0);
  assert.equal(view.board[38], 1);
  assert.equal(view.board[31], 2);
  assert.equal(view.turn, 0);
  assert.equal(view.lastMove, 31);
  assert.deepEqual(view.winCells, []);
  assert.equal(view.finished, false);
  assert.equal(view.winner, null);
  assert.equal(view.players.length, 2);
});

test("connect4: CPU は勝ち手を選び、相手の勝ちを阻止し、空盤面では中央を選ぶ", () => {
  const empty = connect4.createState(players(), rng, {});
  assert.deepEqual(connect4.cpuAction(empty, 0, makeRng(1)), { type: "drop", col: 3 });

  const base = connect4.createState(players(), rng, {});
  const winBoard = new Array(42).fill(0);
  winBoard[35 + 2] = 1; // col2: rows5,4,3
  winBoard[28 + 2] = 1;
  winBoard[21 + 2] = 1;
  winBoard[35] = 2;
  winBoard[28] = 2;
  const winState = { ...base, board: winBoard, turn: 0 };
  assert.deepEqual(connect4.cpuAction(winState, 0, makeRng(1)), { type: "drop", col: 2 });

  const blockBoard = new Array(42).fill(0);
  blockBoard[35 + 4] = 2; // col4: rows5,4,3 が相手
  blockBoard[28 + 4] = 2;
  blockBoard[21 + 4] = 2;
  blockBoard[35] = 1;
  blockBoard[28] = 1;
  const blockState = { ...base, board: blockBoard, turn: 0 };
  assert.deepEqual(connect4.cpuAction(blockState, 0, makeRng(1)), { type: "drop", col: 4 });
});

test("connect4: onPlayerLeft は相手の勝ちで終了させる", () => {
  const s = connect4.createState(players(), rng, {});
  const left = connect4.onPlayerLeft(s, 1);
  assert.equal(left.finished, true);
  assert.equal(left.winner, 0);
});

/* ---------------- gomoku ---------------- */

function gomokuStateWith(board, turn = 0) {
  return {
    players: players(),
    board,
    turn,
    lastMove: null,
    winCells: [],
    finished: false,
    winner: null,
  };
}

test("gomoku: 初期状態は空の15×15・先手 seat0", () => {
  const s = gomoku.createState(players(), rng, {});
  assert.equal(s.board.length, 225);
  assert.ok(s.board.every((v) => v === 0));
  assert.equal(s.turn, 0);
  const next = gomoku.applyAction(s, 0, { type: "place", index: 112 }, rng);
  assert.equal(next.board[112], 1);
  assert.equal(next.turn, 1);
  assert.equal(s.board[112], 0, "元の state を破壊しない");
  const view = gomoku.viewFor(next, 0);
  assert.equal(view.lastMove, 112);
  assert.equal(view.winner, null);
});

test("gomoku: 違法な手は throw する（手番違い・占有・範囲外）", () => {
  const s = gomoku.createState(players(), rng, {});
  const a = gomoku.applyAction(s, 0, { type: "place", index: 112 }, rng);
  assert.throws(() => gomoku.applyAction(a, 0, { type: "place", index: 0 }, rng), /手番ではありません/);
  assert.throws(() => gomoku.applyAction(a, 1, { type: "place", index: 112 }, rng), /既に石があります/);
  assert.throws(() => gomoku.applyAction(a, 1, { type: "place", index: 225 }, rng), /範囲外/);
});

test("gomoku: 横5つで勝ち、winCells に5マスが入る", () => {
  let s = gomoku.createState(players(), rng, {});
  const moves = [
    [0, 108], [1, 0],
    [0, 109], [1, 1],
    [0, 110], [1, 2],
    [0, 111], [1, 3],
    [0, 112],
  ];
  for (const [seat, index] of moves) s = gomoku.applyAction(s, seat, { type: "place", index }, rng);
  assert.equal(s.finished, true);
  assert.equal(s.winner, 0);
  assert.deepEqual(s.winCells, [108, 109, 110, 111, 112]);
  assert.throws(() => gomoku.applyAction(s, 1, { type: "place", index: 50 }, rng), /終了しています/);
});

test("gomoku: 縦5つで勝つ", () => {
  const board = new Array(225).fill(0);
  for (const i of [52, 67, 82, 97]) board[i] = 1; // col7, rows3-6
  board[0] = 2;
  board[1] = 2;
  const s = gomokuStateWith(board, 0);
  const end = gomoku.applyAction(s, 0, { type: "place", index: 112 }, rng);
  assert.equal(end.finished, true);
  assert.equal(end.winner, 0);
  assert.deepEqual(end.winCells, [52, 67, 82, 97, 112]);
});

test("gomoku: 長連（6つ）も勝ちで、winCells は並んだ全マス", () => {
  let s = gomoku.createState(players(), rng, {});
  const moves = [
    [0, 108], [1, 0],
    [0, 109], [1, 1],
    [0, 110], [1, 2],
    [0, 111], [1, 3],
    [0, 113], [1, 210],
    [0, 112], // 隙間を埋めて 108-113 の6連
  ];
  for (const [seat, index] of moves) s = gomoku.applyAction(s, seat, { type: "place", index }, rng);
  assert.equal(s.finished, true);
  assert.equal(s.winner, 0);
  assert.deepEqual(s.winCells, [108, 109, 110, 111, 112, 113]);
});

test("gomoku: 埋まった盤面（5つ並び無し）は引き分け", () => {
  const board = new Array(225).fill(0);
  for (let r = 0; r < 15; r++) {
    for (let c = 0; c < 15; c++) {
      const even = r % 2 === 0;
      const v = c % 4 < 2 ? (even ? 1 : 2) : (even ? 2 : 1);
      board[r * 15 + c] = v;
    }
  }
  board[0] = 0; // 左上だけ空き。パターン上このマスは 1（seat0）。
  const s = gomokuStateWith(board, 0);
  const end = gomoku.applyAction(s, 0, { type: "place", index: 0 }, rng);
  assert.equal(end.finished, true);
  assert.equal(end.winner, "draw");
});

test("gomoku: CPU は空盤面で中央、勝ち手を完成させ、相手の4を止める", () => {
  const empty = gomoku.createState(players(), rng, {});
  assert.deepEqual(gomoku.cpuAction(empty, 0, makeRng(1)), { type: "place", index: 112 });

  // オープン4（両端が空き）: どちらかの端で勝てる。
  const openBoard = new Array(225).fill(0);
  for (const i of [108, 109, 110, 111]) openBoard[i] = 1;
  openBoard[0] = 2;
  const openState = gomokuStateWith(openBoard, 0);
  const winAct = gomoku.cpuAction(openState, 0, makeRng(1));
  assert.equal(winAct.type, "place");
  assert.ok([107, 112].includes(winAct.index), `勝ち手は両端のどちらか: ${winAct.index}`);

  // 片側が塞がれた4: 勝ち手は 112 のみ。
  const closedBoard = new Array(225).fill(0);
  for (const i of [108, 109, 110, 111]) closedBoard[i] = 1;
  closedBoard[107] = 2;
  const closedState = gomokuStateWith(closedBoard, 0);
  assert.deepEqual(gomoku.cpuAction(closedState, 0, makeRng(1)), { type: "place", index: 112 });

  // 相手の片側4: 阻止手は 112 のみ。
  const threatBoard = new Array(225).fill(0);
  for (const i of [108, 109, 110, 111]) threatBoard[i] = 2;
  threatBoard[107] = 1;
  threatBoard[0] = 1;
  const threatState = gomokuStateWith(threatBoard, 0);
  assert.deepEqual(gomoku.cpuAction(threatState, 0, makeRng(1)), { type: "place", index: 112 });
});

test("gomoku: onPlayerLeft は相手の勝ちで終了させる", () => {
  const s = gomoku.createState(players(), rng, {});
  const left = gomoku.onPlayerLeft(s, 0);
  assert.equal(left.finished, true);
  assert.equal(left.winner, 1);
});
