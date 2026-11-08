# -*- coding: utf-8 -*-
"""導線最適化 M7（ランキング集約）と M9（その場でショートカット登録）の固定テスト。"""
import unittest


class RankingsBundleTest(unittest.TestCase):
    def test_rankings_action_registered_in_rta_genre(self):
        from core.general import action_registry
        from core.general.common import GENERAL_GENRES

        self.assertEqual(GENERAL_GENRES["rta"][0], "ランキング")
        spec = action_registry.default_registry().get("general:rankings")
        self.assertIsNotNone(spec)
        self.assertEqual(spec.genre, "rta")

    def test_rankings_view_targets_existing_actions(self):
        from cogs.general import RankingsView
        from core.general import action_registry

        registry = action_registry.default_registry()
        # bump/up 個別4件は boardNotify RTA 統合ボード1件に集約し、
        # 即抜けRTAボードを同列に追加（5→6）
        self.assertEqual(len(RankingsView.TARGETS), 6)
        for _label, value in RankingsView.TARGETS:
            self.assertIsNotNone(registry.get(f"general:{value}"), value)
        self.assertIn("rta_board", [value for _label, value in RankingsView.TARGETS])
        self.assertIn("sokunuke_board", [value for _label, value in RankingsView.TARGETS])

    def test_rankings_view_has_six_buttons(self):
        import types

        from cogs.general import RankingsView

        view = RankingsView(types.SimpleNamespace(), 1)
        self.assertEqual(len(view.children), 6)
        self.assertIn("/game", view.embed().description)


