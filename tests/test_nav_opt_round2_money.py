# -*- coding: utf-8 -*-
"""導線最適化ラウンド2（ダイス表示名・マネーパネル作法）の固定テスト。"""
import asyncio
import unittest
from types import SimpleNamespace


class DiceNamingTest(unittest.TestCase):
    """R2-4: ギャンブルのダイスは「ダイスベット」と表示し、/game の数字当てと区別する。"""

    def test_general_label(self):
        from cogs.general import GENERAL_ACTIONS

        labels = {value: label for label, value in GENERAL_ACTIONS["play"]}
        self.assertEqual(labels["dice"], "ダイスベット")

    def test_gambling_titles(self):
        from cogs.game import DiceModal, _dice_embed

        self.assertEqual(_dice_embed(None, 1).title, "ダイスベット")
        import inspect
        src = inspect.getsource(DiceModal)
        self.assertIn('title="ダイスベット"', src)


class MoneyPanelCleanupTest(unittest.TestCase):
    """R2-5: マネーパネルに再描画だけの「更新」ボタンを置かない。"""

    def _labels(self, category):
        from cogs.general import MoneyPanelView

        view = MoneyPanelView.__new__(MoneyPanelView)
        view.category = category
        view.cog = None
        view.user_id = 1
        import discord
        discord.ui.View.__init__(view, timeout=300)
        view.refresh()
        return [getattr(child, "label", None) for child in view.children]

    def test_no_refresh_only_button(self):
        for category in ("home", "market", "items", "craft", "play", "more"):
            self.assertNotIn("更新", self._labels(category), category)

    def test_placeholder_style(self):
        from cogs.general import MoneyPanelView
        import discord

        view = MoneyPanelView.__new__(MoneyPanelView)
        view.category = "home"
        view.cog = None
        view.user_id = 1
        discord.ui.View.__init__(view, timeout=300)
        view.refresh()
        select = next(c for c in view.children if isinstance(c, discord.ui.Select))
        self.assertEqual(select.placeholder, "カテゴリを選択してください")




if __name__ == "__main__":
    unittest.main()
