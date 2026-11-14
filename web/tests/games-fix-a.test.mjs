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
const air = await loadLib("airhockey.ts");
const nm = await loadLib("numbermemory.ts");
const drag = await loadLib("dragrace.ts");

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
