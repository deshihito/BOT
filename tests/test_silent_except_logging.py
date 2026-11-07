# -*- coding: utf-8 -*-
"""無言の例外握りつぶしへのログ追加のテスト (監査 #7 第1弾)。

代表経路について、例外時にログが出ることと、従来どおりの
フォールバック挙動（制御フロー不変）が保たれることを確認する。
"""
import types
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

import discord

import cogs.doubt as doubt_module
import cogs.general as general_module
import core.support.globalchat.cog as globalchat_module
import cogs.guess as guess_module
import cogs.jinrou as jinrou_module
import core.support.log_viewer.cog as log_viewer_module
import core.support.muted.cog as muted_module
import cogs.nation as nation_module
import core.vc.music.entry as music_module
import core.vc.rec.entry as rec_module
import core.vc.voice_entry as voice_module
import core.support.entry as support_module
import cogs.uno as uno_module
import cogs.zetamodoki as zeta_module
import core.support.panel_v2 as panel_v2_module


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


# ======================================================
# 監査 #7 第2弾（残りファイル）
# ======================================================


class DoubtPanelDeleteLoggingTests(unittest.IsolatedAsyncioTestCase):
    """前回パネルの削除失敗（元 bare except）が debug ログになり処理が続くこと。"""

    async def test_delete_failure_logs_debug_and_continues(self):
        # 前回パネルの削除は共通基盤 game_panels.replace が担う（削除失敗は
        # 基盤側で debug ログに残り、処理は続く）ことを send_main_screen 経由で確かめる
        cog = object.__new__(doubt_module.Doubt)
        old_msg = types.SimpleNamespace(
            delete=AsyncMock(side_effect=RuntimeError("already gone"))
        )
        new_msg = types.SimpleNamespace(id=100)
        game = types.SimpleNamespace(
            last_panel_msg=old_msg,
            current_player_id=1,
            next_required_num=1,
            field=[],
            hands={},
            players=[],
        )
        channel = types.SimpleNamespace(id=99, send=AsyncMock(return_value=new_msg))
        doubt_module.game_panels._active[(99, "party")] = old_msg
        try:
            with patch.object(doubt_module, "GameControlView", MagicMock()):
                with self.assertLogs("core.game.game.game_panels", level="DEBUG") as logs:
                    await cog.send_main_screen(channel, game)
        finally:
            doubt_module.game_panels._active.pop((99, "party"), None)
        self.assertTrue(any("deletion failed" in line for line in logs.output))
        self.assertIs(game.last_panel_msg, new_msg)


class MutedSyncLoggingTests(unittest.IsolatedAsyncioTestCase):
    """権限同期のチャンネル単位失敗（元 bare except）が debug ログになり集計されること。"""

    async def test_channel_failure_logs_debug_and_counts_failed(self):
        fake_cog = types.SimpleNamespace(
            embed_color=0xFFFFFF,
            get_or_create_muted_role=AsyncMock(return_value=(MagicMock(), None)),
        )
        view = muted_module.Muted.MuteSettingView(fake_cog)
        raw_callback = view.children[0].callback.callback
        channel = types.SimpleNamespace(
            set_permissions=AsyncMock(side_effect=RuntimeError("no perm"))
        )
        interaction = types.SimpleNamespace(
            response=types.SimpleNamespace(defer=AsyncMock()),
            guild=types.SimpleNamespace(channels=[channel], text_channels=[]),
            edit_original_response=AsyncMock(),
        )
        select = types.SimpleNamespace(values=["link"])
        with self.assertLogs("cogs.muted", level="DEBUG") as logs:
            await raw_callback(view, interaction, select)
        embed = interaction.edit_original_response.call_args.kwargs["embed"]
        self.assertIn("失敗: 1", embed.description)
        self.assertTrue(any("権限同期" in line for line in logs.output))


class _FakeGuessTable:
    def __init__(self, name):
        self._name = name
        self._op = None

    def select(self, *args, **kwargs):
        self._op = "select"
        return self

    def update(self, *args, **kwargs):
        self._op = "update"
        return self

    def insert(self, *args, **kwargs):
        self._op = "insert"
        return self

    def eq(self, *args, **kwargs):
        return self

    def execute(self):
        if self._name == "transaction_history":
            raise RuntimeError("history down")
        if self._op == "select":
            return types.SimpleNamespace(data=[{"balance": 100}])
        return types.SimpleNamespace(data=[{"balance": 150}])


class GuessHistoryLoggingTests(unittest.IsolatedAsyncioTestCase):
    """取引履歴の記録失敗が warning ログになり、残高反映の結果は返ること。"""

    async def test_history_failure_logs_warning_and_returns_result(self):
        cog = object.__new__(guess_module.Guess)
        fake_db = types.SimpleNamespace(table=lambda name: _FakeGuessTable(name))
        with patch.object(guess_module.config, "db_api", fake_db):
            with self.assertLogs("cogs.guess", level="WARNING") as logs:
                result = await cog._apply_delta("42", 50, True)
        self.assertEqual(result, (50, 150))
        self.assertTrue(any("取引履歴" in line for line in logs.output))


class ZetaBackupLoggingTests(unittest.TestCase):
    """壊れた保存ファイルの退避失敗が debug ログになること（本体の読み込み失敗は exception 済み）。"""

    def test_backup_failure_logs_debug_and_returns_empty(self):
        import tempfile
        from pathlib import Path

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "custom.json"
            path.write_text("{broken json", encoding="utf-8")
            store = zeta_module.CustomSituationStore(path)
            with patch("os.replace", side_effect=OSError("cannot move")):
                with self.assertLogs("cogs.zetamodoki", level="DEBUG") as logs:
                    data = store._root()
        self.assertEqual(data, {})
        self.assertTrue(any("退避" in line for line in logs.output))


class UnoEndGameLoggingTests(unittest.IsolatedAsyncioTestCase):
    """ゲーム終了時のパネル削除失敗が debug ログになること。"""

    async def test_panel_delete_failure_logs_debug(self):
        cog = object.__new__(uno_module.Uno)
        cog.games = {}
        cog.bot = types.SimpleNamespace(get_channel=lambda channel_id: None)
        msg = types.SimpleNamespace(delete=AsyncMock(side_effect=_http_exception()))
        game = types.SimpleNamespace(
            channel_id=1, active_view=None, active_panel_message=msg
        )
        with self.assertLogs("cogs.uno", level="DEBUG") as logs:
            await cog.end_game(game, "reason")
        self.assertTrue(any("パネル削除" in line for line in logs.output))


class LogViewerErrorLoggingTests(unittest.IsolatedAsyncioTestCase):
    """エラーハンドラ自身の通知送信失敗が debug ログになること。"""

    async def test_notify_failure_logs_debug(self):
        cog = object.__new__(log_viewer_module.LogViewer)
        ctx = types.SimpleNamespace(
            send=AsyncMock(side_effect=RuntimeError("cannot send"))
        )
        error = log_viewer_module.commands.CheckFailure("not allowed")
        with self.assertLogs("cogs.log_viewer", level="DEBUG") as logs:
            await cog.logs_error(ctx, error)
        self.assertTrue(any("権限エラーの通知" in line for line in logs.output))


class GlobalChatNotifyLoggingTests(unittest.IsolatedAsyncioTestCase):
    """DM通知と代替通知の失敗がどちらも debug ログになること。"""

    async def test_both_notification_failures_log_debug(self):
        cog = object.__new__(globalchat_module.GlobalChatCog)
        message = types.SimpleNamespace(
            author=types.SimpleNamespace(
                send=AsyncMock(side_effect=RuntimeError("dm closed"))
            ),
            add_reaction=AsyncMock(side_effect=RuntimeError("no reaction perm")),
            reply=AsyncMock(),
        )
        with self.assertLogs("cogs.globalchat", level="DEBUG") as logs:
            await cog.notify_sender(message, "text")
        self.assertTrue(any("DM通知" in line for line in logs.output))
        self.assertTrue(any("代替通知" in line for line in logs.output))


class SioVoiceRemoveLoggingTests(unittest.TestCase):
    """TTS 一時ファイルの削除失敗が debug ログになること。"""

    def test_remove_failure_logs_debug(self):
        with patch.object(voice_module.os, "unlink", side_effect=OSError("busy")):
            with self.assertLogs("cogs.sio_voice", level="DEBUG") as logs:
                voice_module.TTSCog._remove("/tmp/nonexistent.wav")
        self.assertTrue(any("一時ファイルの削除" in line for line in logs.output))


class PanelV2OnErrorLoggingTests(unittest.IsolatedAsyncioTestCase):
    """パネルのエラー通知そのものの送信失敗が debug ログになること。"""

    async def test_error_notification_failure_logs_debug(self):
        view = object.__new__(panel_v2_module.PanelLayoutView)
        interaction = types.SimpleNamespace(
            response=types.SimpleNamespace(is_done=lambda: True),
            followup=types.SimpleNamespace(
                send=AsyncMock(side_effect=_http_exception())
            ),
        )
        with self.assertLogs("core.support.panel_v2", level="DEBUG") as logs:
            await view.on_error(interaction, RuntimeError("boom"))
        self.assertTrue(any("エラー通知の送信" in line for line in logs.output))


class SioRecEchoCleanupLoggingTests(unittest.TestCase):
    """やまびこ後片付けの停止失敗が debug ログになること。"""

    def test_cleanup_failures_log_debug(self):
        cog = object.__new__(rec_module.RecordingCog)
        vc = types.SimpleNamespace(
            stop_listening=MagicMock(side_effect=RuntimeError("not listening")),
            stop=MagicMock(side_effect=RuntimeError("not playing")),
        )
        cog.echo_sessions = {
            7: {"vc": vc, "sink": types.SimpleNamespace(cleanup=lambda: None)}
        }
        cleanup = cog._echo_cleanup(7)
        with self.assertLogs("cogs.sio_rec", level="DEBUG") as logs:
            cleanup("test")
        self.assertTrue(any("受信停止" in line for line in logs.output))
        self.assertTrue(any("再生停止" in line for line in logs.output))


class NationErrorReplyLoggingTests(unittest.IsolatedAsyncioTestCase):
    """nation のエラー通知送信失敗が debug ログになること（元のエラーは log.error 済み）。"""

    async def test_reply_failure_logs_debug(self):
        cog = object.__new__(nation_module.NationCog)
        cog._reply = AsyncMock(side_effect=_http_exception())
        cog._embed = lambda *args, **kwargs: object()
        ctx = types.SimpleNamespace()
        error = nation_module.commands.CommandError("boom")
        with self.assertLogs("cogs.nation", level="DEBUG") as logs:
            await cog.cog_command_error(ctx, error)
        self.assertTrue(any("エラー通知の送信" in line for line in logs.output))


if __name__ == "__main__":
    unittest.main()
