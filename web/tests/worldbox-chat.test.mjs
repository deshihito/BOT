// WORLD BOX バッチ6: チャットとプレゼンス間引きの純粋ロジックテスト。
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

const T = await loadBundle(
  ["worldbox/chat.ts", "worldbox/presence.ts"],
  [
    "sanitizeChatText", "parseChatMessage", "pruneChatMessages", "visibleChatMessages",
    "CHAT_PROXIMITY_RANGE", "CHAT_PROXIMITY_TTL_MS", "CHAT_GLOBAL_TTL_MS",
    "thinPresenceNear", "PRESENCE_NEAR_RADIUS", "PRESENCE_MAX_PLAYERS",
  ],
);

const msg = (over = {}) => ({
  id: "m1", channel: "proximity", name: "a", text: "hi", at: 10_000,
  x: 0, y: 0, space: "world", ...over,
});

test("chat: sanitize rejects empty/long/control text", () => {
  assert.equal(T.sanitizeChatText("  こんにちは  "), "こんにちは");
  assert.equal(T.sanitizeChatText(""), null);
  assert.equal(T.sanitizeChatText("x".repeat(121)), null);
  assert.equal(T.sanitizeChatText(42), null);
  assert.equal(T.sanitizeChatText("a\nb"), "a b");
});

test("chat: parse roundtrip and junk rejection", () => {
  const m = T.parseChatMessage(msg({ guildId: "g1", channel: "union" }));
  assert.equal(m?.guildId, "g1");
  assert.equal(T.parseChatMessage(msg({ channel: "nope" })), null);
  assert.equal(T.parseChatMessage(msg({ text: "" })), null);
  assert.equal(T.parseChatMessage(null), null);
});

test("chat: prune drops expired per-channel TTL and caps count", () => {
  const now = 10_000 + T.CHAT_PROXIMITY_TTL_MS + 1;
  const pruned = T.pruneChatMessages([msg()], "proximity", now);
  assert.equal(pruned.length, 0);
  const fresh = T.pruneChatMessages([msg({ at: now - 1000 })], "proximity", now);
  assert.equal(fresh.length, 1);
  const many = Array.from({ length: 60 }, (_, i) => msg({ id: `m${i}`, at: 5000 + i, channel: "global" }));
  assert.equal(T.pruneChatMessages(many, "global", 5000 + T.CHAT_GLOBAL_TTL_MS - 1).length, 50);
});

test("chat: proximity visibility is range+space limited", () => {
  const viewer = { x: 0, y: 0, space: "world", guildId: null };
  const near = msg({ id: "n", x: T.CHAT_PROXIMITY_RANGE, y: 0, at: 9000 });
  const far = msg({ id: "f", x: T.CHAT_PROXIMITY_RANGE + 1, y: 0, at: 9000 });
  const otherSpace = msg({ id: "s", x: 0, y: 0, space: "lobby", at: 9000 });
  const seen = T.visibleChatMessages([near, far, otherSpace], viewer, "proximity", 10_000);
  assert.deepEqual(seen.map((m) => m.id), ["n"]);
});

test("chat: global stays within space, union within guild", () => {
  const g = msg({ id: "g", channel: "global", space: "lobby", at: 9000 });
  const seenG = T.visibleChatMessages([g], { x: 0, y: 0, space: "world", guildId: null }, "global", 10_000);
  assert.equal(seenG.length, 0);
  const u = msg({ id: "u", channel: "union", guildId: "g1", at: 9000 });
  assert.equal(T.visibleChatMessages([u], { x: 0, y: 0, space: "world", guildId: "g2" }, "union", 10_000).length, 0);
  assert.equal(T.visibleChatMessages([u], { x: 0, y: 0, space: "world", guildId: "g1" }, "union", 10_000).length, 1);
  assert.equal(T.visibleChatMessages([u], { x: 0, y: 0, space: "world", guildId: null }, "union", 10_000).length, 0);
});

const entry = (id, x, y, ts = 1000) => ({
  id, name: id, x, y, vx: 0, vy: 0, face: 1, space: "world", ts,
});

test("presence: thinning keeps only near players, nearest first", () => {
  const self = entry("me", 0, 0);
  const near = entry("near", 10, 0, 900);
  const edge = entry("edge", T.PRESENCE_NEAR_RADIUS, 0, 800);
  const far = entry("far", T.PRESENCE_NEAR_RADIUS + 1, 0, 9999);
  const out = T.thinPresenceNear([far, edge, near], self);
  assert.deepEqual(out.map((e) => e.id), ["near", "edge"]);
});

test("presence: thinning without self falls back to capped list", () => {
  const many = Array.from({ length: 40 }, (_, i) => entry(`p${i}`, i * 100, 0));
  const out = T.thinPresenceNear(many, null);
  assert.equal(out.length, T.PRESENCE_MAX_PLAYERS);
});

test("presence: thinning respects the player cap", () => {
  const self = entry("me", 0, 0);
  const many = Array.from({ length: 40 }, (_, i) => entry(`p${i}`, i + 1, 0));
  const out = T.thinPresenceNear(many, self);
  assert.equal(out.length, T.PRESENCE_MAX_PLAYERS);
  assert.equal(out[0].id, "p0");
});
