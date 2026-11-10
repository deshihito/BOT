"""隠しチャンネル（Bot が閲覧できないチャンネル）対策のテスト。

2026-11-16 から、Bot が閲覧できないチャンネルは名前が ``___hidden___``
で届き、ID・種類・位置・親以外のフィールドは信頼できなくなる。
ここでは core/channel_safety.py の判定と、それを使う各機能が
隠しチャンネルで壊れないことを確認する。
"""

import sys
import types
import unittest
from pathlib import Path
from unittest.mock import AsyncMock

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import discord  # noqa: E402

from core.channel_safety import (  # noqa: E402
    HIDDEN_CHANNEL_LABEL,
    HIDDEN_CHANNEL_NAME,
    channel_display_name,
    is_hidden_channel,
)
from core.support.server_setup import cog as server_setup  # noqa: E402
from core.support.muted.cog import Muted  # noqa: E402
from core.support.server_assist import usable_text_channels  # noqa: E402
from core.support.server_assist.features import serverlog  # noqa: E402
from core.support.auth.cog import sync_category_perms  # noqa: E402
from tests.fake_kv_supabase import FakeKVSupabase  # noqa: E402


ALL_PERMS = types.SimpleNamespace(
    view_channel=True, send_messages=True, embed_links=True,
    manage_webhooks=True, add_reactions=True, read_messages=True,
    read_message_history=True,
)


class FakeChannel:
    def __init__(self, channel_id, name, position=0, perms=None, overwrite=None):
        self.id = channel_id
        self.name = name
        self.position = position
        self.perms = perms if perms is not None else ALL_PERMS
        self.mention = f"<#{channel_id}>"
        self.type = "text"
        self.guild = None
        self._overwrite = overwrite if overwrite is not None else discord.PermissionOverwrite()
        self.set_permissions = AsyncMock()
        self.send = AsyncMock()

    def permissions_for(self, member):
        return self.perms

    def overwrites_for(self, role):
        return self._overwrite


class HelperTest(unittest.TestCase):
    def test_is_hidden_channel(self):
        self.assertTrue(is_hidden_channel(FakeChannel(1, HIDDEN_CHANNEL_NAME)))
        self.assertFalse(is_hidden_channel(FakeChannel(2, "general")))
        self.assertFalse(is_hidden_channel(types.SimpleNamespace()))  # 名前が無いものは隠し扱いしない
        self.assertFalse(is_hidden_channel(None))

    def test_channel_display_name(self):
        self.assertEqual(channel_display_name(FakeChannel(1, "general")), "general")
        self.assertEqual(channel_display_name(FakeChannel(2, HIDDEN_CHANNEL_NAME)), HIDDEN_CHANNEL_LABEL)
        self.assertEqual(
            channel_display_name(FakeChannel(3, HIDDEN_CHANNEL_NAME), fallback="チャンネル"),
            "チャンネル",
        )
        self.assertEqual(channel_display_name(types.SimpleNamespace(name=None)), HIDDEN_CHANNEL_LABEL)


class WelcomePickerTest(unittest.TestCase):
    def _guild(self, system, channels):
        return types.SimpleNamespace(
            me=types.SimpleNamespace(id=999),
            system_channel=system,
            text_channels=channels,
        )

    def test_can_post_rejects_hidden_channel(self):
        hidden = FakeChannel(1, HIDDEN_CHANNEL_NAME)
        self.assertFalse(server_setup.can_post(hidden, types.SimpleNamespace()))
        self.assertFalse(server_setup.can_post_v2(hidden, types.SimpleNamespace()))
        visible = FakeChannel(2, "general")
        self.assertTrue(server_setup.can_post(visible, types.SimpleNamespace()))
        self.assertTrue(server_setup.can_post_v2(visible, types.SimpleNamespace()))

    def test_pick_welcome_channel_skips_hidden(self):
        hidden_first = FakeChannel(1, HIDDEN_CHANNEL_NAME, position=0)
        visible = FakeChannel(2, "general", position=1)
        guild = self._guild(hidden_first, [hidden_first, visible])
        self.assertIs(server_setup.pick_welcome_channel(guild), visible)
        self.assertIs(server_setup.pick_welcome_channel_v2(guild), visible)

    def test_channel_missing_marks_hidden_as_not_viewable(self):
        hidden = FakeChannel(1, HIDDEN_CHANNEL_NAME)
        self.assertEqual(
            server_setup._channel_missing(hidden, types.SimpleNamespace(), ["view_channel", "manage_webhooks"]),
            ["view_channel"],
        )
        visible = FakeChannel(2, "general")
        self.assertEqual(
            server_setup._channel_missing(visible, types.SimpleNamespace(), ["view_channel", "manage_webhooks"]),
            [],
        )


class UsableTextChannelsTest(unittest.TestCase):
    def test_hidden_channel_is_not_usable(self):
        guild = types.SimpleNamespace(
            me=types.SimpleNamespace(id=999),
            text_channels=[FakeChannel(1, HIDDEN_CHANNEL_NAME), FakeChannel(2, "general")],
        )
        usable = usable_text_channels(guild)
        self.assertEqual([c.id for c in usable], [2])


class ServerLogDisplayTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.db = FakeKVSupabase()
        # serverlog の設定読み書きは guild_settings ストア経由。テスト用の偽ストアに差し替える代わりに
        # update_settings/get_settings を直接モジュール属性で差し替える。
        self._orig_update = serverlog.update_settings
        self._orig_get = serverlog.get_settings
        self.saved = {}
        serverlog.update_settings = lambda gid, key, **kw: self.saved.update(kw)
        serverlog.get_settings = lambda gid, key: dict(self.saved)
        self.addCleanup(setattr, serverlog, "update_settings", self._orig_update)
        self.addCleanup(setattr, serverlog, "get_settings", self._orig_get)

    async def test_hidden_channel_name_is_not_shown_raw(self):
        serverlog.update_settings(1, serverlog.KEY, enabled=True, channel_id=20, log_channels=True)
        guild = types.SimpleNamespace(id=1)
        log_channel = FakeChannel(20, "server-log")
        log_channel.guild = guild
        guild.get_channel = lambda cid: log_channel
        hidden = FakeChannel(30, HIDDEN_CHANNEL_NAME)
        hidden.guild = guild
        await serverlog.on_guild_channel_create(None, hidden)
        self.assertEqual(log_channel.send.await_count, 1)
        embed = log_channel.send.await_args.kwargs["embed"]
        name_field = next(f for f in embed.fields if f.name == "名前")
        self.assertNotEqual(name_field.value, HIDDEN_CHANNEL_NAME)


class SyncCategoryPermsTest(unittest.IsolatedAsyncioTestCase):
    async def test_one_failing_channel_does_not_stop_the_sync(self):
        class FakeRole:
            def __init__(self, role_id):
                self.id = role_id

        role = FakeRole(5)

        class FakeSyncChannel:
            def __init__(self, channel_id, fail=False):
                self.id = channel_id
                self.fail = fail
                self.edited = False

            async def edit(self, **kwargs):
                if self.fail:
                    raise discord.Forbidden(types.SimpleNamespace(status=403, reason="Forbidden"), "no")
                self.edited = True

        ok1, bad, ok2 = FakeSyncChannel(1), FakeSyncChannel(2, fail=True), FakeSyncChannel(3)
        category = types.SimpleNamespace(
            guild=types.SimpleNamespace(default_role=FakeRole(0)),
            channels=[ok1, bad, ok2],
            edit=AsyncMock(),
        )
        count = await sync_category_perms(category, role)
        self.assertEqual(count, 2)
        self.assertTrue(ok1.edited)
        self.assertTrue(ok2.edited)


class MutedHideToggleTest(unittest.IsolatedAsyncioTestCase):
    async def test_reference_channel_skips_hidden(self):
        cog = Muted.__new__(Muted)
        cog.bot = types.SimpleNamespace()
        cog.embed_color = 0xFFFFFF
        role = types.SimpleNamespace(id=77)
        cog.get_or_create_muted_role = AsyncMock(return_value=(role, False))

        # 先頭の隠しチャンネルは「非表示状態」の上書きを持つが、基準に使ってはいけない。
        hidden = FakeChannel(1, HIDDEN_CHANNEL_NAME, overwrite=discord.PermissionOverwrite(view_channel=False))
        visible = FakeChannel(2, "general", overwrite=discord.PermissionOverwrite(view_channel=None))
        guild = types.SimpleNamespace(id=1, text_channels=[hidden, visible], channels=[hidden, visible])
        interaction = types.SimpleNamespace(
            guild=guild,
            response=types.SimpleNamespace(defer=AsyncMock()),
            edit_original_response=AsyncMock(),
        )
        view = Muted.MuteSettingView(cog, discord.Embed())
        select = next(item for item in view.children if isinstance(item, discord.ui.Select))
        select._values = ["hide_toggle"]
        await select.callback(interaction)
        # 基準は visible（未設定＝見える）なので「非表示にする」方向になる。
        visible.set_permissions.assert_awaited()
        kwargs = visible.set_permissions.await_args.kwargs
        self.assertIs(kwargs["view_channel"], False)


if __name__ == "__main__":
    unittest.main()
