// WORLD BOX Phase 3 拡張（天候連動・冒険手帳/実績/称号・ユニオン週間共闘目標・マップ道標）のテスト。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const require = createRequire(import.meta.url);
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

function readWeb(relPath) {
  return fs.readFileSync(path.join(rootDir, relPath), "utf8");
}

async function loadBundle(files, exportNames) {
  const code =
    files.map((name) => stripModuleSyntax(transpile(name))).join("\n") +
    `\nexport { ${exportNames.join(", ")} };\n`;
  return import(dataUrl(code));
}

const W = await loadBundle(
  ["worldbox/weather.ts"],
  [
    "WEATHER_PERIOD_SEC", "WEATHER_NAMES", "RAIN_CROP_GROWTH_MULT", "RAIN_FISHING_BONUS_CHANCE",
    "weatherAt", "weatherGrowthMult", "rollRainFishingBonus",
  ],
);

const FX = await loadBundle(
  ["worldbox/fx.ts"],
  ["WEATHER_PERIOD_SEC", "weatherAt"],
);

const TM = await loadBundle(
  [
    "worldbox/rng.ts", "worldbox/mapgen.ts", "worldbox/seasons.ts", "worldbox/presence.ts",
    "worldbox/items.ts", "worldbox/profile.ts", "worldbox/tiles.ts", "worldbox/machines.ts",
  ],
  [
    "MAP_SEED", "worldTileSource", "mapTileAt", "T_DIRT", "T_GRASS", "applyTileAction", "evaluateMachine", "addItem",
    "parseProfile", "serializeProfile", "bumpProfileStat", "sanitizeHeartbeat",
  ],
);

const A = await loadBundle(
  ["worldbox/achievements.ts"],
  [
    "STAT_KEYS", "PLAYER_TITLE_MAX", "ACHIEVEMENTS", "ACHIEVEMENT_CATEGORY_NAMES",
    "sanitizePlayerTitle", "evaluateAchievements", "unlockedTitles", "isTitleUnlocked", "newlyUnlockedAnnouncements",
  ],
);

const UG = await loadBundle(
  ["worldbox/union-goals.ts"],
  [
    "UNION_GOALS", "goalWeekKeyOf", "emptyUnionGoalsState", "parseUnionGoalsState",
    "applyUnionGoalProgress", "toUnionGoalViews",
  ],
);

const relayCore = require("../realtime/relay-core.js");

test("weather: fx.ts と weather.ts の天候判定が全区間で一致し、雨天農業・釣りボーナスが効く", () => {
  assert.equal(W.WEATHER_PERIOD_SEC, FX.WEATHER_PERIOD_SEC);
  assert.equal(W.WEATHER_NAMES.clear, "晴れ");
  assert.equal(W.WEATHER_NAMES.rain, "雨");

  let sawRain = false;
  let sawClear = false;
  for (let i = 0; i < 1000; i++) {
    const sec = 1_700_000_000 + i * W.WEATHER_PERIOD_SEC;
    const w = W.weatherAt(sec);
    assert.equal(w, FX.weatherAt(sec));
    if (w === "rain") {
      sawRain = true;
      assert.equal(W.weatherGrowthMult(sec), W.RAIN_CROP_GROWTH_MULT);
    } else {
      sawClear = true;
      assert.equal(W.weatherGrowthMult(sec), 1);
    }
  }
  assert.ok(sawRain && sawClear);

  // 釣り追加ドロップ: 晴れでは絶対に増えず、雨では 25% 以下で raw_fish/pearl を返す
  assert.deepEqual(W.rollRainFishingBonus("clear", () => 0.01), {});
  assert.deepEqual(W.rollRainFishingBonus("rain", () => 0.30), {});
  assert.deepEqual(W.rollRainFishingBonus("rain", () => 0.10), { pearl: 1 });
  let calls = 0;
  assert.deepEqual(
    W.rollRainFishingBonus("rain", () => (calls++ === 0 ? 0.10 : 0.50)),
    { raw_fish: 1 },
  );

  // tiles.ts の植付けが growthMult (0.75) で成長時間を 25% 短縮する
  const now = 1_700_000_000_000;
  const worldMap = TM.worldTileSource(TM.MAP_SEED);
  let gx = -1;
  let gy = -1;
  outer: for (let y = 300; y < 700; y++) {
    for (let x = 300; x < 700; x++) {
      if (TM.mapTileAt(worldMap, x, y) === TM.T_GRASS) {
        gx = x;
        gy = y;
        break outer;
      }
    }
  }
  assert.ok(gx >= 0 && gy >= 0, "grass tile must be found");
  let prof = TM.parseProfile(null);
  prof = TM.addItem(prof, "wooden_hoe", 1);
  prof = TM.addItem(prof, "wheat_seed", 4);
  const tilled = TM.applyTileAction(null, prof, worldMap, "discord:1", "till", gx, gy, undefined, now);
  assert.equal(tilled.ok, true, `till failed at (${gx},${gy}): ${tilled.ok ? "" : tilled.error}`);
  const sunny = TM.applyTileAction(tilled.override, prof, worldMap, "discord:1", "plant", gx, gy, "wheat_seed", now, { growthMult: 1 });
  const rainy = TM.applyTileAction(tilled.override, prof, worldMap, "discord:1", "plant", gx, gy, "wheat_seed", now, { growthMult: 0.75 });
  assert.equal(sunny.ok, true);
  assert.equal(rainy.ok, true);
  const sunnyDur = sunny.override.crop.readyAt - sunny.override.crop.plantedAt;
  const rainyDur = rainy.override.crop.readyAt - rainy.override.crop.plantedAt;
  assert.equal(rainyDur, Math.round(sunnyDur * 0.75));

  // machines.ts の harvest_replant がカスタム growthDurationMs をそのまま反映する
  const matureOverride = {
    ownerId: "abcd1234",
    farmland: true,
    crop: { cropId: "wheat", plantedAt: now - 100_000, readyAt: now - 1 },
  };
  const neighbors = new Map([[`${gx},${gy}`, matureOverride]]);
  const machine = {
    ownerId: "abcd1234",
    program: { trigger: "mature", action: "harvest_replant", intervalSec: 30, enabled: true, autoStore: false },
    buffer: { wheat_seed: 2 },
    lastEvalAt: now - 60_000,
    updatedAt: now - 60_000,
  };
  const ev = TM.evaluateMachine(machine, neighbors, now, { growthDurationMs: () => 45_000 });
  assert.equal(ev.evaluated, true);
  const replanted = ev.changed.get(`${gx},${gy}`);
  assert.ok(replanted?.crop);
  assert.equal(replanted.crop.readyAt - replanted.crop.plantedAt, 45_000);
});

test("achievements & profile & presence: 統計加算・称号解放・空時省略互換・WS/REST連携", () => {
  // 空プロフィールでは stats / title キーが省略される
  const empty = TM.parseProfile(null);
  const rawEmpty = JSON.parse(TM.serializeProfile(empty));
  assert.equal("stats" in rawEmpty, false);
  assert.equal("title" in rawEmpty, false);

  // bumpProfileStat が非負整数のみ積み上げ、シリアライズ往復できる
  let prof = TM.bumpProfileStat(empty, "chops", 1);
  prof = TM.bumpProfileStat(prof, "bossKills", 1);
  prof = { ...prof, title: "竜殺し\n余計な文字123456" };
  const round = TM.parseProfile(TM.serializeProfile(prof));
  assert.deepEqual(round.stats, { chops: 1, bossKills: 1 });
  assert.equal(round.title, "竜殺し 余計な文字123456".slice(0, A.PLAYER_TITLE_MAX));

  // 実績判定と解放済み称号・レア速報差分
  const before = { stats: { chops: 1 }, discoveredRecipes: [] };
  const after = { stats: { chops: 1, bossKills: 1 }, discoveredRecipes: [] };
  assert.equal(A.isTitleUnlocked(before, "木こり"), true);
  assert.equal(A.isTitleUnlocked(before, "竜殺し"), false);
  assert.equal(A.isTitleUnlocked(after, "竜殺し"), true);
  assert.ok(A.unlockedTitles(after).includes("竜殺し"));

  const alerts = A.newlyUnlockedAnnouncements(before, after);
  assert.deepEqual(alerts.map((x) => x.id), ["boss_slayer"]);
  // 二度目は初達成ではないため出ない
  assert.deepEqual(A.newlyUnlockedAnnouncements(after, after), []);

  // presence.ts & relay-core.js で title をサニタイズ・未設定時省略
  const bounds = { minX: -100, maxX: 100, minY: -100, maxY: 100 };
  const hbWithTitle = TM.sanitizeHeartbeat({ x: 1, y: 2, space: "world", title: "  豪商\tテスト極限長オーバー  " }, bounds);
  const hbNoTitle = TM.sanitizeHeartbeat({ x: 1, y: 2, space: "world", title: "   " }, bounds);
  assert.equal(hbWithTitle.title, "豪商 テスト極限長オーバ");
  assert.equal("title" in hbNoTitle, false);

  const wsHb = relayCore.sanitizeHeartbeat({ x: 1, y: 2, space: "world", title: "英雄テスト\x00文字" }, "world");
  assert.equal(wsHb.title, "英雄テスト 文字".slice(0, 12));
  const kvWithTitle = JSON.parse(relayCore.presenceKvValue({ name: "tester", ...wsHb, id: "abcd1234", ts: 1000 }));
  const kvNoTitle = JSON.parse(relayCore.presenceKvValue({ name: "tester", ...hbNoTitle, id: "abcd1234", ts: 1000 }));
  assert.equal(kvWithTitle.title, wsHb.title);
  assert.equal("title" in kvNoTitle, false);
});

test("union-goals: 週間共闘目標の加算・初回達成通知・週替わりリセット（累計引き継ぎ）", () => {
  const mon1 = Date.UTC(2026, 10, 16, 9, 0, 0); // 2026-11-16 (Mon)
  const mon2 = Date.UTC(2026, 10, 23, 9, 0, 0); // 2026-11-23 (Next Mon)
  const week1 = UG.goalWeekKeyOf(mon1);
  const week2 = UG.goalWeekKeyOf(mon2);
  assert.notEqual(week1, week2);

  let st = UG.emptyUnionGoalsState(week1);
  const step1 = UG.applyUnionGoalProgress(st, mon1, "gather", 39);
  assert.equal(step1.newlyCompleted, null);
  assert.equal(step1.state.totalCompleted, 0);

  const step2 = UG.applyUnionGoalProgress(step1.state, mon1 + 1000, "gather", 2);
  assert.equal(step2.newlyCompleted?.id, "gather");
  assert.equal(step2.state.totalCompleted, 1);

  // 同週内の追加進捗では重複達成通知を出さない
  const step3 = UG.applyUnionGoalProgress(step2.state, mon1 + 2000, "gather", 5);
  assert.equal(step3.newlyCompleted, null);
  assert.equal(step3.state.totalCompleted, 1);

  const views = UG.toUnionGoalViews(step3.state);
  const gView = views.find((v) => v.id === "gather");
  assert.equal(gView.current, 40);
  assert.notEqual(gView.completedAt, null);

  // 翌週に切り替わると今週の進捗と達成印はリセットされ、累計達成回数だけ引き継ぐ
  const rolled = UG.parseUnionGoalsState(JSON.stringify(step3.state), mon2);
  assert.equal(rolled.week, week2);
  assert.deepEqual(rolled.progress, { gather: 0, craft: 0, combat: 0 });
  assert.deepEqual(rolled.completed, {});
  assert.equal(rolled.totalCompleted, 1);
});

test("Phase 3 wiring: UI パネル・クライアント・API・バックアップ登録の配線が揃っている", () => {
  const codexPanel = readWeb("app/games/worldbox/WorldBoxCodexPanel.tsx");
  assert.ok(codexPanel.includes('className="wb-panel"'));
  assert.ok(codexPanel.includes('"Escape"'));
  assert.ok(codexPanel.includes('"set_title"'));
  assert.ok(codexPanel.includes("ItemSlotGrid"));
  assert.ok(codexPanel.includes("ItemSlot"));
  assert.ok(codexPanel.includes("ItemAnnotation"));

  const guildBoard = readWeb("app/games/worldbox/WorldBoxGuildBoardPanel.tsx");
  assert.ok(guildBoard.includes('setTab("goals")'));
  assert.ok(guildBoard.includes("/api/worldbox/union-goals"));
  assert.ok(guildBoard.includes("累計達成:"));

  const client = readWeb("app/games/worldbox/WorldBoxClient.tsx");
  assert.ok(client.includes("WorldBoxCodexPanel"));
  assert.ok(client.includes("codexOpen"));
  assert.ok(client.includes("WEATHER_NAMES"));
  assert.ok(client.includes("雨の恵みで追釣"));
  assert.ok(client.includes("flag_red"));
  assert.ok(client.includes("flag_blue"));
  assert.ok(client.includes("sign_board"));
  assert.ok(client.includes("invRef.current?.respawn"));
  assert.ok(client.includes("invRef.current?.title"));
  assert.ok(client.includes("title: invRef.current?.title || undefined"));

  const profileRoute = readWeb("app/api/worldbox/profile/route.ts");
  assert.ok(profileRoute.includes('case "set_title"'));
  assert.ok(profileRoute.includes("isTitleUnlocked"));
  assert.ok(profileRoute.includes("dispatchProgressEffects"));

  const tilesRoute = readWeb("app/api/worldbox/tiles/route.ts");
  assert.ok(tilesRoute.includes("weatherGrowthMult"));
  assert.ok(tilesRoute.includes("dispatchProgressEffects"));

  const fishingRoute = readWeb("app/api/worldbox/fishing/route.ts");
  assert.ok(fishingRoute.includes("rollRainFishingBonus"));
  assert.ok(fishingRoute.includes("rainBonus"));
  assert.ok(fishingRoute.includes("dispatchProgressEffects"));

  const mobsRoute = readWeb("app/api/worldbox/mobs/route.ts");
  assert.ok(mobsRoute.includes("dispatchProgressEffects"));
  assert.ok(mobsRoute.includes("bumpProfileStat"));

  const tradeRoute = readWeb("app/api/worldbox/trade/route.ts");
  assert.ok(tradeRoute.includes("notifyAchievementDiscord"));
  assert.ok(tradeRoute.includes('bumpProfileStat(swapped.aProfile, "trades", 1)'));

  const machinesRoute = readWeb("app/api/worldbox/machines/route.ts");
  assert.ok(machinesRoute.includes("weatherGrowthMult"));

  const unionGoalsRoute = readWeb("app/api/worldbox/union-goals/route.ts");
  assert.ok(unionGoalsRoute.includes("toUnionGoalViews"));

  const backupPy = fs.readFileSync(path.join(rootDir, "..", "tools/worldbox_backup.py"), "utf8");
  assert.ok(backupPy.includes('"worldbox_union_goals"'));
});
