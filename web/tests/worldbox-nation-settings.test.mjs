// WORLD BOX 国家設定（バッチN1）の検証:
// - 設定の parse/検証（税率・公開/非公開・任命大臣・累計税収）
// - 税率を適用したギルドショップの売り手取り分と税額
// - 役職解決（王 > 任命大臣 ∪ Discord 大臣 > 国民、離脱した任命大臣は落ちる）
// - 非公開の国のランキング/一覧フィルタ（自国民には自国だけ見える）
// - ルート配線（税率の適用先・join 拒否・ランキングフィルタ）
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

const wb = await loadBundle(
  ["worldbox/nation-settings.ts", "worldbox/guild-shop.ts"],
  [
    "TAX_RATE_DEFAULT", "TAX_RATE_MAX",
    "defaultNationSettings", "normalizeTaxRate", "parseNationSettings",
    "taxRateOf", "isPrivateNation", "memberKeysOf", "effectiveMinisters",
    "resolveMemberRole", "isNationHiddenFrom",
    "GUILD_SHOP_FEE_RATE", "sellerProceeds", "saleTaxAmount",
  ],
);

const KING = "discord:100000000000000001";
const USER_B = "discord:100000000000000002";
const USER_C = "discord:100000000000000003";
const USER_D = "discord:100000000000000004";
const GUILD_1 = "900000000000000001";
const GUILD_2 = "900000000000000002";

const NATION = { guildId: GUILD_1, name: "一国", color: "#e5484d", kingKey: KING, capital: { x: 1, y: 1 }, createdAt: 1 };
const MEMBER_KEYS = new Set([KING, USER_B, USER_C]);

// ---------- parse / 検証 ----------

test("nation-settings: 空・壊れた保存は既定値（税率5%・公開・大臣なし）", () => {
  for (const raw of [null, undefined, "not json", 42, [], {}]) {
    const s = wb.parseNationSettings(raw);
    assert.equal(s.taxRate, 0.05);
    assert.equal(s.visibility, "open");
    assert.deepEqual(s.ministers, []);
    assert.equal(s.taxCollected, 0);
  }
});

test("nation-settings: 有効な保存を復元する（JSON文字列も可）", () => {
  const raw = JSON.stringify({
    taxRate: 0.07, visibility: "private", ministers: [USER_B], taxCollected: 1234.9, updatedAt: 99,
  });
  const s = wb.parseNationSettings(raw);
  assert.equal(s.taxRate, 0.07);
  assert.equal(s.visibility, "private");
  assert.deepEqual(s.ministers, [USER_B]);
  assert.equal(s.taxCollected, 1234);
  assert.equal(s.updatedAt, 99);
});

test("nation-settings: 税率は 0〜0.10 の範囲だけを受け、範囲外は既定値", () => {
  assert.equal(wb.normalizeTaxRate(0), 0);
  assert.equal(wb.normalizeTaxRate(0.1), 0.1);
  assert.equal(wb.normalizeTaxRate(0.03), 0.03);
  assert.equal(wb.normalizeTaxRate(0.11), wb.TAX_RATE_DEFAULT);
  assert.equal(wb.normalizeTaxRate(-0.01), wb.TAX_RATE_DEFAULT);
  assert.equal(wb.normalizeTaxRate("0.05"), wb.TAX_RATE_DEFAULT);
  assert.equal(wb.normalizeTaxRate(Number.NaN), wb.TAX_RATE_DEFAULT);
});

test("nation-settings: 大臣リストは重複と不正値を落とす", () => {
  const s = wb.parseNationSettings({ ministers: [USER_B, USER_B, "", 42, USER_C] });
  assert.deepEqual(s.ministers, [USER_B, USER_C]);
});

// ---------- 税率と売り手取り分 ----------

test("nation-settings: 税率は未設定なら既定5%、設定があればその値", () => {
  assert.equal(wb.taxRateOf(null), 0.05);
  assert.equal(wb.taxRateOf(undefined), 0.05);
  assert.equal(wb.taxRateOf(wb.parseNationSettings({ taxRate: 0.02 })), 0.02);
  assert.equal(wb.GUILD_SHOP_FEE_RATE, wb.TAX_RATE_DEFAULT);
});

test("guild-shop: 売り手取り分は国の税率で変わり、税額は差分", () => {
  assert.equal(wb.sellerProceeds(100, 3), 285); // 既定 5%
  assert.equal(wb.sellerProceeds(100, 3, 0), 300);
  assert.equal(wb.sellerProceeds(100, 3, 0.1), 270);
  assert.equal(wb.sellerProceeds(100, 3, 0.02), 294);
  assert.equal(wb.saleTaxAmount(100, 3), 15);
  assert.equal(wb.saleTaxAmount(100, 3, 0), 0);
  assert.equal(wb.saleTaxAmount(100, 3, 0.1), 30);
});

// ---------- 役職解決 ----------

test("nation-settings: 王は常に王（任命・権限より優先）", () => {
  const settings = wb.parseNationSettings({ ministers: [KING] });
  const r = wb.resolveMemberRole(NATION, settings, KING, "citizen", MEMBER_KEYS);
  assert.deepEqual(r, { role: "king", appointed: false, discordMinister: false });
});

test("nation-settings: 任命大臣と Discord 大臣はどちらも大臣になる", () => {
  const settings = wb.parseNationSettings({ ministers: [USER_B] });
  assert.deepEqual(
    wb.resolveMemberRole(NATION, settings, USER_B, "citizen", MEMBER_KEYS),
    { role: "minister", appointed: true, discordMinister: false },
  );
  assert.deepEqual(
    wb.resolveMemberRole(NATION, settings, USER_C, "minister", MEMBER_KEYS),
    { role: "minister", appointed: false, discordMinister: true },
  );
  const both = wb.parseNationSettings({ ministers: [USER_C] });
  assert.deepEqual(
    wb.resolveMemberRole(NATION, both, USER_C, "minister", MEMBER_KEYS),
    { role: "minister", appointed: true, discordMinister: true },
  );
  assert.deepEqual(
    wb.resolveMemberRole(NATION, null, USER_C, "citizen", MEMBER_KEYS),
    { role: "citizen", appointed: false, discordMinister: false },
  );
});

test("nation-settings: 国民でなくなった任命大臣は自動で落ちる", () => {
  const settings = wb.parseNationSettings({ ministers: [USER_B, USER_D] });
  assert.deepEqual(wb.effectiveMinisters(settings, MEMBER_KEYS), [USER_B]);
  // 離脱者は国民ではないので解決自体が null
  assert.equal(wb.resolveMemberRole(NATION, settings, USER_D, "citizen", MEMBER_KEYS), null);
});

test("nation-settings: memberKeysOf はその国の国民だけを集める", () => {
  const state = {
    nations: {},
    members: {
      [KING]: { nationId: GUILD_1, role: "king" },
      [USER_B]: { nationId: GUILD_1, role: "citizen" },
      [USER_C]: { nationId: GUILD_2, role: "citizen" },
    },
  };
  assert.deepEqual([...wb.memberKeysOf(state, GUILD_1)].sort(), [KING, USER_B].sort());
});

// ---------- 非公開フィルタ ----------

test("nation-settings: 非公開の国は他国民から隠れ、自国民には見える", () => {
  const priv = wb.parseNationSettings({ visibility: "private" });
  const open = wb.parseNationSettings({ visibility: "open" });
  assert.equal(wb.isPrivateNation(priv), true);
  assert.equal(wb.isPrivateNation(null), false);
  assert.equal(wb.isNationHiddenFrom(priv, GUILD_1, GUILD_2), true);
  assert.equal(wb.isNationHiddenFrom(priv, GUILD_1, null), true);
  assert.equal(wb.isNationHiddenFrom(priv, GUILD_1, GUILD_1), false);
  assert.equal(wb.isNationHiddenFrom(open, GUILD_1, GUILD_2), false);
  assert.equal(wb.isNationHiddenFrom(null, GUILD_1, GUILD_2), false);
});

// ---------- ルート配線 ----------

test("nation-settings: ルート配線（税率適用・join拒否・ランキングフィルタ・設定API）", () => {
  const guildShopRoute = fs.readFileSync(path.join(rootDir, "app/api/worldbox/guild-shop/route.ts"), "utf8");
  assert.ok(guildShopRoute.includes("taxRateOf"), "ギルドショップが国の税率を引いていない");
  assert.ok(guildShopRoute.includes("saleTaxAmount"), "税額の累計加算が配線されていない");
  assert.ok(guildShopRoute.includes("updateNationSettings"), "税収の加算が設定ストアへ書かれていない");
  const nationsRoute = fs.readFileSync(path.join(rootDir, "app/api/worldbox/nations/route.ts"), "utf8");
  assert.ok(nationsRoute.includes("nation_private"), "非公開の国の join 拒否が配線されていない");
  assert.ok(nationsRoute.includes("isNationHiddenFrom"), "国一覧の非公開フィルタが配線されていない");
  const warRoute = fs.readFileSync(path.join(rootDir, "app/api/worldbox/war/route.ts"), "utf8");
  assert.ok(warRoute.includes("isNationHiddenFrom"), "ランキングの非公開フィルタが配線されていない");
  const settingsRoute = fs.readFileSync(path.join(rootDir, "app/api/worldbox/nation-settings/route.ts"), "utf8");
  assert.ok(settingsRoute.includes("king_only"), "設定変更の王限定が配線されていない");
  assert.ok(settingsRoute.includes("loadMyLobbyStation"), "設定変更のギルドボード前検証が配線されていない");
  const panel = fs.readFileSync(path.join(rootDir, "app/games/worldbox/WorldBoxGuildBoardPanel.tsx"), "utf8");
  assert.ok(panel.includes("/api/worldbox/nation-settings"), "パネルの設定タブが API に接続されていない");
});
