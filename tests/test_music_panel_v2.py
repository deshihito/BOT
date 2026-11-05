"""表示モダン化 §4.2-7: 音楽パネルのネイティブ V2 化（Section＋Thumbnail）。

サムネイルURLがある場合だけ Section＋Thumbnail＋Separator 構成になり、
操作部品（ActionRow 群）は従来と同数・同種が保たれること。
"""
import types
import unittest

import discord

from core.music.ui import build_music_panel_layout


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


if __name__ == "__main__":
    unittest.main()
