"""表示モダン化 §4.2-7: 音楽パネルのネイティブ V2 化（Section＋Thumbnail）。

サムネイルURLがある場合だけ Section＋Thumbnail＋Separator 構成になり、
操作部品（ActionRow 群）は従来と同数・同種が保たれること。
"""
import types
import unittest
from unittest.mock import AsyncMock, patch

import discord

from core.vc.music import panel as music_panel
from core.vc.music import playback as music_playback
from core.vc.music import search as music_search
from core.vc.music.panel import PanelMixin
from core.vc.music.search import SearchMixin
from core.vc.music.spatial import PythonSpatialAudioSource, SpatialControlView
from core.vc.music.ui import build_music_panel_layout


def fake_cog():
    state = {
        "speed": 1.0, "volume": 0.5, "eq": "default", "custom_eq_filter": None,
        "loop_mode": "off", "shuffle_enabled": False, "is_paused": False,
        "current_track": None, "queue": None,
    }
    return types.SimpleNamespace(get_state=lambda guild_id: state)


def container_of(layout):
    assert len(layout.children) == 1
    container = layout.children[0]
    assert isinstance(container, discord.ui.Container)
    return container


def structure_signature(layout):
    """ActionRow 内の部品種別とラベルの並び（custom_id は自動生成のため対象外）。"""
    signature = []
    for item in container_of(layout).children:
        if isinstance(item, discord.ui.ActionRow):
            signature.append(tuple(
                (type(child).__name__, getattr(child, "label", None))
                for child in item.children
            ))
    return signature


class MusicPanelNativeV2Test(unittest.TestCase):
    def test_without_thumbnail_keeps_text_display_layout(self):
        layout = build_music_panel_layout(fake_cog(), 1, "panel text")
        children = container_of(layout).children
        self.assertIsInstance(children[0], discord.ui.TextDisplay)
        self.assertFalse(any(isinstance(c, discord.ui.Section) for c in children))

    def test_with_thumbnail_uses_section_thumbnail_separator(self):
        url = "https://i.ytimg.com/vi/example/default.jpg"
        layout = build_music_panel_layout(fake_cog(), 1, "panel text", thumbnail_url=url)
        children = container_of(layout).children
        section = children[0]
        self.assertIsInstance(section, discord.ui.Section)
        self.assertIsInstance(section.accessory, discord.ui.Thumbnail)
        self.assertEqual(section.accessory.media.url, url)
        self.assertIsInstance(section.children[0], discord.ui.TextDisplay)
        self.assertIn("panel text", section.children[0].content)
        self.assertIsInstance(children[1], discord.ui.Separator)

    def test_controls_are_identical_with_and_without_thumbnail(self):
        plain = build_music_panel_layout(fake_cog(), 1, "panel text")
        rich = build_music_panel_layout(
            fake_cog(), 1, "panel text", thumbnail_url="https://example.com/a.jpg")
        self.assertEqual(structure_signature(plain), structure_signature(rich))
        self.assertTrue(structure_signature(plain))

    def test_non_http_thumbnail_is_ignored(self):
        layout = build_music_panel_layout(
            fake_cog(), 1, "panel text", thumbnail_url="attachment://cover.png")
        children = container_of(layout).children
        self.assertIsInstance(children[0], discord.ui.TextDisplay)


class MusicPanelNameResolutionTest(unittest.TestCase):
    """分割先モジュールの名前空間で、他モジュール定義の名前が解決できること。

    Mixin のメソッドは定義されたモジュールのグローバルで名前解決するため、
    core/vc/music/entry.py 側の import では届かない（2026-11-06 の NameError 再発防止）。
    """

    def test_search_and_panel_resolve_build_music_panel_layout(self):
        self.assertIs(music_search.build_music_panel_layout, build_music_panel_layout)
        self.assertIs(music_panel.build_music_panel_layout, build_music_panel_layout)

    def test_panel_resolves_spatial_control_view(self):
        self.assertIs(music_panel.SpatialControlView, SpatialControlView)

    def test_playback_resolves_python_spatial_audio_source(self):
        self.assertIs(music_playback.PythonSpatialAudioSource, PythonSpatialAudioSource)


def _panel_state(**overrides):
    state = {
        "speed": 1.0, "volume": 0.5, "eq": "default", "custom_eq_filter": None,
        "loop_mode": "off", "shuffle_enabled": False, "is_paused": False,
        "current_track": None, "queue": None,
        "panel_message": None, "current_thumbnail_url": None,
    }
    state.update(overrides)
    return state


class _FakeResponder:
    def __init__(self, guild_id=123):
        self.guild = types.SimpleNamespace(id=guild_id)
        self.source = object()
        self.sent = []
        self.message = types.SimpleNamespace(id=999)

    async def defer(self):
        pass

    async def send(self, **kwargs):
        self.sent.append(kwargs)
        return self.message


class MusicPanelImplDriveTest(unittest.IsolatedAsyncioTestCase):
    async def test_panel_impl_sends_layout_view(self):
        state = _panel_state()

        class _Cog(SearchMixin):
            async def _ensure_music_connection(self, r):
                return None

            def get_state(self, guild_id):
                return state

            async def update_panel(self, guild_id):
                self.updated = True

            def _save_music_snapshot(self, guild_id):
                self.saved = True

        cog = _Cog()
        responder = _FakeResponder()
        await cog._panel_impl(responder)

        self.assertEqual(len(responder.sent), 1)
        self.assertIsInstance(responder.sent[0]["view"], discord.ui.LayoutView)
        self.assertIs(state["panel_message"], responder.message)
        self.assertTrue(cog.updated)
        self.assertTrue(cog.saved)

    async def test_update_panel_edits_with_layout_view(self):
        state = _panel_state(
            panel_message=types.SimpleNamespace(id=555),
            queue=types.SimpleNamespace(qsize=lambda: 0),
        )

        class _Cog(PanelMixin):
            def get_state(self, guild_id):
                return state

        edit = AsyncMock()
        with patch.object(music_panel, "edit_message_v2", edit):
            await _Cog().update_panel(123)

        edit.assert_awaited_once()
        self.assertIs(edit.await_args.args[0], state["panel_message"])
        self.assertIsInstance(edit.await_args.args[1], discord.ui.LayoutView)

    async def test_spatial_panel_sends_spatial_control_view(self):
        state = _panel_state()

        class _Cog(PanelMixin):
            def get_state(self, guild_id):
                return state

        responder = _FakeResponder()
        await _Cog()._spatial_panel(responder, 123)

        self.assertEqual(len(responder.sent), 1)
        # sweep2 VC-16: 立体音響パネルは V2 ラッパー経由で送信される。
        sent_view = responder.sent[0]["view"]
        inner = getattr(sent_view, "panel", sent_view)
        self.assertIsInstance(inner, SpatialControlView)


class MusicPanelHeadingEmojiTest(unittest.IsolatedAsyncioTestCase):
    """見出しの {MUSIC} がアプリ絵文字 markup に展開されること。

    ロールアウト時に先頭セグメントだけ f 接頭辞が付かず、波括弧ごと
    表示されるバグがあった (2026-11-06 スクショ報告)。
    """

    async def test_heading_renders_music_emoji_markup(self):
        state = _panel_state(
            panel_message=types.SimpleNamespace(id=555),
            queue=types.SimpleNamespace(qsize=lambda: 0),
        )

        class _Cog(PanelMixin):
            def get_state(self, guild_id):
                return state

        edit = AsyncMock()
        with patch.object(music_panel, "edit_message_v2", edit):
            await _Cog().update_panel(123)

        layout = edit.await_args.args[1]
        container = container_of(layout)
        header = container.children[0]
        self.assertIsInstance(header, discord.ui.TextDisplay)
        self.assertTrue(
            header.content.startswith(
                "# <:music:1561710964238450809> ボイスコントロールパネル"),
            header.content[:60],
        )
        self.assertNotIn("{MUSIC}", header.content)


class VoiceControlViewEmojiTest(unittest.TestCase):
    """コンポーネントの label / placeholder にアプリ絵文字 markup を埋めないこと。

    Discord は label / placeholder 内のカスタム絵文字 markup を描画せず
    生文字列で表示するため、絵文字は emoji= 引数側で持たせる。
    """

    def _view(self):
        from core.vc.music.ui import VoiceControlView
        return VoiceControlView(fake_cog(), 1)

    def test_no_markup_in_any_label_or_placeholder(self):
        for child in self._view().children:
            label = getattr(child, "label", None)
            if isinstance(label, str):
                self.assertNotIn("<:", label)
            placeholder = getattr(child, "placeholder", None)
            if isinstance(placeholder, str):
                self.assertNotIn("<:", placeholder)

    def test_search_and_library_buttons_use_emoji_arg(self):
        by_emoji = {}
        for child in self._view().children:
            emoji = getattr(child, "emoji", None)
            if emoji is not None:
                by_emoji[emoji.name] = child
        for name in ("loupe", "book"):
            self.assertIn(name, by_emoji)
            self.assertIn(by_emoji[name].label, ("", None))

    def test_volume_select_placeholder_is_text_only(self):
        from core.vc.music.ui import VoiceControlView
        select = next(
            child for child in self._view().children
            if isinstance(child, VoiceControlView.VolumeSelect))
        self.assertEqual(select.placeholder, "音量を選択")

    def test_layout_inserts_volume_caption_before_volume_row(self):
        from core.support.emojis import VOL
        from core.vc.music.ui import VoiceControlView
        layout = build_music_panel_layout(fake_cog(), 1, "panel text")
        children = container_of(layout).children
        caption = f"{VOL} 音量変更 (現在: 50%)"
        idx = next(
            i for i, child in enumerate(children)
            if isinstance(child, discord.ui.TextDisplay) and child.content == caption)
        row = children[idx + 1]
        self.assertIsInstance(row, discord.ui.ActionRow)
        self.assertTrue(any(
            isinstance(item, VoiceControlView.VolumeSelect) for item in row.children))


if __name__ == "__main__":
    unittest.main()
