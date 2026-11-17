// AGO WORLD BOX テントの検証:
// - テントが置ける（facility として設置経路に載る）
// - 内装ビルダー（壁・床・出入口・作業台ステーション・固体・到達可能性）
// - セーブ/プレゼンスの tent 空間の往復
// - ステーション検証（station-online）の tent 対応
// - クライアント配線（踏んで入る・出口で戻る・チップ表示）
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

function bundle(names, exportNames) {
  const parts = names.map((n) => stripModuleSyntax(transpile(n)));
  const code = `${parts.join("\n")}\nreturn { ${exportNames.join(", ")} };`;
  return new Function(code)();
}

const world = bundle(
  ["worldbox/mapgen.ts", "worldbox/lobby.ts", "worldbox/tent.ts"],
  ["buildTent", "tentTileAt", "TENT_W", "TENT_H", "TENT_MAX_W", "TENT_MAX_H", "TENT_ENTRY", "TENT_EXIT", "L_WALL", "L_WOOD", "stationNear"],
);

const saveMod = bundle(
  ["worldbox/mapgen.ts", "worldbox/lobby.ts", "worldbox/tent.ts", "worldbox/save.ts"],
  ["serializeSave", "parseSave"],
);

const presenceMod = bundle(
  ["worldbox/presence.ts"],
  ["sanitizePresenceSpace"],
);

test("テント内装: 壁と床、出入口は歩ける", () => {
  const tent = world.buildTent();
  assert.equal(tent.width, world.TENT_W);
  assert.equal(tent.height, world.TENT_H);
  // 四辺は壁（出入口を除く）
  assert.equal(world.tentTileAt(tent.tiles, tent.width, tent.height, 0, 0), world.L_WALL);
  assert.equal(world.tentTileAt(tent.tiles, tent.width, tent.height, 5, 0), world.L_WALL);
  assert.equal(world.tentTileAt(tent.tiles, tent.width, tent.height, 0, 5), world.L_WALL);
  // 内側は木の床、出入口タイルも床
  assert.equal(world.tentTileAt(tent.tiles, tent.width, tent.height, 6, 5), world.L_WOOD);
  assert.equal(world.tentTileAt(tent.tiles, tent.width, tent.height, world.TENT_EXIT.x, world.TENT_EXIT.y), world.L_WOOD);
  // 出入口オブジェクトは平置き（通過可）
  const pad = tent.objects.find((o) => o.sprite === "warp_pad");
  assert.ok(pad);
  assert.equal(pad.solid, false);
  assert.equal(pad.x, world.TENT_EXIT.x);
  assert.equal(pad.y, world.TENT_EXIT.y);
  // 入口タイルは固体に含まれない
  const entryKey = `${Math.floor(world.TENT_ENTRY.x)},${Math.floor(world.TENT_ENTRY.y)}`;
  assert.equal(tent.blocked.has(entryKey), false);
});

test("テント内装: 作業台とかまどが smith ステーションで、入口から届く", () => {
  const tent = world.buildTent();
  const smiths = tent.objects.filter((o) => o.station === "smith");
  assert.ok(smiths.length >= 2, "作業台とかまどが無い");
  assert.ok(smiths.some((o) => o.sprite === "workbench"));
  // 入口タイルから作業台（出入口脇）に隣接できる
  const st = world.stationNear(tent.objects, Math.floor(world.TENT_ENTRY.x), Math.floor(world.TENT_ENTRY.y));
  assert.equal(st, "smith");
  // オブジェクト同士の重なりが無い
  const seen = new Set();
  for (const o of tent.objects) {
    for (let dy = 0; dy < o.h; dy++) {
      for (let dx = 0; dx < o.w; dx++) {
        const k = `${o.x + dx},${o.y + dy}`;
        assert.equal(seen.has(k), false, `重なり: ${k}`);
        seen.add(k);
      }
    }
  }
  // 固体のオブジェクトは blocked に入る（座席は上に乗って座るため除く）
  for (const o of tent.objects) {
    if (o.solid && !["bench", "chair", "sofa"].includes(o.sprite)) {
      assert.ok(tent.blocked.has(`${o.x},${o.y}`), `${o.sprite} が blocked に無い`);
    }
  }
  // テントのソファには座れる（blocked に入っていない）
  const sofa = tent.objects.find((o) => o.sprite === "sofa");
  assert.ok(sofa, "テントにソファがある");
  assert.equal(tent.blocked.has(`${sofa.x},${sofa.y}`), false, "ソファは固体でない");
});

test("セーブ: tent 空間が往復し、範囲外は tent 内へ丸まる", () => {
  const json = saveMod.serializeSave({ space: "tent", x: 6.5, y: 8.5, worldReturn: { x: 100.5, y: 200.5 } });
  const back = saveMod.parseSave(json);
  assert.equal(back.space, "tent");
  assert.equal(back.x, 6.5);
  assert.equal(back.y, 8.5);
  const clamped = saveMod.parseSave(saveMod.serializeSave({ space: "tent", x: 999, y: 999, worldReturn: null }));
  assert.ok(clamped.x <= world.TENT_MAX_W - 0.5 && clamped.y <= world.TENT_MAX_H - 0.5);
});

test("プレゼンス: tent 空間を通す", () => {
  assert.equal(presenceMod.sanitizePresenceSpace("tent"), "tent");
  assert.equal(presenceMod.sanitizePresenceSpace("lobby"), "lobby");
  assert.equal(presenceMod.sanitizePresenceSpace("変な値"), "world");
});

test("配線: テントは facility で置け、クライアントとサーバーが tent を扱う", () => {
  const items = fs.readFileSync(path.join(libDir, "worldbox/items.ts"), "utf8");
  assert.match(items, /id: "tent"[^}]*facility: true/);
  const client = fs.readFileSync(path.join(rootDir, "app/games/worldbox/WorldBoxClient.tsx"), "utf8");
  assert.ok(client.includes('doWarp("tent")'), "テントを踏んで入る配線が無い");
  assert.ok(client.includes("tentExitFor"), "出口の配線が無い");
  assert.ok(client.includes("buildTent"), "内装の読み込みが無い");
  assert.ok(client.includes('spaceUi !== "world" && stationUi'), "室内チップ表示が tent に広がっていない");
  const station = fs.readFileSync(path.join(libDir, "worldbox/station-online.ts"), "utf8");
  assert.ok(station.includes('presence.space === "tent"'), "サーバー検証に tent が無い");
  assert.ok(station.includes("buildTent"), "サーバー検証が内装を読まない");
  const panel = fs.readFileSync(path.join(rootDir, "app/games/worldbox/WorldBoxEconomyPanel.tsx"), "utf8");
  assert.ok(panel.includes('space !== "world" && station === "smith"'), "経済パネルの合成タブが tent で開かない");
  const relay = fs.readFileSync(path.join(rootDir, "realtime/relay-core.js"), "utf8");
  assert.ok(relay.includes("tent: { width: 22, height: 17 }"), "中継の空間境界に tent が無い");
});
