// WORLD BOX 半製品修正バッチ「役職・強化・バイタル」の回帰テスト:
// - 道具強化の実効ティア（ティア+強化レベル）がツルハシ/斧にも効く
//   （従来は剣の playerAttack だけが強化を読んでいた）
// - 守護の満腹 heal ゲートは役職込みの最大 HP で判定する
// - 食事効果は vitals.consumeEffect に一本化（eatItem は消費とゲートだけ）
// - バフ duration はアイテム定義（buff.minutes）が正で、vitals 側は導出する
// - ルート配線: vitals hazard / roles skill・revive のユーザーロック、
//   技 XP（挑発・ヒーリングゾーン・全役職の技撃破）、斥候の罠軽減の横展開
// - クライアント配線: 食事バフ（warm/alert）の残り時間表示
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const rootDir = path.join(import.meta.dirname, "..");
const libDir = path.join(rootDir, "lib");
const appDir = path.join(rootDir, "app");

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

function readApp(rel) {
  return fs.readFileSync(path.join(appDir, rel), "utf8");
}

// ---------------------------------------------------------------- 道具強化
const T = await loadBundle(
  ["worldbox/rng.ts", "worldbox/mapgen.ts", "worldbox/items.ts", "worldbox/profile.ts", "worldbox/presence.ts", "worldbox/seasons.ts", "worldbox/tiles.ts"],
  ["parseProfile", "bestToolTier", "blockMineDamage", "itemById", "BLOCK_MINE_DAMAGE"],
);

function profileWith(overrides = {}) {
  return { ...T.parseProfile(null), items: {}, enhance: {}, ...overrides };
}

test("enhance: bestToolTier adds enhancement levels (pickaxe/axe)", () => {
  const plain = profileWith({ items: { wooden_pickaxe: 1 } });
  assert.equal(T.bestToolTier(plain, "pickaxe"), 1);
  const enhanced = profileWith({ items: { wooden_pickaxe: 1 }, enhance: { wooden_pickaxe: 2 } });
  assert.equal(T.bestToolTier(enhanced, "pickaxe"), 3);
  // 強化はその道具だけに効く（斧には漏れない）
  assert.equal(T.bestToolTier(enhanced, "axe"), 0);
  const axe = profileWith({ items: { stone_axe: 1 }, enhance: { stone_axe: 1 } });
  assert.equal(T.bestToolTier(axe, "axe"), 3);
  // 持っていない道具の強化は数えない
  const notHeld = profileWith({ items: {}, enhance: { iron_pickaxe: 3 } });
  assert.equal(T.bestToolTier(notHeld, "pickaxe"), 0);
});

test("enhance: blockMineDamage follows the effective pickaxe tier", () => {
  const brick = T.itemById("brick_block"); // durability 55, mineTool pickaxe
  const plain = profileWith({ items: { wooden_pickaxe: 1 } });
  assert.equal(T.blockMineDamage(plain, brick), T.BLOCK_MINE_DAMAGE[1]);
  const enhanced = profileWith({ items: { wooden_pickaxe: 1 }, enhance: { wooden_pickaxe: 2 } });
  assert.equal(T.blockMineDamage(enhanced, brick), T.BLOCK_MINE_DAMAGE[3]);
});

// ---------------------------------------------------------------- 食事まわり
const E = await loadBundle(
  ["worldbox/items.ts", "worldbox/profile.ts", "worldbox/vitals.ts", "worldbox/economy.ts"],
  ["eatItem", "consumeEffect", "parseProfile", "itemById", "BUFF_DURATION_MS", "maxHpFor"],
);

const NOW = 1_700_000_000_000;

test("eat: guardian at HP 110/120 and full hunger can still eat healing food", () => {
  const guard = {
    ...E.parseProfile(null),
    role: "guard", hp: 110, hunger: 100, items: { stew: 1 },
  };
  assert.equal(E.maxHpFor(guard), 120);
  const r = E.eatItem(guard, "stew", NOW);
  assert.equal(r.ok, true);
  assert.equal(r.profile.hp, 120); // 110 + heal 10（上限は守護の 120）
  // 満腹・満 HP の通常役職は従来どおり hunger_full
  const free = { ...E.parseProfile(null), role: "free", hp: 100, hunger: 100, items: { stew: 1 } };
  const ng = E.eatItem(free, "stew", NOW);
  assert.equal(ng.ok, false);
  assert.equal(ng.error, "hunger_full");
});

test("eat: eatItem applies exactly the consumeEffect formula (single source)", () => {
  const base = { ...E.parseProfile(null), hp: 50, hunger: 10, items: { stew: 1, honey_tea: 1 } };
  const ate = E.eatItem(base, "stew", NOW);
  assert.equal(ate.ok, true);
  assert.equal(ate.profile.hunger, 75); // 10 + 65
  assert.equal(ate.profile.hp, 60); // 50 + 10
  const warm = ate.profile.status.find((e) => e.kind === "warm");
  assert.equal(warm.until, NOW + 10 * 60_000);
  // consumeEffect 単体と結果が一致する（消費だけが eatItem の仕事）
  const removed = { ...base, items: { honey_tea: 1 } };
  const viaEffect = E.consumeEffect(removed, "stew", NOW);
  assert.equal(viaEffect.profile.hunger, ate.profile.hunger);
  assert.equal(viaEffect.profile.hp, ate.profile.hp);
  assert.deepEqual(viaEffect.profile.status, ate.profile.status);
  // 解毒も従来どおり効く
  const poisoned = { ...ate.profile, status: [...ate.profile.status, { kind: "poison", until: NOW + 30000 }] };
  const drank = E.eatItem(poisoned, "honey_tea", NOW);
  assert.equal(drank.ok, true);
  assert.ok(!drank.profile.status.some((e) => e.kind === "poison"));
  assert.ok(drank.profile.status.some((e) => e.kind === "alert"));
});

test("buffs: BUFF_DURATION_MS is derived from the item catalog", () => {
  const stew = E.itemById("stew");
  const tea = E.itemById("honey_tea");
  assert.equal(E.BUFF_DURATION_MS.warm, stew.buff.minutes * 60_000);
  assert.equal(E.BUFF_DURATION_MS.alert, tea.buff.minutes * 60_000);
});

// ---------------------------------------------------------------- 配線検証
test("wiring: instances route counts enhancement in the cave tier gate and scout mitigation covers cave/dungeon chests", () => {
  const src = readApp("api/worldbox/instances/route.ts");
  assert.match(src, /function bestToolTier\([\s\S]*?profile\.enhance/);
  const mitigations = src.match(/profile\.role === "scout" && rng\(\) < 0\.5/g) ?? [];
  assert.ok(mitigations.length >= 3, `斥候の罠軽減は遺跡+洞窟+ダンジョンの3か所（実際 ${mitigations.length}）`);
});

test("wiring: vitals hazard runs inside the user lock", () => {
  const src = readApp("api/worldbox/vitals/route.ts");
  const at = src.indexOf('data.action === "hazard"');
  assert.ok(at >= 0);
  assert.match(src.slice(at, at + 600), /withUserLock\(ownerKey/);
});

test("wiring: roles skill/revive run inside user locks, with skill XP grants", () => {
  const src = readApp("api/worldbox/roles/route.ts");
  // skill 本体は自分のロック内で読み直す
  assert.match(src, /fields\.action === "skill"[\s\S]{0,700}?withUserLock\(ownerKey, async \(\) => \{\s*const profile = await loadProfile\(ownerKey\);/);
  // revive は薬師→対象の順に別々のロック（対象の HP・pendingTeleport も対象のロック内）
  assert.match(src, /fields\.action === "revive"[\s\S]*?withUserLock\(target\.ownerKey, async \(\) => \{/);
  // 技 XP: 挑発（守護）・ヒーリングゾーン（薬師）・技撃破（全役職）
  assert.match(src, /addMasteryXp\(next, "guard", 2\)/);
  assert.match(src, /addMasteryXp\(next, "medic", 2\)/);
  assert.match(src, /addMasteryXp\(next, profile\.role, 3\)/);
});

test("wiring: client shows active food buffs with remaining minutes next to poison", () => {
  const src = readApp("games/worldbox/WorldBoxClient.tsx");
  const at = src.indexOf("毒</span>"); // バイタル表示の毒チップ
  assert.ok(at >= 0);
  const region = src.slice(at, at + 1500);
  assert.match(region, /"温かい食事"/);
  assert.match(region, /"自然回復"/);
  assert.match(region, /e\.until > gaugeNow/);
});
