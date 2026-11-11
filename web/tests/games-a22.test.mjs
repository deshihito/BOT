// A22フェーズ新規3本のロジック検証（lib のみ、UI 非依存）。
// - lib/skyscrapers.ts: 見える数の計算・生成妥当性・決定性・検証・完成
// - lib/slant.ts: 生成妥当性（解がルールを満たす）・決定性・タップ循環・数字条件・ループ検出
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

const sky = await loadLib("skyscrapers.ts");
const sl = await loadLib("slant.ts");
const sb = await loadOnline("stopbattle.ts", [
  "gameModule",
  "SB_TOTAL_ROUNDS",
  "SB_TARGETS_MS",
  "sbScoreForError",
  "sbTargetForRound",
]);

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

// ---- ビルディング ----

test("ビルディング: 見える数は最大値の更新回数", () => {
  assert.equal(sky.visibleCount([1, 2, 3, 4]), 4);
  assert.equal(sky.visibleCount([4, 1, 2, 3]), 1);
  assert.equal(sky.visibleCount([2, 3, 1, 4]), 3);
  assert.equal(sky.visibleCount([3, 1, 4, 2]), 2);
  assert.equal(sky.visibleCount([2, 1, 4, 3]), 2);
  assert.equal(sky.visibleCount([5]), 1);
});

test("ビルディング: 解はラテン方陣で、外周ヒントが解と一致する", () => {
  for (const size of [4, 5]) {
    for (const seed of [1, 42, 777]) {
      const g = sky.createSkyscrapersGame(size, seed);
      assert.equal(g.solution.length, size * size);
      const expected = Array.from({ length: size }, (_, i) => i + 1).join(",");
      for (let r = 0; r < size; r++) {
        const row = g.solution.slice(r * size, r * size + size).sort((a, b) => a - b).join(",");
        assert.equal(row, expected, `size=${size} seed=${seed} row=${r}`);
      }
      for (let c = 0; c < size; c++) {
        const col = Array.from({ length: size }, (_, r) => g.solution[r * size + c])
          .sort((a, b) => a - b)
          .join(",");
        assert.equal(col, expected, `size=${size} seed=${seed} col=${c}`);
        const colRaw = Array.from({ length: size }, (_, r) => g.solution[r * size + c]);
        assert.equal(g.clues.top[c], sky.visibleCount(colRaw));
        assert.equal(g.clues.bottom[c], sky.visibleCount([...colRaw].reverse()));
      }
      for (let r = 0; r < size; r++) {
        const rowRaw = g.solution.slice(r * size, r * size + size);
        assert.equal(g.clues.left[r], sky.visibleCount(rowRaw));
        assert.equal(g.clues.right[r], sky.visibleCount([...rowRaw].reverse()));
      }
      assert.ok(g.values.every((v) => v === 0));
    }
  }
});

test("ビルディング: 同じシードでは同じ問題になり、解を入れると勝ち・元状態は不変", () => {
  const a = sky.createSkyscrapersGame(4, 42);
  const b = sky.createSkyscrapersGame(4, 42);
  assert.deepEqual(a.solution, b.solution);
  assert.deepEqual(a.clues, b.clues);

  let s = a;
  for (let i = 0; i < a.solution.length; i++) {
    s = sky.setSkyValue(s, i, a.solution[i]);
  }
  assert.equal(s.status, "won");
  assert.equal(sky.checkSky(s).complete, true);
  assert.ok(a.values.every((v) => v === 0));
  assert.equal(a.status, "playing");
});

test("ビルディング: ヒントを隠しても解で完成し、隠れた分だけ 0 になる", () => {
  const g = sky.createSkyscrapersGame(5, 99, 7);
  const all = [...g.clues.top, ...g.clues.bottom, ...g.clues.left, ...g.clues.right];
  assert.equal(all.filter((v) => v === 0).length, 7);
  const solved = { ...g, values: [...g.solution] };
  assert.equal(sky.checkSky(solved).complete, true);
});

test("ビルディング: 行の重複とヒント不一致を検出し、不正な入力は無視する", () => {
  const g = sky.createSkyscrapersGame(4, 7);
  let s = sky.setSkyValue(g, 0, 1);
  s = sky.setSkyValue(s, 1, 1);
  assert.ok(sky.skyViolations(s).some((v) => v.type === "rowDup"));

  // 解で埋めた盤面に、わざと違うヒントを与えると clue 違反になる。
  const col0 = Array.from({ length: 4 }, (_, r) => g.solution[r * 4]);
  const wrong = (sky.visibleCount(col0) % 4) + 1;
  const rigged = {
    ...g,
    values: [...g.solution],
    clues: { ...g.clues, top: [wrong, ...g.clues.top.slice(1)] },
  };
  assert.ok(sky.skyViolations(rigged).some((v) => v.type === "clue"));
  assert.equal(sky.checkSky(rigged).complete, false);

  assert.equal(sky.setSkyValue(g, 0, 5), g); // 4x4 に 5 は不可
  assert.equal(sky.setSkyValue(g, -1, 1), g);
  assert.equal(sky.setSkyValue(g, 0, 0), g); // 変化なし
});

// ---- スラント ----

test("スラント: 解はルールを満たし（数字・ループなし）、与え数字は解と一致する", () => {
  for (const seed of [3, 42, 1234, 98765]) {
    const g = sl.createSlantGame(seed);
    assert.equal(g.solution.length, 25);
    assert.ok(g.solution.every((m) => m === 1 || m === 2));
    // 解をそのまま盤面にした状態は完成扱いになる（ルール検証ベース）。
    const solved = { ...g, board: [...g.solution] };
    const check = sl.checkSlant(solved);
    assert.deepEqual(check.violations, [], `seed=${seed}`);
    assert.equal(check.complete, true);
    // 表示されている数字は解の端点数と一致する。
    const counts = sl.slantPointCounts(g.width, g.height, g.solution);
    g.clues.forEach((clue, p) => {
      if (clue !== null) assert.equal(clue, counts[p], `seed=${seed} point=${p}`);
    });
    // 0 と 4 の点は必ず表示される。
    counts.forEach((count, p) => {
      if (count === 0 || count === 4) assert.equal(g.clues[p], count);
    });
  }
});

test("スラント: 同じシードでは同じ問題になり、タップで循環し元状態は不変", () => {
  const a = sl.createSlantGame(42);
  const b = sl.createSlantGame(42);
  assert.deepEqual(a.solution, b.solution);
  assert.deepEqual(a.clues, b.clues);

  let s = sl.cycleSlantCell(a, 0);
  assert.equal(s.board[0], 1);
  s = sl.cycleSlantCell(s, 0);
  assert.equal(s.board[0], 2);
  s = sl.cycleSlantCell(s, 0);
  assert.equal(s.board[0], 0);
  assert.equal(a.board[0], 0); // 元状態は不変
  assert.equal(sl.cycleSlantCell(a, -1), a);
  assert.equal(sl.cycleSlantCell(a, 25), a);
});

test("スラント: 数字 0 の点に斜線が触れると違反になる", () => {
  const g = sl.createSlantGame(11);
  const counts = sl.slantPointCounts(g.width, g.height, g.solution);
  // 解で 0 の点（= 表示も 0）を探し、隣接マスからその点に触れる斜線を置く。
  let target = -1;
  let cell = -1;
  let mark = 0;
  for (let p = 0; p < counts.length && target < 0; p++) {
    if (counts[p] !== 0) continue;
    const pr = Math.floor(p / (g.width + 1));
    const pc = p % (g.width + 1);
    const around = [
      [pr - 1, pc - 1],
      [pr - 1, pc],
      [pr, pc - 1],
      [pr, pc],
    ];
    for (const [r, c] of around) {
      if (r < 0 || r >= g.height || c < 0 || c >= g.width) continue;
      const idx = r * g.width + c;
      for (const m of [1, 2]) {
        const ends = sl.slantEndpoints(g.width, g.height, idx, m);
        if (ends && (ends[0] === p || ends[1] === p)) {
          target = p;
          cell = idx;
          mark = m;
          break;
        }
      }
      if (target >= 0) break;
    }
  }
  assert.ok(target >= 0, "数字 0 の点が見つかるはず");
  const s = sl.setSlantCell(g, cell, mark);
  const vs = sl.slantViolations(s);
  assert.ok(vs.some((v) => v.type === "point" && v.points.includes(target)));
});

test("スラント: 4本の斜線で作る菱形の輪をループとして検出する", () => {
  const g = sl.createSlantGame(5);
  // 点 (1,1) を囲む菱形: (0,0)=/ 、(0,1)=\ 、(1,0)=\ 、(1,1)=/
  const board = new Array(25).fill(0);
  board[0] = 1;
  board[1] = 2;
  board[5] = 2;
  board[6] = 1;
  const vs = sl.slantViolations({ ...g, board });
  const loop = vs.find((v) => v.type === "loop");
  assert.ok(loop, "ループが検出されるはず");
  assert.ok(loop.cells.length >= 1);
  assert.ok(loop.cells.every((i) => [0, 1, 5, 6].includes(i)));
});

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
