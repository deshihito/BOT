// AGO WORLD BOX 経済の検証:
// - アイテムカタログの母数と整合性（ID一意・価格・レシピ参照・合成の利益）
// - 経済の状態遷移（売買・食事・労働・合成）。コインはプロフィールでなく
//   ブリッジのオプ（coin）として表現され、残高検証は実残高の引数で行う
// - steal の規則（成功/失敗・保護・クールダウン・特殊アイテム）
// - プロフィール（かばん）の検証とクライアント配線
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
    out.push(line.replace(/^export\s+/, ""));
  }
  return out.join("\n");
}

function loadBundle(files, names) {
  const code = files.map((name) => stripModuleSyntax(transpile(name))).join("\n");
  return new Function(`${code}\nreturn { ${names.join(", ")} };`)();
}

const eco = loadBundle(
  ["worldbox/items.ts", "worldbox/profile.ts", "worldbox/economy.ts"],
  [
    "ITEMS", "itemById", "RECIPES", "recipeById", "sellPrice",
    "DEFAULT_PROFILE", "parseProfile", "countItem",
    "buyItem", "sellItem", "eatItem", "doWork", "craftItem", "resolveSteal",
    "STEAL_MAX_AMOUNT", "STEAL_TARGET_MIN_COINS", "STEAL_FINE_AMOUNT",
  ],
);

const fresh = () => eco.parseProfile(null);

test("アイテムの母数が厚い（28種以上）・IDが一意・価格が正", () => {
  assert.ok(eco.ITEMS.length >= 28, `items=${eco.ITEMS.length}`);
  const ids = new Set(eco.ITEMS.map((i) => i.id));
  assert.equal(ids.size, eco.ITEMS.length);
  for (const item of eco.ITEMS) {
    assert.ok(item.price > 0, item.id);
    if (item.category === "food") assert.ok(item.hunger > 0, item.id);
  }
  const categories = new Set(eco.ITEMS.map((i) => i.category));
  assert.deepEqual(
    [...categories].sort(),
    ["block", "crafted", "crop", "food", "furniture", "material", "seed", "special", "tool"],
  );
});

test("レシピの参照がすべて実在し、合成品は売ると素材代より高くなる", () => {
  for (const recipe of eco.RECIPES) {
    const output = eco.itemById(recipe.output);
    assert.ok(output, recipe.id);
    let inputCost = 0;
    for (const [id, n] of Object.entries(recipe.inputs)) {
      const input = eco.itemById(id);
      assert.ok(input, `${recipe.id}:${id}`);
      inputCost += input.price * n;
    }
    if (recipe.id === "bread") continue; // パンは利便性レシピ（小麦をまとめて食べやすくする）
    assert.ok(
      eco.sellPrice(output) * recipe.outputCount > inputCost,
      `${recipe.id}: sell=${eco.sellPrice(output)} cost=${inputCost}`,
    );
  }
});

test("売買: 買うと spend オプが出てかばんに入り、売ると earn オプが出る", () => {
  const bought = eco.buyItem(fresh(), "wood", 2, 100);
  assert.equal(bought.ok, true);
  assert.deepEqual(bought.coin, { kind: "spend", amount: 16, reason: "shop_buy" });
  assert.equal(eco.countItem(bought.profile, "wood"), 2);
  assert.equal(bought.profile.coins, 100, "プロフィールの coins は触らない（正はブリッジ）");
  const sold = eco.sellItem(bought.profile, "wood", 1);
  assert.deepEqual(sold.coin, { kind: "earn", amount: 4, reason: "shop_sale" });
  assert.equal(eco.countItem(sold.profile, "wood"), 1);
  assert.equal(eco.sellItem(fresh(), "wood").error, "not_enough_items");
  // 残高は引数（実残高）で検証する
  assert.equal(eco.buyItem(fresh(), "wood", 1, 3).error, "not_enough_coins");
  assert.equal(eco.buyItem(fresh(), "wood", 1, 8).ok, true);
});

test("食事と労働: 食べて回復し、働くと空腹度と引き換えに earn オプが出る", () => {
  const tired = { ...fresh(), hunger: 30, items: { bread: 1 } };
  const ate = eco.eatItem(tired, "bread");
  assert.equal(ate.profile.hunger, 50);
  assert.equal(eco.countItem(ate.profile, "bread"), 0);
  assert.equal(ate.coin, undefined);
  const worked = eco.doWork(fresh());
  assert.equal(worked.profile.hunger, 90);
  assert.deepEqual(worked.coin, { kind: "earn", amount: 20, reason: "work" });
  assert.equal(worked.profile.coins, 100, "プロフィールの coins は触らない");
  assert.equal(eco.doWork({ ...fresh(), hunger: 5 }).error, "too_tired");
  assert.equal(eco.eatItem({ ...fresh(), hunger: 50 }, "bread").error, "not_enough_items");
});

test("合成: 素材を消費して成果物が得られ、足りなければ失敗する", () => {
  const withWood = { ...fresh(), items: { wood: 3 } };
  const crafted = eco.craftItem(withWood, "carving", () => 0.99);
  assert.equal(crafted.ok, true);
  assert.equal(eco.countItem(crafted.profile, "carving"), 1);
  assert.equal(eco.countItem(crafted.profile, "wood"), 0);
  assert.equal(eco.craftItem(fresh(), "carving").error, "not_enough_items");
  const rare = eco.craftItem({ ...fresh(), items: { herb: 2, glass: 1 } }, "potion", () => 0);
  assert.equal(eco.countItem(rare.profile, "star_shard"), 1);
});

test("steal 成功: 対象の実残高の5%（上限つき）を奪い、両者に時刻が付く", () => {
  const actor = fresh();
  const target = { ...fresh(), coins: 400 };
  const balances = { actorCoins: 100, targetCoins: 400 };
  const result = eco.resolveSteal(actor, target, 100_000_000, () => 0, balances);
  assert.equal(result.ok, true);
  assert.equal(result.success, true);
  assert.equal(result.amount, 20);
  assert.equal(result.coin, undefined, "成功時の移動は steal オプ（ルート側で積む）");
  // プロフィールの coins は両者とも触らない。変わるのは時刻だけ
  assert.equal(result.actor.coins, 100);
  assert.equal(result.target.coins, 400);
  assert.equal(result.actor.stealActorAt, 100_000_000);
  assert.equal(result.target.stealTargetAt, 100_000_000);
  const capped = eco.resolveSteal(fresh(), fresh(), 100_000_000, () => 0, { actorCoins: 0, targetCoins: 100000 });
  assert.equal(capped.amount, eco.STEAL_MAX_AMOUNT);
});

test("steal 失敗: 罰金は spend オプ（実残高が上限）", () => {
  const result = eco.resolveSteal(fresh(), fresh(), 100_000_000, () => 0.99, { actorCoins: 100, targetCoins: 400 });
  assert.equal(result.success, false);
  assert.equal(result.amount, eco.STEAL_FINE_AMOUNT);
  assert.deepEqual(result.coin, { kind: "spend", amount: eco.STEAL_FINE_AMOUNT, reason: "steal_fine" });
  assert.equal(result.actor.coins, 100, "プロフィールの coins は触らない");
  const broke = eco.resolveSteal(fresh(), fresh(), 100_000_000, () => 0.99, { actorCoins: 5, targetCoins: 400 });
  assert.equal(broke.amount, 5);
  const penniless = eco.resolveSteal(fresh(), fresh(), 100_000_000, () => 0.99, { actorCoins: 0, targetCoins: 400 });
  assert.equal(penniless.amount, 0);
  assert.equal(penniless.coin, undefined, "罰金0ならオプも積まない");
});

test("steal の保護: 少額の相手・防犯チャーム・クールダウン・直近被害", () => {
  const now = 10_000_000;
  const rich = { actorCoins: 100, targetCoins: 400 };
  const poor = { actorCoins: 100, targetCoins: eco.STEAL_TARGET_MIN_COINS - 1 };
  assert.equal(eco.resolveSteal(fresh(), fresh(), now, () => 0, poor).error, "target_protected");
  const guarded = { ...fresh(), items: { guard_charm: 1 } };
  assert.equal(eco.resolveSteal(fresh(), guarded, now, () => 0, rich).error, "target_protected");
  const cooling = { ...fresh(), stealActorAt: now - 1000 };
  assert.equal(eco.resolveSteal(cooling, fresh(), now, () => 0, rich).error, "steal_cooldown");
  const recent = { ...fresh(), stealTargetAt: now - 1000 };
  assert.equal(eco.resolveSteal(fresh(), recent, now, () => 0, rich).error, "target_recently_stolen");
});

test("怪盗マスクで成功率が上がる（素の成功率では失敗する目でも成功）", () => {
  const masked = { ...fresh(), items: { thief_mask: 1 } };
  const balances = { actorCoins: 100, targetCoins: 400 };
  // 素の成功率 0.40 では失敗する 0.5 の目が、マスク (+0.15) では成功する
  assert.equal(eco.resolveSteal(fresh(), fresh(), 100_000_000, () => 0.5, balances).success, false);
  assert.equal(eco.resolveSteal(masked, fresh(), 100_000_000, () => 0.5, balances).success, true);
});

test("プロフィールの検証: 未定義アイテムは捨てられ、所持数はクランプされる", () => {
  const parsed = eco.parseProfile('{"coins": 50, "hunger": 40, "items": {"wood": 3, "unknown_thing": 5, "stone": -2}}');
  assert.deepEqual(parsed.items, { wood: 3 });
  assert.equal(parsed.coins, 50);
});

test("クライアント配線: 経済パネルと API がつながっている", () => {
  const client = fs.readFileSync(path.join(rootDir, "app/games/worldbox/WorldBoxClient.tsx"), "utf8");
  assert.match(client, /WorldBoxEconomyPanel/);
  assert.match(client, /経済/);
  assert.match(client, /座標 X/);
  const presenceOnline = fs.readFileSync(path.join(libDir, "worldbox/presence-online.ts"), "utf8");
  assert.match(presenceOnline, /findPresenceOwnerKey/);
  const panel = fs.readFileSync(path.join(rootDir, "app/games/worldbox/WorldBoxEconomyPanel.tsx"), "utf8");
  for (const action of ["buy", "sell", "eat", "craft", "work", "steal"]) {
    assert.ok(panel.includes(`"${action}"`) || panel.includes(action), action);
  }
  const route = fs.readFileSync(path.join(rootDir, "app/api/worldbox/profile/route.ts"), "utf8");
  assert.match(route, /resolveSteal/);
  assert.match(route, /findPresenceOwnerKey/);
  // コインはブリッジのオプとして積み、残高表示はブリッジ側が正
  assert.match(route, /buildEconomyOp/);
  assert.match(route, /economy-bridge/);
  assert.ok(!panel.includes("profile.coins"), "残高表示にプロフィールの coins を使わない");
  assert.ok(panel.includes("/api/worldbox/economy"), "パネルがブリッジ API を使っていない");
});

test("ショップはロビー空間でのみ開く（クライアントが空間を渡し、パネルが制限する）", () => {
  const client = fs.readFileSync(path.join(rootDir, "app/games/worldbox/WorldBoxClient.tsx"), "utf8");
  assert.match(client, /<WorldBoxEconomyPanel space=\{spaceUi\} \/>/);
  const panel = fs.readFileSync(path.join(rootDir, "app/games/worldbox/WorldBoxEconomyPanel.tsx"), "utf8");
  assert.match(panel, /space === "lobby"/);
  assert.match(panel, /inLobby && tabBtn\("shop"/);
  assert.match(panel, /ショップ（売買）はロビーでのみ利用できます/);
});
