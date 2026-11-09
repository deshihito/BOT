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
        self.assertEqual(total, 71)  # RTA 個別ボード8件を統合ボード1件に集約（76−8＋1）、その後 即抜けRTAボード追加で +1、おみくじ（新ジャンル「占い」）追加で +1

    def test_support_single_action_genres_absorbed(self):
        from cogs.support import SUPPORT_ACTIONS_BY_GENRE, SUPPORT_GENRES

        self.assertNotIn("language", SUPPORT_GENRES)
        self.assertNotIn("event", SUPPORT_GENRES)
        # サーバーアシスト再編: assist ジャンルも吸収し、各機能が既存
        # ジャンルの一級アクションになった（旧ハブ1件→各機能23件）。
        self.assertNotIn("assist", SUPPORT_GENRES)
        automation = [value for _label, value in SUPPORT_ACTIONS_BY_GENRE["automation"]]
        moderation = [value for _label, value in SUPPORT_ACTIONS_BY_GENRE["moderation"]]
        self.assertIn("language", automation)
        self.assertIn("giveaway", moderation)
        self.assertIn("assist_welcome", automation)
        self.assertIn("assist_automod", moderation)
        total = sum(len(items) for items in SUPPORT_ACTIONS_BY_GENRE.values())
        # 機能数再編: 55件 −旧 bumprta_* 4件 −旧 sns_notify 1件 ＋分割で増えた31件 = 81件。Luna AI 追加で 82件、人物分析（新ジャンル analysis）追加で 83件、サーバー分析追加で 84件。
        self.assertEqual(total, 84)

    def test_genre_aliases_cover_absorbed_genres(self):
        from cogs.general import GENERAL_GENRE_ALIASES
        from cogs.support import SUPPORT_GENRE_ALIASES

        self.assertEqual(GENERAL_GENRE_ALIASES["translation"], "custom")
        self.assertEqual(SUPPORT_GENRE_ALIASES["language"], "automation")
        self.assertEqual(SUPPORT_GENRE_ALIASES["event"], "moderation")
        self.assertEqual(SUPPORT_GENRE_ALIASES["assist"], "automation")


class VoiceTriggerLabelTest(unittest.TestCase):
    """S6→ラウンド2: /support の voice_trigger ラベルがサーバー設定であることを示すこと。"""

    def test_label_matches_panel(self):
        from core.general.action_registry import build_support_actions
        from cogs.support import SUPPORT_ACTIONS, SUPPORT_ACTIONS_BY_GENRE, SUPPORT_GENRES

        specs = build_support_actions(SUPPORT_ACTIONS, SUPPORT_ACTIONS_BY_GENRE, SUPPORT_GENRES)
        spec = next(s for s in specs if s.value == "voice_trigger")
        self.assertEqual(spec.label, "音声トリガーのサーバー設定")
        self.assertEqual(spec.id, "support:voice_trigger")


if __name__ == "__main__":
    unittest.main()
