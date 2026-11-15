// WORLD BOX バッチ4: 冒険役職 + ダブルタップ技の純粋ロジックテスト。
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

const R = await loadBundle(
  ["worldbox/fx.ts", "worldbox/items.ts", "worldbox/profile.ts", "worldbox/roles.ts"],
  [
    "ADVENTURE_ROLES", "SKILLS", "MASTERY_THRESHOLDS", "rankForXp", "masteryRankOf",
    "addMasteryXp", "activeSkillFor", "skillCooldownLeft", "maxHpFor", "partyGateSatisfied",
    "isAdventureRoleId", "parseProfile", "serializeProfile",
    "SKILL_FX_DURATION_MS", "skillFxProgress", "skillFxStage", "thunderBoltPoints",
  ],
);

function profileWith(role, xp = 0) {
  const p = R.parseProfile(null);
  p.role = role;
  if (role !== "free") p.mastery[role] = { xp };
  return p;
}

test("rank thresholds", () => {
  assert.equal(R.rankForXp(0), 1);
  assert.equal(R.rankForXp(29), 1);
  assert.equal(R.rankForXp(30), 2);
  assert.equal(R.rankForXp(80), 3);
  assert.equal(R.rankForXp(160), 4);
  assert.equal(R.rankForXp(300), 5);
  assert.equal(R.rankForXp(99999), 5);
});

test("every non-free role has a rank-1 skill and all 9 fx are used", () => {
  const usedFx = new Set();
  for (const role of ["blade", "guard", "scout", "miner", "medic"]) {
    const skill = R.activeSkillFor(profileWith(role, 0));
    assert.ok(skill, `${role} must have a rank-1 skill`);
    assert.equal(skill.minRank, 1);
  }
  for (const def of Object.values(R.SKILLS)) usedFx.add(def.fx);
  for (const fx of ["fireball", "heal_zone", "sweep", "thunder_strike", "ice_lance", "meteor", "whirlwind", "arrow_rain", "poison_field"]) {
    assert.ok(usedFx.has(fx), `fx ${fx} must be assigned to some skill`);
  }
});

test("higher rank replaces the active skill", () => {
  assert.equal(R.activeSkillFor(profileWith("blade", 0))?.id, "sweep");
  assert.equal(R.activeSkillFor(profileWith("blade", 80))?.id, "whirlwind");
  assert.equal(R.activeSkillFor(profileWith("miner", 0))?.id, "fireball");
  assert.equal(R.activeSkillFor(profileWith("miner", 300))?.id, "meteor");
  assert.equal(R.activeSkillFor(profileWith("guard", 0))?.id, "ice_lance");
  assert.equal(R.activeSkillFor(profileWith("guard", 300))?.id, "thunder_strike");
  assert.equal(R.activeSkillFor(profileWith("scout", 80))?.id, "arrow_rain");
  assert.equal(R.activeSkillFor(profileWith("medic", 300))?.id, "heal_zone");
  assert.equal(R.activeSkillFor(profileWith("free", 0)), null);
});

test("mastery persists per role across switches", () => {
  let p = profileWith("blade", 0);
  p = R.addMasteryXp(p, "blade", 35).profile;
  assert.equal(R.masteryRankOf(p, "blade"), 2);
  p = { ...p, role: "miner" };
  assert.equal(R.masteryRankOf(p, "miner"), 1);
  p = { ...p, role: "blade" };
  assert.equal(R.masteryRankOf(p, "blade"), 2);
});

test("cooldown is computed from skillAt", () => {
  const now = 1_000_000;
  let p = profileWith("blade", 0);
  assert.equal(R.skillCooldownLeft(p, "sweep", now), 0);
  p = { ...p, skillAt: { sweep: now } };
  assert.equal(R.skillCooldownLeft(p, "sweep", now + 1000), R.SKILLS.sweep.cooldownMs - 1000);
  assert.equal(R.skillCooldownLeft(p, "sweep", now + R.SKILLS.sweep.cooldownMs), 0);
});

test("guard max hp bonus", () => {
  assert.equal(R.maxHpFor(profileWith("guard", 0)), 120);
  assert.equal(R.maxHpFor(profileWith("blade", 0)), 100);
});

test("party gate: floor2 needs a rank2+, boss needs a rank3+", () => {
  assert.equal(R.partyGateSatisfied([1], "floor2"), false);
  assert.equal(R.partyGateSatisfied([2, 1], "floor2"), true);
  assert.equal(R.partyGateSatisfied([2], "boss"), false);
  assert.equal(R.partyGateSatisfied([3], "boss"), true);
  assert.equal(R.partyGateSatisfied([], "floor2"), false);
});

test("profile roundtrip keeps role fields", () => {
  let p = profileWith("scout", 45);
  p = {
    ...p,
    skillAt: { poison_field: 123 },
    tauntUntil: 456,
    reviveMark: { space: "cave:1,2:1", at: 789 },
    pendingTeleport: { space: "world", x: 3.5, y: 4.5 },
  };
  const back = R.parseProfile(R.serializeProfile(p));
  assert.equal(back.role, "scout");
  assert.equal(back.mastery.scout?.xp, 45);
  assert.equal(back.skillAt.poison_field, 123);
  assert.equal(back.tauntUntil, 456);
  assert.deepEqual(back.reviveMark, { space: "cave:1,2:1", at: 789 });
  assert.deepEqual(back.pendingTeleport, { space: "world", x: 3.5, y: 4.5 });
});

test("legacy profile defaults to free role", () => {
  const back = R.parseProfile(JSON.stringify({ items: {}, hotbar: [], storage: [], hunger: 80 }));
  assert.equal(back.role, "free");
  assert.deepEqual(back.mastery, {});
  assert.equal(R.masteryRankOf(back, "blade"), 1);
  assert.equal(back.pendingTeleport, null);
});

test("skill fx stages: telegraph before impact", () => {
  const eff = { kind: "thunder_strike", x: 0, y: 0, fromX: 0, fromY: 0, startedAt: 1000, seed: 7 };
  assert.equal(R.skillFxStage(eff, 1000), 0);
  assert.equal(R.skillFxStage(eff, 1000 + R.SKILL_FX_DURATION_MS.thunder_strike * 0.6), 1);
  const met = { ...eff, kind: "meteor" };
  assert.equal(R.skillFxStage(met, 1000), 0);
  assert.equal(R.skillFxStage(met, 1000 + R.SKILL_FX_DURATION_MS.meteor * 0.7), 1);
  assert.equal(R.skillFxStage(met, 1000 + R.SKILL_FX_DURATION_MS.meteor * 0.9), 2);
  assert.ok(R.skillFxProgress(eff, 1000 + R.SKILL_FX_DURATION_MS.thunder_strike) >= 1);
});

test("thunder bolt is deterministic and spans endpoints", () => {
  const a = R.thunderBoltPoints(42, 0, 0, 0, 5);
  const b = R.thunderBoltPoints(42, 0, 0, 0, 5);
  assert.deepEqual(a, b);
  assert.equal(a[0].y, 0);
  assert.equal(a[a.length - 1].y, 5);
});

test("role ids validated", () => {
  assert.equal(R.isAdventureRoleId("blade"), true);
  assert.equal(R.isAdventureRoleId("free"), true);
  assert.equal(R.isAdventureRoleId("king"), false);
  assert.equal(R.isAdventureRoleId(42), false);
});

const C = await loadBundle(
  ["worldbox/rng.ts", "worldbox/mapgen.ts", "worldbox/mobs.ts", "worldbox/combat.ts"],
  ["parseMobStates"],
);

test("mob states keep instance-prefixed keys (batch2 regression)", () => {
  const states = C.parseMobStates({
    "cave:1,2:1|slime@3,4": { hp: 5 },
    "slime@1,1": { hp: 7, frozenUntil: 999 },
    "junk": { hp: 1 },
  });
  assert.equal(states["cave:1,2:1|slime@3,4"]?.hp, 5);
  assert.equal(states["slime@1,1"]?.hp, 7);
  assert.equal(states["slime@1,1"]?.frozenUntil, 999);
  assert.equal(states.junk, undefined);
});

test("roles: 蘇生はダンジョンセッションの dead から外す（S5）", () => {
  // 蘇生後に dead に残っていると、mobs ルートが攻撃を弾き、全滅判定が
  // 誤ってセッションを閉じてしまう。蘇生ルートで dead を除去する。
  const route = fs.readFileSync(path.join(rootDir, "app/api/worldbox/roles/route.ts"), "utf8");
  assert.match(route, /action === "revive"/);
  assert.match(route, /storeDungeonSession/);
  assert.match(route, /dead: ds\.dead\.filter\(\(m\) => m !== target\.ownerKey\)/);
});
