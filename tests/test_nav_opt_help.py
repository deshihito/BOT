# -*- coding: utf-8 -*-
"""導線最適化 M6（/help へのレジストリアクション統合）の固定テスト。"""
import unittest


class HelpActionIntegrationTest(unittest.TestCase):
    def test_every_action_mapped_exactly_once(self):
        from cogs.help import ACTION_CATEGORY_MAP, panel_action_lines
        from core import action_registry

        total = sum(len(panel_action_lines(cat)) for cat in ACTION_CATEGORY_MAP)
        expected = len([s for s in action_registry.default_registry().all()
                        if s.root != "help"])
        self.assertEqual(total, expected)

    def test_economy_lists_market_with_route(self):
        from cogs.help import panel_action_lines

        lines = panel_action_lines("economy")
        self.assertTrue(any("市場" in line and "/general" in line for line in lines))

    def test_category_page_includes_panel_actions(self):
        from cogs.help import category_pages

        catalog = {"categories": [{
            "id": "economy", "label": "コイン", "description": "説明", "guide": None,
        }], "commands": []}
        pages = category_pages(catalog, "economy")
        text = "\n".join(page.description or "" for page in pages)
        self.assertIn("パネル機能", text)
        self.assertIn("市場", text)

    def test_overview_mentions_quick(self):
        from cogs.help import overview_embed

        embed = overview_embed({"categories": []})
        self.assertIn("/quick", embed.description)


if __name__ == "__main__":
    unittest.main()
