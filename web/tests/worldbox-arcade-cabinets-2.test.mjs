// AGO WORLD BOX ロビーのアーケード筐体配置（L6 第2弾・データ先行）の検証:
// - 残り20タイトル（ARCADE_SECOND_WAVE）が 2F 南弧6台＋3F 14台に 1タイル1ゲームで並ぶ
// - 26タイトル全てが 2F/3F のどこかにちょうど1台ずつ置かれている（重複・欠落なし）
// - 筐体は床の上にあり重ならず、固体で blocked に載る
// - 前列（円の中心側）に立て、入口から届く。列の隙間も歩行可（階段への動線を塞がない）
// - 筐体スプライトは 64x64 RGBA の PNG として存在し、textures.ts に登録済み
// - station "arcade" とゲーム ID が付く（L4 で配線済み）
// - 3F の既存家具（南の休憩コーナー・L5 アンカー本棚）は動かさない
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
function dataUrl(js) {
  return "data:text/javascript;base64," + Buffer.from(js).toString("base64");
}
async function loadLib(name) {
  const src = fs.readFileSync(path.join(libDir, name), "utf8");
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(dataUrl(js));
}

const arcade = await loadLib("worldbox/arcade.ts");
const rngUrl = dataUrl(transpile("worldbox/rng.ts"));
const mapgenUrl = dataUrl(transpile("worldbox/mapgen.ts").replaceAll('"./rng"', JSON.stringify(rngUrl)));
const lobbyUrl = dataUrl(transpile("worldbox/lobby.ts").replaceAll('"./mapgen"', JSON.stringify(mapgenUrl)));
const lobby = await import(lobbyUrl);
const floorsUrl = dataUrl(
  transpile("worldbox/lobby-floors.ts")
    .replaceAll('"./mapgen"', JSON.stringify(mapgenUrl))
    .replaceAll('"./lobby"', JSON.stringify(lobbyUrl)),
);
const floors = await import(floorsUrl);

// 第2弾の配置表: [id, 階, x, y, 前列x, 前列y]（前列は円の中心側）
const SECOND_WAVE_PLACEMENT = [
  // 2F 南弧（y=19、前は北側 y=18）
  ["territory", 2, 15, 19, 15, 18],
  ["drawguess", 2, 17, 19, 17, 18],
  ["daifugo", 2, 19, 19, 19, 18],
  ["babanuki", 2, 21, 19, 21, 18],
  ["quizbattle", 2, 23, 19, 23, 18],
  ["bombpass", 2, 25, 19, 25, 18],
  // 3F 西弧（x=9、前は東側 x=10）
  ["shiritori", 3, 9, 10, 10, 10],
  ["nanja", 3, 9, 12, 10, 12],
  ["liarsdice", 3, 9, 14, 10, 14],
  ["cheat", 3, 9, 16, 10, 16],
  // 3F 東弧（x=23、前は西側 x=22）
  ["hagetaka", 3, 23, 10, 22, 10],
  ["burst", 3, 23, 12, 22, 12],
  ["texas", 3, 23, 14, 22, 14],
  ["countdown", 3, 23, 16, 22, 16],
  // 3F 南弧（y=18、前は北側 y=17）
  ["musicalchairs", 3, 10, 18, 10, 17],
  ["wordbasket", 3, 12, 18, 12, 17],
  ["speed", 3, 20, 18, 20, 17],
  ["typerace", 3, 22, 18, 22, 17],
  // 3F 北デッキ（y=3、前は南側 y=4）
  ["calcrace", 3, 17, 3, 17, 4],
  ["stopbattle", 3, 19, 3, 19, 4],
];

const cabinets2 = () =>
  floors.buildLobby2().objects.filter((o) => o.sprite.startsWith("arcade_"));
const cabinets3 = () =>
  floors.buildLobby3().objects.filter((o) => o.sprite.startsWith("arcade_"));

function walkableTiles(data) {
  const out = new Set();
  for (let y = 0; y < data.height; y++) {
    for (let x = 0; x < data.width; x++) {
      const id = data.tiles[y * data.width + x];
      if (id !== 0 && id !== 1 && !data.blocked.has(`${x},${y}`)) out.add(`${x},${y}`);
    }
  }
  return out;
}
function reachableFrom(data, sx, sy) {
  const walk = walkableTiles(data);
  const seen = new Set([`${sx},${sy}`]);
  const q = [[sx, sy]];
  while (q.length) {
    const [x, y] = q.pop();
    for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
      const k = `${nx},${ny}`;
      if (walk.has(k) && !seen.has(k)) { seen.add(k); q.push([nx, ny]); }
    }
  }
  return seen;
}

test("cabinets2: 第2弾20台が配置表どおり 2F 南弧6台＋3F 14台に並ぶ", () => {
  assert.deepEqual(
    [...arcade.ARCADE_SECOND_WAVE],
    SECOND_WAVE_PLACEMENT.map(([id]) => id),
    "配置表の並びが ARCADE_SECOND_WAVE と違う",
  );
  assert.equal(SECOND_WAVE_PLACEMENT.length, 20, "第2弾が20台でない");
  const cabs2 = cabinets2();
  assert.equal(cabs2.length, 12, `2F の筐体が12台でない: ${cabs2.map((o) => o.sprite).join(",")}`);
  const ids2 = cabs2.map((o) => o.sprite.slice("arcade_".length));
  assert.deepEqual(ids2, [...arcade.ARCADE_FIRST_WAVE, ...arcade.ARCADE_SECOND_WAVE_2F]);
  const cabs3 = cabinets3();
  assert.equal(cabs3.length, 14, `3F の筐体が14台でない: ${cabs3.map((o) => o.sprite).join(",")}`);
  const ids3 = cabs3.map((o) => o.sprite.slice("arcade_".length));
  assert.deepEqual(ids3, [...arcade.ARCADE_SECOND_WAVE_3F]);
  for (const [id, floor, x, y] of SECOND_WAVE_PLACEMENT) {
    const cabs = floor === 2 ? cabs2 : cabs3;
    const found = cabs.find((o) => o.sprite === `arcade_${id}`);
    assert.ok(found, `arcade_${id} が ${floor}F に置かれていない`);
    assert.equal(found.x, x, `arcade_${id} の x が ${x} でない`);
    assert.equal(found.y, y, `arcade_${id} の y が ${y} でない`);
    assert.ok(found.w === 1 && found.h === 1, `arcade_${id} が 1タイルでない`);
  }
});

test("cabinets2: 26タイトル全てが 2F/3F のどこかにちょうど1台ずつある", () => {
  const placed = [...cabinets2(), ...cabinets3()].map((o) => o.sprite.slice("arcade_".length));
  assert.equal(placed.length, 26, `筐体が26台でない: ${placed.length}`);
  assert.deepEqual(
    [...placed].sort(),
    [...arcade.ARCADE_GAMES.map((e) => e.id)].sort(),
    "置かれた筐体と ARCADE_GAMES 26タイトルが一致しない",
  );
  assert.equal(new Set(placed).size, 26, "筐体が重複している");
});

test("cabinets2: 筐体は床の上にあり重ならず、固体で blocked に載る", () => {
  for (const [floor, data] of [[2, floors.buildLobby2()], [3, floors.buildLobby3()]]) {
    const seen = new Set();
    for (const o of data.objects.filter((ob) => ob.sprite.startsWith("arcade_"))) {
      const tile = data.tiles[o.y * data.width + o.x];
      assert.notEqual(tile, 0, `${o.sprite} (${o.x},${o.y}) が虚空の上にある`);
      assert.notEqual(tile, lobby.L_WALL, `${o.sprite} (${o.x},${o.y}) が壁の上にある`);
      assert.ok(!seen.has(`${o.x},${o.y}`), `${o.sprite} が重なっている`);
      seen.add(`${o.x},${o.y}`);
      assert.equal(o.solid, true, `${o.sprite} が固体でない`);
      assert.ok(data.blocked.has(`${o.x},${o.y}`), `${o.sprite} が blocked に載っていない`);
    }
  }
  // 2F 南弧はカーペット、3F 西・東・南弧は大理石/広場、北デッキは木の上
  const data2 = floors.buildLobby2();
  for (const o of cabinets2().filter((c) => c.y === 19)) {
    assert.equal(data2.tiles[o.y * data2.width + o.x], lobby.L_CARPET, `${o.sprite} がカーペットの上でない`);
  }
});

test("cabinets2: 前列（円の中心側）に立て、入口から届く。列の隙間も歩行可", () => {
  const data2 = floors.buildLobby2();
  const reach2 = reachableFrom(data2, Math.floor(floors.LOBBY2_ENTRY.x), Math.floor(floors.LOBBY2_ENTRY.y));
  const walk2 = walkableTiles(data2);
  const data3 = floors.buildLobby3();
  const reach3 = reachableFrom(data3, Math.floor(floors.LOBBY3_ENTRY.x), Math.floor(floors.LOBBY3_ENTRY.y));
  const walk3 = walkableTiles(data3);
  for (const [id, floor, , , fx, fy] of SECOND_WAVE_PLACEMENT) {
    const walk = floor === 2 ? walk2 : walk3;
    const reach = floor === 2 ? reach2 : reach3;
    assert.ok(walk.has(`${fx},${fy}`), `arcade_${id} の前 (${fx},${fy}) に立てない`);
    assert.ok(reach.has(`${fx},${fy}`), `arcade_${id} の前 (${fx},${fy}) に入口から行けない`);
  }
  // 2F 南弧の隙間（x=16,18,20,22,24）は通路として歩行可で、南踊り場への動線を塞がない
  for (const x of [16, 18, 20, 22, 24]) {
    assert.ok(walk2.has(`${x},19`), `2F 南弧の隙間 (${x},19) が歩行不可`);
    assert.ok(reach2.has(`${x},19`), `2F 南弧の隙間 (${x},19) に入口から行けない`);
  }
  assert.ok(reach2.has("19,22"), "2F 南弧の先の南踊り場に入口から行けない");
  // 3F 西・東弧の隙間（y=11,13,15）は通路として歩行可
  for (const y of [11, 13, 15]) {
    assert.ok(walk3.has(`9,${y}`), `3F 西弧の隙間 (9,${y}) が歩行不可`);
    assert.ok(reach3.has(`9,${y}`), `3F 西弧の隙間 (9,${y}) に入口から行けない`);
    assert.ok(walk3.has(`23,${y}`), `3F 東弧の隙間 (23,${y}) が歩行不可`);
    assert.ok(reach3.has(`23,${y}`), `3F 東弧の隙間 (23,${y}) に入口から行けない`);
  }
  // 3F 南弧の隙間（x=11,13..19,21）は歩行可で、南の休憩コーナーへ行ける
  for (const x of [11, 14, 16, 19, 21]) {
    assert.ok(walk3.has(`${x},18`), `3F 南弧の隙間 (${x},18) が歩行不可`);
    assert.ok(reach3.has(`${x},18`), `3F 南弧の隙間 (${x},18) に入口から行けない`);
  }
  assert.ok(reach3.has("17,19"), "3F 南の休憩コーナーに入口から行けない");
  // 3F 北デッキの階段（15,3)(16,3）と入口（15,5）が塞がれていない
  assert.ok(reach3.has("15,3"), "3F の階段に入口から行けない");
  assert.ok(reach3.has("16,5"), "3F の入口付近に立てない");
});

test("cabinets2: スプライト PNG が 64x64 RGBA で存在し、textures.ts に登録されている", () => {
  const spriteDir = path.join(rootDir, "public/img/worldbox/lobby");
  const texturesSrc = fs.readFileSync(path.join(libDir, "worldbox/textures.ts"), "utf8");
  for (const id of arcade.ARCADE_SECOND_WAVE) {
    const name = `arcade_${id}`;
    const file = path.join(spriteDir, `${name}.png`);
    assert.ok(fs.existsSync(file), `スプライトが無い: ${name}.png`);
    const buf = fs.readFileSync(file);
    assert.deepEqual([...buf.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], `${name} が PNG でない`);
    assert.equal(buf.readUInt32BE(16), 64, `${name} の幅が 64 でない`);
    assert.equal(buf.readUInt32BE(20), 64, `${name} の高さが 64 でない`);
    assert.equal(buf[24], 8, `${name} のビット深度が 8 でない`);
    assert.equal(buf[25], 6, `${name} が RGBA でない`);
    assert.ok(
      texturesSrc.includes(`${name}: "/img/worldbox/lobby/${name}.png"`),
      `${name} が LOBBY_SPRITE_SRC に登録されていない`,
    );
  }
});

test("cabinets2: 筐体に station arcade とゲーム ID が付いている（L4）", () => {
  for (const o of [...cabinets2(), ...cabinets3()]) {
    assert.equal(o.station, "arcade", `${o.sprite} に station arcade が付いていない`);
    assert.equal(o.arcade, o.sprite.slice("arcade_".length), `${o.sprite} のゲーム ID がスプライト名と一致しない`);
  }
});

test("cabinets2: 3F の既存家具は動いていない（南の休憩コーナー・L5 アンカー本棚）", () => {
  const data3 = floors.buildLobby3();
  const byPos = new Map(data3.objects.map((o) => [`${o.x},${o.y}`, o.sprite]));
  assert.equal(byPos.get("14,19"), "sofa", "3F 南の休憩ソファが動いている");
  assert.equal(byPos.get("15,19"), "table_round", "3F 南の休憩テーブルが動いている");
  assert.equal(byPos.get("18,19"), "bookshelf", "3F 南の休憩本棚が動いている");
  assert.equal(byPos.get("13,4"), "bookshelf", "L5 アンカー本棚 (13,4) が動いている");
  assert.equal(byPos.get("14,4"), "bookshelf", "L5 アンカー本棚 (14,4) が動いている");
  assert.equal(byPos.get("15,3"), "stairs", "3F の階段が動いている");
});
