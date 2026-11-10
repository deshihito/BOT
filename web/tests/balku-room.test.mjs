// BALKU のルーム内チャット / CPU 戦（lib/balku-server.ts /
// lib/balku-cpu.ts）の検証。balku.test.mjs と同じ loadBundle 方式で
// TS を読み込む。balku-server の bot-api は未設定スタブに差し替え、
// メモリのみモードで動かす（isBotApiConfigured() === false）。
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

/** 複数行 import も含めて import 文を取り除き、export を剥がす。 */
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

async function loadBundle(files, exportNames, prefix = "") {
  const code =
    prefix +
    files.map((name) => stripModuleSyntax(transpile(name))).join("\n") +
    `\nexport { ${exportNames.join(", ")} };\n`;
  return import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
}

const BOT_API_STUB = `
function isBotApiConfigured() { return false; }
async function kvGet() { return null; }
async function kvList() { return new Map(); }
async function kvSet() {}
async function kvDelete() {}
`;

const cpu = await loadBundle(
  ["balku-game.ts", "balku-cpu.ts"],
  [
    "createLobbyState",
    "addLobbyPlayer",
    "startGame",
    "applyGameAction",
    "expireTimedOutTurn",
    "decideCpuTurnAction",
    "decideCpuBid",
    "decideCpuStep",
    "applyCpuStepToState",
    "cpuActionPending",
    "nextCpuName",
  ],
);

const server = await loadBundle(
  ["balku-game.ts", "balku-cpu.ts", "balku-server.ts"],
  [
    "createBalkuRoom",
    "joinBalkuRoom",
    "getBalkuRoom",
    "startBalkuGame",
    "applyBalkuMove",
    "postBalkuChat",
    "setBalkuCpu",
    "forceBalkuCpuStep",
    "BalkuRoomError",
  ],
  `import { randomBytes } from "node:crypto";\n${BOT_API_STUB}\n`,
);

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

function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function expectStatus(promise, status) {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof server.BalkuRoomError, `BalkuRoomError ではない: ${error}`);
    assert.equal(error.status, status);
    return;
  }
  assert.fail(`status ${status} で拒否されるはずだった`);
}

const startedTwoCpuSide = () => {
  let s = cpu.createLobbyState("人間");
  s = cpu.addLobbyPlayer(s, "CPU タクト");
  s = cpu.startGame(s);
  s.activeSeat = 1;
  return s;
};

/* --- CPU 方策（純粋関数） --- */

test("CPU名: プールから重複しない名前を割り当てる", () => {
  assert.equal(cpu.nextCpuName([]), "CPU タクト");
  assert.equal(cpu.nextCpuName(["CPU タクト"]), "CPU ハンマー");
  assert.equal(cpu.nextCpuName(["CPU タクト", "CPU ハンマー"]), "CPU スコップ");
});

test("CPU方策: 素材が揃った企画は最高点を公開で提出する", () => {
  const s = startedTwoCpuSide();
  const hut = plan("hut", 6, { type: "coins", amount: 1, label: "" }, { 木材: 3 });
  const small = plan("small", 2, { type: "coins", amount: 1, label: "" }, { 木材: 1 });
  s.players[1].hand = [small, hut, mat("w1", "木材"), mat("w2", "木材"), mat("w3", "木材")];
  const action = cpu.decideCpuTurnAction(s, 1, () => 0.5);
  assert.equal(action.type, "submit");
  assert.equal(action.projectId, "hut");
  assert.equal(action.faceUp, true);
  assert.deepEqual([...action.materialIds].sort(), ["w1", "w2", "w3"]);
});

test("CPU方策: あと少しで揃う企画は市場で不足素材を買う", () => {
  const s = startedTwoCpuSide();
  const hut = plan("hut", 6, { type: "coins", amount: 1, label: "" }, { 木材: 3 });
  s.players[1].hand = [hut, mat("w1", "木材"), mat("w2", "木材")];
  s.players[1].coins = 10;
  const action = cpu.decideCpuTurnAction(s, 1, () => 0.5);
  assert.deepEqual(action, { type: "buyMaterial", material: "木材" });
});

test("CPU方策: 買えない不足1種は低確率で伏せ提出、外れたらパスする", () => {
  const s = startedTwoCpuSide();
  const hut = plan("hut", 6, { type: "coins", amount: 1, label: "" }, { 木材: 3 });
  s.players[1].hand = [hut, mat("w1", "木材"), mat("w2", "木材")];
  s.players[1].coins = 0; // 市場では買えない
  const bluff = cpu.decideCpuTurnAction(s, 1, () => 0);
  assert.equal(bluff.type, "submit");
  assert.equal(bluff.faceUp, false);
  assert.deepEqual([...bluff.materialIds].sort(), ["w1", "w2"]);
  const pass = cpu.decideCpuTurnAction(s, 1, () => 0.99);
  assert.equal(pass.type, "endTurn");
});

test("CPU方策: オークションは必要な素材が市場価格以下のときだけ最少入札する", () => {
  const s = startedTwoCpuSide();
  const hut = plan("hut", 6, { type: "coins", amount: 1, label: "" }, { 木材: 3 });
  s.players[1].hand = [hut];
  s.players[1].coins = 10;
  s.auction = { card: mat("auc1", "木材"), highestBid: 2, highestBidderSeat: 0, deadlineAt: Date.now() + 15000, roundOpened: 1 };
  assert.deepEqual(cpu.decideCpuBid(s, 1), { type: "bid", amount: 3 });
  // 次の入札が市場価格（木材5）を超えるなら入札しない
  s.auction.highestBid = 5;
  assert.equal(cpu.decideCpuBid(s, 1), null);
  // 企画カードの出品には入札しない
  s.auction.highestBid = 0;
  s.auction.card = plan("auc2", 5);
  assert.equal(cpu.decideCpuBid(s, 1), null);
  // 自分が最高入札者なら追わない
  s.auction.card = mat("auc3", "木材");
  s.auction.highestBidderSeat = 1;
  assert.equal(cpu.decideCpuBid(s, 1), null);
});

test("CPU方策: 他社の伏せ提出へのBALKUは抽選が当たったときだけコールする", () => {
  const s = startedTwoCpuSide();
  s.activeSeat = 0; // 人間の手番でもコール機会はある
  s.players[0].submitted.push({ id: "sub1", faceUp: false, legal: false, effectActivated: false, project: plan("t", 5), materials: [] });
  const hit = cpu.decideCpuStep(s, new Set([1]), () => 0);
  assert.equal(hit.seat, 1);
  assert.deepEqual(hit.action, { type: "bulkCall", targetSeat: 0, submissionId: "sub1" });
  const miss = cpu.decideCpuStep(s, new Set([1]), () => 0.99);
  assert.equal(miss, null);
  assert.equal(cpu.cpuActionPending(s, new Set([1])), true);
  assert.equal(cpu.cpuActionPending(s, new Set()), false);
});

test("CPU同士のフルゲームが詰まらず最後まで回って終了する", () => {
  let s = cpu.createLobbyState("CPU タクト");
  s = cpu.addLobbyPlayer(s, "CPU ハンマー");
  s = cpu.addLobbyPlayer(s, "CPU スコップ");
  s = cpu.addLobbyPlayer(s, "CPU ドリル");
  s = cpu.startGame(s);
  const allSeats = new Set([0, 1, 2, 3]);
  const rng = mulberry32(42);
  let guard = 0;
  let auctionCardId = null;
  let auctionSteps = 0;
  while (s.phase !== "finished" && guard < 20000) {
    guard += 1;
    // オークションは入札の機会を数手だけ与えてから期限決済させる
    if (s.auction) {
      if (s.auction.card.id !== auctionCardId) {
        auctionCardId = s.auction.card.id;
        auctionSteps = 0;
      }
      auctionSteps += 1;
      if (auctionSteps > 8) {
        s = cpu.expireTimedOutTurn(s, s.auction.deadlineAt + 1);
        continue;
      }
    } else {
      auctionCardId = null;
    }
    const stepped = cpu.applyCpuStepToState(s, allSeats, rng);
    if (stepped) {
      s = stepped;
      continue;
    }
    if (s.auction) {
      s = cpu.expireTimedOutTurn(s, s.auction.deadlineAt + 1);
      continue;
    }
    if (s.turnDeadlineAt) {
      s = cpu.expireTimedOutTurn(s, s.turnDeadlineAt + 1);
      continue;
    }
    assert.fail("CPU でも期限処理でも進めない状態になった");
  }
  assert.equal(s.phase, "finished");
  assert.ok(s.finalScores.length >= 1);
  assert.ok(s.winnerSeats.length >= 1);
});

/* --- サーバー: チャット --- */

test("チャット: 投稿がスナップショットに乗り、他のメンバーにも見える", async () => {
  const { code, playerToken } = await server.createBalkuRoom({ displayName: "ホスト", maxPlayers: 4, isPublic: false });
  const posted = await server.postBalkuChat(code, playerToken, "  よろしく！  ");
  assert.equal(posted.success, true);
  assert.equal(posted.message.text, "よろしく！");
  assert.equal(posted.message.name, "ホスト");
  assert.equal(posted.message.playerId, 0);
  const hostView = await server.getBalkuRoom(code, playerToken);
  assert.equal(hostView.chat.length, 1);
  assert.equal(hostView.chat[0].text, "よろしく！");
  const guest = await server.joinBalkuRoom({ code, displayName: "ゲスト" });
  const guestView = await server.getBalkuRoom(code, guest.playerToken);
  assert.equal(guestView.chat.length, 1);
  await server.postBalkuChat(code, guest.playerToken, "対戦よろしく");
  const after = await server.getBalkuRoom(code, playerToken);
  assert.equal(after.chat.length, 2);
  assert.equal(after.chat[1].playerId, 1);
});

test("チャット: 非メンバーは投稿も閲覧もできず、空文と200文字超は拒否される", async () => {
  const { code, playerToken } = await server.createBalkuRoom({ displayName: "ホスト", maxPlayers: 2, isPublic: false });
  const outsider = "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz";
  await expectStatus(server.postBalkuChat(code, outsider, "部外者"), 403);
  await expectStatus(server.getBalkuRoom(code, outsider), 403);
  await expectStatus(server.postBalkuChat(code, playerToken, "   "), 400);
  await expectStatus(server.postBalkuChat(code, playerToken, "あ".repeat(201)), 400);
  const ok = await server.postBalkuChat(code, playerToken, "あ".repeat(200));
  assert.equal(ok.message.text.length, 200);
});

test("チャット: 保持は最新ぶんに切り詰められ、ビューは最新50件", async () => {
  const { code, playerToken } = await server.createBalkuRoom({ displayName: "ホスト", maxPlayers: 2, isPublic: false });
  for (let i = 1; i <= 105; i += 1) {
    await server.postBalkuChat(code, playerToken, `m${i}`);
  }
  const view = await server.getBalkuRoom(code, playerToken);
  assert.equal(view.chat.length, 50);
  assert.equal(view.chat[0].text, "m56");
  assert.equal(view.chat[49].text, "m105");
});

/* --- サーバー: CPU --- */

test("CPU: ホストだけが待機中に追加/削除でき、満席では追加できない", async () => {
  const { code, playerToken } = await server.createBalkuRoom({ displayName: "ホスト", maxPlayers: 4, isPublic: false });
  const guest = await server.joinBalkuRoom({ code, displayName: "ゲスト" });
  await expectStatus(server.setBalkuCpu(code, guest.playerToken, "add"), 403);
  await server.setBalkuCpu(code, playerToken, "add");
  await server.setBalkuCpu(code, playerToken, "add");
  let view = await server.getBalkuRoom(code, playerToken);
  assert.deepEqual(view.cpuSeats, [2, 3]);
  assert.deepEqual(
    view.state.players.map((p) => p.name),
    ["ホスト", "ゲスト", "CPU タクト", "CPU ハンマー"],
  );
  await expectStatus(server.setBalkuCpu(code, playerToken, "add"), 400); // 満席
  // 人間の席は外せない / 非ホストは外せない
  await expectStatus(server.setBalkuCpu(code, playerToken, "remove", 1), 400);
  await expectStatus(server.setBalkuCpu(code, guest.playerToken, "remove", 2), 403);
  await server.setBalkuCpu(code, playerToken, "remove", 2);
  view = await server.getBalkuRoom(code, playerToken);
  assert.deepEqual(view.cpuSeats, [2]);
  assert.deepEqual(
    view.state.players.map((p) => p.name),
    ["ホスト", "ゲスト", "CPU ハンマー"],
  );
});

test("CPU: 1人+CPUで開始でき、開始後の追加はできない。チャットは対戦中も使える", async () => {
  const { code, playerToken } = await server.createBalkuRoom({ displayName: "ホスト", maxPlayers: 2, isPublic: false });
  await server.setBalkuCpu(code, playerToken, "add");
  const before = await server.getBalkuRoom(code, playerToken);
  assert.equal(before.state.players.length, 2);
  assert.deepEqual(before.cpuSeats, [1]);
  const started = await server.startBalkuGame(code, playerToken, before.revision);
  assert.equal(started.success, true);
  const view = await server.getBalkuRoom(code, playerToken);
  assert.equal(view.status, "active");
  await expectStatus(server.setBalkuCpu(code, playerToken, "add"), 400);
  const posted = await server.postBalkuChat(code, playerToken, "対戦中チャット");
  assert.equal(posted.success, true);
  const after = await server.getBalkuRoom(code, playerToken);
  assert.equal(after.chat.at(-1)?.text, "対戦中チャット");
});

test("CPU: processCpu を繰り返すと CPU の手番が進んで人間に戻る", async () => {
  const { code, playerToken } = await server.createBalkuRoom({ displayName: "ホスト", maxPlayers: 2, isPublic: false });
  await server.setBalkuCpu(code, playerToken, "add");
  let view = await server.getBalkuRoom(code, playerToken);
  await server.startBalkuGame(code, playerToken, view.revision);
  view = await server.getBalkuRoom(code, playerToken);
  assert.equal(view.state.activeSeat, 0);
  await server.applyBalkuMove(code, playerToken, view.revision, { type: "endTurn" });
  view = await server.getBalkuRoom(code, playerToken);
  assert.equal(view.state.activeSeat, 1, "人間のパスで CPU の手番になる");
  const revisionBefore = view.revision;
  // 予約時刻を待たずに1手ずつ進める（テスト用フック）。CPU の手番が
  // 終わって人間に戻るか、対戦が終了するまで繰り返す。
  for (let i = 0; i < 40 && view.state.activeSeat === 1 && view.status === "active"; i += 1) {
    await server.forceBalkuCpuStep(code, playerToken);
    view = await server.getBalkuRoom(code, playerToken);
  }
  assert.ok(view.revision > revisionBefore, "CPU の手で revision が進んだ");
  assert.ok(view.state.activeSeat === 0 || view.status === "finished", "CPU の手番が滞留していない");
});
