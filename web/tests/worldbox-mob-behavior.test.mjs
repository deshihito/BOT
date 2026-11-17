// AGO WORLD BOX モブ行動（mob-behavior.ts）のテスト。
// - 全種 locomotion、全敵対パターン、ボスは3つ以上
// - 状態機械: alert→chase→windup（予兆）→strike→recover→chase、クールダウン、リーシュ帰還
// - 逃走（非敵対）と provoked（中立の敵対化）
// - locomotionPose の形
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const rootDir = path.join(import.meta.dirname, "..");
const libDir = path.join(rootDir, "lib");

function transpile(name, base = libDir) {
  const src = fs.readFileSync(path.join(base, name), "utf8");
  return ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}

function stripModuleSyntax(code) {
  const lines = code.split("\n");
  const out = [];
  let skippingImport = false;
  for (const line of lines) {
    if (skippingImport) {
      if (line.includes(";")) skippingImport = false;
      continue;
    }
    if (/^import\s/.test(line)) {
      if (!line.includes(";")) skippingImport = true;
      continue;
    }
    out.push(line.replace(/^export\s+/, ""));
  }
  return out.join("\n");
}

function bundleModule(files, names) {
  const code = files.map((name) => stripModuleSyntax(transpile(name))).join("\n");
  return "data:text/javascript;base64," + Buffer.from(`${code}\nexport { ${names.join(", ")} };`).toString("base64");
}

const url = bundleModule(
  ["worldbox/rng.ts", "worldbox/mapgen.ts", "worldbox/maplogic.ts", "worldbox/items.ts", "worldbox/mobs.ts", "worldbox/mob-behavior.ts"],
  [
    "MOBS", "mobById",
    "MOB_LOCOMOTION", "locomotionFor", "locomotionPose", "LOCOMOTION_SPEED", "MOB_SPEED_MUL",
    "PATTERN_DEF", "MOB_PATTERNS", "patternsFor", "isBossMob", "validateMobBehavior",
    "createBehaviorState", "stepMobBehavior", "AGGRO_RANGE", "LEASH_DISTANCE", "mobBaseSpeed",
  ],
);
const B = await import(url);

const rng = () => 0.5;
function input(def, over = {}) {
  return {
    def, now: 0, pos: { x: 10.5, y: 10.5 }, anchor: { x: 10.5, y: 10.5 },
    player: { x: 12.5, y: 10.5 }, fleeing: false, provoked: false, hpFrac: 1, rng,
    ...over,
  };
}

test("割当: 全種 locomotion、全敵対にパターン、ボスは3つ以上", () => {
  assert.deepEqual(B.validateMobBehavior(B.MOBS), []);
  assert.equal(Object.keys(B.MOB_LOCOMOTION).length, B.MOBS.length);
  for (const def of B.MOBS) {
    assert.ok(B.locomotionFor(def.id), def.id);
    if (def.temperament === "hostile") assert.ok(B.patternsFor(def).length >= 1, def.id);
    if (B.isBossMob(def)) assert.ok(B.patternsFor(def).length >= 3, def.id);
  }
  // ボス級の顔ぶれ
  for (const id of ["ogre", "dungeon_dragon", "sea_serpent", "spider_queen", "giant_golem", "giant", "world_dragon", "treant"]) {
    assert.ok(B.isBossMob(B.mobById(id)), id);
  }
  assert.ok(!B.isBossMob(B.mobById("wolf")));
  // locomotion の代表例
  assert.equal(B.locomotionFor("frog"), "hop");
  assert.equal(B.locomotionFor("bee"), "flutter");
  assert.equal(B.locomotionFor("fish_blue"), "swim");
  assert.equal(B.locomotionFor("sea_serpent"), "slither");
  assert.equal(B.locomotionFor("snail"), "crawl");
  assert.ok(B.mobBaseSpeed(B.mobById("snail")) < B.mobBaseSpeed(B.mobById("rabbit")), "カタツムリは遅い");
  assert.ok(B.mobBaseSpeed(B.mobById("world_dragon")) < B.mobBaseSpeed(B.mobById("wolf")), "大型は遅い");
});

test("状態機械: 敵対は alert→chase→windup（予兆イベント）→strike→recover→chase", () => {
  const wolf = B.mobById("wolf");
  let st = B.createBehaviorState(10.5, 10.5);
  let out = B.stepMobBehavior(st, input(wolf, { now: 0 }));
  assert.equal(out.state.mode, "alert");
  out = B.stepMobBehavior(out.state, input(wolf, { now: 400 }));
  assert.equal(out.state.mode, "chase");
  // chase: プレイヤーへ移動
  assert.ok(out.speed > 0);
  // パターン範囲内（距離2）なので windup に入り予兆イベントが出る
  out = B.stepMobBehavior(out.state, input(wolf, { now: 500 }));
  assert.equal(out.state.mode, "windup");
  assert.equal(out.state.pattern, "lunge_bite");
  assert.ok(out.events.some((e) => e.kind === "telegraph" && e.pattern === "lunge_bite"));
  assert.equal(out.speed, 0, "windup 中は静止（予兆）");
  // windup 終了で strike（dash: 高速で目標へ）
  out = B.stepMobBehavior(out.state, input(wolf, { now: 500 + B.PATTERN_DEF.lunge_bite.windupMs + 1 }));
  assert.equal(out.state.mode, "strike");
  assert.ok(out.events.some((e) => e.kind === "strike"));
  assert.ok(out.speed > 3, "突進は高速");
  // strike 終了で recover、recover 終了で chase へ戻る
  out = B.stepMobBehavior(out.state, input(wolf, { now: 2000 }));
  assert.equal(out.state.mode, "recover");
  out = B.stepMobBehavior(out.state, input(wolf, { now: 2000 + B.PATTERN_DEF.lunge_bite.recoverMs + 1 }));
  assert.equal(out.state.mode, "chase");
  // クールダウン中は同じパターンが即再発しない
  const out2 = B.stepMobBehavior(out.state, input(wolf, { now: 2700 }));
  assert.notEqual(out2.state.mode, "windup");
});

test("状態機械: 凍結中は行動が止まり、解除時は残り時間が繰り越される", () => {
  const wolf = B.mobById("wolf");
  let st = B.createBehaviorState(10.5, 10.5);
  let out = B.stepMobBehavior(st, input(wolf, { now: 0 }));
  out = B.stepMobBehavior(out.state, input(wolf, { now: 400 }));
  out = B.stepMobBehavior(out.state, input(wolf, { now: 500 }));
  assert.equal(out.state.mode, "windup");
  const windupUntil = out.state.until;
  // 凍結中: モード不変・速度 0・イベントなし（予兆も突進も進まない）
  out = B.stepMobBehavior(out.state, input(wolf, { now: 600, frozen: true }));
  assert.equal(out.state.mode, "windup");
  assert.equal(out.speed, 0);
  assert.deepEqual(out.events, []);
  out = B.stepMobBehavior(out.state, input(wolf, { now: 5000, frozen: true }));
  assert.equal(out.state.mode, "windup");
  assert.equal(out.speed, 0);
  // 解除: 凍結していた 4400ms ぶん windup の終了時刻が後ろへずれる
  out = B.stepMobBehavior(out.state, input(wolf, { now: 5000, frozen: false }));
  assert.equal(out.state.mode, "windup");
  assert.equal(out.state.until, windupUntil + 4400);
  // ずれた終了時刻を過ぎれば strike へ進む
  out = B.stepMobBehavior(out.state, input(wolf, { now: windupUntil + 4400 + 1 }));
  assert.equal(out.state.mode, "strike");
});

test("状態機械: リーシュで帰還し、アンカー近くで idle に戻る", () => {
  const wolf = B.mobById("wolf");
  let st = B.createBehaviorState(30.5, 10.5);
  const out = B.stepMobBehavior(st, input(wolf, {
    now: 0, pos: { x: 30.5, y: 10.5 }, player: { x: 31.5, y: 10.5 },
  }));
  assert.equal(out.state.mode, "return");
  assert.deepEqual(out.target, { x: 10.5, y: 10.5 });
  const back = B.stepMobBehavior(out.state, input(wolf, { now: 100, pos: { x: 11.2, y: 10.5 }, player: null }));
  assert.equal(back.state.mode, "idle");
});

test("状態機械: 非敵対は逃げ、中立は provoked でパターンを使う", () => {
  const rabbit = B.mobById("rabbit");
  let st = B.createBehaviorState(10.5, 10.5);
  const flee = B.stepMobBehavior(st, input(rabbit, { now: 0, fleeing: true }));
  assert.equal(flee.state.mode, "flee");
  assert.ok(flee.speed > 0);

  const bear = B.mobById("bear"); // neutral、swipe/slam
  st = B.createBehaviorState(10.5, 10.5);
  const calm = B.stepMobBehavior(st, input(bear, { now: 0 }));
  assert.notEqual(calm.state.mode, "alert", "provoked でなければ敵対化しない");
  const prov = B.stepMobBehavior(B.createBehaviorState(10.5, 10.5), input(bear, { now: 0, provoked: true }));
  assert.equal(prov.state.mode, "alert");
});

test("ボス: HP30%未満で怒りイベント＋クールダウン短縮、phase/dive はテレポート", () => {
  const dragon = B.mobById("world_dragon");
  let st = B.createBehaviorState(10.5, 10.5);
  const out = B.stepMobBehavior(st, input(dragon, { now: 0, hpFrac: 0.2, player: { x: 30, y: 30 } }));
  assert.equal(out.state.enraged, true);
  assert.ok(out.events.some((e) => e.kind === "enrage"));

  const ghost = B.mobById("ghost");
  st = B.createBehaviorState(10.5, 10.5);
  let o = B.stepMobBehavior(st, input(ghost, { now: 0, player: { x: 14.5, y: 10.5 } }));
  o = B.stepMobBehavior(o.state, input(ghost, { now: 400, player: { x: 14.5, y: 10.5 } }));
  o = B.stepMobBehavior(o.state, input(ghost, { now: 500, player: { x: 14.5, y: 10.5 } }));
  assert.equal(o.state.mode, "windup");
  assert.equal(o.state.pattern, "phase_strike");
  o = B.stepMobBehavior(o.state, input(ghost, { now: 500 + B.PATTERN_DEF.phase_strike.windupMs + 1, player: { x: 14.5, y: 10.5 } }));
  assert.equal(o.state.mode, "strike");
  assert.ok(o.teleport, "phase_strike はプレイヤー近くへ再出現する");
  assert.ok(Math.hypot(o.teleport.x - 14.5, o.teleport.y - 10.5) < 1.6);
});

test("locomotionPose: hop は跳ね、flutter は浮き、静止は控えめ", () => {
  const hop = B.locomotionPose("hop", Math.PI / 2, true);
  assert.ok(hop.bob > 0.1);
  const flutter = B.locomotionPose("flutter", 0, true);
  assert.ok(flutter.bob > 0.05);
  const idle = B.locomotionPose("walk", 0, false);
  assert.ok(Math.abs(idle.bob) < 0.02);
  const slither = B.locomotionPose("slither", Math.PI / 2, true);
  assert.ok(Math.abs(slither.sway) > 0.05);
});

test("クライアント配線: 状態機械と予兆・投射物の描画が入っている", () => {
  const client = fs.readFileSync(path.join(rootDir, "app/games/worldbox/WorldBoxClient.tsx"), "utf8");
  assert.ok(client.includes("stepMobBehavior"), "状態機械が配線されていない");
  assert.ok(client.includes("mobTelegraphs"), "予兆描画が無い");
  assert.ok(client.includes("mobProjectiles"), "投射物描画が無い");
  assert.ok(client.includes("locomotionPose"), "locomotion 変形が無い");
  assert.ok(client.includes("enraged"), "怒り演出が無い");
  assert.ok(!client.includes('def.temperament === "hostile" && distP < 5'), "旧 think が残っている");
});
