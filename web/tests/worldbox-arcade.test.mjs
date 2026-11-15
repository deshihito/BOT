// AGO WORLD BOX ロビーのアーケード基盤（L1）の検証:
// - ARCADE_GAMES は ONLINE_GAMES 26タイトルとちょうど一致する（欠け・余分なし）
// - 区分の規則（faceoff=2人固定の盤面対戦、party=多人数、realtime=同時進行・時間勝負）
// - 区分内の order は 1 からの連番、スプライト名は arcade_<id> で一意
// - 第1弾（L3）は対面3＋パーティ3
// - 人数・タイトルは registry 側（各ゲームモジュール）が正で、arcade.ts は重複して持たない
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

const arcade = await loadLib("worldbox/arcade.ts");

// registry.ts が import するゲームモジュール名が ONLINE_GAMES の正。
const registrySrc = fs.readFileSync(path.join(libDir, "online/registry.ts"), "utf8");
const registryIds = [...registrySrc.matchAll(/from "\.\/games\/([a-z0-9]+)"/g)].map((m) => m[1]);
assert.equal(registryIds.length, 26, `registry のゲーム数が 26 でない: ${registryIds.length}`);

const modules = new Map();
for (const id of registryIds) {
  const mod = await loadOnline(`${id}.ts`, ["gameModule"]);
  modules.set(mod.gameModule.id, mod.gameModule);
}

test("arcade: 26タイトルと registry がちょうど一致する（欠け・余分なし）", () => {
  assert.equal(arcade.ARCADE_GAMES.length, 26);
  const arcadeIds = arcade.ARCADE_GAMES.map((e) => e.id);
  assert.equal(new Set(arcadeIds).size, 26, "arcade 側に重複 id がある");
  assert.deepEqual([...arcadeIds].sort(), [...modules.keys()].sort());
  // 各モジュールの id・タイトル・人数が読める（registry 側が正）
  for (const [id, gm] of modules) {
    assert.equal(typeof gm.title, "string");
    assert.ok(gm.title.length > 0, `${id} のタイトルが空`);
    assert.ok(Number.isInteger(gm.minPlayers) && gm.minPlayers >= 2, `${id} の minPlayers`);
    assert.ok(Number.isInteger(gm.maxPlayers) && gm.maxPlayers >= gm.minPlayers, `${id} の maxPlayers`);
  }
});

test("arcade: 区分の規則（faceoff=2人固定、party=多人数、realtime=同時進行の4本）", () => {
  const byId = new Map(arcade.ARCADE_GAMES.map((e) => [e.id, e]));
  for (const e of arcade.ARCADE_GAMES) {
    const gm = modules.get(e.id);
    if (e.category === "faceoff") {
      assert.equal(gm.minPlayers, 2, `${e.id} は faceoff なのに min が 2 でない`);
      assert.equal(gm.maxPlayers, 2, `${e.id} は faceoff なのに max が 2 でない`);
    } else if (e.category === "party") {
      assert.ok(gm.maxPlayers >= 4, `${e.id} は party なのに max が 4 未満`);
    }
  }
  assert.deepEqual(
    arcade.ARCADE_GAMES.filter((e) => e.category === "realtime").map((e) => e.id).sort(),
    ["calcrace", "speed", "stopbattle", "typerace"],
  );
  assert.deepEqual(
    arcade.ARCADE_GAMES.filter((e) => e.category === "faceoff").map((e) => e.id).sort(),
    ["battleship", "connect4", "reversi", "territory"],
  );
  assert.equal(arcade.ARCADE_GAMES.filter((e) => e.category === "party").length, 18);
});

test("arcade: 区分内の order は 1 からの連番で重複なし", () => {
  for (const category of ["faceoff", "party", "realtime"]) {
    const orders = arcade.ARCADE_GAMES.filter((e) => e.category === category).map((e) => e.order).sort((a, b) => a - b);
    assert.deepEqual(orders, orders.map((_, i) => i + 1), `${category} の order が連番でない`);
  }
});

test("arcade: スプライト名は arcade_<id> で一意（素材は L3 で作成）", () => {
  const sprites = arcade.ARCADE_GAMES.map((e) => e.sprite);
  assert.equal(new Set(sprites).size, 26);
  for (const e of arcade.ARCADE_GAMES) {
    assert.equal(e.sprite, `arcade_${e.id}`);
    assert.ok(/^[a-z0-9_]+$/.test(e.sprite), `不正なスプライト名: ${e.sprite}`);
  }
  // arcade.ts は人数・タイトルを重複して持たない（registry 側が正）
  const src = fs.readFileSync(path.join(libDir, "worldbox/arcade.ts"), "utf8");
  assert.ok(!src.includes("minPlayers") && !src.includes("maxPlayers"), "人数を arcade.ts に重複させている");
  assert.ok(!src.includes("title:"), "タイトルを arcade.ts に重複させている");
});

test("arcade: 第1弾（L3）は対面3＋パーティ3で、全て registry にある", () => {
  assert.equal(arcade.ARCADE_FIRST_WAVE.length, 6);
  assert.equal(new Set(arcade.ARCADE_FIRST_WAVE).size, 6);
  for (const id of arcade.ARCADE_FIRST_WAVE) assert.ok(modules.has(id), `第1弾に registry 外の id: ${id}`);
  for (const id of ["reversi", "connect4", "battleship"]) assert.ok(arcade.ARCADE_FIRST_WAVE.includes(id), `第1弾に対面の ${id} が無い`);
  const partyWave = arcade.ARCADE_FIRST_WAVE.filter((id) => arcade.arcadeById(id).category === "party");
  assert.equal(partyWave.length, 3);
});

test("arcade: 参照ヘルパー（未知 id は undefined、区分別は order 順）", () => {
  assert.equal(arcade.arcadeById("reversi").category, "faceoff");
  assert.equal(arcade.arcadeById("werewolf").category, "party");
  assert.equal(arcade.arcadeById("speed").category, "realtime");
  assert.equal(arcade.arcadeById("chess"), undefined);
  assert.equal(arcade.arcadeById(""), undefined);
  assert.equal(arcade.arcadeById(42), undefined);
  assert.deepEqual(arcade.arcadeByCategory("faceoff").map((e) => e.id), ["reversi", "connect4", "battleship", "territory"]);
  assert.deepEqual(arcade.arcadeByCategory("realtime").map((e) => e.id), ["speed", "typerace", "calcrace", "stopbattle"]);
  assert.equal(arcade.arcadeByCategory("party").length, 18);
});
