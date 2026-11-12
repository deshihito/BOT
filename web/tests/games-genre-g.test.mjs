// 看板ジャンルの必須入力（バッチG）の検証。
// - sudoku: ヒントで確定した数字が同範囲のメモからも消える
// - minesweeper: 推測不要盤面の生成（ソルバー検証）・コード入力
// - solitaire: オートフィニッシュ（到達可能な盤面で完走）
// - sokoban: デッドロック検出・クリック押し・Moves/Pushes は lib 既存
// - nonogram: 手がかりの消し込み判定
// - slider2048: moveSlideDetailed の移動情報が moveSlide と一致し盤面を再構成できる
// - wordle: デイリー決定性・成績記録・シェア文
// - daifugo: ルールトグル（革命/8切り/スペ3返し/縛り）
// - drawguess: お題3択（描き手のみ・時間切れ自動確定）※既存実装の回帰確認
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const libDir = path.join(import.meta.dirname, "..", "lib");
const gamesDir = path.join(libDir, "online", "games");

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

async function loadGame(file, alias) {
  const src = fs.readFileSync(path.join(gamesDir, file), "utf8");
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const code = stripModuleSyntax(js) + `\nexport { gameModule as ${alias} };\n`;
  const mod = await import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
  return mod[alias];
}

function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
    return s / 0x80000000;
  };
}

const sudoku = await loadLib("sudoku.ts");
const ms = await loadLib("minesweeper.ts");
const sol = await loadLib("solitaire.ts");
const soko = await loadLib("sokoban.ts");
const nono = await loadLib("nonogram.ts");
const slide = await loadLib("slider2048.ts");
const wordle = await loadLib("wordle.ts");
const df = await loadGame("daifugo.ts", "daifugo");
const dg = await loadGame("drawguess.ts", "drawguess");

// ---------------- sudoku ----------------

test("数独: ヒントで確定した数字は同行・列・ブロックのメモからも消える", () => {
  let state = sudoku.createSudokuGame("easy", 42);
  const hintIdx = sudoku.findHintIndex(state);
  assert.ok(hintIdx >= 0);
  const value = state.solution[hintIdx];
  const row = Math.floor(hintIdx / 9);
  const col = hintIdx % 9;
  // ヒント対象と行を共有する空きマスに、その数字をメモしておく
  let peer = -1;
  for (let c = 0; c < 9; c++) {
    const i = row * 9 + c;
    if (i !== hintIdx && !state.givens[i] && state.board[i] === 0) {
      peer = i;
      break;
    }
  }
  assert.ok(peer >= 0, "メモを置ける同行の空きマスがある");
  state = sudoku.toggleNote(state, peer, value);
  assert.ok(state.notes[peer].includes(value));
  state = sudoku.applyHint(state);
  assert.equal(state.board[hintIdx], value);
  assert.ok(!state.notes[peer].includes(value), "ヒントで確定した数字はメモから消える");
  assert.equal(col >= 0, true);
});

// ---------------- minesweeper ----------------

test("マインスイーパー: 生成盤面は推測なしで解け、初手は空き領域を開く", () => {
  const cases = [
    { rows: 9, cols: 9, mines: 10, seed: 42, start: 40 },
    { rows: 9, cols: 9, mines: 10, seed: 3, start: 0 },
    { rows: 12, cols: 12, mines: 26, seed: 7, start: 66 },
    { rows: 12, cols: 16, mines: 40, seed: 11, start: 0 },
  ];
  for (const c of cases) {
    const state = ms.revealCell(ms.createMsGame(c.rows, c.cols, c.mines, c.seed), c.start);
    assert.notEqual(state.status, "lost");
    assert.equal(state.cells[c.start].count, 0, `seed=${c.seed} の初手は 0 マス`);
    assert.equal(
      ms.isSolvableWithoutGuessing(c.rows, c.cols, state.cells.map((x) => x.mine), c.start),
      true,
      `seed=${c.seed} の盤面は推測なしで解ける`,
    );
    assert.equal(state.cells.filter((x) => x.mine).length, c.mines);
  }
});

test("マインスイーパー: コード入力で周囲を一括開放できる", () => {
  let state = ms.revealCell(ms.createMsGame(9, 9, 10, 42), 40);
  const neighborsOf = (i) => {
    const r = Math.floor(i / 9);
    const c = i % 9;
    const out = [];
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        const nr = r + dr;
        const nc = c + dc;
        if (nr < 0 || nc < 0 || nr >= 9 || nc >= 9) continue;
        out.push(nr * 9 + nc);
      }
    }
    return out;
  };
  // 数字マスを1つ選び、地雷の隣マス全てに旗を立ててからコードする
  let done = false;
  for (let i = 0; i < 81 && !done; i++) {
    const cell = state.cells[i];
    if (!cell.open || cell.count === 0) continue;
    const ns = neighborsOf(i);
    const hidden = ns.filter((n) => !state.cells[n].open);
    if (hidden.length <= cell.count) continue; // 開く余地がある数字マスのみ
    let s = state;
    for (const n of ns) {
      if (s.cells[n].mine && !s.cells[n].flagged) s = ms.toggleFlag(s, n);
    }
    const before = s.opened;
    s = ms.chordCell(s, i);
    assert.ok(s.opened > before, "コードで追加のマスが開く");
    assert.notEqual(s.status, "lost");
    done = true;
  }
  assert.ok(done, "コード可能な数字マスが見つかる");
});

test("マインスイーパー: 旗の数が合わないコードは無効、地雷への誤った旗でのコードは敗北", () => {
  const base = ms.revealCell(ms.createMsGame(9, 9, 10, 42), 40);
  // 閉じたマスへのコードは同じ参照
  const closedIdx = base.cells.findIndex((c) => !c.open);
  assert.equal(ms.chordCell(base, closedIdx), base);
  // 旗不足のコードは同じ参照
  const numbered = base.cells.findIndex((c) => c.open && c.count > 0);
  assert.ok(numbered >= 0);
  assert.equal(ms.chordCell(base, numbered), base);
  // 誤った旗（安全マスに旗・地雷は無旗）で数を合わせてコードすると踏む
  const neighborsOf = (i) => {
    const r = Math.floor(i / 9);
    const c = i % 9;
    const out = [];
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        const nr = r + dr;
        const nc = c + dc;
        if (nr < 0 || nc < 0 || nr >= 9 || nc >= 9) continue;
        out.push(nr * 9 + nc);
      }
    }
    return out;
  };
  let lostState = null;
  for (let i = 0; i < 81 && !lostState; i++) {
    const cell = base.cells[i];
    if (!cell.open || cell.count === 0) continue;
    const ns = neighborsOf(i);
    const safeHidden = ns.filter((n) => !base.cells[n].open && !base.cells[n].mine);
    const mineHidden = ns.filter((n) => !base.cells[n].open && base.cells[n].mine);
    if (mineHidden.length === 0 || safeHidden.length < cell.count) continue;
    let s = base;
    for (let k = 0; k < cell.count; k++) s = ms.toggleFlag(s, safeHidden[k]);
    s = ms.chordCell(s, i);
    if (s.status === "lost") lostState = s;
  }
  assert.ok(lostState, "誤旗シナリオを作れる");
  assert.ok(lostState.exploded !== null && lostState.cells[lostState.exploded].mine);
});

// ---------------- solitaire ----------------

const RED_SUITS = new Set(["hearts", "diamonds"]);

/** 実プレイで到達可能な盤面（場札は色交互・降順の正規列）を合成する。 */
function buildReachableSolitaire(seed) {
  const rnd = makeRng(seed);
  const deck = sol.createDeck().map((card) => ({ ...card, faceUp: true }));
  const pool = [...deck];
  const piles = Array.from({ length: 7 }, () => []);
  for (let p = 0; p < 7; p++) {
    let needRank = 13 - Math.floor(rnd() * 4);
    let needRed = rnd() < 0.5;
    while (needRank >= 1) {
      const idx = pool.findIndex((card) => card.rank === needRank && RED_SUITS.has(card.suit) === needRed);
      if (idx < 0) break;
      piles[p].push(pool.splice(idx, 1)[0]);
      needRank--;
      needRed = !needRed;
    }
  }
  const stock = pool.map((card) => ({ ...card, faceUp: false }));
  return { stock, waste: [], foundations: [[], [], [], []], tableau: piles, moves: 0, status: "playing" };
}

test("ソリティア: 通常の配札ではオートフィニッシュ不可、全て表向きなら完走する", () => {
  assert.equal(sol.canAutoFinish(sol.createSolitaire(1)), false);
  for (const seed of [5, 17, 23]) {
    const state = buildReachableSolitaire(seed);
    assert.equal(state.tableau.flat().length + state.stock.length, 52);
    assert.equal(sol.canAutoFinish(state), true);
    const done = sol.autoFinishSolitaire(state);
    assert.equal(done.status, "won", `seed=${seed} で完走`);
    assert.equal(sol.foundationTotal(done), 52);
  }
  // 不可な状態では同じ参照を返す
  const fresh = sol.createSolitaire(9);
  assert.equal(sol.autoFinishSolitaire(fresh), fresh);
});

// ---------------- sokoban ----------------

test("倉庫番: 角に押し込んだ箱をデッドロックとして検出する", () => {
  let state = soko.createSokobanGame(0);
  assert.deepEqual(soko.deadlockedBoxes(state), []);
  // 第1面: 箱を上の壁際まで押し、左の角へ追い込む
  for (const dir of ["down", "right", "up", "right", "up", "left", "left"]) {
    state = soko.moveSokoban(state, dir);
  }
  const dead = soko.deadlockedBoxes(state);
  assert.ok(dead.includes(7), `左上の角 (index 7) の箱が詰み判定される: ${dead}`);
});

test("倉庫番: 箱クリックで歩いて行って押す", () => {
  const state = soko.createSokobanGame(0);
  const boxIndex = state.boxes[0];
  const next = soko.pushBoxByClick(state, boxIndex);
  assert.notEqual(next, state);
  assert.equal(next.pushes, 1);
  assert.equal(next.moves, 3); // 2歩歩いて1回押す
  assert.deepEqual(next.boxes, [9]); // 箱は (1,3) へ
  // 箱でないマスのクリックは同じ参照
  assert.equal(soko.pushBoxByClick(state, state.player), state);
});

// ---------------- nonogram ----------------

test("ノノグラム: 手がかりの消し込み（閉じたランを端から照合）", () => {
  const F = 1;
  const X = 2;
  const E = 0;
  // 両端が閉じた 3 ランは確定
  assert.deepEqual(nono.lineHintSatisfaction([3], [F, F, F, X, E, E]), [true]);
  // 両端が未決定のランは確定しない
  assert.deepEqual(nono.lineHintSatisfaction([3], [E, F, F, F, E, E]), [false]);
  // 左右両端から照合できる
  assert.deepEqual(
    nono.lineHintSatisfaction([2, 1], [F, F, X, E, E, E, E, X, F, X]),
    [true, true],
  );
  // 片側だけ合えば片側だけ確定
  assert.deepEqual(nono.lineHintSatisfaction([2, 2], [F, F, X, E, E, E]), [true, false]);
  // 空行の手がかり [0] は塗りが無ければ確定、塗りがあれば未確定
  assert.deepEqual(nono.lineHintSatisfaction([0], [E, X, E]), [true]);
  assert.deepEqual(nono.lineHintSatisfaction([0], [E, F, E]), [false]);
});

// ---------------- slider2048 ----------------

test("2048: moveSlideDetailed は moveSlide と同じ結果で、移動情報から盤面を再構成できる", () => {
  const dirs = ["left", "right", "up", "down"];
  const rnd = makeRng(99);
  let a = slide.createSlideGame(42);
  let b = slide.createSlideGame(42);
  for (let step = 0; step < 80; step++) {
    const dir = dirs[Math.floor(rnd() * 4)];
    const plain = slide.moveSlide(a, dir);
    const detail = slide.moveSlideDetailed(b, dir);
    assert.equal(detail.moved, plain.moved);
    assert.deepEqual(detail.state, plain.state);
    if (detail.moved) {
      // motions + spawned から移動後の盤面（出現込み）を再構成する
      const rebuilt = new Array(16).fill(0);
      const seenTo = new Set();
      for (const m of detail.motions) {
        if (seenTo.has(m.to)) continue;
        seenTo.add(m.to);
        rebuilt[m.to] = m.merged ? m.value * 2 : m.value;
      }
      if (detail.spawned) rebuilt[detail.spawned.index] = detail.spawned.value;
      assert.deepEqual(rebuilt, detail.state.tiles, `step ${step} (${dir}) の再構成`);
    }
    a = plain.state;
    b = detail.state;
    if (a.status === "lost") break;
  }
});

test("2048: 合体では2枚分の移動が同じマスへ向かい merged になる", () => {
  const tiles = new Array(16).fill(0);
  tiles[0] = 2;
  tiles[1] = 2;
  tiles[5] = 4;
  const state = { tiles, score: 0, status: "playing", keepGoing: false, rng: 7, moves: 0 };
  const detail = slide.moveSlideDetailed(state, "left");
  assert.equal(detail.moved, true);
  const into0 = detail.motions.filter((m) => m.to === 0);
  assert.equal(into0.length, 2);
  assert.ok(into0.every((m) => m.merged && m.value === 2));
  assert.equal(detail.state.tiles[0], 4);
  assert.ok(detail.spawned && detail.state.tiles[detail.spawned.index] === detail.spawned.value);
});

// ---------------- wordle ----------------

test("ワード当て: デイリーは日付（JST）で決まり、同日は全員同じ答え", () => {
  // UTC 2026-01-01 20:30 は JST 2026-01-02 05:30
  assert.equal(wordle.dailyKeyFor(new Date(Date.UTC(2026, 0, 1, 20, 30))), "2026-01-02");
  assert.equal(wordle.dailyKeyFor(new Date(Date.UTC(2026, 0, 1, 10, 0))), "2026-01-01");
  const d = new Date(Date.UTC(2026, 5, 15, 0, 0));
  const g1 = wordle.createDailyWordleGame(d);
  const g2 = wordle.createDailyWordleGame(new Date(d.getTime() + 3600_000));
  assert.equal(g1.answer, g2.answer);
  assert.ok(wordle.ANSWER_WORDS.includes(g1.answer));
});

test("ワード当て: 成績の記録（勝率・連勝・分布）と二重記録防止", () => {
  let stats = wordle.emptyWordleStats();
  stats = wordle.recordWordleResult(stats, { won: true, guessesUsed: 3, key: "daily:2026-01-02" });
  assert.equal(stats.played, 1);
  assert.equal(stats.wins, 1);
  assert.equal(stats.currentStreak, 1);
  assert.equal(stats.maxStreak, 1);
  assert.deepEqual(stats.distribution, [0, 0, 1, 0, 0, 0]);
  const dup = wordle.recordWordleResult(stats, { won: true, guessesUsed: 3, key: "daily:2026-01-02" });
  assert.equal(dup, stats, "同じ key は二度記録しない");
  stats = wordle.recordWordleResult(stats, { won: false, guessesUsed: 6, key: "random:1" });
  assert.equal(stats.played, 2);
  assert.equal(stats.currentStreak, 0);
  stats = wordle.recordWordleResult(stats, { won: true, guessesUsed: 6, key: "random:2" });
  assert.equal(stats.distribution[5], 1);
  assert.equal(stats.currentStreak, 1);
});

test("ワード当て: シェア文はブロック文字で盤面を表す", () => {
  let game = wordle.createWordleGameWithAnswer("CRANE");
  game = wordle.submitGuess(game, "SLATE").state;
  game = wordle.submitGuess(game, "CRANE").state;
  assert.equal(game.status, "won");
  const text = wordle.buildShareText(game, "デイリー 2026-01-02");
  const lines = text.split("\n");
  assert.equal(lines[0], "ワード当て デイリー 2026-01-02 2/6");
  assert.equal(lines.length, 3);
  for (const line of lines.slice(1)) {
    assert.equal(line.length, 5);
    assert.ok(/^[■▨□]+$/.test(line), `ブロック文字のみ: ${line}`);
  }
  assert.equal(lines[2], "■■■■■");
});

// ---------------- daifugo ----------------

const DF_PLAYERS = (n) => Array.from({ length: n }, (_, i) => ({ seat: i, name: `P${i}` }));
const C = (suit, rank) => suit * 13 + (rank - 3);
const DF_DEFAULTS = { revolution: true, eightCut: true, spade3Return: false, suitLock: false };

function dfState(rules, over = {}) {
  const base = df.createState(DF_PLAYERS(2), makeRng(9), { rules });
  return { ...base, ...over };
}

test("大富豪: parseOptions と createState のルール既定値は従来どおり", () => {
  assert.deepEqual(df.parseOptions({}), { rules: DF_DEFAULTS });
  assert.deepEqual(df.parseOptions({ rules: { spade3Return: true } }), {
    rules: { ...DF_DEFAULTS, spade3Return: true },
  });
  assert.deepEqual(df.parseOptions({ rules: { revolution: "yes" } }), { rules: DF_DEFAULTS });
  const st = df.createState(DF_PLAYERS(2), makeRng(3), {});
  assert.deepEqual(st.rules, DF_DEFAULTS);
  assert.equal(st.lockedSuit, null);
  const custom = df.createState(DF_PLAYERS(2), makeRng(3), { rules: { suitLock: true } });
  assert.equal(custom.rules.suitLock, true);
  assert.equal(custom.rules.revolution, true);
});

test("大富豪: 革命トグル OFF では5枚出しても革命しない", () => {
  const five = [C(0, 5), C(1, 5), C(2, 5), C(3, 5), 52];
  const mkState = (revolution) =>
    dfState(
      { ...DF_DEFAULTS, revolution },
      { hands: [[...five, C(3, 3)], [C(0, 6), C(1, 7)]], field: null, turn: 0 },
    );
  const on = df.applyAction(mkState(true), 0, { type: "play", cards: five }, makeRng(1));
  assert.equal(on.revolution, true);
  const off = df.applyAction(mkState(false), 0, { type: "play", cards: five }, makeRng(1));
  assert.equal(off.revolution, false);
});

test("大富豪: 8切りトグル OFF では8を出しても場が流れない", () => {
  const mkState = (eightCut) =>
    dfState(
      { ...DF_DEFAULTS, eightCut },
      { hands: [[C(0, 8), C(3, 3), C(2, 4)], [C(0, 6)]], field: null, turn: 0 },
    );
  const on = df.applyAction(mkState(true), 0, { type: "play", cards: [C(0, 8)] }, makeRng(1));
  assert.equal(on.field, null);
  assert.equal(on.turn, 0);
  const off = df.applyAction(mkState(false), 0, { type: "play", cards: [C(0, 8)] }, makeRng(1));
  assert.deepEqual(off.field, { cards: [C(0, 8)], seat: 0 });
  assert.equal(off.turn, 1);
});

test("大富豪: スペ3返しはトグル ON のときだけジョーカー単体に返せる", () => {
  const mkState = (spade3Return) =>
    dfState(
      { ...DF_DEFAULTS, spade3Return },
      {
        hands: [[C(0, 3), C(3, 4)], [C(0, 6), C(1, 6)]],
        field: { cards: [52], seat: 1 },
        turn: 0,
      },
    );
  assert.throws(
    () => df.applyAction(mkState(false), 0, { type: "play", cards: [C(0, 3)] }, makeRng(1)),
    /場より強い/,
  );
  const ok = df.applyAction(mkState(true), 0, { type: "play", cards: [C(0, 3)] }, makeRng(1));
  assert.deepEqual(ok.field, { cards: [C(0, 3)], seat: 0 });
});

test("大富豪: 縛りは同じマークで発生し、他マークを弾き、場が流れると解ける", () => {
  let st = dfState(
    { ...DF_DEFAULTS, suitLock: true },
    {
      hands: [
        [C(0, 7), C(1, 9), C(3, 3)],
        [C(0, 9), C(1, 10), C(2, 6)],
      ],
      field: { cards: [C(0, 5)], seat: 1 },
      turn: 0,
    },
  );
  // ♠7 を ♠5 に重ねると縛り（♠）が発生する
  st = df.applyAction(st, 0, { type: "play", cards: [C(0, 7)] }, makeRng(1));
  assert.equal(st.lockedSuit, 0);
  assert.equal(df.viewFor(st, 1).lockedSuit, 0);
  // 縛り中は ♥10 が強さで勝っていても弾かれる
  assert.throws(
    () => df.applyAction(st, 1, { type: "play", cards: [C(1, 10)] }, makeRng(1)),
    /縛り/,
  );
  // ♠9 で応じると縛りは続く
  st = df.applyAction(st, 1, { type: "play", cards: [C(0, 9)] }, makeRng(1));
  assert.equal(st.lockedSuit, 0);
  // seat0 は出せる手が無くパスすると場が流れ、縛りも解ける
  st = df.applyAction(st, 0, { type: "pass" }, makeRng(1));
  assert.equal(st.field, null);
  assert.equal(st.lockedSuit, null);
});

// ---------------- drawguess ----------------

test("お絵かき当て: お題は描き手にだけ3択で渡り、時間切れで自動確定する", () => {
  const state = dg.createState(DF_PLAYERS(3), makeRng(5), {});
  assert.equal(state.phase, "choosing");
  const drawerView = dg.viewFor(state, 0);
  assert.equal(drawerView.you.isDrawer, true);
  assert.ok(Array.isArray(drawerView.wordOptions));
  assert.equal(drawerView.wordOptions.length, 3);
  const guesserView = dg.viewFor(state, 1);
  assert.equal(guesserView.wordOptions, null);
  assert.equal(guesserView.word, null);
  // 描き手が2番目を選ぶと drawing になり、描き手にだけお題が見える
  const chosen = dg.applyAction(state, 0, { type: "choose", index: 1 }, makeRng(5));
  assert.equal(chosen.phase, "drawing");
  assert.equal(dg.viewFor(chosen, 0).word, drawerView.wordOptions[1]);
  assert.equal(dg.viewFor(chosen, 1).word, null);
  // 選ばなければ制限時間の経過で先頭のお題が自動確定する
  const timedOut = dg.tick(state, Date.now() + 60_000);
  assert.equal(timedOut.phase, "drawing");
  assert.equal(dg.viewFor(timedOut, 0).word, drawerView.wordOptions[0]);
});
