// 第3波（反射/エイム系）のロジック検証（lib のみ、UI 非依存）。
// - lib/reaction.ts: 待機スケジュール・状態遷移・フライング・集計・評価
// - lib/aim.ts: 的スケジュール・ヒット判定・得点・命中率
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

const reaction = await loadLib("reaction.ts");
const aim = await loadLib("aim.ts");

// ---------------- reaction ----------------

test("反応速度: 待機スケジュールは決定的で全て 2000〜5000ms の範囲", () => {
  const a = reaction.createWaitSchedule(42);
  const b = reaction.createWaitSchedule(42);
  assert.deepEqual(a, b);
  assert.equal(a.length, reaction.REACTION_WAITS_PER_SESSION);
  for (const w of a) {
    assert.ok(w >= reaction.REACTION_MIN_WAIT_MS && w <= reaction.REACTION_MAX_WAIT_MS, `wait ${w}`);
  }
  const c = reaction.createWaitSchedule(43);
  assert.notDeepEqual(a, c);
});

test("反応速度: waitMsFromRandom は境界をクランプする", () => {
  assert.equal(reaction.waitMsFromRandom(0), 2000);
  assert.equal(reaction.waitMsFromRandom(1), 5000);
  assert.equal(reaction.waitMsFromRandom(-3), 2000);
  assert.equal(reaction.waitMsFromRandom(9), 5000);
  assert.equal(reaction.waitMsFromRandom(0.5), 3500);
});

test("反応速度: セッション初期状態は idle・5ラウンド・結果なし", () => {
  const s = reaction.createReactionSession(7);
  assert.equal(s.phase, "idle");
  assert.equal(s.rounds, 5);
  assert.equal(s.round, 0);
  assert.deepEqual(s.results, []);
  assert.equal(s.fouls, 0);
});

test("反応速度: startRound で待機に入り、スケジュールの待機時間がセットされる", () => {
  const s0 = reaction.createReactionSession(11);
  const s1 = reaction.startRound(s0);
  assert.equal(s1.phase, "waiting");
  assert.equal(s1.currentWaitMs, s0.waits[0]);
  assert.equal(s1.waitIndex, 1);
  // waiting のまま再スタートしても変わらない
  assert.equal(reaction.startRound(s1), s1);
  // 元の状態は変わらない
  assert.equal(s0.phase, "idle");
});

test("反応速度: 合図前のタップはフライングで、ラウンドは進まない", () => {
  let s = reaction.startRound(reaction.createReactionSession(3));
  s = reaction.tapTooEarly(s);
  assert.equal(s.phase, "tooSoon");
  assert.equal(s.fouls, 1);
  assert.equal(s.round, 0);
  assert.deepEqual(s.results, []);
  // tooSoon からは再挑戦でき、新しい待機時間が消費される
  const retry = reaction.startRound(s);
  assert.equal(retry.phase, "waiting");
  assert.equal(retry.waitIndex, 2);
  // ready でない状態への tapTooEarly は無効
  assert.equal(reaction.tapTooEarly(s), s);
});

test("反応速度: signalReady は待機中のみ効き、recordTap で結果が記録される", () => {
  let s = reaction.createReactionSession(5);
  assert.equal(reaction.signalReady(s), s); // idle では無効
  s = reaction.startRound(s);
  s = reaction.signalReady(s);
  assert.equal(s.phase, "ready");
  const after = reaction.recordTap(s, 231.6);
  assert.equal(after.phase, "idle");
  assert.equal(after.round, 1);
  assert.deepEqual(after.results, [232]); // 丸められる
});

test("反応速度: recordTap の不正な値は無効（負・NaN・異常に大きい）", () => {
  let s = reaction.signalReady(reaction.startRound(reaction.createReactionSession(9)));
  assert.equal(reaction.recordTap(s, -1), s);
  assert.equal(reaction.recordTap(s, Number.NaN), s);
  assert.equal(reaction.recordTap(s, 120_000), s);
  // waiting 中の recordTap も無効
  const w = reaction.startRound(reaction.createReactionSession(9));
  assert.equal(reaction.recordTap(w, 200), w);
});

test("反応速度: 5回記録すると done になり、それ以上は進まない", () => {
  let s = reaction.createReactionSession(21, 5);
  for (let i = 0; i < 5; i++) {
    s = reaction.startRound(s);
    assert.equal(s.phase, "waiting");
    s = reaction.signalReady(s);
    s = reaction.recordTap(s, 200 + i * 10);
  }
  assert.equal(s.phase, "done");
  assert.equal(s.round, 5);
  assert.deepEqual(s.results, [200, 210, 220, 230, 240]);
  assert.equal(reaction.startRound(s), s);
});

test("反応速度: 集計は平均・最速・最遅を返し、空なら全て 0", () => {
  const sum = reaction.summarizeResults([200, 300, 250]);
  assert.equal(sum.count, 3);
  assert.equal(sum.averageMs, 250);
  assert.equal(sum.bestMs, 200);
  assert.equal(sum.worstMs, 300);
  assert.deepEqual(reaction.summarizeResults([]), { count: 0, averageMs: 0, bestMs: 0, worstMs: 0 });
});

test("反応速度: 評価ラベルは速いほど上になり、未計測を区別する", () => {
  assert.equal(reaction.gradeForAverage(180), "神速");
  assert.equal(reaction.gradeForAverage(240), "とても速い");
  assert.equal(reaction.gradeForAverage(300), "速い");
  assert.equal(reaction.gradeForAverage(400), "ふつう");
  assert.equal(reaction.gradeForAverage(600), "ゆっくり");
  assert.equal(reaction.gradeForAverage(0), "未計測");
});

test("反応速度: 状態は JSON 化できる", () => {
  const s = reaction.startRound(reaction.createReactionSession(99));
  assert.deepEqual(JSON.parse(JSON.stringify(s)), s);
});

// ---------------- aim ----------------

test("エイム: スケジュールは決定的で、出現時刻が単調増加し30秒以内", () => {
  const a = aim.createAimSchedule(42);
  const b = aim.createAimSchedule(42);
  assert.deepEqual(a, b);
  assert.ok(a.length >= 15, `targets ${a.length}`);
  for (let i = 1; i < a.length; i++) assert.ok(a[i].spawnAtMs > a[i - 1].spawnAtMs);
  for (const t of a) {
    assert.ok(t.spawnAtMs >= 0 && t.spawnAtMs < aim.AIM_GAME_MS);
    assert.ok(t.durationMs > 0);
    assert.equal(t.id, a.indexOf(t));
  }
});

test("エイム: 的はエリア内に収まり、半径と得点が連動する", () => {
  const schedule = aim.createAimSchedule(7);
  for (const t of schedule) {
    assert.ok(t.x - t.radius >= -0.01 && t.x + t.radius <= 100.01, `x ${t.x} r ${t.radius}`);
    assert.ok(t.y - t.radius >= -0.01 && t.y + t.radius <= 100.01, `y ${t.y} r ${t.radius}`);
    assert.ok(t.radius >= aim.AIM_MIN_RADIUS - 0.01 && t.radius <= aim.AIM_MAX_RADIUS + 0.01);
    assert.equal(t.points, aim.pointsForRadius(t.radius));
    assert.ok(t.points === 10 || t.points === 20 || t.points === 30);
  }
});

test("エイム: 終盤ほど的が小さく、出現間隔と継続時間が短い", () => {
  assert.ok(aim.aimRadiusAt(28_000) < aim.aimRadiusAt(0));
  assert.ok(aim.aimSpawnIntervalMs(28_000) < aim.aimSpawnIntervalMs(0));
  assert.ok(aim.aimDurationMs(28_000) < aim.aimDurationMs(0));
  const schedule = aim.createAimSchedule(13);
  assert.ok(schedule[schedule.length - 1].radius <= schedule[0].radius);
});

test("エイム: 連続する的は位置が離れている（中心間 15 以上）", () => {
  const schedule = aim.createAimSchedule(123);
  for (let i = 1; i < schedule.length; i++) {
    const dx = schedule[i].x - schedule[i - 1].x;
    const dy = schedule[i].y - schedule[i - 1].y;
    assert.ok(Math.hypot(dx, dy) >= 15, `dist at ${i}`);
  }
});

test("エイム: ヒット判定は中心と円内で true、円外と不正値で false", () => {
  const target = { id: 0, x: 50, y: 50, radius: 5, spawnAtMs: 0, durationMs: 1000, points: 10 };
  assert.equal(aim.hitTest(target, 50, 50), true);
  assert.equal(aim.hitTest(target, 54, 50), true);
  assert.equal(aim.hitTest(target, 55, 50), true); // 境界上
  assert.equal(aim.hitTest(target, 56, 50), false);
  assert.equal(aim.hitTest(target, 0, 0), false);
  assert.equal(aim.hitTest(target, Number.NaN, 50), false);
});

test("エイム: 得点は小さい的ほど高く、速く当てるとボーナスが付く", () => {
  assert.ok(aim.pointsForRadius(3.5) > aim.pointsForRadius(5.5));
  const target = { id: 0, x: 50, y: 50, radius: 5.5, spawnAtMs: 1000, durationMs: 1000, points: 10 };
  const fast = aim.pointsForHit(target, 1000); // 出現直後
  const slow = aim.pointsForHit(target, 1999); // 消える直前
  assert.ok(fast > slow);
  assert.equal(fast, 20); // 10 + ボーナス最大10
  assert.ok(slow >= 10 && slow <= 11);
});

test("エイム: 命中率は 0〜1 で、試射ゼロなら 0", () => {
  assert.equal(aim.accuracyFor(0, 0), 0);
  assert.equal(aim.accuracyFor(3, 4), 0.75);
  assert.equal(aim.accuracyFor(5, 5), 1);
  assert.equal(aim.accuracyFor(9, 3), 1); // クランプ
});

test("エイム: activeTargetsAt は出現中だけを返し、ヒット済みを除く", () => {
  const schedule = aim.createAimSchedule(31);
  const first = schedule[0];
  const atSpawn = aim.activeTargetsAt(schedule, first.spawnAtMs + 1, new Set());
  assert.ok(atSpawn.some((t) => t.id === first.id));
  const hit = aim.activeTargetsAt(schedule, first.spawnAtMs + 1, new Set([first.id]));
  assert.ok(!hit.some((t) => t.id === first.id));
  const before = aim.activeTargetsAt(schedule, 0, new Set());
  assert.equal(before.length, 0);
});

test("エイム: 的は JSON 化できる", () => {
  const schedule = aim.createAimSchedule(77);
  assert.deepEqual(JSON.parse(JSON.stringify(schedule)), schedule);
});
