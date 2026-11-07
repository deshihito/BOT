# -*- coding: utf-8 -*-
"""セーフティ修正クラスタ2（circulation／採掘／steal／宝くじ）の回帰テスト。

対象: E-3（steal 同時実行の予約方式）、E-4（rollback_dig 差分方式）、
E-8c（プリズンマイナー消費タイミング）、E-15（採掘の持続速度抑制＝
掘り間隔の不足分を掘り切り後のクールダウンへ加算）、E-1（宝くじ確定と
採掘プール控除の flush-before-wallet）、E-5c（宝くじ購入の返金失敗時
の critical ログ＋運営連絡文言）。
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

from core.general import steal
from core.game import lottery, mining
from core.game.game import prison as prison_core
from core.general import economy_pool, items
from cogs import wallet as wallet_module
from cogs.circulation import CirculationCog

T0 = datetime(2026, 1, 1, 9, 0, tzinfo=items.JST)


class _ScriptedRandom(random.Random):
    def __init__(self, values):
        super().__init__()
        self._values = list(values)

    def random(self):
        return self._values.pop(0) if self._values else 0.99


class _StubRng:
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
    """fail_credit: 正の delta は常に None。fail_refunds: {(uid, delta)} は None。

    on_credit: 正の delta の適用前に呼ばれる観測フック（flush 順序の検証用）。
    """

    def __init__(self, balances=None, *, fail_credit=False, fail_refunds=(),
                 on_credit=None, delay=False):
        self.balances = dict(balances or {})
        self.fail_credit = fail_credit
        self.fail_refunds = set(fail_refunds)
        self.on_credit = on_credit
        self.delay = delay

    async def _change_balance(self, user_id, delta, *, require_funds=False,
                              create_with=None):
        if self.delay:
            await asyncio.sleep(0)
            await asyncio.sleep(0)
        if delta > 0:
            if self.on_credit is not None:
                self.on_credit(user_id, delta)
            if self.fail_credit or (str(user_id), delta) in self.fail_refunds:
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
    def __init__(self, cogs):
        self._cogs = cogs

    def get_cog(self, name):
        return self._cogs.get(name)


def _make_cog(tmp, wallet, *, mining_rng=None, lottery_rng=None,
              steal_rng=None, prison_store=None):
    item_store = items.ItemStore(Path(tmp) / "items.json", rng=random.Random(42))
    cog = CirculationCog(
        _FakeBot({"WalletCog": wallet}),
        mining_store=mining.MiningStore(
            Path(tmp) / "mining.json", rng=mining_rng or random.Random(42)),
        lottery_store=lottery.LotteryStore(
            Path(tmp) / "lottery.json", rng=lottery_rng or random.Random(42)),
        steal_store=steal.StealStore(
            Path(tmp) / "steal.json", rng=steal_rng or random.Random(42)),
        item_store=item_store,
        balance_reader=lambda uid: wallet.balances.get(uid, 0),
        economy_store=economy_pool.EconomyPoolStore(Path(tmp) / "economy.json"),
        prison_store=prison_store or prison_core.PrisonStore(
            Path(tmp) / "prison.json"),
    )
    return cog, item_store


# ---------------------------------------------------------------------------
# E-3: steal 予約方式
# ---------------------------------------------------------------------------

class StealReserveStoreTest(unittest.TestCase):
    def test_reserve_blocks_second_actor_and_target(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = steal.StealStore(Path(tmp) / "steal.json")
            reservation = store.reserve("1", "2", now=T0)
            # 同一 actor の2件目は、await を挟まなくても即座に弾かれる。
            with self.assertRaises(items.ItemError):
                store.reserve("1", "3", now=T0)
            # 同一対象への別 actor の実行も対象保護で弾かれる。
            with self.assertRaises(items.ItemError):
                store.reserve("9", "2", now=T0)
            store.commit_reservation(reservation)
            # 確定後は従来どおりクールダウン・回数が残る。
            self.assertEqual(store.actor_status("1", T0)["today_count"], 1)
            with self.assertRaises(items.ItemError):
                store.check("1", "3", now=T0 + timedelta(minutes=30))
            self.assertGreater(store.target_cooldown_remaining("2", T0), 0)

    def test_reserve_rollback_restores_pre_state(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = steal.StealStore(Path(tmp) / "steal.json")
            reservation = store.reserve("1", "2", now=T0)
            store.rollback_reservation(reservation)
            self.assertEqual(store.actor_status("1", T0)["today_count"], 0)
            self.assertEqual(store.actor_status("1", T0)["cooldown_remaining"], 0)
            self.assertEqual(store.target_cooldown_remaining("2", T0), 0)
            # ロールバック後は再予約できる（冪等でもある）。
            store.rollback_reservation(reservation)
            again = store.reserve("1", "2", now=T0)
            store.commit_reservation(again)
            self.assertEqual(store.actor_status("1", T0)["today_count"], 1)

    def test_reserve_enforces_daily_limit_atomically(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = steal.StealStore(Path(tmp) / "steal.json")
            for index in range(steal.DAILY_ACTOR_LIMIT):
                reservation = store.reserve(
                    "1", f"t{index}", now=T0 + timedelta(hours=index))
                store.commit_reservation(reservation)
            with self.assertRaises(items.ItemError):
                store.reserve("1", "other", now=T0 + timedelta(hours=3))


class StealConcurrentCogTest(unittest.TestCase):
    def test_concurrent_steal_second_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _FakeWallet({"1": 1000, "2": 10000}, delay=True)
            cog, _items = _make_cog(
                tmp, wallet, steal_rng=_ScriptedRandom([0.0]))

            async def both():
                return await asyncio.gather(
                    cog.execute_steal(1, 2, in_guild=True, now=T0),
                    cog.execute_steal(1, 2, in_guild=True, now=T0),
                )

            first, second = asyncio.run(both())
            self.assertIn("成功", first)
            self.assertIn("1時間に1回まで", second)
            # 盗みは1回分だけ成立し、ゼロサムのまま。
            self.assertEqual(wallet.balances, {"1": 1500, "2": 9500})
            self.assertEqual(
                cog.steal_store.actor_status("1", T0)["today_count"], 1)

    def test_failed_credit_rolls_back_reservation(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _FakeWallet({"1": 1000, "2": 10000}, fail_credit=True)
            cog, _items = _make_cog(
                tmp, wallet, steal_rng=_ScriptedRandom([0.0]))
            message = asyncio.run(cog.execute_steal(1, 2, in_guild=True, now=T0))
            self.assertIn("失敗", message)
            # 予約は巻き戻され、クールダウン・回数・対象保護は残らない。
            self.assertEqual(
                cog.steal_store.actor_status("1", T0)["today_count"], 0)
            self.assertEqual(cog.steal_store.target_cooldown_remaining("2", T0), 0)


# ---------------------------------------------------------------------------
# E-4: rollback_dig 差分方式
# ---------------------------------------------------------------------------

class MiningRollbackDiffTest(unittest.TestCase):
    def test_rollback_preserves_concurrent_dig_consumption(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = mining.MiningStore(
                Path(tmp) / "mining.json",
                rng=_StubRng(ints=[3, 100, 200], floats=[0.99] * 4))
            store.start_session("1", now=T0)
            result_a = store.dig("1", 10_000, now=T0)
            result_b = store.dig("1", 10_000, now=T0 + timedelta(seconds=10))
            self.assertEqual(result_b["session_left"], 1)
            store.rollback_dig("1", result_a)
            # A の1回分だけが戻り、B の消費は巻き戻らない（旧スナップ
            # ショット方式では 3 に戻っていた）。
            self.assertEqual(store.status("1", T0)["session_left"], 2)

    def test_rollback_reopens_finished_direct_session(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = mining.MiningStore(
                Path(tmp) / "mining.json",
                rng=_StubRng(ints=[1, 100, 100], floats=[0.99] * 4))
            store.start_session("1", now=T0, direct=True)
            result = store.dig("1", 10_000, now=T0)
            self.assertEqual(result["session_left"], 0)
            self.assertFalse(store.status("1", T0)["direct"])
            store.rollback_dig("1", result)
            status = store.status("1", T0)
            self.assertEqual(status["session_left"], 1)
            self.assertTrue(status["direct"])
            # 戻した1回はそのまま掘り直せる。
            again = store.dig("1", 10_000, now=T0 + timedelta(seconds=10))
            self.assertEqual(again["session_left"], 0)


# ---------------------------------------------------------------------------
# E-8c: プリズンマイナーの消費タイミング
# ---------------------------------------------------------------------------

class PrisonMinerTimingTest(unittest.TestCase):
    def _imprisoned_cog(self, tmp, wallet, **kwargs):
        prison_store = prison_core.PrisonStore(Path(tmp) / "prison.json")
        prison_store.imprison("1", minutes=30, now=T0)
        cog, item_store = _make_cog(
            tmp, wallet, prison_store=prison_store, **kwargs)
        item_store.add("1", items.PRISON_MINER_ITEM, 1)
        return cog, item_store

    def test_not_consumed_when_pool_empty(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _FakeWallet({})
            cog, item_store = self._imprisoned_cog(
                tmp, wallet, mining_rng=_StubRng(ints=[3]))
            message = asyncio.run(cog.execute_mining(1, now=T0))
            self.assertIn("プールにコインがありません", message)
            self.assertEqual(item_store.count("1", items.PRISON_MINER_ITEM), 1)

    def test_not_consumed_during_mining_cooldown(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _FakeWallet({})
            cog, item_store = self._imprisoned_cog(
                tmp, wallet,
                mining_rng=_StubRng(ints=[1, 100], floats=[0.99, 0.99]))
            # 先にセッションを掘り切ってクールダウン中にする。
            cog.mining_store.start_session("1", now=T0)
            cog.mining_store.dig("1", 10_000, now=T0)
            cog.economy_store.add_loss(100_000)  # プールは十分ある
            message = asyncio.run(cog.execute_mining(1, now=T0))
            self.assertIn("クールタイム中", message)
            self.assertEqual(item_store.count("1", items.PRISON_MINER_ITEM), 1)

    def test_consumed_when_dig_actually_happens(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _FakeWallet({})
            cog, item_store = self._imprisoned_cog(
                tmp, wallet,
                mining_rng=_StubRng(ints=[3, 300], floats=[0.99, 0.99]))
            cog.economy_store.add_loss(100_000)
            message = asyncio.run(cog.execute_mining(1, now=T0))
            self.assertIn("採掘しました", message)
            self.assertEqual(item_store.count("1", items.PRISON_MINER_ITEM), 0)


# ---------------------------------------------------------------------------
# E-15: 掘り間隔の不足分の加算（持続速度の抑制）
# ---------------------------------------------------------------------------

class MiningIntervalDebtTest(unittest.TestCase):
    def test_burst_digging_extends_next_session_wait(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = mining.MiningStore(
                Path(tmp) / "mining.json",
                rng=_StubRng(ints=[5, 100, 100, 100, 100, 100, 4],
                             floats=[0.99] * 10))
            self.assertEqual(store.start_session("1", now=T0), 5)
            for _ in range(5):
                store.dig("1", 10_000, now=T0)  # 全て同じ時刻＝連続即掘り
            # 従来は開始+61秒で次セッションが始まったが、間隔不足分
            # （4回 × 3秒）が加算され、まだ始まらない。
            with self.assertRaises(items.ItemError):
                store.start_session("1", now=T0 + timedelta(seconds=61))
            # 開始+60秒+不足分12秒を過ぎれば始まる。
            self.assertEqual(
                store.start_session("1", now=T0 + timedelta(seconds=73)), 4)

    def test_spaced_digging_keeps_original_cooldown(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = mining.MiningStore(
                Path(tmp) / "mining.json",
                rng=_StubRng(ints=[3, 100, 100, 100, 2], floats=[0.99] * 6))
            store.start_session("1", now=T0)
            for index in range(3):
                store.dig("1", 10_000, now=T0 + timedelta(seconds=10 * index))
            # 間隔（10秒≥3秒）を守れば不足分は0で、従来どおり+61秒で開始。
            self.assertEqual(
                store.start_session("1", now=T0 + timedelta(seconds=61)), 2)

    def test_per_dig_roll_spec_unchanged(self):
        # 定数（原典準拠の確率構造・回数レンジ）は一切変えていない。
        self.assertEqual(mining.COOLDOWN_SECONDS, 60)
        self.assertEqual(
            (mining.SESSION_MIN_DIGS, mining.SESSION_MAX_DIGS), (1, 20))
        self.assertEqual(
            (mining.BASE_MIN_COINS, mining.BASE_MAX_COINS), (10, 500))
        self.assertEqual(mining.FAIL_RATE, 0.20)
        self.assertEqual(mining.JACKPOT_RATE, 0.10)
        self.assertEqual(
            (mining.JACKPOT_POOL_MIN_RATE, mining.JACKPOT_POOL_MAX_RATE),
            (0.01, 0.10))
        with tempfile.TemporaryDirectory() as tmp:
            store = mining.MiningStore(
                Path(tmp) / "mining.json",
                rng=_StubRng(ints=[2, 300], floats=[0.99, 0.99]))
            store.start_session("1", now=T0)
            result = store.dig("1", 10_000, now=T0)
            self.assertEqual(result["coins"], 300)
            self.assertFalse(result["failed"])
            self.assertFalse(result["jackpot"])
            store = mining.MiningStore(
                Path(tmp) / "mining2.json",
                rng=_StubRng(ints=[2, 100], floats=[0.99, 0.05],
                             uniform_value=0.05))
            store.start_session("1", now=T0)
            result = store.dig("1", 100_000, now=T0)
            self.assertTrue(result["jackpot"])
            self.assertEqual(result["extra"], 5_000)
            self.assertEqual(result["coins"], 5_100)


# ---------------------------------------------------------------------------
# E-1: flush-before-wallet
# ---------------------------------------------------------------------------

class FlushBeforeWalletTest(unittest.TestCase):
    def test_mining_pool_flushed_before_credit(self):
        with tempfile.TemporaryDirectory() as tmp:
            economy_path = Path(tmp) / "economy.json"
            observed = {}

            def on_credit(uid, delta):
                try:
                    observed["pool"] = json.loads(
                        economy_path.read_text(encoding="utf-8"))["pool"]
                except Exception:
                    observed["pool"] = None

            wallet = _FakeWallet({}, on_credit=on_credit)
            cog, _items = _make_cog(
                tmp, wallet,
                mining_rng=_StubRng(ints=[3, 300], floats=[0.99, 0.99]))
            cog.economy_store.add_loss(10_000)  # プール 7,000（メモリのみ）
            message = asyncio.run(cog.execute_mining(1, now=T0))
            self.assertIn("採掘しました", message)
            # credit 時点で、控除後のプール残高が既にディスクへ出ている。
            self.assertEqual(observed.get("pool"), 7_000 - 300)

    def test_lottery_settlement_flushed_before_prizes(self):
        with tempfile.TemporaryDirectory() as tmp:
            lottery_path = Path(tmp) / "lottery.json"
            observed = []

            def on_credit(uid, delta):
                try:
                    state = json.loads(lottery_path.read_text(encoding="utf-8"))
                    observed.append(
                        (state["round"]["id"], len(state["history"])))
                except Exception:
                    observed.append(None)

            wallet = _FakeWallet({"1": 1000, "2": 1000}, on_credit=on_credit)
            cog, _items = _make_cog(tmp, wallet, lottery_rng=random.Random(11))
            asyncio.run(cog.execute_lottery_buy(1, 5, now=T0))
            asyncio.run(cog.execute_lottery_buy(2, 5, now=T0))
            result = asyncio.run(
                cog.settle_lottery(now=T0 + timedelta(hours=13)))
            self.assertIsNotNone(result)
            self.assertTrue(observed)
            # 全ての賞金 credit の時点で、確定済み（次ラウンド id=2・
            # 履歴1件）が既にディスクへ出ている。
            self.assertTrue(all(entry == (2, 1) for entry in observed))


# ---------------------------------------------------------------------------
# E-5c: 宝くじ購入の返金失敗
# ---------------------------------------------------------------------------

class LotteryBuyRefundTest(unittest.TestCase):
    def _cog_with_failing_add(self, tmp, wallet):
        cog, _items = _make_cog(tmp, wallet)

        def boom(uid, count, now=None):
            raise items.ItemError("テスト用の購入失敗")

        cog.lottery_store.add_tickets = boom
        return cog

    def test_refund_failure_logs_critical_and_tells_to_contact_ops(self):
        with tempfile.TemporaryDirectory() as tmp:
            total = lottery.TICKET_PRICE * 3
            wallet = _FakeWallet({"1": 1000}, fail_refunds={("1", total)})
            cog = self._cog_with_failing_add(tmp, wallet)
            with self.assertLogs(level="CRITICAL"):
                message = asyncio.run(cog.execute_lottery_buy(1, 3, now=T0))
            self.assertIn("テスト用の購入失敗", message)
            self.assertIn("運営へ連絡", message)
            # debit は成立し返金が失敗したので、残高は減ったままである
            # ことが文言とログで追える（黙って消えない）。
            self.assertEqual(wallet.balances["1"], 1000 - total)

    def test_successful_refund_keeps_original_message(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _FakeWallet({"1": 1000})
            cog = self._cog_with_failing_add(tmp, wallet)
            message = asyncio.run(cog.execute_lottery_buy(1, 3, now=T0))
            self.assertIn("テスト用の購入失敗", message)
            self.assertNotIn("運営へ連絡", message)
            self.assertEqual(wallet.balances["1"], 1000)


class BatonConsumptionOrderTest(unittest.TestCase):
    """E-5c: 罰金移転が失敗した場合、警棒は消費されない。"""

    def test_baton_not_consumed_when_fine_transfer_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _FakeWallet({"1": 1000, "2": 10000})
            cog, item_store = _make_cog(tmp, wallet)
            item_store.add("2", items.DAI_BATON_ITEM, 1)

            async def failing_fine(actor, target):
                return 0, "コインの更新に失敗しました。残高は変わっていません。"

            cog._transfer_fine = failing_fine
            message = asyncio.run(cog.execute_steal(1, 2, in_guild=True, now=T0))
            self.assertIn("失敗", message)
            # 警棒は残り、逮捕も試行記録も残らない。
            self.assertEqual(item_store.count("2", items.DAI_BATON_ITEM), 1)
            self.assertIsNone(
                prison_core.block_message("1", now=T0, store=cog.prison_store))
            self.assertEqual(
                cog.steal_store.actor_status("1", T0)["today_count"], 0)

    def test_baton_consumed_when_fine_transfer_succeeds(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _FakeWallet({"1": 1000, "2": 10000})
            cog, item_store = _make_cog(tmp, wallet)
            item_store.add("2", items.DAI_BATON_ITEM, 1)
            message = asyncio.run(cog.execute_steal(1, 2, in_guild=True, now=T0))
            self.assertIn("撃退", message)
            self.assertEqual(item_store.count("2", items.DAI_BATON_ITEM), 0)
            self.assertIsNotNone(
                prison_core.block_message("1", now=T0, store=cog.prison_store))


if __name__ == "__main__":
    unittest.main()
