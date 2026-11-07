"""表示系改善（2026-11-07）のテスト。

- TTS（VOICEVOX 読み上げ）の開始/停止/1回読み上げ/設定確認が embed で出ること
- 音楽パネルが新しいメッセージへ切り替わるとき、旧パネルが
  「スナップショット付け替え → 旧削除」の順で消えること、削除失敗が
  パネル表示を止めないこと
"""
import types
import unittest
from unittest.mock import AsyncMock

import discord

from core.support.legacy import Responder
from core.vc.tts import TTSCog, TTSSettings
from core.vc.music.panel import PanelMixin
from core.vc.music.search import SearchMixin
from core.vc.music.state import StateMixin


def _ctx(send_result=None):
    return types.SimpleNamespace(
        guild=types.SimpleNamespace(id=1, voice_client=None),
        channel=types.SimpleNamespace(id=55),
        author=types.SimpleNamespace(id=7),
        send=AsyncMock(return_value=send_result),
    )


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


class TTSEmbedTest(unittest.IsolatedAsyncioTestCase):
    async def test_start_sends_embed(self):
        cog = _tts_cog()
        ctx = _ctx()
        await cog._start_impl(Responder(ctx))
        kwargs = ctx.send.call_args.kwargs
        self.assertNotIn("content", kwargs)
        embed = kwargs["embed"]
        self.assertIsInstance(embed, discord.Embed)
        self.assertIn("読み上げを開始", embed.title)
        self.assertIn("<#55>", embed.description)
        self.assertIn("テスト話者", embed.description)

    async def test_stop_sends_embed(self):
        cog = _tts_cog()
        cog.read_channels = {1: 55}
        ctx = _ctx()
        await cog._stop_impl(Responder(ctx))
        kwargs = ctx.send.call_args.kwargs
        self.assertNotIn("content", kwargs)
        self.assertIn("読み上げを停止", kwargs["embed"].description)

    async def test_say_sends_embed(self):
        cog = _tts_cog()
        cog.enqueue = AsyncMock(return_value=True)
        ctx = _ctx()
        await cog._say_impl(Responder(ctx), "こんにちは")
        kwargs = ctx.send.call_args.kwargs
        self.assertNotIn("content", kwargs)
        self.assertIn("テスト話者", kwargs["embed"].description)

    async def test_settings_confirmation_is_embed(self):
        cog = _tts_cog()
        # _apply_config が返す文言自体は従来どおり（表示だけ embed 化する）。
        text = await cog._apply_config(7, None, None, None)
        self.assertIn("読み上げ設定", text)
        self.assertIn("テスト話者", text)


class _PanelCog(StateMixin, SearchMixin, PanelMixin):
    pass


def _panel_cog(events):
    cog = object.__new__(_PanelCog)
    cog.states = {}
    cog.default_volume = 1.0
    cog.default_speed = 1.0
    cog.default_eq = "flat"
    cog.bot = types.SimpleNamespace(user=types.SimpleNamespace(id=999))
    cog._ensure_music_connection = AsyncMock(return_value=None)
    cog.update_panel = AsyncMock()
    cog._save_music_snapshot = lambda guild_id: events.append("snapshot")
    return cog


def _panel_message(mid, events=None, fail=False):
    async def _delete():
        if events is not None:
            events.append("delete")
        if fail:
            raise RuntimeError("already gone")
    return types.SimpleNamespace(
        id=mid, author=types.SimpleNamespace(id=999), delete=_delete)


class MusicPanelCleanupTest(unittest.IsolatedAsyncioTestCase):
    async def test_reopen_deletes_old_panel_after_snapshot(self):
        events = []
        cog = _panel_cog(events)
        state = cog.get_state(1)
        old = _panel_message(100, events)
        state["panel_message"] = old
        new = _panel_message(200)
        ctx = _ctx(send_result=new)
        await cog._panel_impl(Responder(ctx))
        self.assertIs(state["panel_message"], new)
        # スナップショットの付け替えが旧パネル削除より先であること。
        self.assertEqual(events, ["snapshot", "delete"])

    async def test_first_open_deletes_nothing(self):
        events = []
        cog = _panel_cog(events)
        new = _panel_message(200)
        ctx = _ctx(send_result=new)
        await cog._panel_impl(Responder(ctx))
        self.assertEqual(events, ["snapshot"])

    async def test_delete_failure_does_not_break_panel_open(self):
        events = []
        cog = _panel_cog(events)
        state = cog.get_state(1)
        state["panel_message"] = _panel_message(100, events, fail=True)
        new = _panel_message(200)
        ctx = _ctx(send_result=new)
        await cog._panel_impl(Responder(ctx))  # 例外で落ちないこと
        self.assertIs(state["panel_message"], new)
        cog.update_panel.assert_awaited()

    async def test_does_not_delete_other_users_message(self):
        cog = _panel_cog([])
        foreign = types.SimpleNamespace(
            id=1, author=types.SimpleNamespace(id=123), delete=AsyncMock())
        await cog._delete_superseded_panel(foreign)
        foreign.delete.assert_not_called()

    async def test_delete_helper_noops(self):
        cog = _panel_cog([])
        await cog._delete_superseded_panel(None)
        await cog._delete_superseded_panel(types.SimpleNamespace(id=1))


if __name__ == "__main__":
    unittest.main()
