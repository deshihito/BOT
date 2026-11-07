# -*- coding: utf-8 -*-
"""導線最適化 S9（ギャンブルパネルのルール隔離・更新ボタン削除）の固定テスト。"""
import types
import unittest


def _cog():
    from cogs.game import GamblingCog

    return GamblingCog(types.SimpleNamespace())


class GamblingPanelTextTest(unittest.TestCase):
    def test_panels_have_no_rule_description(self):
        from cogs.game import _blackjack_embed, _dice_embed, _double_embed, _slot_embed

        cog = _cog()
        for embed in (_slot_embed(cog, 1), _double_embed(cog, 1),
                      _blackjack_embed(cog, 1), _dice_embed(cog, 1)):
            self.assertIsNone(embed.description, embed.title)

    def test_slot_shows_risk_line_as_footer(self):
        from cogs.game import _slot_embed

        embed = _slot_embed(_cog(), 1)
        self.assertIn("全額没収", embed.footer.text)

    def test_rules_kept_behind_button(self):
        from cogs.game import GAMBLING_RULES

        self.assertIn("全額没収", GAMBLING_RULES["slot"])
        for game in ("double", "blackjack", "dice"):
            self.assertTrue(GAMBLING_RULES[game], game)

    def test_views_have_rules_button_and_no_refresh(self):
        from cogs.game import BlackjackView, DiceView, DoubleView, SlotView

        cog = _cog()
        for view in (SlotView(cog, 1), DoubleView(cog, 1),
                     BlackjackView(cog, 1), DiceView(cog, 1)):
            labels = [child.label for child in view.children]
            self.assertIn("ルール", labels)
            self.assertNotIn("更新", labels)


if __name__ == "__main__":
    unittest.main()
