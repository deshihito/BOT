// A5フェーズの新規4本のロジック検証。
// - lib/darts.ts: エリア判定（ブル/ダブル/トリプル/セクター）・ラウンド制と合計
// - lib/touchnumber.ts: 配置・次の数字判定・ミス集計
// - lib/online/games/wordwolf.ts: お題秘匿・議論tick・投票/決選投票の決着
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

async function loadWordwolf() {
  const src = fs.readFileSync(path.join(libDir, "online", "games", "wordwolf.ts"), "utf8");
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const code = stripModuleSyntax(js) + "\n export { gameModule, WORDWOLF_PAIRS };\n";
  return import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
}

const darts = await loadLib("darts.ts");
const touch = await loadLib("touchnumber.ts");
const ww = await loadWordwolf();

function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// ---------------------------------------------------------------- ダーツ

test("ダーツ: ブルは50点、外ブルは25点", () => {
  assert.equal(darts.scoreDart(0, 0).score, 50);
  assert.equal(darts.scoreDart(0, 0).label, "BULL");
  assert.equal(darts.scoreDart(0, 0.1).score, 25);
});

test("ダーツ: 上方向は20、ダブルリングで40点、トリプルで60点", () => {
  const single = darts.scoreDart(0, 0.3);
  assert.equal(single.number, 20);
  assert.equal(single.score, 20);
  const dbl = darts.scoreDart(0, 0.97);
  assert.equal(dbl.label, "D20");
  assert.equal(dbl.score, 40);
  const tpl = darts.scoreDart(0, 0.555);
  assert.equal(tpl.label, "T20");
  assert.equal(tpl.score, 60);
});

test("ダーツ: 右方向はセクター6、盤外はミス", () => {
  const hit = darts.scoreDart(0.5, 0);
  assert.equal(hit.number, 6);
  assert.equal(hit.score, 6);
  assert.equal(darts.scoreDart(0, 1.2).score, 0);
  assert.equal(darts.scoreDart(0, 1.2).label, "MISS");
});

test("ダーツ: 3投×8ラウンドで終了し、合計が一致する", () => {
  let s = darts.createDartsGame(42, 8, false);
  for (let i = 0; i < 24; i++) s = darts.throwDart(s, 0, 0);
  assert.equal(s.status, "finished");
  assert.equal(s.totalScore, 24 * 50);
  assert.equal(s.rounds.length, 8);
  assert.ok(s.rounds.every((r) => r.length === 3));
  // 終了後の投擲は無効
  assert.equal(darts.throwDart(s, 0, 0), s);
});

test("ダーツ: jitter 有効でも同じシードでは同じ結果になる", () => {
  const play = () => {
    let s = darts.createDartsGame(7, 2, true);
    for (let i = 0; i < 6; i++) s = darts.throwDart(s, 0.1, 0.2);
    return s;
  };
  assert.deepEqual(play(), play());
});

// ---------------------------------------------------------------- タッチザナンバー

test("タッチザナンバー: 配置は1..sizeの順列で、シード決定的", () => {
  const a = touch.createTouchGame(25, 3);
  const b = touch.createTouchGame(25, 3);
  assert.deepEqual(a.board, b.board);
  assert.deepEqual([...a.board].sort((x, y) => x - y), Array.from({ length: 25 }, (_, i) => i + 1));
  const c = touch.createTouchGame(50, 3);
  assert.equal(c.board.length, 50);
});

test("タッチザナンバー: 順番にタップすると進み、最後で勝ち", () => {
  let s = touch.createTouchGame(25, 5);
  for (let v = 1; v <= 25; v++) s = touch.tapValue(s, v);
  assert.equal(s.status, "won");
  assert.equal(s.misses, 0);
});

test("タッチザナンバー: 先の数字はミス、片付け済みは無視", () => {
  let s = touch.createTouchGame(25, 5);
  s = touch.tapValue(s, 10);
  assert.equal(s.misses, 1);
  assert.equal(s.next, 1);
  s = touch.tapValue(s, 1);
  assert.equal(s.next, 2);
  const before = s;
  s = touch.tapValue(s, 1);
  assert.equal(s.misses, before.misses);
  assert.equal(s.next, 2);
});

// ---------------------------------------------------------------- ワードウルフ

function makePlayers(n) {
  return Array.from({ length: n }, (_, i) => ({ seat: i, name: `P${i}` }));
}

function startWw(n, seed = 42, discussionSec = 180) {
  const parsed = ww.gameModule.parseOptions({ discussionSec });
  return ww.gameModule.createState(makePlayers(n), seeded(seed), parsed);
}

function toVote(state) {
  return ww.gameModule.tick(state, state.discussionEndsAt + 1);
}

function voteAll(state, targetFor) {
  let s = state;
  for (const p of s.players) {
    if (s.left[p.seat]) continue;
    s = ww.gameModule.applyAction(s, p.seat, { type: "vote", target: targetFor(p.seat, s) }, seeded(1));
  }
  return s;
}

test("ワードウルフ: お題はウルフ1人だけ別で、ビューでは他人のお題が見えない", () => {
  const s = startWw(4, 42);
  const wolf = s.wolfSeat;
  for (const p of s.players) {
    const view = ww.gameModule.viewFor(s, p.seat);
    const expected = p.seat === wolf ? s.pair.minority : s.pair.majority;
    const other = p.seat === wolf ? s.pair.majority : s.pair.minority;
    assert.equal(view.you.word, expected);
    assert.ok(!JSON.stringify(view).includes(other), `seat ${p.seat} のビューに他人のお題が漏れている`);
    assert.equal(view.result, null);
  }
  const minorityCount = s.players.filter((p) => s.words[p.seat] === s.pair.minority).length;
  assert.equal(minorityCount, 1);
});

test("ワードウルフ: 人数と議論時間の検証", () => {
  assert.throws(() => startWw(2), /3〜6人/);
  assert.throws(() => startWw(7), /3〜6人/);
  assert.throws(() => ww.gameModule.parseOptions({ discussionSec: 999 }), /議論時間/);
  for (const sec of [120, 180, 240]) {
    assert.equal(startWw(3, 1, sec).discussionSec, sec);
  }
});

test("ワードウルフ: tick で議論が終わり投票へ進む", () => {
  const s = startWw(4, 7);
  assert.equal(s.phase, "discuss");
  assert.equal(ww.gameModule.tick(s, s.discussionEndsAt - 1000).phase, "discuss");
  assert.equal(toVote(s).phase, "vote");
});

test("ワードウルフ: 全員 ready でも投票へ進む", () => {
  let s = startWw(3, 9);
  for (const p of s.players) s = ww.gameModule.applyAction(s, p.seat, { type: "ready" }, seeded(1));
  assert.equal(s.phase, "vote");
});

test("ワードウルフ: ウルフを指名できれば多数派の勝ち、結果で全開示される", () => {
  let s = toVote(startWw(4, 42));
  const wolf = s.wolfSeat;
  const other = s.players.find((p) => p.seat !== wolf).seat;
  s = voteAll(s, (seat) => (seat === wolf ? other : wolf));
  assert.equal(s.phase, "finished");
  assert.equal(s.winner, "majority");
  assert.equal(s.caughtSeat, wolf);
  const view = ww.gameModule.viewFor(s, other);
  assert.equal(view.result.wolfSeat, wolf);
  assert.equal(view.result.majorityWord, s.pair.majority);
  assert.equal(view.result.minorityWord, s.pair.minority);
});

test("ワードウルフ: 外せばウルフの勝ち", () => {
  let s = toVote(startWw(4, 42));
  const wolf = s.wolfSeat;
  const victim = s.players.find((p) => p.seat !== wolf).seat;
  const other = s.players.find((p) => p.seat !== wolf && p.seat !== victim).seat;
  // victim 以外は全員 victim へ、victim は other へ → victim が指名される
  s = voteAll(s, (seat) => (seat === victim ? other : victim));
  assert.equal(s.phase, "finished");
  assert.equal(s.winner, "wolf");
  assert.equal(s.caughtSeat, victim);
});

test("ワードウルフ: 同票は決選投票1回、それでも同票ならウルフの逃げ切り", () => {
  let s = toVote(startWw(4, 42));
  // 0↔1 に2票ずつ集める
  const first = { 0: 1, 1: 0, 2: 1, 3: 0 };
  s = voteAll(s, (seat) => first[seat]);
  assert.equal(s.phase, "revote");
  assert.deepEqual([...s.tiedCandidates].sort((a, b) => a - b), [0, 1]);
  // 決選候補以外への投票はできない
  assert.throws(() => ww.gameModule.applyAction(s, 0, { type: "vote", target: 2 }, seeded(1)), /決選投票/);
  s = voteAll(s, (seat) => first[seat]);
  assert.equal(s.phase, "finished");
  assert.equal(s.winner, "wolf");
  assert.equal(s.caughtSeat, null);
});

test("ワードウルフ: ウルフが退出したら多数派の勝ち、退出者への投票はできない", () => {
  let s = startWw(4, 42);
  const wolf = s.wolfSeat;
  s = ww.gameModule.onPlayerLeft(s, wolf);
  assert.equal(s.phase, "finished");
  assert.equal(s.winner, "majority");

  let s2 = toVote(startWw(5, 42));
  const leaver = s2.players.find((p) => p.seat !== s2.wolfSeat).seat;
  s2 = ww.gameModule.onPlayerLeft(s2, leaver);
  const voter = s2.players.find((p) => p.seat !== leaver && p.seat !== s2.wolfSeat).seat;
  assert.throws(() => ww.gameModule.applyAction(s2, voter, { type: "vote", target: leaver }, seeded(1)), /退出/);
});

test("ワードウルフ: parseAction の形式検証", () => {
  assert.deepEqual(ww.gameModule.parseAction({ type: "ready" }), { type: "ready" });
  assert.deepEqual(ww.gameModule.parseAction({ type: "vote", target: 2 }), { type: "vote", target: 2 });
  assert.equal(ww.gameModule.parseAction({ type: "vote", target: -1 }), null);
  assert.equal(ww.gameModule.parseAction({ type: "nope" }), null);
  assert.equal(ww.gameModule.parseAction(null), null);
});

test("ワードウルフ: 投票に締切があり、tick で未投票者を棄権として集計する", () => {
  let s = toVote(startWw(4, 42));
  assert.equal(s.phase, "vote");
  assert.equal(typeof s.voteEndsAt, "number");
  // ビューにも締切が伝わる。
  assert.equal(ww.gameModule.viewFor(s, 0).voteEndsAt, s.voteEndsAt);
  // 締切前は同一参照。
  assert.equal(ww.gameModule.tick(s, s.voteEndsAt - 1), s);
  const wolf = s.wolfSeat;
  const voters = s.players.filter((p) => p.seat !== wolf).slice(0, 2);
  for (const v of voters) {
    s = ww.gameModule.applyAction(s, v.seat, { type: "vote", target: wolf }, seeded(1));
  }
  assert.equal(s.phase, "vote", "まだ全員分そろっていないので投票中");
  // 締切で残りは棄権扱いになり、入った票（ウルフへの2票）で決着する。
  s = ww.gameModule.tick(s, s.voteEndsAt + 1);
  assert.equal(s.phase, "finished");
  assert.equal(s.winner, "majority");
  assert.equal(s.caughtSeat, wolf);
});

test("ワードウルフ: 投票で1票も入らなければ締切でウルフの逃げ切り", () => {
  let s = toVote(startWw(4, 42));
  s = ww.gameModule.tick(s, s.voteEndsAt + 1);
  assert.equal(s.phase, "finished");
  assert.equal(s.winner, "wolf");
  assert.equal(s.caughtSeat, null);
});

test("ワードウルフ: 決選投票にも締切があり、過ぎると集計される", () => {
  let s = toVote(startWw(4, 42));
  const first = { 0: 1, 1: 0, 2: 1, 3: 0 };
  s = voteAll(s, (seat) => first[seat]);
  assert.equal(s.phase, "revote");
  assert.equal(typeof s.voteEndsAt, "number");
  // 誰も決選投票をしないまま締切 → 同票のままなのでウルフの勝ち。
  s = ww.gameModule.tick(s, s.voteEndsAt + 1);
  assert.equal(s.phase, "finished");
  assert.equal(s.winner, "wolf");
});
