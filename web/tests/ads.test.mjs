// lib/ads-core.ts の純粋ロジック（検証・上限・状態遷移・スクリーニング解釈）を確かめる
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const src = fs.readFileSync(path.join(import.meta.dirname, "..", "lib", "ads-core.ts"), "utf8");
const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const m = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));

const NOW = Date.parse("2026-11-10T00:00:00.000Z");
const FUTURE = new Date(NOW + 10 * m.MS_PER_DAY).toISOString();
const PAST = new Date(NOW - m.MS_PER_DAY).toISOString();

function app(overrides = {}) {
  return {
    id: "1_111_aaaa",
    guild_id: "111",
    guild_name: "対象鯖",
    applicant_user_id: "999",
    text: "みんなでゲームする鯖です",
    url: "https://discord.gg/example",
    status: "pending",
    screening: null,
    created_at: new Date(NOW).toISOString(),
    reviewed_at: null,
    reviewed_by: null,
    reject_reason: null,
    reject_note: null,
    revoke_reason: null,
    expires_at: null,
    ...overrides,
  };
}

// ---------------------------------------------------------- 紹介文の検証

test("validateAdText は60字まで通し、改行とURLを弾く", () => {
  assert.equal(m.validateAdText("あ".repeat(60)).ok, true);
  assert.equal(m.validateAdText("あ".repeat(61)).ok, false);
  assert.equal(m.validateAdText("2行\nある").ok, false);
  assert.equal(m.validateAdText("見てね https://example.com").ok, false);
  assert.equal(m.validateAdText("  前後の空白は詰める  ").value, "前後の空白は詰める");
  assert.equal(m.validateAdText("").ok, false);
  assert.equal(m.validateAdText(42).ok, false);
});

// ---------------------------------------------------------- 招待リンク

test("normalizeInviteUrl は discord.gg / discord.com/invite だけを通し正規化する", () => {
  assert.equal(m.normalizeInviteUrl("discord.gg/abc123").value, "https://discord.gg/abc123");
  assert.equal(m.normalizeInviteUrl("https://discord.gg/abc123").value, "https://discord.gg/abc123");
  assert.equal(m.normalizeInviteUrl("https://discord.com/invite/abc-123").value, "https://discord.gg/abc-123");
  assert.equal(m.normalizeInviteUrl("https://example.com/abc").ok, false);
  assert.equal(m.normalizeInviteUrl("https://discord.gg/").ok, false);
  assert.equal(m.normalizeInviteUrl("https://discord.gg/abc/def").ok, false);
  assert.equal(m.normalizeInviteUrl("短縮 http://bit.ly/xyz").ok, false);
});

// ---------------------------------------------------------- 却下入力

test("validateRejectInput は other の自由文必須を守る", () => {
  assert.equal(m.validateRejectInput("spam", "").ok, true);
  assert.equal(m.validateRejectInput("other", "").ok, false);
  assert.deepEqual(m.validateRejectInput("other", "理由あり"), { ok: true, reason: "other", note: "理由あり" });
  assert.equal(m.validateRejectInput("unknown", "x").ok, false);
});

// ---------------------------------------------------------- レコード正規化

test("normalizeApplication は壊れたレコードを落とし、必須項目を寄せる", () => {
  const normalized = m.normalizeApplication("k1", app({ status: "approved", expires_at: FUTURE }));
  assert.equal(normalized.status, "approved");
  assert.equal(normalized.id, "1_111_aaaa");
  assert.equal(m.normalizeApplication("k2", { status: "approved" }), null);
  assert.equal(m.normalizeApplication("k3", "text"), null);
  assert.equal(m.normalizeApplication("k4", app({ status: "weird" })), null);
});

// ---------------------------------------------------------- 実効ステータスと上限

test("effectiveStatus は掲載期限を無視し、退出を revoked として扱う", () => {
  const approved = app({ status: "approved", expires_at: FUTURE });
  assert.equal(m.effectiveStatus(approved, NOW, new Set(["111"])), "approved");
  // 掲載期限は撤廃されたため、expires_at が過去でも・無くても approved のまま（永続表示）
  assert.equal(m.effectiveStatus(app({ status: "approved", expires_at: PAST }), NOW, new Set(["111"])), "approved");
  assert.equal(m.effectiveStatus(app({ status: "approved", expires_at: null }), NOW, new Set(["111"])), "approved");
  assert.equal(m.effectiveStatus(approved, NOW, new Set(["222"])), "revoked");
  assert.equal(m.effectiveStatus(approved, NOW, null), "approved");
  assert.equal(m.effectiveStatus(app({ status: "pending" }), NOW, new Set()), "pending");
});

test("canCreateForGuild は pending があるギルドで新規申請を止める", () => {
  assert.equal(m.canCreateForGuild([app()], "111"), false);
  assert.equal(m.canCreateForGuild([app({ status: "approved", expires_at: FUTURE })], "111"), true);
  assert.equal(m.canCreateForGuild([app()], "222"), true);
  assert.equal(m.canCreateForGuild([], "111"), true);
});

test("canApprove は全体上限20件（承認済み・導入済みのみ数える）で止まる", () => {
  const approved = Array.from({ length: 20 }, (_, i) =>
    app({ id: `a${i}`, guild_id: String(1000 + i), status: "approved", expires_at: FUTURE }));
  const registry = new Set(approved.map((a) => a.guild_id));
  assert.equal(m.countActiveApproved(approved, NOW, registry), 20);
  assert.equal(m.canApprove(approved, NOW, registry), false);
  assert.equal(m.canApprove(approved.slice(0, 19), NOW, registry), true);
  // 退出済みは上限に数えない。expires_at は数え方に影響しない（期限切れでも数える）
  const mixed = [...approved.slice(0, 19), app({ id: "x", guild_id: "2000", status: "approved", expires_at: PAST })];
  assert.equal(m.canApprove(mixed, NOW, registry), true);
  assert.equal(m.canApprove(mixed, NOW, new Set([...registry, "2000"])), false);
});

test("isOwnerUser は OWNER_DISCORD_ID 一致のときだけ true（未設定なら常に false）", () => {
  assert.equal(m.isOwnerUser("111", "111"), true);
  assert.equal(m.isOwnerUser("222", "111"), false);
  assert.equal(m.isOwnerUser("111", null), false);
  assert.equal(m.isOwnerUser("111", ""), false);
  assert.equal(m.isOwnerUser(null, "111"), false);
  assert.equal(m.isOwnerUser(undefined, undefined), false);
});

// ---------------------------------------------------------- スクリーニング

test("buildScreeningRequest は4観点の choice 質問と state を作る", () => {
  const { state, questions } = m.buildScreeningRequest({
    guildName: "対象鯖", memberCount: 42, text: "紹介文", url: "https://discord.gg/example",
  });
  assert.deepEqual(JSON.parse(state), {
    server_name: "対象鯖", member_count: 42,
    description_text: "紹介文", invite_url: "https://discord.gg/example",
  });
  assert.deepEqual(Object.keys(questions).sort(), ["mismatch", "nsfw", "shop", "spam"]);
  for (const q of Object.values(questions)) {
    assert.equal(q.type, "choice");
    assert.ok(q.criteria.suspect && q.criteria.clear);
  }
});

test("parseScreeningResponse は answers の包み方の違いを吸収し、suspect で flagged にする", () => {
  const at = new Date(NOW).toISOString();
  const flat = m.parseScreeningResponse(
    { answers: { spam: "suspect", shop: "clear", nsfw: "clear", mismatch: "clear" } }, at);
  assert.equal(flat.flagged, true);
  assert.equal(flat.verdicts.spam, "suspect");

  const wrapped = m.parseScreeningResponse(
    { success: true, result: { answers: { spam: { choice: "clear" }, shop: { choice: "clear" }, nsfw: { choice: "clear" }, mismatch: { choice: "suspect" } } } }, at);
  assert.equal(wrapped.flagged, true);
  assert.equal(wrapped.verdicts.mismatch, "suspect");

  const clean = m.parseScreeningResponse(
    { answers: { spam: "clear", shop: "clear", nsfw: "clear", mismatch: "clear" } }, at);
  assert.equal(clean.flagged, false);

  assert.equal(m.parseScreeningResponse({ success: false }, at), null);
  assert.equal(m.parseScreeningResponse({ answers: { spam: "maybe" } }, at), null);
  assert.equal(m.parseScreeningResponse("text", at), null);
});

test("unavailableScreening は未実施として全観点 unknown になる", () => {
  const s = m.unavailableScreening(new Date(NOW).toISOString());
  assert.equal(s.status, "unavailable");
  assert.equal(s.flagged, false);
  assert.deepEqual(Object.values(s.verdicts), ["unknown", "unknown", "unknown", "unknown"]);
});
