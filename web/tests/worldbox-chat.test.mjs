// AGO WORLD BOX 近距離チャットの検証:
// - 距離で届く/届かないが決まる（範囲内は距離つき、範囲外は含まれない）
// - 保持期間・保持件数の切り詰め、連続投稿の間隔、本文の整形
// - API は位置をクライアント申告でなくプレゼンス（サーバー側）から取る配線
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

const chat = loadBundle(
  ["worldbox/chat.ts"],
  [
    "CHAT_RANGE_TILES", "CHAT_TTL_MS", "CHAT_MIN_INTERVAL_MS",
    "sanitizeChatText", "parseChatLog", "pruneChatLog", "chatDistanceTiles",
    "selectAudibleMessages", "canPostChat",
  ],
);

const NOW = 1_700_000_000_000;
const msg = (id, x, y, at = NOW, from = "p1") => ({
  id, from, name: "誰か", space: "world", x, y, text: "こんにちは", at,
});

test("距離: 範囲内は距離つきで届き、範囲外は届かない", () => {
  const log = [
    msg("near", 3, 4, NOW),          // 距離5
    msg("edge", chat.CHAT_RANGE_TILES, 0, NOW), // ちょうど範囲
    msg("far", chat.CHAT_RANGE_TILES + 1, 0, NOW), // 範囲外
  ];
  const heard = chat.selectAudibleMessages(log, { x: 0, y: 0 }, NOW);
  assert.deepEqual(heard.map((m) => m.id), ["near", "edge"]);
  assert.equal(heard[0].distanceTiles, 5);
  assert.equal(heard[1].distanceTiles, chat.CHAT_RANGE_TILES);
  assert.equal(Math.round(chat.chatDistanceTiles(0, 0, 3, 4)), 5);
});

test("保持期間を過ぎた発言は聞こえない・残らない", () => {
  const log = [msg("old", 1, 1, NOW - chat.CHAT_TTL_MS - 1), msg("new", 1, 1, NOW)];
  assert.deepEqual(chat.pruneChatLog(log, NOW).map((m) => m.id), ["new"]);
  assert.deepEqual(chat.selectAudibleMessages(log, { x: 0, y: 0 }, NOW).map((m) => m.id), ["new"]);
});

test("連続投稿は最小間隔を空ける", () => {
  const log = [msg("a", 0, 0, NOW, "p1")];
  assert.equal(chat.canPostChat(log, "p1", NOW + chat.CHAT_MIN_INTERVAL_MS - 1), false);
  assert.equal(chat.canPostChat(log, "p1", NOW + chat.CHAT_MIN_INTERVAL_MS), true);
  assert.equal(chat.canPostChat(log, "p2", NOW), true);
});

test("本文の整形とログの解釈（壊れた要素は捨てる）", () => {
  assert.equal(chat.sanitizeChatText("  あい　うえお  "), "あい うえお");
  assert.equal(chat.sanitizeChatText("   "), null);
  assert.equal(chat.sanitizeChatText("x".repeat(201)), null);
  assert.equal(chat.sanitizeChatText(42), null);
  const log = chat.parseChatLog([msg("ok", 0, 0), { id: "bad" }, null, "junk"]);
  assert.deepEqual(log.map((m) => m.id), ["ok"]);
  assert.deepEqual(chat.parseChatLog("nope"), []);
});

test("API とクライアントの配線（位置はプレゼンス由来・距離表示・≡メニュー）", () => {
  const route = fs.readFileSync(path.join(rootDir, "app/api/worldbox/chat/route.ts"), "utf8");
  const client = fs.readFileSync(path.join(rootDir, "app/games/worldbox/WorldBoxClient.tsx"), "utf8");
  // 位置はクライアント申告でなくサーバー側プレゼンスから取る
  assert.match(route, /loadMyPresence\(ownerKey\)/);
  assert.match(route, /x: me\.x,\s*y: me\.y/);
  assert.match(route, /selectAudibleMessages/);
  assert.match(route, /distanceTiles/);
  // クライアント: ≡ メニューから開き、距離（タイル先）を表示する
  assert.match(client, /id: "chat"/);
  assert.match(client, /`?\$?\{?m\.distanceTiles\}?タイル先/);
  assert.match(client, /setChatOpen\(false\)/);
});
