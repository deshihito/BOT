// AGO WORLD BOX の取引所（/general の本物アゴトークン市場との接続）の検証:
// - market.ts: スナップショットの解釈と見積もり（Bot 側 quote と同じ式）
// - market-online.ts: bot_kv 名前空間とオプの配線（ソース確認）
// - GET /api/worldbox/exchange: スナップショットから本人の保有量つきで返す
// - profile ルート: token_buy / token_sell / token_convert は市場オプ経由
// - 旧アイテム版 ago_token は通常売却できない（sellItem が拒否）
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const here = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(here, "..");
const libDir = path.join(rootDir, "lib");

function transpile(rel, base = libDir) {
  const file = path.join(base, rel);
  const source = fs.readFileSync(file, "utf8");
  return ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}
function dataUrl(code) {
  return "data:text/javascript;base64," + Buffer.from(code).toString("base64");
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
function bundleModule(files, names) {
  const code = files.map((name) => stripModuleSyntax(transpile(name))).join("\n");
  return dataUrl(`${code}\nexport { ${names.join(", ")} };`);
}

const market = await import(bundleModule(
  ["worldbox/market.ts"],
  ["parseMarketSnapshot", "marketBalanceOf", "quoteBuyTokens", "quoteSellAga", "quantizeTokens", "MARKET_FEE_RATE"],
));
const eco = await import(bundleModule(
  ["worldbox/items.ts", "worldbox/profile.ts", "worldbox/vitals.ts", "worldbox/economy.ts"],
  ["sellItem", "itemById", "parseProfile"],
));

const profileSrc = fs.readFileSync(path.join(rootDir, "app/api/worldbox/profile/route.ts"), "utf8");
const exchangeRouteSrc = fs.readFileSync(path.join(rootDir, "app/api/worldbox/exchange/route.ts"), "utf8");
const marketOnlineSrc = fs.readFileSync(path.join(libDir, "worldbox/market-online.ts"), "utf8");
const panelSrc = fs.readFileSync(path.join(rootDir, "app/games/worldbox/WorldBoxEconomyPanel.tsx"), "utf8");

// ---------- market.ts（純粋ロジック） ----------

test("parseMarketSnapshot: Bot の公開形式を解釈し、保有量を引ける", () => {
  const snap = market.parseMarketSnapshot({
    rate: 123.45,
    history: [{ t: "2026-11-18T10:00:00+09:00", rate: 120 }, { t: "x", rate: 123.45 }],
    halted: false,
    haltReason: "",
    tradeCapAga: 5000,
    balances: { "12345": 7.5 },
    updatedAt: "2026-11-18T10:05:00+09:00",
  });
  assert.ok(snap);
  assert.equal(snap.rate, 123.45);
  assert.equal(snap.history.length, 2);
  assert.equal(market.marketBalanceOf(snap, "12345"), 7.5);
  assert.equal(market.marketBalanceOf(snap, "99999"), 0);
});

test("parseMarketSnapshot: レートが無い・不正なら null", () => {
  assert.equal(market.parseMarketSnapshot(null), null);
  assert.equal(market.parseMarketSnapshot({}), null);
  assert.equal(market.parseMarketSnapshot({ rate: 0 }), null);
  assert.equal(market.parseMarketSnapshot({ rate: "100" }), null);
});

test("見積もりは Bot 側 quote と同じ式（手数料1%・切り捨て・0.01単位）", () => {
  // quote_buy: fee = int(aga * 0.01), tokens = (aga - fee) / rate を 0.01 切り捨て
  const buy = market.quoteBuyTokens(1000, 100);
  assert.deepEqual(buy, { fee: 10, netAga: 990, tokens: 9.9 });
  const buy2 = market.quoteBuyTokens(10000, 123.45);
  assert.equal(buy2.fee, 100);
  assert.equal(buy2.tokens, market.quantizeTokens(9900 / 123.45));
  // quote_sell: gross = int(tokens * rate), fee = int(gross * 0.01)
  const sell = market.quoteSellAga(9.9, 100);
  assert.deepEqual(sell, { grossAga: 990, fee: 9, netAga: 981 });
  assert.equal(market.MARKET_FEE_RATE, 0.01);
});

// ---------- 配線（ソース確認） ----------

test("market-online: 名前空間 worldbox_market と snapshot キーで bot_kv を使う", () => {
  assert.ok(marketOnlineSrc.includes('WORLDBOX_MARKET_NAMESPACE = "worldbox_market"'));
  assert.ok(marketOnlineSrc.includes('MARKET_SNAPSHOT_KEY = "snapshot"'));
  assert.ok(marketOnlineSrc.includes("kvGet") && marketOnlineSrc.includes("kvSet"));
  assert.ok(marketOnlineSrc.includes("submitMarketOp") && marketOnlineSrc.includes("waitForMarketOp"));
});

test("取引所の価格表示ルートはスナップショットから返す（決定的価格は廃止）", () => {
  assert.ok(exchangeRouteSrc.includes("loadMarketSnapshot"));
  assert.ok(exchangeRouteSrc.includes("marketBalanceOf"));
  assert.ok(!exchangeRouteSrc.includes("tokenPriceAt"));
  assert.ok(!fs.existsSync(path.join(libDir, "worldbox/exchange.ts")), "旧 exchange.ts が残っている");
});

test("profile ルート: token 系は市場オプ経由で、旧価格遷移を使わない", () => {
  assert.ok(profileSrc.includes("submitMarketOp") && profileSrc.includes("waitForMarketOp"));
  assert.ok(profileSrc.includes("token_buy"));
  assert.ok(profileSrc.includes("token_convert"));
  assert.ok(profileSrc.includes("tokenConvertNonce"), "変換の冪等マーカーが無い");
  assert.ok(!profileSrc.includes("buyToken") && !profileSrc.includes("sellToken"));
  assert.ok(!profileSrc.includes("tokenPriceAt"));
});

test("経済パネル: 取引所タブは本物残高と AGO 買い／トークン売り／変換を出す", () => {
  assert.ok(panelSrc.includes("tokenInfo?.balance") || panelSrc.includes("tokenInfo.balance"));
  assert.ok(panelSrc.includes('action: "token_buy", agaAmount'));
  assert.ok(panelSrc.includes('action: "token_sell", tokenAmount'));
  assert.ok(panelSrc.includes('action: "token_convert"'));
  assert.ok(panelSrc.includes("quoteBuyTokens") && panelSrc.includes("quoteSellAga"));
  assert.ok(panelSrc.includes("market_trade_failed"), "Bot の失敗文言を表示していない");
});

// ---------- 旧アイテム版トークン ----------

test("sellItem: 旧アゴトークンは通常売却できない", () => {
  const profile = eco.parseProfile(JSON.stringify({
    coins: 0, hunger: 100, hp: 100, status: [], items: { ago_token: 2 },
    hotbar: [], storage: [], role: "free",
  }));
  const result = eco.sellItem(profile, "ago_token", 1);
  assert.equal(result.ok, false);
  assert.equal(result.error, "not_sellable");
});
