// A32フェーズの新規2本＋増量のロジック検証。
// - lib/missile.ts: 固定ステップの決定性・迎撃での破壊・都市全滅での終了・ウェーブ遷移
// - lib/dragrace.ts: 反応＋シフト誤差のタイムモデル・フライング・自動遅れシフト
// - lib/online/games/shiritori.ts: 単語バンク増量（第2弾）後の妥当性（1000語以上・重複なし・形式）
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

const mi = await loadLib("missile.ts");
const dr = await loadLib("dragrace.ts");
const shi = await loadOnline("shiritori.ts", [
  "SHIRITORI_WORDS",
  "isValidWordForm",
  "isBankWord",
  "shiritoriTail",
]);

// ---- ミサイル防衛 ----

test("ミサイル防衛: 同じシード・同じ操作では完全に同じ展開になる", () => {
  let a = mi.createMissileGame(42);
  let b = mi.createMissileGame(42);
  for (let i = 0; i < 120; i++) {
    a = mi.stepMissile(a);
    b = mi.stepMissile(b);
  }
  a = mi.fireAt(a, 500, 200);
  b = mi.fireAt(b, 500, 200);
  for (let i = 0; i < 120; i++) {
    a = mi.stepMissile(a);
    b = mi.stepMissile(b);
  }
  assert.deepEqual(a, b);
  assert.ok(a.enemies.length + a.kills + a.spawnQueue.length >= 0);
});

test("ミサイル防衛: ウェーブが進むと敵ミサイルが出現する", () => {
  let s = mi.createMissileGame(7);
  let sawEnemy = false;
  for (let i = 0; i < 200 && !sawEnemy; i++) {
    s = mi.stepMissile(s);
    if (s.enemies.length > 0) sawEnemy = true;
  }
  assert.ok(sawEnemy);
  assert.equal(s.phase, "playing");
  assert.equal(mi.aliveCities(s), 6);
});

test("ミサイル防衛: 迎撃弾は残弾を消費し、爆風で敵を破壊できる", () => {
  let s = mi.createMissileGame(42);
  const before = mi.totalAmmo(s);
  s = mi.fireAt(s, 500, 200);
  assert.equal(mi.totalAmmo(s), before - 1);
  assert.equal(s.interceptors.length, 1);
  // 不正な座標では撃てない（状態不変）
  assert.equal(mi.fireAt(s, Number.NaN, 100), s);

  // 敵の未来位置を狙って撃ち続けると、やがて破壊できる
  let t = mi.createMissileGame(42);
  for (let i = 0; i < 60; i++) t = mi.stepMissile(t);
  assert.ok(t.enemies.length > 0, "敵が出現している");
  const target = t.enemies[0];
  const ahead = mi.enemyPosition({
    ...target,
    elapsedMs: target.elapsedMs + 1200,
  });
  t = mi.fireAt(t, ahead.x, ahead.y);
  for (let i = 0; i < 100; i++) t = mi.stepMissile(t);
  assert.ok(t.kills >= 1, `破壊できていない: kills=${t.kills}`);
  assert.ok(t.score >= mi.SCORE_PER_KILL);
});

test("ミサイル防衛: 爆風の半径は成長→持続→縮小する", () => {
  assert.equal(mi.blastRadius(0), 0);
  assert.ok(mi.blastRadius(3) < mi.blastRadius(6));
  assert.equal(mi.blastRadius(6), mi.BLAST_MAX_RADIUS);
  assert.equal(mi.blastRadius(14), mi.BLAST_MAX_RADIUS);
  assert.ok(mi.blastRadius(17) < mi.BLAST_MAX_RADIUS);
  assert.equal(mi.blastRadius(mi.BLAST_TOTAL_STEPS), 0);
});

test("ミサイル防衛: 防衛しなければウェーブが切り替わり、やがて都市全滅で終了する", () => {
  let s = mi.createMissileGame(3);
  let sawWaveClear = false;
  let sawWave2FullAmmo = false;
  for (let i = 0; i < 30000 && s.phase !== "over"; i++) {
    s = mi.stepMissile(s);
    if (s.phase === "waveclear") sawWaveClear = true;
    if (s.wave === 2 && mi.totalAmmo(s) === 30) sawWave2FullAmmo = true;
  }
  assert.ok(sawWaveClear, "ウェーブクリアを経由する");
  assert.ok(sawWave2FullAmmo, "ウェーブ開始時に残弾が補充される");
  assert.equal(s.phase, "over");
  assert.equal(mi.aliveCities(s), 0);
  // 終了後はステップしても変化しない
  assert.equal(mi.stepMissile(s), s);
});

// ---- ドラッグレース ----

test("ドラッグレース: 同じシードでは CPU の内容まで同じになる", () => {
  const a = dr.createDragRace(99, "normal");
  const b = dr.createDragRace(99, "normal");
  assert.deepEqual(a, b);
  assert.ok(a.waitMs >= dr.WAIT_MIN_MS && a.waitMs <= dr.WAIT_MAX_MS);
  assert.equal(a.cpuShiftErrors.length, dr.GEAR_COUNT - 1);
  const expectedCpu =
    a.cpuReactionMs +
    dr.IDEAL_RUN_MS +
    a.cpuShiftErrors.reduce((sum, e) => sum + dr.shiftPenaltyMs(e), 0);
  assert.equal(a.cpuTotalMs, expectedCpu);
  // 難易度が高いほど CPU は速い傾向（生成範囲の上限で確認）
  const easy = dr.createDragRace(5, "easy");
  const hard = dr.createDragRace(5, "hard");
  assert.ok(easy.cpuReactionMs >= 400 && hard.cpuReactionMs <= 340 + 145);
});

test("ドラッグレース: シフトペナルティは完璧ゾーンで0、大きく外すほど増える", () => {
  assert.equal(dr.shiftPenaltyMs(0), 0);
  assert.equal(dr.shiftPenaltyMs(dr.PERFECT_WINDOW_MS), 0);
  assert.equal(dr.shiftPenaltyMs(-dr.PERFECT_WINDOW_MS), 0);
  assert.ok(dr.shiftPenaltyMs(200) > 0);
  assert.ok(dr.shiftPenaltyMs(600) > dr.shiftPenaltyMs(200));
  assert.equal(dr.shiftQuality(0), "perfect");
  assert.equal(dr.shiftQuality(600), "bad");
});

test("ドラッグレース: フライングは失格、正常な流れでは最適シフトで反応分だけのタイムになる", () => {
  let s = dr.createDragRace(11, "normal");
  s = dr.beginCountdown(s);
  assert.equal(s.phase, "waiting");
  const fouled = dr.foulStart(s);
  assert.equal(fouled.phase, "fouled");
  assert.equal(fouled.winner, "cpu");

  // 不正な反応値は無効
  assert.equal(dr.launch(s, -1), s);
  assert.equal(dr.launch(s, Number.NaN), s);

  s = dr.launch(s, 250);
  assert.equal(s.phase, "running");
  for (const t of dr.OPTIMAL_SHIFT_MS) s = dr.shift(s, t);
  assert.equal(s.shiftsDone, dr.GEAR_COUNT - 1);
  assert.equal(s.playerTotalMs, 250 + dr.IDEAL_RUN_MS);
  s = dr.advanceRace(s, 20000);
  assert.equal(s.phase, "finished");
  assert.equal(
    s.winner,
    s.playerTotalMs < s.cpuTotalMs ? "player" : s.playerTotalMs > s.cpuTotalMs ? "cpu" : "draw",
  );
});

test("ドラッグレース: シフトを放置すると自動で遅れシフトになり、ペナルティが付く", () => {
  let s = dr.createDragRace(21, "easy");
  s = dr.beginCountdown(s);
  s = dr.launch(s, 300);
  s = dr.advanceRace(s, 30000);
  assert.equal(s.shiftsDone, dr.GEAR_COUNT - 1);
  for (const e of s.shiftErrors) assert.equal(e, dr.MAX_SHIFT_ERROR_MS);
  assert.equal(
    s.playerTotalMs,
    300 + dr.IDEAL_RUN_MS + (dr.GEAR_COUNT - 1) * dr.shiftPenaltyMs(dr.MAX_SHIFT_ERROR_MS),
  );
  assert.equal(s.phase, "finished");
});

test("ドラッグレース: RPM と進行度は範囲内に収まる", () => {
  let s = dr.createDragRace(31, "hard");
  s = dr.beginCountdown(s);
  s = dr.launch(s, 200);
  assert.equal(dr.rpmFraction(s, 0), 0);
  const mid = dr.rpmFraction(s, dr.OPTIMAL_SHIFT_MS[0] - 10);
  assert.ok(mid > 0.9 && mid <= 1);
  assert.equal(dr.playerProgress(s, 0), 0);
  assert.ok(dr.cpuProgress(s, 100000) <= 1);
  assert.ok(dr.cpuProgress(s, 100000) > 0.99);
});

// ---- しりとり増量（第2弾） ----

test("しりとり: バンクが1000語以上で、重複がなく全て有効な形式", () => {
  const words = shi.SHIRITORI_WORDS;
  assert.ok(words.length >= 1000, `単語数が足りない: ${words.length}`);
  assert.equal(new Set(words).size, words.length);
  for (const w of words) {
    assert.ok(shi.isValidWordForm(w), `形式が不正: ${w}`);
  }
});

test("しりとり: 第2弾で追加した代表語がバンクにあり、ン終わりの脱落語も含まれる", () => {
  for (const w of ["モルモット", "オカピ", "クロワッサン", "シンカンセン", "マージャン", "リンゴジュース"]) {
    assert.ok(shi.isBankWord(w), `追加語が見つからない: ${w}`);
  }
  // 既存方針どおり「ン」で終わる語（出すと脱落）も収録されている
  assert.ok(shi.SHIRITORI_WORDS.some((w) => w.endsWith("ン")));
  assert.equal(shi.shiritoriTail("シンカンセン"), "ン");
});
