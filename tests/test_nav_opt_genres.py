# -*- coding: utf-8 -*-
"""導線最適化 S6/S7（ラベル是正・1件ジャンル吸収）の固定テスト。"""
import unittest


class GenreAbsorptionTest(unittest.TestCase):
    def test_general_translation_absorbed_into_custom(self):
        from cogs.general import GENERAL_ACTIONS, GENERAL_GENRES

        self.assertNotIn("translation", GENERAL_GENRES)
        self.assertNotIn("translation", GENERAL_ACTIONS)
        values = [value for _label, value in GENERAL_ACTIONS["custom"]]
        self.assertIn("translation_settings", values)
        total = sum(len(items) for items in GENERAL_ACTIONS.values())
        self.assertEqual(total, 46)  # money_panel 追加後の総数。機能は減らない

    def test_support_single_action_genres_absorbed(self):
        from cogs.support import SUPPORT_ACTIONS_BY_GENRE, SUPPORT_GENRES

        self.assertNotIn("language", SUPPORT_GENRES)
        self.assertNotIn("event", SUPPORT_GENRES)
        automation = [value for _label, value in SUPPORT_ACTIONS_BY_GENRE["automation"]]
        moderation = [value for _label, value in SUPPORT_ACTIONS_BY_GENRE["moderation"]]
        self.assertIn("language", automation)
        self.assertIn("giveaway", moderation)
        total = sum(len(items) for items in SUPPORT_ACTIONS_BY_GENRE.values())
        self.assertEqual(total, 30)  # 機能は減らない

    def test_genre_aliases_cover_absorbed_genres(self):
        from cogs.general import GENERAL_GENRE_ALIASES
        from cogs.support import SUPPORT_GENRE_ALIASES

        self.assertEqual(GENERAL_GENRE_ALIASES["translation"], "custom")
        self.assertEqual(SUPPORT_GENRE_ALIASES["language"], "automation")
        self.assertEqual(SUPPORT_GENRE_ALIASES["event"], "moderation")


class VoiceTriggerLabelTest(unittest.TestCase):
    """S6→ラウンド2: /support の voice_trigger ラベルがサーバー設定であることを示すこと。"""

    def test_label_matches_panel(self):
        from core.action_registry import build_support_actions
        from cogs.support import SUPPORT_ACTIONS, SUPPORT_ACTIONS_BY_GENRE, SUPPORT_GENRES

        specs = build_support_actions(SUPPORT_ACTIONS, SUPPORT_ACTIONS_BY_GENRE, SUPPORT_GENRES)
        spec = next(s for s in specs if s.value == "voice_trigger")
        self.assertEqual(spec.label, "音声トリガーのサーバー設定")
        self.assertEqual(spec.id, "support:voice_trigger")


if __name__ == "__main__":
    unittest.main()
