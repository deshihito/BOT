"""一時ログの15秒自動削除と、5大ルートパネルの失効時削除のテスト。

- VC参加/退出・読み上げ開始/停止/1回読み上げのステータスログは
  delete_after=15 で送られること（チャンネルに残り続けない）。
- Responder が delete_after を ctx / interaction の両経路へ渡すこと。
- 5大ルートパネル（delete_message_on_timeout=True を立てたパネル）は
  PanelLayoutView のタイムアウト時にメッセージごと消えること。
  フラグのないパネルは従来どおり消えないこと。
"""
import types
import unittest
from unittest.mock import AsyncMock

import discord

from core.support.legacy import TRANSIENT_LOG_DELETE_AFTER_SECONDS, Responder
from core.support.panel_v2 import (
    PanelLayoutView, as_panel_v2, edit_panel_v2, track_panel_from_interaction)
from core.vc.tts import TTSCog
from core.vc.music.connection import ConnectionMixin


def _ctx(send_result=None, **extra):
    base = dict(
        guild=types.SimpleNamespace(id=1, voice_client=None),
        channel=types.SimpleNamespace(id=55),
        author=types.SimpleNamespace(id=7),
        send=AsyncMock(return_value=send_result),
    )
    base.update(extra)
    return types.SimpleNamespace(**base)


def _tts_cog():
    cog = object.__new__(TTSCog)
    cog.settings = {}
    cog.read_channels = {}
    cog.queues = {}
    cog.workers = {}
    cog._speakers = ["話者A", "話者B", "話者C", "テスト話者"]
    cog.voice_sessions = types.SimpleNamespace(release=AsyncMock())
    cog._ensure_connection = AsyncMock(return_value=None)
    return cog


class TransientLogDeleteAfterTest(unittest.IsolatedAsyncioTestCase):
    async def test_tts_start_stop_say_use_delete_after_15(self):
        self.assertEqual(TRANSIENT_LOG_DELETE_AFTER_SECONDS, 15)
        cog = _tts_cog()
        ctx = _ctx()
        await cog._start_impl(Responder(ctx))
        self.assertEqual(ctx.send.call_args.kwargs["delete_after"], 15)

        cog = _tts_cog()
        cog.read_channels = {1: 55}
        ctx = _ctx()
        await cog._stop_impl(Responder(ctx))
        self.assertEqual(ctx.send.call_args.kwargs["delete_after"], 15)

        cog = _tts_cog()
        cog.enqueue = AsyncMock(return_value=True)
        ctx = _ctx()
        await cog._say_impl(Responder(ctx), "こんにちは")
        self.assertEqual(ctx.send.call_args.kwargs["delete_after"], 15)

    async def test_vc_join_and_leave_use_delete_after_15(self):
        cog = object.__new__(ConnectionMixin)
        cog._acquire_music = AsyncMock()
        author = types.SimpleNamespace(
            id=7, voice=types.SimpleNamespace(
                channel=types.SimpleNamespace(name="VC1")))
        ctx = _ctx(author=author)
        await cog._join_impl(Responder(ctx))
        self.assertEqual(ctx.send.call_args.kwargs["delete_after"], 15)

        cog = object.__new__(ConnectionMixin)
        session = types.SimpleNamespace(feature="music")
        cog.voice_sessions = types.SimpleNamespace(
            get=lambda guild_id: session,
            can_leave=lambda s, u: True,
            release=AsyncMock(),
        )
        ctx = _ctx()
        await cog._leave_impl(Responder(ctx))
        self.assertEqual(ctx.send.call_args.kwargs["delete_after"], 15)

    async def test_responder_passes_delete_after_to_ctx(self):
        source = types.SimpleNamespace(send=AsyncMock())
        await Responder(source).send("ログ", delete_after=15)
        source.send.assert_awaited_once_with(content="ログ", delete_after=15)

    async def test_responder_passes_delete_after_to_followup(self):
        followup = types.SimpleNamespace(send=AsyncMock())
        response = types.SimpleNamespace(is_done=lambda: True)
        source = types.SimpleNamespace(response=response, followup=followup)
        await Responder(source).send("ログ", delete_after=15)
        followup.send.assert_awaited_once_with(
            content="ログ", ephemeral=False, delete_after=15)

    async def test_responder_omits_delete_after_by_default(self):
        source = types.SimpleNamespace(send=AsyncMock())
        await Responder(source).send("通常")
        source.send.assert_awaited_once_with(content="通常")


class _FlaggedPanel(discord.ui.View):
    delete_message_on_timeout = True

    def __init__(self):
        super().__init__(timeout=600)

    def embed(self):
        return discord.Embed(title="ルートパネル")


class _PlainPanel(discord.ui.View):
    def __init__(self):
        super().__init__(timeout=600)

    def embed(self):
        return discord.Embed(title="通常パネル")


def _message():
    return types.SimpleNamespace(delete=AsyncMock())


class RootPanelTimeoutDeleteTest(unittest.IsolatedAsyncioTestCase):
    async def test_flagged_panel_message_deleted_on_timeout(self):
        wrapper = as_panel_v2(_FlaggedPanel())
        message = _message()
        wrapper.track_message(message)
        await wrapper.on_timeout()
        message.delete.assert_awaited_once()

    async def test_plain_panel_not_deleted_on_timeout(self):
        wrapper = as_panel_v2(_PlainPanel())
        message = _message()
        wrapper.track_message(message)
        await wrapper.on_timeout()
        message.delete.assert_not_called()

    async def test_flagged_panel_without_message_is_noop(self):
        wrapper = as_panel_v2(_FlaggedPanel())
        await wrapper.on_timeout()  # 例外にならないこと

    async def test_interaction_check_tracks_message(self):
        wrapper = as_panel_v2(_FlaggedPanel())
        message = _message()
        interaction = types.SimpleNamespace(
            message=message, user=types.SimpleNamespace(id=7))
        await wrapper.interaction_check(interaction)
        self.assertIs(wrapper._tracked_message, message)

    async def test_edit_panel_v2_tracks_message(self):
        wrapper = as_panel_v2(_FlaggedPanel())
        message = _message()
        interaction = types.SimpleNamespace(
            message=message,
            response=types.SimpleNamespace(is_done=lambda: True),
            edit_original_response=AsyncMock(),
        )
        await edit_panel_v2(interaction, wrapper)
        self.assertIs(wrapper._tracked_message, message)

    async def test_track_from_interaction_without_original_response_is_noop(self):
        # CI の /help テストのように original_response を持たない
        # interaction でも、追跡に失敗して表示が壊れないこと。
        wrapper = as_panel_v2(_FlaggedPanel())
        interaction = types.SimpleNamespace()
        await track_panel_from_interaction(wrapper, interaction)
        self.assertIsNone(wrapper._tracked_message)

    async def test_track_from_interaction_stores_original_response(self):
        wrapper = as_panel_v2(_FlaggedPanel())
        message = _message()
        interaction = types.SimpleNamespace(
            original_response=AsyncMock(return_value=message))
        await track_panel_from_interaction(wrapper, interaction)
        self.assertIs(wrapper._tracked_message, message)

    async def test_root_panels_carry_the_flag(self):
        from core.general.panel import GeneralPanel
        from core.support.panel import SupportPanelView
        from core.vc.hub import VoicePanelView
        from core.game.hub.cog import GameDetailView, GameHubView
        from core.help.help.cog import BackView, CommandView, HelpView

        for cls in (GeneralPanel, SupportPanelView, VoicePanelView,
                    GameHubView, GameDetailView, HelpView, BackView, CommandView):
            self.assertTrue(
                getattr(cls, "delete_message_on_timeout", False), cls.__name__)


if __name__ == "__main__":
    unittest.main()
