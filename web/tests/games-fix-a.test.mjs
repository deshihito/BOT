// 「遊べない」修正バッチA（ソロ10本）の再発防止テスト。
// 監査で実証された問題が直っていることを lib レベルで固定する。
// - kanacross: パレット（lib の KANA_PALETTE_ROWS）に全問題の使用文字が含まれ、
//   パレット文字だけで全問題を完成できる
// - blackjack: 残チップ1〜9（最小ベット未満）でも再支給・次ラウンドで復帰できる
// - shikaku: 解に 1×1 長方形を含む局面が、1×1 を置いて完成できる
// - hashi: 交差セルでも全ての候補辺がタップ到達可能（hashiTapEdge の交互選択）
// - airhockey: パドル衝突でパックが場外へ押し出されない
// - numbermemory: 30桁を超える問題でも lib が全桁の回答を受け付ける
// - dragrace: launch の受理条件（5秒超は棄却）が Client の検出前提どおりである
// - halma: 同一局面の反復・手数上限で引き分けになり、CPU 自己対戦が必ず終わる
// - spider: 山札が尽きて手が無いと詰み（stuck）になる
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const libDir = path.join(import.meta.dirname, "..", "lib");

async function loadLib(name) {
  const src = fs.readFileSync(path.join(libDir, name), "utf8");
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));
}

const kana = await loadLib("kanacross.ts");
const bj = await loadLib("blackjack.ts");
const shikaku = await loadLib("shikaku.ts");
const hashi = await loadLib("hashi.ts");
const air = await loadLib("airhockey.ts");
const nm = await loadLib("numbermemory.ts");
const drag = await loadLib("dragrace.ts");
const halma = await loadLib("halma.ts");
const spider = await loadLib("spider.ts");

// ------------------------------------------------------------ kanacross

test("カナクロス: パレットに全問題の使用文字が全て含まれている", () => {
  const palette = new Set(kana.KANA_PALETTE_ROWS.join("").split(""));
  // 濁点・半濁点がパレットにあること（修正の核心）
  for (const ch of ["ガ", "ギ", "グ", "ゲ", "ゴ", "ザ", "ジ", "ズ", "ゼ", "ゾ", "ダ", "ヂ", "ヅ", "デ", "ド", "バ", "ビ", "ブ", "ベ", "ボ", "パ", "ピ", "プ", "ペ", "ポ"]) {
    assert.ok(palette.has(ch), `パレットに ${ch} が無い`);
  }
  for (const puzzle of kana.KANACROSS_PUZZLES) {
    for (const ch of puzzle.solution) {
      if (ch === null) continue;
      assert.ok(palette.has(ch), `${puzzle.id} の ${ch} がパレットに無い`);
    }
  }
});

test("カナクロス: 全問題がパレット文字だけの入力で完成できる", () => {
  const palette = new Set(kana.KANA_PALETTE_ROWS.join("").split(""));
  kana.KANACROSS_PUZZLES.forEach((puzzle, i) => {
    let state = kana.createKanacrossGame(i);
    puzzle.solution.forEach((ch, index) => {
      if (ch === null) return;
      assert.ok(palette.has(ch));
      state = kana.setEntry(state, index, ch);
    });
    assert.equal(state.status, "completed", `${puzzle.id} が完成しない`);
  });
});

// ------------------------------------------------------------ blackjack

test("ブラックジャック: 残チップ5（最小ベット未満）でも再支給で復帰できる", () => {
  const s = bj.createBlackjackGame(1, 5);
  assert.equal(s.chips, 5);
  assert.equal(s.phase, "betting");
  const refilled = bj.refillChips(s);
  assert.equal(refilled.chips, bj.BJ_INITIAL_CHIPS);
});

test("ブラックジャック: 精算後に残チップ5でも次ラウンドで再支給される", () => {
  const settled = { ...bj.createBlackjackGame(1, 5), phase: "settled" };
  const next = bj.nextRound(settled);
  assert.equal(next.chips, bj.BJ_INITIAL_CHIPS);
  assert.equal(next.phase, "betting");
});

test("ブラックジャック: 最小ベット以上あるときは再支給されない", () => {
  for (const chips of [bj.BJ_MIN_BET, 100, 500]) {
    const s = bj.createBlackjackGame(1, chips);
    assert.equal(bj.refillChips(s), s, `チップ ${chips} で再支給されてしまう`);
    assert.equal(bj.nextRound({ ...s, phase: "settled" }).chips, chips);
  }
  // 対局中は残チップが少なくても再支給しない
  const playing = { ...bj.createBlackjackGame(1, 5), phase: "player" };
  assert.equal(bj.refillChips(playing), playing);
});

// ------------------------------------------------------------ shikaku

test("しかく: 解に 1×1 長方形を含む局面が実在し、1×1 を置いて完成できる", () => {
  let found = 0;
  for (const size of [5, 6]) {
    for (let seed = 1; seed <= 120; seed++) {
      const st = shikaku.createShikakuGame(size, seed);
      const has1x1 = st.solution.some((r) => r.r1 === r.r2 && r.c1 === r.c2);
      if (!has1x1) continue;
      found++;
      // 1×1 長方形を単体で置けること
      const one = st.solution.find((r) => r.r1 === r.r2 && r.c1 === r.c2);
      const placed = shikaku.applyShikakuRect(st, one);
      assert.equal(placed.rects.length, 1);
      assert.equal(shikaku.rectArea(placed.rects[0]), 1);
      // 解の長方形を順に置けば（1×1 含む）完成すること
      let s = st;
      for (const rect of st.solution) s = shikaku.applyShikakuRect(s, rect);
      assert.equal(s.status, "won", `size=${size} seed=${seed} が完成しない`);
    }
  }
  assert.ok(found > 0, "1×1 長方形を含む局面が1つも生成されなかった");
});

// ------------------------------------------------------------ hashi

test("橋をかけろ: 全ての候補辺が、その全ての通過セルから到達可能", () => {
  for (const size of [7, 9]) {
    for (let seed = 1; seed <= 60; seed++) {
      const st = hashi.createHashiGame(seed, size);
      for (const edge of hashi.hashiCandidateEdges(st)) {
        for (const cell of edge.cells) {
          const at = hashi.hashiEdgesAtCell(st, cell);
          assert.ok(
            at.some((e) => e.a === edge.a && e.b === edge.b),
            `seed=${seed} cell=${cell} で辺 ${edge.a}-${edge.b} が落ちている`,
          );
        }
      }
    }
  }
});

test("橋をかけろ: 交差セルでは交互選択で両方の辺に到達でき、橋のある辺が優先される", () => {
  let crossing = null;
  for (let seed = 1; seed <= 400 && !crossing; seed++) {
    const st = hashi.createHashiGame(seed, 7);
    for (let cell = 0; cell < 49; cell++) {
      const at = hashi.hashiEdgesAtCell(st, cell);
      if (at.length === 2) {
        crossing = { st, cell, at };
        break;
      }
    }
  }
  assert.ok(crossing, "交差セルを持つ盤面が見つからなかった");
  const { st, cell, at } = crossing;
  const [e1, e2] = at;
  const k1 = hashi.hashiEdgeKey(e1.a, e1.b);
  const k2 = hashi.hashiEdgeKey(e2.a, e2.b);
  const t1 = hashi.hashiTapEdge(st, cell, null);
  const t2 = hashi.hashiTapEdge(st, cell, hashi.hashiEdgeKey(t1.a, t1.b));
  assert.notEqual(hashi.hashiEdgeKey(t2.a, t2.b), hashi.hashiEdgeKey(t1.a, t1.b));
  assert.deepEqual(
    new Set([hashi.hashiEdgeKey(t1.a, t1.b), hashi.hashiEdgeKey(t2.a, t2.b)]),
    new Set([k1, k2]),
    "交互タップで交差セルの両方の辺に到達できない",
  );
  // 橋がかかっている辺は lastTap に関係なく優先される
  const bridged = hashi.cycleHashiBridge(st, t1.a, t1.b);
  assert.notEqual(bridged, st);
  const t3 = hashi.hashiTapEdge(bridged, cell, hashi.hashiEdgeKey(t2.a, t2.b));
  assert.equal(hashi.hashiEdgeKey(t3.a, t3.b), hashi.hashiEdgeKey(t1.a, t1.b));
});

// ------------------------------------------------------------ airhockey

test("エアホッケー: 角に押し付けてもパックが場外へ押し出されない", () => {
  const base = air.createAirHockeyGame(7, "easy");
  const st = {
    ...base,
    serveTimer: 0,
    player: { x: air.AIR_FIELD_W - air.AIR_PADDLE_R, y: air.AIR_FIELD_H - air.AIR_PADDLE_R },
    puck: {
      x: air.AIR_FIELD_W - air.AIR_PADDLE_R + 20,
      y: air.AIR_FIELD_H - air.AIR_PADDLE_R + 20,
      vx: 0,
      vy: 0,
    },
  };
  const next = air.stepAirHockey(st, {
    x: air.AIR_FIELD_W - air.AIR_PADDLE_R,
    y: air.AIR_FIELD_H - air.AIR_PADDLE_R,
  });
  assert.ok(next.puck.x <= air.AIR_FIELD_W - air.AIR_PUCK_R, `puck.x=${next.puck.x} が場外`);
  assert.ok(next.puck.y <= air.AIR_FIELD_H - air.AIR_PUCK_R, `puck.y=${next.puck.y} が場外`);
  assert.ok(next.puck.x >= air.AIR_PUCK_R);
  assert.ok(next.puck.y >= air.AIR_PUCK_R);
});

test("エアホッケー: パック追尾入力でもパックがフィールド近傍から逸脱しない", () => {
  for (const [seed, diff] of [[7, "easy"], [1, "normal"]]) {
    let st = air.createAirHockeyGame(seed, diff);
    for (let i = 0; i < 6000 && st.status === "playing"; i++) {
      st = air.stepAirHockey(st, st.puck);
      assert.ok(
        st.puck.x >= air.AIR_PUCK_R && st.puck.x <= air.AIR_FIELD_W - air.AIR_PUCK_R,
        `seed=${seed} step=${i} puck.x=${st.puck.x}`,
      );
      assert.ok(
        st.puck.y >= -air.AIR_PUCK_R && st.puck.y <= air.AIR_FIELD_H + air.AIR_PUCK_R,
        `seed=${seed} step=${i} puck.y=${st.puck.y}`,
      );
    }
  }
});

// ------------------------------------------------------------ numbermemory

test("数字記憶: 30桁を超える問題でも全桁の正解が受け付けられる", () => {
  const s = nm.createNumberMemoryGame(42, 35);
  assert.equal(s.digits, 35);
  assert.equal(s.number.length, 35);
  const r = nm.submitNumberAnswer(s, s.number);
  assert.equal(r.correct, true);
  assert.equal(r.state.digits, 36);
  assert.equal(r.state.number.length, 36);
});

// ------------------------------------------------------------ dragrace

test("ドラッグレース: launch は5秒以内の反応だけ受理し、超過は状態を変えない", () => {
  const waiting = drag.beginCountdown(drag.createDragRace(1, "normal"));
  assert.equal(waiting.phase, "waiting");
  assert.equal(drag.launch(waiting, 5000).phase, "running");
  assert.equal(drag.launch(waiting, 5001), waiting);
});

test("ドラッグレース: 終了後の beginCountdown は ready でないため開始しない", () => {
  const waiting = drag.beginCountdown(drag.createDragRace(1, "normal"));
  const running = drag.launch(waiting, 300);
  const finished = drag.advanceRace(running, 999999);
  assert.equal(finished.phase, "finished");
  assert.equal(drag.beginCountdown(finished), finished);
});

// ------------------------------------------------------------ halma

test("ハルマ: 同一局面が3回現れると引き分けになる", () => {
  const idx = (q, r) => halma.HALMA_CELLS.findIndex((c) => c.q === q && c.r === r);
  const A = idx(0, 0);
  const B = idx(1, 0);
  const C = idx(3, -3);
  const D = idx(3, -2);
  const board = new Array(halma.HALMA_CELLS.length).fill(0);
  board[A] = 1;
  board[C] = 2;
  let st = halma.halmaCustomState(board, 0);
  const cycle = [
    [A, B],
    [C, D],
    [B, A],
    [D, C],
  ];
  // 7手目までは引き分けにならない
  for (let ply = 0; ply < 7; ply++) {
    const [from, to] = cycle[ply % 4];
    st = halma.halmaApplyMove(st, from, to);
    assert.equal(st.status, "playing", `${ply + 1}手目で終局してしまった`);
  }
  // 8手目で開始局面が3回目になり引き分け
  const [from, to] = cycle[7 % 4];
  st = halma.halmaApplyMove(st, from, to);
  assert.equal(st.status, "draw");
  assert.equal(st.winner, null);
});

test("ハルマ: 手数上限に達すると引き分けになる", () => {
  const idx = (q, r) => halma.HALMA_CELLS.findIndex((c) => c.q === q && c.r === r);
  const board = new Array(halma.HALMA_CELLS.length).fill(0);
  board[idx(0, 0)] = 1;
  board[idx(3, -3)] = 2;
  const st = { ...halma.halmaCustomState(board, 0), moves: halma.HALMA_MAX_MOVES - 1 };
  const after = halma.halmaApplyMove(st, idx(0, 0), idx(1, 0));
  assert.equal(after.moves, halma.HALMA_MAX_MOVES);
  assert.equal(after.status, "draw");
});

test("ハルマ: CPU 自己対戦は勝敗か引き分けで必ず終局する", () => {
  let st = halma.createHalmaGame(3);
  for (let ply = 0; ply < halma.HALMA_MAX_MOVES + 10 && st.status === "playing"; ply++) {
    st = halma.halmaCpuTurn(st);
  }
  assert.ok(st.status === "won" || st.status === "draw", `status=${st.status} で終わらなかった`);
});

// ------------------------------------------------------------ spider

function spiderCard(rank, faceUp = true) {
  return { id: `c-${rank}-${Math.random()}`, rank, faceUp };
}

test("スパイダー: 山札が尽きて手が無ければ詰みになる", () => {
  const st = {
    columns: Array.from({ length: 10 }, () => [spiderCard(13)]),
    stock: [],
    completed: 0,
    moves: 0,
    status: "playing",
    seed: 1,
  };
  assert.equal(spider.hasSpiderMove(st), false);
  assert.equal(spider.isSpiderStuck(st), true);
});

test("スパイダー: 配り切った後に手が無ければ状態が詰みに遷移する", () => {
  const pre = {
    columns: Array.from({ length: 10 }, () => [spiderCard(13)]),
    stock: Array.from({ length: 10 }, () => spiderCard(13, false)),
    completed: 0,
    moves: 0,
    status: "playing",
    seed: 1,
  };
  assert.equal(spider.isSpiderStuck(pre), false); // まだ配れる
  const after = spider.dealSpider(pre);
  assert.equal(after.stock.length, 0);
  assert.equal(after.status, "stuck");
});

test("スパイダー: 手が残っている局面は詰みにならない", () => {
  const columns = Array.from({ length: 10 }, () => [spiderCard(13)]);
  columns[0] = [spiderCard(5)];
  columns[1] = [spiderCard(6)];
  const st = { columns, stock: [], completed: 0, moves: 0, status: "playing", seed: 1 };
  assert.equal(spider.hasSpiderMove(st), true);
  assert.equal(spider.isSpiderStuck(st), false);
  const after = spider.moveSpider(st, 0, 0, 1);
  assert.equal(after.status, "playing");
  // 通常の初期局面も詰みではない
  const fresh = spider.createSpider(11);
  assert.equal(fresh.status, "playing");
  assert.equal(spider.isSpiderStuck(fresh), false);
});
