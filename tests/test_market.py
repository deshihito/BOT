"""core/general/market.py（アゴトークン市場）と /general への登録のテスト。

見るもの: レートエンジンが暴走しないこと（決定論的シード）、clamp／バンド／
サーキットブレーカー、手数料と取引上限、プールの保存則
（トークン総量不変・コインはプール経由のみ）、保存と読み戻し、
参照系に副作用がないこと、レジストリへの登録と AI tools の対象外化。
"""
from __future__ import annotations

import random
import sys
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core import action_registry
from core.general import market


class _QuietRandom(random.Random):
    """ノイズゼロの乱数（反発など決定論的な動きだけを見る用）。"""

    def random(self):
        return 0.99

    def gauss(self, mu, sigma):
        return 0.0

    def uniform(self, a, b):
        return 0.0

    def choice(self, seq):
        return seq[0]


def _store(tmp: str, rng=None) -> market.MarketStore:
    return market.MarketStore(Path(tmp) / "market.json", rng=rng or random.Random(42))


class RateEngineTest(unittest.TestCase):
    def test_long_run_stays_bounded_with_seed(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = _store(tmp, random.Random(42))
            now = datetime(2026, 1, 1, tzinfo=market.JST)
            rates = []
            for i in range(30 * 24 * 12):  # 30日分
                rates.append(store.tick(now + timedelta(minutes=5 * i)))
            self.assertTrue(all(market.RATE_MIN <= r <= market.RATE_MAX for r in rates))
            # stable チューニング前提の範囲（90日検証で全試行 88.5〜111.5）。
            # seed 42 の30日ラン実測は final 104.6 / min 91.2 / max 109.0。
            self.assertGreaterEqual(rates[-1], 85)
            self.assertLessEqual(rates[-1], 115)
            self.assertGreater(min(rates), 85)
            self.assertLess(max(rates), 115)

    def test_tick_change_is_clamped(self):
        class LoudRandom(_QuietRandom):
            def gauss(self, mu, sigma):
                return 10.0  # 極端なノイズでも clamp（±1.5%）に収まること

        with tempfile.TemporaryDirectory() as tmp:
            store = _store(tmp, LoudRandom())
            before = store.rate()
            after = store.tick(datetime(2026, 1, 1, tzinfo=market.JST))
            # clamp は対数リターンへの適用（参照シミュレーションと同じ）。
            import math
            self.assertLessEqual(abs(math.log(after / before)), market.TICK_CLAMP + 1e-9)

    def test_band_pulls_rate_back_toward_anchor(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = _store(tmp, _QuietRandom())
            store._state["rate"] = 300.0
            store._state["day_open_rate"] = 300.0
            after = store.tick(datetime(2026, 1, 1, tzinfo=market.JST))
            self.assertLess(after, 300.0)
            self.assertGreater(after, 290.0)

    def test_reads_have_no_side_effects(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = _store(tmp)
            before = store.snapshot()
            store.rate()
            store.token_balance("1")
            store.snapshot()
            after = store.snapshot()
            self.assertEqual(before["rate"], after["rate"])
            self.assertEqual(len(before["history"]), len(after["history"]))

    def test_circuit_breaker_on_hourly_jump(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = _store(tmp, _QuietRandom())
            now = datetime(2026, 1, 2, 12, 0, tzinfo=market.JST)
            store._state["history"] = [
                {"t": (now - timedelta(hours=2)).isoformat(), "rate": 100.0, "volume": 0},
                {"t": (now - timedelta(minutes=5)).isoformat(), "rate": 112.0, "volume": 0},
            ]
            store._state["rate"] = 112.0
            store._state["day_open_rate"] = 112.0
            store.tick(now)
            halted, reason = store.halt_status(now)
            self.assertTrue(halted)
            self.assertIn("サーキットブレーカー", reason)
            with self.assertRaises(market.TradeError):
                store.validate_buy(100, now)


class TradeTest(unittest.TestCase):
    def test_fee_math(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = _store(tmp)
            quote = store.quote_buy(10_000)
            self.assertEqual(quote["fee"], 100)
            self.assertEqual(quote["net_aga"], 9_900)
            self.assertEqual(quote["tokens"], 99.0)
            sell = store.quote_sell(10.0)
            self.assertEqual(sell["gross_aga"], 1_000)
            self.assertEqual(sell["fee"], 10)
            self.assertEqual(sell["net_aga"], 990)

    def test_minimum_and_cap(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = _store(tmp)
            with self.assertRaises(market.TradeError):
                store.validate_buy(market.MIN_TRADE_AGA - 1)
            cap = store.trade_cap_aga()
            self.assertEqual(cap, int(market.POOL_SEED_AGA * market.TRADE_CAP_POOL_RATIO))
            store.validate_buy(cap)  # 上限ちょうどは通る
            with self.assertRaises(market.TradeError):
                store.validate_buy(cap + 1)

    def test_conservation_of_tokens_and_coins(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = _store(tmp)
            user_aga = 100_000  # テスト側で数えるユーザのコイン増減
            rng = random.Random(7)
            for _ in range(200):
                uid = str(rng.choice([1, 2, 3]))
                if rng.random() < 0.5:
                    amount = rng.randint(10, 5_000)
                    store.validate_buy(amount)
                    store.apply_buy(uid, amount)
                    user_aga -= amount
                else:
                    balance = store.token_balance(uid)
                    if balance < 1:
                        continue
                    amount = round(rng.uniform(0.2, min(balance, 50.0)), 2)
                    store.validate_sell(uid, amount)
                    result = store.apply_sell(uid, amount)
                    user_aga += result["net_aga"]
            state = store.snapshot()
            total_tokens = state["pool_token"] + sum(state["balances"].values())
            self.assertAlmostEqual(total_tokens, market.TOTAL_TOKEN_SUPPLY, places=6)
            # コインはプール経由でのみ動き、消却分を含めれば総量が保存される。
            self.assertEqual(state["pool_aga"] + state["burned_aga"] + user_aga,
                             market.POOL_SEED_AGA + 100_000)

    def test_sell_requires_balance(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = _store(tmp)
            with self.assertRaises(market.TradeError):
                store.validate_sell("999", 1.0)
            store.apply_buy("999", 1_000)
            store.validate_sell("999", 5.0)
            with self.assertRaises(market.TradeError):
                store.validate_sell("999", 500.0)

    def test_side_halt_when_pool_runs_low(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = _store(tmp)
            store._state["pool_token"] = market.TOTAL_TOKEN_SUPPLY * 0.01
            self.assertIsNotNone(store.side_halt("buy", datetime.now(market.JST)))
            store._state["pool_token"] = market.TOTAL_TOKEN_SUPPLY
            store._state["pool_aga"] = int(market.POOL_SEED_AGA * 0.01)
            self.assertIsNotNone(store.side_halt("sell", datetime.now(market.JST)))

    def test_persistence_roundtrip(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = _store(tmp)
            store.apply_buy("123", 10_000)
            rate = store.tick(datetime(2026, 1, 1, tzinfo=market.JST))
            store.flush()
            loaded = _store(tmp)
            self.assertEqual(loaded.token_balance("123"), 99.0)
            self.assertEqual(loaded.rate(), rate)
            state = loaded.snapshot()
            self.assertAlmostEqual(
                state["pool_token"] + sum(state["balances"].values()),
                market.TOTAL_TOKEN_SUPPLY, places=6)


class ChartMathTest(unittest.TestCase):
    def test_ohlc_and_moving_average(self):
        now = datetime(2026, 1, 1, 12, 0, tzinfo=market.JST)
        history = [
            {"t": (now - timedelta(minutes=10)).isoformat(), "rate": 100.0, "volume": 5},
            {"t": (now - timedelta(minutes=5)).isoformat(), "rate": 110.0, "volume": 7},
            {"t": now.isoformat(), "rate": 105.0, "volume": 3},
        ]
        buckets = market.ohlc_buckets(history, hours=5, now=now)
        self.assertEqual(len(buckets), 3)
        self.assertEqual(buckets[1]["open"], 100.0)
        self.assertEqual(buckets[1]["high"], 110.0)
        self.assertEqual(buckets[2]["low"], 105.0)
        ma = market.moving_average([1.0] * 25, window=20)
        self.assertIsNone(ma[18])
        self.assertEqual(ma[19], 1.0)


class RegistryTest(unittest.TestCase):
    def test_market_actions_registered_and_trades_blocked_for_ai(self):
        from cogs.general import GENERAL_ACTIONS, GENERAL_GENRES

        specs = action_registry.build_general_actions(GENERAL_ACTIONS, GENERAL_GENRES)
        by_id = {spec.id: spec for spec in specs}
        self.assertIn("general:market", by_id)
        self.assertIn("general:token_buy", by_id)
        self.assertIn("general:token_sell", by_id)
        for action_id in ("general:token_buy", "general:token_sell"):
            self.assertEqual(by_id[action_id].risk, "blocked")
            self.assertNotIn("aitools", by_id[action_id].surfaces)
        labels = {spec.id: spec.label for spec in specs}
        self.assertIn(market.TOKEN_NAME, labels["general:token_buy"])


if __name__ == "__main__":
    unittest.main()
