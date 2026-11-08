"""経済系パネルの画像化（core/economy_image）のテスト。

見るもの: レンダラが所定サイズ・白基調の PNG を返し、データ欠落でも
落ちないこと、画像化した各表示の行データが従来の embed 表示と
同一（値・価格・並び）であること。経済ロジックには触れない。
"""
from __future__ import annotations

import io
import random
import sys
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import config
from core.economy_image import PanelRow, render_market_chart_png, render_panel_png
from core.general.circulation import cog as circulation_cog
from core.general.items import cog as items_cog
from core.general.items import items as items_core
from core.general.market import market as market_core
from core.general.money_panel import cog as money_cog
from core.general.role_shop import cog as role_shop_cog
from core.general.workshop import cog as workshop_cog
from core.general.workshop import workshop as workshop_core
from core.game import lottery as lottery_core

BG = (246, 247, 250)


def _open(png: bytes) -> Image.Image:
    image = Image.open(io.BytesIO(png))
    image.load()
    return image


class RendererBasicsTest(unittest.TestCase):
    def test_panel_png_is_white_themed_1000_wide(self):
        png = render_panel_png(
            title="テスト", accent=(10, 20, 30),
            sections=[(None, [PanelRow("残高", "1,234 AGO")])],
            cache_namespace="test-panel")
        self.assertTrue(png.startswith(b"\x89PNG"))
        image = _open(png)
        self.assertEqual(image.width, 1000)
        self.assertEqual(image.convert("RGB").getpixel((4, 4)), BG)

    def test_panel_png_empty_data_does_not_crash(self):
        for sections in ([], [(None, [])], [("見出し", [])]):
            png = render_panel_png(
                title="空", accent=(0, 0, 0), sections=sections,
                cache_namespace="test-empty")
            self.assertTrue(png.startswith(b"\x89PNG"))

    def test_panel_png_long_text_wraps(self):
        png = render_panel_png(
            title="長文", accent=(0, 0, 0),
            sections=[(None, [PanelRow(
                "説明", "9,999 AGO",
                sub="あ" * 120)])],
            cache_namespace="test-long")
        self.assertTrue(png.startswith(b"\x89PNG"))

    def test_chart_none_without_buckets(self):
        self.assertIsNone(render_market_chart_png(
            buckets=[], ma=[], token_name=market_core.TOKEN_NAME))

    def test_chart_png_from_history(self):
        base = datetime.now(config.JST) - timedelta(hours=2)
        history = [
            {"t": (base + timedelta(minutes=5 * i)).isoformat(),
             "rate": 100.0 + i, "volume": 10.0}
            for i in range(24)
        ]
        buckets = market_core.ohlc_buckets(history, hours=5)
        closes = [bucket["close"] for bucket in buckets]
        png = render_market_chart_png(
            buckets=buckets,
            ma=market_core.moving_average(closes, 20),
            token_name=market_core.TOKEN_NAME,
            stats={"rate": 123.0, "change_1h": 1.5, "change_day": -2.0,
                   "supply": 1_000_000, "circulating": 12_345})
        self.assertIsNotNone(png)
        image = _open(png)
        self.assertEqual(image.size, (1000, 640))
        self.assertEqual(image.convert("RGB").getpixel((4, 4)), BG)


def _status() -> dict:
    return {
        "balance": 12345, "rate": 105.5, "tokens": 12.5,
        "total_assets": 13664,
        "items_total": 5, "items_kinds": 2, "boxes": 2, "effects": 1,
        "machines": 1, "pending_cycles": 3, "min_cycles_left": 40,
        "commissions_total": 1, "commissions_ready": 0, "streak_days": 2,
        "lottery_pool": 98765, "lottery_tickets": 3,
        "lottery_closes": "11/09 21:00",
        "mining_session_left": 0, "mining_ready": True,
        "mining_remaining": 0, "mining_pool": 4321,
        "session_kind": None, "party_count": 4,
        "active_effect_details": [
            {"name": "防犯チャーム", "remaining": 90.0}],
    }


class MoneyPanelImageTest(unittest.TestCase):
    def test_rows_match_legacy_embed(self):
        status = _status()
        embed = money_cog.status_embed(status)
        fields = {f.name: f.value.replace("**", "") for f in embed.fields}
        hero, _banner, sections = money_cog.status_panel_content(status)
        rows = {row.label: row for _t, rs in sections for row in rs}
        # ヒーローは残高、サブに総資産（embed の AGOコイン／総資産と同一）
        self.assertEqual(hero.value, fields["AGOコイン"].replace(" AGO", "") + " AGO")
        self.assertEqual(hero.value, "12,345 AGO")
        self.assertIn("総資産 13,664 AGO", hero.sub)
        self.assertEqual(fields["総資産"], "13,664 AGO")
        # トークン行
        token_row = rows[market_core.TOKEN_NAME]
        self.assertIn(token_row.value, fields[market_core.TOKEN_NAME])
        self.assertIn("105.50", token_row.sub)
        # アイテム・工房・宝くじ・採掘・編成の主要数値が一致する
        self.assertIn("5", rows["アイテム"].value)
        self.assertIn("宝箱 2 個", rows["アイテム"].sub)
        self.assertEqual(rows["工房"].value, "1 台")
        self.assertIn("3 サイクル分", rows["工房"].sub)
        self.assertIn("98,765", rows["宝くじ"].value)
        self.assertIn("3 枚", rows["宝くじ"].sub)
        self.assertIn("4,321", rows["採掘"].sub)
        self.assertEqual(rows["編成"].value, "4 体")
        # 効果は別セクションで同じ名前・残り時間表記
        effect_sections = [rs for t, rs in sections if t == "発動中の効果"]
        self.assertEqual(len(effect_sections), 1)
        self.assertEqual(effect_sections[0][0].label, "防犯チャーム")

    def test_image_embed_has_only_image(self):
        embed = money_cog.status_embed(_status(), image=True)
        self.assertEqual(embed.fields, [])
        self.assertEqual(
            embed.image.url, "attachment://money_status.png")

    def test_status_png_renders(self):
        png = money_cog.status_panel_png(_status(), user_id=1, name="taro")
        self.assertTrue(png.startswith(b"\x89PNG"))
        self.assertEqual(_open(png).width, 1000)


class ItemsImageTest(unittest.TestCase):
    def test_rows_match_legacy_embed_and_shop_lines(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = items_core.ItemStore(
                Path(tmp) / "items.json", rng=random.Random(42))
            store.add("1", "scrap", 3)
            store.add("1", "treasure_box", 2)
            embed = items_cog._items_embed(store, 1)
            fields = {f.name: f.value for f in embed.fields}
            inv_rows = items_cog._inventory_rows(store, 1)
            self.assertEqual(
                [f"・{r.label} ×{r.value[1:]}" for r in inv_rows],
                fields["所持アイテム"].split("\n"))
            plain, consumables = items_cog._shop_rows()
            shop_lines = items_cog._shop_lines()
            self.assertEqual(len(plain), len(shop_lines[0]))
            self.assertEqual(len(consumables), len(shop_lines[1]))
            for row, line in zip(plain, shop_lines[0]):
                self.assertTrue(line.startswith(f"・{row.label} — "))
                self.assertIn(row.value, line)
                self.assertIn(row.sub, line)
            png = items_cog.items_panel_png(store, 1)
            self.assertTrue(png.startswith(b"\x89PNG"))

    def test_empty_inventory_renders(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = items_core.ItemStore(
                Path(tmp) / "items.json", rng=random.Random(42))
            png = items_cog.items_panel_png(store, 99)
            self.assertTrue(png.startswith(b"\x89PNG"))


class WorkshopImageTest(unittest.TestCase):
    def _cog(self, tmp: str):
        item_store = items_core.ItemStore(
            Path(tmp) / "items.json", rng=random.Random(42))
        workshop_store = workshop_core.WorkshopStore(
            Path(tmp) / "workshop.json", rng=random.Random(42))
        cog = workshop_cog.WorkshopCog(
            SimpleNamespace(get_cog=lambda name: None),
            workshop_store=workshop_store, item_store=item_store)
        return cog, workshop_store

    def test_rows_match_legacy_embed(self):
        with tempfile.TemporaryDirectory() as tmp:
            cog, store = self._cog(tmp)
            store.add_machine("1", "small")
            embed = workshop_cog._workshop_embed(cog, 1)
            fields = {f.name: f.value for f in embed.fields}
            _banner, sections = workshop_cog.workshop_panel_content(cog, 1)
            by_title = {t: rs for t, rs in sections}
            machine_rows = by_title["所有加工機"]
            self.assertEqual(len(machine_rows), 1)
            legacy_line = fields["所有加工機"].split("\n")[0]
            self.assertIn(machine_rows[0].label, legacy_line)
            self.assertIn(
                machine_rows[0].value.replace("残り寿命 ", ""),
                legacy_line)
            tier_rows = by_title["加工機（購入）"]
            legacy_tiers = fields["加工機（購入）"].split("\n")
            self.assertEqual(len(tier_rows), len(legacy_tiers))
            for row, line in zip(tier_rows, legacy_tiers):
                self.assertIn(row.label, line)
                self.assertIn(row.value, line)
            png = workshop_cog.workshop_panel_png(cog, 1)
            self.assertTrue(png.startswith(b"\x89PNG"))

    def test_no_machines_renders(self):
        with tempfile.TemporaryDirectory() as tmp:
            cog, _store = self._cog(tmp)
            png = workshop_cog.workshop_panel_png(cog, 7)
            self.assertTrue(png.startswith(b"\x89PNG"))


class LotteryImageTest(unittest.TestCase):
    def _cog(self, tmp: str):
        store = lottery_core.LotteryStore(
            Path(tmp) / "lottery.json", rng=random.Random(42))
        store.add_tickets("1", 3)
        return SimpleNamespace(lottery_store=store, bot=None), store

    def test_hero_and_rows_match_legacy_embed(self):
        with tempfile.TemporaryDirectory() as tmp:
            cog, store = self._cog(tmp)
            embed = circulation_cog._lottery_embed(cog, 1)
            fields = {f.name: f.value.replace("**", "") for f in embed.fields}
            hero, sections = circulation_cog.lottery_panel_content(cog, 1)
            pool_name = next(iter(fields))
            self.assertTrue(hero.label.startswith("第"))
            self.assertEqual(hero.value, fields[pool_name])
            self.assertIn("締切", hero.sub)
            rows = {r.label: r for _t, rs in sections for r in rs}
            self.assertEqual(
                rows["あなたのチケット"].value, fields["あなたのチケット"])
            png = circulation_cog.lottery_panel_png(cog, 1)
            self.assertTrue(png.startswith(b"\x89PNG"))

    def test_winners_rows_match_legacy_embed(self):
        with tempfile.TemporaryDirectory() as tmp:
            cog, store = self._cog(tmp)
            store.last_result = lambda: {  # type: ignore[method-assign]
                "round_id": 7,
                "winners": [{"user_id": 42, "prize": 5000, "tickets": 2}],
                "boost": 0}
            embed = circulation_cog._lottery_embed(cog, 1)
            fields = {f.name: f.value.replace("**", "") for f in embed.fields}
            _hero, sections = circulation_cog.lottery_panel_content(cog, 1)
            result = {t: rs for t, rs in sections}["前回（第7回）の結果"]
            legacy_line = fields["前回（第7回）の結果"].split("\n")[0]
            self.assertIn(result[0].label, legacy_line)
            self.assertEqual(result[0].value, "5,000 AGO")
            self.assertIn("5,000 AGO", legacy_line)


class RoleShopImageTest(unittest.TestCase):
    def _snapshot(self) -> dict:
        return {
            "products": [
                {"name": "VIPロール", "price": 3000, "days": 30,
                 "role_id": 111},
                {"name": "応援ロール", "price": 500, "days": 7,
                 "role_id": 222},
            ],
            "grants": {111: datetime(2026, 11, 20, 12, 0)},
        }

    def test_rows_match_legacy_embed(self):
        snapshot = self._snapshot()
        embed = role_shop_cog.shop_embed(snapshot)
        fields = {f.name: f.value for f in embed.fields}
        rows = role_shop_cog.role_shop_rows(snapshot)
        self.assertEqual([r.label for r in rows], list(fields))
        for row in rows:
            legacy = fields[row.label]
            self.assertTrue(legacy.startswith(row.value))
            if row.sub:
                self.assertIn(row.sub, legacy)
        png = role_shop_cog.role_shop_panel_png(snapshot)
        self.assertIsNotNone(png)
        self.assertTrue(png.startswith(b"\x89PNG"))

    def test_empty_products_no_image(self):
        snapshot = {"products": [], "grants": {}}
        self.assertIsNone(role_shop_cog.role_shop_panel_png(snapshot))
        embed = role_shop_cog.shop_embed(snapshot, image=True)
        self.assertEqual(
            embed.description, "まだ商品が登録されていません。")


if __name__ == "__main__":
    unittest.main()
