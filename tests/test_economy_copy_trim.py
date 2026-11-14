# -*- coding: utf-8 -*-
"""経済の文言削減C（2026-11-14）の固定テスト。

- フッター定型文は画像版/通常版で同じ文を1定義から出す（宝くじ/アイテム/合成）
- 工房フッター（同パネル内のボタン名そのものの案内）は置かない
- 市場フッターは手数料の開示だけを残す（更新間隔の仕組み説明は出さない）
"""
import random
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from core.game import lottery as lottery_core
from core.general.circulation import cog as circulation_cog
from core.general.items import cog as items_cog
from core.general.items import items as items_core
from core.general.market import cog as market_cog
from core.general.market import market as market_core
from core.general.workshop import cog as workshop_cog
from core.general.workshop import workshop as workshop_core


class FooterTrimTest(unittest.TestCase):
    def test_lottery_footer_shared_and_unchanged(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = lottery_core.LotteryStore(
                Path(tmp) / "lottery.json", rng=random.Random(42))
            cog = SimpleNamespace(lottery_store=store, bot=None)
            expected = circulation_cog._LOTTERY_FOOTER
            self.assertIn("チケットは1枚 100 AGO", expected)
            for image in (True, False):
                embed = circulation_cog._lottery_embed(cog, 1, image=image)
                self.assertEqual(embed.footer.text, expected)

    def test_items_footer_shared_and_unchanged(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = items_core.ItemStore(
                Path(tmp) / "items.json", rng=random.Random(42))
            for image in (True, False):
                embed = items_cog._items_embed(store, 1, image=image)
                self.assertEqual(
                    embed.footer.text, "買えない素材は合成や宝箱で手に入ります。")

    def _workshop_cog(self, tmp: str):
        item_store = items_core.ItemStore(
            Path(tmp) / "items.json", rng=random.Random(42))
        workshop_store = workshop_core.WorkshopStore(
            Path(tmp) / "workshop.json", rng=random.Random(42))
        return workshop_cog.WorkshopCog(
            SimpleNamespace(get_cog=lambda name: None),
            workshop_store=workshop_store, item_store=item_store)

    def test_workshop_footer_removed(self):
        with tempfile.TemporaryDirectory() as tmp:
            cog = self._workshop_cog(tmp)
            for image in (True, False):
                embed = workshop_cog._workshop_embed(cog, 1, image=image)
                self.assertIsNone(embed.footer.text)

    def test_craft_footer_keeps_only_exploration_hint(self):
        with tempfile.TemporaryDirectory() as tmp:
            cog = self._workshop_cog(tmp)
            for image in (True, False):
                embed = workshop_cog._craft_embed(cog, 1, image=image)
                self.assertEqual(
                    embed.footer.text, "組み合わせは試して見つけてください。")

    def test_market_footer_keeps_only_fee_disclosure(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = market_core.MarketStore(
                Path(tmp) / "market.json", rng=random.Random(42))
            embed = market_cog._market_embed(store, 1)
            self.assertEqual(embed.footer.text, "売買には手数料がかかります。")


if __name__ == "__main__":
    unittest.main()
