// 人狼（lib/online/games/werewolf.ts）の検証。
// balku.test.mjs と同じ loadBundle 方式（TS transpile + import 除去 + 連結）。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const libDir = path.join(import.meta.dirname, "..", "lib");

function transpile(name) {
  const src = fs.readFileSync(path.join(libDir, name), "utf8");
  return ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
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

async function loadBundle(files, exportNames) {
  const code =
    files.map((name) => stripModuleSyntax(transpile(name))).join("\n") +
    `\nexport { ${exportNames.join(", ")} };\n`;
  return import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
}

const { gameModule } = await loadBundle(["online/games/werewolf.ts"], ["gameModule"]);
const rng0 = () => 0.5;

// 決定的な疑似乱数（LCG）。
function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function makePlayers(n) {
  return Array.from({ length: n }, (_, i) => ({ seat: i, name: `P${i}` }));
}

function startGame(n, seed = 42, options = { discussionSec: 60 }) {
  const parsed = gameModule.parseOptions(options);
  return gameModule.createState(makePlayers(n), seeded(seed), parsed);
}

function seatsOf(state, role) {
  return state.players.filter((p) => state.roles[p.seat] === role).map((p) => p.seat);
}
function seatOf(state, role, idx = 0) {
  return seatsOf(state, role)[idx];
}
function aliveList(state) {
  return state.players.filter((p) => state.alive[p.seat]).map((p) => p.seat);
}
function act(state, seat, action) {
  return gameModule.applyAction(state, seat, action, rng0);
}
function nightEntries(state, { wolfTarget, wolfTargets, seerTarget, hunterTarget }) {
  const entries = [];
  for (const p of state.players) {
    if (!state.alive[p.seat]) continue;
    const role = state.roles[p.seat];
    if (role === "wolf") entries.push([p.seat, wolfTargets?.[p.seat] ?? wolfTarget]);
    else if (role === "seer") entries.push([p.seat, seerTarget]);
    else if (role === "hunter") entries.push([p.seat, hunterTarget]);
  }
  return entries;
}
function doNight(state, plan, order) {
  const entries = order ?? nightEntries(state, plan);
  let s = state;
  for (const [seat, target] of entries) s = act(s, seat, { type: "nightAction", target });
  return s;
}
function readyAll(state) {
  let s = state;
  for (const seat of aliveList(s)) s = act(s, seat, { type: "ready" });
  return s;
}
function doVotes(state, entries) {
  let s = state;
  for (const [seat, target] of entries) s = act(s, seat, { type: "vote", target });
  return s;
}
function tieEntries(state) {
  const [a, b, c, d] = aliveList(state);
  return [
    [a, c],
    [b, d],
    [c, a],
    [d, b],
  ];
}
/** 5人: 人狼が村人0を襲い、狩人は村人1を守る → 村人0が死んで昼になる状態。 */
function dayAfterFirstKill5() {
  const s = startGame(5, 7);
  const wolf = seatOf(s, "wolf");
  const villagers = seatsOf(s, "villager");
  const after = doNight(s, { wolfTarget: villagers[0], seerTarget: wolf, hunterTarget: villagers[1] });
  assert.equal(after.phase, "day");
  return after;
}
/** 4人: 人狼が村人0を襲って昼になる状態（生存3人）。 */
function dayAfterKill4() {
  const s = startGame(4, 11);
  const wolf = seatOf(s, "wolf");
  const villagers = seatsOf(s, "villager");
  const after = doNight(s, { wolfTarget: villagers[0], seerTarget: wolf });
  assert.equal(after.phase, "day");
  return after;
}

// ---------------------------------------------------------------- 基本

test("メタ情報と人数別役職配分（4〜8人）が配分表どおり", () => {
  assert.equal(gameModule.id, "werewolf");
  assert.equal(gameModule.minPlayers, 4);
  assert.equal(gameModule.maxPlayers, 8);
  assert.equal(gameModule.cpuSupported, false);
  assert.equal(gameModule.chatEnabled, false);
  const table = {
    4: { wolf: 1, seer: 1, hunter: 0, villager: 2 },
    5: { wolf: 1, seer: 1, hunter: 1, villager: 2 },
    6: { wolf: 2, seer: 1, hunter: 1, villager: 2 },
    7: { wolf: 2, seer: 1, hunter: 1, villager: 3 },
    8: { wolf: 2, seer: 1, hunter: 1, villager: 4 },
  };
  for (let n = 4; n <= 8; n++) {
    const s = startGame(n, 100 + n);
    const counts = { wolf: 0, seer: 0, hunter: 0, villager: 0 };
    for (const p of s.players) counts[s.roles[p.seat]] += 1;
    assert.deepEqual(counts, table[n], `${n}人の配分`);
    assert.equal(s.phase, "night");
    assert.equal(s.dayCount, 1);
    assert.equal(s.winner, null);
    assert.ok(s.alive.every(Boolean));
    assert.equal(gameModule.phaseOf(s), "night");
    assert.equal(gameModule.isFinished(s), false);
  }
  assert.throws(() => gameModule.createState(makePlayers(3), seeded(1), {}), /4〜8人/);
  assert.throws(() => gameModule.createState(makePlayers(9), seeded(1), {}), /4〜8人/);
});

test("parseOptions: 既定120、30〜600へ丸め、不正な型は throw", () => {
  assert.deepEqual(gameModule.parseOptions({}), { discussionSec: 120 });
  assert.deepEqual(gameModule.parseOptions({ discussionSec: 10 }), { discussionSec: 30 });
  assert.deepEqual(gameModule.parseOptions({ discussionSec: 9999 }), { discussionSec: 600 });
  assert.deepEqual(gameModule.parseOptions({ discussionSec: 119.6 }), { discussionSec: 120 });
  assert.throws(() => gameModule.parseOptions({ discussionSec: "120" }), /数値/);
  assert.throws(() => gameModule.parseOptions({ discussionSec: null }), /数値/);
});

test("parseAction: 形式検証し、不正な形式は null", () => {
  assert.deepEqual(gameModule.parseAction({ type: "nightAction", target: 2 }), { type: "nightAction", target: 2 });
  assert.deepEqual(gameModule.parseAction({ type: "ready" }), { type: "ready" });
  assert.deepEqual(gameModule.parseAction({ type: "vote", target: 0 }), { type: "vote", target: 0 });
  assert.equal(gameModule.parseAction({ type: "vote" }), null);
  assert.equal(gameModule.parseAction({ type: "vote", target: 1.5 }), null);
  assert.equal(gameModule.parseAction({ type: "vote", target: "1" }), null);
  assert.equal(gameModule.parseAction({ type: "unknown" }), null);
  assert.equal(gameModule.parseAction(null), null);
  assert.equal(gameModule.parseAction("ready"), null);
});

// ---------------------------------------------------------------- 夜

test("夜の行動: 村人・人狼→人狼・自己対象・二重提出は throw、元状態を破壊しない", () => {
  const s = startGame(6, 3);
  const wolf = seatOf(s, "wolf");
  const wolf2 = seatOf(s, "wolf", 1);
  const villager = seatOf(s, "villager");
  const seer = seatOf(s, "seer");
  const victim = seatsOf(s, "villager")[1];
  assert.throws(() => act(s, villager, { type: "nightAction", target: wolf }), /村人は夜に行動できません/);
  assert.throws(() => act(s, wolf, { type: "nightAction", target: wolf2 }), /人狼は人狼を襲撃できません/);
  assert.throws(() => act(s, seer, { type: "nightAction", target: seer }), /自分は選べません/);
  const afterWolf = act(s, wolf, { type: "nightAction", target: victim });
  assert.equal(s.night.wolfVotes.length, 0, "applyAction は元の状態を破壊しない");
  assert.equal(afterWolf.night.wolfVotes.length, 1);
  assert.throws(() => act(afterWolf, wolf, { type: "nightAction", target: victim }), /すでに提出しています/);
  assert.throws(() => act(s, villager, { type: "ready" }), /今は昼ではありません/);
  assert.throws(() => act(s, villager, { type: "vote", target: wolf }), /投票フェーズではありません/);
});

test("夜の解決: 護衛が外れれば襲撃先が死に、役職が公開され昼になる", () => {
  const s = startGame(5, 7);
  const wolf = seatOf(s, "wolf");
  const villagers = seatsOf(s, "villager");
  const before = Date.now();
  const after = doNight(s, { wolfTarget: villagers[0], seerTarget: wolf, hunterTarget: villagers[1] });
  assert.equal(after.phase, "day");
  assert.equal(after.alive[villagers[0]], false);
  assert.deepEqual(after.lastNightResult, { deadSeat: villagers[0] });
  assert.equal(after.revealedRoles[villagers[0]], "villager");
  assert.ok(after.dayEndsAt > before && after.dayEndsAt <= Date.now() + 60_000);
  const view = gameModule.viewFor(after, villagers[1]);
  assert.equal(view.players.find((p) => p.seat === villagers[0]).role, "villager");
  assert.equal(view.players.find((p) => p.seat === villagers[0]).deathCause, "attack");
});

test("夜の解決: 護衛一致で誰も死なない。占い結果は占い師にだけ見える", () => {
  const s = startGame(5, 9);
  const wolf = seatOf(s, "wolf");
  const seer = seatOf(s, "seer");
  const villagers = seatsOf(s, "villager");
  const after = doNight(s, { wolfTarget: villagers[0], seerTarget: wolf, hunterTarget: villagers[0] });
  assert.equal(after.phase, "day");
  assert.deepEqual(after.lastNightResult, { deadSeat: null });
  assert.ok(after.alive.every(Boolean));
  const seerView = gameModule.viewFor(after, seer);
  assert.deepEqual(seerView.night.seerResults, [{ day: 1, target: wolf, isWolf: true }]);
  const villagerView = gameModule.viewFor(after, villagers[1]);
  assert.deepEqual(villagerView.night.seerResults, []);
  assert.ok(!JSON.stringify(villagerView).includes("isWolf"));
});

test("人狼チームの決定: 同数なら最も早く submit された対象が優先される", () => {
  const s = startGame(6, 5);
  const [w1, w2] = seatsOf(s, "wolf");
  const villagers = seatsOf(s, "villager");
  const seer = seatOf(s, "seer");
  const hunter = seatOf(s, "hunter");
  // w2 が先に villagers[1] を、w1 が後に villagers[0] を指す（1票ずつ同数）。
  // 狩人は villagers[0] を守るので、決定が villagers[0] なら無死、villagers[1] なら死亡で区別できる。
  const order = [
    [w2, villagers[1]],
    [w1, villagers[0]],
    [seer, w1],
    [hunter, villagers[0]],
  ];
  const after = doNight(s, {}, order);
  assert.equal(after.phase, "day");
  assert.deepEqual(after.lastNightResult, { deadSeat: villagers[1] });
});

test("死亡者は次の夜に行動できない", () => {
  let s = dayAfterFirstKill5();
  const dead = s.players.find((p) => !s.alive[p.seat]).seat;
  // 全員 ready → 同数投票×2で処刑なし → 次の夜へ
  s = readyAll(s);
  assert.equal(s.phase, "vote");
  s = doVotes(s, tieEntries(s));
  assert.equal(s.phase, "vote");
  s = doVotes(s, tieEntries(s));
  assert.equal(s.phase, "night");
  assert.equal(s.dayCount, 2);
  assert.throws(() => act(s, dead, { type: "nightAction", target: seatOf(s, "wolf") }), /死亡している/);
  const villager = aliveList(s).find((seat) => s.roles[seat] === "villager");
  assert.throws(() => act(s, villager, { type: "nightAction", target: seatOf(s, "wolf") }), /村人は夜に行動できません/);
});

// ---------------------------------------------------------------- 昼・投票

test("議論: ready 全員で投票へ、重複 ready は throw", () => {
  let s = dayAfterKill4();
  const alive = aliveList(s);
  s = act(s, alive[0], { type: "ready" });
  assert.equal(s.phase, "day");
  assert.throws(() => act(s, alive[0], { type: "ready" }), /すでに/);
  s = act(s, alive[1], { type: "ready" });
  assert.equal(s.phase, "day");
  s = act(s, alive[2], { type: "ready" });
  assert.equal(s.phase, "vote");
  assert.equal(gameModule.phaseOf(s), "vote");
});

test("議論: tick の期限切れで投票へ、期限前は同一参照", () => {
  const s = dayAfterKill4();
  assert.equal(gameModule.tick(s, s.dayEndsAt - 1), s);
  const after = gameModule.tick(s, s.dayEndsAt + 1);
  assert.notEqual(after, s);
  assert.equal(after.phase, "vote");
  // 夜フェーズでは tick は何もしない
  const night = startGame(4, 2);
  assert.equal(gameModule.tick(night, Date.now() + 10_000_000), night);
});

test("投票: 最多得票1人で処刑され、人狼処刑で村勝ち", () => {
  let s = dayAfterKill4();
  const wolf = seatOf(s, "wolf");
  const seer = seatOf(s, "seer");
  const villager = aliveList(s).find((seat) => s.roles[seat] === "villager");
  s = readyAll(s);
  s = doVotes(s, [
    [seer, wolf],
    [villager, wolf],
    [wolf, seer],
  ]);
  assert.equal(s.phase, "finished");
  assert.equal(s.winner, "village");
  assert.deepEqual(s.lastExecution, { deadSeat: wolf, tied: false });
  assert.equal(s.alive[wolf], false);
  assert.equal(gameModule.isFinished(s), true);
});

test("投票: 同数→再投票1回、再投票でも同数→処刑なしで次の夜", () => {
  let s = dayAfterFirstKill5();
  s = readyAll(s);
  const aliveBefore = aliveList(s);
  s = doVotes(s, tieEntries(s));
  assert.equal(s.phase, "vote", "同数最多は再投票で同フェーズ継続");
  assert.equal(s.revoteUsed, true);
  assert.equal(s.votes.length, 0);
  const aViewer = gameModule.viewFor(s, aliveBefore[0]);
  assert.equal(aViewer.vote.revote, true);
  assert.equal(aViewer.vote.votedCount, 0);
  s = doVotes(s, tieEntries(s));
  assert.equal(s.phase, "night");
  assert.equal(s.dayCount, 2);
  assert.deepEqual(s.lastExecution, { deadSeat: null, tied: true });
  assert.deepEqual(aliveList(s), aliveBefore, "誰も処刑されていない");
});

// ---------------------------------------------------------------- 勝敗

test("勝敗: 夜明け時点（夜の解決直後）で人狼数>=村側なら人狼勝ち", () => {
  let s = startGame(5, 21);
  const wolf = seatOf(s, "wolf");
  const seer = seatOf(s, "seer");
  const hunter = seatOf(s, "hunter");
  const villagers = seatsOf(s, "villager");
  // 夜1: 村人0が死ぬ（狼1 vs 村側3）
  s = doNight(s, { wolfTarget: villagers[0], seerTarget: wolf, hunterTarget: villagers[1] });
  assert.equal(s.phase, "day");
  // 昼1: 村人1を処刑（狼1 vs 村側2）
  s = readyAll(s);
  s = doVotes(s, [
    [wolf, villagers[1]],
    [seer, villagers[1]],
    [hunter, villagers[1]],
    [villagers[1], wolf],
  ]);
  assert.equal(s.phase, "night");
  assert.equal(s.winner, null);
  // 夜2: 占い師が死ぬ（狼1 vs 村側1）→ 夜明け判定で人狼勝ち
  s = doNight(s, { wolfTarget: seer, seerTarget: hunter, hunterTarget: wolf });
  assert.equal(s.phase, "finished");
  assert.equal(s.winner, "wolf");
  assert.deepEqual(s.lastNightResult, { deadSeat: seer });
});

test("勝敗: 処刑で村側が減って同数になれば人狼勝ち", () => {
  let s = dayAfterKill4(); // 生存: 狼1・占い師1・村人1
  const wolf = seatOf(s, "wolf");
  const seer = seatOf(s, "seer");
  const villager = aliveList(s).find((seat) => s.roles[seat] === "villager");
  s = readyAll(s);
  s = doVotes(s, [
    [wolf, villager],
    [seer, villager],
    [villager, wolf],
  ]);
  assert.equal(s.phase, "finished");
  assert.equal(s.winner, "wolf");
  assert.deepEqual(s.lastExecution, { deadSeat: villager, tied: false });
});

// ---------------------------------------------------------------- 秘匿

test("秘匿: 無関係な村人のビューに生存中の役職情報が無い", () => {
  const s = startGame(6, 33);
  const villager = seatOf(s, "villager");
  const json = JSON.stringify(gameModule.viewFor(s, villager));
  assert.ok(!json.includes('"wolf"'), json);
  assert.ok(!json.includes('"seer"'), json);
  assert.ok(!json.includes('"hunter"'), json);
  const view = gameModule.viewFor(s, villager);
  assert.equal(view.you.role, "villager");
  assert.equal(view.wolves, undefined, "人狼以外には wolves キー自体を出さない");
  assert.ok(view.players.every((p) => p.role === undefined));
});

test("秘匿: 人狼同士は互いが見えるが、他の役職は見えない", () => {
  const s = startGame(6, 34);
  const wolves = seatsOf(s, "wolf");
  assert.equal(wolves.length, 2);
  const view = gameModule.viewFor(s, wolves[0]);
  assert.deepEqual([...view.wolves].sort((a, b) => a - b), [...wolves].sort((a, b) => a - b));
  const json = JSON.stringify(view);
  assert.ok(!json.includes('"seer"'), json);
  assert.ok(!json.includes('"hunter"'), json);
});

test("秘匿: 終了時は全員の役職が公開される", () => {
  let s = dayAfterKill4();
  const wolf = seatOf(s, "wolf");
  const seer = seatOf(s, "seer");
  const villager = aliveList(s).find((seat) => s.roles[seat] === "villager");
  s = readyAll(s);
  s = doVotes(s, [
    [seer, wolf],
    [villager, wolf],
    [wolf, seer],
  ]);
  assert.equal(s.phase, "finished");
  const view = gameModule.viewFor(s, villager);
  for (const p of view.players) assert.equal(p.role, s.roles[p.seat], `seat ${p.seat} の役職が公開される`);
});

// ---------------------------------------------------------------- 退出

test("退出: 夜に未提出の狩人が退出しても進行が詰まらず夜が解決する", () => {
  let s = startGame(5, 55);
  const wolf = seatOf(s, "wolf");
  const seer = seatOf(s, "seer");
  const hunter = seatOf(s, "hunter");
  const villagers = seatsOf(s, "villager");
  s = act(s, wolf, { type: "nightAction", target: villagers[0] });
  s = act(s, seer, { type: "nightAction", target: wolf });
  assert.equal(s.phase, "night", "狩人の提出待ち");
  s = gameModule.onPlayerLeft(s, hunter);
  assert.equal(s.alive[hunter], false);
  assert.equal(s.revealedRoles[hunter], "hunter");
  assert.equal(s.phase, "day", "狩人を提出不要として夜が解決する");
  assert.deepEqual(s.lastNightResult, { deadSeat: villagers[0] });
  const view = gameModule.viewFor(s, seer);
  assert.equal(view.players.find((p) => p.seat === hunter).deathCause, "left");
  // 既に死亡したプレイヤーの退出は同一参照（変化なし）
  assert.equal(gameModule.onPlayerLeft(s, hunter), s);
});

test("退出: 投票フェーズで未投票者が退出すると残りで集計が進む", () => {
  let s = dayAfterFirstKill5();
  const wolf = seatOf(s, "wolf");
  const seer = seatOf(s, "seer");
  const hunter = seatOf(s, "hunter");
  const villager = aliveList(s).find((seat) => s.roles[seat] === "villager");
  s = readyAll(s);
  assert.equal(s.phase, "vote");
  s = doVotes(s, [
    [wolf, villager],
    [seer, wolf],
    [villager, wolf],
  ]);
  assert.equal(s.phase, "vote", "狩人の投票待ち");
  s = gameModule.onPlayerLeft(s, hunter);
  assert.equal(s.phase, "finished", "残り全員投票済みとして集計され人狼が処刑される");
  assert.equal(s.winner, "village");
  assert.deepEqual(s.lastExecution, { deadSeat: wolf, tied: false });
});

test("退出: 最後の人狼が退出すれば村勝ちで終了する", () => {
  const s = startGame(4, 77);
  const wolf = seatOf(s, "wolf");
  const after = gameModule.onPlayerLeft(s, wolf);
  assert.equal(after.phase, "finished");
  assert.equal(after.winner, "village");
  assert.equal(after.revealedRoles[wolf], "wolf");
});
