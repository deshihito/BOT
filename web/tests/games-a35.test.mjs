// A35 で追加したゲームのロジック検証（lib のみ、UI 非依存）。
// - lib/chinchiro.ts: 役判定・強さ比較・倍率・全ラウンド完走と得点整合
// - lib/crocodile.ts: 進行・CPU の応答・決着・決定性
// - lib/kanacross.ts: 増量分を含む全問題の整合性（isValidPuzzle）
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

const cc = await loadLib("chinchiro.ts");
const cr = await loadLib("crocodile.ts");
const kana = await loadLib("kanacross.ts");

// ---------- チンチロリン: 役判定 ----------

test("チンチロリン: 役判定（ピンゾロ/アラシ/シゴロ/通常の目/ヒフミ/目なし）", () => {
  const pin = cc.evaluateHand([1, 1, 1]);
  assert.equal(pin.kind, "pinzoro");
  assert.equal(pin.multiplier, 5);
  const ara = cc.evaluateHand([5, 5, 5]);
  assert.equal(ara.kind, "arashi");
  assert.equal(ara.multiplier, 3);
  assert.equal(ara.triple, 5);
  const shi = cc.evaluateHand([6, 4, 5]);
  assert.equal(shi.kind, "shigoro");
  assert.equal(shi.multiplier, 2);
  const normal = cc.evaluateHand([2, 5, 2]);
  assert.equal(normal.kind, "normal");
  assert.equal(normal.point, 5);
  assert.equal(normal.multiplier, 1);
  const hifumi = cc.evaluateHand([3, 1, 2]);
  assert.equal(hifumi.kind, "hifumi");
  const menashi = cc.evaluateHand([1, 3, 5]);
  assert.equal(menashi.kind, "menashi");
  assert.equal(cc.isDetermined(menashi), false);
  assert.equal(cc.isDetermined(normal), true);
});

test("チンチロリン: 強さの順序（ピンゾロ＞アラシ＞シゴロ＞通常の目＞目なし＞ヒフミ＞ションベン）", () => {
  const pin = cc.evaluateHand([1, 1, 1]);
  const ara6 = cc.evaluateHand([6, 6, 6]);
  const ara2 = cc.evaluateHand([2, 2, 2]);
  const shi = cc.evaluateHand([4, 5, 6]);
  const n6 = cc.evaluateHand([3, 3, 6]);
  const n1 = cc.evaluateHand([4, 4, 1]);
  const menashi = cc.evaluateHand([2, 4, 6]);
  const hifumi = cc.evaluateHand([1, 2, 3]);
  const shonben = cc.shonbenHand();
  assert.ok(cc.compareHands(pin, ara6) > 0);
  assert.ok(cc.compareHands(ara6, ara2) > 0);
  assert.ok(cc.compareHands(ara2, shi) > 0);
  assert.ok(cc.compareHands(shi, n6) > 0);
  assert.ok(cc.compareHands(n6, n1) > 0);
  assert.ok(cc.compareHands(n1, menashi) > 0);
  assert.ok(cc.compareHands(menashi, hifumi) > 0);
  assert.ok(cc.compareHands(hifumi, shonben) > 0);
  assert.equal(cc.compareHands(n6, cc.evaluateHand([5, 5, 6])), 0);
});

/** プレイヤーは「役が出たら必ず確定する」方針で最後まで進める。 */
function playChinchiroToEnd(seed) {
  let s = cc.createChinchiroGame(seed);
  let guard = 0;
  while (s.phase !== "finished" && guard++ < 1000) {
    if (s.phase === "roll") s = cc.rollCc(s);
    else if (s.phase === "decide") s = cc.keepCcHand(s);
    else if (s.phase === "roundEnd") s = cc.nextCcRound(s);
    else break;
  }
  return s;
}

test("チンチロリン: 全10ラウンド完走し、得点が履歴と一致する（ゼロサム）", () => {
  for (const seed of [1, 7, 42, 12345]) {
    const s = playChinchiroToEnd(seed);
    assert.equal(s.phase, "finished");
    assert.equal(s.history.length, cc.CC_TOTAL_ROUNDS);
    let p = 0;
    let c = 0;
    for (const h of s.history) {
      // 得点は勝者の役の倍率×10、敗者がヒフミなら2倍
      if (h.winner === "draw") {
        assert.equal(h.points, 0);
      } else {
        const winnerHand = h.winner === "player" ? h.playerHand : h.cpuHand;
        const loserHand = h.winner === "player" ? h.cpuHand : h.playerHand;
        let expected = cc.CC_BASE_POINTS * winnerHand.multiplier;
        if (loserHand.kind === "hifumi") expected *= 2;
        assert.equal(h.points, expected);
        assert.equal(Math.sign(cc.compareHands(h.playerHand, h.cpuHand)), h.winner === "player" ? 1 : -1);
      }
      if (h.winner === "player") {
        p += h.points;
        c -= h.points;
      } else if (h.winner === "cpu") {
        c += h.points;
        p -= h.points;
      }
    }
    assert.equal(s.playerScore, p);
    assert.equal(s.cpuScore, c);
    assert.equal(s.playerScore + s.cpuScore, 0);
  }
});

test("チンチロリン: 同じシード・同じ操作では全く同じ結果になる（決定性）", () => {
  const a = playChinchiroToEnd(99);
  const b = playChinchiroToEnd(99);
  assert.deepEqual(a.history, b.history);
  assert.equal(a.playerScore, b.playerScore);
});

test("チンチロリン: 振り直しは最大3回までで、3回目で必ずラウンドが締まる", () => {
  let s = cc.createChinchiroGame(5);
  let guard = 0;
  // 確定せず振り続けても、1ラウンドは最大 CC_MAX_ROLLS 回の投げで締まる
  while (s.phase === "roll" || s.phase === "decide") {
    assert.ok(s.playerRolls < cc.CC_MAX_ROLLS);
    s = cc.rollCc(s);
    assert.ok(++guard <= cc.CC_MAX_ROLLS);
  }
  assert.ok(s.phase === "roundEnd" || s.phase === "finished");
  assert.equal(s.history.length, 1);
  // 締まった後は振れない・確定できない（同じ状態が返る）
  assert.equal(cc.rollCc(s), s);
  assert.equal(cc.keepCcHand(s), s);
});

// ---------- ワニワニ ----------

test("ワニワニ: 当たりは1本だけ範囲内にあり、押下済みの歯は二度押せない", () => {
  const s = cr.createCrocodileGame(3);
  assert.ok(Number.isInteger(s.trap) && s.trap >= 0 && s.trap < cr.CR_TEETH);
  assert.equal(s.pressed.length, cr.CR_TEETH);
  const safe = s.pressed.findIndex((_, i) => i !== s.trap);
  const after = cr.pressTooth(s, safe);
  assert.notEqual(after, s);
  // 終了していなければ、再押下は無効（同じ状態）
  if (after.status === "playing") {
    assert.equal(cr.pressTooth(after, safe), after);
  }
  // 範囲外は無効
  assert.equal(cr.pressTooth(s, -1), s);
  assert.equal(cr.pressTooth(s, cr.CR_TEETH), s);
});

test("ワニワニ: 当たりの歯を押すと負けになる", () => {
  const s = cr.createCrocodileGame(11);
  const after = cr.pressTooth(s, s.trap);
  assert.equal(after.status, "lost");
  assert.equal(after.lastPlayer, s.trap);
  assert.equal(after.cpuPresses, 0); // 負けたら CPU は押さない
});

test("ワニワニ: 安全な歯を押すと CPU が1本押し、交互に進んで必ず決着する", () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    let s = cr.createCrocodileGame(seed);
    let guard = 0;
    while (s.status === "playing" && guard++ < 50) {
      const next = s.pressed.findIndex((p) => !p);
      const before = s.pressed.filter(Boolean).length;
      s = cr.pressTooth(s, next);
      const afterCount = s.pressed.filter(Boolean).length;
      if (s.status === "playing") {
        // 自分+CPU で2本ずつ減る
        assert.equal(afterCount, before + 2);
        assert.equal(s.cpuPresses, s.playerPresses);
      }
    }
    assert.ok(s.status === "won" || s.status === "lost");
    // 決着時は当たりの歯が押されている
    assert.equal(s.pressed[s.trap], true);
    if (s.status === "won") assert.equal(s.lastCpu, s.trap);
    if (s.status === "lost") assert.equal(s.lastPlayer, s.trap);
  }
});

test("ワニワニ: 同じシードでは当たりの位置も CPU の押し方も同じ（決定性）", () => {
  const play = (seed) => {
    let s = cr.createCrocodileGame(seed);
    while (s.status === "playing") {
      s = cr.pressTooth(s, s.pressed.findIndex((p) => !p));
    }
    return s;
  };
  const a = play(77);
  const b = play(77);
  assert.deepEqual(a.pressed, b.pressed);
  assert.equal(a.status, b.status);
  assert.equal(a.trap, b.trap);
});

// ---------- カナクロス増量 ----------

test("カナクロス: 問題は14問に増え、全問が isValidPuzzle で妥当", () => {
  assert.equal(kana.KANACROSS_PUZZLES.length, 14);
  const ids = kana.KANACROSS_PUZZLES.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ["ringo", "sakana", "yasai", "okazu", "amerika"]) {
    assert.ok(ids.includes(id), id);
  }
  for (const p of kana.KANACROSS_PUZZLES) {
    assert.equal(kana.isValidPuzzle(p), true, p.id);
  }
});

test("カナクロス: 追加問題も全マス入力で完成する", () => {
  for (const index of [5, 6, 7]) {
    const puzzle = kana.KANACROSS_PUZZLES[index];
    let s = kana.createKanacrossGame(index);
    puzzle.solution.forEach((ch, i) => {
      if (ch !== null) s = kana.setEntry(s, i, ch);
    });
    assert.equal(s.status, "completed", puzzle.id);
  }
});
