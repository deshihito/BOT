// AGO WORLD BOX ブラッシュアップ・回帰検証テスト:
// 1. ロビー隣接判定の辺（正面）優先（stationGenreNear / stationArcadeNear / stationNear）
// 2. save.ts の tpAt 往復・不正値処理
// 3. relay-core.js の setRoomBaseline / presenceKvValue(entry, tpTs) / ROLE_IDS teleporter
// 4. サーバー側テレポート連続性・swim_rescue 検証（realtime-server / presence / save / vitals）
// 5. ダンジョン進行配線（mobs/route.ts floorBossDead / partyKeyOf / effDef.hp）
// 6. 空クエリ・非有限値・ロック・ロールバック補強（各 API ルート）
// 7. クライアント UI ライフサイクル（WorldBoxRacingPanel / WorldBoxClient）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const rootDir = path.join(import.meta.dirname, "..");
const libDir = path.join(rootDir, "lib");
const require = createRequire(import.meta.url);
const relay = require(path.join(rootDir, "realtime", "relay-core.js"));

function transpile(name, base = libDir) {
  const src = fs.readFileSync(path.join(base, name), "utf8");
  return ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}

function dataUrl(js) {
  return "data:text/javascript;base64," + Buffer.from(js).toString("base64");
}

function readWeb(relPath) {
  return fs.readFileSync(path.join(rootDir, relPath), "utf8");
}

const mapgenUrl = dataUrl(transpile("worldbox/mapgen.ts"));
const lobbyUrl = dataUrl(transpile("worldbox/lobby.ts").replaceAll('"./mapgen"', JSON.stringify(mapgenUrl)));
const tentUrl = dataUrl(
  transpile("worldbox/tent.ts")
    .replaceAll('"./mapgen"', JSON.stringify(mapgenUrl))
    .replaceAll('"./lobby"', JSON.stringify(lobbyUrl)),
);
const saveUrl = dataUrl(
  transpile("worldbox/save.ts")
    .replaceAll('"./lobby"', JSON.stringify(lobbyUrl))
    .replaceAll('"./tent"', JSON.stringify(tentUrl))
    .replaceAll('"./mapgen"', JSON.stringify(mapgenUrl)),
);
const presenceUrl = dataUrl(transpile("worldbox/presence.ts"));

const lobby = await import(lobbyUrl);
const saveMod = await import(saveUrl);
const presenceMod = await import(presenceUrl);

const NOW = 1_700_000_000_000;

test("lobby: stationGenreNear と stationArcadeNear は角接より辺接（正面）を優先する", () => {
  // 配列の先頭に角で接する施設、後方に辺（正面）で接する施設を置く
  const list = [
    { sprite: "display_case", x: 5, y: 5, w: 1, h: 1, solid: true, station: "shop", genre: "tools" },
    { sprite: "shop_counter", x: 7, y: 6, w: 1, h: 1, solid: true, station: "shop", genre: "food" },
    { sprite: "arcade_cabinet", x: 10, y: 10, w: 1, h: 1, solid: true, station: "arcade", arcade: "game_a" },
    { sprite: "arcade_cabinet", x: 12, y: 11, w: 1, h: 1, solid: true, station: "arcade", arcade: "game_b" },
  ];
  // (6, 6) は (5, 5) と角で接し、(7, 6) とは辺で接する
  assert.equal(lobby.stationGenreNear(list, 6, 6), "food");
  // (11, 11) は (10, 10) と角で接し、(12, 11) とは辺で接する
  assert.equal(lobby.stationArcadeNear(list, 11, 11), "game_b");
  // 正面が無く角だけ接する場合は角の施設を返す
  assert.equal(lobby.stationGenreNear(list, 4, 4), "tools");
  assert.equal(lobby.stationArcadeNear(list, 9, 9), "game_a");
});

test("save: serializeSave の tpAt 付与と parseSaveTpAt の往復・不正値拒否", () => {
  const base = { space: "world", x: 12.5, y: -8.5, worldReturn: { x: 1.5, y: 2.5 } };
  const withTp = saveMod.serializeSave(base, { tpAt: NOW });
  assert.equal(saveMod.parseSaveTpAt(withTp), NOW);
  assert.deepEqual(saveMod.parseSave(withTp), base);

  const withoutTp = saveMod.serializeSave(base);
  assert.equal(saveMod.parseSaveTpAt(withoutTp), 0);
  assert.equal("tpAt" in JSON.parse(withoutTp), false);

  // 壊れた・ゼロ・負数・数値以外の tpAt は 0 に丸める
  assert.equal(saveMod.parseSaveTpAt(null), 0);
  assert.equal(saveMod.parseSaveTpAt("not-json"), 0);
  assert.equal(saveMod.parseSaveTpAt(JSON.stringify({ tpAt: 0 })), 0);
  assert.equal(saveMod.parseSaveTpAt(JSON.stringify({ tpAt: -100 })), 0);
  assert.equal(saveMod.parseSaveTpAt(JSON.stringify({ tpAt: "1700000000000" })), 0);
});

test("relay-core: teleporter 役職・setRoomBaseline・presenceKvValue の互換", () => {
  // sanitizeHeartbeat は teleporter を通す（presence.ts の ROLE_IDS と一致）
  const hb = relay.sanitizeHeartbeat({ x: 3, y: 4, space: "world", role: "teleporter", rank: 2 });
  assert.ok(hb);
  assert.equal(hb.role, "teleporter");
  const presHb = presenceMod.sanitizeHeartbeat(
    { x: 3, y: 4, space: "world", role: "teleporter" },
    { minX: -100, maxX: 100, minY: -100, maxY: 100 },
  );
  assert.equal(presHb?.role, "teleporter");

  // setRoomBaseline は旧空間の記録を消し、新空間に baseline を設定する
  const room = relay.createRoom();
  relay.acceptHeartbeat(room, "p1", "Alice", { x: 5, y: 5, space: "lobby" }, NOW, null);
  assert.equal(relay.snapshot(room, "lobby", "other", NOW).length, 1);

  const b = relay.setRoomBaseline(room, "p1", "Alice", { space: "world", x: 500, y: 500, ts: NOW + 100 });
  assert.ok(b);
  assert.equal(relay.snapshot(room, "lobby", "other", NOW + 100).length, 0);
  assert.equal(relay.snapshot(room, "world", "other", NOW + 100).length, 1);

  // テレポート直後のハートビート（新空間内での連続移動）は受理される
  const next = relay.acceptHeartbeat(room, "p1", "Alice", { x: 501, y: 500, space: "world" }, NOW + 300, b);
  assert.ok(next && !next.rejected);

  // presenceKvValue: 1引数では tpTs を付けず、2引数または entry.tpTs で付与する
  const plain = JSON.parse(relay.presenceKvValue(b));
  assert.equal("tpTs" in plain, false);
  const withArg = JSON.parse(relay.presenceKvValue(b, NOW + 200));
  assert.equal(withArg.tpTs, NOW + 200);
  const withProp = JSON.parse(relay.presenceKvValue({ ...b, tpTs: NOW + 300 }));
  assert.equal(withProp.tpTs, NOW + 300);
});

test("サーバー転移・swim_rescue 配線: realtime-server / presence / save / vitals の整合", () => {
  const rtServer = readWeb("realtime-server.js");
  assert.ok(rtServer.includes("saveTp > presTp && saveTp >= presTs"));
  assert.ok(rtServer.includes("saveTp > sinceTpTs && saveTp >= presTs"));
  assert.ok(rtServer.includes("info.lastSpaceAt = now"));
  assert.ok(rtServer.includes("Math.max(info.lastTpTs, info.lastSpaceAt)"));

  const presenceRoute = readWeb("app/api/worldbox/presence/route.ts");
  assert.ok(presenceRoute.includes("parseSaveTpAt"));
  assert.ok(presenceRoute.includes("saveTp >= prev.ts"));
  assert.ok(presenceRoute.includes("recoveredTpTs"));

  const saveRoute = readWeb("app/api/worldbox/save/route.ts");
  assert.ok(saveRoute.includes("parseSaveTpAt"));
  assert.ok(saveRoute.includes("saveTp >= freshPresence.ts"));
  assert.ok(saveRoute.includes("recoveredTpAt"));

  const vitalsRoute = readWeb("app/api/worldbox/vitals/route.ts");
  assert.ok(vitalsRoute.includes('action === "swim_rescue"'));
  assert.ok(vitalsRoute.includes("handleSwimRescue"));
  assert.ok(vitalsRoute.includes("tileAt(px, py, MAP_SEED) !== T_WATER || onBridge"));
  assert.ok(vitalsRoute.includes("Math.hypot(data.lx - pos.x, data.ly - pos.y) > 60"));
  assert.ok(vitalsRoute.includes("{ swim: false }"));
  assert.ok(vitalsRoute.includes("movePresenceAndSave"));
  assert.ok(vitalsRoute.includes("{ tpTs: now }"));
  assert.ok(vitalsRoute.includes("{ tpAt: now }"));
});

test("API ルート堅牢化: ダンジョン進行・空クエリ・ロックとロールバック", () => {
  const mobsRoute = readWeb("app/api/worldbox/mobs/route.ts");
  assert.ok(mobsRoute.includes("floorBossDead"));
  assert.ok(mobsRoute.includes("partyKeyOf"));
  assert.ok(mobsRoute.includes("effDef"));
  assert.ok(mobsRoute.includes("maxHp: effDef.hp"));
  assert.ok(mobsRoute.includes("withUserLock(ownerKey"));
  assert.ok(mobsRoute.includes('raw.trim() === ""'));

  const containersRoute = readWeb("app/api/worldbox/containers/route.ts");
  assert.ok(containersRoute.includes('xRaw.trim() === ""'));
  assert.ok(containersRoute.includes("withUserLock(`container:${space}:${coord.x},${coord.y}`"));
  assert.ok(containersRoute.includes("await storeContainer(resolved.storeSpace, resolved.storeX, resolved.storeY, resolved.state)"));

  const stallsRoute = readWeb("app/api/worldbox/stalls/route.ts");
  assert.ok(stallsRoute.includes('!url.searchParams.get("x")?.trim()'));
  assert.ok(stallsRoute.includes("await storeProfile(ownerKey, profile)"));
  assert.ok(stallsRoute.includes("await storeStall(x, y, stall)"));

  const machinesRoute = readWeb("app/api/worldbox/machines/route.ts");
  assert.ok(machinesRoute.includes('!url.searchParams.get("x")?.trim()'));
  assert.ok(machinesRoute.includes("typeof fields.x === \"string\" && !fields.x.trim()"));
  assert.ok(machinesRoute.includes("await storeProfile(ownerKey, before)"));

  const railsRoute = readWeb("app/api/worldbox/rails/route.ts");
  assert.ok(railsRoute.includes("Number.isFinite(fields.x)"));
  assert.ok(railsRoute.includes("{ tpAt: now }"));
  assert.ok(railsRoute.includes("{ tpTs: now }"));

  const objectsRoute = readWeb("app/api/worldbox/objects/route.ts");
  assert.ok(objectsRoute.includes("await storeProfile(ownerKey, profile)"));

  const guildShopRoute = readWeb("app/api/worldbox/guild-shop/route.ts");
  assert.ok(guildShopRoute.includes("rollbackOnFail"));

  const instancesRoute = readWeb("app/api/worldbox/instances/route.ts");
  assert.ok(instancesRoute.includes("withUserLock(ownerKey"));

  const rolesRoute = readWeb("app/api/worldbox/roles/route.ts");
  assert.ok(rolesRoute.includes("hasXY"));
  assert.ok(rolesRoute.includes("withUserLock(`mob:${key}`"));

  const opsRoute = readWeb("app/api/worldbox/ops/route.ts");
  assert.ok(opsRoute.includes("withUserLock(`tile:${x},${y}`"));
});

test("クライアントライフサイクルと UI 統一: 競馬場・屋台・看板・要塞化・水中帰還", () => {
  const racingPanel = readWeb("app/games/worldbox/WorldBoxRacingPanel.tsx");
  assert.ok(racingPanel.includes('className="wb-panel"'));
  assert.ok(racingPanel.includes('role="dialog"'));
  assert.ok(racingPanel.includes('position: "sticky"'));

  const client = readWeb("app/games/worldbox/WorldBoxClient.tsx");
  // エラーラベル・駅離脱クローズ・レース保護・タイマークリーンアップ
  for (const key of ["already_listed", "not_listed", "own_stall", "insufficient_balance", "store_failed", "invalid_coord"]) {
    assert.ok(client.includes(`${key}:`), `TILE_ERROR_LABEL missing ${key}`);
  }
  assert.ok(client.includes('if (stationUi !== "race") setRacingOpen(false)'));
  assert.ok(client.includes("const stallReqRef = useRef(0)"));
  assert.ok(client.includes("if (stallReqRef.current !== reqId) return"));
  assert.ok(client.includes("pianoFlushTimerRef.current !== undefined"));
  assert.ok(client.includes("playerCardTimerRef.current !== null"));

  // Esc と空間切替のパネルクローズ
  assert.ok(client.includes("setRacingOpen(false)"));
  assert.ok(client.includes("setMachinePanel(null)"));
  assert.ok(client.includes("setFortifyPanel(null)"));
  assert.ok(client.includes("setStallPanel(null)"));
  assert.ok(client.includes("}, [spaceUi])"));

  // 水中帰還のサーバー検証と橋上除外・snapBack 抑制
  assert.ok(client.includes("let rescueSyncUntil = 0"));
  assert.ok(client.includes("if (Date.now() < rescueSyncUntil) return"));
  assert.ok(client.includes("if (space === \"world\" && !inWaterNow && !onBridgeNow) lastLand = { x: player.x, y: player.y }"));
  assert.ok(client.includes('action: "swim_rescue"'));
  assert.ok(client.includes("data.rescue"));

  // 屋台・看板・要塞化パネルの sticky ヘッダー
  const stickyCount = (client.match(/stickyPanelHead/g) ?? []).length;
  assert.ok(stickyCount >= 11, `expected >= 11 stickyPanelHead occurrences, got ${stickyCount}`);
});
