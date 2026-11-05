"""Phase 4 循環モジュール（core/mining.py・core/lottery.py・core/steal.py と
CirculationCog）のテスト。

見るもの: 各モジュールの保存則（失敗時に残高・所持・状態が不変）、
キャップ類（採掘の個人/日次/グローバル供給、宝くじの購入上限、
盗みの上限と対象保護の閾値）、クールダウン（実行者・対象）、
宝くじの売上→プール→抽選→分配→繰越と払戻率90%、steal のギルド限定と
ゼロサム性、永続化ラウンドトリップ、レジストリ登録。
"""
from __future__ import annotations

import asyncio
import json
import random
import sys
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core import action_registry, items, lottery, mining, steal
from cogs import wallet as wallet_module
from cogs.circulation import CirculationCog

T0 = datetime(2026, 1, 1, 9, 0, tzinfo=items.JST)


class _ScriptedRandom(random.Random):
    """random() がキュー順の値を返す rng（抽選を決め打ちするため）。"""

    def __init__(self, values: list[float]):
        super().__init__()
        self._values = list(values)

    def random(self) -> float:
        if self._values:
            return self._values.pop(0)
        return 0.99


def _write_state(tmp: str, name: str, payload: dict) -> Path:
    path = Path(tmp) / name
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


# ---------------------------------------------------------------------------
# 採掘
# ---------------------------------------------------------------------------

class MiningDefinitionTest(unittest.TestCase):
    def test_yield_table_is_valid(self):
        total_weight = 0
        for yield_items, coins, weight in mining.YIELD_TABLE:
            self.assertGreater(weight, 0)
            self.assertGreaterEqual(coins, 0)
            # 主産物は素材: どの行にも素材が1個以上ある。
            self.assertGreaterEqual(sum(yield_items.values()), 1)
            for item_id, count in yield_items.items():
                self.assertIn(item_id, items.ITEM_DEFS)
                self.assertGreater(count, 0)
            total_weight += weight
        self.assertGreater(total_weight, 0)

    def test_coin_byproduct_is_small_relative_to_materials(self):
        total = sum(w for _i, _c, w in mining.YIELD_TABLE)
        ev_coins = sum(c * w for _i, c, w in mining.YIELD_TABLE) / total
        ev_materials = sum(sum(i.values()) * w for i, _c, w in mining.YIELD_TABLE) / total
        # コイン副産物の期待値は素材の想定価値より十分小さい。
        material_value = sum(
            sum(items.ITEM_DEFS[i]["price"] * n for i, n in row.items()) * w
            for row, _c, w in mining.YIELD_TABLE) / total
        self.assertLess(ev_coins, material_value)
        self.assertGreater(ev_materials, 0)


class MiningStoreTest(unittest.TestCase):
    def test_dig_grants_table_outcome_and_records(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = mining.MiningStore(
                Path(tmp) / "mining.json", rng=_ScriptedRandom([0.0]))
            result = store.dig("1", now=T0)
            self.assertEqual(result["items"], {"scrap": 2})
            self.assertEqual(result["coins"], 0)
            status = store.status("1", T0)
            self.assertEqual(status["today_count"], 1)
            self.assertGreater(status["cooldown_remaining"], 0)

    def test_cooldown_blocks_and_preserves_state(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = mining.MiningStore(
                Path(tmp) / "mining.json", rng=_ScriptedRandom([0.0, 0.0]))
            store.dig("1", now=T0)
            with self.assertRaises(items.ItemError):
                store.dig("1", now=T0 + timedelta(minutes=30))
            self.assertEqual(store.status("1", T0)["today_count"], 1)
            result = store.dig("1", now=T0 + timedelta(hours=1))
            self.assertEqual(result["items"], {"scrap": 2})
            self.assertEqual(
                store.status("1", T0 + timedelta(hours=1))["today_count"], 2)

    def test_daily_user_limit(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = mining.MiningStore(
                Path(tmp) / "mining.json", rng=random.Random(42))
            for hour in range(mining.DAILY_USER_LIMIT):
                store.dig("1", now=T0 + timedelta(hours=hour))
            with self.assertRaises(items.ItemError):
                store.dig("1", now=T0 + timedelta(hours=mining.DAILY_USER_LIMIT))
            status = store.status("1", T0 + timedelta(hours=10))
            self.assertEqual(status["today_count"], mining.DAILY_USER_LIMIT)
            # 日が変わればまた掘れる。
            store.dig("1", now=T0 + timedelta(days=1))
            self.assertEqual(
                store.status("1", T0 + timedelta(days=1))["today_count"], 1)

    def test_global_coin_cap_clamps_to_zero(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = _write_state(tmp, "mining.json", {
                "users": {},
                "daily": {"date": "2026-01-01",
                          "coins": mining.DAILY_GLOBAL_COIN_CAP - 10,
                          "materials": 0},
            })
            store = mining.MiningStore(path, rng=_ScriptedRandom([0.99, 0.99]))
            # コイン80の行を引いても、残量10までしか出ない。
            first = store.dig("1", now=T0)
            self.assertEqual(first["coins"], 10)
            self.assertEqual(first["items"], {"scrap": 2})
            # コイン枠が尽きた後はコインだけ0になり、素材は出る。
            second = store.dig("2", now=T0)
            self.assertEqual(second["coins"], 0)
            self.assertEqual(second["items"], {"scrap": 2})
            status = store.status("1", T0)
            self.assertEqual(status["global_coins_remaining"], 0)

    def test_global_material_cap_trims_and_then_blocks(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = _write_state(tmp, "mining.json", {
                "users": {},
                "daily": {"date": "2026-01-01",
                          "coins": mining.DAILY_GLOBAL_COIN_CAP,
                          "materials": mining.DAILY_GLOBAL_MATERIAL_CAP - 1},
            })
            store = mining.MiningStore(path, rng=_ScriptedRandom([0.0]))
            result = store.dig("1", now=T0)
            self.assertEqual(sum(result["items"].values()), 1)
            self.assertEqual(result["coins"], 0)
            # 両方の枠が尽きたら明示的にエラー（産出ゼロ）。
            with self.assertRaises(items.ItemError):
                store.dig("2", now=T0)

    def test_rollback_restores_state(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = mining.MiningStore(
                Path(tmp) / "mining.json", rng=_ScriptedRandom([0.99]))
            before = store.status("1", T0)
            result = store.dig("1", now=T0)
            self.assertEqual(result["coins"], 80)
            store.rollback_dig("1", result)
            after = store.status("1", T0)
            self.assertEqual(after, before)

    def test_persistence_roundtrip(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "mining.json"
            store = mining.MiningStore(path, rng=_ScriptedRandom([0.0]))
            store.dig("7", now=T0)
            store.flush()
            loaded = mining.MiningStore(path)
            status = loaded.status("7", T0)
            self.assertEqual(status["today_count"], 1)
            self.assertGreater(status["cooldown_remaining"], 0)
            self.assertEqual(
                status["global_materials_remaining"],
                mining.DAILY_GLOBAL_MATERIAL_CAP - 2)


# ---------------------------------------------------------------------------
# 宝くじ
# ---------------------------------------------------------------------------

class LotteryDefinitionTest(unittest.TestCase):
    def test_prize_shares_sum_to_one(self):
        for count, shares in lottery.PRIZE_SHARES.items():
            self.assertEqual(len(shares), count)
            self.assertAlmostEqual(sum(shares), 1.0)

    def test_next_draw_time(self):
        same_day = lottery.next_draw_time(T0)
        self.assertEqual((same_day.day, same_day.hour), (1, lottery.DRAW_HOUR))
        at_close = lottery.next_draw_time(
            datetime(2026, 1, 1, lottery.DRAW_HOUR, 0, tzinfo=items.JST))
        self.assertEqual(at_close.day, 2)
        late = lottery.next_draw_time(datetime(2026, 1, 1, 23, 30, tzinfo=items.JST))
        self.assertEqual((late.day, late.hour), (2, lottery.DRAW_HOUR))


class LotteryStoreTest(unittest.TestCase):
    def _store(self, tmp: str, rng=None) -> lottery.LotteryStore:
        return lottery.LotteryStore(
            Path(tmp) / "lottery.json", rng=rng or random.Random(42))

    def test_add_tickets_and_user_limit(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = self._store(tmp)
            owned = store.add_tickets("1", lottery.MAX_TICKETS_PER_USER, now=T0)
            self.assertEqual(owned, lottery.MAX_TICKETS_PER_USER)
            current = store.current_round(T0)
            self.assertEqual(
                current["pool"], lottery.TICKET_PRICE * lottery.MAX_TICKETS_PER_USER)
            self.assertEqual(store.remaining_allowance("1", T0), 0)
            with self.assertRaises(items.ItemError):
                store.add_tickets("1", 1, now=T0)
            # 失敗してもプールと口数は不変。
            self.assertEqual(store.tickets_of("1", T0), lottery.MAX_TICKETS_PER_USER)
            self.assertEqual(store.current_round(T0)["pool"], current["pool"])

    def test_settle_before_due_is_none(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = self._store(tmp)
            store.add_tickets("1", 1, now=T0)
            self.assertIsNone(store.settle_if_due(now=T0 + timedelta(hours=1)))
            self.assertEqual(store.tickets_of("1", T0), 1)

    def test_settle_no_sales_carries_over_whole_pool(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = _write_state(tmp, "lottery.json", {
                "round": {"id": 5, "pool": 300, "tickets": {},
                          "closes_at": "2026-01-01T21:00:00+09:00"},
                "history": [],
            })
            store = lottery.LotteryStore(path, rng=random.Random(42))
            result = store.settle_if_due(now=T0 + timedelta(hours=13))
            self.assertIsNotNone(result)
            self.assertEqual(result["winners"], [])
            self.assertEqual(result["payout"], 0)
            self.assertEqual(result["burned"], 0)
            self.assertEqual(result["carryover"], 300)
            current = store.current_round(T0 + timedelta(hours=13))
            self.assertEqual(current["id"], 6)
            self.assertEqual(current["pool"], 300)

    def test_settle_single_holder_gets_full_payout(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = self._store(tmp)
            store.add_tickets("1", 10, now=T0)  # プール 1,000
            result = store.settle_if_due(now=T0 + timedelta(hours=13))
            pool = lottery.TICKET_PRICE * 10
            self.assertEqual(result["pool"], pool)
            self.assertEqual(result["burned"], pool - int(pool * lottery.PAYOUT_RATE))
            self.assertEqual(len(result["winners"]), 1)
            self.assertEqual(result["winners"][0]["user_id"], "1")
            self.assertEqual(result["winners"][0]["prize"], int(pool * lottery.PAYOUT_RATE))
            self.assertEqual(result["carryover"], 0)
            # 次ラウンドは繰越0で始まり、チケットはリセットされる。
            self.assertEqual(store.current_round(T0 + timedelta(hours=13))["pool"], 0)
            self.assertEqual(store.tickets_of("1", T0 + timedelta(hours=13)), 0)

    def test_settle_three_holders_shares_and_conservation(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = self._store(tmp, rng=random.Random(7))
            store.add_tickets("a", 5, now=T0)
            store.add_tickets("b", 3, now=T0)
            store.add_tickets("c", 2, now=T0)
            result = store.settle_if_due(now=T0 + timedelta(hours=13))
            pool = lottery.TICKET_PRICE * 10
            payout_total = int(pool * lottery.PAYOUT_RATE)
            prizes = [w["prize"] for w in result["winners"]]
            self.assertEqual(len(prizes), 3)
            self.assertEqual(
                prizes, [int(payout_total * s) for s in lottery.PRIZE_SHARES[3]])
            self.assertEqual(len({w["user_id"] for w in result["winners"]}), 3)
            # 保存則: 賞金＋繰越＋消却＝プール。
            self.assertEqual(
                result["payout"] + result["carryover"] + result["burned"], pool)
            self.assertEqual(result["burned"], pool - payout_total)
            self.assertEqual(
                store.current_round(T0 + timedelta(hours=13))["pool"],
                result["carryover"])

    def test_settle_two_holders_use_two_shares(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = self._store(tmp, rng=random.Random(3))
            store.add_tickets("a", 4, now=T0)
            store.add_tickets("b", 4, now=T0)
            result = store.settle_if_due(now=T0 + timedelta(hours=13))
            payout_total = int(800 * lottery.PAYOUT_RATE)
            self.assertEqual(
                [w["prize"] for w in result["winners"]],
                [int(payout_total * s) for s in lottery.PRIZE_SHARES[2]])

    def test_settle_rounding_leftover_carries_over(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = _write_state(tmp, "lottery.json", {
                "round": {"id": 1, "pool": 1009,
                          "tickets": {"a": 1, "b": 1, "c": 1},
                          "closes_at": "2026-01-01T21:00:00+09:00"},
                "history": [],
            })
            store = lottery.LotteryStore(path, rng=random.Random(42))
            result = store.settle_if_due(now=T0 + timedelta(hours=13))
            payout_total = int(1009 * lottery.PAYOUT_RATE)  # 908
            self.assertEqual(result["burned"], 1009 - payout_total)
            self.assertEqual(result["payout"], 454 + 272 + 181)
            self.assertEqual(result["carryover"], payout_total - result["payout"])
            self.assertEqual(
                store.current_round(T0 + timedelta(hours=13))["pool"], 1)

    def test_draw_is_deterministic_with_same_seed(self):
        outcomes = []
        for _ in range(2):
            with tempfile.TemporaryDirectory() as tmp:
                store = self._store(tmp, rng=random.Random(123))
                store.add_tickets("a", 5, now=T0)
                store.add_tickets("b", 3, now=T0)
                store.add_tickets("c", 2, now=T0)
                result = store.settle_if_due(now=T0 + timedelta(hours=13))
                outcomes.append([w["user_id"] for w in result["winners"]])
        self.assertEqual(outcomes[0], outcomes[1])

    def test_history_is_trimmed(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = self._store(tmp)
            store.current_round(T0)
            for day in range(lottery.HISTORY_LIMIT + 5):
                store.settle_if_due(now=T0 + timedelta(days=day + 1))
            history = store.history()
            self.assertEqual(len(history), lottery.HISTORY_LIMIT)
            self.assertEqual(store.last_result()["round_id"], lottery.HISTORY_LIMIT + 5)

    def test_persistence_roundtrip(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "lottery.json"
            store = lottery.LotteryStore(path, rng=random.Random(42))
            store.add_tickets("9", 3, now=T0)
            store.flush()
            loaded = lottery.LotteryStore(path)
            self.assertEqual(loaded.tickets_of("9", T0), 3)
            self.assertEqual(
                loaded.current_round(T0)["pool"], lottery.TICKET_PRICE * 3)


# ---------------------------------------------------------------------------
# 盗む（core）
# ---------------------------------------------------------------------------

class StealDefinitionTest(unittest.TestCase):
    def test_steal_amount_threshold_and_cap(self):
        self.assertEqual(steal.steal_amount(steal.TARGET_MIN_BALANCE - 1), 0)
        self.assertEqual(
            steal.steal_amount(steal.TARGET_MIN_BALANCE),
            int(steal.TARGET_MIN_BALANCE * steal.STEAL_BALANCE_RATE))
        self.assertEqual(steal.steal_amount(2000), 100)
        self.assertEqual(steal.steal_amount(10**9), steal.STEAL_MAX_AMOUNT)

    def test_fine_amount_capped_by_balance(self):
        self.assertEqual(steal.fine_amount(0), 0)
        self.assertEqual(steal.fine_amount(30), 30)
        self.assertEqual(steal.fine_amount(10**6), steal.FINE_AMOUNT)

    def test_success_rate_boundary(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = steal.StealStore(
                Path(tmp) / "steal.json", rng=_ScriptedRandom([0.39, 0.40]))
            self.assertTrue(store.roll_success())
            self.assertFalse(store.roll_success())


class StealStoreTest(unittest.TestCase):
    def test_actor_and_target_cooldowns(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = steal.StealStore(Path(tmp) / "steal.json")
            store.record_attempt("1", "2", now=T0)
            # 実行者はクールダウン中。
            with self.assertRaises(items.ItemError):
                store.check("1", "3", now=T0 + timedelta(minutes=30))
            # 別の実行者でも、対象は保護期間中。
            with self.assertRaises(items.ItemError):
                store.check("9", "2", now=T0 + timedelta(minutes=30))
            # 1時間後は実行者は動けるが、対象の保護は6時間続く。
            store.check("1", "3", now=T0 + timedelta(hours=1))
            with self.assertRaises(items.ItemError):
                store.check("9", "2", now=T0 + timedelta(hours=5))
            store.check("9", "2", now=T0 + timedelta(hours=6))

    def test_daily_actor_limit(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = steal.StealStore(Path(tmp) / "steal.json")
            for index in range(steal.DAILY_ACTOR_LIMIT):
                store.record_attempt("1", f"t{index}", now=T0 + timedelta(hours=index))
            with self.assertRaises(items.ItemError):
                store.check("1", "other", now=T0 + timedelta(hours=3))
            # 日が変わればリセットされる。
            store.check("1", "other", now=T0 + timedelta(days=1))

    def test_persistence_roundtrip(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "steal.json"
            store = steal.StealStore(path)
            store.record_attempt("5", "6", now=T0)
            store.flush()
            loaded = steal.StealStore(path)
            status = loaded.actor_status("5", T0)
            self.assertEqual(status["today_count"], 1)
            self.assertGreater(status["cooldown_remaining"], 0)
            self.assertGreater(loaded.target_cooldown_remaining("6", T0), 0)


# ---------------------------------------------------------------------------
# Cog フロー
# ---------------------------------------------------------------------------

class _FakeWallet:
    def __init__(self, balances: dict[str, int], fail_credit: bool = False):
        self.balances = dict(balances)
        self.fail_credit = fail_credit

    async def _change_balance(self, user_id, delta, *, require_funds=False,
                               create_with=None):
        if delta > 0 and self.fail_credit:
            return None
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


class CogFlowTest(unittest.TestCase):
    def _cog(self, tmp: str, wallet: _FakeWallet, *,
             mining_rng=None, lottery_rng=None, steal_rng=None):
        item_store = items.ItemStore(Path(tmp) / "items.json", rng=random.Random(42))
        mining_store = mining.MiningStore(
            Path(tmp) / "mining.json", rng=mining_rng or random.Random(42))
        lottery_store = lottery.LotteryStore(
            Path(tmp) / "lottery.json", rng=lottery_rng or random.Random(42))
        steal_store = steal.StealStore(
            Path(tmp) / "steal.json", rng=steal_rng or random.Random(42))
        bot = _FakeBot({"WalletCog": wallet})
        cog = CirculationCog(
            bot, mining_store=mining_store, lottery_store=lottery_store,
            steal_store=steal_store, item_store=item_store,
            balance_reader=lambda uid: wallet.balances.get(uid, 0))
        return cog, item_store

    # ---- 採掘
    def test_mining_flow_grants_items_and_coin_byproduct(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _FakeWallet({})
            cog, item_store = self._cog(tmp, wallet, mining_rng=_ScriptedRandom([0.99]))
            message = asyncio.run(cog.execute_mining(1, now=T0))
            self.assertIn("採掘しました", message)
            self.assertEqual(item_store.count("1", "scrap"), 2)
            # 新規ユーザーは初期残高10＋副産物80。
            self.assertEqual(wallet.balances["1"], wallet_module.NEW_USER_BALANCE + 80)

    def test_mining_flow_rolls_back_when_coin_credit_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _FakeWallet({}, fail_credit=True)
            cog, item_store = self._cog(tmp, wallet, mining_rng=_ScriptedRandom([0.99]))
            message = asyncio.run(cog.execute_mining(1, now=T0))
            self.assertIn("失敗", message)
            status = cog.mining_store.status("1", T0)
            self.assertEqual(status["today_count"], 0)
            self.assertEqual(status["cooldown_remaining"], 0)
            self.assertEqual(item_store.count("1", "scrap"), 0)

    def test_mining_flow_cooldown_message(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _FakeWallet({})
            cog, _store = self._cog(tmp, wallet, mining_rng=_ScriptedRandom([0.0, 0.0]))
            asyncio.run(cog.execute_mining(1, now=T0))
            message = asyncio.run(cog.execute_mining(1, now=T0))
            self.assertIn("1時間に1回まで", message)

    # ---- 宝くじ
    def test_lottery_buy_flow(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _FakeWallet({"1": 1000})
            cog, _store = self._cog(tmp, wallet)
            message = asyncio.run(cog.execute_lottery_buy(1, 3, now=T0))
            self.assertIn("購入しました", message)
            self.assertEqual(wallet.balances["1"], 1000 - 3 * lottery.TICKET_PRICE)
            self.assertEqual(cog.lottery_store.tickets_of("1", T0), 3)
            self.assertEqual(
                cog.lottery_store.current_round(T0)["pool"], 3 * lottery.TICKET_PRICE)

    def test_lottery_buy_insufficient_changes_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _FakeWallet({"1": 50})
            cog, _store = self._cog(tmp, wallet)
            message = asyncio.run(cog.execute_lottery_buy(1, 1, now=T0))
            self.assertIn("不足", message)
            self.assertEqual(wallet.balances["1"], 50)
            self.assertEqual(cog.lottery_store.tickets_of("1", T0), 0)
            self.assertEqual(cog.lottery_store.current_round(T0)["pool"], 0)

    def test_lottery_buy_over_limit_changes_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _FakeWallet({"1": 100000})
            cog, _store = self._cog(tmp, wallet)
            asyncio.run(
                cog.execute_lottery_buy(1, lottery.MAX_TICKETS_PER_USER, now=T0))
            balance = wallet.balances["1"]
            message = asyncio.run(cog.execute_lottery_buy(1, 1, now=T0))
            self.assertIn("枚まで", message)
            self.assertEqual(wallet.balances["1"], balance)
            self.assertEqual(
                cog.lottery_store.tickets_of("1", T0), lottery.MAX_TICKETS_PER_USER)

    def test_lottery_settle_pays_winners_via_wallet(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _FakeWallet({"1": 1000, "2": 1000})
            cog, _store = self._cog(tmp, wallet, lottery_rng=random.Random(11))
            asyncio.run(cog.execute_lottery_buy(1, 5, now=T0))
            asyncio.run(cog.execute_lottery_buy(2, 5, now=T0))
            before = dict(wallet.balances)
            result = asyncio.run(cog.settle_lottery(now=T0 + timedelta(hours=13)))
            self.assertIsNotNone(result)
            pool = 10 * lottery.TICKET_PRICE
            paid = sum(
                wallet.balances[w["user_id"]] - before[w["user_id"]]
                for w in result["winners"])
            self.assertEqual(paid, result["payout"])
            self.assertEqual(
                result["payout"] + result["carryover"] + result["burned"], pool)
            self.assertEqual(result["burned"], pool - int(pool * lottery.PAYOUT_RATE))

    # ---- 盗む
    def test_steal_requires_same_guild(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _FakeWallet({"1": 1000, "2": 10000})
            cog, _store = self._cog(tmp, wallet, steal_rng=_ScriptedRandom([0.0]))
            message = asyncio.run(cog.execute_steal(1, 2, in_guild=False, now=T0))
            self.assertIn("同じサーバー", message)
            self.assertEqual(wallet.balances, {"1": 1000, "2": 10000})
            self.assertEqual(cog.steal_store.actor_status("1", T0)["today_count"], 0)

    def test_steal_rejects_self_and_bot(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _FakeWallet({"1": 1000, "2": 10000})
            cog, _store = self._cog(tmp, wallet, steal_rng=_ScriptedRandom([0.0]))
            self.assertIn("自分からは", asyncio.run(
                cog.execute_steal(1, 1, in_guild=True, now=T0)))
            self.assertIn("Botからは", asyncio.run(
                cog.execute_steal(1, 2, in_guild=True, target_is_bot=True, now=T0)))
            self.assertEqual(wallet.balances, {"1": 1000, "2": 10000})

    def test_steal_protects_poor_target_without_recording(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _FakeWallet({"1": 1000, "2": steal.TARGET_MIN_BALANCE - 1})
            cog, _store = self._cog(tmp, wallet, steal_rng=_ScriptedRandom([0.0]))
            message = asyncio.run(cog.execute_steal(1, 2, in_guild=True, now=T0))
            self.assertIn("保護されます", message)
            self.assertEqual(
                wallet.balances, {"1": 1000, "2": steal.TARGET_MIN_BALANCE - 1})
            self.assertEqual(cog.steal_store.actor_status("1", T0)["today_count"], 0)
            self.assertEqual(cog.steal_store.target_cooldown_remaining("2", T0), 0)

    def test_steal_success_is_zero_sum_and_capped(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _FakeWallet({"1": 1000, "2": 10000})
            cog, _store = self._cog(tmp, wallet, steal_rng=_ScriptedRandom([0.0]))
            message = asyncio.run(cog.execute_steal(1, 2, in_guild=True, now=T0))
            self.assertIn("成功", message)
            # 10,000 の 5% = 500（上限ちょうど）。総和は不変（ゼロサム）。
            self.assertEqual(wallet.balances, {"1": 1500, "2": 9500})
            self.assertEqual(sum(wallet.balances.values()), 11000)
            self.assertEqual(cog.steal_store.actor_status("1", T0)["today_count"], 1)
            # 直後の再実行はクールダウンで止まり、残高は不変。
            message = asyncio.run(cog.execute_steal(1, 2, in_guild=True, now=T0))
            self.assertIn("1時間に1回まで", message)
            self.assertEqual(wallet.balances, {"1": 1500, "2": 9500})

    def test_steal_failure_pays_fine_zero_sum(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _FakeWallet({"1": 1000, "2": 10000})
            cog, _store = self._cog(tmp, wallet, steal_rng=_ScriptedRandom([0.99]))
            message = asyncio.run(cog.execute_steal(1, 2, in_guild=True, now=T0))
            self.assertIn("失敗", message)
            self.assertEqual(
                wallet.balances, {"1": 1000 - steal.FINE_AMOUNT,
                                  "2": 10000 + steal.FINE_AMOUNT})
            self.assertEqual(sum(wallet.balances.values()), 11000)

    def test_steal_failure_fine_limited_by_actor_balance(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _FakeWallet({"1": 30, "2": 10000})
            cog, _store = self._cog(tmp, wallet, steal_rng=_ScriptedRandom([0.99]))
            asyncio.run(cog.execute_steal(1, 2, in_guild=True, now=T0))
            self.assertEqual(wallet.balances, {"1": 0, "2": 10030})


class RegistryTest(unittest.TestCase):
    def test_circulation_actions_are_registered(self):
        registry = action_registry.default_registry()
        panel = registry.by_id("general:lottery")
        self.assertEqual(panel.genre, "money")
        self.assertNotEqual(panel.risk, "blocked")
        for action_id in ("general:mining", "general:lottery_buy", "general:steal"):
            spec = registry.by_id(action_id)
            self.assertEqual(spec.genre, "money", action_id)
            self.assertEqual(spec.risk, "blocked", action_id)
            self.assertNotIn("aitools", spec.surfaces, action_id)


if __name__ == "__main__":
    unittest.main()
