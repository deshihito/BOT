# -*- coding: utf-8 -*-
"""導線最適化 小変更群（S1/S2/S5/S8/S10/S11）の固定テスト。"""
import os
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def read(*parts):
    with open(os.path.join(ROOT, *parts), encoding="utf-8") as fh:
        return fh.read()


class VoiceGuidanceTest(unittest.TestCase):
    """S1: 存在しない /voice への操作案内がユーザー向け文に残っていないこと。"""

    def test_no_voice_panel_guidance(self):
        for path in (
            ("cogs", "sio_rec.py"),
            ("cogs", "sio_voicechanger.py"),
            ("cogs", "sio_karaoke.py"),
            ("cogs", "sio_transcription.py"),
            ("core", "vc", "hub.py"),
        ):
            src = read(*path)
            self.assertNotIn("/voice のパネルから", src, path)
            self.assertNotIn("`/voice` のパネルから", src, path)


class GameHubEmbedTest(unittest.TestCase):
    """S2: /game 初画面はタイトル＋1行だけで、一覧フィールドを持たないこと。"""

    def test_hub_embed_has_no_fields(self):
        from cogs.game import hub_embed

        embed = hub_embed()
        self.assertEqual(embed.title, "パーティーゲーム")
        self.assertEqual(embed.fields, [])
        self.assertNotIn("\n", embed.description)


class QuickDeadEndTest(unittest.TestCase):
    """S5: help:overview が /quick の palette 対象から外れていること。"""

    def test_help_overview_not_in_palette(self):
        from core.action_registry import build_help_actions

        (spec,) = build_help_actions()
        self.assertNotIn("palette", spec.surfaces)
        self.assertIn("shortcut", spec.surfaces)


class GameGenreDescriptionTest(unittest.TestCase):
    """S8: /game ジャンル説明は他ルート方針どおり自明なものは空にすること。"""

    def test_genre_descriptions_empty(self):
        from cogs.game import GAME_GENRES

        for key, (_label, description) in GAME_GENRES.items():
            self.assertEqual(description, "", key)


class RootPanelTimeoutTest(unittest.TestCase):
    """S10: ルートパネルの timeout は 600 に統一されていること。"""

    def test_timeouts_unified(self):
        self.assertIn("timeout=600", read("core", "general", "panel.py"))
        self.assertIn("timeout=600", read("core", "support", "panel.py"))
        self.assertIn("timeout=600", read("core", "vc", "hub.py"))


class ContextMenuNameTest(unittest.TestCase):
    """S11: コンテキストメニュー名が日本語化されていること。"""

    def test_japanese_names(self):
        src = read("cogs", "general.py")
        self.assertIn('name="引用画像にする"', src)
        self.assertIn('name="meme画像にする"', src)
        self.assertNotIn("Make it a Quote", src)
        self.assertNotIn("Make it a Meme", src)


if __name__ == "__main__":
    unittest.main()
