// AGO WORLD BOX スロット統一＋売却専用ショップ（2026-11-17 ユーザー指示）の検証:
// - ロビーに売却専用ステーション "sell"（買取カウンター）が置かれ、接したタイルから引ける
// - 売却は買取カウンターでも可能（sellGate）だが、購入は従来どおり shop/smith のみ
// - 経済パネル: 売却は売却タブに一本化され、かばん注釈に売却ボタンは無い
// - 経済パネルに空腹度・HP の表示は無い（バイタルはステージ左上の常時バーが正）
// - 各パネルのヘッダーは sticky で「閉じる」がスクロールしても消えない
// - アイテム表示は共通 ItemSlot/ItemSlotGrid に統一されている
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
        .replace(/^export\s*\{\[^}]*\};?\s*$/, ""),
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

const wb = await loadBundle(
  ["worldbox/rng.ts", "worldbox/mapgen.ts", "worldbox/lobby.ts"],
  ["LOBBY_OBJECTS", "LOBBY_NPCS", "buildLobby", "stationNear", "isSolidLobbyTile"],
);
const lobby = wb.buildLobby();

const read = (rel) => fs.readFileSync(path.join(rootDir, rel), "utf8");

// ---------- 売却専用ショップ（買取カウンター） ----------

test("sell-shop: 買取カウンターがロビーに置かれ、北側のタイルから sell が引ける", () => {
  const sellObjs = lobby.objects.filter((o) => o.station === "sell");
  assert.ok(sellObjs.length >= 2, "買取カウンターは2タイル分ある");
  assert.equal(wb.stationNear(lobby.objects, 15, 26), "sell");
  assert.equal(wb.stationNear(lobby.objects, 16, 26), "sell");
  // 店員NPCがカウンターの内側にいて、固体ではない
  const npc = wb.LOBBY_NPCS.find((n) => n.x === 15 && n.y === 28);
  assert.ok(npc, "買取カウンターの店員NPCがいる");
  assert.equal(wb.isSolidLobbyTile(lobby.tiles, 15, 28), false);
});

test("sell-shop: 既存ステーションの引きは壊れていない", () => {
  assert.equal(wb.stationNear(lobby.objects, 5, 21), "shop");
  assert.equal(wb.stationNear(lobby.objects, 24, 28), null);
});

// ---------- API: 売却ゲート ----------

test("sell-shop: API は売却に sellGate（shop/smith/sell）を使い、購入は shopGate のまま", () => {
  const route = read("app/api/worldbox/profile/route.ts");
  // sellGate は shop/smith に sell を加えたもの、shopGate は sell を含まない
  const sellGateBody = route.match(/const sellGate = async \(\) => \{[\s\S]*?\};/)?.[0] ?? "";
  assert.ok(sellGateBody.includes('"sell"'), "sellGate が売却カウンターを許可する");
  const shopGateBody = route.match(/const shopGate = async \(\) => \{[\s\S]*?\};/)?.[0] ?? "";
  assert.ok(shopGateBody.length > 0 && !shopGateBody.includes('"sell"'), "shopGate は売却カウンターで買わせない");
  // sell ケースは sellGate、buy ケースは shopGate
  assert.ok(/case "sell": \{[\s\S]*?await sellGate\(\)/.test(route));
  assert.ok(/case "buy": \{[\s\S]*?await shopGate\(\)/.test(route));
});

// ---------- 経済パネル: 売却一本化＋バイタル撤去 ----------

test("economy: 売却タブが売却専用ショップで開き、売却アクションは1か所だけ", () => {
  const panel = read("app/games/worldbox/WorldBoxEconomyPanel.tsx");
  assert.ok(panel.includes('atSellShop'));
  assert.ok(panel.includes('tabBtn("sell", "売却")'));
  assert.equal(panel.split('action: "sell"').length - 1, 1, "売却ボタンは売却タブの注釈内だけ");
});

test("economy: パネル内にプレイヤーの空腹度・HP の表示は無い（ステージ左上の常時バーが正）", () => {
  const panel = read("app/games/worldbox/WorldBoxEconomyPanel.tsx");
  assert.ok(!panel.includes("profile.hunger"), "満腹度バーが無い");
  assert.ok(!panel.includes("profile.hp"), "HP バーが無い");
  assert.ok(!panel.includes("毒）"), "毒ラベルが無い");
});

test("economy: ヘッダーは sticky で閉じるボタンが常時見える", () => {
  const panel = read("app/games/worldbox/WorldBoxEconomyPanel.tsx");
  assert.ok(panel.includes('position: "sticky"'));
});

// ---------- スロット統一＋sticky（全パネル横断） ----------

const PANELS = [
  "app/games/worldbox/WorldBoxGuildShopPanel.tsx",
  "app/games/worldbox/WorldBoxMachinePanel.tsx",
  "app/games/worldbox/WorldBoxGuildBoardPanel.tsx",
  "app/games/worldbox/WorldBoxCasinoPanel.tsx",
  "app/games/worldbox/WorldBoxArenaPanel.tsx",
];

test("slots: ギルドショップ・装置・ギルドボードは共通スロット部品を使う", () => {
  for (const rel of PANELS.slice(0, 3)) {
    const src = read(rel);
    assert.ok(src.includes('from "./ItemSlotGrid"'), `${rel} が ItemSlotGrid を使う`);
    assert.ok(!src.includes('aria-label="アイテム"'), `${rel} にアイテム選択の select が残っていない`);
  }
});

test("menu: ≡ の「設定」の中に BGM・効果音・通報が格納されている", () => {
  const client = read("app/games/worldbox/WorldBoxClient.tsx");
  assert.ok(client.includes("settingsOpen"), "設定の開閉 state がある");
  assert.ok(!client.includes('id: "report"'), "通報は menuActions 本体に残っていない");
  const settingsIdx = client.indexOf("設定\n            </button>");
  const bgmIdx = client.indexOf("BGMを切る");
  const seIdx = client.indexOf("効果音を切る");
  const reportIdx = client.indexOf("通報する");
  assert.ok(settingsIdx > 0, "設定ボタンがある");
  assert.ok(bgmIdx > settingsIdx && seIdx > settingsIdx && reportIdx > settingsIdx,
    "BGM・効果音・通報は設定ボタンより後（設定の中）にある");
  // 設定の中はインデント付きの入れ子グリッド
  assert.ok(client.includes("paddingLeft: 14"), "設定の中身は入れ子表示になっている");
});

test("sticky: 全パネルのヘッダーが sticky で固定される", () => {
  for (const rel of [...PANELS, "app/games/worldbox/WorldBoxEconomyPanel.tsx"]) {
    assert.ok(read(rel).includes('position: "sticky"'), `${rel} のヘッダーが sticky`);
  }
  const client = read("app/games/worldbox/WorldBoxClient.tsx");
  assert.ok(client.includes("stickyPanelHead"), "内蔵パネル用 sticky ヘッダーがある");
  assert.ok(client.includes('sell: "売却専用ショップ"'), "売却ステーションのラベルがある");
  assert.ok(client.includes("ItemSlotView"), "コレクション・種ピッカーがスロット化されている");
});
