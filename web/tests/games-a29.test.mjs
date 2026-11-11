// A29フェーズの新規2本＋増量のロジック検証。
// - lib/hearts.ts: ルール（パス/2♣/フォロー/点計算/ムーン）・CPU込み全進行・決定性
// - lib/puttgolf.ts: シミュレーション決定性・ガイド経由の自動プレイで全ホール到達
// - lib/online/games/majority.ts: バンク 75問・4択形式・重複なし
// - lib/online/games/minority.ts: バンク 55問・2択形式・重複なし
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
  const code = stripModuleSyntax(js) + `\nexport { ${exportsList.join(", ")} };\n`;
  return import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
}

const hearts = await loadLib("hearts.ts");
const putt = await loadLib("puttgolf.ts");
const mj = await loadOnline("majority.ts", ["MAJORITY_QUESTIONS"]);
const mn = await loadOnline("minority.ts", ["MINORITY_QUESTIONS"]);

// ---------------------------------------------------------------- ハーツ

test("ハーツ: 点計算（ハート1点、スペードのQは13点、デッキ全体で26点）", () => {
  const deck = Array.from({ length: 52 }, (_, i) => i);
  assert.equal(hearts.pointsOfCards(deck), 26);
  assert.equal(hearts.pointsOfCard(hearts.QUEEN_OF_SPADES), 13);
  assert.equal(hearts.pointsOfCard(hearts.cardId("heart", 1)), 1);
  assert.equal(hearts.pointsOfCard(hearts.cardId("club", 13)), 0);
  assert.equal(hearts.TWO_OF_CLUBS, hearts.cardId("club", 2));
});

test("ハーツ: 初期配布は各13枚・重複なし、パス方向は左から始まる", () => {
  const s = hearts.createHeartsGame(42);
  assert.equal(s.phase, "pass");
  assert.equal(s.passDir, 0);
  const all = s.players.flatMap((p) => p.hand);
  assert.equal(all.length, 52);
  assert.equal(new Set(all).size, 52);
  for (const p of s.players) assert.equal(p.hand.length, 13);
});

test("ハーツ: 同じシードでは同じ配布になる（決定性）", () => {
  const a = hearts.createHeartsGame(7);
  const b = hearts.createHeartsGame(7);
  assert.deepEqual(
    a.players.map((p) => p.hand),
    b.players.map((p) => p.hand),
  );
});

test("ハーツ: パスの検証（3枚・重複不可・手札にあるものだけ）", () => {
  const s = hearts.createHeartsGame(11);
  const hand = s.players[0].hand;
  assert.throws(() => hearts.submitPass(s, hand.slice(0, 2)));
  assert.throws(() => hearts.submitPass(s, [hand[0], hand[0], hand[1]]));
  const notMine = Array.from({ length: 52 }, (_, i) => i).find((c) => !hand.includes(c));
  assert.throws(() => hearts.submitPass(s, [hand[0], hand[1], notMine]));
  const after = hearts.submitPass(s, hand.slice(0, 3));
  assert.equal(after.players[0].hand.length, 13);
  for (const c of hand.slice(0, 3)) assert.ok(!after.players[0].hand.includes(c));
  // 左（seat 1）が自分のパスした3枚を受け取っている
  for (const c of hand.slice(0, 3)) assert.ok(after.players[1].hand.includes(c));
});

test("ハーツ: 最初のリードはクラブの2しか出せない", () => {
  // seat 0 がクラブの2を持つシードを探して検証する
  let found = false;
  for (let seed = 1; seed < 200 && !found; seed++) {
    let s = hearts.createHeartsGame(seed);
    if (s.phase === "pass") {
      s = hearts.submitPass(s, hearts.chooseCpuPass(s.players[0].hand));
    }
    // パス後にクラブの2を持つ人がリード。受け取りで seat 0 が持つ場合もある
    if (s.phase === "play" && s.turn === 0 && s.tricksPlayed === 0) {
      assert.deepEqual(hearts.legalPlays(s), [hearts.TWO_OF_CLUBS]);
      found = true;
    }
  }
  assert.ok(found, "seat 0 が最初のリードになるシードが見つかるはず");
});

test("ハーツ: CPUパスは常に手札から3枚・重複なし", () => {
  for (let seed = 1; seed <= 30; seed++) {
    const s = hearts.createHeartsGame(seed);
    for (const p of s.players) {
      const picks = hearts.chooseCpuPass(p.hand);
      assert.equal(picks.length, 3);
      assert.equal(new Set(picks).size, 3);
      for (const c of picks) assert.ok(p.hand.includes(c));
    }
  }
});

/** 人間も CPU 方針で操作して1ゲームを最後まで進める。 */
function playFullGame(seed) {
  let s = hearts.createHeartsGame(seed);
  let handPointSums = [];
  let guard = 0;
  while (s.phase !== "finished" && guard++ < 5000) {
    if (s.phase === "pass") {
      s = hearts.submitPass(s, hearts.chooseCpuPass(s.players[0].hand));
    } else if (s.phase === "play") {
      assert.equal(s.turn, 0, "play フェーズでは人間の手番で止まっているはず");
      // 1ハンドのカード総数チェック（手札+場+取った札 = 52）
      const inHands = s.players.reduce((n, p) => n + p.hand.length, 0);
      const taken = s.players.reduce((n, p) => n + p.taken.length, 0);
      assert.equal(inHands + taken + s.trick.length, 52);
      const legal = hearts.legalPlays(s);
      assert.ok(legal.length > 0);
      // フォロー義務: リードスートを持っているなら legal は全てそのスート
      if (s.trick.length > 0) {
        const ledSuit = hearts.cardSuit(s.trick[0].card);
        const hasLed = s.players[0].hand.some((c) => hearts.cardSuit(c) === ledSuit);
        if (hasLed) assert.ok(legal.every((c) => hearts.cardSuit(c) === ledSuit));
      }
      s = hearts.playCard(s, hearts.chooseCpuPlay(s, 0));
    } else if (s.phase === "handEnd") {
      // ハンドの生点は合計26点
      const raw = s.players.reduce((n, p) => n + hearts.pointsOfCards(p.taken), 0);
      assert.equal(raw, 26);
      const sum = s.handPoints.reduce((a, b) => a + b, 0);
      assert.ok(sum === 26 || sum === 78, "通常は26、ムーン時は78");
      handPointSums.push(s.handPoints);
      s = hearts.nextHand(s);
    }
  }
  assert.equal(s.phase, "finished");
  assert.ok(s.winners && s.winners.length >= 1);
  // 最終スコアは handPoints の累計と一致する
  for (let seat = 0; seat < 4; seat++) {
    const total = handPointSums.reduce((n, hp) => n + hp[seat], 0);
    assert.equal(s.players[seat].score, total);
  }
  const min = Math.min(...s.players.map((p) => p.score));
  assert.ok(s.winners.every((w) => s.players[w].score === min));
  return s;
}

test("ハーツ: CPU込みで全ゲームが最後まで進行し、スコアが整合する", () => {
  for (const seed of [1, 5, 13, 99]) {
    playFullGame(seed);
  }
});

test("ハーツ: 全進行もシード決定的（同じシードで同じ最終スコア）", () => {
  const a = playFullGame(31);
  const b = playFullGame(31);
  assert.deepEqual(
    a.players.map((p) => p.score),
    b.players.map((p) => p.score),
  );
});

// ---------------------------------------------------------------- パットゴルフ

test("パットゴルフ: 9ホール生成はシード決定的で、パーは2〜4", () => {
  const a = putt.createPuttGame(3);
  const b = putt.createPuttGame(3);
  assert.deepEqual(a.holes, b.holes);
  assert.equal(a.holes.length, 9);
  for (const h of a.holes) {
    assert.ok(h.par >= 2 && h.par <= 4);
    assert.ok(h.guide.length === 4);
    assert.deepEqual(h.guide[0], h.tee);
    assert.deepEqual(h.guide[3], h.cup);
  }
  const c = putt.createPuttGame(4);
  assert.notDeepEqual(a.holes, c.holes);
});

test("パットゴルフ: 壁は通路（ガイド）から離れて置かれる", () => {
  for (let seed = 1; seed <= 10; seed++) {
    const g = putt.createPuttGame(seed);
    for (const h of g.holes) {
      for (const w of h.walls) {
        // 壁の中心がガイドのどの点とも 40px 以上離れている（生成条件の緩い確認）
        for (const gp of h.guide) {
          const d = Math.hypot(w.x + w.w / 2 - gp.x, w.y + w.h / 2 - gp.y);
          assert.ok(d > 40, `seed ${seed} hole ${h.index}: 壁が通路に近すぎる`);
        }
      }
    }
  }
});

test("パットゴルフ: 同じ打ち方は必ず同じ結果になる（シミュレーション決定性）", () => {
  const g = putt.createPuttGame(8);
  const hole = g.holes[0];
  const r1 = putt.simulateShot(hole, hole.tee, 20, 55);
  const r2 = putt.simulateShot(hole, hole.tee, 20, 55);
  assert.deepEqual(r1, r2);
  assert.ok(r1.points.length >= 2);
  // 強さ0でもボールは少し転がり、フィールド内に止まる
  const r0 = putt.simulateShot(hole, hole.tee, 0, 0);
  assert.ok(r0.end.x >= 0 && r0.end.x <= putt.PG_WIDTH);
  assert.ok(r0.end.y >= 0 && r0.end.y <= putt.PG_HEIGHT);
});

test("パットゴルフ: ガイド経由の自動プレイで全ホールに到達できる", () => {
  for (const seed of [2, 17, 123]) {
    let s = putt.createPuttGame(seed);
    let guard = 0;
    while (s.phase !== "finished" && guard++ < 40) {
      const hole = s.holes[s.holeIndex];
      let ball = { ...s.ball };
      let wpIndex = 1;
      let holed = false;
      for (let shots = 0; shots < 24 && !holed; shots++) {
        // 現在位置に一番近い次のガイド点を狙う
        while (wpIndex < hole.guide.length - 1 && Math.hypot(ball.x - hole.guide[wpIndex].x, ball.y - hole.guide[wpIndex].y) < 34) {
          wpIndex++;
        }
        const target = hole.guide[wpIndex];
        const d = Math.hypot(target.x - ball.x, target.y - ball.y);
        const angle = (Math.atan2(target.y - ball.y, target.x - ball.x) * 180) / Math.PI;
        const isCup = wpIndex === hole.guide.length - 1;
        const power = Math.max(4, Math.min(100, putt.powerForDistance(d) + (isCup ? 1 : 7)));
        const res = putt.simulateShot(hole, ball, angle, power);
        ball = res.end;
        holed = res.holed;
        if (!holed && Math.hypot(ball.x - target.x, ball.y - target.y) < 34 && wpIndex < hole.guide.length - 1) {
          wpIndex++;
        }
      }
      assert.ok(holed, `seed ${seed} hole ${hole.index + 1} に到達できるはず`);
      // lib の shoot でも同じホールを打ち切り、nextHole で進める
      let viaLib = s;
      let ball2 = { ...viaLib.ball };
      let wp2 = 1;
      let holed2 = false;
      for (let shots = 0; shots < 24 && !holed2; shots++) {
        const hole2 = viaLib.holes[viaLib.holeIndex];
        while (wp2 < hole2.guide.length - 1 && Math.hypot(ball2.x - hole2.guide[wp2].x, ball2.y - hole2.guide[wp2].y) < 34) wp2++;
        const target = hole2.guide[wp2];
        const d = Math.hypot(target.x - ball2.x, target.y - ball2.y);
        const angle = (Math.atan2(target.y - ball2.y, target.x - ball2.x) * 180) / Math.PI;
        const isCup = wp2 === hole2.guide.length - 1;
        const power = Math.max(4, Math.min(100, putt.powerForDistance(d) + (isCup ? 1 : 7)));
        const before = viaLib.strokes[viaLib.holeIndex];
        const out = putt.shoot(viaLib, angle, power);
        viaLib = out.state;
        ball2 = out.result.end;
        holed2 = out.result.holed;
        assert.equal(viaLib.strokes[viaLib.holeIndex], before + 1);
      }
      assert.ok(holed2);
      s = putt.nextHole(viaLib);
    }
    assert.equal(s.phase, "finished");
    assert.equal(s.strokes.length, 9);
    assert.ok(s.strokes.every((v) => v > 0));
    assert.equal(s.totalStrokes, s.strokes.reduce((a, b) => a + b, 0));
  }
});

test("パットゴルフ: 入力検証（範囲外の強さ・終了後の打撃はエラー）", () => {
  const s = putt.createPuttGame(1);
  assert.throws(() => putt.shoot(s, 0, 101));
  assert.throws(() => putt.shoot(s, Number.NaN, 50));
  assert.throws(() => putt.nextHole(s)); // まだカップインしていない
});

// ---------------------------------------------------------------- バンク増量

test("多数決: バンクは100問・全て4択・トピックと選択肢に重複なし", () => {
  assert.equal(mj.MAJORITY_QUESTIONS.length, 100);
  const topics = mj.MAJORITY_QUESTIONS.map((q) => q.topic);
  assert.equal(new Set(topics).size, topics.length);
  for (const q of mj.MAJORITY_QUESTIONS) {
    assert.equal(q.choices.length, 4);
    assert.equal(new Set(q.choices).size, 4);
    for (const c of q.choices) assert.ok(typeof c === "string" && c.length > 0);
  }
});

test("少数決: バンクは75問・全て2択タプル・トピックに重複なし", () => {
  assert.equal(mn.MINORITY_QUESTIONS.length, 75);
  const topics = mn.MINORITY_QUESTIONS.map((q) => q.topic);
  assert.equal(new Set(topics).size, topics.length);
  for (const q of mn.MINORITY_QUESTIONS) {
    assert.equal(q.choices.length, 2);
    assert.notEqual(q.choices[0], q.choices[1]);
    for (const c of q.choices) assert.ok(typeof c === "string" && c.length > 0);
  }
});
