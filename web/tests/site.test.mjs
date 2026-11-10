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
    bump: [{ name: "c", value: 5300.9, user_id: 999 }],
    up: [{ name: "d", value: 9870 }],
    guild_id: 123,
  });
  assert.deepEqual(snapshot, {
    updated_at: "2026-11-07T00:00:00+00:00",
    exp: [{ name: "a", value: 100, level: 3 }],
    coin: [{ name: "b", value: 50 }],
    bump: [{ name: "c", value: 5300 }],
    up: [{ name: "d", value: 9870 }],
    rta: {
      fast: [
        { name: "c", value: 5300, service: "bump" },
        { name: "d", value: 9870, service: "up" },
      ],
      slow: [],
    },
  });
  // RTA キーが無い旧スナップショットは空配列として読む
  const legacy = m.parseRankingSnapshot({
    updated_at: "2026-11-07T00:00:00+00:00",
    exp: [],
    coin: [],
  });
  assert.deepEqual(legacy.bump, []);
  assert.deepEqual(legacy.up, []);
  assert.equal(m.parseRankingSnapshot(null), null);
  assert.equal(m.parseRankingSnapshot({ exp: [] }), null);
});

test("parseBotStatusSnapshot は余分な項目を落とし、数値を整える", () => {
  const snapshot = m.parseBotStatusSnapshot({
    updated_at: "2026-11-08T03:00:00+00:00",
    started_at: "2026-11-05T00:30:00+00:00",
    guild_count: 25,
    member_count: 40291.9,
    latency_ms: 41.6,
    guild_id: 123,
    note: "extra",
  });
  assert.deepEqual(snapshot, {
    updated_at: "2026-11-08T03:00:00+00:00",
    started_at: "2026-11-05T00:30:00+00:00",
    guild_count: 25,
    member_count: 40291,
    latency_ms: 41,
  });
});

test("parseBotStatusSnapshot は欠けた任意項目を null にし、不正な本体は null を返す", () => {
  const snapshot = m.parseBotStatusSnapshot({ updated_at: "2026-11-08T03:00:00+00:00" });
  assert.deepEqual(snapshot, {
    updated_at: "2026-11-08T03:00:00+00:00",
    started_at: null,
    guild_count: 0,
    member_count: 0,
    latency_ms: null,
  });
  assert.equal(m.parseBotStatusSnapshot(null), null);
  assert.equal(m.parseBotStatusSnapshot("x"), null);
  assert.equal(m.parseBotStatusSnapshot({}), null);
  assert.equal(m.parseBotStatusSnapshot({ updated_at: "not-a-date" }), null);
  assert.equal(m.parseBotStatusSnapshot({ updated_at: 123 }), null);
});

test("isBotStatusFresh は15分以内だけを新鮮とする", () => {
  const snapshot = { updated_at: "2026-11-08T03:00:00+00:00" };
  assert.equal(m.isBotStatusFresh(snapshot, new Date("2026-11-08T03:14:59+00:00")), true);
  assert.equal(m.isBotStatusFresh(snapshot, new Date("2026-11-08T03:15:01+00:00")), false);
});

test("parseRankingSnapshot は rta 単一ボード（最速/最遅、日時・サービスつき）を読み取る", () => {
  const snapshot = m.parseRankingSnapshot({
    updated_at: "2026-11-09T00:00:00+00:00",
    exp: [],
    coin: [],
    rta: {
      fast: [
        { name: "a", value: 4000, at: "2026-11-07T05:00:00+00:00", service: "up" },
        { name: "a", value: 5300, at: "2026-11-08T05:00:00+00:00", service: "bump" },
      ],
      slow: [{ name: "b", value: 90000, at: null, service: "bump" }],
    },
  });
  // 同じユーザーでもサービスが違えば別エントリとして残る
  assert.equal(snapshot.rta.fast.length, 2);
  assert.equal(snapshot.rta.fast[0].service, "up");
  assert.equal(snapshot.rta.fast[1].at, "2026-11-08T05:00:00+00:00");
  assert.equal(snapshot.rta.slow[0].at, undefined);
  assert.equal(m.RTA_SERVICE_LABELS.sharkbot, "SharkBot");
  assert.equal(m.RTA_SERVICE_LABELS.dsio, "DiscordServers.io");
  assert.equal(m.RTA_SERVICE_LABELS.discom, "DISCOM");
});

test("parseRankingSnapshot は移行期の旧形式（サービス別 Record）を総合ボードで読み替える", () => {
  const snapshot = m.parseRankingSnapshot({
    updated_at: "2026-11-09T00:00:00+00:00",
    exp: [],
    coin: [],
    rta: {
      bump: {
        fast: [{ name: "a", value: 5300, at: "2026-11-08T05:00:00+00:00", service: "bump" }],
        slow: [],
      },
      all: {
        fast: [{ name: "a", value: 4000, at: "2026-11-07T05:00:00+00:00", service: "up" }],
        slow: [],
      },
    },
  });
  assert.equal(snapshot.rta.fast[0].value, 4000);
  assert.equal(snapshot.rta.fast[0].service, "up");
  assert.deepEqual(snapshot.rta.slow, []);
});

test("parseRankingSnapshot は旧形式（rta キーなし）を bump/up の最速ボードへ寄せる", () => {
  const snapshot = m.parseRankingSnapshot({
    updated_at: "2026-11-09T00:00:00+00:00",
    exp: [],
    coin: [],
    bump: [{ name: "a", value: 5300 }],
    up: [{ name: "b", value: 6100 }],
  });
  assert.deepEqual(snapshot.rta.fast, [
    { name: "a", value: 5300, service: "bump" },
    { name: "b", value: 6100, service: "up" },
  ]);
  assert.deepEqual(snapshot.rta.slow, []);
});
