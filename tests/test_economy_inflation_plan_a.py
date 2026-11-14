"""経済インフレ対策A案（配当のバンクロール原資化）のテスト。

見るもの:
- EconomyPoolStore.pay_house の引き順（プール→国庫）・不足時キャップ・
  負にならないこと、refund_house の内訳復元、total_house_paid の加算と
  旧JSON（キー無し）との互換。
- 採掘ジャクポットの絶対上限（直下掘りの1.5倍の後にクランプ）。
- ダブルアップ倍率 1.6 の cashout 額。
- バンクロールが空のとき、各ゲームで「勝ってもベット分は戻る」ことと、
  wallet credit 失敗時にバンクロールが巻き戻ること。
- 保存則: シード付きで各ゲームを回し、全ユーザー残高＋プール＋国庫の
  合計が不変であること。
- tools/economy_reset の dry-run 非書込・apply 後の状態・冪等性・
  バックアップ/リストアの往復。
"""
from __future__ import annotations

import asyncio
import json
import random
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core.game import mining
from core.game.gambling import gambling
from core.general.circulation import economy_pool
from core.general.items import items as items_core
from cogs import general as wallet_module
from cogs.game import GamblingCog
from tools import economy_reset


# ---------------------------------------------------------------------------
# フェイク（test_gambling と同形）
# ---------------------------------------------------------------------------

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


class _CreditFailWallet(_FakeWallet):
    """credit（正の delta）だけが None で失敗する wallet。"""

    async def _change_balance(self, user_id, delta, *, require_funds=False,
                               create_with=None):
        if delta > 0:
            return None
        return await super()._change_balance(
            user_id, delta, require_funds=require_funds,
            create_with=create_with)


class _FakeBot:
    def __init__(self, cogs: dict):
        self._cogs = cogs

    def get_cog(self, name):
        return self._cogs.get(name)


class _ScriptedRandom(random.Random):
    def __init__(self, randoms=(), choices_results=(), choice_results=(),
                 randints=()):
        super().__init__()
        self._randoms = list(randoms)
        self._choices_results = list(choices_results)
        self._choice_results = list(choice_results)
        self._randints = list(randints)

    def random(self) -> float:
        if self._randoms:
            return self._randoms.pop(0)
        return 0.99

    def choices(self, population, weights=None, *, cum_weights=None, k=1):
        if self._choices_results:
            return self._choices_results.pop(0)
        return [population[0]] * k

    def choice(self, seq):
        if self._choice_results:
            return self._choice_results.pop(0)
        return seq[0]

    def randint(self, a, b):
        if self._randints:
            return self._randints.pop(0)
        return a


def _economy(tmp: str, pool: int = 0, treasury: int = 0) -> economy_pool.EconomyPoolStore:
    path = Path(tmp) / "economy.json"
    path.write_text(json.dumps({"pool": pool, "treasury": treasury}),
                    encoding="utf-8")
    return economy_pool.EconomyPoolStore(path)


def _cog(tmp: str, wallet, economy, rng=None, item_store=None):
    store = gambling.GamblingStore(
        Path(tmp) / "gambling.json", rng=rng or random.Random(42))
    bot = _FakeBot({"WalletCog": wallet})
    cog = GamblingCog(
        bot, store=store,
        balance_reader=lambda uid: wallet.balances.get(uid, 0),
        item_store=item_store, economy_store=economy)
    return cog, store


def _total(wallet: _FakeWallet, economy) -> int:
    snap = economy.snapshot()
    return sum(wallet.balances.values()) + snap["pool"] + snap["treasury"]


# ---------------------------------------------------------------------------
# A1: pay_house / refund_house
# ---------------------------------------------------------------------------

class PayHouseTest(unittest.TestCase):
    def test_draws_pool_first_then_treasury(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = _economy(tmp, pool=300, treasury=500)
            result = store.pay_house(400)
            self.assertEqual(result, {"paid": 400, "pool": 300, "treasury": 100})
            self.assertEqual(store.pool_balance(), 0)
            self.assertEqual(store.treasury_balance(), 400)
            self.assertEqual(store.snapshot()["total_house_paid"], 400)

    def test_caps_at_bankroll_and_never_negative(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = _economy(tmp, pool=100, treasury=50)
            result = store.pay_house(10_000)
            self.assertEqual(result["paid"], 150)
            self.assertEqual(store.pool_balance(), 0)
            self.assertEqual(store.treasury_balance(), 0)
            # 空になってからは払わない。
            self.assertEqual(store.pay_house(1)["paid"], 0)
            self.assertEqual(store.snapshot()["total_house_paid"], 150)

    def test_zero_and_negative_amounts_are_noops(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = _economy(tmp, pool=100, treasury=100)
            self.assertEqual(store.pay_house(0)["paid"], 0)
            self.assertEqual(store.pay_house(-5)["paid"], 0)
            self.assertEqual(store.snapshot()["total_house_paid"], 0)

    def test_refund_house_restores_breakdown(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = _economy(tmp, pool=300, treasury=500)
            breakdown = store.pay_house(400)
            store.refund_house(breakdown)
            self.assertEqual(store.pool_balance(), 300)
            self.assertEqual(store.treasury_balance(), 500)
            self.assertEqual(store.snapshot()["total_house_paid"], 0)
            # 二重に戻しても残高は増え、カウンタは負にならない範囲で戻る。
            store.refund_house({"pool": 10, "treasury": 0, "paid": 10})
            self.assertEqual(store.pool_balance(), 310)
            self.assertEqual(store.snapshot()["total_house_paid"], 0)

    def test_old_json_without_counter_loads_zero(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "economy.json"
            path.write_text(json.dumps({"pool": 7, "treasury": 8}),
                            encoding="utf-8")
            store = economy_pool.EconomyPoolStore(path)
            self.assertEqual(store.snapshot()["total_house_paid"], 0)
            store.pay_house(5)
            store.flush()
            reloaded = economy_pool.EconomyPoolStore(path)
            self.assertEqual(reloaded.snapshot()["total_house_paid"], 5)


# ---------------------------------------------------------------------------
# A4: 採掘ジャクポットの絶対上限
# ---------------------------------------------------------------------------

class _JackpotRng:
    """random() の呼び出し順（失敗判定→ジャクポット判定）に値を返す。"""

    def __init__(self, uniform_value: float):
        self._uniform_value = uniform_value
        self._randoms = [0.99, 0.0]  # 失敗しない / ジャクポット発動

    def randint(self, a, b):
        return b

    def random(self):
        return self._randoms.pop(0) if self._randoms else 0.99

    def uniform(self, a, b):
        return self._uniform_value


class JackpotCapTest(unittest.TestCase):
    def _store(self, tmp: str, rng) -> mining.MiningStore:
        return mining.MiningStore(Path(tmp) / "mining.json", rng=rng)

    def test_jackpot_capped_at_absolute_limit(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = self._store(tmp, _JackpotRng(0.10))
            result = store._roll(10**9)
            self.assertTrue(result["jackpot"])
            self.assertEqual(result["extra"], mining.JACKPOT_CAP_COINS)

    def test_direct_multiplier_applies_before_cap(self):
        with tempfile.TemporaryDirectory() as tmp:
            # 割合0.10×直下1.5倍=0.15。プール100,000なら上乗せ15,000が
            # 上限10,000にクランプされ、プール10,000なら1,500のまま。
            store = self._store(tmp, _JackpotRng(0.10))
            result = store._roll(100_000, direct=True)
            self.assertEqual(result["extra"], mining.JACKPOT_CAP_COINS)
            store2 = self._store(tmp, _JackpotRng(0.10))
            result2 = store2._roll(10_000, direct=True)
            self.assertEqual(result2["extra"], 1_500)


# ---------------------------------------------------------------------------
# A3: ダブルアップ倍率
# ---------------------------------------------------------------------------

class DoubleMultiplierTest(unittest.TestCase):
    def test_step_is_1_6_and_cashout_amount(self):
        self.assertEqual(gambling.DOUBLE_MULTIPLIER_STEP, 1.6)
        with tempfile.TemporaryDirectory() as tmp:
            rng = _ScriptedRandom(randoms=[0.5])
            store = gambling.GamblingStore(
                Path(tmp) / "gambling.json", rng=rng)
            store.start_double("1", 1000)
            store.double_go("1")
            result = store.double_cashout("1")
            self.assertEqual(result["payout"], 1600)


# ---------------------------------------------------------------------------
# A2: バンクロール空/十分なときの配当と、credit 失敗時の巻き戻し
# ---------------------------------------------------------------------------

class BankrollPayoutTest(unittest.TestCase):
    def test_dice_hit_with_empty_bankroll_returns_stake_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _FakeWallet({"1": 10_000})
            economy = _economy(tmp)
            rng = _ScriptedRandom(randints=[7])
            cog, _store = _cog(tmp, wallet, economy, rng=rng)
            message = asyncio.run(cog.execute_dice(1, 100, 7, 100))
            self.assertIn("当たり", message)
            self.assertIn("100 AGO 獲得", message)
            self.assertEqual(wallet.balances["1"], 10_000)  # ベット分のみ返却
            self.assertEqual(economy.snapshot()["total_house_paid"], 0)

    def test_dice_hit_funded_draws_profit_from_bankroll(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _FakeWallet({"1": 10_000})
            economy = _economy(tmp, pool=20_000)
            rng = _ScriptedRandom(randints=[7])
            cog, _store = _cog(tmp, wallet, economy, rng=rng)
            asyncio.run(cog.execute_dice(1, 100, 7, 100))
            self.assertEqual(wallet.balances["1"], 10_000 - 100 + 10_000)
            # 利益分 9,900 がプールから引かれる。
            self.assertEqual(economy.pool_balance(), 20_000 - 9_900)
            self.assertEqual(economy.snapshot()["total_house_paid"], 9_900)

    def test_blackjack_win_with_empty_bankroll_returns_stake_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _FakeWallet({"1": 10_000})
            economy = _economy(tmp)
            rng = _ScriptedRandom(choice_results=[10, 9, 10, 6, 10])
            cog, _store = _cog(tmp, wallet, economy, rng=rng)
            asyncio.run(cog.execute_blackjack_start(1, 1000))
            message = asyncio.run(cog.execute_blackjack_stand(1))
            self.assertIn("勝ち", message)
            self.assertEqual(wallet.balances["1"], 10_000)

    def test_double_cashout_with_empty_bankroll_returns_stake_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _FakeWallet({"1": 10_000})
            economy = _economy(tmp)
            rng = _ScriptedRandom(randoms=[0.5])
            cog, _store = _cog(tmp, wallet, economy, rng=rng)
            asyncio.run(cog.execute_double_start(1, 1000))
            asyncio.run(cog.execute_double_go(1))
            message = asyncio.run(cog.execute_double_cashout(1))
            self.assertIn("1,000 AGO 獲得", message)
            self.assertEqual(wallet.balances["1"], 10_000)

    def test_slot_win_with_empty_bankroll_credits_stake_portion_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _FakeWallet({"1": 100_000})
            economy = _economy(tmp)
            rng = _ScriptedRandom(choices_results=[[1, 1, 2, 3, 4, 5, 9]])
            cog, _store = _cog(tmp, wallet, economy, rng=rng)
            asyncio.run(cog.execute_slot_start(1, 10))
            asyncio.run(cog.execute_slot_spin(1))
            # 名目報酬1,100のうちベット分1,000だけが credit される。
            self.assertEqual(wallet.balances["1"], 100_000 - 10_000 + 1_000)

    def test_credit_failure_refunds_bankroll(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _CreditFailWallet({"1": 10_000})
            economy = _economy(tmp, pool=20_000)
            rng = _ScriptedRandom(randints=[7])
            cog, _store = _cog(tmp, wallet, economy, rng=rng)
            message = asyncio.run(cog.execute_dice(1, 100, 7, 100))
            self.assertIn("失敗", message)
            # 確保した利益分はバンクロールへ巻き戻っている。
            self.assertEqual(economy.pool_balance(), 20_000)
            self.assertEqual(economy.snapshot()["total_house_paid"], 0)

    def test_devil_reward_is_funded_and_capped_by_bankroll(self):
        class _ItemStore:
            def count(self, uid, item_id):
                return 1

            def remove(self, uid, item_id, count):
                return 0

        class _StubRng:
            def random(self):
                return 0.1  # 発動率0.25未満

        with tempfile.TemporaryDirectory() as tmp:
            wallet = _FakeWallet({"1": 0})
            economy = _economy(tmp, pool=500)
            cog, _store = _cog(
                tmp, wallet, economy, item_store=_ItemStore())
            cog._rng = _StubRng()
            # 名目2,000（没収1,000×2倍）だが原資は500しかない。
            paid = asyncio.run(cog._try_devil_reward("1", 1_000))
            self.assertEqual(paid, 500)
            self.assertEqual(wallet.balances["1"], 500)
            self.assertEqual(economy.pool_balance(), 0)


# ---------------------------------------------------------------------------
# 保存則シミュレーション
# ---------------------------------------------------------------------------

class ConservationTest(unittest.TestCase):
    def test_total_supply_is_conserved_across_games(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _FakeWallet({"1": 5_000_000})
            economy = _economy(tmp, pool=2_000_000, treasury=500_000)
            cog, store = _cog(
                tmp, wallet, economy, rng=random.Random(20261114))
            total0 = _total(wallet, economy)
            for i in range(60):
                kind = i % 3
                if kind == 0:
                    asyncio.run(cog.execute_dice(
                        1, [5, 20, 100][i % 3], 3, 500))
                elif kind == 1:
                    asyncio.run(cog.execute_blackjack_start(1, 500))
                    if store.session("1") is not None:
                        asyncio.run(cog.execute_blackjack_stand(1))
                else:
                    asyncio.run(cog.execute_double_start(1, 500))
                    if store.session("1") is not None:
                        asyncio.run(cog.execute_double_go(1))
                    if store.session("1") is not None:
                        asyncio.run(cog.execute_double_cashout(1))
                self.assertEqual(_total(wallet, economy), total0,
                                 f"round {i} kind {kind}")
            # 実際にバンクロール支払いが発生していること（素通し防止）。
            self.assertGreater(economy.snapshot()["total_house_paid"], 0)

    def test_slot_session_conserves_total(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _FakeWallet({"1": 1_000_000})
            economy = _economy(tmp, pool=300_000, treasury=100_000)
            miss = [1, 2, 3, 4, 5, 8, 9]
            pair = [1, 1, 2, 3, 4, 5, 9]
            rng = _ScriptedRandom(
                choices_results=[miss, pair] * 5)
            cog, _store = _cog(tmp, wallet, economy, rng=rng)
            total0 = _total(wallet, economy)
            asyncio.run(cog.execute_slot_start(1, 10))
            _message, info = asyncio.run(cog.execute_slot_spin_bulk(1, 10))
            self.assertTrue(info["finished"])
            self.assertEqual(_total(wallet, economy), total0)


# ---------------------------------------------------------------------------
# A5: 新規ユーザーの初期残高
# ---------------------------------------------------------------------------

class NewUserBalanceTest(unittest.TestCase):
    def test_constant_is_10000(self):
        self.assertEqual(wallet_module.NEW_USER_BALANCE, 10_000)


# ---------------------------------------------------------------------------
# tools/economy_reset
# ---------------------------------------------------------------------------

class _FakeUsersIO:
    def __init__(self, rows):
        self.rows = [dict(r) for r in rows]

    def fetch_all(self):
        return [dict(r) for r in self.rows]

    def set_balance(self, user_id, balance, debt):
        for row in self.rows:
            if row["user_id"] == str(user_id):
                row["balance"] = balance
                row["debt"] = debt
                return
        raise KeyError(user_id)


def _reset_fixture(tmp: str):
    data_dir = Path(tmp) / "data"
    data_dir.mkdir()
    (data_dir / "economy_pool.json").write_text(json.dumps({
        "pool": 999, "treasury": 555, "total_recycled": 10,
        "total_paid": 3, "total_released": 2, "total_boosted": 1,
        "lottery_boost_pending": 4, "last_release_date": "2026-11-01",
    }), encoding="utf-8")
    (data_dir / "gambling.json").write_text(json.dumps({
        "users": {"1": {"kakuhen": 2}},
        "sessions": {"1": {"kind": "slot"}},
        "duels": {"1": {"bet": 500}},
    }), encoding="utf-8")
    io = _FakeUsersIO([
        {"user_id": "1", "balance": 123_456, "debt": 700},
        {"user_id": "2", "balance": 0, "debt": 0},
        {"user_id": "3", "balance": 5, "debt": 1},
    ])
    return io, data_dir


class EconomyResetTest(unittest.TestCase):
    def test_dry_run_writes_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            io, data_dir = _reset_fixture(tmp)
            backup_dir = Path(tmp) / "backup"
            before_pool = (data_dir / "economy_pool.json").read_bytes()
            before_gambling = (data_dir / "gambling.json").read_bytes()
            rc = economy_reset.main(
                [], users_io=io, data_dir=data_dir)
            self.assertEqual(rc, 0)
            self.assertEqual((data_dir / "economy_pool.json").read_bytes(),
                             before_pool)
            self.assertEqual((data_dir / "gambling.json").read_bytes(),
                             before_gambling)
            self.assertFalse(backup_dir.exists())
            self.assertEqual(io.rows[0]["balance"], 123_456)

    def test_apply_resets_everything_and_backs_up(self):
        with tempfile.TemporaryDirectory() as tmp:
            io, data_dir = _reset_fixture(tmp)
            backup_dir = Path(tmp) / "backup"
            result = economy_reset.apply_reset(
                io, data_dir, backup_dir, today="2026-11-14")
            self.assertFalse(result["already_reset"])
            self.assertTrue(all(
                r["balance"] == economy_reset.RESET_BALANCE and r["debt"] == 0
                for r in io.rows))
            self.assertEqual(result["total_balance"],
                             3 * economy_reset.RESET_BALANCE)
            pool = json.loads(
                (data_dir / "economy_pool.json").read_text(encoding="utf-8"))
            self.assertEqual(pool["pool"], economy_reset.RESET_POOL)
            self.assertEqual(pool["treasury"], 0)
            self.assertEqual(pool["total_recycled"], 0)
            self.assertEqual(pool["last_release_date"], "2026-11-14")
            gambling = json.loads(
                (data_dir / "gambling.json").read_text(encoding="utf-8"))
            self.assertEqual(gambling["sessions"], {})
            self.assertEqual(gambling["duels"], {})
            self.assertEqual(gambling["users"], {"1": {"kakuhen": 2}})
            # バックアップには適用前の状態が残る。
            backed_users = json.loads(
                (backup_dir / "users.json").read_text(encoding="utf-8"))
            self.assertEqual(backed_users[0]["balance"], 123_456)
            backed_pool = json.loads(
                (backup_dir / "economy_pool.json").read_text(encoding="utf-8"))
            self.assertEqual(backed_pool["pool"], 999)

    def test_apply_is_idempotent(self):
        with tempfile.TemporaryDirectory() as tmp:
            io, data_dir = _reset_fixture(tmp)
            economy_reset.apply_reset(
                io, data_dir, Path(tmp) / "b1", today="2026-11-14")
            second = economy_reset.apply_reset(
                io, data_dir, Path(tmp) / "b2", today="2026-11-14")
            self.assertTrue(second["already_reset"])
            self.assertFalse((Path(tmp) / "b2").exists())
            self.assertTrue(all(
                r["balance"] == economy_reset.RESET_BALANCE for r in io.rows))

    def test_restore_roundtrip(self):
        with tempfile.TemporaryDirectory() as tmp:
            io, data_dir = _reset_fixture(tmp)
            backup_dir = Path(tmp) / "backup"
            economy_reset.apply_reset(
                io, data_dir, backup_dir, today="2026-11-14")
            summary = economy_reset.restore_backup(io, data_dir, backup_dir)
            self.assertEqual(summary["total_balance"], 123_456 + 0 + 5)
            self.assertEqual(summary["pool"], 999)
            self.assertEqual(io.rows[0]["debt"], 700)
            gambling = json.loads(
                (data_dir / "gambling.json").read_text(encoding="utf-8"))
            self.assertEqual(gambling["sessions"], {"1": {"kind": "slot"}})


if __name__ == "__main__":
    unittest.main()
