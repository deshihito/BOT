# -*- coding: utf-8 -*-
"""サーバーアシスト再編（旧 M2 の後継）の固定テスト。

旧ハブは廃止し、各機能は support:assist_<key> の一級アクションとして
/support の既存ジャンルに配置される。ID とラベルは従来どおり
（保存済みショートカット・利用履歴・統計の参照を壊さない）。
"""
import unittest


class AssistRegistryTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from core.general import action_registry

        cls.registry = action_registry.default_registry()

    def test_all_features_registered(self):
        from cogs.support import SUPPORT_ACTIONS_BY_GENRE
        from core.support.server_assist import discover_features

        genre_by_value = {
            value: genre
            for genre, items in SUPPORT_ACTIONS_BY_GENRE.items()
            for _label, value in items
        }
        features = discover_features()
        self.assertGreater(len(features), 20)
        for feature in features:
            spec = self.registry.get(f"support:assist_{feature.key}")
            self.assertIsNotNone(spec, feature.key)
            self.assertEqual(spec.label, feature.label)
            self.assertEqual(spec.description, feature.description)
            # ジャンルは SUPPORT_ACTIONS_BY_GENRE の配置と一致すること。
            self.assertEqual(spec.genre, genre_by_value[f"assist_{feature.key}"])
            self.assertNotEqual(spec.genre, "assist")

    def test_genre_spot_checks(self):
        expected = {
            "support:assist_automod": "moderation",
            "support:assist_warnings": "moderation",
            "support:assist_applications": "moderation",
            "support:assist_autorole": "roles",
            "support:assist_leveling": "roles",
            "support:assist_reactionroles": "roles",
            "support:assist_stickyroles": "roles",
            "support:assist_serverlog": "logs",
            "support:assist_invites": "logs",
            "support:assist_welcome": "automation",
            "support:assist_tempvoice": "automation",
            "support:assist_timed": "automation",
        }
        for action_id, genre in expected.items():
            self.assertEqual(self.registry.get(action_id).genre, genre, action_id)

    def test_assist_not_for_ai(self):
        for spec in self.registry.by_root("support"):
            if spec.value.startswith("assist_"):
                self.assertNotIn("aitools", spec.surfaces, spec.id)
                self.assertIn("palette", spec.surfaces, spec.id)
                self.assertIn("shortcut", spec.surfaces, spec.id)

    def test_parent_action_is_removed(self):
        # 旧ハブの親アクションは廃止。AI tools の候補からも消える。
        self.assertIsNone(self.registry.get("support:server_assist"))
        from core.general.ai_tools import ai_tools_router

        self.assertNotIn("support:server_assist", ai_tools_router.action_candidates())


if __name__ == "__main__":
    unittest.main()
