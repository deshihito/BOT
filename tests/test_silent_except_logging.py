# -*- coding: utf-8 -*-
"""無言の例外握りつぶしへのログ追加のテスト (監査 #7 第1弾)。

代表経路について、例外時にログが出ることと、従来どおりの
フォールバック挙動（制御フロー不変）が保たれることを確認する。
"""
import types
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

import discord

import cogs.general as general_module
import cogs.jinrou as jinrou_module
import cogs.sio_music as music_module
import cogs.support as support_module


def _http_exception():
    response = types.SimpleNamespace(status=404, reason="Not Found")
    return discord.HTTPException(response, "not found")


class JinrouRatingLoggingTests(unittest.IsolatedAsyncioTestCase):
    """print だったレート系ハンドラが logger.exception を出すこと。"""

    def _broken_db(self):
        db = MagicMock()
        db.table.side_effect = RuntimeError("db down")
        return db

    async def test_get_player_rating_logs_and_returns_default(self):
        with patch.object(jinrou_module, "db_api", self._broken_db()):
            with self.assertLogs("cogs.jinrou", level="ERROR") as logs:
                rating = await jinrou_module.get_player_rating(42)
        self.assertEqual(rating, jinrou_module.ELO_STARTING_RATING)
        self.assertTrue(any("レート取得" in line for line in logs.output))

    async def test_update_player_rating_logs(self):
        with patch.object(jinrou_module, "db_api", self._broken_db()):
            with self.assertLogs("cogs.jinrou", level="ERROR") as logs:
                await jinrou_module.update_player_rating(42, 1500.0)
        self.assertTrue(any("レート更新" in line for line in logs.output))

    async def test_get_top_ratings_logs_and_returns_empty(self):
        with patch.object(jinrou_module, "db_api", self._broken_db()):
            with self.assertLogs("cogs.jinrou", level="ERROR") as logs:
                top = await jinrou_module.get_top_ratings()
        self.assertEqual(top, [])
        self.assertTrue(any("ランキング取得" in line for line in logs.output))


class JinrouGlobalProxyLoggingTests(unittest.IsolatedAsyncioTestCase):
    """bare except だったグローバル送信が Exception + debug ログになること。"""

    async def test_send_failure_logs_debug_and_returns_none(self):
        chan = types.SimpleNamespace(
            id=1, send=AsyncMock(side_effect=RuntimeError("send failed"))
        )
        game = types.SimpleNamespace(
            is_global=True, channels=[chan], _original_channel=chan
        )
        proxy = jinrou_module.GlobalChannelProxy(game)
        with self.assertLogs("cogs.jinrou", level="DEBUG") as logs:
            result = await proxy.send("hello")
        self.assertIsNone(result)
        self.assertTrue(any("グローバルチャンネルへの送信" in line for line in logs.output))


class GeneralStoreFetchLoggingTests(unittest.TestCase):
    """_store_fetch の失敗が warning ログになり None を返すこと。"""

    def test_store_fetch_failure_logs_warning_and_returns_none(self):
        store = types.SimpleNamespace(
            get=MagicMock(side_effect=RuntimeError("store down"))
        )
        with self.assertLogs("cogs.general", level="WARNING") as logs:
            result = general_module._store_fetch(store, "some:key")
        self.assertIsNone(result)
        self.assertTrue(any("旧ストア" in line for line in logs.output))


class GeneralLevelupUserLoggingTests(unittest.IsolatedAsyncioTestCase):
    """_levelup_user の取得失敗が debug ログになり None を返すこと。"""

    async def test_fetch_failures_log_debug_and_return_none(self):
        cog = object.__new__(general_module.GeneralCog)
        cog.bot = types.SimpleNamespace(
            fetch_user=AsyncMock(side_effect=_http_exception())
        )
        guild = types.SimpleNamespace(
            get_member=lambda user_id: None,
            fetch_member=AsyncMock(side_effect=_http_exception()),
        )
        with self.assertLogs("cogs.general", level="DEBUG") as logs:
            result = await cog._levelup_user(guild, 123)
        self.assertIsNone(result)
        self.assertTrue(any("メンバーの取得" in line for line in logs.output))
        self.assertTrue(any("ユーザーの取得" in line for line in logs.output))


class SupportBulkRoleLoggingTests(unittest.IsolatedAsyncioTestCase):
    """一括ロール操作のメンバー単位失敗が debug ログになり集計されること。"""

    async def test_member_failure_logs_debug_and_counts_failed(self):
        cog = object.__new__(support_module.SupportCog)
        role = MagicMock()
        role.is_default.return_value = False
        role.managed = False
        role.__ge__.return_value = False
        me = types.SimpleNamespace(
            guild_permissions=types.SimpleNamespace(manage_roles=True),
            top_role=object(),
        )
        member = types.SimpleNamespace(
            bot=False,
            roles=[],
            add_roles=AsyncMock(side_effect=RuntimeError("boom")),
            remove_roles=AsyncMock(),
        )
        guild = types.SimpleNamespace(me=me, members=[member])
        with self.assertLogs("cogs.support", level="DEBUG") as logs:
            affected, skipped, failed = await cog.bulk_role_update(
                guild, role, True
            )
        self.assertEqual((affected, skipped, failed), (0, 0, 1))
        self.assertTrue(any("一括ロール操作" in line for line in logs.output))


class SupportEditAuthPanelLoggingTests(unittest.IsolatedAsyncioTestCase):
    """認証パネルの編集失敗が debug ログになり再送信フォールバックすること。"""

    async def test_edit_failure_logs_debug_and_falls_back_to_send(self):
        interaction = types.SimpleNamespace(
            response=types.SimpleNamespace(
                edit_message=AsyncMock(side_effect=_http_exception()),
                is_done=lambda: True,
                send_message=AsyncMock(),
            ),
            followup=types.SimpleNamespace(send=AsyncMock()),
        )
        with patch.object(support_module, "as_panel_v2", lambda panel: object()):
            with self.assertLogs("cogs.support", level="DEBUG") as logs:
                await support_module.edit_auth_panel_message(interaction, object())
        interaction.followup.send.assert_awaited_once()
        self.assertTrue(any("認証パネルの編集" in line for line in logs.output))


class MusicGetDurationLoggingTests(unittest.IsolatedAsyncioTestCase):
    """get_duration の ffprobe 失敗が debug ログになり 0 を返すこと。"""

    async def test_ffprobe_failure_logs_debug_and_returns_zero(self):
        cog = object.__new__(music_module.VoiceCog)
        with patch(
            "asyncio.create_subprocess_exec",
            new=AsyncMock(side_effect=FileNotFoundError("no ffprobe")),
        ):
            with self.assertLogs("cogs.sio_music", level="DEBUG") as logs:
                duration = await cog.get_duration("https://example.invalid/x")
        self.assertEqual(duration, 0)
        self.assertTrue(any("ffprobe" in line for line in logs.output))


if __name__ == "__main__":
    unittest.main()
