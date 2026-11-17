// AGO WORLD BOX 残A sweep（2026-11-17 監査の残項目）の検証:
// - 戦争マークの地図表示: warMarksByNation（防衛側は HP、攻撃側は null、
//   期限切れ・終了済みは出ない）と nations 応答・描画への配線
// - ギルドショップ「下げる」: GET の mine フラグとパネル条件が
//   サーバーの unlist 権限（出品者本人 / 区画ギルドのリーダー）と一致
// - ギルドショップの地図表現: relay watch（guildShop poke）→
//   クライアント取り直し → カウンター上のギルド名描画の配線
// - チャット掲示の RMW 直列化（Web 側 appendChatMessage のロック）
// - PvP 参加費とカジノ先払いの直接提出（submitEconomyOp）への移行と、
//   ブラックジャックの hit/stand への先払い確認ゲート
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const rootDir = path.join(import.meta.dirname, "..");
const libDir = path.join(rootDir, "lib");
const require = createRequire(import.meta.url);
const watch = require(path.join(rootDir, "realtime", "watch-core.js"));

function transpile(name, base = libDir) {
  const src = fs.readFileSync(path.join(base, name), "utf8");
  return ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}
function dataUrl(js) {
  return "data:text/javascript;base64," + Buffer.from(js).toString("base64");
}
function read(rel) {
  return fs.readFileSync(path.join(rootDir, rel), "utf8");
}

const W = await import(dataUrl(transpile("worldbox/war.ts")));
const NOW = 1_700_000_000_000;
const A = { id: "111111111111111111", name: "あごサーバー" };
const B = { id: "222222222222222222", name: "もちサーバー" };

// ---------- 戦争マーク表示 ----------

test("war-marks: 防衛側はマーク HP、攻撃側は markHp null で返る", () => {
  const r = W.declareWar(W.emptyWarState(), A, B, NOW);
  assert.equal(r.ok, true);
  const marks = W.warMarksByNation(r.state, NOW + 1000);
  assert.deepEqual(marks[B.id], { markHp: 100, markMax: 100 });
  assert.deepEqual(marks[A.id], { markHp: null, markMax: 100 });
});

test("war-marks: 削られた HP がそのまま出る / 期限切れと終了済みは出ない", () => {
  const r = W.declareWar(W.emptyWarState(), A, B, NOW);
  const hit = W.attackMark(r.state, r.war.id, "pid-1", NOW + 60_000);
  assert.equal(hit.ok, true);
  const marks = W.warMarksByNation(hit.state, NOW + 60_000);
  assert.equal(marks[B.id].markHp, 90);
  // 期限を過ぎたら（未精算でも）出ない
  assert.deepEqual(W.warMarksByNation(hit.state, NOW + W.WAR_DURATION_MS + 1), {});
  // 終了済みは出ない
  const closed = W.expireWars(hit.state, NOW + W.WAR_DURATION_MS + 1);
  assert.deepEqual(W.warMarksByNation(closed, NOW + 1000), {});
});

test("war-marks: nations 応答に warMarks が載り、ルートが表示国だけに絞る", () => {
  const nationsSrc = read("lib/worldbox/nations.ts");
  assert.match(nationsSrc, /warMarks: Record<string, \{ markHp: number \| null; markMax: number \}>/);
  assert.match(nationsSrc, /warMarks: \{\},/);
  const routeSrc = read("app/api/worldbox/nations/route.ts");
  assert.match(routeSrc, /warMarksByNation\(await loadWarState\(\), Date\.now\(\)\)/);
  assert.match(routeSrc, /visible\.has\(guildId\)/);
  const clientSrc = read("app/games/worldbox/WorldBoxClient.tsx");
  assert.match(clientSrc, /nationsRef\.current\.warMarks\?\.\[nation\.id\]/);
  assert.match(clientSrc, /warMark\.markHp \/ warMark\.markMax/);
});

// ---------- ギルドショップ「下げる」 ----------

test("guild-shop: GET の view が mine を返し、生キーは出ない", () => {
  const routeSrc = read("app/api/worldbox/guild-shop/route.ts");
  assert.match(routeSrc, /mine: l\.sellerKey === viewerKey/);
  assert.match(routeSrc, /view\(state, nations, ownerKey\)/);
  assert.match(routeSrc, /view\(pruned, nations, ownerKey\)/);
  // view の listings に sellerKey が含まれないこと
  const viewBlock = routeSrc.slice(routeSrc.indexOf("function view("), routeSrc.indexOf("/** 国家設定込み"));
  assert.ok(!viewBlock.includes("sellerKey: l.sellerKey"), "view が sellerKey を漏らしている");
});

test("guild-shop: パネルの「下げる」条件がサーバーの unlist 権限と一致する", () => {
  const routeSrc = read("app/api/worldbox/guild-shop/route.ts");
  // サーバー側の正: 本人 or 区画ギルドのリーダー
  assert.match(routeSrc, /const mine = found\.listing\.sellerKey === ownerKey;/);
  assert.match(routeSrc, /const leaderOfPlot = myGuild === found\.plot\.guildId && isLeader;/);
  const panelSrc = read("app/games/worldbox/WorldBoxGuildShopPanel.tsx");
  assert.match(panelSrc, /\(sel\.mine \|\| \(isLeader && shop\.myGuildId === plot\.guildId\)\)/);
  assert.ok(!panelSrc.includes("|| true"), "常時真の条件が残っている");
});

// ---------- ギルドショップの地図表現 ----------

test("guild-shop watch: WATCH_PLAN に guildShop（worldbox_guild_shop・poke）が入る", () => {
  const plan = watch.WATCH_PLAN.find((p) => p.kind === "guildShop");
  assert.ok(plan, "guildShop の watch が無い");
  assert.equal(plan.namespace, "worldbox_guild_shop");
});

test("guild-shop watch: relay が sync guildShop を流し、クライアントが取り直して地図に描く", () => {
  const serverSrc = read("realtime-server.js");
  assert.match(serverSrc, /kind === "guildShop"/);
  assert.match(serverSrc, /\{ t: "sync", kind: "guildShop" \}/);
  const clientSrc = read("app/games/worldbox/WorldBoxClient.tsx");
  assert.match(clientSrc, /msg\.kind === "guildShop"/);
  assert.match(clientSrc, /guildShopRefreshRef\.current\(true\)/);
  assert.match(clientSrc, /notifyGuildShopChanged\(\)/);
  // 借り区画のギルド名をカウンター上に描く
  assert.match(clientSrc, /GUILD_PLOT_ANCHORS\[plot\.idx\]/);
  assert.match(clientSrc, /fillText\(plot\.guildName, gx, gy - 5\)/);
  // パネルも合図で取り直す
  const panelSrc = read("app/games/worldbox/WorldBoxGuildShopPanel.tsx");
  assert.match(panelSrc, /onGuildShopChanged/);
});

// ---------- チャット掲示の RMW 直列化 ----------

test("chat: appendChatMessage がリスト単位のロックで直列化される", () => {
  const src = read("lib/worldbox/chat-online.ts");
  assert.match(src, /withUserLock\(`chat-list:\$\{namespaceFor\(message\.channel\)\}:\$\{key\}`/);
});

// ---------- 経済の残存窓（PvP / カジノ） ----------

test("pvp: 参加費は submitEconomyOp で直接提出され、確定失敗は待ちから外す", () => {
  const src = read("app/api/worldbox/pvp/route.ts");
  assert.match(src, /async function submitFee\(/);
  assert.match(src, /await submitEconomyOp\(op\)/);
  assert.match(src, /feeA\.state === "failed"/);
  assert.match(src, /feeB\.state === "failed"/);
  // 決闘作成は両費の提出後（従来どおり savePvpDuel は提出の後段）
  const submitIdx = src.indexOf("await submitFee(b.ownerKey");
  const saveIdx = src.indexOf("await savePvpDuel(next)");
  assert.ok(submitIdx >= 0 && saveIdx > submitIdx, "参加費の提出が決闘保存より前に無い");
});

test("casino: 先払いは submitSpend（直接提出）で、BJ の hit/stand に確認ゲートがある", () => {
  const src = read("app/api/worldbox/casino/route.ts");
  assert.match(src, /async function submitSpend\(/);
  assert.match(src, /await submitEconomyOp\(op\)/);
  for (const reason of ["slot7Prepay", "doubleBet", "blackjackBet"]) {
    assert.match(src, new RegExp(`submitSpend\\(ctx\\.userKey, ctx\\.discordId, \\{\\s*amount: \\w+, reason: CASINO_SESSION_REASONS\\.${reason},?\\s*\\}\\)`), reason);
  }
  // hit/stand のゲート: pending は bet_pending、失敗はセッション破棄
  const hitIdx = src.indexOf('action === "bj_hit"');
  const gateIdx = src.indexOf("spendStatuses(ctx.userKey, bjs.spendOpIds)", hitIdx);
  assert.ok(gateIdx > hitIdx, "bj_hit/stand に先払い確認が無い");
  const gateBlock = src.slice(gateIdx, gateIdx + 400);
  assert.match(gateBlock, /bet_pending/);
  assert.match(gateBlock, /bet_failed/);
});
