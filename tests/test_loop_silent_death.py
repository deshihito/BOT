# -*- coding: utf-8 -*-
"""S2: tasks.loop の無言死の回帰テスト。

discord.py の tasks.loop は本体で例外が漏れるとループごと止まる
（.error ハンドラは報告だけで再開しない）。ループ本体・直前の
読み込みで例外が出ても吸収して次周期に再試行できることを、
ループの1周分（.coro）を直接呼んで検証する。実 Discord には接続しない。
"""
from __future__ import annotations

import os
import sys
import types
import unittest
from unittest import mock
from unittest.mock import AsyncMock, Mock, patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

for _name, _value in {"BOT_API_BASE_URL": "http://127.0.0.1:8787", "BOT_API_KEY": "dummy-key"}.items():
    os.environ.setdefault(_name, _value)

import cogs.support  # noqa: E402,F401 （support 系の import 順を既存テストに合わせる）
from core.support import guild_settings  # noqa: E402
from core.support import quest as quest_mod  # noqa: E402
from core.support.quest import QuestSupportMixin  # noqa: E402
from core.support.sns import SnsSupportMixin  # noqa: E402
from core.vc import radio as radio_mod  # noqa: E402
from core.vc.radio import RadioCog, save_radio_settings  # noqa: E402
from core.vc.globalvc import entry as gvc  # noqa: E402
from tests.test_radio import FakeGuild, use_temp_settings  # noqa: E402
from tests.test_voice_session import make_bot  # noqa: E402


def failing_store():
    """ensure_loaded が必ず失敗する設定ストア（読み込み障害の再現）。"""
    store = Mock()
    store.ensure_loaded = AsyncMock(side_effect=RuntimeError("kv down"))
    return store


class GlobalVCLoopSurvivalTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.bot, self.manager = make_bot()
        self.saved = dict(gvc.GLOBAL_ROOMS)
        gvc.GLOBAL_ROOMS.clear()
        self.cog = gvc.GlobalVCCog(self.bot)

    async def asyncTearDown(self):
        await self.manager.close()
        gvc.GLOBAL_ROOMS.clear()
        gvc.GLOBAL_ROOMS.update(self.saved)

    async def test_theme_loop_survives_rotate_failure(self):
        with patch.object(gvc, "rotate_room_themes", side_effect=RuntimeError("theme boom")):
            await gvc.GlobalVCCog._theme_rotation_loop.coro(self.cog)
        # 例外が外へ漏れなければ、ループは次周期も生きている（=止まっていない）

    async def test_watchdog_survives_prune_failure(self):
        with patch.object(gvc, "_prune_dead_clients", side_effect=RuntimeError("prune boom")):
            await gvc.GlobalVCCog._playback_watchdog.coro(self.cog)


class SnsPollSurvivalTest(unittest.IsolatedAsyncioTestCase):
    def make_cog(self):
        obj = SnsSupportMixin.__new__(SnsSupportMixin)
        obj.bot = types.SimpleNamespace(guilds=[])
        return obj

    async def test_poll_survives_settings_load_failure(self):
        obj = self.make_cog()
        store = failing_store()
        guild_settings.set_store(store)
        self.addCleanup(guild_settings.set_store, None)
        await SnsSupportMixin.sns_poll.coro(obj)


class QuestPollSurvivalTest(unittest.IsolatedAsyncioTestCase):
    def make_cog(self):
        obj = QuestSupportMixin.__new__(QuestSupportMixin)
        obj.bot = types.SimpleNamespace(guilds=[])
        obj._quest = Mock()
        return obj

    async def test_poll_survives_settings_load_failure(self):
        obj = self.make_cog()
        store = failing_store()
        guild_settings.set_store(store)
        self.addCleanup(guild_settings.set_store, None)
        with patch.object(quest_mod, "_quest_feed_url", return_value="https://example.invalid/feed"):
            await QuestSupportMixin.quest_poll.coro(obj)


class RadioSupervisorSurvivalTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        use_temp_settings(self)

    def make_cog(self, guilds):
        bot = mock.MagicMock()
        bot.get_guild = lambda gid: next((g for g in guilds if g.id == gid), None)
        cog = RadioCog(bot)
        return cog

    async def test_supervisor_survives_settings_load_failure(self):
        cog = self.make_cog([])
        with patch.object(radio_mod, "get_store", return_value=failing_store()):
            await RadioCog._supervisor.coro(cog)

    async def test_supervisor_skips_failing_guild_and_continues(self):
        guild1, guild2 = FakeGuild(1), FakeGuild(2)
        for guild in (guild1, guild2):
            await save_radio_settings(
                guild.id, always_on=True, playing=True, channel_id=guild.channel.id)
        cog = self.make_cog([guild1, guild2])
        cog.start_radio = AsyncMock()

        def _has_radio(gid):
            if gid == guild1.id:
                raise RuntimeError("session boom")
            return False

        cog.session_has_radio = Mock(side_effect=_has_radio)
        await RadioCog._supervisor.coro(cog)
        # 失敗した guild1 を飛ばし、guild2 の復帰は試みられていること
        self.assertEqual(cog.start_radio.await_count, 1)
        called_guild = cog.start_radio.await_args.args[0]
        self.assertEqual(called_guild.id, guild2.id)


if __name__ == "__main__":
    unittest.main()
