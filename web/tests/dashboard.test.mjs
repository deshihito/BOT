// lib/dashboard-core.ts の純粋ロジック（権限判定・ID検証・JSON境界・マージ）を確かめる
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const src = fs.readFileSync(path.join(import.meta.dirname, "..", "lib", "dashboard-core.ts"), "utf8");
const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const m = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));

const ADMIN = (1n << 3n).toString();
const MANAGE = (1n << 5n).toString();
const NONE = "0";
const VIEW = (1n << 10n).toString();

test("hasManageGuild は管理者とサーバー管理だけを通す", () => {
  assert.equal(m.hasManageGuild(ADMIN), true);
  assert.equal(m.hasManageGuild(MANAGE), true);
  assert.equal(m.hasManageGuild((1n << 3n | 1n << 10n).toString()), true);
  assert.equal(m.hasManageGuild(VIEW), false);
  assert.equal(m.hasManageGuild(NONE), false);
  assert.equal(m.hasManageGuild("abc"), false);
  assert.equal(m.hasManageGuild(""), false);
});

test("manageableGuilds はオーナーと管理権限だけ残す", () => {
  const guilds = [
    { id: "1", name: "a", icon: null, owner: true, permissions: NONE },
    { id: "2", name: "b", icon: null, owner: false, permissions: MANAGE },
    { id: "3", name: "c", icon: null, owner: false, permissions: VIEW },
  ];
  assert.deepEqual(m.manageableGuilds(guilds).map((g) => g.id), ["1", "2"]);
});

test("isSnowflake は17〜20桁の数字だけ", () => {
  assert.equal(m.isSnowflake("12345678901234567"), true);
  assert.equal(m.isSnowflake("123456789012345678901"), false);
  assert.equal(m.isSnowflake("1234567890123456"), false);
  assert.equal(m.isSnowflake("12345678901234567a"), false);
});

test("大きな整数は番兵文字列で往復し、精度が落ちない", () => {
  const text = `{"value":{"channel_id":${"1513038883787505764"},"count":42,"name":"x"}}`;
  const parsed = m.parseJsonPreservingInts(text);
  assert.equal(parsed.value.channel_id, "#int:1513038883787505764");
  assert.equal(parsed.value.count, 42);
  assert.equal(m.stringifyWithInts(parsed), text);
  assert.equal(m.unwrapId(parsed.value.channel_id), "1513038883787505764");
});

test("parseJsonPreservingInts は文字列中の数字に触れない", () => {
  const parsed = m.parseJsonPreservingInts('{"msg":"idは1513038883787505764です","n":7}');
  assert.equal(parsed.msg, "idは1513038883787505764です");
  assert.equal(parsed.n, 7);
});

const welcomeSpec = {
  section: "assist_welcome",
  label: "参加・退出メッセージ",
  description: "",
  fields: [
    { name: "enabled", label: "有効", type: "bool" },
    { name: "channel_id", label: "チャンネル", type: "channel" },
    { name: "message", label: "文面", type: "text", maxLength: 10 },
  ],
};

test("sanitizeSectionInput はIDを番兵化し、空欄を削除(null)にする", () => {
  const result = m.sanitizeSectionInput(welcomeSpec, { enabled: true, channel_id: "123456789012345678", message: "" });
  assert.equal(result.ok, true);
  assert.equal(result.values.channel_id, "#int:123456789012345678");
  assert.equal(result.values.message, null);
  assert.equal(result.values.enabled, true);
});

test("sanitizeSectionInput は不正なID・長すぎる文面・未知の項目を弾く", () => {
  assert.equal(m.sanitizeSectionInput(welcomeSpec, { channel_id: "abc" }).ok, false);
  assert.equal(m.sanitizeSectionInput(welcomeSpec, { message: "12345678901" }).ok, false);
  assert.equal(m.sanitizeSectionInput(welcomeSpec, { unknown: 1 }).ok, false);
  assert.equal(m.sanitizeSectionInput(welcomeSpec, { enabled: "yes" }).ok, false);
});

test("mergeGuildSettings はBotのupdateと同じ意味（nullで削除、空で除去）", () => {
  const current = { assist_welcome: { enabled: true, channel_id: "#int:1" }, other: { x: 1 } };
  const merged = m.mergeGuildSettings(current, "assist_welcome", { channel_id: null, message: "hi" });
  assert.deepEqual(merged, { assist_welcome: { enabled: true, message: "hi" }, other: { x: 1 } });
  const emptied = m.mergeGuildSettings({ assist_welcome: { enabled: true } }, "assist_welcome", { enabled: null });
  assert.equal(emptied, null);
});

test("SETTING_SECTIONS のセクション名は重複しない", () => {
  const names = m.SETTING_SECTIONS.map((spec) => spec.section);
  assert.equal(new Set(names).size, names.length);
  const nonAssist = new Set(["vc_auto_start", "globalchat", "command_control", "bot_control", "ticket", "bump_rta"]);
  for (const name of names) assert.ok(name.startsWith("assist_") || nonAssist.has(name), name);
});

const commandControlSpec = {
  section: "command_control",
  label: "cc",
  description: "",
  fields: [
    { name: "mode", label: "モード", type: "enum", options: [{ value: "off" }, { value: "deny" }, { value: "allow" }] },
    { name: "actions", label: "アクション", type: "text_list", maxItems: 300, itemPattern: "^[a-z0-9_]+:[a-z0-9_]+(:[a-z0-9_]+)?$", excludeValues: ["support:bot_fixer"] },
    { name: "rates", label: "レート", type: "rate_map" },
  ],
};

test("command_control: bot_fixer 自体は黙って除かれ、レートが対応表になる", () => {
  const result = m.sanitizeSectionInput(commandControlSpec, {
    mode: "deny",
    actions: ["general:money_panel", "support:bot_fixer"],
    rates: "general:money_panel 10 3600\nsupport:bot_fixer 5 600",
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.values.actions, ["general:money_panel"]);
  assert.deepEqual(result.values.rates, { "general:money_panel": { count: 10, window_seconds: 3600 } });
});

test("command_control: 不正なアクションIDと範囲外レートを弾く", () => {
  assert.equal(m.sanitizeSectionInput(commandControlSpec, { actions: ["BAD ID"] }).ok, false);
  assert.equal(m.sanitizeSectionInput(commandControlSpec, { rates: "general:x 0 3600" }).ok, false);
  assert.equal(m.sanitizeSectionInput(commandControlSpec, { rates: "general:x 10 30" }).ok, false);
  assert.equal(m.sanitizeSectionInput(commandControlSpec, { rates: "" }).ok, true);
});

const botControlSpec = {
  section: "bot_control",
  label: "bc",
  description: "",
  mapSection: true,
  fields: [{ name: "rules", label: "ルール", type: "bot_rule_map" }],
};

test("bot_control: 行形式を対応表へ変換し、applySectionValues がセクションを置き換える", () => {
  const result = m.sanitizeSectionInput(botControlSpec, {
    rules: "123456789012345678 234567890123456789,345678901234567890 20 3600",
  });
  assert.equal(result.ok, true);
  const applied = m.applySectionValues({ other: { x: 1 } }, botControlSpec, result.values);
  assert.deepEqual(applied.other, { x: 1 });
  assert.deepEqual(applied.bot_control["123456789012345678"].allowed_channel_ids, ["#int:234567890123456789", "#int:345678901234567890"]);
  assert.deepEqual(applied.bot_control["123456789012345678"].rate, { count: 20, window_seconds: 3600 });
  const cleared = m.applySectionValues(applied, botControlSpec, { rules: null });
  assert.equal("bot_control" in cleared, false);
});

test("bot_control: 許可チャンネルなし・AGO自身・重複を弾く", () => {
  assert.equal(m.sanitizeSectionInput(botControlSpec, { rules: "123456789012345678 " }).ok, false);
  assert.equal(m.sanitizeSectionInput(botControlSpec, { rules: "1476636487784337428 234567890123456789" }).ok, false);
  assert.equal(m.sanitizeSectionInput(botControlSpec, { rules: "123456789012345678 234567890123456789\n123456789012345678 234567890123456789" }).ok, false);
});

test("id_list はIDを番兵化し不正なIDを弾く", () => {
  const spec = { section: "globalchat", label: "g", description: "", fields: [{ name: "blocked_users", label: "ブロック", type: "id_list", maxItems: 100 }] };
  const ok = m.sanitizeSectionInput(spec, { blocked_users: ["123456789012345678"] });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.values.blocked_users, ["#int:123456789012345678"]);
  assert.equal(m.sanitizeSectionInput(spec, { blocked_users: ["abc"] }).ok, false);
});

test("userAvatarUrl / guildIconUrl は CDN 形式で、アニメーションは gif、無ければデフォルト/ null", () => {
  assert.equal(
    m.userAvatarUrl("123456789012345678", "abc123"),
    "https://cdn.discordapp.com/avatars/123456789012345678/abc123.png?size=64",
  );
  assert.equal(
    m.userAvatarUrl("123456789012345678", "a_xyz"),
    "https://cdn.discordapp.com/avatars/123456789012345678/a_xyz.gif?size=64",
  );
  const fallback = m.userAvatarUrl("80351110224678912", null);
  assert.match(fallback, /^https:\/\/cdn\.discordapp\.com\/embed\/avatars\/[0-5]\.png$/);
  assert.equal(m.guildIconUrl("123", null), null);
  assert.equal(
    m.guildIconUrl("123", "deadbeef"),
    "https://cdn.discordapp.com/icons/123/deadbeef.png?size=64",
  );
});

test("automod には横断連投とコピペ荒らしの離散選択肢がある", () => {
  const spec = m.sectionSpec("assist_automod");
  const cross = spec.fields.find((f) => f.name === "cross_count");
  const raid = spec.fields.find((f) => f.name === "raid_users");
  assert.deepEqual(cross.options.map((o) => o.value), [0, 3, 5]);
  assert.deepEqual(raid.options.map((o) => o.value), [0, 3, 5, 10]);
  const ok = m.sanitizeSectionInput(spec, { cross_count: 3, raid_users: 10 });
  assert.equal(ok.ok, true);
  assert.equal(m.sanitizeSectionInput(spec, { cross_count: 4 }).ok, false);
});

test("parseEmojiRoleMap はモーダルと同じ形式を受け、不正なロールIDを弾く", () => {
  const ok = m.parseEmojiRoleMap("⭐=123456789012345678\n👍:234567890123456789");
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.value, { "⭐": "#int:123456789012345678", "👍": "#int:234567890123456789" });
  assert.equal(m.parseEmojiRoleMap("⭐=abc").ok, false);
  assert.deepEqual(m.parseEmojiRoleMap("").value, null);
});

test("reactionroles の連動リセット: チャンネル変更でメッセージと対応表が消え、明示した新メッセージは残る", () => {
  const stored = {
    channel_id: "#int:111111111111111111",
    message_id: "#int:222222222222222222",
    mappings: { "⭐": "#int:333333333333333333" },
  };
  const changedChannel = m.applyReactionRolesCoupling(
    { channel_id: "#int:444444444444444444", message_id: "#int:222222222222222222", mappings: { "⭐": "#int:333333333333333333" } },
    stored,
  );
  assert.equal(changedChannel.message_id, null);
  assert.equal(changedChannel.mappings, null);
  const changedMessage = m.applyReactionRolesCoupling(
    { channel_id: "#int:111111111111111111", message_id: "#int:555555555555555555", mappings: { "⭐": "#int:333333333333333333" } },
    stored,
  );
  assert.equal(changedMessage.mappings, null);
  const rewritten = m.applyReactionRolesCoupling(
    { channel_id: "#int:111111111111111111", message_id: "#int:555555555555555555", mappings: { "👍": "#int:666666666666666666" } },
    stored,
  );
  assert.deepEqual(rewritten.mappings, { "👍": "#int:666666666666666666" });
});

test("parseLevelRoleMap はレベル範囲と件数を検証する", () => {
  const ok = m.parseLevelRoleMap("10=123456789012345678\n2:234567890123456789");
  assert.equal(ok.ok, true);
  assert.deepEqual(Object.keys(ok.value), ["2", "10"]);
  assert.equal(m.parseLevelRoleMap("1=123456789012345678").ok, false);
  assert.equal(m.parseLevelRoleMap("1001=123456789012345678").ok, false);
});

test("parseScheduleList は時刻をゼロ埋めし、reconcileSchedules は id と last_sent を引き継ぐ", () => {
  const parsed = m.parseScheduleList("9:05 おはよう\n21:00 定例");
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.value[0], { time: "09:05", message: "おはよう" });
  assert.equal(m.parseScheduleList("25:00 x").ok, false);
  const existing = [
    { id: "abcd1234", time: "09:05", message: "おはよう", last_sent: "2026-11-07" },
    { id: "eeee2222", time: "20:00", message: "旧告知", last_sent: "2026-11-06" },
  ];
  let n = 0;
  const reconciled = m.reconcileSchedules(parsed.value, existing, () => `new${++n}`);
  assert.deepEqual(reconciled[0], { id: "abcd1234", time: "09:05", message: "おはよう", last_sent: "2026-11-07" });
  assert.equal(reconciled[1].id, "new1");
  assert.equal("last_sent" in reconciled[1], false);
});

test("ticket と bump_rta セクションが定義され、bump_rta は external である", () => {
  const ticket = m.sectionSpec("ticket");
  assert.ok(ticket.fields.some((f) => f.name === "delete_after"));
  const bump = m.sectionSpec("bump_rta");
  assert.equal(bump.external, "bump_rta");
  const ok = m.sanitizeSectionInput(bump, { notifications_enabled: false, role_id: "123456789012345678" });
  assert.equal(ok.ok, true);
  assert.equal(ok.values.role_id, "#int:123456789012345678");
});

test("SECTION_CATEGORIES は全セクションをちょうど1回ずつ分類する", () => {
  const all = m.SECTION_CATEGORIES.flatMap((category) => category.sections);
  assert.equal(all.length, m.SETTING_SECTIONS.length);
  assert.equal(new Set(all).size, all.length);
  for (const spec of m.SETTING_SECTIONS) assert.ok(all.includes(spec.section), spec.section);
});

test("moduleEnabled は主トグルと設定済み判定を使い分ける", () => {
  const automod = m.sectionSpec("assist_automod");
  assert.equal(m.moduleEnabled(automod, { enabled: true }), true);
  assert.equal(m.moduleEnabled(automod, { enabled: false }), false);
  const bump = m.sectionSpec("bump_rta");
  assert.equal(m.moduleEnabled(bump, {}), true);
  assert.equal(m.moduleEnabled(bump, { notifications_enabled: false }), false);
  const vc = m.sectionSpec("vc_auto_start");
  assert.equal(m.moduleEnabled(vc, { music: true }), true);
  assert.equal(m.moduleEnabled(vc, {}), false);
  const cc = m.sectionSpec("command_control");
  assert.equal(m.moduleEnabled(cc, { mode: "off" }), false);
  assert.equal(m.moduleEnabled(cc, { mode: "deny" }), true);
  const gc = m.sectionSpec("globalchat");
  assert.equal(m.moduleEnabled(gc, { ng_words: ["#str:悪口"] }), true);
  assert.equal(m.moduleEnabled(gc, {}), false);
  const welcome = m.sectionSpec("assist_welcome");
  assert.equal(m.moduleEnabled(welcome, { goodbye_enabled: true }), true);
  assert.equal(m.moduleEnabled(welcome, {}), false);
});

test("primaryToggleField は enabled 系だけを拾う", () => {
  assert.equal(m.primaryToggleField(m.sectionSpec("assist_automod")).name, "enabled");
  assert.equal(m.primaryToggleField(m.sectionSpec("bump_rta")).name, "notifications_enabled");
  assert.equal(m.primaryToggleField(m.sectionSpec("vc_auto_start")), null);
  assert.equal(m.primaryToggleField(m.sectionSpec("assist_embed")).name, "enabled");
  assert.equal(m.primaryToggleField(m.sectionSpec("globalchat")), null);
});
