// WORLD BOX Phase 1 拡張（ACL・機械トリガ/自動搬出・Discordイベント連携）のテスト。
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

function readWeb(relPath) {
  return fs.readFileSync(path.join(rootDir, relPath), "utf8");
}

async function loadBundle(files, exportNames) {
  const code =
    files.map((name) => stripModuleSyntax(transpile(name))).join("\n") +
    `\nexport { ${exportNames.join(", ")} };\n`;
  return import(dataUrl(code));
}

const ACL = await loadBundle(
  ["worldbox/acl.ts"],
  ["ACCESS_SCOPES", "isAccessScope", "parseAccessScope", "accessScopeLabel", "canAccessScope"],
);

const C = await loadBundle(
  ["worldbox/items.ts", "worldbox/profile.ts", "worldbox/containers.ts"],
  ["emptyContainer", "parseContainerState", "serializeContainerState"],
);

const T = await loadBundle(
  ["worldbox/rng.ts", "worldbox/mapgen.ts", "worldbox/items.ts", "worldbox/profile.ts", "worldbox/presence.ts", "worldbox/seasons.ts", "worldbox/tiles.ts"],
  [
    "tileKey", "applyPlaceBlock", "applyToggleGate", "applySetGateAccess",
    "applyMineBlock", "parseTileOverride", "tileView", "worldTileSource",
    "mapTileAt", "T_GRASS", "presenceIdFor",
  ],
);

const M = await loadBundle(
  ["worldbox/items.ts", "worldbox/machines.ts"],
  [
    "defaultProgram", "parseProgram", "encodeProgram", "decodeProgram",
    "depositSeedToBuffer", "transferItemsToSlots", "evaluateMachine",
    "MACHINE_ALERT_COOLDOWN_MS", "MACHINE_BUFFER_ALERT_THRESHOLD", "MACHINE_SENSOR_RADIUS",
  ],
);

const CH = await loadBundle(
  ["worldbox/chat.ts"],
  ["CHAT_EVENT_TEXT_MAX", "parseUnionChatSettings", "sanitizeEventText"],
);

test("acl: 公開・ユニオン・自分のみの権限判定", () => {
  assert.deepEqual([...ACL.ACCESS_SCOPES], ["public", "union", "owner"]);
  assert.equal(ACL.parseAccessScope("union"), "union");
  assert.equal(ACL.parseAccessScope("owner"), "owner");
  assert.equal(ACL.parseAccessScope("invalid"), "public");
  assert.equal(ACL.accessScopeLabel("union"), "ユニオン");

  // public / undefined は未所属でも許可
  assert.equal(ACL.canAccessScope(undefined, { actorId: null, ownerId: "o1" }), true);
  assert.equal(ACL.canAccessScope("public", { actorId: "a1", ownerId: "o1", actorNationId: "g2", ownerNationId: "g1" }), true);

  // union は本人と同一ユニオンのみ
  assert.equal(ACL.canAccessScope("union", { actorId: "o1", ownerId: "o1", actorNationId: null, ownerNationId: null }), true);
  assert.equal(ACL.canAccessScope("union", { actorId: "a1", ownerId: "o1", actorNationId: "g1", ownerNationId: "g1" }), true);
  assert.equal(ACL.canAccessScope("union", { actorId: "a1", ownerId: "o1", actorNationId: "g2", ownerNationId: "g1" }), false);
  assert.equal(ACL.canAccessScope("union", { actorId: "a1", ownerId: "o1", actorNationId: null, ownerNationId: "g1" }), false);
  assert.equal(ACL.canAccessScope("union", { actorId: "a1", ownerId: "o1", actorNationId: null, ownerNationId: null }), false);

  // owner は同一ユニオンでも他人なら拒否
  assert.equal(ACL.canAccessScope("owner", { actorId: "o1", ownerId: "o1", actorNationId: "g1", ownerNationId: "g1" }), true);
  assert.equal(ACL.canAccessScope("owner", { actorId: "a1", ownerId: "o1", actorNationId: "g1", ownerNationId: "g1" }), false);
});

test("containers: access のシリアライズ・パース往復（public は省略互換）", () => {
  const pub = C.emptyContainer("o1", "barrel");
  assert.equal("access" in pub, false);

  const unionRaw = C.serializeContainerState({ ...pub, access: "union" });
  const parsedUnion = C.parseContainerState(unionRaw, "barrel");
  assert.equal(parsedUnion?.access, "union");

  const ownerRaw = C.serializeContainerState({ ...pub, access: "owner" });
  const parsedOwner = C.parseContainerState(ownerRaw, "barrel");
  assert.equal(parsedOwner?.access, "owner");

  const resetRaw = C.serializeContainerState({ ...pub, access: "public" });
  const parsedReset = C.parseContainerState(resetRaw, "barrel");
  assert.equal("access" in parsedReset, false);
});

test("tiles: 門の公開範囲設定・開閉制限・撤去時クリーンアップ", () => {
  const map = T.worldTileSource();
  let gx = 0;
  let gy = 0;
  outer: for (let y = 0; y < 512; y++) {
    for (let x = 0; x < 512; x++) {
      if (T.mapTileAt(map, x, y) === T.T_GRASS) {
        gx = x;
        gy = y;
        break outer;
      }
    }
  }
  const prof = { items: { wooden_gate: 1 }, hotbar: Array(5).fill(null), storage: Array(10).fill(null), coins: 0 };

  const placed = T.applyPlaceBlock(undefined, prof, map, "discord:111", gx, gy, "wooden_gate", 1000, { onCapital: false });
  assert.equal(placed.ok, true);
  const ov = placed.override;

  // 非所有者は gateAccess を変更できない
  const deniedSet = T.applySetGateAccess(ov, prof, map, "discord:222", gx, gy, "union", 1001);
  assert.equal(deniedSet.ok, false);
  assert.equal(deniedSet.error, "not_owner");

  // 所有者は union / owner / public へ切替可
  const setUnion = T.applySetGateAccess(ov, prof, map, "discord:111", gx, gy, "union", 1002);
  assert.equal(setUnion.ok, true);
  assert.equal(setUnion.override?.gateAccess, "union");
  assert.equal(T.parseTileOverride(JSON.stringify(setUnion.override))?.gateAccess, "union");
  assert.equal(
    T.tileView(map, { [T.tileKey(gx, gy)]: setUnion.override }, gx, gy, 1002, T.presenceIdFor("discord:111")).block?.gateAccess,
    "union",
  );

  // toggle_gate は ctx.gateAllowed === false で not_allowed を返す
  const deniedToggle = T.applyToggleGate(setUnion.override, prof, map, "discord:222", gx, gy, 1003, { gateAllowed: false });
  assert.equal(deniedToggle.ok, false);
  assert.equal(deniedToggle.error, "not_allowed");

  const okToggle = T.applyToggleGate(setUnion.override, prof, map, "discord:333", gx, gy, 1004, { gateAllowed: true });
  assert.equal(okToggle.ok, true);
  assert.equal(okToggle.override?.gateOpen, true);

  // public に戻すと gateAccess は消える
  const resetPub = T.applySetGateAccess(okToggle.override, prof, map, "discord:111", gx, gy, "public", 1005);
  assert.equal(resetPub.ok, true);
  assert.equal("gateAccess" in (resetPub.override ?? {}), false);
});

test("machines: 収穫+自動種まき・チェスト搬出・バッファ満杯アラート・種補充", () => {
  // 種補充は有効な種のみ受け付ける
  const baseM = { ownerId: "p1", program: M.defaultProgram(), buffer: {}, lastEvalAt: 0, updatedAt: 0 };
  const s1 = M.depositSeedToBuffer(baseM, "wheat_seed", 3, 100);
  assert.ok(s1);
  const s2 = M.depositSeedToBuffer(s1, "wheat_seed", 2, 101);
  assert.deepEqual(s2?.buffer, { wheat_seed: 5 });
  assert.equal(M.depositSeedToBuffer(baseM, "wheat", 5, 102), null);

  // harvest_replant: 成熟作物を収穫し、バッファの種を1消費して植え直す
  const now = 500_000;
  const matureWheat = {
    ownerId: "p1",
    farmland: true,
    crop: { cropId: "wheat", plantedAt: 1, readyAt: 100 },
  };
  const neighbors = new Map([
    ["1,0", matureWheat],
    ["-1,0", matureWheat],
  ]);
  const st = {
    ownerId: "p1",
    program: { ...M.defaultProgram(), trigger: "mature", action: "harvest_replant" },
    buffer: { wheat_seed: 1 },
    lastEvalAt: 0,
    updatedAt: 0,
  };
  const res = M.evaluateMachine(st, neighbors, now);
  assert.equal(res.evaluated, true);
  assert.equal(res.harvested, 4);
  assert.equal(res.replanted, 1);
  // 1マス目は植え直され、2マス目は種切れで空地
  assert.equal(res.changed.get("1,0")?.crop?.cropId, "wheat");
  assert.equal(res.changed.get("-1,0")?.crop, null);
  assert.equal(res.state.buffer.wheat_seed ?? 0, 0);
  assert.equal((res.state.buffer.wheat ?? 0) >= 4, true);

  // transferItemsToSlots: 種はバッファに残し、作物だけスロットへ移す
  const emptySlots = Array(5).fill(null);
  const transfer = M.transferItemsToSlots(emptySlots, { wheat_seed: 4, wheat: 12 }, 99);
  assert.equal(transfer.moved, 12);
  assert.deepEqual(transfer.buffer, { wheat_seed: 4 });
  assert.deepEqual(transfer.slots[0], { id: "wheat", count: 12 });

  // buffer_full + discord_alert: 閾値以上で発火し、クールダウン中は抑制
  const fullState = {
    ownerId: "p1",
    program: { ...M.defaultProgram(), trigger: "buffer_full", action: "discord_alert" },
    buffer: { wheat: M.MACHINE_BUFFER_ALERT_THRESHOLD },
    lastEvalAt: 0,
    updatedAt: 0,
  };
  const a1 = M.evaluateMachine(fullState, new Map(), now);
  assert.equal(a1.alertTriggered, true);
  assert.equal(a1.harvested, 0);

  const a2 = M.evaluateMachine(
    { ...a1.state, lastAlertAt: now },
    new Map(),
    now + M.MACHINE_ALERT_COOLDOWN_MS - 1000,
  );
  assert.equal(a2.alertTriggered, false);
});

test("chat: イベント通知フラグ・サニタイズ", () => {
  assert.deepEqual(CH.parseUnionChatSettings({ mode: "channel", channelId: "123456789012345678", events: false }), {
    mode: "channel",
    channelId: "123456789012345678",
    updatedAt: 0,
    events: false,
  });
  assert.deepEqual(CH.parseUnionChatSettings({ mode: "global", events: true }), {
    mode: "global",
    channelId: null,
    updatedAt: 0,
  });
  const longText = "あ".repeat(CH.CHAT_EVENT_TEXT_MAX + 20);
  assert.equal(CH.sanitizeEventText(longText).length, CH.CHAT_EVENT_TEXT_MAX);
  assert.equal(CH.sanitizeEventText("a\nb\rc"), "a b c");
});

test("Phase 1 配線確認: API ルート・クライアント・Python ワーカー", () => {
  const containersRoute = readWeb("app/api/worldbox/containers/route.ts");
  assert.ok(containersRoute.includes("canAccessScope"), "containers API に ACL 判定がある");
  assert.ok(containersRoute.includes('"set_access"'), "containers API に公開範囲変更がある");

  const tilesRoute = readWeb("app/api/worldbox/tiles/route.ts");
  assert.ok(tilesRoute.includes("canAccessScope"), "tiles API に ACL 判定がある");
  assert.ok(tilesRoute.includes('"set_gate_access"'), "tiles API に門公開範囲変更がある");
  assert.ok(tilesRoute.includes("not_allowed"), "tiles API が not_allowed を 403 で返す");

  const machinesRoute = readWeb("app/api/worldbox/machines/route.ts");
  assert.ok(machinesRoute.includes("transferItemsToSlots"), "machines API が隣接コンテナ搬出を使う");
  assert.ok(machinesRoute.includes('"deposit_seed"'), "machines API が種補充を持つ");
  assert.ok(machinesRoute.includes('"ping_sensors"'), "machines API が侵入センサー検知を持つ");

  for (const rel of [
    "app/api/worldbox/war/route.ts",
    "app/api/worldbox/requests/route.ts",
    "app/api/worldbox/stalls/route.ts",
    "app/api/worldbox/guild-shop/route.ts",
    "app/api/worldbox/machines/route.ts",
  ]) {
    assert.ok(readWeb(rel).includes("enqueueUnionDiscordEvent"), `${rel} が Discord イベント通知を積む`);
  }

  const client = readWeb("app/games/worldbox/WorldBoxClient.tsx");
  assert.ok(client.includes("setContainerScope"), "クライアントが収納公開範囲切替を持つ");
  assert.ok(client.includes('"set_gate_access"'), "クライアントが門公開範囲切替を持つ");
  assert.ok(client.includes('"ping_sensors"'), "クライアントがセンサー検知呼び出しを持つ");

  const machinePanel = readWeb("app/games/worldbox/WorldBoxMachinePanel.tsx");
  assert.ok(machinePanel.includes('"deposit_seed"'), "装置パネルが種補充ボタンを持つ");
  assert.ok(machinePanel.includes("autoStore"), "装置パネルが隣接搬出切替を持つ");

  const boardPanel = readWeb("app/games/worldbox/WorldBoxGuildBoardPanel.tsx");
  assert.ok(boardPanel.includes("イベント通知"), "ギルドボードがイベント通知 ON/OFF を持つ");
});
