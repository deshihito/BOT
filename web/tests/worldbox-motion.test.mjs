// AGO WORLD BOX 移動の手触りの検証:
// - スタミナ（消費・回復遅延・空封じ・帰還後の下限）
// - ダッシュ入力（スティックの強い倒し / キー2度押し）
// - 泳ぎ（swim オプションで水に入れる。他の固体は従来通り）
// - 他プレイヤー描画（バネ追従で飛ばない・ワープ時だけ即合わせ・外挿は頭打ち）
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
    out.push(
      line
        .replace(/^export\s+(?=(const|let|var|function|class)\s)/, "")
        .replace(/^export\s+(?=async\s+function)/, "")
        .replace(/^export\s*\{[^}]*\};?\s*$/, ""),
    );
  }
  return out.join("\n");
}

function dataUrl(js) {
  return "data:text/javascript;base64," + Buffer.from(js).toString("base64");
}

async function loadBundle(files, exportNames) {
  const code =
    files.map((name) => stripModuleSyntax(transpile(name))).join("\n") +
    `\nexport { ${exportNames.join(", ")} };\n`;
  return import(dataUrl(code));
}

const st = await loadBundle(
  ["worldbox/stamina.ts"],
  [
    "STAMINA_MAX", "DASH_DRAIN_PER_SEC", "SWIM_DRAIN_PER_SEC", "SWIM_DASH_DRAIN_PER_SEC",
    "STAMINA_REGEN_PER_SEC", "STAMINA_REGEN_DELAY_SEC", "DASH_RELOCK_STAMINA", "SWIM_RESCUE_STAMINA",
    "createStamina", "staminaDrainRate", "canDash", "stepStamina", "rescueStamina",
    "staminaGaugeVisible", "isStickDash", "createTapTracker", "registerKeyTap",
  ],
);

const mv = await loadBundle(
  ["worldbox/rng.ts", "worldbox/mapgen.ts", "worldbox/move.ts"],
  [
    "T_GRASS", "T_WATER", "T_TREE", "WALK_SPEED", "SWIM_SPEED", "DASH_SPEED", "tilesSource",
    "stepMove", "canStandAt", "findFreeNear", "isWaterAt",
  ],
);

const rm = await loadBundle(
  ["worldbox/presence.ts", "worldbox/remote.ts"],
  [
    "REMOTE_SNAP_DISTANCE", "createRemoteTrack", "updateRemoteTrack", "stepRemoteTrack", "predictPosition",
  ],
);

// ---------- スタミナ ----------

test("stamina: 初期状態は満タンでダッシュ可、ゲージは隠れる", () => {
  const s = st.createStamina();
  assert.equal(s.value, st.STAMINA_MAX);
  assert.equal(st.canDash(s), true);
  assert.equal(st.staminaGaugeVisible(s), false);
});

test("stamina: 使い道ごとの消費レート", () => {
  assert.equal(st.staminaDrainRate("dash"), st.DASH_DRAIN_PER_SEC);
  assert.equal(st.staminaDrainRate("swim"), st.SWIM_DRAIN_PER_SEC);
  assert.equal(st.staminaDrainRate("swimDash"), st.SWIM_DASH_DRAIN_PER_SEC);
  assert.ok(st.SWIM_DASH_DRAIN_PER_SEC > st.DASH_DRAIN_PER_SEC, "ダッシュ泳ぎは陸ダッシュより速く減る");
  assert.ok(st.SWIM_DRAIN_PER_SEC < st.DASH_DRAIN_PER_SEC, "泳ぎはダッシュよりゆっくり減る");
  const dash = st.stepStamina(st.createStamina(), "dash", 1).state;
  assert.equal(dash.value, st.STAMINA_MAX - st.DASH_DRAIN_PER_SEC);
  const swim = st.stepStamina(st.createStamina(), "swim", 2).state;
  assert.equal(swim.value, st.STAMINA_MAX - st.SWIM_DRAIN_PER_SEC * 2);
});

test("stamina: 空になった瞬間に emptied が立ち、ダッシュ封じになる", () => {
  let s = { value: 10, exhausted: false, idleSec: 0 };
  const r1 = st.stepStamina(s, "dash", 0.2);
  assert.equal(r1.emptied, false);
  assert.ok(r1.state.value > 0);
  const r2 = st.stepStamina(r1.state, "dash", 1);
  assert.equal(r2.emptied, true);
  assert.equal(r2.state.value, 0);
  assert.equal(r2.state.exhausted, true);
  assert.equal(st.canDash(r2.state), false);
  // 泳ぎで空にしても同じく封じられる
  const r3 = st.stepStamina({ value: 3, exhausted: false, idleSec: 0 }, "swim", 1);
  assert.equal(r3.emptied, true);
  assert.equal(r3.state.exhausted, true);
});

test("stamina: 回復は遅延の後に始まり、満タンで止まる", () => {
  let s = { value: 50, exhausted: false, idleSec: 0 };
  s = st.stepStamina(s, "none", 0.5).state;
  assert.equal(s.value, 50, "遅延内は回復しない");
  s = st.stepStamina(s, "none", 0.5).state;
  const expected = 50 + st.STAMINA_REGEN_PER_SEC * (1.0 - st.STAMINA_REGEN_DELAY_SEC);
  assert.ok(Math.abs(s.value - expected) < 1e-9, `遅延超過ぶんだけ回復する: ${s.value} != ${expected}`);
  const full = st.stepStamina({ value: 99, exhausted: false, idleSec: 5 }, "none", 5).state;
  assert.equal(full.value, st.STAMINA_MAX);
});

test("stamina: 空封じは DASH_RELOCK_STAMINA まで回復すると解ける", () => {
  let s = { value: 0, exhausted: true, idleSec: 0 };
  assert.equal(st.canDash(s), false);
  for (let i = 0; i < 40; i++) s = st.stepStamina(s, "none", 0.1).state;
  assert.ok(s.value >= st.DASH_RELOCK_STAMINA);
  assert.equal(s.exhausted, false);
  assert.equal(st.canDash(s), true);
});

test("stamina: 水中帰還後は下限値が置かれ、ダッシュ封じが続く", () => {
  const s = st.rescueStamina({ value: 0, exhausted: true, idleSec: 0 });
  assert.equal(s.value, st.SWIM_RESCUE_STAMINA);
  assert.equal(s.exhausted, true);
  assert.equal(st.canDash(s), false);
  assert.equal(st.staminaGaugeVisible(s), true);
});

test("stamina: ゲージは減っている間と使った直後だけ出る", () => {
  assert.equal(st.staminaGaugeVisible({ value: 40, exhausted: false, idleSec: 99 }), true);
  assert.equal(st.staminaGaugeVisible({ value: st.STAMINA_MAX, exhausted: false, idleSec: 0 }), true);
  assert.equal(st.staminaGaugeVisible({ value: st.STAMINA_MAX, exhausted: false, idleSec: 99 }), false);
});

// ---------- ダッシュ入力 ----------

test("dash入力: スティックは閾値を超えた倒しだけダッシュ", () => {
  assert.equal(st.isStickDash(0.86, 0), true);
  assert.equal(st.isStickDash(0.85, 0), false);
  assert.equal(st.isStickDash(0.6, 0.6), false);
  assert.equal(st.isStickDash(0.7, 0.7), true);
  assert.equal(st.isStickDash(0, 0), false);
  assert.equal(st.isStickDash(0.3, 0.2), false);
});

test("dash入力: 同じキーの2度押し（300ms以内）だけダッシュ", () => {
  let tr = st.createTapTracker();
  let r = st.registerKeyTap(tr, "w", 1000);
  tr = r.tracker;
  assert.equal(r.doubleTapped, false);
  r = st.registerKeyTap(tr, "w", 1250);
  tr = r.tracker;
  assert.equal(r.doubleTapped, true, "250ms後の再押しは2度押し");
  r = st.registerKeyTap(tr, "w", 2000);
  tr = r.tracker;
  assert.equal(r.doubleTapped, false, "750ms空くと2度押しでない");
  r = st.registerKeyTap(tr, "a", 2100);
  tr = r.tracker;
  assert.equal(r.doubleTapped, false, "別のキーは2度押しでない");
  r = st.registerKeyTap(tr, "a", 2300);
  assert.equal(r.doubleTapped, true);
});

// ---------- 泳ぎ（移動） ----------

function tinyMap() {
  const tiles = new Uint8Array(36).fill(mv.T_GRASS);
  for (const [x, y] of [[2, 2], [3, 2], [2, 3], [3, 3]]) tiles[y * 6 + x] = mv.T_WATER;
  tiles[2 * 6 + 4] = mv.T_TREE;
  return mv.tilesSource(0, 6, 6, tiles);
}

test("swim: オプションなしでは水に入れない", () => {
  const map = tinyMap();
  const r = mv.stepMove(map, { x: 1.5, y: 2.5 }, { x: mv.WALK_SPEED, y: 0 }, 0.5);
  assert.equal(r.hitX, true);
  assert.equal(r.x, 1.5);
  assert.equal(mv.canStandAt(map, 2.5, 2.5), false);
  assert.equal(mv.isWaterAt(map, 2.5, 2.5), true);
});

test("swim: オプションありでは水に入って進める", () => {
  const map = tinyMap();
  const r = mv.stepMove(map, { x: 1.5, y: 2.5 }, { x: mv.SWIM_SPEED, y: 0 }, 0.5, undefined, { swim: true });
  assert.equal(r.hitX, false);
  assert.ok(Math.abs(r.x - 3.0) < 1e-9);
  assert.equal(mv.isWaterAt(map, r.x, r.y), true);
  assert.equal(mv.canStandAt(map, 2.5, 2.5, undefined, { swim: true }), true);
});

test("swim: 泳ぎ中も木などの固体にはぶつかる", () => {
  const map = tinyMap();
  const r = mv.stepMove(map, { x: 3.5, y: 2.5 }, { x: mv.SWIM_SPEED, y: 0 }, 0.5, undefined, { swim: true });
  assert.equal(r.hitX, true);
  assert.equal(r.x, 3.5);
});

test("swim: findFreeNear は泳ぎ可なら水上をそのまま認める", () => {
  const map = tinyMap();
  const inWater = mv.findFreeNear(map, 2.5, 2.5, undefined, { swim: true });
  assert.deepEqual(inWater, { x: 2.5, y: 2.5 });
  const rescued = mv.findFreeNear(map, 2.5, 2.5);
  assert.equal(mv.isWaterAt(map, rescued.x, rescued.y), false);
});

// ---------- 他プレイヤーの描画補間 ----------

const BOUNDS = { minX: 0, maxX: 1024, minY: 0, maxY: 1024 };
const entry = (x, y, vx, vy, ts, face = 1) => ({ id: "a", name: "n", x, y, vx, vy, face, space: "world", ts });

test("remote: 初見は予測位置から始まる", () => {
  const tr = rm.createRemoteTrack(entry(10, 10, 0, 0, 1000), 1000, BOUNDS);
  assert.equal(tr.rx, 10);
  assert.equal(tr.ry, 10);
});

test("remote: 歩行中の更新では描画位置が飛ばず、なめらかに追いつく", () => {
  let tr = rm.createRemoteTrack(entry(10, 10, 4.4, 0, 0), 0, BOUNDS);
  let maxStep = 0;
  let prevX = tr.rx;
  for (let t = 0; t <= 2000; t += 1000 / 60) {
    tr = rm.stepRemoteTrack(tr, t, 1 / 60, BOUNDS);
    maxStep = Math.max(maxStep, Math.abs(tr.rx - prevX));
    prevX = tr.rx;
  }
  assert.ok(maxStep < 0.35, `1フレームで飛びすぎ: ${maxStep}`);
  // 外挿は2秒で頭打ち → 目標は 10 + 4.4*2 = 18.8（目標が動き続けるため寄せは緩めに見る）
  assert.ok(Math.abs(tr.rx - 18.8) < 0.9, `外挿目標へ寄っていない: ${tr.rx}`);
  // 新しいスナップショット（2秒時点で 18.8）を受けても描画位置はその場で動かない
  const before = tr.rx;
  tr = rm.updateRemoteTrack(tr, entry(18.8, 10, 4.4, 0, 2000), 2000, BOUNDS);
  assert.equal(tr.rx, before);
  // その後もなめらかに追い続ける
  for (let t = 2000; t <= 3000; t += 1000 / 60) {
    tr = rm.stepRemoteTrack(tr, t, 1 / 60, BOUNDS);
    assert.ok(Math.abs(tr.rx - prevX) < 0.35, "更新後も飛ばない");
    prevX = tr.rx;
  }
  assert.ok(Math.abs(tr.rx - 23.2) < 0.8, `新しい予測へ寄っていない: ${tr.rx}`);
});

test("remote: 大きく離れた更新（ワープ）は即座に合わせる", () => {
  let tr = rm.createRemoteTrack(entry(10, 10, 0, 0, 0), 0, BOUNDS);
  tr = rm.updateRemoteTrack(tr, entry(10 + rm.REMOTE_SNAP_DISTANCE + 12, 10, 0, 0, 100), 100, BOUNDS);
  assert.equal(tr.rx, 10 + rm.REMOTE_SNAP_DISTANCE + 12);
  assert.equal(tr.ry, 10);
});

test("remote: 外挿は頭打ちになり、止まった相手はその場に収まる", () => {
  let tr = rm.createRemoteTrack(entry(10, 10, 4.4, 0, 0), 0, BOUNDS);
  for (let i = 0; i < 120; i++) tr = rm.stepRemoteTrack(tr, 10_000, 1 / 60, BOUNDS);
  assert.ok(Math.abs(tr.rx - 18.8) < 0.3, `頭打ち位置に収まっていない: ${tr.rx}`);
  assert.ok(tr.rx < 19.1);
});

test("remote: 向きはスナップショットの face がそのまま使われる", () => {
  let tr = rm.createRemoteTrack(entry(10, 10, 0, 0, 0, -1), 0, BOUNDS);
  assert.equal(tr.entry.face, -1);
  tr = rm.updateRemoteTrack(tr, entry(11, 10, 1, 0, 100, 1), 100, BOUNDS);
  assert.equal(tr.entry.face, 1);
});

// ---------- クライアント配線 ----------

test("クライアント: スタミナ・ダッシュ・泳ぎ・補間が配線されている", () => {
  const client = fs.readFileSync(path.join(rootDir, "app/games/worldbox/WorldBoxClient.tsx"), "utf8");
  for (const needle of [
    "stepStamina", "canDash", "isStickDash", "registerKeyTap", "rescueStamina",
    "staminaGaugeVisible", "createRemoteTrack", "updateRemoteTrack", "stepRemoteTrack",
    "isWaterAt", "SWIM_SPEED", "DASH_SPEED",
  ]) {
    assert.ok(client.includes(needle), `クライアントに ${needle} が無い`);
  }
  assert.ok(client.includes('{ swim: space === "world" }'), "ワールドでのみ泳ぎが有効になっていない");
});
