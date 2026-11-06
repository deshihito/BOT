# -*- coding: utf-8 -*-
"""導線最適化 M8（MIQ導線の純化）の固定テスト。"""
import unittest


class MiqPurificationTest(unittest.TestCase):
    def test_miq_genre_absorbed_and_help_action_gone(self):
        from cogs.general import GENERAL_ACTIONS, GENERAL_GENRES
        from core import action_registry

        self.assertNotIn("miq", GENERAL_GENRES)
        self.assertNotIn("miq", GENERAL_ACTIONS)
        custom_values = [v for _label, v in GENERAL_ACTIONS["custom"]]
        self.assertIn("miq_settings", custom_values)
        registry = action_registry.default_registry()
        self.assertIsNone(registry.get("general:miq_help"))
        spec = registry.get("general:miq_settings")
        self.assertEqual(spec.genre, "custom")

    def test_genre_alias_for_saved_shortcuts(self):
        from cogs.general import GENERAL_GENRE_ALIASES

        self.assertEqual(GENERAL_GENRE_ALIASES["miq"], "custom")

    def test_settings_embed_explains_creation(self):
        import types

        from core.general.miq.miq_ui import MiqSettingsView

        view = MiqSettingsView(types.SimpleNamespace(), 123)
        embed = view.embed()
        self.assertIn("引用画像にする", embed.description)
        self.assertIn("@BOT miq", embed.description)


if __name__ == "__main__":
    unittest.main()
