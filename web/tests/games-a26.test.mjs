// A26フェーズの検証。
// - lib/cranegame.ts: 景品配置の決定性・距離ベースの掴み判定・往復と降下の進行
// - lib/online/games/musicalchairs.ts: 音楽停止→着席競争→最遅脱落・未着席の規則・退出
// - lib/online/games/nanja.ts: 増量後のバンク件数（30種）と重複なし・山札120枚
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

const crane = await loadLib("cranegame.ts");
const mc = await loadOnline("musicalchairs.ts", [
  "gameModule",
  "MC_REACT_LIMIT_MS",
  "MC_MUSIC_MIN_MS",
  "MC_MUSIC_MAX_MS",
]);
const nanja = await loadOnline("nanja.ts", [
  "gameModule",
  "NANJA_CREATURES",
  "NANJA_DEFAULT_NAMES",
  "NANJA_COPIES_PER_CREATURE",
]);

function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const seats = (n) => Array.from({ length: n }, (_, i) => ({ seat: i, name: `P${i + 1}` }));

// ---------------------------------------------------------------- クレーンゲーム

test("クレーン: 同じシードでは同じ景品配置になり、景品は8個で範囲内に収まる", () => {
  const a = crane.createCraneGame(42);
  const b = crane.createCraneGame(42);
  assert.deepEqual(a.prizes, b.prizes);
  assert.equal(a.prizes.length, crane.CRANE_PRIZE_COUNT);
  assert.equal(a.phase, "aimX");
  for (const p of a.prizes) {
    assert.ok(p.x >= 0 && p.x <= 100 && p.y >= 0 && p.y <= 100);
    // 掴める範囲は「半径 − 重さペナルティ」で決定的に決まる
    assert.equal(p.grabRadius, p.radius - (p.weight - 1) * 1.5);
  }
  const c = crane.createCraneGame(43);
  assert.notDeepEqual(c.prizes, a.prizes);
});

test("クレーン: 掴み判定は中心との距離だけで決まる（確率なし）", () => {
  const st = crane.createCraneGame(7);
  const target = st.prizes[3];
  // 中心ちょうどなら必ず取れる
  const hit = crane.evaluateGrab(st.prizes, target.x, target.y);
  assert.equal(hit.prizeId, target.id);
  assert.equal(hit.dist, 0);
  // grabRadius ちょうどの距離でも取れる
  const edge = crane.evaluateGrab(st.prizes, target.x + target.grabRadius, target.y);
  assert.equal(edge.prizeId, target.id);
  // どの景品からも遠い角では取れない
  const miss = crane.evaluateGrab(st.prizes, 0, 0);
  assert.equal(miss.prizeId, null);
  assert.ok(miss.dist > target.grabRadius);
  // 同じ入力では常に同じ結果（決定的）
  assert.deepEqual(crane.evaluateGrab(st.prizes, 50, 50), crane.evaluateGrab(st.prizes, 50, 50));
});

test("クレーン: 往復は範囲を出ず、状態は非破壊に進む", () => {
  const st = crane.createCraneGame(11);
  let s = st;
  for (let i = 0; i < 200; i++) {
    s = crane.stepCrane(s, 100);
    assert.ok(s.craneX >= 0 && s.craneX <= 100);
    assert.equal(s.phase, "aimX");
  }
  assert.equal(st.craneX, 0); // 元の状態は変わらない
  assert.ok(s.craneX !== 0 || s.dirX === -1);
});

test("クレーン: 2回止めると降下して結果が出る／中心を狙えば取れる", () => {
  const base = crane.createCraneGame(99);
  const target = base.prizes[2];
  // 横と奥行きを景品の中心に合わせて止める
  let s = { ...base, craneX: target.x };
  s = crane.stopCrane(s);
  assert.equal(s.phase, "aimY");
  s = { ...s, craneY: target.y };
  s = crane.stopCrane(s);
  assert.equal(s.phase, "dropping");
  assert.equal(s.grabX, target.x);
  assert.equal(s.grabY, target.y);
  for (let i = 0; i < 9; i++) s = crane.stepCrane(s, 100);
  assert.equal(s.phase, "done");
  assert.equal(s.result.prizeId, target.id);
  // done のあとは進まない
  assert.equal(crane.stepCrane(s, 100), s);
  assert.equal(crane.stopCrane(s), s);

  // 角で止めれば外れる
  let m = { ...base, craneX: 0 };
  m = crane.stopCrane(m);
  m = { ...m, craneY: 0 };
  m = crane.stopCrane(m);
  for (let i = 0; i < 9; i++) m = crane.stepCrane(m, 100);
  assert.equal(m.phase, "done");
  assert.equal(m.result.prizeId, null);
});

// ---------------------------------------------------------------- 椅子取り

const mcMod = mc.gameModule;

test("椅子取り: 3〜8人以外は開始できず、止まる時刻はビューに漏れない", () => {
  assert.throws(() => mcMod.createState(seats(2), makeRng(1), {}));
  assert.throws(() => mcMod.createState(seats(9), makeRng(1), {}));
  const st = mcMod.createState(seats(4), makeRng(3), {});
  assert.equal(st.phase, "playing");
  assert.ok(st.stopAt > Date.now());
  assert.ok(st.stopAt - st.roundStartedAt >= mc.MC_MUSIC_MIN_MS);
  assert.ok(st.stopAt - st.roundStartedAt <= mc.MC_MUSIC_MAX_MS);
  const view = mcMod.viewFor(st, 0);
  assert.equal("stopAt" in view, false);
  assert.equal("rngState" in view, false);
  assert.equal(view.aliveCount, 4);
  assert.equal(view.chairs, 3);
  // 締切前は tick しても同一参照（変化なし）
  assert.equal(mcMod.tick(st, st.stopAt - 1), st);
});

test("椅子取り: 音楽が止まるまでは座れず、全員座ると一番遅い人が脱落する", () => {
  let st = mcMod.createState(seats(3), makeRng(5), {});
  assert.throws(() => mcMod.applyAction(st, 0, { type: "sit" }, makeRng(1)));
  st = mcMod.tick(st, st.stopAt);
  assert.equal(st.phase, "racing");
  assert.equal(st.reactEndsAt, st.stopAt + mc.MC_REACT_LIMIT_MS);
  st = mcMod.applyAction(st, 0, { type: "sit" }, makeRng(1));
  assert.equal(st.phase, "racing");
  assert.throws(() => mcMod.applyAction(st, 0, { type: "sit" }, makeRng(1))); // 二度座りは不可
  st = mcMod.applyAction(st, 1, { type: "sit" }, makeRng(1));
  st = mcMod.applyAction(st, 2, { type: "sit" }, makeRng(1));
  assert.equal(st.phase, "intermission");
  assert.equal(st.lastResult.eliminatedSeat, 2); // 受信順で一番遅い
  assert.equal(st.lastResult.reason, "slowest");
  assert.deepEqual(
    st.lastResult.sits.map((s) => s.seat),
    [0, 1, 2],
  );
  const view = mcMod.viewFor(st, 2);
  assert.equal(view.aliveCount, 2);
  assert.equal(view.you.alive, false);
});

test("椅子取り: 締切までに座れなかった人が最遅扱いで脱落する（同着は seat が大きい方）", () => {
  let st = mcMod.createState(seats(4), makeRng(8), {});
  st = mcMod.tick(st, st.stopAt);
  st = mcMod.applyAction(st, 0, { type: "sit" }, makeRng(1));
  st = mcMod.tick(st, st.reactEndsAt);
  assert.equal(st.phase, "intermission");
  assert.equal(st.lastResult.reason, "nosit");
  assert.deepEqual(st.lastResult.notSat, [1, 2, 3]);
  assert.equal(st.lastResult.eliminatedSeat, 3); // 座れなかった中で seat 最大
});

test("椅子取り: 最後まで進めると優勝者が決まり順位が付く", () => {
  let st = mcMod.createState(seats(4), makeRng(13), {});
  for (let guard = 0; guard < 300 && st.phase !== "finished"; guard++) {
    if (st.phase === "playing") {
      st = mcMod.tick(st, st.stopAt);
    } else if (st.phase === "racing") {
      // 生存者全員を seat 順に座らせる（最後の生存者が毎回脱落する）
      const alive = st.players
        .map((p) => p.seat)
        .filter((s) => !st.leftSeats.includes(s) && !st.eliminatedSeats.includes(s));
      for (const seat of alive) st = mcMod.applyAction(st, seat, { type: "sit" }, makeRng(1));
    } else if (st.phase === "intermission") {
      st = mcMod.tick(st, st.intermissionEndsAt);
    }
  }
  assert.equal(st.phase, "finished");
  assert.equal(st.winnerSeat, 0); // seat 順に座るので最小 seat が残る
  const view = mcMod.viewFor(st, 0);
  assert.equal(view.standings.find((s) => s.seat === 0).rank, 1);
  assert.equal(view.standings.find((s) => s.seat === 1).rank, 2); // 最後に脱落した人
  assert.equal(view.standings.find((s) => s.seat === 3).rank, 4); // 最初に脱落した人
  assert.equal(view.standings.length, 4);
});

test("椅子取り: 退出は脱落扱いで、生存1人で終了する／parseAction の検証", () => {
  let st = mcMod.createState(seats(3), makeRng(21), {});
  st = mcMod.onPlayerLeft(st, 1);
  assert.ok(st.eliminatedSeats.includes(1));
  assert.equal(st.phase, "playing");
  st = mcMod.onPlayerLeft(st, 2);
  assert.equal(st.phase, "finished");
  assert.equal(st.winnerSeat, 0);
  assert.deepEqual(mcMod.parseAction({ type: "sit" }), { type: "sit" });
  assert.equal(mcMod.parseAction({ type: "dance" }), null);
  assert.equal(mcMod.parseAction("sit"), null);
  assert.equal(mcMod.parseAction(null), null);
});

// ---------------------------------------------------------------- ナンジャ増量

test("ナンジャ増量: 生き物は30種で重複がなく、自動名も30件そろっている", () => {
  assert.equal(nanja.NANJA_CREATURES.length, 30);
  const pairs = nanja.NANJA_CREATURES.map((c) => `${c.color}|${c.shape}`);
  assert.equal(new Set(pairs).size, 30);
  const triples = nanja.NANJA_CREATURES.map((c) => `${c.color}|${c.shape}|${c.kana}`);
  assert.equal(new Set(triples).size, 30);
  assert.equal(new Set(nanja.NANJA_CREATURES.map((c) => c.kana)).size, 30);
  const labels = nanja.NANJA_CREATURES.map((c) => c.label);
  assert.equal(new Set(labels).size, 30);
  assert.equal(nanja.NANJA_DEFAULT_NAMES.length, 30);
  assert.equal(new Set(nanja.NANJA_DEFAULT_NAMES).size, 30);
  // 代表例が含まれている（色×形×カナで一意に区別できる）
  assert.ok(nanja.NANJA_CREATURES.some((c) => c.colorName === "あか" && c.shape === "circle" && c.kana === "ア"));
  assert.ok(nanja.NANJA_CREATURES.some((c) => c.colorName === "みどり" && c.shape === "square" && c.kana === "ス"));
  assert.ok(nanja.NANJA_CREATURES.some((c) => c.colorName === "むらさき" && c.shape === "diamond" && c.kana === "ホ"));
});

test("ナンジャ増量: 山札は30種×4枚=120枚で全種そろっている", () => {
  const st = nanja.gameModule.createState(seats(3), makeRng(5), {});
  assert.equal(st.deck.length, 30 * nanja.NANJA_COPIES_PER_CREATURE);
  const counts = new Array(30).fill(0);
  for (const c of st.deck) counts[c]++;
  assert.deepEqual(counts, new Array(30).fill(nanja.NANJA_COPIES_PER_CREATURE));
  // 新種（id 12以降）をめくっても命名フェーズに進み、時間切れで自動名が付く
  let s = { ...st, deck: [17] };
  s = nanja.gameModule.applyAction(s, 0, { type: "flip" }, makeRng(1));
  assert.equal(s.phase, "naming");
  assert.equal(s.namingCreature, 17);
  s = nanja.gameModule.tick(s, s.namingEndsAt + 1);
  assert.equal(s.names[17], nanja.NANJA_DEFAULT_NAMES[17]);
});
