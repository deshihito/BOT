"""Phase 4 循環モジュール（core/mining.py・core/lottery.py・core/steal.py と
CirculationCog）のテスト。

見るもの: 各モジュールの保存則（失敗時に残高・所持・状態が不変）、
制限類（宝くじの購入上限、盗みの上限と対象保護の閾値）、
クールダウン（実行者・対象）、宝くじの売上→プール→抽選→分配→繰越と
払戻率90%、steal のギルド限定とゼロサム性、永続化ラウンドトリップ、
レジストリ登録。

採掘は 2026-11-06 の再仕様で原典準拠（セッション式＋損失還流プール
払い）になった。旧仕様の日次キャップ類のテストは、セッション・
クールダウン・プール clamp のテストに置き換えてある。
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

from core import action_registry, economy_pool, items, lottery, mining, steal
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

class _StubRng:
    """採掘用 rng スタブ: randint/random/uniform を決め打ちする。"""

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


class MiningDefinitionTest(unittest.TestCase):
    def test_constants_match_original(self):
        # 原典 main.py の MiningView の値そのまま。
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

    def test_old_daily_caps_are_gone(self):
        # 旧 AGO 仕様（素材テーブル・個人/日次/グローバルキャップ）は廃止。
        for name in ("YIELD_TABLE", "DAILY_USER_LIMIT", "COOLDOWN_HOURS",
                     "DAILY_GLOBAL_COIN_CAP", "DAILY_GLOBAL_MATERIAL_CAP"):
            self.assertFalse(hasattr(mining, name), name)


class MiningStoreTest(unittest.TestCase):
    def test_session_grants_digs_and_dig_pays_base(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = mining.MiningStore(
                Path(tmp) / "mining.json",
                rng=_StubRng(ints=[3, 300], floats=[0.99, 0.99]))
            self.assertEqual(store.start_session("1", now=T0), 3)
            result = store.dig("1", 10_000, now=T0)
            self.assertEqual(result["coins"], 300)
            self.assertFalse(result["failed"])
            self.assertFalse(result["jackpot"])
            status = store.status("1", T0)
            self.assertEqual(status["session_left"], 2)
            self.assertGreater(status["cooldown_remaining"], 0)

    def test_start_session_keeps_existing_session(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = mining.MiningStore(
                Path(tmp) / "mining.json", rng=_StubRng(ints=[5]))
            self.assertEqual(store.start_session("1", now=T0), 5)
            # セッションが残っている間は振り直さず、残りをそのまま返す。
            self.assertEqual(store.start_session("1", now=T0), 5)

    def test_cooldown_blocks_new_session_and_preserves_state(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = mining.MiningStore(
                Path(tmp) / "mining.json",
                rng=_StubRng(ints=[1, 100, 2], floats=[0.99, 0.99]))
            store.start_session("1", now=T0)
            store.dig("1", 10_000, now=T0)
            with self.assertRaises(items.ItemError):
                store.start_session("1", now=T0 + timedelta(seconds=30))
            self.assertEqual(
                store.status("1", T0 + timedelta(seconds=30))["session_left"], 0)
            # 60秒経てば次のセッションが始まる。
            self.assertEqual(
                store.start_session("1", now=T0 + timedelta(seconds=61)), 2)

    def test_dig_requires_session(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = mining.MiningStore(
                Path(tmp) / "mining.json", rng=_StubRng())
            with self.assertRaises(items.ItemError):
                store.dig("1", 10_000, now=T0)

    def test_failed_roll_pays_zero(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = mining.MiningStore(
                Path(tmp) / "mining.json",
                rng=_StubRng(ints=[2, 400], floats=[0.0, 0.99]))
            store.start_session("1", now=T0)
            result = store.dig("1", 10_000, now=T0)
            self.assertTrue(result["failed"])
            self.assertEqual(result["coins"], 0)

    def test_jackpot_adds_pool_share(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = mining.MiningStore(
                Path(tmp) / "mining.json",
                rng=_StubRng(ints=[2, 100], floats=[0.99, 0.05],
                             uniform_value=0.05))
            store.start_session("1", now=T0)
            result = store.dig("1", 100_000, now=T0)
            self.assertTrue(result["jackpot"])
            self.assertEqual(result["extra"], 5_000)
            self.assertEqual(result["coins"], 5_100)

    def test_payment_clamped_to_pool_balance(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = mining.MiningStore(
                Path(tmp) / "mining.json",
                rng=_StubRng(ints=[2, 500], floats=[0.99, 0.99]))
            store.start_session("1", now=T0)
            result = store.dig("1", 120, now=T0)
            self.assertEqual(result["requested"], 500)
            self.assertEqual(result["coins"], 120)

    def test_rollback_restores_state(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = mining.MiningStore(
                Path(tmp) / "mining.json",
                rng=_StubRng(ints=[4, 250], floats=[0.99, 0.99]))
            store.start_session("1", now=T0)
            before = store.status("1", T0)
            result = store.dig("1", 10_000, now=T0)
            self.assertEqual(result["coins"], 250)
            store.rollback_dig("1", result)
            self.assertEqual(store.status("1", T0), before)

    def test_persistence_roundtrip(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "mining.json"
            store = mining.MiningStore(
                path, rng=_StubRng(ints=[6, 100], floats=[0.99, 0.99]))
            store.start_session("7", now=T0)
            store.dig("7", 10_000, now=T0)
            store.flush()
            loaded = mining.MiningStore(path)
            status = loaded.status("7", T0)
            self.assertEqual(status["session_left"], 5)
            self.assertGreater(status["cooldown_remaining"], 0)

    def test_legacy_state_migration_keeps_last_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = _write_state(tmp, "mining.json", {
                "users": {"7": {"last": T0.isoformat(),
                                "day": "2026-01-01", "count": 3}},
                "daily": {"date": "2026-01-01", "coins": 5, "materials": 5},
            })
            store = mining.MiningStore(path)
            status = store.status("7", T0)
            self.assertEqual(status["session_left"], 0)
            self.assertGreater(status["cooldown_remaining"], 0)


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
        economy_store = economy_pool.EconomyPoolStore(
            Path(tmp) / "economy_pool.json")
        bot = _FakeBot({"WalletCog": wallet})
        cog = CirculationCog(
            bot, mining_store=mining_store, lottery_store=lottery_store,
            steal_store=steal_store, item_store=item_store,
            balance_reader=lambda uid: wallet.balances.get(uid, 0),
            economy_store=economy_store)
        return cog, item_store

    # ---- 採掘
    def test_mining_flow_pays_from_pool(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _FakeWallet({})
            cog, _store = self._cog(
                tmp, wallet,
                mining_rng=_StubRng(ints=[3, 300], floats=[0.99, 0.99]))
            cog.economy_store.add_loss(10_000)  # プール 7,000
            message = asyncio.run(cog.execute_mining(1, now=T0))
            self.assertIn("300 AGO を採掘しました", message)
            # 新規ユーザーは初期残高10＋採掘300。支払いはプールから。
            self.assertEqual(wallet.balances["1"], wallet_module.NEW_USER_BALANCE + 300)
            self.assertEqual(cog.economy_store.pool_balance(), 7_000 - 300)
            self.assertEqual(cog.mining_store.status("1", T0)["session_left"], 2)

    def test_mining_flow_empty_pool_digs_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _FakeWallet({})
            cog, _store = self._cog(tmp, wallet, mining_rng=_StubRng(ints=[3]))
            message = asyncio.run(cog.execute_mining(1, now=T0))
            self.assertIn("プールにコインがありません", message)
            self.assertNotIn("1", wallet.balances)
            # セッションは始まっているが回数は消費されていない。
            self.assertEqual(cog.mining_store.status("1", T0)["session_left"], 3)

    def test_mining_flow_rolls_back_when_coin_credit_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _FakeWallet({}, fail_credit=True)
            cog, _store = self._cog(
                tmp, wallet,
                mining_rng=_StubRng(ints=[3, 300], floats=[0.99, 0.99]))
            cog.economy_store.add_loss(10_000)
            message = asyncio.run(cog.execute_mining(1, now=T0))
            self.assertIn("失敗", message)
            # プールは払い戻され、セッション回数も戻る。
            self.assertEqual(cog.economy_store.pool_balance(), 7_000)
            self.assertEqual(cog.mining_store.status("1", T0)["session_left"], 3)

    def test_mining_flow_cooldown_message(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _FakeWallet({})
            cog, _store = self._cog(
                tmp, wallet,
                mining_rng=_StubRng(ints=[1, 100], floats=[0.99, 0.99]))
            cog.economy_store.add_loss(10_000)
            asyncio.run(cog.execute_mining(1, now=T0))
            message = asyncio.run(cog.execute_mining(1, now=T0))
            self.assertIn("クールタイム中", message)

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
