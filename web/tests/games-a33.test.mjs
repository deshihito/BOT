// A33 で追加したゲーム3件のロジック検証（lib のみ、UI 非依存）。
// - lib/billiards.ts: 決定性・ポケット・スクラッチ・全消し
// - lib/curling.ts: 得点計算・シミュレーション決定性・ホッグアウト・全試合完走
// - lib/anagram.ts: 増量後のバンク（120語・重複なし・カタカナ・シャッフル保証）
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

const bl = await loadLib("billiards.ts");
const cu = await loadLib("curling.ts");
const an = await loadLib("anagram.ts");

// ---------------------------------------------------------------- ビリヤード

test("ビリヤード: 初期配置は手球＋的球6つで、重なりがなく決定的", () => {
  const a = bl.createBilliardsGame(42);
  const b = bl.createBilliardsGame(42);
  assert.deepEqual(a, b);
  assert.equal(a.balls.length, 7);
  assert.deepEqual(a.balls.map((x) => x.id), [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(bl.remainingBalls(a), 6);
  for (let i = 0; i < a.balls.length; i++) {
    for (let j = i + 1; j < a.balls.length; j++) {
      const d = Math.hypot(a.balls[i].x - a.balls[j].x, a.balls[i].y - a.balls[j].y);
      assert.ok(d >= bl.BL_BALL_RADIUS * 2 - 0.001, `ball ${i} と ${j} が重なっている`);
    }
    assert.ok(a.balls[i].x >= 0 && a.balls[i].x <= bl.BL_WIDTH);
    assert.ok(a.balls[i].y >= 0 && a.balls[i].y <= bl.BL_HEIGHT);
  }
});

test("ビリヤード: シミュレーションは決定的（同じ入力で同じ結果）", () => {
  const s = bl.createBilliardsGame(7);
  const r1 = bl.simulateShot(s.balls, 10, 70);
  const r2 = bl.simulateShot(s.balls, 10, 70);
  assert.deepEqual(r1, r2);
  assert.ok(r1.frames.length > 1, "転がるフレームがある");
  // 元の状態は壊れていない（非破壊）
  assert.deepEqual(s, bl.createBilliardsGame(7));
});

test("ビリヤード: 的球をポケット方向へ当てると落ちる", () => {
  // コーナーポケットの手前に的球を置き、手球を真っ直ぐ当てる配置
  const balls = [
    { id: 0, x: 660, y: 60, pocketed: false },
    { id: 1, x: 740, y: 35, pocketed: false },
    { id: 2, x: 200, y: 400, pocketed: false },
  ];
  const angle = (Math.atan2(35 - 60, 740 - 660) * 180) / Math.PI;
  const r = bl.simulateShot(balls, angle, 60);
  assert.deepEqual(r.pocketedIds, [1]);
  assert.equal(r.scratch, false);
  const last = r.frames[r.frames.length - 1];
  assert.equal(last.find((b) => b.id === 1).pocketed, true);
});

test("ビリヤード: 手球を直接ポケットへ打つとスクラッチになり、置き直される", () => {
  const state = {
    ...bl.createBilliardsGame(1),
    balls: [
      { id: 0, x: 700, y: 60, pocketed: false },
      { id: 1, x: 200, y: 400, pocketed: false },
    ],
  };
  const angle = (Math.atan2(22 - 60, 778 - 700) * 180) / Math.PI;
  const { state: next, result } = bl.shoot(state, angle, 70);
  assert.equal(result.scratch, true);
  assert.equal(next.scratches, 1);
  assert.equal(next.shots, 1);
  assert.equal(bl.billiardsScore(next), 2, "スコアは打数＋スクラッチ");
  const cue = next.balls.find((b) => b.id === 0);
  assert.equal(cue.pocketed, false, "手球は戻されている");
  assert.equal(cue.x, bl.BL_HEAD_SPOT.x);
  assert.equal(next.phase, "aiming", "的球が残っているので続行");
});

test("ビリヤード: 最後の的球を落とすとクリアになり、以降は打てない", () => {
  const state = {
    ...bl.createBilliardsGame(1),
    balls: [
      { id: 0, x: 660, y: 60, pocketed: false },
      { id: 1, x: 740, y: 35, pocketed: false },
    ],
  };
  const angle = (Math.atan2(35 - 60, 740 - 660) * 180) / Math.PI;
  const { state: next } = bl.shoot(state, angle, 60);
  assert.equal(next.phase, "cleared");
  assert.equal(bl.remainingBalls(next), 0);
  assert.throws(() => bl.shoot(next, 0, 50));
});

test("ビリヤード: 入力検証（不正な角度・強さは例外）", () => {
  const s = bl.createBilliardsGame(3);
  assert.throws(() => bl.shoot(s, Number.NaN, 50));
  assert.throws(() => bl.shoot(s, 0, -1));
  assert.throws(() => bl.shoot(s, 0, 101));
  // simulateShot は不正入力でも例外にせず静止結果を返す
  const r = bl.simulateShot(s.balls, Number.NaN, 50);
  assert.equal(r.pocketedIds.length, 0);
  assert.equal(r.scratch, false);
});

test("ビリヤード: 一番近い的球を狙う自動プレイで全消しできる", () => {
  let s = bl.createBilliardsGame(42);
  for (let i = 0; i < 60 && s.phase === "aiming"; i++) {
    const cue = s.balls.find((b) => b.id === 0);
    const targets = s.balls.filter((b) => b.id > 0 && !b.pocketed);
    let nearest = targets[0];
    let nd = Number.POSITIVE_INFINITY;
    for (const t of targets) {
      const d = Math.hypot(t.x - cue.x, t.y - cue.y);
      if (d < nd) {
        nd = d;
        nearest = t;
      }
    }
    const angle = (Math.atan2(nearest.y - cue.y, nearest.x - cue.x) * 180) / Math.PI;
    s = bl.shoot(s, angle, 65).state;
  }
  assert.equal(s.phase, "cleared");
  assert.equal(bl.billiardsScore(s), s.shots + s.scratches);
});

// ---------------------------------------------------------------- カーリング

const stoneAt = (cu2, id, side, x, y) => ({ id, side, x, y });

test("カーリング: 得点計算（最寄りの側が、相手の最寄りより内側の数だけ得点）", () => {
  const S = (id, side, d) => stoneAt(cu, id, side, cu.CU_BUTTON.x + d, cu.CU_BUTTON.y);
  // player: 20, 30 / cpu: 40 → player が 2 点
  assert.deepEqual(
    cu.scoreEndStones([S(1, "player", 20), S(2, "player", 30), S(3, "cpu", 40)]),
    { player: 2, cpu: 0 },
  );
  // cpu だけハウス内 → cpu がその数だけ得点
  assert.deepEqual(
    cu.scoreEndStones([S(1, "cpu", 10), S(2, "cpu", 50), S(3, "player", 300)]),
    { player: 0, cpu: 2 },
  );
  // どちらもハウス外 → ブランク
  assert.deepEqual(cu.scoreEndStones([S(1, "player", 300), S(2, "cpu", 200)]), {
    player: 0,
    cpu: 0,
  });
  assert.deepEqual(cu.scoreEndStones([]), { player: 0, cpu: 0 });
});

test("カーリング: シミュレーションは決定的で、適正な強さではハウスに残る", () => {
  const input = { id: 1, side: "player", x: 160, y: cu.CU_THROW_Y };
  const r1 = cu.simulateThrow([], input, 78, 0);
  const r2 = cu.simulateThrow([], input, 78, 0);
  assert.deepEqual(r1.frames, r2.frames);
  assert.deepEqual(r1.stones, r2.stones);
  assert.equal(r1.kept, true);
  assert.equal(cu.inHouse(r1.stones[0]), true);
  assert.ok(cu.distanceToButton(r1.stones[0]) < 20, "強さ78は中心付近に止まる");
});

test("カーリング: 弱すぎる投げはホッグライン未達で取り除かれ、強すぎるとバックラインを越える", () => {
  const input = { id: 1, side: "player", x: 160, y: cu.CU_THROW_Y };
  const weak = cu.simulateThrow([], input, 20, 0);
  assert.equal(weak.kept, false);
  assert.equal(weak.stones.length, 0);
  const strong = cu.simulateThrow([], input, 100, 0);
  assert.equal(strong.kept, false);
  assert.equal(strong.stones.length, 0);
});

test("カーリング: カールで横に曲がり、向きが符号どおりになる", () => {
  const input = { id: 1, side: "player", x: 160, y: cu.CU_THROW_Y };
  const right = cu.simulateThrow([], input, 78, 100).stones[0];
  const left = cu.simulateThrow([], input, 78, -100).stones[0];
  assert.ok(right.x > 165, `右カールで右へ (x=${right.x})`);
  assert.ok(left.x < 155, `左カールで左へ (x=${left.x})`);
});

test("カーリング: ストーン同士が衝突すると相手が動く（テイクアウト）", () => {
  const target = stoneAt(cu, 1, "cpu", cu.CU_BUTTON.x, cu.CU_BUTTON.y);
  const before = { ...target };
  const r = cu.simulateThrow([target], { id: 2, side: "player", x: 160, y: cu.CU_THROW_Y }, 82, 0);
  const cpuStone = r.stones.find((s) => s.side === "cpu");
  assert.ok(cpuStone, "CPU ストーンは（押し出されても）残るか取り除かれる");
  const moved = Math.hypot(cpuStone.x - before.x, cpuStone.y - before.y);
  assert.ok(moved > 5, `衝突で相手ストーンが動いた (moved=${moved.toFixed(1)})`);
});

test("カーリング: CPU の狙いは決定的で、投げるとハウス周辺に残る", () => {
  let s = cu.createCurlingGame(7);
  s = cu.playerThrow(s, 78, 0).state;
  assert.equal(s.turn, "cpu");
  const d1 = cu.decideCpuThrow(s);
  const d2 = cu.decideCpuThrow(s);
  assert.deepEqual(d1, d2, "同じ状態からは同じ狙い");
  assert.ok(d1.power >= 0 && d1.power <= 100);
  const { state: next } = cu.cpuThrow(s);
  assert.equal(next.turn, "player");
  assert.equal(next.throwIndex, 2);
  const cpuStone = next.stones.find((x) => x.side === "cpu");
  assert.ok(cpuStone, "CPU ストーンが残っている");
  assert.ok(cu.distanceToButton(cpuStone) < 120, "CPU ストーンはハウス周辺にある");
});

test("カーリング: 手番と入力の検証", () => {
  const s = cu.createCurlingGame(5);
  assert.throws(() => cu.cpuThrow(s), "プレイヤーの手番で CPU は投げられない");
  assert.throws(() => cu.playerThrow(s, -1, 0));
  assert.throws(() => cu.playerThrow(s, 50, 101));
  assert.throws(() => cu.nextEnd(s), "エンド中は次へ進めない");
});

test("カーリング: 全2エンドを完走すると勝者が決まり、スコアが整合する", () => {
  let s = cu.createCurlingGame(123);
  let guard = 0;
  while (s.phase !== "finished" && guard++ < 100) {
    if (s.phase === "endScored") {
      s = cu.nextEnd(s);
      continue;
    }
    s = s.turn === "player" ? cu.playerThrow(s, 78, 0).state : cu.cpuThrow(s).state;
  }
  assert.equal(s.phase, "finished");
  assert.equal(s.endScores.length, 2);
  const sum = {
    player: s.endScores.reduce((a, e) => a + e.player, 0),
    cpu: s.endScores.reduce((a, e) => a + e.cpu, 0),
  };
  assert.deepEqual(s.scores, sum);
  const expected = sum.player === sum.cpu ? "draw" : sum.player > sum.cpu ? "player" : "cpu";
  assert.equal(s.winner, expected);
});

// ---------------------------------------------------------------- アナグラム増量

test("アナグラム: バンクは120語で、重複なし・全てカタカナ", () => {
  assert.equal(an.ANAGRAM_WORDS.length, 120);
  assert.equal(new Set(an.ANAGRAM_WORDS).size, 120);
  for (const word of an.ANAGRAM_WORDS) {
    assert.match(word, /^[ァ-ヶー]+$/, `${word} はカタカナのみ`);
    assert.ok([...word].length >= 2, `${word} は2文字以上`);
    // 並べ替えても変わらない単語（全文字同一など）は含めない
    assert.ok(new Set([...word]).size >= 2, `${word} は複数種の文字を含む`);
  }
});

test("アナグラム: 増量分もシャッフルが元の並びにならない", () => {
  const added = [
    "パイナップル", "トランペット", "スパゲッティ", "ハンバーグ", "ヒコウキ",
  ];
  for (const word of added) {
    assert.ok(an.ANAGRAM_WORDS.includes(word), `${word} がバンクにある`);
    for (let seed = 0; seed < 40; seed++) {
      const { text } = an.shuffleWord(word, seed * 31 + 7);
      assert.notEqual(text, word);
      assert.deepEqual([...text].sort(), [...word].sort());
    }
  }
  // 増量後も出題は10問で決定的
  const a = an.createAnagramGame(99);
  assert.equal(a.words.length, 10);
  assert.equal(new Set(a.words).size, 10);
});
