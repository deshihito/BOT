"""細かい修正一式（2026-11-06）のテスト。

対象:
- パネル部品が __init__ の到達不能コードで欠落していたバグの再発防止
  （StealView / BuyLotteryView / BuyMachineView / CraftView）
- steal アイテム5種（泥帽・大泥帽・警棒・大警棒・大怪盗）の判定接続
- prison（逮捕）: ストアの永続化・lazy 解除、発生経路、マネー系の
  実行ブロック（dispatch 集合と各 cog の execute_* の二層）
- 全アイテム売却の統一（売却額 = 購入価格の半分）と保存則
- 市場チャート（価格のみ・日本語フォント・embed 内デフォルト表示）と
  市場パネルのプール額非表示
- 経済系パネルのコンポーネントV2 化（PanelLayoutView で包めること）
"""
from __future__ import annotations

import asyncio
import random
import sys
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path

import discord

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core.game.gambling import gambling as gambling_core
from core.general.circulation import steal
from core.game.game import prison as prison_core
from core.general.items import items
from core.general.market import market as market_core
from core.general.common import GENERAL_ACTIONS, MONEY_PRISON_BLOCKED_VALUES
from core.support.panel_v2 import PanelLayoutView, as_panel_v2
from cogs import general as wallet_module
from cogs.general import (
    BuyLotteryView, CirculationCog, MiningView, StealView)
from cogs.game import GamblingCog, SlotView
from cogs.general import ItemsCog
from cogs.general import MarketCog, MarketView, _market_embed, _render_chart
from cogs.general import status_embed
from cogs.general import BuyMachineView, CraftView, WorkshopCog
from core.game import lottery, mining
from core.general.circulation import economy_pool
from core.general.workshop import workshop as workshop_core
T0 = datetime(2026, 1, 1, 9, 0, tzinfo=items.JST)


class _ScriptedRandom(random.Random):
    def __init__(self, values: list[float]):
        super().__init__()
        self._values = list(values)

    def random(self) -> float:
        if self._values:
            return self._values.pop(0)
        return 0.99


class _FakeWallet:
    def __init__(self, balances: dict[str, int]):
        self.balances = dict(balances)

    async def _change_balance(self, user_id, delta, *, require_funds=False,
                               create_with=None):
        if user_id not in self.balances:
            if create_with is None:
                return None
            self.balances[user_id] = create_with
        if require_funds and self.balances[user_id] + delta < 0:
            return wallet_module.INSUFFICIENT
        self.balances[user_id] += delta
        return self.balances[user_id]


class _FakeBot:
    def __init__(self, cogs: dict):
        self._cogs = cogs

    def get_cog(self, name):
        return self._cogs.get(name)


def _circulation(tmp: str, wallet: _FakeWallet, *, steal_rng=None):
    item_store = items.ItemStore(Path(tmp) / "items.json", rng=random.Random(42))
    cog = CirculationCog(
        _FakeBot({"WalletCog": wallet}),
        mining_store=mining.MiningStore(Path(tmp) / "mining.json", rng=random.Random(42)),
        lottery_store=lottery.LotteryStore(Path(tmp) / "lottery.json", rng=random.Random(42)),
        steal_store=steal.StealStore(
            Path(tmp) / "steal.json", rng=steal_rng or random.Random(42)),
        item_store=item_store,
        balance_reader=lambda uid: wallet.balances.get(uid, 0),
        economy_store=economy_pool.EconomyPoolStore(Path(tmp) / "economy_pool.json"),
        prison_store=prison_core.PrisonStore(Path(tmp) / "prison.json"),
    )
    return cog, item_store


# ---------------------------------------------------------------------------
# 到達不能コードで部品が欠落していたバグの再発防止
# ---------------------------------------------------------------------------

class PanelComponentsTest(unittest.TestCase):
    def test_steal_view_has_target_select(self):
        with tempfile.TemporaryDirectory() as tmp:
            cog, _store = _circulation(tmp, _FakeWallet({}))
            view = StealView(cog, 1)
            self.assertTrue(
                any(isinstance(c, discord.ui.UserSelect) for c in view.children),
                "StealView に対象選択 UserSelect が無い（steal ができない）")

    def test_buy_lottery_view_has_count_select(self):
        with tempfile.TemporaryDirectory() as tmp:
            cog, _store = _circulation(tmp, _FakeWallet({}))
            view = BuyLotteryView(cog, 1)
            selects = [c for c in view.children if isinstance(c, discord.ui.Select)]
            self.assertEqual(len(selects), 1)
            self.assertTrue(selects[0].options)

    def test_buy_machine_view_has_tier_buttons(self):
        view = BuyMachineView(object(), 1)
        buttons = [c for c in view.children if isinstance(c, discord.ui.Button)]
        self.assertEqual(len(buttons), len(workshop_core.MACHINE_TIERS))

    def test_craft_view_has_two_selects(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = items.ItemStore(Path(tmp) / "items.json", rng=random.Random(42))
            store.add("1", "scrap", 3)
            cog = WorkshopCog(_FakeBot({}), item_store=store)
            view = CraftView(cog, 1)
            selects = [c for c in view.children if isinstance(c, discord.ui.Select)]
            self.assertEqual(len(selects), 2)
            self.assertIsNone(view.first)
            self.assertIsNone(view.second)


# ---------------------------------------------------------------------------
# prison ストア
# ---------------------------------------------------------------------------

class PrisonStoreTest(unittest.TestCase):
    def test_imprison_and_lazy_expiry(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = prison_core.PrisonStore(Path(tmp) / "prison.json")
            store.imprison("1", minutes=5, reason="baton_counter", now=T0)
            self.assertTrue(store.is_imprisoned("1", T0))
            self.assertAlmostEqual(store.remaining_seconds("1", T0), 300, delta=1)
            self.assertFalse(store.is_imprisoned("1", T0 + timedelta(minutes=6)))
            self.assertEqual(store.remaining_seconds("1", T0 + timedelta(minutes=6)), 0.0)

    def test_persistence_round_trip(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "prison.json"
            store = prison_core.PrisonStore(path)
            store.imprison("1", hours=6, reason="mud_hat_failure", now=T0)
            store.flush()
            reloaded = prison_core.PrisonStore(path)
            self.assertTrue(reloaded.is_imprisoned("1", T0 + timedelta(hours=1)))
            self.assertFalse(reloaded.is_imprisoned("1", T0 + timedelta(hours=7)))

    def test_imprison_never_shortens(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = prison_core.PrisonStore(Path(tmp) / "prison.json")
            store.imprison("1", hours=6, now=T0)
            store.imprison("1", minutes=5, now=T0)
            self.assertAlmostEqual(
                store.remaining_seconds("1", T0), 6 * 3600, delta=1)

    def test_block_message(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = prison_core.PrisonStore(Path(tmp) / "prison.json")
            self.assertIsNone(prison_core.block_message("1", now=T0, store=store))
            store.imprison("1", minutes=5, now=T0)
            message = prison_core.block_message("1", now=T0, store=store)
            self.assertIn("逮捕中", message)
            self.assertIn("あと約5分", message)


# ---------------------------------------------------------------------------
# steal アイテムと逮捕の発生
# ---------------------------------------------------------------------------

class StealItemsTest(unittest.TestCase):
    def test_dai_baton_repels_and_imprisons(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _FakeWallet({"1": 1000, "2": 10000})
            cog, store = _circulation(tmp, wallet, steal_rng=_ScriptedRandom([0.0]))
            store.add("2", items.DAI_BATON_ITEM, 1)
            message = asyncio.run(cog.execute_steal(1, 2, in_guild=True, now=T0))
            self.assertIn("大警棒で撃退", message)
            self.assertIn("逮捕されました", message)
            # 警棒は消費され、罰金が移り、総和は不変（ゼロサム）。
            self.assertEqual(store.count("2", items.DAI_BATON_ITEM), 0)
            self.assertEqual(
                wallet.balances, {"1": 1000 - steal.FINE_AMOUNT,
                                  "2": 10000 + steal.FINE_AMOUNT})
            # 大警棒の逮捕は60分。
            remaining = cog.prison_store.remaining_seconds("1", T0)
            self.assertAlmostEqual(remaining, 60 * 60, delta=1)
            self.assertEqual(cog.steal_store.actor_status("1", T0)["today_count"], 1)

    def test_baton_repels_at_scripted_roll(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _FakeWallet({"1": 1000, "2": 10000})
            cog, store = _circulation(tmp, wallet, steal_rng=_ScriptedRandom([0.0]))
            cog._rng = _ScriptedRandom([0.0])  # 撃退抽選に当たる
            store.add("2", items.BATON_ITEM, 1)
            message = asyncio.run(cog.execute_steal(1, 2, in_guild=True, now=T0))
            self.assertIn("警棒で撃退", message)
            self.assertEqual(store.count("2", items.BATON_ITEM), 0)
            self.assertAlmostEqual(
                cog.prison_store.remaining_seconds("1", T0), 30 * 60, delta=1)

    def test_baton_not_consumed_when_repel_roll_misses(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _FakeWallet({"1": 1000, "2": 10000})
            cog, store = _circulation(tmp, wallet, steal_rng=_ScriptedRandom([0.0]))
            cog._rng = _ScriptedRandom([0.99])  # 撃退抽選に外れる
            store.add("2", items.BATON_ITEM, 1)
            message = asyncio.run(cog.execute_steal(1, 2, in_guild=True, now=T0))
            self.assertIn("成功", message)
            self.assertEqual(store.count("2", items.BATON_ITEM), 1)
            self.assertFalse(cog.prison_store.is_imprisoned("1", T0))

    def test_charm_takes_precedence_over_baton(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _FakeWallet({"1": 1000, "2": 10000})
            cog, store = _circulation(tmp, wallet, steal_rng=_ScriptedRandom([0.0]))
            store.add("2", "steal_charm", 1)
            # 効果の有効判定は cog 側が実時刻で行うため、実時刻で発動させる。
            store.use_item("2", "steal_charm")
            store.add("2", items.DAI_BATON_ITEM, 1)
            message = asyncio.run(cog.execute_steal(1, 2, in_guild=True, now=T0))
            self.assertIn("防犯チャーム", message)
            # チャームが先に弾くので大警棒は発動せず、逮捕もしない。
            self.assertEqual(store.count("2", items.DAI_BATON_ITEM), 1)
            self.assertFalse(cog.prison_store.is_imprisoned("1", T0))

    def test_mud_hat_bonus_on_success_and_consumed(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _FakeWallet({"1": 1000, "2": 10000})
            cog, store = _circulation(tmp, wallet, steal_rng=_ScriptedRandom([0.0]))
            # 上乗せ率 uniform(0.10, 1.00): random()=0.5 → 0.55 → 5,500。
            cog._rng = _ScriptedRandom([0.5])
            store.add("1", items.MUD_HAT_ITEM, 1)
            message = asyncio.run(cog.execute_steal(1, 2, in_guild=True, now=T0))
            self.assertIn("上乗せ", message)
            # 基本 500（10,000の5%）+ 上乗せ 5,500、ゼロサム。
            self.assertEqual(wallet.balances, {"1": 7000, "2": 4000})
            self.assertEqual(store.count("1", items.MUD_HAT_ITEM), 0)
            self.assertFalse(cog.prison_store.is_imprisoned("1", T0))

    def test_mud_hat_failure_imprisons_thirty_minutes(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _FakeWallet({"1": 1000, "2": 10000})
            cog, store = _circulation(tmp, wallet, steal_rng=_ScriptedRandom([0.99]))
            store.add("1", items.MUD_HAT_ITEM, 1)
            message = asyncio.run(cog.execute_steal(1, 2, in_guild=True, now=T0))
            self.assertIn("失敗", message)
            self.assertIn("逮捕されました", message)
            self.assertEqual(store.count("1", items.MUD_HAT_ITEM), 0)
            self.assertAlmostEqual(
                cog.prison_store.remaining_seconds("1", T0), 30 * 60, delta=1)

    def test_dai_mud_hat_failure_imprisons_sixty_minutes(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _FakeWallet({"1": 1000, "2": 10000})
            cog, store = _circulation(tmp, wallet, steal_rng=_ScriptedRandom([0.99]))
            store.add("1", items.DAI_MUD_HAT_ITEM, 1)
            asyncio.run(cog.execute_steal(1, 2, in_guild=True, now=T0))
            self.assertAlmostEqual(
                cog.prison_store.remaining_seconds("1", T0), 60 * 60, delta=1)

    def test_master_thief_effect_boosts_rate_and_amount(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _FakeWallet({"1": 1000, "2": 10000})
            # 素の成功率0.40では外れる 0.5 でも、+0.30 の補正で当たる。
            cog, store = _circulation(tmp, wallet, steal_rng=_ScriptedRandom([0.5]))
            store.add("1", items.MASTER_THIEF_ITEM, 1)
            store.use_item("1", items.MASTER_THIEF_ITEM)
            message = asyncio.run(cog.execute_steal(1, 2, in_guild=True, now=T0))
            self.assertIn("成功", message)
            # 額は割合・上限とも2倍: 10,000 × 5% × 2 = 1,000。
            self.assertEqual(wallet.balances, {"1": 2000, "2": 9000})

    def test_imprisoned_actor_cannot_steal(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _FakeWallet({"1": 1000, "2": 10000})
            cog, _store = _circulation(tmp, wallet, steal_rng=_ScriptedRandom([0.0]))
            cog.prison_store.imprison("1", minutes=5, now=T0)
            message = asyncio.run(cog.execute_steal(1, 2, in_guild=True, now=T0))
            self.assertIn("逮捕中", message)
            self.assertEqual(wallet.balances, {"1": 1000, "2": 10000})
            self.assertEqual(cog.steal_store.actor_status("1", T0)["today_count"], 0)


# ---------------------------------------------------------------------------
# 逮捕中のマネー系ブロック（二層のうち execute 層と dispatch 集合）
# ---------------------------------------------------------------------------

class PrisonBlockTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._old_shared = prison_core._shared_store
        prison_core._shared_store = prison_core.PrisonStore(
            Path(self._tmp.name) / "prison.json")
        # execute_* の逮捕判定は実時刻で行われるため、実時刻で逮捕する。
        prison_core.shared_store().imprison("1", hours=1)

    def tearDown(self):
        prison_core._shared_store = self._old_shared
        self._tmp.cleanup()

    def test_dispatch_block_set_matches_money_genre(self):
        # 経済導線整理Bで money は3ジャンルに分割されたため、合算で見る。
        money_values = {
            value
            for genre in ("money", "trade_craft", "play")
            for _label, value in GENERAL_ACTIONS[genre]}
        self.assertTrue(MONEY_PRISON_BLOCKED_VALUES <= money_values)
        display_values = {"money_panel", "status", "coin_leaderboard",
                          "market", "items", "workshop", "lottery"}
        self.assertFalse(MONEY_PRISON_BLOCKED_VALUES & display_values)
        for value in ("pay", "token_buy", "token_sell", "item_buy",
                      "item_use", "box_open", "machine_buy", "workshop_claim",
                      "craft", "mining", "lottery_buy", "steal", "slot",
                      "double", "blackjack", "dice"):
            self.assertIn(value, MONEY_PRISON_BLOCKED_VALUES)

    def test_market_trade_blocked(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _FakeWallet({"1": 100000})
            store = market_core.MarketStore(Path(tmp) / "market.json", rng=random.Random(42))
            cog = MarketCog(_FakeBot({"WalletCog": wallet}), store=store)
            message = asyncio.run(cog.execute_buy(1, 1000))
            self.assertIn("逮捕中", message)
            self.assertEqual(wallet.balances["1"], 100000)
            message = asyncio.run(cog.execute_sell(1, 1.0))
            self.assertIn("逮捕中", message)

    def test_items_blocked(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = items.ItemStore(Path(tmp) / "items.json", rng=random.Random(42))
            store.add("1", "scrap", 2)
            wallet = _FakeWallet({"1": 1000})
            cog = ItemsCog(_FakeBot({"WalletCog": wallet}), store=store)
            self.assertIn("逮捕中", asyncio.run(cog.execute_sell(1, "scrap", 1)))
            self.assertIn("逮捕中", asyncio.run(cog.execute_buy(1, "scrap", 1)))
            self.assertIn("逮捕中", cog.execute_use(1, "scrap"))
            self.assertIn("逮捕中", asyncio.run(cog.execute_open_boxes(1)))
            self.assertEqual(store.count("1", "scrap"), 2)
            self.assertEqual(wallet.balances["1"], 1000)

    def test_gambling_blocked(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _FakeWallet({"1": 100000})
            cog = GamblingCog(
                _FakeBot({"WalletCog": wallet}),
                store=gambling_core.GamblingStore(Path(tmp) / "gambling.json"),
                balance_reader=lambda uid: wallet.balances.get(uid, 0))
            self.assertIn(
                "逮捕中", asyncio.run(cog.execute_slot_start(1, 10)))
            self.assertIn(
                "逮捕中", asyncio.run(cog.execute_double_start(1, 100)))
            self.assertIn(
                "逮捕中", asyncio.run(cog.execute_blackjack_start(1, 100)))
            self.assertIn(
                "逮捕中", asyncio.run(cog.execute_dice(1, 100, 7, 100)))
            self.assertEqual(wallet.balances["1"], 100000)
            self.assertIsNone(cog.store.session("1"))

    def test_workshop_blocked(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = items.ItemStore(Path(tmp) / "items.json", rng=random.Random(42))
            cog = WorkshopCog(_FakeBot({}), item_store=store)
            self.assertIn(
                "逮捕中", asyncio.run(cog.execute_buy_machine(1, "small")))
            self.assertIn("逮捕中", cog.execute_claim(1))
            self.assertIn("逮捕中", cog.execute_craft(1, "scrap", "scrap"))
            self.assertIn("逮捕中", cog.execute_commission(1, "scrap", "scrap"))
            self.assertIn("逮捕中", cog.execute_claim_commissions(1))

    def test_mining_and_lottery_blocked(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _FakeWallet({"1": 10000})
            cog, _store = _circulation(tmp, wallet)
            cog.prison_store.imprison("1", hours=1, now=T0)
            self.assertIn(
                "逮捕中", asyncio.run(cog.execute_mining(1, now=T0)))
            self.assertIn(
                "逮捕中", asyncio.run(cog.execute_lottery_buy(1, 1, now=T0)))
            self.assertEqual(wallet.balances["1"], 10000)

    def test_money_panel_status_shows_prison(self):
        # B-2: 公開パネルには逮捕状態を出さない（S4 の線引きで逮捕は
        # 非公開側。本人への通知は ephemeral 経路が担う）。
        embed = status_embed({
            "balance": 100, "prison_remaining": 30 * 60.0})
        fields = {field.name: field.value for field in embed.fields}
        self.assertNotIn("状態", fields)
        for value in fields.values():
            self.assertNotIn("逮捕中", value)
        self.assertNotIn("逮捕中", embed.description or "")


# ---------------------------------------------------------------------------
# 全アイテム売却の統一と保存則
# ---------------------------------------------------------------------------

class SellUnificationTest(unittest.TestCase):
    def test_every_item_sells_at_half_price(self):
        for item_id, definition in items.ITEM_DEFS.items():
            self.assertEqual(
                definition["sell_price"], definition["price"] // 2, item_id)

    def test_new_steal_items_are_defined(self):
        for item_id, name in (("mud_hat", "泥帽"), ("dai_mud_hat", "大泥帽"),
                              ("baton", "警棒"), ("dai_baton", "大警棒"),
                              ("master_thief", "大怪盗")):
            self.assertIn(item_id, items.ITEM_DEFS)
            self.assertEqual(items.ITEM_DEFS[item_id]["name"], name)
            self.assertTrue(items.ITEM_DEFS[item_id]["purchasable"], item_id)

    def test_sell_material_conservation(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = items.ItemStore(Path(tmp) / "items.json", rng=random.Random(42))
            store.add("1", "circuit_piece", 3)
            wallet = _FakeWallet({"1": 0})
            cog = ItemsCog(_FakeBot({"WalletCog": wallet}), store=store)
            message = asyncio.run(cog.execute_sell(1, "circuit_piece", 2))
            self.assertIn("売りました", message)
            self.assertEqual(store.count("1", "circuit_piece"), 1)
            self.assertEqual(wallet.balances["1"], 2 * (1200 // 2))

    def test_sell_more_than_held_changes_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = items.ItemStore(Path(tmp) / "items.json", rng=random.Random(42))
            store.add("1", "scrap", 1)
            wallet = _FakeWallet({"1": 500})
            cog = ItemsCog(_FakeBot({"WalletCog": wallet}), store=store)
            message = asyncio.run(cog.execute_sell(1, "scrap", 5))
            self.assertNotIn("売りました", message)
            self.assertEqual(store.count("1", "scrap"), 1)
            self.assertEqual(wallet.balances["1"], 500)

    def test_box_value_stays_below_price(self):
        self.assertLess(items.box_expected_value(), items.BOX_PRICE)


# ---------------------------------------------------------------------------
# 市場チャートとパネル
# ---------------------------------------------------------------------------

class MarketChartTest(unittest.TestCase):
    def _history(self) -> list[dict]:
        base = datetime.now(items.JST) - timedelta(hours=2)
        return [
            {"t": (base + timedelta(minutes=5 * i)).isoformat(),
             "rate": 100.0 + i, "volume": 10.0}
            for i in range(24)
        ]

    def test_chart_renders_png(self):
        data = _render_chart(self._history())
        self.assertIsNotNone(data)
        self.assertTrue(data.startswith(b"\x89PNG"))

    def test_chart_uses_bundled_japanese_font(self):
        # チャートは PIL 描画（core/economy_image）になり、描画基盤の
        # 優先フォントが同梱の日本語フォントと一致することを確認する。
        data = _render_chart(self._history())
        self.assertIsNotNone(data)
        from cogs.general import CHART_FONT_PATH
        from core import leaderboard_image
        self.assertEqual(
            leaderboard_image._BOARD_FONT_PATH, CHART_FONT_PATH)

    def test_market_embed_hides_pool_and_embeds_chart(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = market_core.MarketStore(
                Path(tmp) / "market.json", rng=random.Random(42))
            plain = _market_embed(store, 1)
            names = [field.name for field in plain.fields]
            self.assertFalse(any("プール" in name for name in names))
            self.assertIsNone(plain.image.url)
            with_chart = _market_embed(store, 1, with_chart=True)
            self.assertEqual(
                with_chart.image.url, "attachment://market_chart.png")

    def test_market_view_has_no_chart_button(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = market_core.MarketStore(
                Path(tmp) / "market.json", rng=random.Random(42))
            cog = MarketCog(_FakeBot({}), store=store)
            view = MarketView(cog, 1)
            labels = [c.label for c in view.children
                      if isinstance(c, discord.ui.Button)]
            self.assertNotIn("チャート", labels)
            self.assertIn("更新", labels)


# ---------------------------------------------------------------------------
# コンポーネントV2 化
# ---------------------------------------------------------------------------

class PanelV2Test(unittest.TestCase):
    def _assert_wrappable(self, view):
        wrapped = as_panel_v2(view)
        self.assertIsInstance(wrapped, PanelLayoutView)
        wrapped._sync()  # 再同期しても壊れない
        self.assertTrue(wrapped.children)

    def test_circulation_views_wrap(self):
        with tempfile.TemporaryDirectory() as tmp:
            cog, _store = _circulation(tmp, _FakeWallet({}))
            self._assert_wrappable(StealView(cog, 1))
            self._assert_wrappable(BuyLotteryView(cog, 1))
            self._assert_wrappable(MiningView(cog, 1))

    def test_workshop_views_wrap(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = items.ItemStore(Path(tmp) / "items.json", rng=random.Random(42))
            store.add("1", "scrap", 2)
            cog = WorkshopCog(_FakeBot({}), item_store=store)
            self._assert_wrappable(BuyMachineView(cog, 1))
            self._assert_wrappable(CraftView(cog, 1))

    def test_market_view_wraps(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = market_core.MarketStore(
                Path(tmp) / "market.json", rng=random.Random(42))
            cog = MarketCog(_FakeBot({}), store=store)
            self._assert_wrappable(MarketView(cog, 1))

    def test_gambling_view_wraps(self):
        with tempfile.TemporaryDirectory() as tmp:
            cog = GamblingCog(
                _FakeBot({}),
                store=gambling_core.GamblingStore(Path(tmp) / "gambling.json"),
                balance_reader=lambda uid: 0)
            view = SlotView(cog, 1)
            view._last_balance = 0
            self._assert_wrappable(view)


if __name__ == "__main__":
    unittest.main()
