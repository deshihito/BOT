"""マネーパネル（cogs/money_panel.py の統合パネル）のテスト。

見るもの: ステータス集約が各ストアの値と一致すること、カテゴリごとの
ビュー構築が Discord のコンポーネント上限に収まること、ボタンから
既存の実行部（GeneralCog.dispatch_general・各 cog の execute_*・
ItemsView のモーダル）へ正しく委譲されること、直接実行の後にパネルが
更新されること、レジストリ登録（読み取り扱い・メッセージ経由
ショートカット対象外）。
"""
from __future__ import annotations

import asyncio
import random
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

import discord

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core import action_registry, gambling, items, lottery, market, mining, steal, workshop
from cogs import wallet as wallet_module
from cogs.circulation import CirculationCog
from cogs.gambling import GamblingCog
from cogs.items import ItemsCog
from cogs.market import MarketCog
from cogs.money_panel import CATEGORIES, MoneyPanelCog, MoneyPanelView, status_embed
from cogs.workshop import WorkshopCog


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
        self._cogs = dict(cogs)

    def get_cog(self, name):
        return self._cogs.get(name)


class _FakeGeneral:
    def __init__(self):
        self.calls: list[str] = []

    async def dispatch_general(self, interaction, value):
        self.calls.append(value)


class _FakeResponse:
    def __init__(self):
        self.modal = None
        self.sent: list = []
        self.edited = None
        self.deferred = False

    async def send_modal(self, modal):
        self.modal = modal

    async def send_message(self, *args, **kwargs):
        self.sent.append((args, kwargs))

    async def defer(self, **kwargs):
        self.deferred = True

    async def edit_message(self, **kwargs):
        self.edited = kwargs


class _FakeFollowup:
    def __init__(self):
        self.sent: list = []

    async def send(self, *args, **kwargs):
        self.sent.append((args, kwargs))


class _FakeMessage:
    def __init__(self):
        self.edits: list = []

    async def edit(self, **kwargs):
        self.edits.append(kwargs)


class _FakeInteraction:
    def __init__(self, user_id: int = 1):
        self.user = SimpleNamespace(id=user_id)
        self.response = _FakeResponse()
        self.followup = _FakeFollowup()
        self.data: dict = {}
        self.guild = None
        self.guild_id = None


def _build(tmp: str, wallet: _FakeWallet):
    item_store = items.ItemStore(Path(tmp) / "items.json", rng=random.Random(42))
    market_store = market.MarketStore(Path(tmp) / "market.json", rng=random.Random(42))
    workshop_store = workshop.WorkshopStore(Path(tmp) / "workshop.json", rng=random.Random(42))
    mining_store = mining.MiningStore(Path(tmp) / "mining.json", rng=random.Random(42))
    lottery_store = lottery.LotteryStore(Path(tmp) / "lottery.json", rng=random.Random(42))
    steal_store = steal.StealStore(Path(tmp) / "steal.json", rng=random.Random(42))
    gambling_store = gambling.GamblingStore(Path(tmp) / "gambling.json", rng=random.Random(42))
    bot = _FakeBot({})
    general = _FakeGeneral()
    bot._cogs.update({
        "WalletCog": wallet,
        "MarketCog": MarketCog(bot, store=market_store),
        "ItemsCog": ItemsCog(bot, store=item_store),
        "WorkshopCog": WorkshopCog(
            bot, workshop_store=workshop_store, item_store=item_store),
        "CirculationCog": CirculationCog(
            bot, mining_store=mining_store, lottery_store=lottery_store,
            steal_store=steal_store, item_store=item_store,
            balance_reader=lambda uid: wallet.balances.get(uid, 0)),
        "GamblingCog": GamblingCog(bot, store=gambling_store),
        "GeneralCog": general,
    })
    panel_cog = MoneyPanelCog(
        bot,
        balance_reader=lambda uid: wallet.balances.get(
            uid, wallet_module.NEW_USER_BALANCE))
    return SimpleNamespace(
        bot=bot, general=general, panel_cog=panel_cog,
        item_store=item_store, market_store=market_store,
        workshop_store=workshop_store, lottery_store=lottery_store,
        mining_store=mining_store)


def _seed(env) -> None:
    env.market_store.apply_buy("1", 1000)
    env.item_store.add("1", "scrap", 3)
    env.item_store.add("1", "treasure_box", 2)
    env.workshop_store.add_machine("1", "small")
    env.lottery_store.add_tickets("1", 3)


def _button(view: MoneyPanelView, label: str) -> discord.ui.Button:
    for child in view.children:
        if isinstance(child, discord.ui.Button) and child.label == label:
            return child
    raise AssertionError(f"ボタンがありません: {label}")


class StatusAggregationTest(unittest.TestCase):
    def test_collect_status_matches_stores(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _FakeWallet({"1": 12345})
            env = _build(tmp, wallet)
            _seed(env)
            status = asyncio.run(env.panel_cog.collect_status(1))
            self.assertEqual(status["balance"], 12345)
            self.assertEqual(status["rate"], float(env.market_store.snapshot()["rate"]))
            self.assertEqual(status["tokens"], float(env.market_store.token_balance("1")))
            self.assertGreater(status["tokens"], 0)
            self.assertEqual(status["items_total"], 5)
            self.assertEqual(status["items_kinds"], 2)
            self.assertEqual(status["boxes"], 2)
            self.assertEqual(status["machines"], 1)
            self.assertEqual(status["pending_cycles"], 0)
            self.assertEqual(status["min_cycles_left"],
                             env.workshop_store.machines("1")[0]["cycles_left"])
            self.assertEqual(status["lottery_tickets"], 3)
            self.assertEqual(
                status["lottery_pool"], int(env.lottery_store.current_round()["pool"]))
            self.assertTrue(status["mining_ready"])
            self.assertEqual(status["mining_today"], 0)
            self.assertIsNone(status["session_kind"])

    def test_status_embed_shows_key_values(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _FakeWallet({"1": 12345})
            env = _build(tmp, wallet)
            _seed(env)
            status = asyncio.run(env.panel_cog.collect_status(1))
            embed = status_embed(status)
            fields = {field.name: field.value for field in embed.fields}
            self.assertIn("12,345", fields["AGOコイン"])
            self.assertIn(f"{status['rate']:,.2f}", fields["アゴトークン"])
            self.assertIn("宝箱 **2 個**", fields["アイテム"])
            self.assertIn("1 台", fields["工房"])

    def test_missing_cogs_degrade_to_balance_only(self):
        bot = _FakeBot({})
        panel_cog = MoneyPanelCog(bot, balance_reader=lambda uid: 777)
        status = asyncio.run(panel_cog.collect_status(9))
        self.assertEqual(status["balance"], 777)
        embed = status_embed(status)
        self.assertEqual([field.name for field in embed.fields], ["AGOコイン"])


class ViewStructureTest(unittest.TestCase):
    def test_every_category_fits_component_limits(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = _build(tmp, _FakeWallet({"1": 0}))
            view = MoneyPanelView(env.panel_cog, 1)
            for value, _label in CATEGORIES:
                view.category = value
                view.refresh()
                self.assertLessEqual(len(view.children), 25, value)
                rows: dict[int, int] = {}
                for child in view.children:
                    rows[child.row] = rows.get(child.row, 0) + 1
                for row, count in rows.items():
                    self.assertLessEqual(count, 5, (value, row))
                selects = [
                    child for child in view.children
                    if isinstance(child, discord.ui.Select)]
                self.assertEqual(len(selects), 1, value)
                self.assertEqual(len(selects[0].options), len(CATEGORIES), value)

    def test_category_switch_rebuilds_and_edits(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = _build(tmp, _FakeWallet({"1": 0}))
            view = MoneyPanelView(env.panel_cog, 1)
            interaction = _FakeInteraction()
            interaction.data = {"values": ["market"]}

            async def _run():
                select = next(
                    child for child in view.children
                    if isinstance(child, discord.ui.Select))
                await select.callback(interaction)

            asyncio.run(_run())
            self.assertEqual(view.category, "market")
            self.assertIsNotNone(interaction.response.edited)
            _button(view, "買う")


class DispatchTest(unittest.TestCase):
    def _view(self, tmp: str, category: str):
        env = _build(tmp, _FakeWallet({"1": 100000}))
        view = MoneyPanelView(env.panel_cog, 1)
        view.category = category
        view.refresh()
        return env, view

    def test_market_buttons_dispatch_to_general(self):
        with tempfile.TemporaryDirectory() as tmp:
            env, view = self._view(tmp, "market")
            interaction = _FakeInteraction()
            asyncio.run(_button(view, "買う").callback(interaction))
            asyncio.run(_button(view, "売る").callback(interaction))
            self.assertEqual(env.general.calls, ["token_buy", "token_sell"])

    def test_play_buttons_dispatch_to_general(self):
        with tempfile.TemporaryDirectory() as tmp:
            env, view = self._view(tmp, "play")
            interaction = _FakeInteraction()
            for label in ("スロット", "ダブルアップ", "ブラックジャック", "ダイスベット",
                          "宝くじを買う", "盗む"):
                asyncio.run(_button(view, label).callback(interaction))
            self.assertEqual(
                env.general.calls,
                ["slot", "double", "blackjack", "dice", "lottery_buy", "steal"])

    def test_more_buttons_dispatch_to_general(self):
        with tempfile.TemporaryDirectory() as tmp:
            env, view = self._view(tmp, "more")
            interaction = _FakeInteraction()
            asyncio.run(_button(view, "送金").callback(interaction))
            asyncio.run(_button(view, "プレイヤー状況").callback(interaction))
            self.assertEqual(env.general.calls, ["pay", "status"])

    def test_item_sell_opens_items_modal(self):
        with tempfile.TemporaryDirectory() as tmp:
            env, view = self._view(tmp, "items")
            interaction = _FakeInteraction()
            asyncio.run(_button(view, "売る").callback(interaction))
            modal = interaction.response.modal
            self.assertIsNotNone(modal)
            # 他テストの cog 再読込でクラス同一性が崩れるため、型名と中身で見る。
            self.assertEqual(type(modal).__name__, "ItemAmountModal")
            self.assertEqual(modal.action, "sell")


class DirectExecutionTest(unittest.TestCase):
    def test_mining_button_executes_and_refreshes_panel(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _FakeWallet({})
            env = _build(tmp, wallet)
            view = MoneyPanelView(env.panel_cog, 1)
            view.message = _FakeMessage()
            interaction = _FakeInteraction()
            asyncio.run(_button(view, "採掘する").callback(interaction))
            self.assertTrue(interaction.response.deferred)
            self.assertEqual(len(interaction.followup.sent), 1)
            sent_text = interaction.followup.sent[0][0][0]
            self.assertIn("採掘", sent_text)
            # 実行結果がアイテムに反映され、パネルが更新される。
            self.assertGreater(env.item_store.inventory("1").get("scrap", 0), 0)
            self.assertEqual(len(view.message.edits), 1)
            status = asyncio.run(env.panel_cog.collect_status(1))
            self.assertFalse(status["mining_ready"])

    def test_claim_button_reports_and_refreshes(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = _build(tmp, _FakeWallet({"1": 0}))
            view = MoneyPanelView(env.panel_cog, 1)
            view.message = _FakeMessage()
            interaction = _FakeInteraction()
            asyncio.run(_button(view, "生産物を受け取る").callback(interaction))
            self.assertEqual(len(interaction.followup.sent), 1)
            self.assertEqual(len(view.message.edits), 1)


class RegistryTest(unittest.TestCase):
    def test_money_panel_is_registered_as_read_only(self):
        registry = action_registry.default_registry()
        spec = registry.by_id("general:money_panel")
        self.assertEqual(spec.genre, "money")
        self.assertNotEqual(spec.risk, "blocked")
        self.assertIn("aitools", spec.surfaces)
        self.assertIn("panel", spec.surfaces)
        # 残高などの個人情報を出すため、メッセージ経由ショートカットには載せない。
        self.assertNotIn("shortcut", spec.surfaces)


if __name__ == "__main__":
    unittest.main()
