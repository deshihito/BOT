// AGO WORLD BOX ロビーのアーケード筐体配置（L3・データ先行）の検証:
// - 第1弾6台（ARCADE_FIRST_WAVE）が 2F ラウンジ北弧に 1タイル1ゲームで並ぶ
// - 筐体はラウンジのカーペットの床の上にあり重ならず、固体で blocked に載る
// - 南側の前列（y=10）に立て、入口から届く。列の隙間も歩行可（北踊り場への動線を塞がない）
// - 筐体スプライトは 64x64 RGBA の PNG として存在し、textures.ts に登録済み
// - station "arcade" とゲーム ID が付く（L4 で配線済み）
// - 第1弾以外のアーケード筐体は 2F 南弧の第2弾6台だけ（3F の14台は cabinets-2 で検証）
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

const cabinets = () =>
  floors.buildLobby2().objects.filter((o) => o.sprite.startsWith("arcade_") && o.y === 9);

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

test("cabinets: 2F に第1弾6台が ARCADE_FIRST_WAVE の順に北弧へ並ぶ", () => {
  const cabs = cabinets();
  assert.equal(cabs.length, 6, `筐体が6台でない: ${cabs.map((o) => o.sprite).join(",")}`);
  const ids = cabs.map((o) => o.sprite.slice("arcade_".length));
  assert.deepEqual(ids, [...arcade.ARCADE_FIRST_WAVE], "筐体の並びが第1弾の順と違う");
  // 左から右へ 1 マス空けで並ぶ（カジノの機器列と同じ間隔）
  assert.deepEqual(cabs.map((o) => o.x), [15, 17, 19, 21, 23, 25]);
  assert.ok(cabs.every((o) => o.y === 9), "筐体が北弧の y=9 に無い");
  assert.ok(cabs.every((o) => o.w === 1 && o.h === 1), "筐体が 1タイルでない");
});

test("cabinets: 筐体はラウンジのカーペットの床の上にあり重ならず、固体で blocked に載る", () => {
  const data = floors.buildLobby2();
  const seen = new Set();
  for (const o of cabinets()) {
    const tile = data.tiles[o.y * data.width + o.x];
    assert.equal(tile, lobby.L_CARPET, `${o.sprite} (${o.x},${o.y}) がカーペットの上でない: ${tile}`);
    assert.ok(!seen.has(`${o.x},${o.y}`), `${o.sprite} が重なっている`);
    seen.add(`${o.x},${o.y}`);
    assert.equal(o.solid, true, `${o.sprite} が固体でない`);
    assert.ok(data.blocked.has(`${o.x},${o.y}`), `${o.sprite} が blocked に載っていない`);
  }
});

test("cabinets: 南側の前列（y=10）に立て、入口から届く。列の隙間も歩行可", () => {
  const data = floors.buildLobby2();
  const reach = reachableFrom(data, Math.floor(floors.LOBBY2_ENTRY.x), Math.floor(floors.LOBBY2_ENTRY.y));
  const walk = walkableTiles(data);
  for (const o of cabinets()) {
    const front = `${o.x},${o.y + 1}`;
    assert.ok(walk.has(front), `${o.sprite} の前 (${front}) に立てない`);
    assert.ok(reach.has(front), `${o.sprite} の前 (${front}) に入口から行けない`);
  }
  // 隙間（x=16,18,20,22,24）は通路として歩行可で、北踊り場への動線を塞がない
  for (const x of [16, 18, 20, 22, 24]) {
    assert.ok(walk.has(`${x},9`), `筐体列の隙間 (${x},9) が歩行不可`);
    assert.ok(reach.has(`${x},9`), `筐体列の隙間 (${x},9) に入口から行けない`);
  }
  assert.ok(reach.has("19,6"), "筐体列の先の北踊り場に入口から行けない");
});

test("cabinets: スプライト PNG が 64x64 RGBA で存在し、textures.ts に登録されている", () => {
  const spriteDir = path.join(rootDir, "public/img/worldbox/lobby");
  const texturesSrc = fs.readFileSync(path.join(libDir, "worldbox/textures.ts"), "utf8");
  for (const id of arcade.ARCADE_FIRST_WAVE) {
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

test("cabinets: 筐体に station arcade とゲーム ID が付いている（L4）", () => {
  for (const o of cabinets()) {
    assert.equal(o.station, "arcade", `${o.sprite} に station arcade が付いていない`);
    assert.equal(o.arcade, o.sprite.slice("arcade_".length), `${o.sprite} のゲーム ID がスプライト名と一致しない`);
  }
});

test("cabinets: 第1弾以外のアーケード筐体は 2F 南弧の第2弾6台だけ", () => {
  const data = floors.buildLobby2();
  const placed = new Set(data.objects.filter((o) => o.sprite.startsWith("arcade_")).map((o) => o.sprite));
  assert.deepEqual(
    [...placed].sort(),
    [...arcade.ARCADE_FIRST_WAVE, ...arcade.ARCADE_SECOND_WAVE_2F]
      .map((id) => `arcade_${id}`)
      .sort(),
  );
  assert.equal(placed.size, 12);
});
