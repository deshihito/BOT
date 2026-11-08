# -*- coding: utf-8 -*-
"""機能数再編 vc ルート拡張（37 → 44）の固定テスト。

- VOICE_ACTIONS_BY_GENRE に音楽6件＋グロチャ自動接続1件が追加され総数44になること
- dispatch_voice_action が新 value を音楽cog / GVCcog の既存 impl へ配線すること
- 音楽パネル本体（build_music_panel_layout）に立体音響の入口ボタンが増え、
  既存の自動再生トグル行が保たれること
Discord には接続しない（fake の interaction / cog で配線だけを見る）。
"""
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import discord  # noqa: E402

from core.vc.common import (  # noqa: E402
    GVC_ROOM_ACTIONS, GVC_ROOM_FORMS, VOICE_ACTIONS_BY_GENRE,
)
from core.vc.hub import MusicSearchModal, VoiceHub  # noqa: E402

NEW_MUSIC = [
    ("プレイリスト管理", "music_playlist"),
    ("立体音響設定", "music_spatial"),
    ("自動再生・再生履歴管理", "music_autoplay"),
    ("キュー表示", "music_queue"),
    ("楽曲検索・追加", "music_search"),
    ("音声ファイルID一覧", "music_files"),
]


class GenreListTest(unittest.TestCase):
    def test_total_is_44(self):
        total = sum(len(items) for items in VOICE_ACTIONS_BY_GENRE.values())
        self.assertEqual(total, 44)

    def test_music_genre_entries(self):
        self.assertEqual(
            VOICE_ACTIONS_BY_GENRE["music"],
            [("音楽操作パネル", "music_panel"), *NEW_MUSIC],
        )

    def test_gvc_auto_connect_registered(self):
        rooms = VOICE_ACTIONS_BY_GENRE["gvc_rooms"]
        self.assertIn(("グロチャ自動接続設定", "gvc_auto_connect"), rooms)
        # フォーム機構（ルーム名入力）経由で開くため FORMS / ACTIONS 両方に載る。
        self.assertIn("gvc_auto_connect", GVC_ROOM_FORMS)
        self.assertIn("gvc_auto_connect", GVC_ROOM_ACTIONS)
        title, fields = GVC_ROOM_FORMS["gvc_auto_connect"]
        self.assertEqual(title, "グロチャ自動接続設定")
        self.assertEqual([(f[0], f[3]) for f in fields], [("name", True)])


class _FakeResponse:
    def __init__(self):
        self.done = False
        self.modal = None
        self.send_modal = AsyncMock(side_effect=self._send_modal)

    def is_done(self):
        return self.done

    async def _send_modal(self, modal):
        self.done = True
        self.modal = modal

    async def defer(self, **kwargs):
        self.done = True

    async def send_message(self, content=None, **kwargs):
        self.done = True


class _FakeInteraction:
    def __init__(self, guild_id=1, user_id=10):
        self.guild = types.SimpleNamespace(id=guild_id, voice_client=None)
        self.guild_id = guild_id
        self.user = types.SimpleNamespace(id=user_id)
        self.channel = types.SimpleNamespace(id=55)
        self.response = _FakeResponse()
        self.followup = types.SimpleNamespace(send=AsyncMock())


def _hub(cogs):
    hub = VoiceHub.__new__(VoiceHub)
    hub.bot = types.SimpleNamespace(get_cog=lambda name: cogs.get(name))
    return hub


def _fake_music_cog():
    return types.SimpleNamespace(
        _playlist_library_impl=AsyncMock(),
        _spatial_impl=AsyncMock(),
        _autoplay_panel_impl=AsyncMock(),
        _queue_impl=AsyncMock(),
        _files_impl=AsyncMock(),
        _search_impl=AsyncMock(),
        _panel_impl=AsyncMock(),
    )


class DispatchTest(unittest.IsolatedAsyncioTestCase):
    async def _dispatch(self, hub, interaction, value, **kwargs):
        with patch("core.support.command_control.guard", AsyncMock(return_value=True)), \
                patch("core.vc.hub.action_usage.record_safely_in_background", lambda *a: None), \
                patch("core.vc.hub.usage_stats.record_action_safely", lambda *a: None):
            return await hub.dispatch_voice_action(interaction, value, **kwargs)

    async def test_music_entries_route_to_music_cog(self):
        music = _fake_music_cog()
        hub = _hub({"VoiceCog": music})
        cases = {
            "music_playlist": music._playlist_library_impl,
            "music_spatial": music._spatial_impl,
            "music_autoplay": music._autoplay_panel_impl,
            "music_queue": music._queue_impl,
            "music_files": music._files_impl,
        }
        for value, impl in cases.items():
            with self.subTest(value=value):
                impl.reset_mock()
                await self._dispatch(hub, _FakeInteraction(), value)
                impl.assert_awaited_once()

    async def test_music_queue_receives_interaction_not_responder(self):
        music = _fake_music_cog()
        hub = _hub({"VoiceCog": music})
        interaction = _FakeInteraction()
        await self._dispatch(hub, interaction, "music_queue")
        self.assertIs(music._queue_impl.await_args.args[0], interaction)

    async def test_music_search_opens_selective_search_modal(self):
        music = _fake_music_cog()
        hub = _hub({"VoiceCog": music})
        interaction = _FakeInteraction()
        await self._dispatch(hub, interaction, "music_search")
        modal = interaction.response.modal
        self.assertIsInstance(modal, MusicSearchModal)
        # モーダル送信でキーワードが選択式検索（_search_impl）へ渡ること。
        modal.keyword._value = "テスト曲"
        submit_interaction = _FakeInteraction()
        await modal.on_submit(submit_interaction)
        music._search_impl.assert_awaited_once()
        args = music._search_impl.await_args.args
        self.assertEqual(args[1], "テスト曲")

    async def test_gvc_auto_connect_routes_with_room_name(self):
        global_cog = types.SimpleNamespace(_text_chat_toggle_impl=AsyncMock())
        hub = _hub({"GlobalVCCog": global_cog})
        await self._dispatch(hub, _FakeInteraction(), "gvc_auto_connect", name="room1")
        global_cog._text_chat_toggle_impl.assert_awaited_once()
        args = global_cog._text_chat_toggle_impl.await_args.args
        self.assertEqual(args[1], "room1")


class _FakeResponder:
    def __init__(self, guild_id=123):
        self.guild = types.SimpleNamespace(id=guild_id)
        self.source = object()
        self.sent = []

    async def defer(self):
        pass

    async def send(self, content=None, **kwargs):
        self.sent.append({"content": content, **kwargs})
        return None


class ImplLandingTest(unittest.IsolatedAsyncioTestCase):
    async def test_playlist_library_impl_opens_library_view(self):
        from core.vc.music.playlists import PlaylistsMixin
        from core.vc.music.ui import PlaylistLibraryView

        class _Cog(PlaylistsMixin):
            pass

        responder = _FakeResponder()
        await _Cog()._playlist_library_impl(responder)
        self.assertEqual(len(responder.sent), 1)
        # Components V2: パネルは PanelLayoutView で包んで送る（実体は .panel）
        panel = responder.sent[0]["view"].panel
        self.assertIsInstance(panel, PlaylistLibraryView)
        self.assertTrue(responder.sent[0]["ephemeral"])
        self.assertIn("ライブラリ", panel.embed().title)

    async def test_autoplay_panel_impl_opens_history_view(self):
        from core.vc.music.autoplay import AutoplayMixin
        from core.vc.music.ui import AutoplayHistoryView, AutoplayToggleButton

        state = {"autoplay_enabled": True}

        class _Cog(AutoplayMixin):
            def get_state(self, guild_id):
                return state

        responder = _FakeResponder()
        await _Cog()._autoplay_panel_impl(responder)
        self.assertEqual(len(responder.sent), 1)
        # Components V2: パネルは PanelLayoutView で包んで送る（実体は .panel）
        view = responder.sent[0]["view"].panel
        self.assertIsInstance(view, AutoplayHistoryView)
        self.assertTrue(any(isinstance(c, AutoplayToggleButton) for c in view.children))
        self.assertIn("ON", view.embed().description)

    async def test_text_chat_toggle_impl_opens_view_for_owner(self):
        from core.vc.globalvc import rooms as rooms_mod
        from core.vc.globalvc.manage import ManageMixin
        from core.vc.globalvc.ui import _TextChatToggleView

        class _Cog(ManageMixin):
            pass

        rooms_mod.ROOMS["split-room"] = rooms_mod.RoomConfig(
            name="split-room", owner_id=42, owner_guild_id=1)
        try:
            responder = _FakeResponder()
            await _Cog()._text_chat_toggle_impl(responder, "split-room")
        finally:
            rooms_mod.ROOMS.pop("split-room", None)
        self.assertEqual(len(responder.sent), 1)
        view = responder.sent[0]["view"]
        self.assertIsInstance(view, _TextChatToggleView)
        # 切り替え権限の判定対象は「開いた人」ではなくルーム作成者。
        self.assertEqual(view.user_id, 42)
        self.assertIn("OFF", view.button.label)

    async def test_text_chat_toggle_impl_unknown_room(self):
        from core.vc.globalvc.manage import ManageMixin

        class _Cog(ManageMixin):
            pass

        responder = _FakeResponder()
        await _Cog()._text_chat_toggle_impl(responder, "no-such-room")
        self.assertEqual(len(responder.sent), 1)
        self.assertNotIn("view", responder.sent[0])


class MusicPanelSpatialButtonTest(unittest.TestCase):
    def _fake_cog(self):
        state = {
            "speed": 1.0, "volume": 0.5, "eq": "default", "custom_eq_filter": None,
            "loop_mode": "off", "shuffle_enabled": False, "is_paused": False,
            "current_track": None, "queue": None, "autoplay_enabled": False,
        }
        return types.SimpleNamespace(get_state=lambda guild_id: state)

    def test_layout_last_row_has_autoplay_and_spatial_buttons(self):
        from core.vc.music.ui import (
            AutoplayToggleButton, SpatialPanelButton, build_music_panel_layout,
        )

        layout = build_music_panel_layout(self._fake_cog(), 1, "panel text")
        last_row = layout.children[0].children[-1]
        self.assertIsInstance(last_row, discord.ui.ActionRow)
        self.assertIsInstance(last_row.children[0], AutoplayToggleButton)
        self.assertIsInstance(last_row.children[1], SpatialPanelButton)
        self.assertEqual(last_row.children[1].label, "立体音響設定")


if __name__ == "__main__":
    unittest.main()
