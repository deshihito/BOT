// オンライン対戦共通基盤（lib/online/server.ts）の検証。
// balku-room.test.mjs と同じ loadBundle 方式で TS を読み込む。
// bot-api は未設定スタブ（メモリのみモード）に差し替え、registry は
// テスト内定義の最小ダミーモジュール群に差し替える（実ゲームの
// ルールには依存しない基盤だけのテスト）。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const webDir = path.join(import.meta.dirname, "..");

function transpile(relPath) {
  const src = fs.readFileSync(path.join(webDir, relPath), "utf8");
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
    if (/^export\s*\{[^}]*\}\s*from\s/.test(line)) continue; // 再エクスポートはスタブ側で代替済み
    out.push(
      line
        .replace(/^export\s+(?=(const|let|var|function|class)\s)/, "")
        .replace(/^export\s+(?=async\s+function)/, "")
        .replace(/^export\s*\{[^}]*\};?\s*$/, ""),
    );
  }
  return out.join("\n");
}

async function loadBundle(relPaths, exportNames, prefix = "") {
  const code =
    prefix +
    relPaths.map((p) => stripModuleSyntax(transpile(p))).join("\n") +
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

// 基盤テスト用の最小ダミーモジュール群。
// dummy: 手番制の得点ゲーム（先に target 点で勝利）。armTick で tick を予約できる。
// nochat: チャット不可・CPU不可。noleft: onPlayerLeft なし。
const DUMMY_MODULES = `
function __cloneState(state) {
  return {
    ...state,
    players: state.players.map((p) => ({ ...p })),
    scores: [...state.scores],
    leftSeats: [...(state.leftSeats || [])],
  };
}
const __dummyModule = {
  id: "dummy",
  title: "ダミー",
  minPlayers: 2,
  maxPlayers: 3,
  cpuSupported: true,
  chatEnabled: true,
  createState(players, rng, options) {
    return {
      phase: "playing",
      players: players.map((p) => ({ seat: p.seat, name: p.name })),
      turn: 0,
      scores: players.map(() => 0),
      target: options && typeof options.target === "number" ? options.target : 2,
      ticks: 0,
      tickArmed: false,
      winner: null,
      leftSeats: [],
    };
  },
  applyAction(state, seat, action, rng) {
    if (state.phase !== "playing") throw new Error("対戦は終了しています");
    const next = __cloneState(state);
    if (action.type === "score") {
      if (seat !== state.turn) throw new Error("あなたの手番ではありません");
      next.scores[seat] += 1;
      if (next.scores[seat] >= next.target) {
        next.phase = "finished";
        next.winner = seat;
      } else {
        next.turn = (seat + 1) % state.players.length;
      }
      return next;
    }
    if (action.type === "finish") {
      next.phase = "finished";
      next.winner = seat;
      return next;
    }
    if (action.type === "armTick") {
      next.tickArmed = true;
      return next;
    }
    throw new Error("不正な手です");
  },
  viewFor(state, seat) {
    return { ...__cloneState(state), viewerSeat: seat };
  },
  parseAction(raw) {
    if (!raw || typeof raw !== "object") return null;
    if (raw.type === "score" || raw.type === "finish" || raw.type === "armTick") return { type: raw.type };
    return null;
  },
  parseOptions(raw) {
    if (raw && raw.bad) throw new Error("オプションが不正です");
    const out = {};
    if (raw && typeof raw.target === "number") out.target = raw.target;
    return out;
  },
  phaseOf(state) { return state.phase; },
  isFinished(state) { return state.phase === "finished"; },
  onPlayerLeft(state, seat) {
    const next = __cloneState(state);
    next.leftSeats = [...next.leftSeats, seat];
    next.phase = "finished";
    const other = state.players.find((p) => p.seat !== seat);
    next.winner = other ? other.seat : null;
    return next;
  },
  cpuAction(state, seat, rng) {
    if (state.phase !== "playing") return null;
    if (state.turn !== seat) return null;
    return { type: "score" };
  },
  tick(state, now) {
    if (!state.tickArmed) return state;
    const next = __cloneState(state);
    next.tickArmed = false;
    next.ticks = (state.ticks || 0) + 1;
    return next;
  },
};
const __nochatModule = Object.assign({}, __dummyModule, { id: "nochat", chatEnabled: false, cpuSupported: false });
const __noleftModule = Object.assign({}, __dummyModule, { id: "noleft" });
delete __noleftModule.onPlayerLeft;
const __onlineModules = { dummy: __dummyModule, nochat: __nochatModule, noleft: __noleftModule };
function getOnlineGame(id) { return __onlineModules[id]; }
`;

const server = await loadBundle(
  ["lib/online/server.ts"],
  [
    "createOnlineRoom",
    "joinOnlineRoom",
    "listPublicOnlineRooms",
    "getOnlineRoom",
    "touchOnlineRoom",
    "subscribeOnlineRoom",
    "startOnlineGame",
    "restartOnlineGame",
    "leaveOnlineRoom",
    "applyOnlineMove",
    "postOnlineChat",
    "setOnlineCpu",
    "forceOnlineCpuStep",
    "onlineSubscriberCount",
    "OnlineRoomError",
    "parseCreateRoomBody",
    "parseMoveBody",
    "parseCpuBody",
    "parseChatBody",
  ],
  `import { randomBytes } from "node:crypto";\n${BOT_API_STUB}\n${DUMMY_MODULES}\n`,
);

async function expectStatus(promise, status, messagePart) {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof server.OnlineRoomError, `OnlineRoomError ではない: ${error}`);
    assert.equal(error.status, status, `status が違う: ${error.message}`);
    if (messagePart) assert.ok(error.message.includes(messagePart), `メッセージ "${error.message}" に "${messagePart}" が含まれない`);
    return error;
  }
  assert.fail(`status ${status} で拒否されるはずだった`);
}

async function createTwoPlayerRoom(gameId = "dummy", extra = {}) {
  const host = await server.createOnlineRoom(gameId, { displayName: "ホスト", maxPlayers: 3, isPublic: false, ...extra });
  const guest = await server.joinOnlineRoom(gameId, { code: host.code, displayName: "ゲスト" });
  return { code: host.code, hostToken: host.playerToken, guestToken: guest.playerToken };
}

async function startTwoPlayerRoom(gameId = "dummy", extra = {}) {
  const room = await createTwoPlayerRoom(gameId, extra);
  const view = await server.getOnlineRoom(gameId, room.code, room.hostToken);
  await server.startOnlineGame(gameId, room.code, room.hostToken, view.revision);
  return room;
}

/* --- 基本フロー: 作成→参加→開始→着手 --- */

test("基盤: 作成→参加→開始→着手が通り、ビューはロビーで state=null になる", async () => {
  const { code, hostToken, guestToken } = await createTwoPlayerRoom("dummy", { options: { target: 2 } });
  assert.equal(code.length, 6);
  const lobby = await server.getOnlineRoom("dummy", code, hostToken);
  assert.equal(lobby.status, "lobby");
  assert.equal(lobby.state, null);
  assert.equal(lobby.gameId, "dummy");
  assert.equal(lobby.minPlayers, 2);
  assert.equal(lobby.maxPlayers, 3);
  assert.equal(lobby.cpuSupported, true);
  assert.equal(lobby.chatEnabled, true);
  assert.deepEqual(
    lobby.players.map((p) => [p.seat, p.name, p.isHost]),
    [
      [0, "ホスト", true],
      [1, "ゲスト", false],
    ],
  );
  // ホスト以外は開始できない
  await expectStatus(server.startOnlineGame("dummy", code, guestToken, lobby.revision), 403);
  // revision 不一致は 409
  await expectStatus(server.startOnlineGame("dummy", code, hostToken, 999), 409);
  const started = await server.startOnlineGame("dummy", code, hostToken, lobby.revision);
  assert.equal(started.success, true);
  const view = await server.getOnlineRoom("dummy", code, hostToken);
  assert.equal(view.status, "playing");
  assert.equal(view.state.viewerSeat, 0);
  assert.deepEqual(view.state.scores, [0, 0]);
  // 形式不正な手は 400
  await expectStatus(server.applyOnlineMove("dummy", code, hostToken, view.revision, { type: "bogus" }), 400);
  // 手番でないプレイヤーの手は module の Error が 400 で返る
  await expectStatus(server.applyOnlineMove("dummy", code, guestToken, view.revision, { type: "score" }), 400, "あなたの手番ではありません");
  // 正しい着手
  const moved = await server.applyOnlineMove("dummy", code, hostToken, view.revision, { type: "score" });
  assert.equal(moved.success, true);
  assert.ok(moved.revision > view.revision);
  const after = await server.getOnlineRoom("dummy", code, guestToken);
  assert.deepEqual(after.state.scores, [1, 0]);
  assert.equal(after.state.turn, 1);
  assert.equal(after.state.viewerSeat, 1);
  // 古い revision での着手は 409
  await expectStatus(server.applyOnlineMove("dummy", code, hostToken, view.revision, { type: "score" }), 409);
});

test("基盤: 未知のゲームは 404、人数範囲外と不正オプションは 400", async () => {
  await expectStatus(server.createOnlineRoom("unknown-game", { displayName: "ホスト", maxPlayers: 2, isPublic: false }), 404, "ゲームが見つかりません");
  await expectStatus(server.createOnlineRoom("dummy", { displayName: "ホスト", maxPlayers: 1, isPublic: false }), 400);
  await expectStatus(server.createOnlineRoom("dummy", { displayName: "ホスト", maxPlayers: 4, isPublic: false }), 400);
  await expectStatus(
    server.createOnlineRoom("dummy", { displayName: "ホスト", maxPlayers: 2, isPublic: false, options: { bad: true } }),
    400,
    "オプションが不正です",
  );
  // 人数が minPlayers 未満では開始できない
  const solo = await server.createOnlineRoom("dummy", { displayName: "ホスト", maxPlayers: 2, isPublic: false });
  const view = await server.getOnlineRoom("dummy", solo.code, solo.playerToken);
  await expectStatus(server.startOnlineGame("dummy", solo.code, solo.playerToken, view.revision), 400);
  // 別ゲームのコードではルームが見つからない
  await expectStatus(server.getOnlineRoom("nochat", solo.code, solo.playerToken), 404);
});

test("基盤: 満席の参加は 400（満席）、開始済みの参加は 400（すでに開始）で区別される", async () => {
  const host = await server.createOnlineRoom("dummy", { displayName: "ホスト", maxPlayers: 2, isPublic: false });
  await server.joinOnlineRoom("dummy", { code: host.code, displayName: "ゲスト" });
  await expectStatus(server.joinOnlineRoom("dummy", { code: host.code, displayName: "三人目" }), 400, "満席");

  const started = await startTwoPlayerRoom("dummy");
  await expectStatus(server.joinOnlineRoom("dummy", { code: started.code, displayName: "三人目" }), 400, "すでに開始");
  await expectStatus(server.joinOnlineRoom("dummy", { code: "ZZZZZZ", displayName: "誰か" }), 404);
});

/* --- 退出とホスト移譲 --- */

test("基盤: ロビー退出で seat が振り直され、ホストが最若席の人間へ移る", async () => {
  const host = await server.createOnlineRoom("dummy", { displayName: "ホスト", maxPlayers: 3, isPublic: false });
  const g1 = await server.joinOnlineRoom("dummy", { code: host.code, displayName: "ゲスト1" });
  const g2 = await server.joinOnlineRoom("dummy", { code: host.code, displayName: "ゲスト2" });
  const view = await server.getOnlineRoom("dummy", host.code, host.playerToken);
  await server.leaveOnlineRoom("dummy", host.code, host.playerToken, view.revision);
  const after = await server.getOnlineRoom("dummy", host.code, g1.playerToken);
  assert.equal(after.player.seat, 0);
  assert.equal(after.player.isHost, true);
  assert.deepEqual(
    after.players.map((p) => [p.seat, p.name, p.isHost]),
    [
      [0, "ゲスト1", true],
      [1, "ゲスト2", false],
    ],
  );
  // 退出したホストはもう見られない
  await expectStatus(server.getOnlineRoom("dummy", host.code, host.playerToken), 403);
  // 全員抜けるとルームは消える
  const v2 = await server.getOnlineRoom("dummy", host.code, g1.playerToken);
  await server.leaveOnlineRoom("dummy", host.code, g1.playerToken, v2.revision);
  const v3 = await server.getOnlineRoom("dummy", host.code, g2.playerToken);
  await server.leaveOnlineRoom("dummy", host.code, g2.playerToken, v3.revision);
  await expectStatus(server.getOnlineRoom("dummy", host.code, g2.playerToken), 404);
});

test("基盤: 対戦中の退出は onPlayerLeft が適用され seat は振り直されない。無いモジュールは 400", async () => {
  const host = await server.createOnlineRoom("dummy", { displayName: "ホスト", maxPlayers: 3, isPublic: false });
  const g1 = await server.joinOnlineRoom("dummy", { code: host.code, displayName: "ゲスト1" });
  const g2 = await server.joinOnlineRoom("dummy", { code: host.code, displayName: "ゲスト2" });
  let view = await server.getOnlineRoom("dummy", host.code, host.playerToken);
  await server.startOnlineGame("dummy", host.code, host.playerToken, view.revision);
  view = await server.getOnlineRoom("dummy", host.code, host.playerToken);
  await server.leaveOnlineRoom("dummy", host.code, host.playerToken, view.revision);
  const after = await server.getOnlineRoom("dummy", host.code, g1.playerToken);
  assert.equal(after.status, "finished");
  assert.deepEqual(after.state.leftSeats, [0]);
  assert.equal(after.state.winner, 1);
  // seat は振り直されない（残りは 1, 2 のまま）。ホストは人間最若席へ。
  assert.deepEqual(
    after.players.map((p) => [p.seat, p.name, p.isHost]),
    [
      [1, "ゲスト1", true],
      [2, "ゲスト2", false],
    ],
  );

  const noLeft = await startTwoPlayerRoom("noleft");
  const nlView = await server.getOnlineRoom("noleft", noLeft.code, noLeft.guestToken);
  await expectStatus(server.leaveOnlineRoom("noleft", noLeft.code, noLeft.guestToken, nlView.revision), 400);
});

/* --- 再戦 --- */

test("基盤: 終了後はホストだけがロビーへ戻せ、ロビーから再戦できる", async () => {
  const { code, hostToken, guestToken } = await startTwoPlayerRoom("dummy");
  let view = await server.getOnlineRoom("dummy", code, hostToken);
  // 終了前は restart できない
  await expectStatus(server.restartOnlineGame("dummy", code, hostToken, view.revision), 400);
  const finished = await server.applyOnlineMove("dummy", code, hostToken, view.revision, { type: "finish" });
  assert.equal(finished.success, true);
  view = await server.getOnlineRoom("dummy", code, hostToken);
  assert.equal(view.status, "finished");
  // 終了後の着手は 400
  await expectStatus(server.applyOnlineMove("dummy", code, hostToken, view.revision, { type: "score" }), 400);
  // 非ホストは戻せない
  await expectStatus(server.restartOnlineGame("dummy", code, guestToken, view.revision), 403);
  const restarted = await server.restartOnlineGame("dummy", code, hostToken, view.revision);
  assert.equal(restarted.success, true);
  view = await server.getOnlineRoom("dummy", code, hostToken);
  assert.equal(view.status, "lobby");
  assert.equal(view.state, null);
  assert.equal(view.players.length, 2);
  // ロビーから再び開始できる
  const again = await server.startOnlineGame("dummy", code, hostToken, view.revision);
  assert.equal(again.success, true);
  view = await server.getOnlineRoom("dummy", code, hostToken);
  assert.equal(view.status, "playing");
});

/* --- チャット --- */

test("基盤: チャットは有効なゲームでのみ使え、他メンバーにも見える", async () => {
  const { code, hostToken, guestToken } = await createTwoPlayerRoom("dummy");
  const posted = await server.postOnlineChat("dummy", code, hostToken, "  よろしく！  ");
  assert.equal(posted.message.text, "よろしく！");
  assert.equal(posted.message.playerId, 0);
  const guestView = await server.getOnlineRoom("dummy", code, guestToken);
  assert.equal(guestView.chat.length, 1);
  await expectStatus(server.postOnlineChat("dummy", code, hostToken, "   "), 400);
  await expectStatus(server.postOnlineChat("dummy", code, hostToken, "あ".repeat(201)), 400);
  await expectStatus(server.postOnlineChat("dummy", code, "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz", "部外者"), 403);

  const noChat = await createTwoPlayerRoom("nochat");
  await expectStatus(server.postOnlineChat("nochat", noChat.code, noChat.hostToken, "hello"), 400, "チャット");
});

/* --- CPU --- */

test("基盤: CPU はホストだけがロビーで着席でき、未対応ゲームと開始後は 400", async () => {
  const host = await server.createOnlineRoom("dummy", { displayName: "ホスト", maxPlayers: 3, isPublic: false });
  const guest = await server.joinOnlineRoom("dummy", { code: host.code, displayName: "ゲスト" });
  await expectStatus(server.setOnlineCpu("dummy", host.code, guest.playerToken, "add"), 403);
  await server.setOnlineCpu("dummy", host.code, host.playerToken, "add");
  let view = await server.getOnlineRoom("dummy", host.code, host.playerToken);
  assert.deepEqual(view.cpuSeats, [2]);
  assert.equal(view.players[2].isCpu, true);
  // 人間の席は外せない
  await expectStatus(server.setOnlineCpu("dummy", host.code, host.playerToken, "remove", 1), 400);
  await server.setOnlineCpu("dummy", host.code, host.playerToken, "remove", 2);
  view = await server.getOnlineRoom("dummy", host.code, host.playerToken);
  assert.deepEqual(view.cpuSeats, []);
  assert.equal(view.players.length, 2);

  const noCpu = await createTwoPlayerRoom("nochat");
  await expectStatus(server.setOnlineCpu("nochat", noCpu.code, noCpu.hostToken, "add"), 400);
});

test("基盤: CPU と開始でき、force ステップで CPU の手が1手進む", async () => {
  const host = await server.createOnlineRoom("dummy", { displayName: "ホスト", maxPlayers: 2, isPublic: false });
  await server.setOnlineCpu("dummy", host.code, host.playerToken, "add");
  let view = await server.getOnlineRoom("dummy", host.code, host.playerToken);
  assert.deepEqual(view.cpuSeats, [1]);
  await server.startOnlineGame("dummy", host.code, host.playerToken, view.revision);
  // 開始後の CPU 追加はできない
  await expectStatus(server.setOnlineCpu("dummy", host.code, host.playerToken, "add"), 400);
  view = await server.getOnlineRoom("dummy", host.code, host.playerToken);
  assert.equal(view.state.turn, 0);
  await server.applyOnlineMove("dummy", host.code, host.playerToken, view.revision, { type: "score" });
  view = await server.getOnlineRoom("dummy", host.code, host.playerToken);
  assert.deepEqual(view.state.scores, [1, 0]);
  assert.equal(view.state.turn, 1, "人間の手で CPU の手番になる");
  const revisionBefore = view.revision;
  await server.forceOnlineCpuStep("dummy", host.code, host.playerToken);
  view = await server.getOnlineRoom("dummy", host.code, host.playerToken);
  assert.ok(view.revision > revisionBefore, "CPU の手で revision が進んだ");
  assert.deepEqual(view.state.scores, [1, 1]);
  assert.equal(view.state.turn, 0, "CPU の手番が滞留していない");
});

/* --- tick --- */

test("基盤: tick は取得時の進行処理で1回だけ適用され、変化が無ければ revision は上がらない", async () => {
  const { code, hostToken } = await startTwoPlayerRoom("dummy");
  let view = await server.getOnlineRoom("dummy", code, hostToken);
  assert.equal(view.state.ticks, 0);
  const armed = await server.applyOnlineMove("dummy", code, hostToken, view.revision, { type: "armTick" });
  assert.equal(armed.success, true);
  view = await server.getOnlineRoom("dummy", code, hostToken);
  assert.equal(view.state.ticks, 1);
  assert.equal(view.state.tickArmed, false);
  assert.equal(view.revision, armed.revision + 1, "tick の変化で revision が1つ上がる");
  const again = await server.getOnlineRoom("dummy", code, hostToken);
  assert.equal(again.state.ticks, 1);
  assert.equal(again.revision, view.revision, "変化が無い tick では revision は上がらない");
});

/* --- 公開一覧・購読 --- */

test("基盤: 公開一覧は公開＆ロビーのみ、購読へは変更が publish される", async () => {
  const pub = await server.createOnlineRoom("dummy", { displayName: "公開ホスト", maxPlayers: 2, isPublic: true });
  await server.createOnlineRoom("dummy", { displayName: "非公開ホスト", maxPlayers: 2, isPublic: false });
  const list = await server.listPublicOnlineRooms("dummy");
  assert.ok(list.some((r) => r.code === pub.code));
  assert.ok(list.every((r) => r.gameId === "dummy"));

  const received = [];
  const sub = await server.subscribeOnlineRoom("dummy", pub.code, pub.playerToken, (v) => received.push(v));
  assert.equal(sub.view.code, pub.code);
  assert.equal(server.onlineSubscriberCount(pub.code), 1);
  await server.postOnlineChat("dummy", pub.code, pub.playerToken, "publish確認");
  assert.ok(received.length >= 1);
  assert.equal(received.at(-1).chat.at(-1)?.text, "publish確認");
  sub.unsubscribe();
  assert.equal(server.onlineSubscriberCount(pub.code), 0);

  // 開始した公開ルームは一覧から消える
  const guest = await server.joinOnlineRoom("dummy", { code: pub.code, displayName: "ゲスト" });
  void guest;
  const v = await server.getOnlineRoom("dummy", pub.code, pub.playerToken);
  await server.startOnlineGame("dummy", pub.code, pub.playerToken, v.revision);
  const list2 = await server.listPublicOnlineRooms("dummy");
  assert.ok(!list2.some((r) => r.code === pub.code));
});

/* --- 入力パーサ --- */

test("基盤: パーサは create の任意項目と move の raw action を契約通りに扱う", () => {
  assert.deepEqual(server.parseCreateRoomBody({ displayName: " たろう " }), { displayName: "たろう", isPublic: true });
  assert.deepEqual(
    server.parseCreateRoomBody({ displayName: "たろう", maxPlayers: 2, isPublic: false, options: { target: 3 } }),
    { displayName: "たろう", maxPlayers: 2, isPublic: false, options: { target: 3 } },
  );
  // options は object のときだけ通る
  assert.deepEqual(server.parseCreateRoomBody({ displayName: "たろう", options: "bad" }), { displayName: "たろう", isPublic: true });
  assert.throws(
    () => server.parseCreateRoomBody({ displayName: "x" }),
    (e) => e instanceof server.OnlineRoomError && e.status === 400,
  );
  const token = "a".repeat(32);
  const rawAction = { type: "score", extra: { nested: 1 } };
  const move = server.parseMoveBody({ playerToken: token, expectedRevision: 3, action: rawAction });
  assert.equal(move.playerToken, token);
  assert.equal(move.expectedRevision, 3);
  assert.deepEqual(move.action, rawAction, "action は検証せず raw のまま渡る");
  assert.deepEqual(server.parseCpuBody({ playerToken: token, action: "remove", seat: 2 }), { playerToken: token, action: "remove", seat: 2 });
  assert.deepEqual(server.parseChatBody({ playerToken: token, text: "hi" }), { playerToken: token, text: "hi" });
});
