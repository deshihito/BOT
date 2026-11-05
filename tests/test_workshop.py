"""core/workshop.py（加工機・委託加工・ストリーク）と WorkshopCog のテスト。

見るもの: ティア定義と価格の回収期間（60日以上、ストリーク最大時も）、
購入の保存則（コインと加工機の対応、残高不足で不変）、生産の lazy 決済と
貯蔵上限、端数時間の持ち越し、レア率、ストリークの加算/上限/猶予リセット、
委託加工（ロック→時間経過→claim、並行上限）、永続化ラウンドトリップ、
レジストリ登録（workshop は読み取り、状態変更系は AI blocked）。
"""
from __future__ import annotations

import asyncio
import random
import sys
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core import action_registry, items, workshop
from cogs import wallet as wallet_module
from cogs.workshop import WorkshopCog

T0 = datetime(2026, 1, 1, 9, 0, tzinfo=items.JST)


def _item_store(tmp: str) -> items.ItemStore:
    return items.ItemStore(Path(tmp) / "items.json", rng=random.Random(42))


def _ws_store(tmp: str, rng=None) -> workshop.WorkshopStore:
    return workshop.WorkshopStore(
        Path(tmp) / "workshop.json", rng=rng or random.Random(42))


class _ScriptedRandom(random.Random):
    """random() がキュー順の値を返す rng（レア抽選などを決め打ちするため）。"""

    def __init__(self, values: list[float]):
        super().__init__()
        self._values = list(values)

    def random(self) -> float:
        if self._values:
            return self._values.pop(0)
        return 0.99


class TierDefinitionTest(unittest.TestCase):
    def test_tiers_are_consistent(self):
        for tier_id, tier in workshop.MACHINE_TIERS.items():
            self.assertGreater(tier["price"], 0, tier_id)
            self.assertGreater(tier["cycle_hours"], 0, tier_id)
            self.assertEqual(
                tier["storage_hours"] % tier["cycle_hours"], 0, tier_id)
            self.assertGreaterEqual(
                tier["storage_hours"] // tier["cycle_hours"], 1, tier_id)
            for item_id, weight in tier["production"]:
                self.assertIn(item_id, items.ITEM_DEFS, tier_id)
                self.assertGreater(weight, 0, tier_id)
            self.assertIn(tier["rare_item"], items.ITEM_DEFS, tier_id)
            self.assertGreaterEqual(tier["rare_rate"], 0.0, tier_id)
            self.assertLess(tier["rare_rate"], 1.0, tier_id)
            self.assertGreaterEqual(tier["commission_slots"], 1, tier_id)

    def test_rare_rates_match_spec(self):
        self.assertEqual(workshop.MACHINE_TIERS["small"]["rare_rate"], 0.0)
        self.assertEqual(workshop.MACHINE_TIERS["auto"]["rare_rate"], 0.05)
        self.assertEqual(workshop.MACHINE_TIERS["large"]["rare_rate"], 0.12)
        self.assertEqual(
            (workshop.MACHINE_TIERS["small"]["cycle_hours"],
             workshop.MACHINE_TIERS["small"]["storage_hours"]), (4, 8))
        self.assertEqual(
            (workshop.MACHINE_TIERS["auto"]["cycle_hours"],
             workshop.MACHINE_TIERS["auto"]["storage_hours"]), (6, 12))
        self.assertEqual(
            (workshop.MACHINE_TIERS["large"]["cycle_hours"],
             workshop.MACHINE_TIERS["large"]["storage_hours"]), (8, 24))
        self.assertEqual(workshop.MACHINE_TIERS["large"]["commission_slots"], 2)

    def test_payback_period_is_at_least_60_days(self):
        for tier_id in workshop.MACHINE_TIERS:
            days = workshop.payback_days(tier_id)
            self.assertGreaterEqual(days, 60.0, tier_id)
            # ストリーク最大（+25%）で回し続けても60日を割らないこと。
            self.assertGreaterEqual(days / 1.25, 60.0, tier_id)


class ProductionTest(unittest.TestCase):
    def test_lazy_settlement_and_storage_cap(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = _ws_store(tmp)
            store.add_machine("1", "small", now=T0)
            machine = store.machines("1")[0]
            self.assertEqual(store.pending_cycles(machine, T0 + timedelta(hours=3)), 0)
            self.assertEqual(store.pending_cycles(machine, T0 + timedelta(hours=4)), 1)
            self.assertEqual(store.pending_cycles(machine, T0 + timedelta(hours=8)), 2)
            # 貯蔵上限（8時間分=2サイクル）で止まる。
            self.assertEqual(store.pending_cycles(machine, T0 + timedelta(hours=100)), 2)
            self.assertEqual(store.total_pending("1", T0 + timedelta(hours=100)), 2)

    def test_claim_moves_anchor_and_keeps_remainder(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = _ws_store(tmp)
            store.add_machine("1", "small", now=T0)
            result = store.claim_production("1", now=T0 + timedelta(hours=5))
            self.assertEqual(result["cycles"], 1)
            self.assertEqual(sum(result["items"].values()), 1)  # 初日はボーナスなし
            # 端数1時間が残るので、3時間後にもう1サイクル完成する。
            self.assertEqual(
                store.total_pending("1", T0 + timedelta(hours=8)), 1)
            # 直後の再 claim は何も生まない。
            again = store.claim_production("1", now=T0 + timedelta(hours=5))
            self.assertEqual(again["cycles"], 0)
            self.assertEqual(again["items"], {})

    def test_claim_without_machines_is_empty(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = _ws_store(tmp)
            result = store.claim_production("nobody", now=T0)
            self.assertEqual(result["cycles"], 0)
            self.assertEqual(result["items"], {})

    def test_rare_roll_hits_rare_item(self):
        with tempfile.TemporaryDirectory() as tmp:
            # 最初の random() がレア判定（0.01 < 0.05）に当たる脚本。
            store = _ws_store(tmp, rng=_ScriptedRandom([0.01]))
            store.add_machine("1", "auto", now=T0)
            result = store.claim_production("1", now=T0 + timedelta(hours=6))
            self.assertEqual(result["items"], {"reinforced_alloy": 1})

    def test_normal_roll_uses_production_table(self):
        with tempfile.TemporaryDirectory() as tmp:
            # レア判定は外れ（0.99）、テーブル抽選は先頭（0.0）→ スクラップ。
            store = _ws_store(tmp, rng=_ScriptedRandom([0.99, 0.0]))
            store.add_machine("1", "auto", now=T0)
            result = store.claim_production("1", now=T0 + timedelta(hours=6))
            self.assertEqual(result["items"], {"scrap": 1})


class StreakTest(unittest.TestCase):
    def _claim_next_day(self, store, day_offset: int) -> dict:
        return store.claim_production("1", now=T0 + timedelta(days=day_offset))

    def test_streak_increments_caps_and_resets(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = _ws_store(tmp, rng=random.Random(1))
            store.add_machine("1", "small", now=T0)
            day0 = self._claim_next_day(store, 0)
            # 初日はサイクルが溜まっていない（購入直後）ので claim できない。
            self.assertEqual(day0["cycles"], 0)
            first = store.claim_production("1", now=T0 + timedelta(hours=4))
            self.assertEqual(first["streak_days"], 1)
            self.assertEqual(first["bonus_rate"], 0.0)
            second = self._claim_next_day(store, 1)
            self.assertEqual(second["streak_days"], 2)
            self.assertEqual(second["bonus_rate"], 0.05)
            # 1日空けても猶予で続く。
            fourth = self._claim_next_day(store, 3)
            self.assertEqual(fourth["streak_days"], 3)
            # 2日空けると切れる。
            seventh = self._claim_next_day(store, 6)
            self.assertEqual(seventh["streak_days"], 1)
            self.assertEqual(seventh["bonus_rate"], 0.0)

    def test_streak_bonus_caps_at_25_percent(self):
        self.assertEqual(workshop.streak_bonus_rate(1), 0.0)
        self.assertEqual(workshop.streak_bonus_rate(2), 0.05)
        self.assertEqual(workshop.streak_bonus_rate(6), 0.25)
        self.assertEqual(workshop.streak_bonus_rate(30), 0.25)

    def test_bonus_produces_extra_items(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = _ws_store(tmp, rng=random.Random(1234))
            for _ in range(10):
                store.add_machine("1", "small", now=T0)
            # 6日連続 claim してストリークを最大まで育てる。
            result = None
            for day in range(6):
                result = store.claim_production(
                    "1", now=T0 + timedelta(days=day, hours=4))
            assert result is not None
            self.assertEqual(result["streak_days"], 6)
            self.assertEqual(result["bonus_rate"], 0.25)
            total_items = sum(result["items"].values())
            self.assertGreater(total_items, result["cycles"])

    def test_same_day_second_claim_does_not_extend_streak(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = _ws_store(tmp, rng=random.Random(1))
            store.add_machine("1", "small", now=T0)
            store.add_machine("1", "small", now=T0)
            first = store.claim_production("1", now=T0 + timedelta(hours=4))
            second = store.claim_production("1", now=T0 + timedelta(hours=8))
            self.assertEqual(first["streak_days"], 1)
            self.assertEqual(second["streak_days"], 1)


class CommissionTest(unittest.TestCase):
    def _setup(self, tmp: str, tier: str = "small"):
        item_store = _item_store(tmp)
        store = _ws_store(tmp)
        store.add_machine("1", tier, now=T0)
        item_store.add("1", "scrap", 4)
        return item_store, store

    def test_commission_requires_machine(self):
        with tempfile.TemporaryDirectory() as tmp:
            item_store = _item_store(tmp)
            store = _ws_store(tmp)
            item_store.add("1", "scrap", 2)
            with self.assertRaises(items.ItemError):
                store.start_commission(item_store, "1", "scrap", "scrap", now=T0)
            self.assertEqual(item_store.count("1", "scrap"), 2)

    def test_commission_locks_materials_and_claims_after_time(self):
        with tempfile.TemporaryDirectory() as tmp:
            item_store, store = self._setup(tmp)
            job = store.start_commission(item_store, "1", "scrap", "scrap", now=T0)
            self.assertEqual(item_store.count("1", "scrap"), 2)  # 2個消費された
            self.assertEqual(len(store.commissions("1")), 1)
            # 完了前は受け取れない。
            early = store.claim_commissions(
                item_store, "1", now=T0 + timedelta(hours=1))
            self.assertEqual(early, [])
            self.assertEqual(len(store.commissions("1")), 1)
            ready_at = datetime.fromisoformat(job["ready_at"])
            results = store.claim_commissions(item_store, "1", now=ready_at)
            self.assertEqual(len(results), 1)
            self.assertIn(results[0]["item"],
                          {"metal_piece", "scrap", "gold_scrap"})
            self.assertEqual(store.commissions("1"), [])
            expected = (2 if results[0]["item"] == "scrap" else 0) + results[0]["count"]
            self.assertEqual(item_store.count("1", results[0]["item"]), expected)

    def test_commission_parallel_limit_by_tier(self):
        with tempfile.TemporaryDirectory() as tmp:
            item_store, store = self._setup(tmp, tier="small")
            store.start_commission(item_store, "1", "scrap", "scrap", now=T0)
            with self.assertRaises(items.ItemError):
                store.start_commission(item_store, "1", "scrap", "scrap", now=T0)
            self.assertEqual(item_store.count("1", "scrap"), 2)  # 2件目は消費なし
        with tempfile.TemporaryDirectory() as tmp:
            item_store, store = self._setup(tmp, tier="large")
            store.start_commission(item_store, "1", "scrap", "scrap", now=T0)
            store.start_commission(item_store, "1", "scrap", "scrap", now=T0)
            self.assertEqual(len(store.commissions("1")), 2)
            self.assertEqual(item_store.count("1", "scrap"), 0)

    def test_commission_rejects_unknown_combination(self):
        with tempfile.TemporaryDirectory() as tmp:
            item_store, store = self._setup(tmp)
            item_store.add("1", "fee_pass", 1)
            with self.assertRaises(items.ItemError):
                store.start_commission(item_store, "1", "scrap", "fee_pass", now=T0)
            self.assertEqual(item_store.count("1", "scrap"), 4)
            self.assertEqual(item_store.count("1", "fee_pass"), 1)


class PersistenceTest(unittest.TestCase):
    def test_roundtrip(self):
        with tempfile.TemporaryDirectory() as tmp:
            item_store = _item_store(tmp)
            store = _ws_store(tmp)
            store.add_machine("9", "large", now=T0)
            item_store.add("9", "scrap", 2)
            store.start_commission(item_store, "9", "scrap", "scrap", now=T0)
            store.claim_production("9", now=T0 + timedelta(hours=8))
            store.flush()
            loaded = _ws_store(tmp)
            machines = loaded.machines("9")
            self.assertEqual(len(machines), 1)
            self.assertEqual(machines[0]["tier"], "large")
            self.assertEqual(len(loaded.commissions("9")), 1)
            status = loaded.streak_status("9", T0 + timedelta(hours=8))
            self.assertEqual(status["days"], 1)


class _FakeWallet:
    def __init__(self, balances: dict[str, int]):
        self.balances = dict(balances)

    async def _change_balance(self, user_id, delta, *, require_funds=False, create_with=None):
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


class BuyMachineFlowTest(unittest.TestCase):
    def _cog(self, tmp: str, balances: dict[str, int]):
        wallet = _FakeWallet(balances)
        item_store = _item_store(tmp)
        ws_store = _ws_store(tmp)
        bot = _FakeBot({"WalletCog": wallet})
        cog = WorkshopCog(bot, workshop_store=ws_store, item_store=item_store)
        return cog, wallet, ws_store

    def test_buy_moves_coins_and_adds_machine(self):
        with tempfile.TemporaryDirectory() as tmp:
            price = workshop.MACHINE_TIERS["small"]["price"]
            cog, wallet, ws_store = self._cog(tmp, {"1": price + 500})
            message = asyncio.run(cog.execute_buy_machine(1, "small"))
            self.assertIn("購入しました", message)
            self.assertEqual(wallet.balances["1"], 500)
            self.assertEqual(len(ws_store.machines("1")), 1)

    def test_buy_with_insufficient_funds_changes_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            cog, wallet, ws_store = self._cog(tmp, {"1": 100})
            message = asyncio.run(cog.execute_buy_machine(1, "small"))
            self.assertIn("不足", message)
            self.assertEqual(wallet.balances["1"], 100)
            self.assertEqual(ws_store.machines("1"), [])

    def test_claim_flow_adds_items(self):
        with tempfile.TemporaryDirectory() as tmp:
            cog, wallet, ws_store = self._cog(tmp, {"1": 0})
            item_store = cog._item_store()
            ws_store.add_machine("1", "small", now=datetime.now(items.JST)
                                 - timedelta(hours=4))
            message = cog.execute_claim(1)
            self.assertIn("受け取りました", message)
            self.assertEqual(sum(item_store.inventory("1").values()), 1)
            empty = cog.execute_claim(1)
            self.assertIn("まだ受け取れる生産物がありません", empty)


class RegistryTest(unittest.TestCase):
    def test_workshop_actions_are_registered(self):
        registry = action_registry.default_registry()
        panel = registry.by_id("general:workshop")
        self.assertEqual(panel.genre, "money")
        self.assertNotEqual(panel.risk, "blocked")
        for action_id in ("general:machine_buy", "general:workshop_claim",
                          "general:craft"):
            spec = registry.by_id(action_id)
            self.assertEqual(spec.genre, "money", action_id)
            self.assertEqual(spec.risk, "blocked", action_id)
            self.assertNotIn("aitools", spec.surfaces, action_id)


if __name__ == "__main__":
    unittest.main()
