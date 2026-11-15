// A25フェーズ新規3本のロジック検証（lib のみ、UI 非依存）。
// - lib/online/games/calcrace.ts: 出題の正しさ・採点・ロック・進行・秘匿・退出
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

const cr = await loadOnline("calcrace.ts", [ "gameModule", "buildCrQuestions", "crScoreFor", "CR_TOTAL_QUESTIONS", "CR_LOCK_MS", ]);

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

function isKnightMove(size, a, b) {
  const dr = Math.abs(Math.floor(a / size) - Math.floor(b / size));
  const dc = Math.abs((a % size) - (b % size));
  return (dr === 1 && dc === 2) || (dr === 2 && dc === 1);
}

// ---------------------------------------------------------------- calcrace

const PLAYERS2 = [
  { seat: 0, name: "A" },
  { seat: 1, name: "B" },
];

function evalExpr(text) {
  const js = text.replace(/−/g, "-").replace(/×/g, "*").replace(/÷/g, "/");
  return Function(`"use strict"; return (${js});`)();
}

test("計算レース: 問題は10問生成され、式と答えが一致する", () => {
  for (const seed of [1, 2, 3]) {
    const qs = cr.buildCrQuestions(makeRng(seed));
    assert.equal(qs.length, cr.CR_TOTAL_QUESTIONS);
    for (const q of qs) {
      assert.equal(evalExpr(q.text), q.answer, q.text);
      assert.ok(Number.isInteger(q.answer) && q.answer >= 0);
    }
  }
  assert.deepEqual(cr.buildCrQuestions(makeRng(9)), cr.buildCrQuestions(makeRng(9)));
});

test("計算レース: 得点式は 100 + 残り秒数×5", () => {
  assert.equal(cr.crScoreFor(20000), 200);
  assert.equal(cr.crScoreFor(10000), 150);
  assert.equal(cr.crScoreFor(9999), 145);
  assert.equal(cr.crScoreFor(0), 100);
});

test("計算レース: 人数バリデーション（2〜8人）", () => {
  const mod = cr.gameModule;
  assert.throws(() => mod.createState([{ seat: 0, name: "A" }], makeRng(1), {}));
  const nine = Array.from({ length: 9 }, (_, i) => ({ seat: i, name: `P${i}` }));
  assert.throws(() => mod.createState(nine, makeRng(1), {}));
  const eight = Array.from({ length: 8 }, (_, i) => ({ seat: i, name: `P${i}` }));
  assert.equal(mod.createState(eight, makeRng(1), {}).players.length, 8);
});

test("計算レース: 最初の正解者だけが速さに応じた得点を得て、全員正解で締め切る", () => {
  const mod = cr.gameModule;
  let s = mod.createState(PLAYERS2, makeRng(11), {});
  s = { ...s, questionEndsAt: Date.now() + 10000 };
  const answer = s.questions[0].answer;
  s = mod.applyAction(s, 1, { type: "answer", value: answer }, makeRng(1));
  assert.equal(s.winnerSeat, 1);
  const gained = s.scores[1];
  assert.ok(gained >= 145 && gained <= 150, `gained=${gained}`);
  assert.equal(s.scores[0], 0);
  assert.equal(s.phase, "question"); // まだ全員は正解していない
  // 後から正解しても得点は入らない
  s = mod.applyAction(s, 0, { type: "answer", value: answer }, makeRng(1));
  assert.equal(s.scores[0], 0);
  assert.equal(s.phase, "reveal");
  assert.equal(s.history[0].winnerSeat, 1);
  assert.equal(s.history[0].results.find((r) => r.seat === 1).gained, gained);
  // reveal が終われば次の問題へ
  s = mod.tick(s, Date.now() + 10000);
  assert.equal(s.phase, "question");
  assert.equal(s.index, 1);
});

test("計算レース: 不正解はその問題だけロックされ、ロック中は回答できない", () => {
  const mod = cr.gameModule;
  let s = mod.createState(PLAYERS2, makeRng(12), {});
  const wrong = s.questions[0].answer + 1;
  s = mod.applyAction(s, 0, { type: "answer", value: wrong }, makeRng(1));
  assert.ok(s.lockedUntil[0] > Date.now());
  assert.throws(() => mod.applyAction(s, 0, { type: "answer", value: s.questions[0].answer }, makeRng(1)), /ロック/);
  // 相手は影響を受けない
  const s2 = mod.applyAction(s, 1, { type: "answer", value: wrong }, makeRng(1));
  assert.ok(s2.lockedUntil[1] > Date.now());
  // ロックが明ければ正解できる
  const unlocked = { ...s, lockedUntil: { ...s.lockedUntil, 0: Date.now() - 1 } };
  const s3 = mod.applyAction(unlocked, 0, { type: "answer", value: unlocked.questions[0].answer }, makeRng(1));
  assert.ok(s3.solvedSeats.includes(0));
});

test("計算レース: 時間切れで締め切り、正解者なしでも進む", () => {
  const mod = cr.gameModule;
  let s = mod.createState(PLAYERS2, makeRng(13), {});
  s = mod.tick(s, (s.questionEndsAt ?? 0) + 1);
  assert.equal(s.phase, "reveal");
  assert.equal(s.history[0].winnerSeat, null);
  assert.ok(s.history[0].results.every((r) => r.gained === 0 && !r.solved));
});

test("計算レース: 提出した値は締切まで他のプレイヤーに見えない", () => {
  const mod = cr.gameModule;
  let s = mod.createState(PLAYERS2, makeRng(14), {});
  s = mod.applyAction(s, 1, { type: "answer", value: 424242 }, makeRng(1)); // 不正解の提出値
  const viewForA = JSON.stringify(mod.viewFor(s, 0));
  assert.ok(!viewForA.includes("424242"));
  assert.ok(!viewForA.includes("answers"));
  // 正解しても、答えそのものは reveal まで開示されない（ロックを明けた状態で回答）
  s = { ...s, lockedUntil: { ...s.lockedUntil, 1: Date.now() - 1 } };
  s = mod.applyAction(s, 1, { type: "answer", value: s.questions[0].answer }, makeRng(1));
  const view2 = mod.viewFor(s, 0);
  assert.equal(view2.correctAnswer, null);
  assert.equal(view2.players.find((p) => p.seat === 1).solved, true);
});

test("計算レース: 退出してもスコアは保持され、順位の対象に残る", () => {
  const mod = cr.gameModule;
  let s = mod.createState(PLAYERS2, makeRng(15), {});
  s = { ...s, questionEndsAt: Date.now() + 10000 };
  s = mod.applyAction(s, 1, { type: "answer", value: s.questions[0].answer }, makeRng(1));
  const scoreOfB = s.scores[1];
  assert.ok(scoreOfB > 0);
  s = mod.onPlayerLeft(s, 1);
  assert.ok(s.leftSeats.includes(1));
  assert.equal(s.scores[1], scoreOfB);
  // B が抜けたので、A の正解だけで締め切る
  s = mod.applyAction(s, 0, { type: "answer", value: s.questions[s.index].answer }, makeRng(1));
  assert.equal(s.phase, "reveal");
  // 最後まで進めて順位に B が残ることを確認
  for (let guard = 0; guard < 100 && s.phase !== "finished"; guard++) {
    if (s.phase === "reveal") {
      s = mod.tick(s, Date.now() + 10000);
    } else {
      s = mod.applyAction(s, 0, { type: "answer", value: s.questions[s.index].answer }, makeRng(1));
    }
  }
  assert.equal(s.phase, "finished");
  const view = mod.viewFor(s, 0);
  assert.equal(view.standings.length, 2);
  assert.ok(view.standings.some((x) => x.seat === 1 && x.score === scoreOfB));
});

test("計算レース: parseAction の形式検証と、全問完走", () => {
  const mod = cr.gameModule;
  assert.equal(mod.parseAction(null), null);
  assert.equal(mod.parseAction({ type: "answer", value: 1.5 }), null);
  assert.equal(mod.parseAction({ type: "answer", value: "42" }), null);
  assert.deepEqual(mod.parseAction({ type: "answer", value: -7 }), { type: "answer", value: -7 });

  let s = mod.createState(PLAYERS2, makeRng(16), {});
  for (let guard = 0; guard < 200 && s.phase !== "finished"; guard++) {
    if (s.phase === "reveal") {
      s = mod.tick(s, Date.now() + 10000);
    } else {
      for (const p of PLAYERS2) {
        if (!s.solvedSeats.includes(p.seat)) {
          s = mod.applyAction(s, p.seat, { type: "answer", value: s.questions[s.index].answer }, makeRng(1));
        }
      }
    }
  }
  assert.equal(s.phase, "finished");
  assert.equal(s.history.length, cr.CR_TOTAL_QUESTIONS);
  // 各問で得点したのは勝者1人だけ
  for (const h of s.history) {
    assert.equal(h.results.filter((r) => r.gained > 0).length, 1);
  }
});
