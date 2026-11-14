// A13フェーズの新規4本のロジック検証。
// - lib/laser.ts: 反射規則・光路シミュレーション・生成パズルの可解性（全探索）
// - lib/online/games/countdown.ts: 式評価の規則・秘匿・採点（完全一致ボーナス/先着）・完走
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

const laser = await loadLib("laser.ts");
const cd = await loadOnline("countdown.ts", [ "gameModule", "evaluateCountdown", "CD_TOTAL_ROUNDS", "CD_POINTS_EXACT", "CD_POINTS_CLOSEST", ]);

function lcg(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const seats = (n) => Array.from({ length: n }, (_, i) => ({ seat: i, name: `P${i + 1}` }));

// ---------------------------------------------------------------- レーザーミラー

test("レーザー: 反射規則は / が E<->N・W<->S、\\ が E<->S・W<->N", () => {
  assert.equal(laser.reflect("E", "/"), "N");
  assert.equal(laser.reflect("N", "/"), "E");
  assert.equal(laser.reflect("W", "/"), "S");
  assert.equal(laser.reflect("S", "/"), "W");
  assert.equal(laser.reflect("E", "\\"), "S");
  assert.equal(laser.reflect("S", "\\"), "E");
  assert.equal(laser.reflect("W", "\\"), "N");
  assert.equal(laser.reflect("N", "\\"), "W");
});

test("レーザー: 光路シミュレーション（反射して的に当たる／外れる）", () => {
  const base = {
    rows: 6,
    cols: 6,
    emitterRow: 0,
    target: 2 * 6 + 2,
    mirrors: [{ index: 2, kind: "\\" }],
    status: "playing",
    moves: 0,
    seed: 0,
  };
  const trace = laser.traceLaser(base);
  assert.deepEqual(trace.cells, [0, 1, 2, 8, 14]);
  assert.equal(trace.hitTarget, true);
  assert.equal(trace.looped, false);

  const missed = laser.traceLaser({ ...base, target: 35 });
  assert.equal(missed.hitTarget, false);
  assert.deepEqual(missed.cells, [0, 1, 2, 8, 14, 20, 26, 32]);
});

test("レーザー: 生成パズルは初期状態では解けておらず、向きの全探索で解が存在する", () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const state = laser.createLaserPuzzle(seed);
    assert.equal(state.status, "playing");
    assert.ok(state.mirrors.length >= 2, `seed ${seed}: 鏡が2枚以上`);
    assert.equal(laser.traceLaser(state).hitTarget, false, `seed ${seed}: 初期は未解決`);
    const n = state.mirrors.length;
    let solvable = false;
    for (let mask = 0; mask < 1 << n && !solvable; mask++) {
      const mirrors = state.mirrors.map((m, i) => ({
        index: m.index,
        kind: (mask >> i) & 1 ? "\\" : "/",
      }));
      if (laser.traceLaser({ ...state, mirrors }).hitTarget) solvable = true;
    }
    assert.ok(solvable, `seed ${seed}: 解が存在する`);
  }
  const a = laser.createLaserPuzzle(77);
  const b = laser.createLaserPuzzle(77);
  assert.deepEqual(a.mirrors, b.mirrors);
  assert.equal(a.target, b.target);
});

test("レーザー: 鏡の回転で向きが切り替わり、手数が増える", () => {
  const state = laser.createLaserPuzzle(9);
  const first = state.mirrors[0];
  const after = laser.rotateLaserMirror(state, first.index);
  assert.notEqual(after, state);
  assert.equal(after.moves, state.moves + 1);
  assert.equal(after.mirrors.find((m) => m.index === first.index).kind, first.kind === "/" ? "\\" : "/");
  // 鏡の無いセルは無効。
  const empty = Array.from({ length: 36 }, (_, i) => i).find(
    (i) => !state.mirrors.some((m) => m.index === i) && i !== state.target,
  );
  assert.equal(laser.rotateLaserMirror(state, empty), state);
});

// ---------------------------------------------------------------- カウントダウン（式評価）

test("カウントダウン: 式評価の基本と pick のみの提出", () => {
  const numbers = [75, 3, 8, 2, 50, 6];
  const ok = cd.evaluateCountdown(numbers, {
    steps: [{ a: { kind: "num", index: 0 }, op: "+", b: { kind: "num", index: 1 } }],
    pick: null,
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.value, 78);
  assert.deepEqual(ok.stepValues, [78]);

  const chained = cd.evaluateCountdown(numbers, {
    steps: [
      { a: { kind: "num", index: 0 }, op: "+", b: { kind: "num", index: 1 } },
      { a: { kind: "step", index: 0 }, op: "*", b: { kind: "num", index: 3 } },
    ],
    pick: null,
  });
  assert.equal(chained.ok, true);
  assert.equal(chained.value, 156);

  const pickOnly = cd.evaluateCountdown(numbers, { steps: [], pick: 4 });
  assert.equal(pickOnly.ok, true);
  assert.equal(pickOnly.value, 50);
});

test("カウントダウン: 式評価の規則違反は ok:false（数字の再利用・割り切れない割り算・負の引き算・未来の step 参照）", () => {
  const numbers = [75, 3, 8, 2, 50, 6];
  const reuse = cd.evaluateCountdown(numbers, {
    steps: [
      { a: { kind: "num", index: 0 }, op: "+", b: { kind: "num", index: 1 } },
      { a: { kind: "step", index: 0 }, op: "+", b: { kind: "num", index: 0 } },
    ],
    pick: null,
  });
  assert.equal(reuse.ok, false);

  const div = cd.evaluateCountdown(numbers, {
    steps: [{ a: { kind: "num", index: 0 }, op: "/", b: { kind: "num", index: 1 } }],
    pick: null,
  });
  assert.equal(div.ok, true); // 75 / 3 = 25 は割り切れる
  const divBad = cd.evaluateCountdown(numbers, {
    steps: [{ a: { kind: "num", index: 2 }, op: "/", b: { kind: "num", index: 1 } }],
    pick: null,
  });
  assert.equal(divBad.ok, false); // 8 / 3 は割り切れない

  const sub = cd.evaluateCountdown(numbers, {
    steps: [{ a: { kind: "num", index: 1 }, op: "-", b: { kind: "num", index: 0 } }],
    pick: null,
  });
  assert.equal(sub.ok, false); // 3 - 75 は負

  const future = cd.evaluateCountdown(numbers, {
    steps: [{ a: { kind: "step", index: 0 }, op: "+", b: { kind: "num", index: 0 } }],
    pick: null,
  });
  assert.equal(future.ok, false);

  const stepReuse = cd.evaluateCountdown(numbers, {
    steps: [
      { a: { kind: "num", index: 0 }, op: "+", b: { kind: "num", index: 1 } },
      { a: { kind: "step", index: 0 }, op: "+", b: { kind: "num", index: 2 } },
      { a: { kind: "step", index: 0 }, op: "+", b: { kind: "num", index: 3 } },
    ],
    pick: null,
  });
  assert.equal(stepReuse.ok, false);
});

// ---------------------------------------------------------------- カウントダウン（対戦フロー）

function submitPick(state, seat, pick) {
  return cd.gameModule.applyAction(state, seat, { type: "submit", steps: [], pick }, lcg(1));
}

test("カウントダウン: 配布は決定的で、目標は101〜999・数字は6つ", () => {
  const a = cd.gameModule.createState(seats(3), lcg(42), {});
  const b = cd.gameModule.createState(seats(3), lcg(42), {});
  assert.deepEqual(a.setups, b.setups);
  assert.equal(a.setups.length, cd.CD_TOTAL_ROUNDS);
  for (const setup of a.setups) {
    assert.ok(setup.target >= 101 && setup.target <= 999);
    assert.equal(setup.numbers.length, 6);
  }
  assert.throws(() => cd.gameModule.createState(seats(1), lcg(1), {}));
  assert.throws(() => cd.gameModule.createState(seats(7), lcg(1), {}));
});

test("カウントダウン: 締切まで他人の式は秘匿され、締切後に開示される", () => {
  let state = cd.gameModule.createState(seats(3), lcg(7), {});
  state = submitPick(state, 0, 0);
  const viewFor1 = cd.gameModule.viewFor(state, 1);
  assert.equal(viewFor1.you.submitted, false);
  const p0 = viewFor1.players.find((p) => p.seat === 0);
  assert.equal(p0.submitted, true);
  assert.ok(!("value" in p0), "締切前は value キー自体が無い");
  assert.ok(!JSON.stringify(viewFor1).includes('"yourValue":' + state.setups[0].numbers[0]) || viewFor1.you.yourValue === null);
  // 自分の提出は自分に見える。
  const viewFor0 = cd.gameModule.viewFor(state, 0);
  assert.equal(viewFor0.you.yourValue, state.setups[0].numbers[0]);

  state = submitPick(state, 1, 1);
  state = submitPick(state, 2, 2);
  assert.equal(state.phase, "reveal");
  const revealed = cd.gameModule.viewFor(state, 1);
  const rp0 = revealed.players.find((p) => p.seat === 0);
  assert.equal(rp0.value, state.setups[0].numbers[0]);
  assert.equal(typeof rp0.distance, "number");
});

test("カウントダウン: 最も近い人が得点し、同距離は先着のみ（全ラウンド完走と順位）", () => {
  let state = cd.gameModule.createState(seats(2), lcg(3), {});
  let totalAwarded = 0;
  for (let round = 0; round < cd.CD_TOTAL_ROUNDS; round++) {
    assert.equal(state.phase, "playing");
    assert.equal(state.round, round);
    // 両者とも同じ数字を提出 → 同距離なので先着の seat 0 だけが得点する。
    state = submitPick(state, 0, 0);
    state = submitPick(state, 1, 0);
    assert.equal(state.phase, "reveal");
    const entry = state.history[state.history.length - 1];
    const winnerPoints = entry.entries.reduce((sum, e) => sum + e.points, 0);
    assert.ok(winnerPoints === cd.CD_POINTS_CLOSEST || winnerPoints === cd.CD_POINTS_EXACT);
    assert.equal(entry.entries.find((e) => e.seat === 0).points, winnerPoints);
    assert.equal(entry.entries.find((e) => e.seat === 1).points, 0);
    totalAwarded += winnerPoints;
    state = cd.gameModule.tick(state, Date.now() + 60_000);
  }
  assert.equal(state.phase, "finished");
  assert.equal(state.scores[0], totalAwarded);
  assert.equal(state.scores[1], 0);
  const view = cd.gameModule.viewFor(state, 0);
  assert.equal(view.standings.find((s) => s.seat === 0).rank, 1);
  assert.equal(view.standings.find((s) => s.seat === 1).rank, 2);
});

test("カウントダウン: 完全一致はボーナス20点", () => {
  // 2〜3手で目標に一致する式が作れるシードを探す（決定的）。
  let found = null;
  for (let seed = 1; seed <= 200 && !found; seed++) {
    const state = cd.gameModule.createState(seats(2), lcg(seed), {});
    const { target, numbers } = state.setups[0];
    const tries = [];
    for (let i = 0; i < numbers.length; i++) {
      for (let j = 0; j < numbers.length; j++) {
        if (i === j) continue;
        for (const op of ["+", "-", "*", "/"]) {
          tries.push({ steps: [{ a: { kind: "num", index: i }, op, b: { kind: "num", index: j } }], pick: null });
        }
      }
    }
    for (const sub of tries) {
      const ev = cd.evaluateCountdown(numbers, sub);
      if (ev.ok && ev.value === target) {
        found = { state, sub };
        break;
      }
    }
  }
  assert.ok(found, "完全一致できるシードが見つかる");
  let state = cd.gameModule.applyAction(found.state, 0, { type: "submit", ...found.sub }, lcg(1));
  state = submitPick(state, 1, 0);
  assert.equal(state.phase, "reveal");
  assert.equal(state.scores[0], cd.CD_POINTS_EXACT);
  assert.equal(state.history[0].winnerSeat, 0);
});

test("カウントダウン: 時間切れで締切、退出は未提出扱いで残り1人なら終了", () => {
  let state = cd.gameModule.createState(seats(3), lcg(9), {});
  state = submitPick(state, 0, 0);
  // 誰も残りを出さなくても tick で締め切られる。
  const closed = cd.gameModule.tick(state, state.roundEndsAt + 1);
  assert.equal(closed.phase, "reveal");
  assert.equal(closed.history[0].entries.find((e) => e.seat === 1).value, null);
  assert.equal(closed.history[0].winnerSeat, 0);

  // 提出済みでも退出すると未提出扱いになり、残り1人で終了する。
  let game = cd.gameModule.createState(seats(2), lcg(9), {});
  game = submitPick(game, 0, 0);
  game = cd.gameModule.onPlayerLeft(game, 0);
  assert.equal(game.phase, "finished");
  assert.equal(game.submissions.length, 0);

  // parseAction の検証。
  assert.equal(cd.gameModule.parseAction({ type: "submit", steps: [], pick: 2 }).pick, 2);
  assert.equal(cd.gameModule.parseAction({ type: "submit", steps: [], pick: 99 }), null);
  assert.equal(cd.gameModule.parseAction({ type: "nope" }), null);
  assert.equal(
    cd.gameModule.parseAction({
      type: "submit",
      steps: [{ a: { kind: "num", index: 0 }, op: "%", b: { kind: "num", index: 1 } }],
      pick: null,
    }),
    null,
  );
});
