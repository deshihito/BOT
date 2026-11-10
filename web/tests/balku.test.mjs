// BALKU（lib/balku-game.ts / lib/games-catalog.ts）の検証。
// 元の server/balkuGame.test.ts を土台に、games.test.mjs と同じ
// loadBundle 方式で TS を読み込む。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const libDir = path.join(import.meta.dirname, "..", "lib");

function transpile(name) {
  const src = fs.readFileSync(path.join(libDir, name), "utf8");
  return ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}

function stripModuleSyntax(code) {
  return code
    .split("\n")
    .filter((line) => !/^import\s/.test(line))
    .map((line) =>
      line
        .replace(/^export\s+(?=(const|let|var|function|class)\s)/, "")
        .replace(/^export\s+(?=async\s+function)/, "")
        .replace(/^export\s*\{[^}]*\};?\s*$/, ""),
    )
    .join("\n");
}

async function loadBundle(files, exportNames) {
  const code =
    files.map((name) => stripModuleSyntax(transpile(name))).join("\n") +
    `\nexport { ${exportNames.join(", ")} };\n`;
  return import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
}

async function loadLib(name) {
  const js = transpile(name);
  return import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));
}

const balku = await loadBundle(
  ["balku-game.ts"],
  [
    "createLobbyState",
    "addLobbyPlayer",
    "startGame",
    "resetToLobby",
    "removePlayerFromState",
    "expireTimedOutTurn",
    "applyGameAction",
    "isLegalSubmission",
    "getTotalPoints",
    "scoreBreakdown",
    "getMarketPrice",
    "snapshotFor",
    "TURN_LIMIT_MS",
    "AUCTION_LIMIT_MS",
    "NEW_PROJECT_DEFINITIONS",
  ],
);
const catalog = await loadLib("games-catalog.ts");

const plan = (id, points, effect = { type: "coins", amount: 0, label: "" }, requirements = {}) => ({
  id,
  kind: "project",
  name: "検証企画",
  points,
  requirements,
  effect,
  immediate: false,
});
const mat = (id, kind) => ({ id, kind: "material", material: kind, name: kind, value: 0 });
const twoPlayers = () => {
  let state = balku.createLobbyState("施工者A");
  state = balku.addLobbyPlayer(state, "施工者B");
  return balku.startGame(state);
};

test("カタログ: balku が playable・アクティビティ対応でオンライン表記", () => {
  const game = catalog.getWebGame("balku");
  assert.ok(game);
  assert.equal(game.title, "BALKU");
  assert.equal(game.status, "playable");
  assert.equal(game.activity, true);
  assert.equal(game.players, "1〜4人（オンライン/CPU対戦）");
  assert.ok(catalog.playableGames().some((g) => g.slug === "balku"));
});

test("素材条件を満たす企画だけを正規完成として判定する", () => {
  const card = plan("plan", 5, undefined, { 木材: 2, 鉄骨: 1 });
  const materials = [mat("w1", "木材"), mat("w2", "木材"), mat("s1", "鉄骨")];
  assert.equal(balku.isLegalSubmission(card, materials), true);
  assert.equal(balku.isLegalSubmission(card, materials.slice(0, 2)), false);
});

test("固定山札は人数に応じて有限で、超伝導体は希少素材として含まれる", () => {
  let state = balku.createLobbyState("施工者A");
  state = balku.addLobbyPlayer(state, "施工者B");
  state = balku.addLobbyPlayer(state, "施工者C");
  const started = balku.startGame(state);
  assert.equal(started.deckInitialCount, 108);
  assert.equal(started.deck.length, 84);
  assert.deepEqual(started.players.map((p) => p.hand.length), [8, 8, 8]);
  assert.deepEqual(started.players.map((p) => p.coins), [3, 3, 3]);
  const premiumInDeck = started.deck.filter((c) => c.kind === "material" && c.material === "超伝導体").length;
  assert.ok(premiumInDeck < 6);
});

test("4人用固定山札では超伝導体が最大5枚で、全144枚に対して希少", () => {
  let state = balku.createLobbyState("施工者A");
  state = balku.addLobbyPlayer(state, "施工者B");
  state = balku.addLobbyPlayer(state, "施工者C");
  state = balku.addLobbyPlayer(state, "施工者D");
  const started = balku.startGame(state);
  const allCards = [...started.deck, ...started.players.flatMap((p) => p.hand)];
  assert.equal(allCards.length, 144);
  const premiumCount = allCards.filter((c) => c.kind === "material" && c.material === "超伝導体").length;
  assert.ok(premiumCount <= 5);
  assert.ok(premiumCount / allCards.length <= 0.035);
});

test("ロビー: 2人未満では開始できず、開始後の入室はできない", () => {
  const solo = balku.createLobbyState("施工者A");
  assert.throws(() => balku.startGame(solo), /2人以上/);
  const started = twoPlayers();
  assert.throws(() => balku.addLobbyPlayer(started, "施工者C"), /開始後/);
});

test("違法建築へのBALKU成功で企画書と添付素材をコール者が獲得する", () => {
  const state = twoPlayers();
  state.players[1].submitted.push({ id: "illegal", faceUp: false, legal: false, effectActivated: false, project: plan("p", 6), materials: [mat("m", "木材")] });
  const next = balku.applyGameAction(state, 0, { type: "bulkCall", targetSeat: 1, submissionId: "illegal" });
  assert.equal(next.players[1].submitted.length, 0);
  assert.ok(next.players[0].hand.some((c) => c.id === "p"));
  assert.ok(next.players[0].hand.some((c) => c.id === "m"));
});

test("BALKU失敗（点数が足りる）: 対象以上の企画をロストし、対象は開示・発動する", () => {
  const state = twoPlayers();
  state.players[0].hand = [plan("big", 6)];
  state.players[0].coins = 3;
  state.players[1].coins = 3;
  state.players[1].submitted.push({
    id: "legal",
    faceUp: false,
    legal: true,
    effectActivated: false,
    project: plan("target", 5, { type: "coins", amount: 2, label: "コイン +2" }),
    materials: [],
  });
  const next = balku.applyGameAction(state, 0, { type: "bulkCall", targetSeat: 1, submissionId: "legal" });
  assert.equal(next.players[0].eliminated, false);
  assert.ok(!next.players[0].hand.some((c) => c.id === "big"));
  assert.equal(next.players[1].submitted[0].faceUp, true);
  assert.equal(next.players[1].submitted[0].effectActivated, true);
  assert.equal(next.players[1].coins, 5);
});

test("BALKU失敗（点数不足）: 全ロストで脱落する", () => {
  const state = twoPlayers();
  state.players[0].hand = [plan("small", 2)];
  state.players[1].submitted.push({ id: "legal", faceUp: true, legal: true, effectActivated: true, project: plan("target", 9), materials: [] });
  const next = balku.applyGameAction(state, 0, { type: "bulkCall", targetSeat: 1, submissionId: "legal" });
  assert.equal(next.players[0].eliminated, true);
  assert.equal(next.players[0].hand.length, 0);
  assert.equal(next.players[0].submitted.length, 0);
});

test("正規完成した強制BALKU権は一度だけ相手企画を接収でき、再使用できない", () => {
  const state = twoPlayers();
  state.players[0].forceBulkCharges = [{ id: "audit", sourceProject: "言いがかり", used: false }];
  state.players[1].submitted.push({ id: "legal-target", faceUp: true, legal: true, effectActivated: true, project: plan("target", 8), materials: [] });
  const next = balku.applyGameAction(state, 0, { type: "forceBulk", chargeId: "audit", targetSeat: 1, submissionId: "legal-target" });
  assert.equal(next.players[0].forceBulkCharges[0].used, true);
  assert.ok(next.players[0].hand.some((c) => c.id === "target"));
  assert.equal(next.players[1].submitted.length, 0);
  assert.throws(() => balku.applyGameAction(next, 0, { type: "forceBulk", chargeId: "audit", targetSeat: 1, submissionId: "legal-target" }), /使用可能な強制BALKU権がありません/);
});

test("手札窃盗は唯一の対戦相手からランダムな手札1枚だけを奪う", () => {
  const state = twoPlayers();
  const steal = plan("steal", 1, { type: "stealCard", amount: 1, label: "手札を奪う" });
  steal.immediate = true;
  state.players[0].hand = [steal];
  state.players[1].hand = [plan("victim", 7), plan("victim2", 3)];
  const next = balku.applyGameAction(state, 0, { type: "submit", projectId: "steal", materialIds: [], faceUp: true });
  // 奪ったのはちょうど1枚（相手の残りは片方だけ。相手は次の手番で2枚ドロー済み）
  assert.equal(next.players[0].hand.length, 1);
  assert.ok(["victim", "victim2"].includes(next.players[0].hand[0].id));
  assert.equal(next.players[1].hand.filter((c) => ["victim", "victim2"].includes(c.id)).length, 1);
});

test("即時調達企画は指定素材を amount 枚だけ手札へ加える", () => {
  const state = twoPlayers();
  const supply = plan("supply", 0, { type: "gainMaterial", amount: 2, label: "合金を2枚獲得", material: "合金" });
  supply.immediate = true;
  state.players[0].hand = [supply];
  const next = balku.applyGameAction(state, 0, { type: "submit", projectId: "supply", materialIds: [], faceUp: true });
  assert.equal(next.players[0].hand.filter((c) => c.kind === "material" && c.material === "合金").length, 2);
});

test("randomMaterial は amount 枚ぶん素材を与える（元実装の1枚バグの修正）", () => {
  const state = twoPlayers();
  const card = plan("rand", 2, { type: "randomMaterial", amount: 2, label: "ランダム素材を2枚獲得" });
  card.immediate = true;
  state.players[0].hand = [card];
  const next = balku.applyGameAction(state, 0, { type: "submit", projectId: "rand", materialIds: [], faceUp: true });
  assert.equal(next.players[0].hand.length, 2);
  assert.ok(next.players[0].hand.every((c) => c.kind === "material"));
});

test("調達市場はコインを払って指定素材を得る。手番も行動権も消費しない", () => {
  const state = twoPlayers();
  state.players[0].coins = 20;
  const handBefore = state.players[0].hand.length;
  const next = balku.applyGameAction(state, 0, { type: "buyMaterial", material: "超伝導体" });
  assert.equal(balku.getMarketPrice("超伝導体"), 10);
  assert.equal(balku.getMarketPrice("合金"), 7);
  assert.equal(balku.getMarketPrice("木材"), 5);
  assert.equal(balku.getMarketPrice("ゴミ"), 1);
  assert.equal(next.players[0].coins, 10);
  assert.equal(next.players[0].hand.length, handBefore + 1);
  assert.ok(next.players[0].hand.some((c) => c.kind === "material" && c.material === "超伝導体"));
  assert.equal(next.activeSeat, 0, "購入では手番は進まない");
  assert.equal(next.players[0].actionUsed, false);
  // コインの限り続けて買える
  const twice = balku.applyGameAction(next, 0, { type: "buyMaterial", material: "ゴミ" });
  assert.equal(twice.players[0].coins, 9);
  assert.equal(twice.activeSeat, 0);
});

test("調達市場はコイン不足時に購入を拒否する", () => {
  const state = twoPlayers();
  state.players[0].coins = 4;
  assert.throws(() => balku.applyGameAction(state, 0, { type: "buyMaterial", material: "木材" }), /5コイン必要です/);
});

test("素材・企画を一律1コインで売却しても、同じ手番と行動権を維持する", () => {
  const state = twoPlayers();
  state.players[0].coins = 3;
  state.players[0].hand = [mat("lumber", "木材"), mat("alloy", "合金"), plan("keep", 5)];
  const next = balku.applyGameAction(state, 0, { type: "sellCards", cardIds: ["lumber", "alloy", "keep"] });
  assert.equal(next.players[0].coins, 6);
  assert.equal(next.players[0].hand.length, 0);
  assert.equal(next.activeSeat, 0);
  assert.equal(next.players[0].actionUsed, false);
  assert.throws(() => balku.applyGameAction(state, 0, { type: "sellCards", cardIds: [] }), /1枚以上/);
  assert.throws(() => balku.applyGameAction(state, 0, { type: "sellCards", cardIds: ["missing"] }), /手札にあるカードのみ/);
});

test("企画提出後は手動終了を待たずに次の施工者へ移り、相手は2枚ドローする", () => {
  const state = twoPlayers();
  const quick = plan("quick", 1, { type: "coins", amount: 2, label: "コイン +2" });
  quick.immediate = true;
  state.players[0].hand = [quick];
  state.players[0].coins = 3;
  const next = balku.applyGameAction(state, 0, { type: "submit", projectId: "quick", materialIds: [], faceUp: true });
  assert.equal(next.players[0].coins, 5);
  assert.equal(next.activeSeat, 1);
  assert.equal(next.players[1].hand.length, 10);
});

test("施工ターンは60秒で期限切れとなり、行動なしで自動パスする", () => {
  const state = twoPlayers();
  assert.ok(state.turnDeadlineAt !== null);
  assert.ok(state.turnDeadlineAt - Date.now() <= balku.TURN_LIMIT_MS);
  const next = balku.expireTimedOutTurn(state, state.turnDeadlineAt + 1);
  assert.notEqual(next, state);
  assert.equal(next.activeSeat, 1);
  assert.equal(next.turn, 2);
  assert.ok(next.turnDeadlineAt > Date.now());
  assert.ok(next.logs.some((log) => log.text.includes("施工時間が終了")));
  // 期限内なら同じ参照のまま（変化なし）
  assert.equal(balku.expireTimedOutTurn(state, Date.now()), state);
});

test("期限を持たない既存の対戦には自動パスせず60秒期限を付与する", () => {
  const state = twoPlayers();
  state.turnDeadlineAt = null;
  const next = balku.expireTimedOutTurn(state, 1000);
  assert.equal(next.activeSeat, 0);
  assert.equal(next.turn, 1);
  assert.equal(next.turnDeadlineAt, 1000 + balku.TURN_LIMIT_MS);
});

test("継続収入企画は所有者の次の施工ターン開始時にコインを与える", () => {
  const state = twoPlayers();
  state.players[0].submitted.push({
    id: "income",
    faceUp: true,
    legal: true,
    effectActivated: true,
    project: plan("income-plan", 6, { type: "income", amount: 1, label: "毎ターン +1" }),
    materials: [],
  });
  state.players[0].coins = 3;
  const afterA = balku.applyGameAction(state, 0, { type: "endTurn" });
  const returned = balku.applyGameAction(afterA, 1, { type: "endTurn" });
  assert.equal(returned.activeSeat, 0);
  assert.equal(returned.players[0].coins, 4);
});

test("継続収入企画を強制BALKUで接収された後は収入を得ない", () => {
  const state = twoPlayers();
  state.players[0].submitted.push({
    id: "income",
    faceUp: true,
    legal: true,
    effectActivated: true,
    project: plan("income-plan", 6, { type: "income", amount: 1, label: "毎ターン +1" }),
    materials: [],
  });
  state.players[0].coins = 3;
  state.players[1].forceBulkCharges = [{ id: "audit", sourceProject: "言いがかり", used: false }];
  const seized = balku.applyGameAction(state, 1, { type: "forceBulk", chargeId: "audit", targetSeat: 0, submissionId: "income" });
  const afterOwnerPass = balku.applyGameAction(seized, 0, { type: "endTurn" });
  const returned = balku.applyGameAction(afterOwnerPass, 1, { type: "endTurn" });
  assert.equal(returned.players[0].submitted.length, 0);
  assert.equal(returned.players[0].coins, 3);
});

test("一巡すると自動オークションが開き、入札で15秒延長され、期限で落札が決済される", () => {
  let state = twoPlayers();
  state = balku.applyGameAction(state, 0, { type: "endTurn" });
  state = balku.applyGameAction(state, 1, { type: "endTurn" });
  assert.ok(state.auction, "一巡の開始でオークションが開く");
  const openedDeadline = state.auction.deadlineAt;
  assert.ok(openedDeadline - Date.now() <= balku.AUCTION_LIMIT_MS);
  assert.ok(openedDeadline - Date.now() > balku.AUCTION_LIMIT_MS - 5000);
  const cardId = state.auction.card.id;
  state.players[1].coins = 5;
  const bid = balku.applyGameAction(state, 1, { type: "bid", amount: 1 });
  assert.equal(bid.auction.highestBid, 1);
  assert.equal(bid.auction.highestBidderSeat, 1);
  assert.ok(bid.auction.deadlineAt >= openedDeadline, "入札で期限が15秒へ延長される");
  assert.ok(bid.auction.deadlineAt - Date.now() > balku.AUCTION_LIMIT_MS - 5000);
  // 期限到来で決済（手番期限は未来なので手番は進まない）
  bid.auction.deadlineAt = 0;
  const settled = balku.expireTimedOutTurn(bid, 1000);
  assert.equal(settled.auction, null);
  assert.ok(settled.players[1].hand.some((c) => c.id === cardId));
  assert.equal(settled.players[1].coins, 4);
});

test("入札のないオークションは期限で取り下げられる", () => {
  let state = balku.createLobbyState("施工者A");
  state = balku.addLobbyPlayer(state, "施工者B");
  state = balku.addLobbyPlayer(state, "施工者C");
  state = balku.startGame(state);
  state = balku.applyGameAction(state, 0, { type: "endTurn" });
  state = balku.applyGameAction(state, 1, { type: "endTurn" });
  state = balku.applyGameAction(state, 2, { type: "endTurn" });
  assert.ok(state.auction);
  state.auction.deadlineAt = 0;
  const expired = balku.expireTimedOutTurn(state, 1000);
  assert.equal(expired.auction, null);
  assert.ok(expired.logs.some((log) => log.text.includes("自動オークション不成立")));
});

test("ミステリーハウスは+3コインと毎ターンの素材獲得、ミュージアムは企画を引く", () => {
  const state = twoPlayers();
  const mystery = plan("mystery", 5, { type: "mysteryHouse", amount: 1, label: "+3コイン / 毎ターン ランダム素材 +1" });
  state.players[0].coins = 3;
  state.players[0].hand = [mystery];
  const afterMystery = balku.applyGameAction(state, 0, { type: "submit", projectId: "mystery", materialIds: [], faceUp: true });
  assert.equal(afterMystery.players[0].coins, 6);
  const prize = plan("museum-prize", 4);
  afterMystery.deck = [prize, mat("d1", "木材"), mat("d2", "鉄骨"), mat("d3", "ガラス")];
  const museum = plan("museum", 2, { type: "randomProject", amount: 1, label: "ランダムな企画カードを1枚獲得" });
  museum.immediate = true;
  afterMystery.activeSeat = 0;
  afterMystery.players[0].actionUsed = false;
  afterMystery.players[0].hand = [museum];
  const afterMuseum = balku.applyGameAction(afterMystery, 0, { type: "submit", projectId: "museum", materialIds: [], faceUp: true });
  assert.ok(afterMuseum.players[0].hand.some((c) => c.id === "museum-prize"));
});

test("新規企画定義: ミステリーハウス等の条件・点数・効果・コピー数が元プールどおり", () => {
  const defs = balku.NEW_PROJECT_DEFINITIONS;
  assert.equal(defs.length, 17);
  assert.equal(defs[0].card.name, "ミステリーハウス");
  assert.equal(defs[0].card.points, 5);
  assert.deepEqual(defs[0].card.requirements, { 超伝導体: 2, 銅線: 3, コンクリート: 2, 鉄骨: 2 });
  assert.equal(defs[0].card.effect.type, "mysteryHouse");
  assert.equal(defs[0].copies, 1);
  const spaceport = defs.find((d) => d.card.name === "宇宙港");
  assert.equal(spaceport.card.points, 14);
  assert.equal(spaceport.card.effect.type, "pointBoost");
});

test("山札が尽きると総ポイントを精算し、同点は共同勝利", () => {
  const state = twoPlayers();
  state.deck = [];
  state.auction = null;
  state.players[0].submitted.push({ id: "a", faceUp: true, legal: true, effectActivated: true, project: plan("a", 5), materials: [] });
  state.players[1].submitted.push({ id: "b", faceUp: true, legal: true, effectActivated: true, project: plan("b", 5), materials: [] });
  const next = balku.applyGameAction(state, 0, { type: "endTurn" });
  assert.equal(next.phase, "finished");
  assert.equal(next.winnerSeat, null);
  assert.deepEqual([...next.winnerSeats].sort(), [0, 1]);
});

test("山札消尽の最終精算は提出点＋ボーナスで単独勝利も決まる", () => {
  const state = twoPlayers();
  state.deck = [];
  state.auction = null;
  state.players[0].submitted.push({ id: "a", faceUp: false, legal: false, effectActivated: false, project: plan("a", 6), materials: [] });
  state.players[1].submitted.push({ id: "b", faceUp: false, legal: false, effectActivated: false, project: plan("b", 5), materials: [] });
  state.players[1].scoreBonus = 0;
  const next = balku.applyGameAction(state, 0, { type: "endTurn" });
  assert.equal(next.phase, "finished");
  assert.equal(next.winnerSeat, 0);
  assert.equal(next.finalScores[0].points, 6);
  assert.equal(next.finalScores[0].submittedPoints, 6);
  assert.equal(next.finalScores[0].bonusPoints, 0);
  assert.equal(balku.getTotalPoints({ ...state.players[0], scoreBonus: 3 }), 9);
});

test("再戦準備では参加者の席順を維持してロビーに戻す", () => {
  const state = twoPlayers();
  state.phase = "finished";
  const lobby = balku.resetToLobby(state);
  assert.equal(lobby.phase, "lobby");
  assert.deepEqual(lobby.players.map((p) => p.name), ["施工者A", "施工者B"]);
});

test("ロビー退出は seat を振り直し、対戦中の退出は脱落になる", () => {
  let lobby = balku.createLobbyState("施工者A");
  lobby = balku.addLobbyPlayer(lobby, "施工者B");
  lobby = balku.addLobbyPlayer(lobby, "施工者C");
  const afterLeave = balku.removePlayerFromState(lobby, 0);
  assert.deepEqual(afterLeave.players.map((p) => p.name), ["施工者B", "施工者C"]);
  assert.deepEqual(afterLeave.players.map((p) => p.seat), [0, 1]);

  const game = twoPlayers();
  const afterGameLeave = balku.removePlayerFromState(game, 1);
  assert.equal(afterGameLeave.players[1].eliminated, true);
  assert.equal(afterGameLeave.phase, "finished", "残り1社で即座に終了判定");
});

test("snapshotFor: 他人の手札と伏せ企画の中身が見えない", () => {
  const state = twoPlayers();
  const secret = plan("secret-plan", 9, { type: "coins", amount: 5, label: "コイン +5" }, { 木材: 2 });
  state.players[1].submitted.push({
    id: "hidden",
    faceUp: false,
    legal: true,
    effectActivated: false,
    project: secret,
    materials: [mat("hm1", "木材"), mat("hm2", "木材")],
  });
  state.players[1].submitted.push({
    id: "open",
    faceUp: true,
    legal: true,
    effectActivated: true,
    project: plan("open-plan", 4),
    materials: [mat("om1", "鉄骨")],
  });
  const snap = balku.snapshotFor(state, 0);
  assert.equal(snap.deck, undefined, "山札そのものは含まれない");
  assert.equal(snap.deckCount, state.deck.length);
  const other = snap.players[1];
  assert.deepEqual(other.hand, []);
  assert.equal(other.handCount, state.players[1].hand.length);
  const hidden = other.submitted.find((s) => s.id === "hidden");
  assert.equal(hidden.project.name, "非開示企画");
  assert.equal(hidden.project.points, 0);
  assert.equal(hidden.legal, false);
  assert.equal(hidden.effectActivated, false);
  assert.deepEqual(hidden.materials, []);
  assert.equal(hidden.materialCount, 2);
  const open = other.submitted.find((s) => s.id === "open");
  assert.equal(open.project.name, "検証企画");
  assert.equal(open.legal, true);
  assert.equal(open.materialCount, 1);
  // 自分のスナップショットでは手札も伏せ企画も見える
  const mine = balku.snapshotFor(state, 1);
  assert.equal(mine.players[1].hand.length, state.players[1].hand.length);
  assert.equal(mine.players[1].submitted.find((s) => s.id === "hidden").project.name, "検証企画");
  assert.equal(mine.players[1].submitted.find((s) => s.id === "hidden").legal, true);
});
