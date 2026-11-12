# -*- coding: utf-8 -*-
"""レベルアップ通知の送信先設定 (guild_settings "levelup_notify") のテスト。

仕様 (3状態):
- 未設定: オン扱いで、EXPが入った場所 (発言したチャンネル/いたVC) へ通知する。
- カスタムチャンネル設定時: そのチャンネルにのみ通知する。
- オフ (enabled=False): 一切通知しない。
- 指定チャンネルが削除済み/投稿不可なら、現行の送信先へフォールバックし、
  警告ログを残す (無言で行き先が変わらないようにする)。

送信経路は core/general/exp/levelup.py の _notify_levelup に集約されており、
チャットEXP / VC退室 / VC tick の3経路すべてがこれを通る。設定パネルは
core/support/levelup.py の LevelUpNotifyPanel (/support レベルアップ通知)。
"""
import types
import unittest
from unittest.mock import AsyncMock, patch

import cogs.support  # noqa: F401  core.support.common の循環 import (MAX_CLEAR) を回避するため先に読む
import core.general.exp.levelup as exp_levelup_module
import core.support.levelup as support_levelup_module
from core.general.exp.levelup import LEVELUP_SECTION, LevelUpMixin, get_levelup_settings
from core.support.levelup import (
    LevelUpChannelSelect,
    LevelUpNotifyPanel,
    LevelUpResetChannelButton,
    LevelUpToggleButton,
)

GUILD_ID = 100


class FakeStore:
    """guild_settings ストアの最小フェイク (get / update / ensure_loaded)。"""

    def __init__(self, sections=None):
        self.sections = dict(sections or {})  # (guild_id, section) -> raw
        self.updates = []

    async def ensure_loaded(self):
        return None

    def get(self, guild_id, section):
        return self.sections.get((guild_id, section), {})

    async def update(self, guild_id, section, **values):
        self.updates.append((guild_id, section, values))
        merged = dict(self.sections.get((guild_id, section), {}))
        merged.update(values)
        self.sections[(guild_id, section)] = merged


def fake_channel(cid, *, view=True, send=True, attach=False):
    perms = types.SimpleNamespace(
        view_channel=view,
        send_messages=send,
        send_messages_in_threads=send,
        attach_files=attach,
    )
    return types.SimpleNamespace(
        id=cid,
        mention=f"<#{cid}>",
        permissions_for=lambda me, _p=perms: _p,
        send=AsyncMock(),
    )


def fake_guild(channels=None):
    channels = channels or {}
    return types.SimpleNamespace(
        id=GUILD_ID,
        me=types.SimpleNamespace(id=999),
        get_channel_or_thread=lambda cid, _c=channels: _c.get(cid),
    )


def fake_user():
    return types.SimpleNamespace(id=42, mention="<@42>", display_name="テスト")


def store_with(raw):
    return FakeStore({(GUILD_ID, LEVELUP_SECTION): raw})


class GetLevelupSettingsTests(unittest.TestCase):
    """get_levelup_settings の正規化 (未設定=オン/送信先なし)。"""

    def test_unset_defaults_to_enabled_without_channel(self):
        cfg = get_levelup_settings(FakeStore(), GUILD_ID)
        self.assertEqual(cfg, {"enabled": True, "channel_id": None})

    def test_stored_values_are_used(self):
        cfg = get_levelup_settings(store_with({"enabled": False, "channel_id": 555}), GUILD_ID)
        self.assertEqual(cfg, {"enabled": False, "channel_id": 555})

    def test_invalid_types_fall_back_to_defaults(self):
        cfg = get_levelup_settings(store_with({"enabled": "off", "channel_id": "555"}), GUILD_ID)
        self.assertEqual(cfg, {"enabled": True, "channel_id": None})
        cfg = get_levelup_settings(store_with({"channel_id": True}), GUILD_ID)
        self.assertIsNone(cfg["channel_id"])

    def test_non_dict_section_falls_back_to_defaults(self):
        cfg = get_levelup_settings(store_with(["broken"]), GUILD_ID)
        self.assertEqual(cfg, {"enabled": True, "channel_id": None})


class NotifyLevelupRoutingTests(unittest.IsolatedAsyncioTestCase):
    """_notify_levelup の送信先解決 (全送信経路共通のヘルパー)。"""

    def _cog(self):
        cog = object.__new__(LevelUpMixin)
        cog.bot = types.SimpleNamespace(user=None)
        return cog

    async def _notify(self, store, guild, fallback):
        cog = self._cog()
        patched = types.SimpleNamespace(get_store=lambda: store)
        with patch.object(exp_levelup_module, "guild_settings", patched):
            await cog._notify_levelup(guild, fake_user(), 3, 4, fallback_channel=fallback)

    async def test_unset_sends_to_fallback_only(self):
        fallback = fake_channel(200)
        guild = fake_guild()
        await self._notify(FakeStore(), guild, fallback)
        fallback.send.assert_awaited_once()
        content = fallback.send.await_args.kwargs["content"]
        self.assertIn("Lv.3 → Lv.4", content)

    async def test_off_sends_nothing(self):
        custom = fake_channel(555)
        fallback = fake_channel(200)
        guild = fake_guild({555: custom})
        store = store_with({"enabled": False, "channel_id": 555})
        await self._notify(store, guild, fallback)
        custom.send.assert_not_awaited()
        fallback.send.assert_not_awaited()

    async def test_custom_channel_receives_only(self):
        custom = fake_channel(555)
        fallback = fake_channel(200)
        guild = fake_guild({555: custom})
        await self._notify(store_with({"channel_id": 555}), guild, fallback)
        custom.send.assert_awaited_once()
        fallback.send.assert_not_awaited()

    async def test_deleted_custom_channel_falls_back_with_warning(self):
        fallback = fake_channel(200)
        guild = fake_guild()  # 指定チャンネルは存在しない (削除済み)
        with self.assertLogs("cogs.general", level="WARNING") as logs:
            await self._notify(store_with({"channel_id": 555}), guild, fallback)
        fallback.send.assert_awaited_once()
        self.assertTrue(any("指定チャンネル" in line for line in logs.output))
        self.assertTrue(any("EXPが入った場所へ通知します" in line for line in logs.output))

    async def test_unpostable_custom_channel_falls_back_with_warning(self):
        custom = fake_channel(555, send=False)
        fallback = fake_channel(200)
        guild = fake_guild({555: custom})
        with self.assertLogs("cogs.general", level="WARNING") as logs:
            await self._notify(store_with({"channel_id": 555}), guild, fallback)
        custom.send.assert_not_awaited()
        fallback.send.assert_awaited_once()
        self.assertTrue(any("指定チャンネル" in line for line in logs.output))

    async def test_no_postable_channel_sends_nothing_and_warns(self):
        custom = fake_channel(555, send=False)
        fallback = fake_channel(200, send=False)
        guild = fake_guild({555: custom})
        with self.assertLogs("cogs.general", level="WARNING") as logs:
            await self._notify(store_with({"channel_id": 555}), guild, fallback)
        custom.send.assert_not_awaited()
        fallback.send.assert_not_awaited()
        self.assertTrue(any("通知をスキップします" in line for line in logs.output))

    async def test_unset_without_postable_fallback_sends_nothing_silently(self):
        fallback = fake_channel(200, send=False)
        guild = fake_guild()
        with self.assertNoLogs("cogs.general", level="WARNING"):
            await self._notify(FakeStore(), guild, fallback)
        fallback.send.assert_not_awaited()


def fake_panel_interaction():
    return types.SimpleNamespace(
        guild_id=GUILD_ID,
        guild=None,
        user=types.SimpleNamespace(
            id=7,
            guild_permissions=types.SimpleNamespace(administrator=False, manage_guild=True),
        ),
        response=types.SimpleNamespace(
            defer=AsyncMock(),
            send_message=AsyncMock(),
        ),
        followup=types.SimpleNamespace(send=AsyncMock()),
    )


class LevelUpPanelTests(unittest.IsolatedAsyncioTestCase):
    """LevelUpNotifyPanel の保存・読戻し・権限 (兄弟パネルと同じ流儀)。"""

    def _panel(self, store, settings=None):
        if settings is None:
            settings = get_levelup_settings(store, GUILD_ID)
        panel = LevelUpNotifyPanel(types.SimpleNamespace(), settings, fake_guild())
        panel.refresh = AsyncMock()
        return panel

    def _patched_store(self, store):
        return patch.object(
            support_levelup_module,
            "guild_settings",
            types.SimpleNamespace(get_store=lambda: store),
        )

    async def test_interaction_check_requires_manage_guild(self):
        panel = self._panel(FakeStore())
        denied = fake_panel_interaction()
        denied.user.guild_permissions = types.SimpleNamespace(
            administrator=False, manage_guild=False
        )
        self.assertFalse(await panel.interaction_check(denied))
        denied.response.send_message.assert_awaited_once()
        self.assertTrue(denied.response.send_message.await_args.kwargs["ephemeral"])

        allowed = fake_panel_interaction()
        self.assertTrue(await panel.interaction_check(allowed))

        admin = fake_panel_interaction()
        admin.user.guild_permissions = types.SimpleNamespace(
            administrator=True, manage_guild=False
        )
        self.assertTrue(await panel.interaction_check(admin))

    async def test_save_channel_and_read_back(self):
        store = FakeStore()
        panel = self._panel(store)
        interaction = fake_panel_interaction()
        with self._patched_store(store):
            await panel.save(interaction, "送信先を設定しました。", channel_id=555)
        self.assertEqual(
            store.sections[(GUILD_ID, LEVELUP_SECTION)]["channel_id"], 555
        )
        self.assertEqual(get_levelup_settings(store, GUILD_ID)["channel_id"], 555)
        panel.refresh.assert_awaited_once()

    async def test_channel_select_callback_saves_channel(self):
        store = FakeStore()
        panel = self._panel(store)
        select = LevelUpChannelSelect(panel)
        select._values = [types.SimpleNamespace(id=777)]
        interaction = fake_panel_interaction()
        with self._patched_store(store):
            await select.callback(interaction)
        self.assertEqual(get_levelup_settings(store, GUILD_ID)["channel_id"], 777)

    async def test_toggle_button_switches_enabled(self):
        store = FakeStore()
        panel = self._panel(store)
        button = LevelUpToggleButton(panel)
        self.assertEqual(button.label, "通知をオフにする")
        interaction = fake_panel_interaction()
        with self._patched_store(store):
            await button.callback(interaction)
        self.assertFalse(get_levelup_settings(store, GUILD_ID)["enabled"])

        panel2 = self._panel(store)  # 保存後の状態で開き直す
        button2 = LevelUpToggleButton(panel2)
        self.assertEqual(button2.label, "通知をオンにする")
        with self._patched_store(store):
            await button2.callback(interaction)
        self.assertTrue(get_levelup_settings(store, GUILD_ID)["enabled"])

    async def test_reset_button_clears_channel(self):
        store = store_with({"channel_id": 555})
        panel = self._panel(store)
        button = LevelUpResetChannelButton(panel)
        self.assertFalse(button.disabled)
        interaction = fake_panel_interaction()
        with self._patched_store(store):
            await button.callback(interaction)
        self.assertIsNone(get_levelup_settings(store, GUILD_ID)["channel_id"])

    async def test_reset_button_disabled_without_channel(self):
        panel = self._panel(FakeStore())
        self.assertTrue(LevelUpResetChannelButton(panel).disabled)


if __name__ == "__main__":
    unittest.main()
