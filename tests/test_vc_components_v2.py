# -*- coding: utf-8 -*-
"""VC まわりの Components V2 化の構成テスト（Discord には接続しない）。

- 埋め込み返信は as_embed_v2（EmbedLayoutView）で送られる
- パネル系ビューは PanelLayoutView で包める（embed() を持つ）
- グロチャ切替ビューはネイティブ LayoutView
"""

import os
import sys
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

for _name, _value in {'BOT_API_BASE_URL': 'http://127.0.0.1:8787', 'BOT_API_KEY': 'dummy-key'}.items():
    os.environ.setdefault(_name, _value)

import discord  # noqa: E402


def walk(item):
    yield item
    for child in getattr(item, "children", None) or []:
        yield from walk(child)


def all_items(view):
    out = []
    for top in view.children:
        out.extend(walk(top))
    return out


class EmbedV2Test(unittest.TestCase):
    def test_we_embed_becomes_layout_view_with_text(self):
        from core.support.embeds import we
        from core.support.panel_v2 import as_embed_v2

        view = as_embed_v2(we("テスト本文です"))
        self.assertIsInstance(view, discord.ui.LayoutView)
        texts = [i.content for i in all_items(view) if isinstance(i, discord.ui.TextDisplay)]
        self.assertTrue(any("テスト本文です" in t for t in texts))

    def test_attachment_image_becomes_media_gallery(self):
        from core.support.panel_v2 import as_embed_v2

        embed = discord.Embed(title="メンバー")
        embed.set_image(url="attachment://gvc_members.png")
        view = as_embed_v2(embed)
        galleries = [i for i in all_items(view) if isinstance(i, discord.ui.MediaGallery)]
        self.assertEqual(len(galleries), 1)
        urls = [entry.media.url for entry in galleries[0].items]
        self.assertEqual(urls, ["attachment://gvc_members.png"])


class PanelWrapTest(unittest.TestCase):
    def test_search_view_wraps(self):
        from core.support.panel_v2 import PanelLayoutView, wrap_panel_view
        from core.vc.music.search import SearchMixin

        embed = discord.Embed(title="検索結果")
        view = SearchMixin.SearchView(
            types.SimpleNamespace(), 1, types.SimpleNamespace(),
            [{"title": "曲", "url": "https://example.com"}], embed)
        wrapper = wrap_panel_view(view)
        self.assertIsInstance(wrapper, PanelLayoutView)
        self.assertIs(view._v2, wrapper)
        self.assertIs(view.embed(), embed)

    def test_playlist_library_view_wraps(self):
        from core.support.panel_v2 import PanelLayoutView, as_panel_v2
        from core.vc.music.ui import PlaylistLibraryView

        view = PlaylistLibraryView(types.SimpleNamespace(), discord.Embed(title="ライブラリ"))
        wrapper = as_panel_v2(view)
        self.assertIsInstance(wrapper, PanelLayoutView)
        self.assertIs(wrapper.panel, view)

    def test_spatial_view_embed_and_wrap(self):
        from core.support.panel_v2 import PanelLayoutView, wrap_panel_view
        from core.vc.music.spatial import SpatialControlView

        cog = types.SimpleNamespace(get_state=lambda guild_id: {})
        view = SpatialControlView(cog, 123)
        embed = view.embed()
        self.assertIn("立体音響", embed.title)
        wrapper = wrap_panel_view(view)
        self.assertIsInstance(wrapper, PanelLayoutView)


class TextChatToggleViewTest(unittest.TestCase):
    def test_is_native_layout_view_with_container(self):
        from core.vc.globalvc.ui import _TextChatToggleView

        embed = discord.Embed(title="ルーム作成", color=0x2ECC71)
        view = _TextChatToggleView(types.SimpleNamespace(), "r", user_id=42, embed=embed)
        self.assertIsInstance(view, discord.ui.LayoutView)
        containers = [i for i in view.children if isinstance(i, discord.ui.Container)]
        self.assertEqual(len(containers), 1)
        buttons = [i for i in all_items(view) if isinstance(i, discord.ui.Button)]
        self.assertEqual(len(buttons), 1)
        self.assertIn("グロチャ自動接続", buttons[0].label)


if __name__ == "__main__":
    unittest.main()
