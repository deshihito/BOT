# -*- coding: utf-8 -*-
"""アイテム拡充（2026-11-06）のテスト。

見るもの: 損失還流プール/国庫（core/general/circulation/economy_pool.py）の70/30分割と
保存則、新規アイテムの定義整合と入手経路、効果アイテム6種が実際に
数値へ効くこと（採掘ドリンク/合成触媒/防犯チャーム/没収ガード/
加速オイル/優待パス）、還流フック（ギャンブル損失・市場手数料の
消却分・宝くじ消却分）、効果の期限切れと永続化。
"""
from __future__ import annotations

import asyncio
import random
import sys
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core.general.workshop import craft, workshop
from core.game import mining
from core.game.gambling import gambling
from core.general.circulation import economy_pool
from core.general.items import items
from core.general.market import market
from cogs import general as wallet_module
from cogs.general import CirculationCog
from cogs.gambling import GamblingCog
from cogs.general import ItemsCog
from cogs.general import MarketCog
from cogs.general import WorkshopCog

T0 = datetime(2026, 1, 1, 9, 0, tzinfo=items.JST)

NEW_EFFECT_ITEMS = {
    "mining_drink": (items.MINING_BOOST_EFFECT, 1),
    "craft_catalyst": (items.CRAFT_CATALYST_EFFECT, 2),
    "steal_charm": (items.STEAL_GUARD_EFFECT, 24),
    "confiscation_guard": (items.CONFISCATION_GUARD_EFFECT, 24),
    "workshop_oil": (items.WORKSHOP_HASTE_EFFECT, 4),
    "trade_vip": (items.TRADE_VIP_EFFECT, 24),
}


class _ScriptedRandom(random.Random):
    """random() がキュー順の値を返す rng。"""

    def __init__(self, values=()):
        super().__init__()
        self._values = list(values)

    def random(self) -> float:
        if self._values:
            return self._values.pop(0)
        return 0.99


class _GamblingRandom(random.Random):
    """test_gambling と同じ流儀の決め打ち rng。"""

    def __init__(self, randoms=(), choices_results=(), choice_results=(),
                 randints=()):
        super().__init__()
        self._randoms = list(randoms)
        self._choices_results = list(choices_results)
        self._choice_results = list(choice_results)
        self._randints = list(randints)

    def random(self) -> float:
        return self._randoms.pop(0) if self._randoms else 0.99

    def choices(self, population, weights=None, *, cum_weights=None, k=1):
        if self._choices_results:
            return self._choices_results.pop(0)
        return [population[0]] * k

    def choice(self, seq):
        return self._choice_results.pop(0) if self._choice_results else seq[0]

    def randint(self, a, b):
        return self._randints.pop(0) if self._randints else a


class _MiningRng:
    """採掘用 rng スタブ（randint/random/uniform を決め打ち）。"""

    def __init__(self, ints=(), floats=(), uniform_value=None):
        self._ints = list(ints)
        self._floats = list(floats)
        self._uniform_value = uniform_value

    def randint(self, a, b):
        return self._ints.pop(0) if self._ints else a

    def random(self):
        return self._floats.pop(0) if self._floats else 0.99

    def uniform(self, a, b):
        return self._uniform_value if self._uniform_value is not None else a


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


def _item_store(tmp: str) -> items.ItemStore:
    return items.ItemStore(Path(tmp) / "items.json", rng=random.Random(42))


def _economy_store(tmp: str) -> economy_pool.EconomyPoolStore:
    return economy_pool.EconomyPoolStore(Path(tmp) / "economy_pool.json")


def _activate(store: items.ItemStore, user: str, item_id: str,
              when: datetime | None = None) -> None:
    store.add(user, item_id, 1)
    store.use_item(user, item_id, when)


# ---------------------------------------------------------------------------
# 還流プール／国庫
# ---------------------------------------------------------------------------

class EconomyPoolTest(unittest.TestCase):
    def test_split_70_30_and_conservation(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = _economy_store(tmp)
            store.add_loss(1000)
            self.assertEqual(store.pool_balance(), 700)
            self.assertEqual(store.treasury_balance(), 300)
            # 端数は国庫側へ寄せ、合計は保存される。
            store.add_loss(101)
            snap = store.snapshot()
            self.assertEqual(snap["pool"], 770)
            self.assertEqual(snap["treasury"], 331)
            self.assertEqual(snap["total_recycled"], 1101)
            self.assertEqual(snap["pool"] + snap["treasury"],
                             snap["total_recycled"])

    def test_pay_clamps_and_refund(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = _economy_store(tmp)
            store.add_loss(1000)
            self.assertEqual(store.pay(500), 500)
            self.assertEqual(store.pay(9999), 200)
            self.assertEqual(store.pool_balance(), 0)
            store.refund(50)
            self.assertEqual(store.pool_balance(), 50)

    def test_persistence_roundtrip(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = _economy_store(tmp)
            store.add_loss(1234)
            store.pay(100)
            store.flush()
            loaded = _economy_store(tmp)
            self.assertEqual(loaded.snapshot(), store.snapshot())

    def test_shared_store_is_singleton(self):
        self.assertIs(economy_pool.shared_store(), economy_pool.shared_store())


# ---------------------------------------------------------------------------
# 新規アイテムの定義整合
# ---------------------------------------------------------------------------

class NewItemDefinitionTest(unittest.TestCase):
    def test_effect_items_are_purchasable_with_duration(self):
        for item_id, (effect_id, hours) in NEW_EFFECT_ITEMS.items():
            definition = items.ITEM_DEFS[item_id]
            self.assertEqual(definition["kind"], "consumable", item_id)
            self.assertTrue(definition["purchasable"], item_id)
            self.assertGreater(definition["price"], 0, item_id)
            self.assertEqual(definition["effect"], effect_id, item_id)
            self.assertEqual(definition["duration_hours"], hours, item_id)
            # 効果IDには実体（use ハンドラ）がある。
            self.assertIn(effect_id, items.EFFECT_HANDLERS, item_id)

    def test_collection_price_ladder(self):
        ladder = [
            items.ITEM_DEFS[key]["sell_price"]
            for key in ("silver_scrap", "gold_scrap", "platinum_scrap",
                        "ago_core", "enhanced_ago_core")
        ]
        self.assertEqual(ladder, sorted(ladder))
        self.assertTrue(all(value > 0 for value in ladder))
        for key in ("silver_scrap", "platinum_scrap", "enhanced_ago_core"):
            self.assertFalse(items.ITEM_DEFS[key]["purchasable"], key)

    def test_every_item_has_an_acquisition_route(self):
        craft_outcomes = {
            row[0] for recipe in craft.RECIPES for row in recipe["outcomes"]}
        produced = {
            item_id for tier in workshop.MACHINE_TIERS.values()
            for item_id, _w in tier["production"]}
        for item_id, definition in items.ITEM_DEFS.items():
            route = (definition["purchasable"] or definition["box_drop"]
                     or item_id in craft_outcomes or item_id in produced)
            self.assertTrue(route, f"入手経路が無い: {item_id}")

    def test_box_drops_and_ev(self):
        drop_ids = {row["item"] for row in items.BOX_DROPS
                    if row["kind"] == "item"}
        for item_id in ("silver_scrap", "platinum_scrap", "mining_drink",
                        "craft_catalyst", "workshop_oil"):
            self.assertIn(item_id, drop_ids, item_id)
            self.assertTrue(items.ITEM_DEFS[item_id]["box_drop"], item_id)
        ev = items.box_expected_value()
        self.assertLess(ev, items.ITEM_DEFS["treasure_box"]["price"])
        # 評価は売却価格（購入価格の半分、全アイテム統一）ベース。
        self.assertGreater(ev, 400)

    def test_chain_extension_recipes(self):
        recipe = craft.find_recipe("circuit_board", "precision_parts")
        self.assertIsNotNone(recipe)
        self.assertIn("computing_unit",
                      [row[0] for row in recipe["outcomes"]])
        top = craft.find_recipe("computing_unit", "ago_core")
        self.assertIsNotNone(top)
        self.assertTrue(top["hidden"])
        enhanced = [row for row in top["outcomes"]
                    if row[0] == "enhanced_ago_core"]
        self.assertTrue(enhanced and enhanced[0][3])  # レア行
        gold_pair = craft.find_recipe("gold_scrap", "gold_scrap")
        platinum = [row for row in gold_pair["outcomes"]
                    if row[0] == "platinum_scrap"]
        self.assertTrue(platinum and platinum[0][3])

    def test_consume_effect_and_expiry(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = _item_store(tmp)
            _activate(store, "1", "confiscation_guard", T0)
            self.assertTrue(
                store.has_effect("1", items.CONFISCATION_GUARD_EFFECT, T0))
            self.assertTrue(
                store.consume_effect("1", items.CONFISCATION_GUARD_EFFECT, T0))
            # 1回限り: 2回目は消費できない。
            self.assertFalse(
                store.consume_effect("1", items.CONFISCATION_GUARD_EFFECT, T0))
            _activate(store, "1", "steal_charm", T0)
            self.assertFalse(store.has_effect(
                "1", items.STEAL_GUARD_EFFECT, T0 + timedelta(hours=25)))
            self.assertFalse(store.consume_effect(
                "1", items.STEAL_GUARD_EFFECT, T0 + timedelta(hours=25)))

    def test_effect_persistence_roundtrip(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = _item_store(tmp)
            _activate(store, "1", "mining_drink", T0)
            store.flush()
            loaded = _item_store(tmp)
            self.assertTrue(
                loaded.has_effect("1", items.MINING_BOOST_EFFECT, T0))


# ---------------------------------------------------------------------------
# 採掘ドリンク
# ---------------------------------------------------------------------------

class MiningDrinkTest(unittest.TestCase):
    def _cog(self, tmp, wallet, item_store, rng):
        mining_store = mining.MiningStore(Path(tmp) / "mining.json", rng=rng)
        economy = _economy_store(tmp)
        bot = _FakeBot({"WalletCog": wallet})
        cog = CirculationCog(
            bot, mining_store=mining_store, item_store=item_store,
            balance_reader=lambda uid: wallet.balances.get(uid, 0),
            economy_store=economy)
        return cog, economy

    def test_bonus_roll_paid_from_pool_without_consuming_session(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _FakeWallet({})
            item_store = _item_store(tmp)
            _activate(item_store, "1", "mining_drink")
            rng = _MiningRng(ints=[2, 100, 200], floats=[0.99] * 4)
            cog, economy = self._cog(tmp, wallet, item_store, rng)
            economy.add_loss(100_000)  # プール 70,000
            message = asyncio.run(cog.execute_mining(1, now=T0))
            self.assertIn("採掘ドリンク", message)
            self.assertEqual(wallet.balances["1"],
                             wallet_module.NEW_USER_BALANCE + 300)
            self.assertEqual(economy.pool_balance(), 70_000 - 300)
            # 追加抽選はセッション回数を消費しない（2回中1回だけ消化）。
            self.assertEqual(cog.mining_store.status("1", T0)["session_left"], 1)

    def test_without_drink_single_roll(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _FakeWallet({})
            item_store = _item_store(tmp)
            rng = _MiningRng(ints=[2, 100], floats=[0.99] * 2)
            cog, economy = self._cog(tmp, wallet, item_store, rng)
            economy.add_loss(100_000)
            message = asyncio.run(cog.execute_mining(1, now=T0))
            self.assertNotIn("採掘ドリンク", message)
            self.assertEqual(wallet.balances["1"],
                             wallet_module.NEW_USER_BALANCE + 100)


# ---------------------------------------------------------------------------
# 合成触媒
# ---------------------------------------------------------------------------

class CraftCatalystTest(unittest.TestCase):
    def test_boost_multiplies_rare_weight_and_caps(self):
        recipe = craft.find_recipe("scrap", "scrap")
        weights = craft.outcome_weights(recipe, rare_boost=1.5)
        gold_index = [row[0] for row in recipe["outcomes"]].index("gold_scrap")
        self.assertEqual(weights[gold_index], 15 * 1.5)
        self.assertEqual(craft.combine_rare_boost(2.0, 1.5), 3.0)  # 上限
        self.assertEqual(craft.combine_rare_boost(1.5), 1.5)
        self.assertEqual(craft.combine_rare_boost(), 1.0)

    def test_boost_changes_roll_outcome(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = _item_store(tmp)
            store.add("1", "scrap", 4)
            # 重み [金15/金属25/スクラップ60]、random=0.2 は通常なら金属片。
            plain = craft.execute_craft(
                store, "1", "scrap", "scrap", rng=_ScriptedRandom([0.2]))
            self.assertEqual(plain["item"], "metal_piece")
            # 触媒 ×1.5 で金の重みが 22.5 になり、同じ乱数で金に届く。
            boosted = craft.execute_craft(
                store, "1", "scrap", "scrap", rng=_ScriptedRandom([0.2]),
                rare_boost=items.CRAFT_CATALYST_MULTIPLIER)
            self.assertEqual(boosted["item"], "gold_scrap")
            self.assertTrue(boosted["rare"])

    def test_cog_passes_boost_only_when_catalyst_active(self):
        with tempfile.TemporaryDirectory() as tmp:
            item_store = _item_store(tmp)
            bot = _FakeBot({"WalletCog": _FakeWallet({})})
            cog = WorkshopCog(bot, item_store=item_store)
            captured = {}

            def fake_execute(store, uid, a, b, **kwargs):
                captured.update(kwargs)
                return {"item": "scrap", "count": 1, "rare": False}

            with mock.patch.object(craft, "execute_craft", fake_execute):
                cog.execute_craft(1, "scrap", "scrap")
                self.assertEqual(captured["rare_boost"], 1.0)
                _activate(item_store, "1", "craft_catalyst")
                cog.execute_craft(1, "scrap", "scrap")
                self.assertEqual(captured["rare_boost"],
                                 items.CRAFT_CATALYST_MULTIPLIER)

    def test_commission_boost_stacks_with_cap(self):
        with tempfile.TemporaryDirectory() as tmp:
            item_store = _item_store(tmp)
            item_store.add("1", "scrap", 2)
            # random=0.3: 委託×2.0（金30/計115→34.5で外れ）では金属片、
            # 触媒込み×3.0（金45/計130→39で当たり）では金のスクラップ。
            store = workshop.WorkshopStore(
                Path(tmp) / "workshop.json", rng=_ScriptedRandom([0.3, 0.3]))
            store.add_machine("1", "large", now=T0)
            store.add_machine("2", "large", now=T0)
            store.start_commission(item_store, "1", "scrap", "scrap", now=T0)
            item_store.add("2", "scrap", 2)
            store.start_commission(item_store, "2", "scrap", "scrap", now=T0)
            later = T0 + timedelta(hours=3)
            plain = store.claim_commissions(item_store, "1", now=later)
            self.assertEqual(plain[0]["item"], "metal_piece")
            boosted = store.claim_commissions(
                item_store, "2", now=later,
                extra_rare_boost=items.CRAFT_CATALYST_MULTIPLIER)
            self.assertEqual(boosted[0]["item"], "gold_scrap")


# ---------------------------------------------------------------------------
# 防犯チャーム
# ---------------------------------------------------------------------------

class StealGuardTest(unittest.TestCase):
    def _cog(self, tmp, wallet, item_store):
        from core.game import lottery as lottery_core
        from core.general.circulation import steal as steal_core
        bot = _FakeBot({"WalletCog": wallet})
        return CirculationCog(
            bot,
            mining_store=mining.MiningStore(Path(tmp) / "mining.json"),
            lottery_store=lottery_core.LotteryStore(Path(tmp) / "lottery.json"),
            steal_store=steal_core.StealStore(
                Path(tmp) / "steal.json", rng=_ScriptedRandom([0.0])),
            item_store=item_store,
            balance_reader=lambda uid: wallet.balances.get(uid, 0),
            economy_store=_economy_store(tmp))

    def test_guarded_target_always_fails_but_fine_and_cooldown_apply(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _FakeWallet({"1": 10_000, "2": 10_000})
            item_store = _item_store(tmp)
            _activate(item_store, "2", "steal_charm")
            cog = self._cog(tmp, wallet, item_store)
            # rng は成功側（0.0）に振ってあるが、ガードで自動失敗する。
            message = asyncio.run(
                cog.execute_steal(1, 2, in_guild=True, now=T0))
            self.assertIn("防犯チャーム", message)
            self.assertEqual(wallet.balances["1"], 10_000 - 100)  # 罰金
            self.assertEqual(wallet.balances["2"], 10_000 + 100)
            # 実行者のクールダウンは通常どおり記録される。
            self.assertEqual(
                cog.steal_store.actor_status("1", T0)["today_count"], 1)

    def test_unguarded_target_can_be_stolen(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _FakeWallet({"1": 10_000, "2": 10_000})
            item_store = _item_store(tmp)
            cog = self._cog(tmp, wallet, item_store)
            message = asyncio.run(
                cog.execute_steal(1, 2, in_guild=True, now=T0))
            self.assertIn("盗みに成功", message)
            self.assertGreater(wallet.balances["1"], 10_000)


# ---------------------------------------------------------------------------
# 没収ガード＋ギャンブルの還流
# ---------------------------------------------------------------------------

class GamblingGuardAndRecycleTest(unittest.TestCase):
    def _cog(self, tmp, wallet, rng, item_store=None):
        store = gambling.GamblingStore(Path(tmp) / "gambling.json", rng=rng)
        economy = _economy_store(tmp)
        bot = _FakeBot({"WalletCog": wallet})
        cog = GamblingCog(
            bot, store=store,
            balance_reader=lambda uid: wallet.balances.get(uid, 0),
            item_store=item_store, economy_store=economy)
        return cog, economy

    def test_confiscation_guard_converts_to_penalty_and_is_consumed(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _FakeWallet({"1": 100_000})
            item_store = _item_store(tmp)
            _activate(item_store, "1", "confiscation_guard")
            rng = _GamblingRandom(choices_results=[[6, 6, 6, 6, 6, 1, 2]])
            cog, economy = self._cog(tmp, wallet, rng, item_store)
            asyncio.run(cog.execute_slot_start(1, 10))
            message = asyncio.run(cog.execute_slot_spin(1))
            self.assertIn("没収ガード発動", message)
            # 先払い後の 90,000 からペナルティ 9,000 だけ引かれる。
            self.assertEqual(wallet.balances["1"], 90_000 - 9_000)
            self.assertFalse(item_store.has_effect(
                "1", items.CONFISCATION_GUARD_EFFECT))
            # ペナルティは損失として還流される。
            self.assertEqual(economy.pool_balance(), int(9_000 * 0.7))

    def test_confiscation_without_guard_takes_all_and_recycles(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _FakeWallet({"1": 100_000})
            rng = _GamblingRandom(choices_results=[[6, 6, 6, 6, 6, 1, 2]])
            cog, economy = self._cog(tmp, wallet, rng, _item_store(tmp))
            asyncio.run(cog.execute_slot_start(1, 10))
            message = asyncio.run(cog.execute_slot_spin(1))
            self.assertIn("所持コイン全額没収", message)
            self.assertEqual(wallet.balances["1"], 0)
            self.assertEqual(economy.pool_balance(), int(90_000 * 0.7))

    def test_double_loss_recycles_bet(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _FakeWallet({"1": 10_000})
            rng = _GamblingRandom(randoms=[0.99])
            cog, economy = self._cog(tmp, wallet, rng)
            asyncio.run(cog.execute_double_start(1, 1000))
            asyncio.run(cog.execute_double_go(1))
            self.assertEqual(economy.pool_balance(), 700)
            self.assertEqual(economy.treasury_balance(), 300)

    def test_dice_loss_recycles_bet(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _FakeWallet({"1": 10_000})
            rng = _GamblingRandom(randints=[3])
            cog, economy = self._cog(tmp, wallet, rng)
            message = asyncio.run(cog.execute_dice(1, 6, 5, 500))
            self.assertIn("はずれ", message)
            self.assertEqual(economy.pool_balance(), 350)

    def test_blackjack_bust_recycles_bet(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _FakeWallet({"1": 10_000})
            rng = _GamblingRandom(choice_results=[10, 6, 5, 9, 10])
            cog, economy = self._cog(tmp, wallet, rng)
            asyncio.run(cog.execute_blackjack_start(1, 1000))
            message, finished = asyncio.run(cog.execute_blackjack_hit(1))
            self.assertTrue(finished)
            self.assertIn("バースト", message)
            self.assertEqual(economy.pool_balance(), 700)

    def test_slot_session_net_loss_recycles_at_finish(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _FakeWallet({"1": 100_000})
            miss = [1, 2, 3, 4, 5, 8, 9]
            pair = [1, 1, 2, 3, 4, 5, 9]  # 2揃い 1,100（連敗をリセット）
            reels = [miss, miss, pair, miss, miss, pair,
                     miss, miss, pair, miss]
            rng = _GamblingRandom(choices_results=reels)
            cog, economy = self._cog(tmp, wallet, rng)
            asyncio.run(cog.execute_slot_start(1, 10))
            _message, info = asyncio.run(cog.execute_slot_spin_bulk(1, 10))
            self.assertTrue(info["finished"])
            # 純損失 = 先払い 10,000 − 配当 3,300 = 6,700 の70%がプールへ。
            self.assertEqual(economy.pool_balance(), int(6_700 * 0.7))
            self.assertEqual(wallet.balances["1"], 100_000 - 6_700)


# ---------------------------------------------------------------------------
# 加速オイル
# ---------------------------------------------------------------------------

class WorkshopHasteTest(unittest.TestCase):
    def test_time_scale_doubles_elapsed_in_core(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = workshop.WorkshopStore(
                Path(tmp) / "workshop.json", rng=random.Random(42))
            store.add_machine("1", "small", now=T0)
            machine = store.machines("1")[0]
            # 小型は4時間サイクル: 2時間では通常0、2倍換算で1サイクル。
            self.assertEqual(
                store.pending_cycles(machine, T0 + timedelta(hours=2)), 0)
            self.assertEqual(
                store.pending_cycles(
                    machine, T0 + timedelta(hours=2), time_scale=2.0), 1)
            result = store.claim_production(
                "1", now=T0 + timedelta(hours=2),
                time_scale=items.WORKSHOP_HASTE_MULTIPLIER)
            self.assertEqual(result["cycles"], 1)
            # サイクルを消化した分だけ寿命も減る（早く尽きる）。
            self.assertEqual(store.machines("1")[0]["cycles_left"], 35)

    def test_cog_claim_uses_oil_when_active(self):
        with tempfile.TemporaryDirectory() as tmp:
            item_store = _item_store(tmp)
            workshop_store = workshop.WorkshopStore(
                Path(tmp) / "workshop.json", rng=random.Random(42))
            bot = _FakeBot({"WalletCog": _FakeWallet({})})
            cog = WorkshopCog(
                bot, workshop_store=workshop_store, item_store=item_store)
            anchor = datetime.now(items.JST) - timedelta(hours=2)
            workshop_store.add_machine("1", "small", now=anchor)
            # オイルなしでは 2時間経過でもサイクル未完。
            message = cog.execute_claim(1)
            self.assertIn("まだ受け取れる生産物がありません", message)
            _activate(item_store, "1", "workshop_oil")
            message = cog.execute_claim(1)
            self.assertIn("受け取りました", message)
            self.assertEqual(
                workshop_store.machines("1")[0]["cycles_left"], 35)


# ---------------------------------------------------------------------------
# 優待パス＋市場手数料の還流
# ---------------------------------------------------------------------------

class TradeVipTest(unittest.TestCase):
    def test_core_cap_ratio_override(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = market.MarketStore(
                Path(tmp) / "market.json", rng=random.Random(42))
            self.assertEqual(store.trade_cap_aga(), 10_000)
            self.assertEqual(
                store.trade_cap_aga(items.TRADE_VIP_CAP_RATIO), 20_000)
            with self.assertRaises(market.TradeError):
                store.validate_buy(15_000)
            store.validate_buy(15_000, cap_ratio=items.TRADE_VIP_CAP_RATIO)

    def test_vip_raises_cap_and_fee_burn_recycles(self):
        with tempfile.TemporaryDirectory() as tmp:
            item_store = _item_store(tmp)
            market_store = market.MarketStore(
                Path(tmp) / "market.json", rng=random.Random(42))
            economy = _economy_store(tmp)
            wallet = _FakeWallet({"1": 10 ** 9, "2": 10 ** 9})
            items_cog = ItemsCog(_FakeBot({"WalletCog": wallet}),
                                 store=item_store)
            bot = _FakeBot({"WalletCog": wallet, "ItemsCog": items_cog})
            market_cog = MarketCog(bot, store=market_store,
                                   economy_store=economy)
            # 通常上限（プールの1% = 10,000）を超える買いは弾かれる。
            message = asyncio.run(market_cog.execute_buy(1, 15_000))
            self.assertIn("取引上限", message)
            self.assertEqual(economy.snapshot()["total_recycled"], 0)
            # 優待パス発動中は買える。手数料150の消却分75が還流される。
            _activate(item_store, "2", "trade_vip")
            message = asyncio.run(market_cog.execute_buy(2, 15_000))
            self.assertIn("買いました", message)
            self.assertEqual(market_store.token_balance("2"), 148.5)
            snap = economy.snapshot()
            self.assertEqual(snap["total_recycled"], 75)
            self.assertEqual(snap["pool"], 52)
            self.assertEqual(snap["treasury"], 23)


# ---------------------------------------------------------------------------
# 宝くじ消却分の還流
# ---------------------------------------------------------------------------

class LotteryBurnRecycleTest(unittest.TestCase):
    def test_settle_recycles_burned_share(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _FakeWallet({})
            bot = _FakeBot({"WalletCog": wallet})
            cog = CirculationCog(
                bot,
                mining_store=mining.MiningStore(Path(tmp) / "mining.json"),
                item_store=_item_store(tmp),
                balance_reader=lambda uid: 0,
                economy_store=_economy_store(tmp))
            fake_result = {"round_id": "2099-01-01", "winners": [],
                           "burned": 1000, "pool": 9000, "carryover": 0}
            with mock.patch.object(
                    cog.lottery_store, "settle_if_due",
                    return_value=fake_result):
                result = asyncio.run(cog.settle_lottery(now=T0))
            self.assertIs(result, fake_result)
            self.assertEqual(cog.economy_store.pool_balance(), 700)
            self.assertEqual(cog.economy_store.treasury_balance(), 300)


if __name__ == "__main__":
    unittest.main()
