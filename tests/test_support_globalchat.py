"""グローバルチャットの /support 移植（2026-11-07）のテスト。

- レジストリ登録（support:globalchat、automation ジャンル、AI 代理実行なし）
- 登録/解除が GlobalChatCog の保存先（active_channels + save_channels）を
  そのまま使うこと
- 設定パネルの表示とトグル、荒らし対策モーダルの保存先
"""
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from core.support import guild_settings
from core.general import action_registry  # noqa: E402
from core.support.storage import KVStore  # noqa: E402
from core.support.globalchat import globalchat_panel as gp  # noqa: E402
from core.support.common import SUPPORT_ACTIONS_BY_GENRE  # noqa: E402
from cogs.support import SUPPORT_ACTIONS, SupportCog  # noqa: E402


def _gc_cog(channels=()):
    return types.SimpleNamespace(active_channels=set(channels), save_channels=MagicMock())


def _guild(channel_ids=(55,)):
    guild = types.SimpleNamespace(id=10, name="テストサーバー")
    channels = {cid: types.SimpleNamespace(id=cid, name=f"ch{cid}", guild=guild)
                for cid in channel_ids}
    guild.get_channel = lambda cid: channels.get(cid)
    guild.me = types.SimpleNamespace(id=999)
    for ch in channels.values():
        ch.permissions_for = lambda me: types.SimpleNamespace(
            view_channel=True, manage_webhooks=True, add_reactions=True)
    guild.channels = channels
    return guild


class RegistryTest(unittest.TestCase):
    def test_action_registered_in_automation_genre(self):
        values = [value for _label, value in SUPPORT_ACTIONS_BY_GENRE["automation"]]
        self.assertIn("globalchat", values)
        self.assertIn("globalchat", [c.value for c in SUPPORT_ACTIONS])

    def test_registry_spec(self):
        spec = action_registry.default_registry().by_id("support:globalchat")
        self.assertIsNotNone(spec)
        self.assertEqual(spec.genre, "automation")
        # 設定の状態変更系なので AI 代理実行には出さない（他設定パネルと同扱い）。
        self.assertNotIn("aitools", spec.surfaces)

    def test_permission_is_manage_guild(self):
        self.assertEqual(
            SupportCog.SUPPORT_REQUIRED_PERMISSIONS.get("globalchat"), "manage_guild")


class ConnectionTest(unittest.TestCase):
    def test_toggle_uses_existing_store(self):
        gc = _gc_cog()
        gp.set_globalchat_connection(gc, 55, True)
        self.assertEqual(gc.active_channels, {55})
        gc.save_channels.assert_called_once()
        gp.set_globalchat_connection(gc, 55, False)
        self.assertEqual(gc.active_channels, set())
        self.assertEqual(gc.save_channels.call_count, 2)

    def test_guild_channel_ids_filters_by_guild(self):
        gc = _gc_cog({55, 77})
        guild = _guild((55,))
        self.assertEqual(gp.guild_globalchat_channel_ids(guild, gc), [55])

    def test_globalchat_cog_shape_check(self):
        bot = types.SimpleNamespace(get_cog=lambda name: _gc_cog())
        self.assertIsNotNone(gp.globalchat_cog(bot))
        bot2 = types.SimpleNamespace(get_cog=lambda name: types.SimpleNamespace())
        self.assertIsNone(gp.globalchat_cog(bot2))


class _StoreTestCase(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        guild_settings.set_store(guild_settings.GuildSettings(
            KVStore("guild_settings", client=None, path=os.path.join(tmp.name, "kv.json"))))
        self.addCleanup(guild_settings.set_store, None)


class ViewTest(_StoreTestCase):
    def _view(self, channels=()):
        gc = _gc_cog(channels)
        guild = _guild()
        channel = guild.channels[55]
        cog = types.SimpleNamespace(bot=types.SimpleNamespace(get_cog=lambda name: gc))
        return gp.GlobalChatSettingsView(cog, guild, channel), gc

    def test_embed_shows_disconnected_state(self):
        view, _gc = self._view()
        embed = view.embed()
        values = [f.value for f in embed.fields]
        self.assertTrue(any("つないでいません" in v for v in values))
        self.assertTrue(any("NG ワード" in v for v in values))

    async def test_toggle_connects_and_saves(self):
        view, gc = self._view()
        interaction = types.SimpleNamespace(
            user=types.SimpleNamespace(
                guild_permissions=types.SimpleNamespace(manage_guild=True, administrator=False)),
            response=types.SimpleNamespace(
                is_done=lambda: False, edit_message=AsyncMock(), send_message=AsyncMock()),
            guild_id=10,
        )
        await view.on_toggle(interaction)
        self.assertIn(55, gc.active_channels)
        gc.save_channels.assert_called_once()
        self.assertTrue(any("つないでいます" in f.value for f in view.embed().fields))

    async def test_toggle_requires_manage_permission(self):
        view, gc = self._view()
        interaction = types.SimpleNamespace(
            user=types.SimpleNamespace(
                guild_permissions=types.SimpleNamespace(manage_guild=False, administrator=False)),
            response=types.SimpleNamespace(
                is_done=lambda: False, send_message=AsyncMock()),
            guild_id=10,
        )
        await view.on_toggle(interaction)
        self.assertEqual(gc.active_channels, set())
        interaction.response.send_message.assert_awaited()


class ModalSaveTest(_StoreTestCase):
    async def test_moderation_modal_saves_to_globalchat_section(self):
        gc = _gc_cog()
        guild = _guild()
        channel = guild.channels[55]
        cog = types.SimpleNamespace(bot=types.SimpleNamespace(get_cog=lambda name: gc))
        view = gp.GlobalChatSettingsView(cog, guild, channel)
        view.refresh = AsyncMock()
        modal = gp.GlobalChatModerationModal(view)
        modal.ng_words._value = "あらし, spam"
        modal.blocked_users._value = "123"
        modal.blocked_guilds._value = "10 456"  # 自サーバー(10)は除外される
        interaction = types.SimpleNamespace(
            user=types.SimpleNamespace(
                guild_permissions=types.SimpleNamespace(manage_guild=True, administrator=False)),
            response=types.SimpleNamespace(send_message=AsyncMock()),
            guild_id=10,
        )
        await modal.on_submit(interaction)
        from core.support.globalchat import globalchat_moderation as mod
        saved = mod.settings(10)
        self.assertEqual(saved["ng_words"], ["あらし", "spam"])
        self.assertEqual(saved["blocked_users"], [123])
        self.assertEqual(saved["blocked_guilds"], [456])


class DispatchTest(unittest.IsolatedAsyncioTestCase):
    async def test_dispatch_routes_to_globalchat_settings(self):
        cog = object.__new__(SupportCog)
        cog.bot = types.SimpleNamespace()
        cog.show_globalchat_settings = AsyncMock()
        interaction = types.SimpleNamespace(guild_id=10, user=types.SimpleNamespace(id=7))
        with patch("cogs.support.action_usage.record_safely_in_background"), \
                patch("cogs.support.usage_stats.record_action_safely"), \
                patch.object(SupportCog, "check_support_permission", AsyncMock(return_value=True)):
            await cog.dispatch(interaction, "globalchat")
        cog.show_globalchat_settings.assert_awaited_once()


if __name__ == "__main__":
    unittest.main()
