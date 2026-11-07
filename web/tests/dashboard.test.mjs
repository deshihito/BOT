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
  const nonAssist = new Set(["vc_auto_start", "globalchat", "command_control", "bot_control"]);
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
