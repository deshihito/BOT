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

const wb = await loadBundle(
  [
    "worldbox/rng.ts",
    "worldbox/mapgen.ts",
    "worldbox/lobby.ts",
    "worldbox/lobby-discovery.ts",
  ],
  [
    "LOBBY_W",
    "LOBBY_H",
    "L_VOID",
    "L_WALL",
    "LOBBY_OBJECTS",
    "LOBBY_DISTRICTS",
    "LOBBY_SECRET_ROOMS",
    "LOBBY_SECRET_STAIRS_IN",
    "LOBBY_SECRET_STAIRS_OUT",
    "LOBBY_SECRET_IN_LANDING",
    "LOBBY_SECRET_OUT_LANDING",
    "buildLobby",
    "lobbyTileAt",
    "lobbyDistrictAt",
    "lobbySecretRoomAt",
    "isSecretPassageTile",
    "stationNear",
    "emptyDiscoveryState",
    "parseDiscoveryState",
    "recordDistrictDiscovery",
    "recordSecretRoomDiscovery",
    "recordVaultClear",
    "recordShootingScore",
    "recordFortuneDraw",
    "toggleFortuneTie",
    "recordQuizClear",
    "discoveryRank",
  ],
);

const lobby = wb.buildLobby();
const tile = (x, y) => wb.lobbyTileAt(lobby.tiles, x, y);

function walkable(x, y) {
  const t = tile(x, y);
  return t !== wb.L_VOID && t !== wb.L_WALL && !lobby.blocked.has(`${x},${y}`);
}

test("デパート＆テーマパーク拡張: 5つの新ウィングと全20地区が存在する", () => {
  assert.equal(wb.LOBBY_DISTRICTS.length, 20);
  const newWings = [
    ["ワンダーランド遊園地＆縁日通り", 176, 26],
    ["デパート中央アトリウム・総合案内", 174, 66],
    ["アクアリウム＆クリスタル迷宮館", 206, 84],
    ["地下商店街・デパート大迷宮モール", 52, 104],
    ["スターライト展望モール＆シアターテラス", 146, 114],
  ];
  for (const [name, x, y] of newWings) {
    assert.equal(wb.lobbyDistrictAt(x, y), name);
    assert.ok(
      wb.LOBBY_DISTRICTS.some((d) => d.name === name),
      `LOBBY_DISTRICTS に ${name} が無い`,
    );
  }
});

test("隠し部屋6箇所・隠し通路・通過可能カバーオブジェクトが全て揃っている", () => {
  assert.equal(wb.LOBBY_SECRET_ROOMS.length, 6);
  for (const room of wb.LOBBY_SECRET_ROOMS) {
    assert.equal(wb.lobbySecretRoomAt(room.cx, room.cy)?.id, room.id);
    assert.ok(walkable(room.cx, room.cy), `${room.id} 中心 (${room.cx},${room.cy}) が歩けない`);
    assert.ok(room.hint.length > 0 && room.riddle.length > 0, `${room.id} の説明不足`);
  }

  const secretCovers = wb.LOBBY_OBJECTS.filter((o) => o.secret === true);
  assert.ok(secretCovers.length >= 10, `秘密カバー数が少ない: ${secretCovers.length}`);
  for (const sc of secretCovers) {
    assert.equal(
      sc.solid,
      false,
      `秘密カバー (${sc.sprite} ${sc.x},${sc.y}) が通過不可になっている`,
    );
  }

  // 秘密通路タイル判定
  assert.equal(wb.isSecretPassageTile(137, 26), true);
  assert.equal(wb.isSecretPassageTile(204, 13), true);
  assert.equal(wb.isSecretPassageTile(215, 48), true);
  assert.equal(wb.isSecretPassageTile(50, 117), true);
  assert.equal(wb.isSecretPassageTile(28, 24), false);

  // VIP秘密クラブへのワープ階段が有効
  for (const s of [...wb.LOBBY_SECRET_STAIRS_IN, ...wb.LOBBY_SECRET_STAIRS_OUT]) {
    assert.ok(walkable(s.x, s.y), `秘密階段 ${s.x},${s.y} が歩けない`);
  }
  assert.ok(
    walkable(Math.floor(wb.LOBBY_SECRET_IN_LANDING.x), Math.floor(wb.LOBBY_SECRET_IN_LANDING.y)),
  );
  assert.ok(
    walkable(Math.floor(wb.LOBBY_SECRET_OUT_LANDING.x), Math.floor(wb.LOBBY_SECRET_OUT_LANDING.y)),
  );
});

test("新規6つのロビー内コンテンツ（station）が存在し、周囲歩行タイルから検出できる", () => {
  const newStations = ["shrine", "jukebox", "shooting", "vault_puzzle", "stamp", "archive"];
  for (const st of newStations) {
    const objs = wb.LOBBY_OBJECTS.filter((o) => o.station === st);
    assert.ok(objs.length >= 1, `station ${st} のオブジェクトが無い`);
    const sample = objs[0];
    const adj = [
      [sample.x, sample.y + sample.h],
      [sample.x, sample.y - 1],
      [sample.x - 1, sample.y],
      [sample.x + sample.w, sample.y],
    ].find(([x, y]) => walkable(x, y));
    assert.ok(adj, `${st} (${sample.x},${sample.y}) の隣に歩ける場所が無い`);
    assert.equal(wb.stationNear(wb.LOBBY_OBJECTS, adj[0], adj[1]), st);
  }
});

test("新規7種類のロビースプライトPNGと textures.ts 登録が一致する", () => {
  const textures = fs.readFileSync(path.join(libDir, "worldbox/textures.ts"), "utf8");
  const newSprites = [
    "secret_wall",
    "shrine",
    "jukebox",
    "shooting_booth",
    "vault_puzzle",
    "stamp_desk",
    "exhibit_pedestal",
  ];
  for (const name of newSprites) {
    assert.ok(
      textures.includes(`/img/worldbox/lobby/${name}.png`),
      `textures.ts に ${name}.png が無い`,
    );
    assert.ok(
      fs.existsSync(path.join(rootDir, "public/img/worldbox/lobby", `${name}.png`)),
      `PNG が無い: ${name}.png`,
    );
  }
});

test("lobby-discovery: 地区・秘密部屋・ミニゲーム実績とランク計算が正しく動く", () => {
  let st = wb.emptyDiscoveryState();
  assert.equal(wb.discoveryRank(st).progressPct, 0);

  const d1 = wb.recordDistrictDiscovery(st, "wonderland");
  assert.equal(d1.newlyDiscovered, true);
  st = d1.state;
  assert.equal(wb.recordDistrictDiscovery(st, "wonderland").newlyDiscovered, false);
  assert.equal(wb.recordDistrictDiscovery(st, "unknown_id").newlyDiscovered, false);

  const s1 = wb.recordSecretRoomDiscovery(st, "vip_club");
  assert.equal(s1.newlyDiscovered, true);
  st = s1.state;
  assert.equal(wb.recordSecretRoomDiscovery(st, "vip_club").newlyDiscovered, false);

  st = wb.recordVaultClear(st);
  st = wb.recordShootingScore(st, 1250);
  st = wb.recordShootingScore(st, 900); // 下回る更新は無視
  assert.equal(st.bestShootingScore, 1250);
  st = wb.recordQuizClear(st, "q_rooms");

  st = wb.recordFortuneDraw(st, {
    rank: "大吉",
    message: "テスト",
    luckyItem: "鍵",
    luckyDir: "東",
    secretWhisper: "囁き",
  });
  st = wb.toggleFortuneTie(st);
  assert.equal(st.lastFortune.tied, true);

  const roundTrip = wb.parseDiscoveryState(JSON.stringify(st));
  assert.deepEqual(roundTrip.districts, ["wonderland"]);
  assert.deepEqual(roundTrip.secretRooms, ["vip_club"]);
  assert.equal(roundTrip.vaultClears, 1);
  assert.equal(roundTrip.bestShootingScore, 1250);
  assert.equal(roundTrip.fortuneCount, 1);
  assert.deepEqual(roundTrip.quizClearedIds, ["q_rooms"]);

  // 壊れた入力や未知IDは弾かれる
  const dirty = wb.parseDiscoveryState('{"districts":["bad","atrium"],"secretRooms":["nope"]}');
  assert.deepEqual(dirty.districts, ["atrium"]);
  assert.deepEqual(dirty.secretRooms, []);
});

test("UIパネル・クライアント・リレーサーバーが新ロビー拡張と正しく接続されている", () => {
  const client = fs.readFileSync(
    path.join(rootDir, "app/games/worldbox/WorldBoxClient.tsx"),
    "utf8",
  );
  for (const panelFile of [
    "WorldBoxShrinePanel.tsx",
    "WorldBoxJukeboxPanel.tsx",
    "WorldBoxShootingPanel.tsx",
    "WorldBoxVaultPuzzlePanel.tsx",
    "WorldBoxStampPanel.tsx",
    "WorldBoxArchivePanel.tsx",
  ]) {
    const p = path.join(rootDir, "app/games/worldbox", panelFile);
    assert.ok(fs.existsSync(p), `パネルが無い: ${panelFile}`);
    const src = fs.readFileSync(p, "utf8");
    assert.ok(src.includes("onClose"), `${panelFile} に onClose が無い`);
    assert.ok(src.includes("閉じる"), `${panelFile} に 閉じる ボタンが無い`);
    assert.ok(
      client.includes(panelFile.replace(".tsx", "")),
      `WorldBoxClient に ${panelFile} が接続されていない`,
    );
  }
  assert.ok(client.includes("LOBBY_SECRET_STAIRS_IN"), "秘密階段INがクライアントに無い");
  assert.ok(client.includes("isSecretPassageTile"), "隠し通路ビネット判定がクライアントに無い");

  // relay-core のロビー境界が 224x136 になっている
  const hb = relay.sanitizeHeartbeat({ x: 220, y: 130, space: "lobby" });
  assert.equal(hb.x, 220);
  assert.equal(hb.y, 130);
});
