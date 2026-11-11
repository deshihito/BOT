// A31フェーズの検証。
// - lib/airhockey.ts: シミュレーション決定性・ゴール判定・勝敗・パドル制限
// - lib/penalty.ts: 進行・早期決着・サドンデス・セーブ判定
// - lib/online/games/quizbattle.ts: 問題バンク増量分（84問・形式・重複なし）
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

async function loadQuizBattle() {
  const src = fs.readFileSync(path.join(libDir, "online", "games", "quizbattle.ts"), "utf8");
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const code = stripModuleSyntax(js) + "\nexport { QUIZ_BATTLE_QUESTIONS };\n";
  return import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
}

const air = await loadLib("airhockey.ts");
const pen = await loadLib("penalty.ts");
const qb = await loadQuizBattle();

// ---------------------------------------------------------------- airhockey

test("エアホッケー: 同じシード・同じ入力では完全に同じ進行になる", () => {
  let a = air.createAirHockeyGame(42, "normal");
  let b = air.createAirHockeyGame(42, "normal");
  for (let i = 0; i < 900; i++) {
    const input = { x: 200 + Math.sin(i * 0.05) * 120, y: 500 };
    a = air.stepAirHockey(a, input);
    b = air.stepAirHockey(b, input);
  }
  assert.deepEqual(a, b);
  assert.ok(a.step === 900 || a.status === "finished");
});

test("エアホッケー: プレイヤーパドルは自陣と盤内に収まる", () => {
  let s = air.createAirHockeyGame(7, "normal");
  for (let i = 0; i < 120; i++) {
    s = air.stepAirHockey(s, { x: -500, y: -500 });
  }
  assert.ok(s.player.x >= air.AIR_PADDLE_R - 1e-9);
  assert.ok(s.player.y >= air.AIR_FIELD_H / 2 + 4 - 1e-9);
  assert.ok(s.player.y <= air.AIR_FIELD_H - air.AIR_PADDLE_R + 1e-9);
});

test("エアホッケー: 上のゴールに入るとプレイヤーの得点、下は CPU の得点", () => {
  const base = air.createAirHockeyGame(3, "normal");
  const toTop = {
    ...base,
    serveTimer: 0,
    puck: { x: air.AIR_FIELD_W / 2, y: 30, vx: 0, vy: -700 },
  };
  let s = toTop;
  for (let i = 0; i < 30 && s.playerScore === 0; i++) s = air.stepAirHockey(s, null);
  assert.equal(s.playerScore, 1);
  assert.equal(s.lastScorer, "player");

  const toBottom = {
    ...base,
    serveTimer: 0,
    puck: { x: air.AIR_FIELD_W / 2, y: air.AIR_FIELD_H - 30, vx: 0, vy: 700 },
    player: { x: 40, y: air.AIR_FIELD_H - 40 },
  };
  let t = toBottom;
  for (let i = 0; i < 30 && t.cpuScore === 0; i++) t = air.stepAirHockey(t, { x: 40, y: air.AIR_FIELD_H - 40 });
  assert.equal(t.cpuScore, 1);
  assert.equal(t.lastScorer, "cpu");
});

test("エアホッケー: ゴール口の外では壁で跳ね返り得点にならない", () => {
  const base = air.createAirHockeyGame(5, "normal");
  let s = {
    ...base,
    serveTimer: 0,
    puck: { x: 30, y: 30, vx: 0, vy: -700 },
  };
  for (let i = 0; i < 20; i++) s = air.stepAirHockey(s, null);
  assert.equal(s.playerScore, 0);
  assert.equal(s.cpuScore, 0);
  assert.ok(s.puck.y >= air.AIR_PUCK_R - 1e-9);
});

test("エアホッケー: 7点先取で終了し、以降ステップしても変わらない", () => {
  const base = air.createAirHockeyGame(9, "easy");
  let s = {
    ...base,
    playerScore: air.AIR_WIN_SCORE - 1,
    serveTimer: 0,
    puck: { x: air.AIR_FIELD_W / 2, y: 30, vx: 0, vy: -700 },
  };
  for (let i = 0; i < 30 && s.status !== "finished"; i++) s = air.stepAirHockey(s, null);
  assert.equal(s.status, "finished");
  assert.equal(s.winner, "player");
  const after = air.stepAirHockey(s, null);
  assert.equal(after, s);
});

test("エアホッケー: 長時間プレーしてもパックが盤外に出ない", () => {
  let s = air.createAirHockeyGame(123, "hard");
  for (let i = 0; i < 60 * 60 && s.status === "playing"; i++) {
    s = air.stepAirHockey(s, { x: 200 + Math.sin(i * 0.021) * 160, y: 560 + Math.cos(i * 0.017) * 60 });
    assert.ok(s.puck.x >= air.AIR_PUCK_R - 1e-6 && s.puck.x <= air.AIR_FIELD_W - air.AIR_PUCK_R + 1e-6, `x=${s.puck.x}`);
  }
  assert.ok(s.step > 0);
});

// ---------------------------------------------------------------- penalty

/** 固定ゾーン列で最後まで進行させる（キッカー/キーパー共通で zone を返す）。 */
function playOut(seed, zoneFor) {
  let s = pen.createPenaltyGame(seed);
  let guard = 0;
  while (s.status === "playing" && guard++ < 40) {
    const zone = zoneFor(s);
    s = s.turn === "player" ? pen.playerShoot(s, zone) : pen.playerDive(s, zone);
  }
  return s;
}

test("PK戦: 同じシード・同じ選択では同じ結果になる", () => {
  const a = playOut(77, () => 4);
  const b = playOut(77, () => 4);
  assert.deepEqual(a.kicks, b.kicks);
  assert.equal(a.status, "finished");
});

test("PK戦: 手番違いと不正なゾーンは無効", () => {
  const s = pen.createPenaltyGame(1);
  assert.equal(pen.playerDive(s, 0), s); // 最初はプレイヤーのキック番
  assert.equal(pen.playerShoot(s, 6), s);
  assert.equal(pen.playerShoot(s, -1), s);
  assert.equal(pen.playerShoot(s, 1.5), s);
});

test("PK戦: キーパーのゾーンと一致したキックはセーブになる", () => {
  let found = null;
  for (let seed = 1; seed <= 300 && !found; seed++) {
    const s = pen.playerShoot(pen.createPenaltyGame(seed), 4);
    const kick = s.kicks[0];
    if (kick.outcome === "saved") found = kick;
  }
  assert.ok(found, "セーブが発生するシードが存在する");
  assert.equal(found.keeperZone, found.zone);
});

test("PK戦: 決着がつけば 10 本を待たずに早期終了するケースがある", () => {
  let early = null;
  for (let seed = 1; seed <= 400 && !early; seed++) {
    const s = playOut(seed, () => 4);
    if (s.status === "finished" && s.kicks.length < 10) early = s;
  }
  assert.ok(early, "早期決着するシードが存在する");
  assert.ok(early.winner === "player" || early.winner === "cpu");
  const loserGoals = early.winner === "player" ? early.cpuGoals : early.playerGoals;
  const loserTaken = pen.penaltyTaken(early, early.winner === "player" ? "cpu" : "player");
  const winnerGoals = early.winner === "player" ? early.playerGoals : early.cpuGoals;
  assert.ok(winnerGoals > loserGoals + (pen.PEN_ROUNDS - loserTaken));
});

test("PK戦: 5本で同点ならサドンデスに入り、最終的に決着する", () => {
  let sd = null;
  for (let seed = 1; seed <= 600 && !sd; seed++) {
    const s = playOut(seed, (st) => (st.kicks.length % 3 === 0 ? 0 : 4));
    if (s.suddenDeath) sd = s;
  }
  assert.ok(sd, "サドンデスに突入するシードが存在する");
  assert.equal(sd.status, "finished");
  assert.ok(sd.kicks.length > 10);
  assert.notEqual(sd.playerGoals, sd.cpuGoals);
  assert.equal(sd.winner, sd.playerGoals > sd.cpuGoals ? "player" : "cpu");
});

test("PK戦: ゴール数の集計がキック履歴と一致する", () => {
  const s = playOut(2024, (st) => st.kicks.length % 6);
  assert.equal(s.playerGoals, s.kicks.filter((k) => k.by === "player" && k.outcome === "goal").length);
  assert.equal(s.cpuGoals, s.kicks.filter((k) => k.by === "cpu" && k.outcome === "goal").length);
  // 交互に蹴っていること
  s.kicks.forEach((k, i) => assert.equal(k.by, i % 2 === 0 ? "player" : "cpu"));
});

// ---------------------------------------------------------------- quizbattle bank

test("クイズバトル: 問題バンクは98問・形式がそろい重複がない", () => {
  const qs = qb.QUIZ_BATTLE_QUESTIONS;
  assert.equal(qs.length, 98);
  const seen = new Set();
  const cats = new Set();
  for (const q of qs) {
    assert.ok(!seen.has(q.question), `重複: ${q.question}`);
    seen.add(q.question);
    cats.add(q.category);
    assert.equal(q.choices.length, 4);
    assert.equal(new Set(q.choices).size, 4, `選択肢の重複: ${q.question}`);
    assert.ok(Number.isInteger(q.answer) && q.answer >= 0 && q.answer < 4);
    assert.ok(q.choices[q.answer].length > 0);
  }
  for (const c of ["雑学", "科学", "歴史", "スポーツ", "アニメ・ゲーム"]) assert.ok(cats.has(c), c);
});

test("クイズバトル: 増量分の正解が正しい", () => {
  const byQuestion = new Map(qb.QUIZ_BATTLE_QUESTIONS.map((q) => [q.question, q.choices[q.answer]]));
  assert.equal(byQuestion.get("人類で初めて月面に着陸した宇宙船は？"), "アポロ11号");
  assert.equal(byQuestion.get("日本国憲法が施行されたのは何年？"), "1947年");
  assert.equal(byQuestion.get("空気の約78%を占める気体は？"), "窒素");
  assert.equal(byQuestion.get("フルマラソンの距離はおよそ何km？"), "約42km");
  assert.equal(byQuestion.get("『Minecraft』で、近づくと爆発する緑色のモンスターは？"), "クリーパー");
  assert.equal(byQuestion.get("2024年に発行された新千円札の肖像は誰？"), "北里柴三郎");
});
