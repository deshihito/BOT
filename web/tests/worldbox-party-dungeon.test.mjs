// WORLD BOX バッチ5: パーティ編成とダンジョン生成の純粋ロジックテスト。
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

const T = await loadBundle(
  ["worldbox/rng.ts", "worldbox/mapgen.ts", "worldbox/lobby.ts", "worldbox/items.ts", "worldbox/mobs.ts", "worldbox/objects.ts", "worldbox/instances.ts", "worldbox/party.ts"],
  [
    "buildDungeonFloor", "dungeonHpScale", "dungeonBossForEntrance", "dungeonFloorBossFor", "DUNGEON_FLOORS",
    "createParty", "joinParty", "leaveParty", "addInvite", "inviteFor", "parseParty", "partyKeyOf",
    "MAX_PARTY_MEMBERS", "PARTY_INVITE_TTL_MS",
  ],
);

const member = (ownerKey, role = "free", rank = 1) => ({ ownerKey, name: ownerKey, role, rank });

test("party: create holds leader and entrance", () => {
  const p = T.createParty("p1", member("discord:1", "blade", 2), { x: 10, y: 20 }, 1000);
  assert.equal(p.leaderKey, "discord:1");
  assert.equal(p.members.length, 1);
  assert.deepEqual(p.entrance, { x: 10, y: 20 });
  assert.equal(T.partyKeyOf(p, "discord:1"), "p1");
  assert.equal(T.partyKeyOf(null, "discord:9"), "solo:discord:9");
});

test("party: join up to 4, reject 5th and duplicates", () => {
  let p = T.createParty("p1", member("discord:1"), { x: 0, y: 0 }, 0);
  const join = (party, m) => {
    const r = T.joinParty(party, m);
    return "party" in r ? r.party : party;
  };
  p = join(p, member("discord:2"));
  p = join(p, member("discord:3"));
  p = join(p, member("discord:4"));
  assert.equal(p.members.length, T.MAX_PARTY_MEMBERS);
  assert.equal(T.joinParty(p, member("discord:5")).error, "full");
  assert.equal(T.joinParty(p, member("discord:2")).error, "already_member");
});

test("party: leader leaving disbands, member leaving keeps party", () => {
  let p = T.createParty("p1", member("discord:1"), { x: 0, y: 0 }, 0);
  p = T.joinParty(p, member("discord:2")).party;
  const after = T.leaveParty(p, "discord:2");
  assert.equal(after?.members.length, 1);
  assert.equal(T.leaveParty(p, "discord:1"), null);
  assert.equal(T.leaveParty(p, "discord:99")?.members.length, 2);
});

test("party: invite expires by TTL", () => {
  let p = T.createParty("p1", member("discord:1"), { x: 0, y: 0 }, 1000);
  p = T.addInvite(p, { toKey: "discord:2", name: "discord:2", at: 1000 });
  assert.ok(T.inviteFor(p, "discord:2", 1000 + T.PARTY_INVITE_TTL_MS - 1));
  assert.equal(T.inviteFor(p, "discord:2", 1000 + T.PARTY_INVITE_TTL_MS + 1), null);
  assert.equal(T.inviteFor(p, "discord:3", 1000), null);
});

test("party: parse roundtrip and junk rejection", () => {
  let p = T.createParty("p1", member("discord:1", "guard", 3), { x: -5, y: 7 }, 42);
  p = T.joinParty(p, member("discord:2", "scout", 1)).party;
  p = T.addInvite(p, { toKey: "discord:3", name: "discord:3", at: 42 });
  const back = T.parseParty(JSON.parse(JSON.stringify(p)));
  assert.deepEqual(back, p);
  assert.equal(T.parseParty(null), null);
  assert.equal(T.parseParty({ id: "x" }), null);
  assert.equal(T.parseParty("nope"), null);
});

test("dungeon: deterministic per entrance, differs across entrances", () => {
  const a = T.buildDungeonFloor(1234, 10, 20, 0);
  const b = T.buildDungeonFloor(1234, 10, 20, 0);
  assert.deepEqual(a, b);
  const c = T.buildDungeonFloor(1234, 11, 20, 0);
  assert.notDeepEqual(
    { mobs: a.mobs, chests: a.chests, boss: a.boss, keyHolder: a.keyHolder },
    { mobs: c.mobs, chests: c.chests, boss: c.boss, keyHolder: c.keyHolder },
  );
});

test("dungeon: every floor has boss, key holder, portal, stairs rules", () => {
  for (let layer = 0; layer < T.DUNGEON_FLOORS; layer++) {
    const f = T.buildDungeonFloor(777, 3, 4, layer);
    assert.equal(f.floor, layer + 1);
    assert.ok(f.mobs.some((m) => m.mobId === f.boss.mobId && m.x === f.boss.x && m.y === f.boss.y), `floor ${layer + 1} boss placed`);
    assert.ok(f.mobs.some((m) => m.mobId === f.keyHolder.mobId && m.x === f.keyHolder.x && m.y === f.keyHolder.y), `floor ${layer + 1} key holder placed`);
    assert.notDeepEqual({ x: f.boss.x, y: f.boss.y }, { x: f.keyHolder.x, y: f.keyHolder.y });
    assert.ok(f.portal.x >= 0 && f.portal.y >= 0);
    if (layer < T.DUNGEON_FLOORS - 1) assert.ok(f.stairsDown, `floor ${layer + 1} stairs`);
    else assert.equal(f.stairsDown, null);
    assert.ok(f.doors.length >= 1, `floor ${layer + 1} key door`);
    // 宝箱: ボス層はボス宝箱のみ、他層は通常宝箱があり得る
    if (layer === T.DUNGEON_FLOORS - 1) {
      assert.ok(f.chests.some((c) => c.bossChest));
      assert.ok(f.chests.every((c) => c.bossChest));
    }
  }
});

test("dungeon: boss types are deterministic and from the allowed sets", () => {
  const allowedFinal = new Set(["ogre", "spider_queen", "dungeon_dragon"]);
  for (let i = 0; i < 12; i++) {
    assert.ok(allowedFinal.has(T.dungeonBossForEntrance(99, i, i * 3)));
    assert.equal(T.dungeonBossForEntrance(99, i, i * 3), T.dungeonBossForEntrance(99, i, i * 3));
  }
  for (const fl of [1, 2, 3]) {
    assert.ok(["ogre", "spider_queen"].includes(T.dungeonFloorBossFor(99, 7, 8, fl)));
  }
  assert.equal(T.dungeonFloorBossFor(99, 7, 8, 4), T.dungeonBossForEntrance(99, 7, 8));
});

test("dungeon: hp scale by party size, attack untouched by design", () => {
  assert.equal(T.dungeonHpScale(1), 1.0);
  assert.equal(T.dungeonHpScale(2), 1.6);
  assert.equal(T.dungeonHpScale(3), 2.2);
  assert.equal(T.dungeonHpScale(4), 2.8);
  assert.equal(T.dungeonHpScale(9), 2.8);
  assert.equal(T.dungeonHpScale(0), 1.0);
});

test("dungeon: tiles are inside the 52x52 bounds and blocked covers walls", () => {
  const f = T.buildDungeonFloor(5, 0, 0, 3);
  for (const m of f.mobs) {
    assert.ok(m.x >= 0 && m.x < 52 && m.y >= 0 && m.y < 52);
  }
  // 固体はオブジェクト（宝箱・扉）だけ。壁は moveMap 側で塞ぐ
  for (const d of f.doors) assert.ok(f.data.blocked.has(`${d.x},${d.y}`));
  assert.equal(f.data.blocked.has(`${f.portal.x},${f.portal.y}`), false);
});
