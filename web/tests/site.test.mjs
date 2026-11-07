// lib/site.ts の純粋ロジック（招待URL定数・流入元の正規化・ランキング検証）を確かめる
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const src = fs.readFileSync(path.join(import.meta.dirname, "..", "lib", "site.ts"), "utf8");
const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const m = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));

test("招待URLはポータルの Install Link と完全一致する", () => {
  assert.equal(
    m.BOT_INVITE_URL,
    "https://discord.com/oauth2/authorize?client_id=1476636487784337428&permissions=4544817123422033&integration_type=0&scope=bot%20applications.commands",
  );
  assert.equal(m.SUPPORT_SERVER_URL, "https://discord.gg/dCAQzJUaa9");
});

test("normalizeInviteSource は想定媒体だけを通し、それ以外は direct", () => {
  assert.equal(m.normalizeInviteSource("topgg"), "topgg");
  assert.equal(m.normalizeInviteSource("X"), "x");
  assert.equal(m.normalizeInviteSource(" website "), "website");
  assert.equal(m.normalizeInviteSource("unknown"), "direct");
  assert.equal(m.normalizeInviteSource("a b"), "direct");
  assert.equal(m.normalizeInviteSource("../etc"), "direct");
  assert.equal(m.normalizeInviteSource(""), "direct");
  assert.equal(m.normalizeInviteSource(null), "direct");
  assert.equal(m.normalizeInviteSource(undefined), "direct");
});

test("parseRankingSnapshot は ID を含む余分な項目を落とし、数値だけ残す", () => {
  const snapshot = m.parseRankingSnapshot({
    updated_at: "2026-11-07T00:00:00+00:00",
    exp: [{ name: "a", value: 100, level: 3, user_id: 999 }],
    coin: [{ name: "b", value: 50.7 }],
    guild_id: 123,
  });
  assert.deepEqual(snapshot, {
    updated_at: "2026-11-07T00:00:00+00:00",
    exp: [{ name: "a", value: 100, level: 3 }],
    coin: [{ name: "b", value: 50 }],
  });
  assert.equal(m.parseRankingSnapshot(null), null);
  assert.equal(m.parseRankingSnapshot({ exp: [] }), null);
});
