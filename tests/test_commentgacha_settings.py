"""コメントガチャの /support 設定（サーバー単位の制限）のテスト。

- 設定の正規化（既定・不正値・重複・上限）
- レジストリ登録（support:commentgacha、automation、AI 代理実行なし）
- dispatch が設定パネルへ届くこと
- Cog の判定（無効・発動チャンネル制限・掘り返し元制限・クールダウン）
- パネルの保存が GuildSettings に書かれること
"""
from __future__ import annotations

import os
import sys
import types
import unittest
from unittest.mock import AsyncMock, patch

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

import discord

# cogs.support を先に読み込む（core.support.* を起点に読むと common の
# 循環 import が途中で binjou に届くため、既存 support テストと同じ順序にする）。
import cogs.support  # noqa: F401
from core.general.commentgacha import settings as gacha_settings
from core.general.commentgacha.cog import CommentGachaCog


# ---------------------------------------------------------------- 正規化

class NormalizeTest(unittest.TestCase):
    def test_defaults(self):
        self.assertEqual(gacha_settings.normalize_settings(None), {
            "enabled": True,
            "cooldown_seconds": 1,
            "blocked_source_channel_ids": [],
            "blocked_trigger_channel_ids": [],
        })
        self.assertEqual(gacha_settings.normalize_settings({}), gacha_settings.normalize_settings(None))

    def test_valid_values_kept(self):
        result = gacha_settings.normalize_settings({
            "enabled": False,
            "cooldown_seconds": 60,
            "blocked_source_channel_ids": [10, 20],
            "blocked_trigger_channel_ids": [30],
        })
        self.assertEqual(result, {
            "enabled": False,
            "cooldown_seconds": 60,
            "blocked_source_channel_ids": [10, 20],
            "blocked_trigger_channel_ids": [30],
        })

    def test_invalid_values_fall_back(self):
        result = gacha_settings.normalize_settings({
            "enabled": "yes",
            "cooldown_seconds": 7,  # プリセット外
            "blocked_source_channel_ids": [10, "20", True, 10, None],
            "blocked_trigger_channel_ids": "123",
        })
        self.assertEqual(result, {
            "enabled": True,
            "cooldown_seconds": 1,
            "blocked_source_channel_ids": [10],
            "blocked_trigger_channel_ids": [],
        })

    def test_blocked_cap_25(self):
        result = gacha_settings.normalize_settings({
            "blocked_source_channel_ids": list(range(1, 40)),
        })
        self.assertEqual(len(result["blocked_source_channel_ids"]), 25)

    def test_get_settings_via_store(self):
        store = types.SimpleNamespace(
            get=lambda guild_id, section: {"enabled": False, "cooldown_seconds": 300})
        result = gacha_settings.get_settings(store, 1)
        self.assertFalse(result["enabled"])
        self.assertEqual(result["cooldown_seconds"], 300)


# ---------------------------------------------------------------- 登録

class RegistrationTest(unittest.TestCase):
    def test_registered_in_support_automation(self):
        from cogs.support import SUPPORT_ACTIONS, SUPPORT_ACTIONS_BY_GENRE, SupportCog

        self.assertIn("commentgacha", [c.value for c in SUPPORT_ACTIONS])
        labels = {c.value: c.name for c in SUPPORT_ACTIONS}
        self.assertEqual(labels["commentgacha"], "コメントガチャ")
        self.assertIn("commentgacha",
                      [v for _l, v in SUPPORT_ACTIONS_BY_GENRE["automation"]])
        self.assertEqual(
            SupportCog.SUPPORT_REQUIRED_PERMISSIONS.get("commentgacha"), "manage_guild")

    def test_registry_spec_excludes_aitools(self):
        from core.general import action_registry

        spec = action_registry.default_registry().get("support:commentgacha")
        self.assertIsNotNone(spec)
        self.assertEqual(spec.genre, "automation")
        self.assertNotIn("aitools", spec.surfaces)


class DispatchTest(unittest.IsolatedAsyncioTestCase):
    async def test_dispatch_routes_to_settings(self):
        from cogs.support import SupportCog

        cog = SupportCog(types.SimpleNamespace(get_cog=lambda name: None))
        cog.show_commentgacha_settings = AsyncMock()
        interaction = types.SimpleNamespace(
            user=types.SimpleNamespace(
                id=42,
                guild_permissions=types.SimpleNamespace(
                    administrator=True, manage_guild=True, manage_roles=True,
                    manage_channels=True, manage_messages=True),
            ),
            guild_id=1,
            guild=types.SimpleNamespace(id=1),
            response=types.SimpleNamespace(send_message=AsyncMock(), is_done=lambda: False),
        )
        await cog.dispatch(interaction, "commentgacha")
        cog.show_commentgacha_settings.assert_awaited_once_with(interaction)


# ---------------------------------------------------------------- Cog 判定

def make_author(name="誰か", *, bot=False, user_id=10):
    return types.SimpleNamespace(
        id=user_id, bot=bot, display_name=name,
        display_avatar=types.SimpleNamespace(url="https://example.com/avatar.png"),
    )


class FakeWebhook:
    def __init__(self):
        self.send = AsyncMock()


class FakeChannel:
    def __init__(self, messages=(), *, channel_id=100, name="general"):
        self.id = channel_id
        self.name = name
        self._messages = list(messages)
        self.last_message_id = self._messages[0].id if self._messages else None
        self.webhook = FakeWebhook()
        self.create_webhook = AsyncMock(return_value=self.webhook)
        self._permissions = types.SimpleNamespace(
            manage_webhooks=True, read_message_history=True)

    def history(self, limit=None, *, before=None, after=None, around=None, oldest_first=None):
        items = list(self._messages)
        if after is not None:
            items = [m for m in items if m.id > after.id]
        if before is not None:
            items = [m for m in items if m.id < before.id]
        if oldest_first:
            items.reverse()
        if limit is not None:
            items = items[:limit]

        async def gen():
            for item in items:
                yield item

        return gen()

    async def webhooks(self):
        return []

    def permissions_for(self, me):
        return self._permissions


def hist_message(msg_id, content, *, author=None):
    return types.SimpleNamespace(
        id=msg_id, content=content,
        author=author or make_author(f"user{msg_id}", user_id=msg_id),
        webhook_id=None, type=None, attachments=[], mentions=[], role_mentions=[],
    )


def make_guild(*channels):
    return types.SimpleNamespace(
        id=1, me=types.SimpleNamespace(id=5),
        text_channels=list(channels), threads=[])


class FakeMessage:
    def __init__(self, content="コメントガチャ", *, channel=None, guild=None, channel_mentions=()):
        self.id = 999
        self.content = content
        self.guild = guild or make_guild(channel) if channel else make_guild()
        self.author = make_author("引いた人", user_id=2)
        self.channel = channel or FakeChannel()
        self.channel_mentions = list(channel_mentions)


def settings_dict(**overrides):
    base = gacha_settings.normalize_settings(None)
    base.update(overrides)
    return base


class CogSettingsGateTest(unittest.IsolatedAsyncioTestCase):
    def make_cog(self, clock=lambda: 1000.0):
        return CommentGachaCog(types.SimpleNamespace(), clock=clock)

    async def run_with(self, settings, message):
        cog = self.make_cog()
        with patch("core.general.commentgacha.cog.gacha_settings.fetch_settings",
                   new=AsyncMock(return_value=settings)):
            await cog.on_message(message)
        return cog

    async def test_disabled_guild_does_not_repost(self):
        channel = FakeChannel([hist_message(7, "昔の名言")])
        await self.run_with(settings_dict(enabled=False), FakeMessage(channel=channel))
        channel.create_webhook.assert_not_awaited()

    async def test_blocked_trigger_channel_does_not_repost(self):
        channel = FakeChannel([hist_message(7, "昔の名言")], channel_id=100)
        await self.run_with(
            settings_dict(blocked_trigger_channel_ids=[100]), FakeMessage(channel=channel))
        channel.create_webhook.assert_not_awaited()

    async def test_blocked_source_same_channel_does_not_repost(self):
        channel = FakeChannel([hist_message(7, "昔の名言")], channel_id=100)
        await self.run_with(
            settings_dict(blocked_source_channel_ids=[100]), FakeMessage(channel=channel))
        channel.create_webhook.assert_not_awaited()

    async def test_blocked_source_named_channel_does_not_repost(self):
        here = FakeChannel([], channel_id=100, name="general")
        there = FakeChannel([hist_message(700, "雑談の名発言")], channel_id=200, name="雑談")
        message = FakeMessage("コメントガチャ#雑談", channel=here, guild=make_guild(here, there))
        await self.run_with(settings_dict(blocked_source_channel_ids=[200]), message)
        here.create_webhook.assert_not_awaited()

    async def test_unblocked_named_channel_still_works(self):
        here = FakeChannel([], channel_id=100, name="general")
        there = FakeChannel([hist_message(700, "雑談の名発言")], channel_id=200, name="雑談")
        message = FakeMessage("コメントガチャ#雑談", channel=here, guild=make_guild(here, there))
        await self.run_with(settings_dict(blocked_source_channel_ids=[999]), message)
        kwargs = here.webhook.send.await_args.kwargs
        self.assertEqual(kwargs["content"], "雑談の名発言")

    async def test_cooldown_preset_applies(self):
        channel = FakeChannel([hist_message(7, "昔の名言")])
        now = [1000.0]
        cog = self.make_cog(clock=lambda: now[0])
        with patch("core.general.commentgacha.cog.gacha_settings.fetch_settings",
                   new=AsyncMock(return_value=settings_dict(cooldown_seconds=30))):
            await cog.on_message(FakeMessage(channel=channel))
            now[0] += 10
            await cog.on_message(FakeMessage(channel=channel))
            self.assertEqual(channel.webhook.send.await_count, 1)
            now[0] += 21
            await cog.on_message(FakeMessage(channel=channel))
            self.assertEqual(channel.webhook.send.await_count, 2)

    async def test_cooldown_zero_allows_immediate_redraw(self):
        channel = FakeChannel([hist_message(7, "昔の名言")])
        cog = self.make_cog()
        with patch("core.general.commentgacha.cog.gacha_settings.fetch_settings",
                   new=AsyncMock(return_value=settings_dict(cooldown_seconds=0))):
            await cog.on_message(FakeMessage(channel=channel))
            await cog.on_message(FakeMessage(channel=channel))
        self.assertEqual(channel.webhook.send.await_count, 2)


# ---------------------------------------------------------------- パネル

class FakeKV:
    def __init__(self):
        self.remote = {}

    def load_local(self):
        return {}

    async def load_all(self):
        return {key: dict(value) for key, value in self.remote.items()}

    async def load_one(self, key):
        return self.remote.get(str(key))

    async def set(self, key, value, *, wait=True):
        self.remote[str(key)] = value

    async def delete(self, key, *, wait=True):
        self.remote.pop(str(key), None)


class PanelTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        from core.support import guild_settings
        from core.support.guild_settings import GuildSettings

        self._guild_settings = guild_settings
        self._old_store = guild_settings.get_store()
        self.kv = FakeKV()
        guild_settings.set_store(GuildSettings(self.kv))

    def tearDown(self):
        self._guild_settings.set_store(self._old_store)

    def make_view(self, **overrides):
        from core.support.commentgacha import CommentGachaSettingsView

        return CommentGachaSettingsView(None, settings_dict(**overrides))

    def test_view_structure(self):
        from core.support.commentgacha import _CooldownSelect

        view = self.make_view()
        selects = [i for i in view.children if isinstance(i, discord.ui.ChannelSelect)]
        plain_selects = [i for i in view.children if isinstance(i, _CooldownSelect)]
        buttons = [i for i in view.children if isinstance(i, discord.ui.Button)]
        self.assertEqual(len(selects), 2)
        self.assertEqual(len(plain_selects), 1)
        self.assertEqual(len(buttons), 1)
        embed = view.embed()
        self.assertIn("オン", embed.description)
        self.assertIn("1秒", embed.description)

    def make_interaction(self):
        return types.SimpleNamespace(
            guild_id=1,
            user=types.SimpleNamespace(
                guild_permissions=types.SimpleNamespace(
                    administrator=False, manage_guild=True)),
            response=types.SimpleNamespace(
                defer=AsyncMock(), is_done=lambda: True,
                send_message=AsyncMock(), edit_message=AsyncMock()),
            followup=types.SimpleNamespace(send=AsyncMock()),
            edit_original_response=AsyncMock(),
        )

    async def test_toggle_saves_disabled(self):
        view = self.make_view()
        interaction = self.make_interaction()
        await view._toggle(interaction)
        saved = self.kv.remote["1"]["commentgacha"]
        self.assertEqual(saved["enabled"], False)
        self.assertFalse(view.settings["enabled"])

    async def test_cooldown_select_saves(self):
        from core.support.commentgacha import _CooldownSelect

        view = self.make_view()
        interaction = self.make_interaction()
        select = next(i for i in view.children if isinstance(i, _CooldownSelect))
        select._values = ["300"]
        await select.callback(interaction)
        saved = self.kv.remote["1"]["commentgacha"]
        self.assertEqual(saved["cooldown_seconds"], 300)

    async def test_non_manager_cannot_save(self):
        view = self.make_view()
        interaction = self.make_interaction()
        interaction.user.guild_permissions.manage_guild = False
        await view._toggle(interaction)
        interaction.response.send_message.assert_awaited_once()
        self.assertEqual(self.kv.remote, {})


if __name__ == "__main__":
    unittest.main()
