// A22フェーズ新規3本のロジック検証（lib のみ、UI 非依存）。
// - lib/online/games/stopbattle.ts: 採点式・秘匿・締切・全ラウンド完走・退出
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

const sb = await loadOnline("stopbattle.ts", [ "gameModule", "SB_TOTAL_ROUNDS", "SB_TARGETS_MS", "sbScoreForError", "sbTargetForRound", ]);

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

// ---- ストップウォッチ対戦 ----

const PLAYERS2 = [
  { seat: 0, name: "A" },
  { seat: 1, name: "B" },
];

/** seat の記録が目標より error 分だけずれるよう開始時刻を仕掛けて止める。 */
function stopWithError(mod, state, seat, errorMs) {
  const target = sb.sbTargetForRound(state.round);
  const rigged = {
    ...state,
    roundStartedAt: Date.now() - (target - errorMs),
    roundEndsAt: Date.now() + 60000,
  };
  return mod.applyAction(rigged, seat, { type: "stop" }, makeRng(1));
}

test("ストップウォッチ対戦: 採点式は誤差0.1秒ごとに1点減点・最低10点", () => {
  assert.equal(sb.sbScoreForError(0), 100);
  assert.equal(sb.sbScoreForError(99), 100);
  assert.equal(sb.sbScoreForError(100), 99);
  assert.equal(sb.sbScoreForError(550), 95);
  assert.equal(sb.sbScoreForError(10000), 10);
  assert.equal(sb.sbScoreForError(999999), 10);
  assert.equal(sb.sbTargetForRound(0), sb.SB_TARGETS_MS[0]);
  assert.equal(sb.SB_TOTAL_ROUNDS, sb.SB_TARGETS_MS.length);
});

test("ストップウォッチ対戦: 記録は締切まで秘匿され、誤差の小さい方が得点する", () => {
  const mod = sb.gameModule;
  let s = mod.createState(PLAYERS2, makeRng(42), {});
  assert.equal(mod.phaseOf(s), "counting");

  s = stopWithError(mod, s, 0, 550);
  // B から見て A の記録は見えない（止めたかどうかだけ）。
  const viewB = mod.viewFor(s, 1);
  const playerA = viewB.players.find((p) => p.seat === 0);
  assert.equal(playerA.stopped, true);
  assert.ok(!("elapsedMs" in playerA));
  // 自分の記録は自分だけ見える。
  const viewA = mod.viewFor(s, 0);
  assert.ok(typeof viewA.you.yourElapsedMs === "number");
  assert.ok(Math.abs(viewA.you.yourElapsedMs - (sb.sbTargetForRound(0) - 550)) < 100);

  s = stopWithError(mod, s, 1, 4050);
  // 全員が止めたので即締切 → reveal。
  assert.equal(mod.phaseOf(s), "reveal");
  const reveal = mod.viewFor(s, 0);
  const entryA = reveal.players.find((p) => p.seat === 0);
  const entryB = reveal.players.find((p) => p.seat === 1);
  assert.equal(entryA.winner, true);
  assert.equal(entryA.gained, 95); // 誤差 550ms → 100 - 5
  assert.ok(Math.abs(entryA.errorMs - 550) < 100);
  assert.equal(entryB.winner, false);
  assert.equal(entryB.gained, 0);
  assert.ok(Math.abs(entryB.errorMs - 4050) < 100);
  assert.equal(reveal.players.find((p) => p.seat === 0).score, 95);
});

test("ストップウォッチ対戦: 締切を過ぎると未送信のまま締め切られ、得点しない", () => {
  const mod = sb.gameModule;
  let s = mod.createState(PLAYERS2, makeRng(7), {});
  // 締切前は同一参照のまま。
  assert.equal(mod.tick(s, s.roundEndsAt - 1), s);
  s = mod.tick(s, s.roundEndsAt);
  assert.equal(mod.phaseOf(s), "reveal");
  const view = mod.viewFor(s, 0);
  for (const p of view.players) {
    assert.equal(p.elapsedMs, null);
    assert.equal(p.errorMs, null);
    assert.equal(p.gained, 0);
    assert.equal(p.winner, false);
  }
  // reveal が終わると次のラウンドの counting へ。
  s = mod.tick(s, s.revealEndsAt);
  assert.equal(mod.phaseOf(s), "counting");
  assert.equal(s.round, 1);
});

test("ストップウォッチ対戦: 5ラウンド進めると終了し順位が付く", () => {
  const mod = sb.gameModule;
  let s = mod.createState(PLAYERS2, makeRng(23), {});
  for (let round = 0; round < sb.SB_TOTAL_ROUNDS; round++) {
    assert.equal(mod.phaseOf(s), "counting");
    s = stopWithError(mod, s, 0, 550);
    s = stopWithError(mod, s, 1, 4050);
    assert.equal(mod.phaseOf(s), "reveal");
    s = mod.tick(s, s.revealEndsAt);
  }
  assert.equal(mod.isFinished(s), true);
  const view = mod.viewFor(s, 0);
  assert.equal(view.standings.find((x) => x.seat === 0).rank, 1);
  assert.equal(view.standings.find((x) => x.seat === 0).score, 95 * sb.SB_TOTAL_ROUNDS);
  assert.equal(view.standings.find((x) => x.seat === 1).rank, 2);
  assert.equal(view.standings.find((x) => x.seat === 1).score, 0);
});

test("ストップウォッチ対戦: 退出は脱落扱いで記録が取り消され、残りだけで締切できる", () => {
  const mod = sb.gameModule;
  const players3 = [...PLAYERS2, { seat: 2, name: "C" }];
  let s = mod.createState(players3, makeRng(29), {});
  s = stopWithError(mod, s, 1, 550);
  s = mod.onPlayerLeft(s, 1);
  assert.ok(s.leftSeats.includes(1));
  assert.ok(!s.stops.some((x) => x.seat === 1));
  assert.equal(mod.viewFor(s, 0).players.find((p) => p.seat === 1).left, true);
  s = stopWithError(mod, s, 0, 550);
  s = stopWithError(mod, s, 2, 4050);
  assert.equal(mod.phaseOf(s), "reveal");
  const view = mod.viewFor(s, 0);
  const entryB = view.players.find((p) => p.seat === 1);
  assert.equal(entryB.elapsedMs, null); // 退出者は未送信扱い
  assert.equal(entryB.gained, 0);
  assert.equal(view.players.find((p) => p.seat === 0).winner, true);
});

test("ストップウォッチ対戦: parseAction の形式検証と人数の検証", () => {
  const mod = sb.gameModule;
  assert.deepEqual(mod.parseAction({ type: "stop" }), { type: "stop" });
  assert.equal(mod.parseAction({ type: "answer", value: 1 }), null);
  assert.equal(mod.parseAction({}), null);
  assert.equal(mod.parseAction(null), null);
  assert.equal(mod.parseAction("stop"), null);

  assert.throws(() => mod.createState([{ seat: 0, name: "A" }], makeRng(1), {}));
  assert.throws(() =>
    mod.createState(
      Array.from({ length: 9 }, (_, i) => ({ seat: i, name: `P${i}` })),
      makeRng(1),
      {},
    ),
  );
  // 二重ストップはできない。
  let s = mod.createState(PLAYERS2, makeRng(31), {});
  s = mod.applyAction(s, 0, { type: "stop" }, makeRng(1));
  assert.throws(() => mod.applyAction(s, 0, { type: "stop" }, makeRng(1)));
  // reveal 中は止められない。
  s = mod.applyAction(s, 1, { type: "stop" }, makeRng(1));
  assert.equal(mod.phaseOf(s), "reveal");
  assert.throws(() => mod.applyAction(s, 0, { type: "stop" }, makeRng(1)));
});
