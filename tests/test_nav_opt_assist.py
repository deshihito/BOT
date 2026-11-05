# -*- coding: utf-8 -*-
"""導線最適化 M2（サーバーアシストのレジストリ登録＋導線短縮）の固定テスト。"""
import unittest


class AssistRegistryTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from core import action_registry

        cls.registry = action_registry.default_registry()

    def test_all_features_registered(self):
        from core.server_assist import discover_features

        features = discover_features()
        self.assertGreater(len(features), 20)
        for feature in features:
            spec = self.registry.get(f"support:assist_{feature.key}")
            self.assertIsNotNone(spec, feature.key)
            self.assertEqual(spec.label, feature.label)
            self.assertEqual(spec.genre, "assist")

    def test_assist_not_for_ai(self):
        for spec in self.registry.by_root("support"):
            if spec.value.startswith("assist_"):
                self.assertNotIn("aitools", spec.surfaces, spec.id)
                self.assertIn("palette", spec.surfaces, spec.id)
                self.assertIn("shortcut", spec.surfaces, spec.id)

    def test_parent_action_still_exists(self):
        self.assertIsNotNone(self.registry.get("support:server_assist"))


if __name__ == "__main__":
    unittest.main()
