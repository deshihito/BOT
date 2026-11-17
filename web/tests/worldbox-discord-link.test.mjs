// WORLD BOX バッチN2: Discord 連携の円滑化（ID 手入力の廃止 + 双方向化）。
// 連携設定の mode 形式と旧形式からの移行読込、Bot 公開ディレクトリの
// parse、宛先解決、掲示メッセージの source 保持、ルート/パネル配線を検証する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { parseChatMessage, parseUnionChatSettings } from "../lib/worldbox/chat.ts";
import {
  parseDiscordDirectory, resolveLinkedChannelId,
} from "../lib/worldbox/discord-directory.ts";

const CID = "222222222222222222";
const GLOBAL_CID = "444444444444444444";

test("parseUnionChatSettings: mode 形式と旧形式の移行読込", () => {
  assert.deepEqual(parseUnionChatSettings({ mode: "global", updatedAt: 5 }),
    { mode: "global", channelId: null, updatedAt: 5 });
  assert.deepEqual(parseUnionChatSettings({ mode: "channel", channelId: CID }),
    { mode: "channel", channelId: CID, updatedAt: 0 });
  assert.deepEqual(parseUnionChatSettings({ mode: "none" }),
    { mode: "none", channelId: null, updatedAt: 0 });
  // 旧形式（チャンネル ID 手入力）は channel として移行読込する
  assert.deepEqual(parseUnionChatSettings({ chatChannelId: CID }),
    { mode: "channel", channelId: CID, updatedAt: 0 });
  assert.deepEqual(parseUnionChatSettings({ chatChannelId: "" }),
    { mode: "none", channelId: null, updatedAt: 0 });
  // 壊れた値は連携なしに倒す
  assert.equal(parseUnionChatSettings({ mode: "channel", channelId: "abc" }).mode, "none");
  assert.equal(parseUnionChatSettings({ mode: "weird" }).mode, "none");
  assert.equal(parseUnionChatSettings(null).mode, "none");
  assert.equal(parseUnionChatSettings("x").mode, "none");
});

test("parseDiscordDirectory: 一覧とグローバル連携チャンネル", () => {
  const dir = parseDiscordDirectory({
    channels: [
      { id: CID, name: "general" },
      { id: GLOBAL_CID, name: "global-chat" },
      { id: "bad", name: "x" },
      { id: CID, name: "dup" },
    ],
    globalChatChannelId: GLOBAL_CID,
    updatedAt: 42,
  });
  assert.equal(dir.channels.length, 2);
  assert.equal(dir.globalChatChannelId, GLOBAL_CID);
  assert.equal(dir.updatedAt, 42);
  assert.equal(parseDiscordDirectory(null), null);
  assert.equal(parseDiscordDirectory({}), null);
  assert.equal(parseDiscordDirectory({ channels: "x" }), null);
  const noGlobal = parseDiscordDirectory({ channels: [], globalChatChannelId: "bad" });
  assert.equal(noGlobal.globalChatChannelId, null);
});

test("resolveLinkedChannelId: mode ごとの宛先解決", () => {
  const dir = parseDiscordDirectory({
    channels: [{ id: GLOBAL_CID, name: "global-chat" }],
    globalChatChannelId: GLOBAL_CID,
  });
  assert.equal(resolveLinkedChannelId({ mode: "channel", channelId: CID, updatedAt: 0 }, null), CID);
  assert.equal(resolveLinkedChannelId({ mode: "global", channelId: null, updatedAt: 0 }, dir), GLOBAL_CID);
  assert.equal(resolveLinkedChannelId({ mode: "global", channelId: null, updatedAt: 0 }, null), null);
  assert.equal(resolveLinkedChannelId({ mode: "none", channelId: null, updatedAt: 0 }, dir), null);
});

test("parseChatMessage: Discord 由来の source を保持する", () => {
  const base = { id: "discord:1", channel: "union", name: "でし", text: "やあ", at: 100, guildId: "1" };
  assert.equal(parseChatMessage({ ...base, source: "discord" }).source, "discord");
  assert.equal(parseChatMessage(base).source, undefined);
  assert.equal(parseChatMessage({ ...base, source: "other" }).source, undefined);
});

test("配線: union-settings はディレクトリ必須・ID 手入力を受けない", async () => {
  const route = await readFile(new URL("../app/api/worldbox/union-settings/route.ts", import.meta.url), "utf8");
  assert.ok(route.includes("loadDiscordDirectory"));
  assert.ok(route.includes("directory_unavailable"));
  assert.ok(route.includes("channel_not_listed"));
  assert.ok(route.includes("global_not_available"));
  assert.ok(!route.includes("invalid_channel_id"));
  const chatRoute = await readFile(new URL("../app/api/worldbox/chat/route.ts", import.meta.url), "utf8");
  assert.ok(chatRoute.includes("resolveLinkedChannelId"));
  const panel = await readFile(new URL("../app/games/worldbox/WorldBoxGuildBoardPanel.tsx", import.meta.url), "utf8");
  // ID 入力欄は撤去され、名前で選ぶピッカーになっている
  assert.ok(!panel.includes('placeholder="チャンネルID"'));
  assert.ok(panel.includes("グローバルチャット"));
  assert.ok(panel.includes("専用チャンネル"));
  assert.ok(panel.includes("Discord側の準備待ち"));
  assert.ok(panel.includes('m.source === "discord"'));
});
