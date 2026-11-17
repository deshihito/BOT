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
  ["worldbox/items.ts", "worldbox/profile.ts", "worldbox/roles.ts", "worldbox/vitals.ts", "worldbox/economy.ts"],
  [
    "ITEMS", "itemById", "RECIPES", "recipeById", "sellPrice",
    "DEFAULT_PROFILE", "parseProfile", "serializeProfile", "countItem",
    "buyItem", "sellItem", "eatItem", "doWork", "craftItem", "craftFromInputs", "resolveSteal",
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
    // 精錬・織りの変換レシピも利便性レシピ（素材を中間材に変えるだけ。売却益でなく用途が価値）
    if (recipe.kind === "smelt" || recipe.kind === "weave") continue;
    assert.ok(
      eco.sellPrice(output) * recipe.outputCount > inputCost,
      `${recipe.id}: sell=${eco.sellPrice(output)} cost=${inputCost}`,
    );
  }
});

test("売買: 買うと spend オプが出てかばんに入り、売ると earn オプが出る", () => {
  const bought = eco.buyItem(fresh(), "wood", 2, 1000);
  assert.equal(bought.ok, true);
  assert.deepEqual(bought.coin, { kind: "spend", amount: 160, reason: "shop_buy" });
  assert.equal(eco.countItem(bought.profile, "wood"), 2);
  assert.equal(bought.profile.coins, 100, "プロフィールの coins は触らない（正はブリッジ）");
  const sold = eco.sellItem(bought.profile, "wood", 1);
  assert.deepEqual(sold.coin, { kind: "earn", amount: 48, reason: "shop_sale" });
  assert.equal(eco.countItem(sold.profile, "wood"), 1);
  assert.equal(eco.sellItem(fresh(), "wood").error, "not_enough_items");
  // 残高は引数（実残高）で検証する
  assert.equal(eco.buyItem(fresh(), "wood", 1, 30).error, "not_enough_coins");
  assert.equal(eco.buyItem(fresh(), "wood", 1, 80).ok, true);
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

test("自由セット合成: 完全一致は成果物と hint exact、不一致は失敗作が残る", () => {
  const exact = eco.craftFromInputs({ ...fresh(), items: { wood: 3 } }, { wood: 3 }, () => 0.99);
  assert.equal(exact.ok, true);
  assert.equal(exact.matched, true);
  assert.equal(exact.hint, "exact");
  assert.equal(exact.resultId, "carving");
  assert.equal(exact.recipe.id, "carving");
  assert.equal(eco.countItem(exact.profile, "carving"), 1);
  assert.equal(eco.countItem(exact.profile, "wood"), 0);
  const far = eco.craftFromInputs({ ...fresh(), items: { meal: 1 } }, { meal: 1 });
  assert.equal(far.ok, true);
  assert.equal(far.matched, false);
  assert.equal(far.hint, "far");
  assert.equal(far.resultId, "mystery_lump");
  assert.equal(far.recipe, null);
  assert.equal(far.rare, null);
  assert.equal(eco.countItem(far.profile, "mystery_lump"), 1);
  assert.equal(eco.countItem(far.profile, "meal"), 0);
});

test("自由セット合成: near は素材種の半分超を共有するレシピがある時", () => {
  // potion は herb×2 + glass×1（2種）。herb×1 + glass×1 は種は一致するが数が違う
  const near = eco.craftFromInputs({ ...fresh(), items: { herb: 1, glass: 1 } }, { herb: 1, glass: 1 });
  assert.equal(near.ok, true);
  assert.equal(near.matched, false);
  assert.equal(near.hint, "near");
  assert.equal(eco.countItem(near.profile, "mystery_lump"), 1);
  assert.equal(eco.countItem(near.profile, "herb"), 0);
  assert.equal(eco.countItem(near.profile, "glass"), 0);
});

test("自由セット合成: 素材不足は消費せずエラー、不正入力は弾く", () => {
  const before = { ...fresh(), items: { herb: 1 } };
  const lack = eco.craftFromInputs(before, { herb: 1, glass: 1 });
  assert.equal(lack.ok, false);
  assert.equal(lack.error, "not_enough_items");
  assert.equal(eco.countItem(before, "herb"), 1, "失敗時に素材を消費しない");
  // 完全一致レシピでも素材が足りなければ not_enough_items
  assert.equal(eco.craftFromInputs({ ...fresh(), items: { wood: 2 } }, { wood: 3 }).error, "not_enough_items");
  const rich = { ...fresh(), items: { wood: 9, stone: 9, herb: 9, glass: 9, cloth: 9 } };
  assert.equal(eco.craftFromInputs(rich, { wood: 1, stone: 1, herb: 1, glass: 1, cloth: 1 }).error, "invalid_request", "5種は不可");
  assert.equal(eco.craftFromInputs(rich, { wood: 7 }).error, "invalid_request", "1種7個は不可");
  assert.equal(eco.craftFromInputs(rich, { wood: 0 }).error, "invalid_request");
  assert.equal(eco.craftFromInputs(rich, { wood: 1.5 }).error, "invalid_request");
  assert.equal(eco.craftFromInputs(rich, { unknown_thing: 1 }).error, "unknown_item");
  assert.equal(eco.craftFromInputs(rich, {}).error, "invalid_request", "空は不可");
  assert.equal(eco.craftFromInputs(rich, null).error, "invalid_request");
  assert.equal(eco.craftFromInputs(rich, ["wood"]).error, "invalid_request");
  // 失敗作はレシピの材料になっていない（どのレシピの inputs にも無い）
  for (const recipe of eco.RECIPES) assert.ok(!("mystery_lump" in recipe.inputs), recipe.id);
  const lump = eco.itemById("mystery_lump");
  assert.equal(lump.category, "material");
  assert.equal(lump.icon, "/img/worldbox/items/slime.png");
});

test("発見レシピはプロフィールに往復し、文字列だけが残る", () => {
  const parsed = eco.parseProfile({ discoveredRecipes: ["carving", "potion", 42, "carving", null] });
  assert.deepEqual(parsed.discoveredRecipes, ["carving", "potion"]);
  const back = eco.parseProfile(eco.serializeProfile(parsed));
  assert.deepEqual(back.discoveredRecipes, ["carving", "potion"]);
  assert.deepEqual(eco.parseProfile({ discoveredRecipes: "carving" }).discoveredRecipes, []);
  assert.deepEqual(fresh().discoveredRecipes, []);
});

test("合成の作り直し配線: パネルはレシピ一覧を出さず台UI、ルートは自由セット式を使う", () => {
  const panel = fs.readFileSync(path.join(rootDir, "app/games/worldbox/WorldBoxEconomyPanel.tsx"), "utf8");
  assert.ok(!panel.includes("RECIPES"), "旧レシピ全件リストが残っている");
  assert.ok(!panel.includes("レア: "), "レア名の事前表示が残っている");
  assert.match(panel, /火を入れる/);
  assert.match(panel, /発見した組み合わせ/);
  assert.match(panel, /discoveredRecipes/);
  const route = fs.readFileSync(path.join(rootDir, "app/api/worldbox/profile/route.ts"), "utf8");
  assert.match(route, /craftFromInputs/);
  assert.match(route, /discoveredRecipes/);
  assert.match(route, /hint/);
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
  for (const action of ["buy", "sell", "eat", "craft"]) {
    assert.ok(panel.includes(`"${action}"`) || panel.includes(action), action);
  }
  // steal は一旦廃止（2026-11-16）: パネルにタブが無く、ルートは拒否する
  assert.ok(!panel.includes('tabBtn("steal"'), "steal タブが残っている");
  const route = fs.readFileSync(path.join(rootDir, "app/api/worldbox/profile/route.ts"), "utf8");
  assert.match(route, /steal_disabled/);
  assert.ok(!route.includes("resolveSteal"), "ルートが steal を解決している");
  // 労働は廃止（2026-11-16）: パネルにボタンが無く、ルートは拒否する
  assert.ok(!panel.includes("労働する"), "労働ボタンが残っている");
  assert.ok(!panel.includes('action: "work"'), "パネルが労働アクションを送っている");
  assert.match(route, /work_disabled/);
  assert.ok(!route.includes("doWork"), "ルートが労働を解決している");
  // コインはブリッジのオプとして積み、残高表示はブリッジ側が正
  assert.match(route, /buildEconomyOp/);
  assert.match(route, /economy-bridge/);
  assert.ok(!panel.includes("profile.coins"), "残高表示にプロフィールの coins を使わない");
  assert.ok(panel.includes("/api/worldbox/economy"), "パネルがブリッジ API を使っていない");
});

test("売買・合成・送金は施設の前でのみ開く（クライアントがステーションを渡し、パネルと API が制限する）", () => {
  const client = fs.readFileSync(path.join(rootDir, "app/games/worldbox/WorldBoxClient.tsx"), "utf8");
  assert.match(client, /<WorldBoxEconomyPanel space=\{spaceUi\} station=\{stationUi\} genre=\{stationGenre\} worldStationKinds=\{worldStationKinds\} onClose=\{\(\) => setShowEconomy\(false\)\} \/>/);
  const panel = fs.readFileSync(path.join(rootDir, "app/games/worldbox/WorldBoxEconomyPanel.tsx"), "utf8");
  assert.match(panel, /space === "lobby"/);
  // タブは「ロビーにいる」だけでは出ない。対応する施設の前にいる時だけ
  assert.match(panel, /station === "shop"/);
  assert.match(panel, /atShop && shopItems\.length > 0 && tabBtn\("shop"/);
  assert.match(panel, /station === "smith"/);
  assert.match(panel, /atWorkbench && tabBtn\("craft"/);
  assert.match(panel, /station === "bank"/);
  assert.match(panel, /atBank && tabBtn\("bank"/);
  // サーバー側もプレゼンスで位置検証する（表示だけの制限にしない）
  const profileRoute = fs.readFileSync(path.join(rootDir, "app/api/worldbox/profile/route.ts"), "utf8");
  assert.match(profileRoute, /loadMyLobbyStation/);
  assert.match(profileRoute, /not_at_shop/);
  assert.match(profileRoute, /not_at_workbench/);
  const economyRoute = fs.readFileSync(path.join(rootDir, "app/api/worldbox/economy/route.ts"), "utf8");
  assert.match(economyRoute, /loadMyLobbyStation/);
  assert.match(economyRoute, /not_at_bank/);
  // 共有ノートの方針: 画面内に説明文を置かない（制限の案内文も置かない）
  assert.ok(!panel.includes("ショップ（売買）はロビーでのみ利用できます"), "説明文が残っている");
});
