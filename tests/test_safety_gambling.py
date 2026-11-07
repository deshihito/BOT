"""ギャンブル系セーフティ修正（監査 E-1/E-5a/E-5c/E-8b/E-10/E-13）の回帰テスト。

見るもの:
- E-10: bj_duel の対戦中中断／タイムアウトは中断側の敗北（waiting の
  取り消しだけ全額返金）。両パネルから二重に決着しない。
- E-8b: 手動キャンセルは prison チェックで弾く。タイムアウトの自動
  決着はチェックを経ず敗北扱いで確定する。
- E-5a: スロット6ペナルティは残高までクランプされ負数にならない。
- E-5c: 開始系（slot/double/blackjack）の debit 後失敗時の返金は戻り値を
  確認し、返金失敗時は critical ログ＋運営連絡の文言が出る。
- E-1: _refund_orphaned は返金 credit の前にストアを flush する。
- E-13: GamblingStore の既定 RNG は SystemRandom。
"""
from __future__ import annotations

import asyncio
import json
import random
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core.game.gambling import gambling
from core.general import economy_pool as economy_core
from core.general.items import ItemError
from cogs import wallet as wallet_module
from cogs import gambling as gambling_pkg
from cogs.gambling import GamblingCog


class _ScriptedRandom(random.Random):
    """choices の結果をキュー順に返す rng（test_gambling と同形）。"""

    def __init__(self, choices_results=()):
        super().__init__()
        self._choices_results = list(choices_results)

    def random(self) -> float:
        return 0.99

    def choices(self, population, weights=None, *, cum_weights=None, k=1):
        if self._choices_results:
            return self._choices_results.pop(0)
        return [population[0]] * k


class _CardRng:
    """choice でカード列を決め打ちする rng（test_next_impl と同形）。"""

    def __init__(self, cards):
        self._cards = list(cards)

    def choice(self, seq):
        return self._cards.pop(0) if self._cards else seq[0]

    def random(self):
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


class _RefundFailWallet(_FakeWallet):
    """入金（返金・credit）だけが None で失敗する wallet。"""

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


def _cog(tmp: str, wallet, rng=None, cards=None):
    if cards is not None:
        rng = _CardRng(cards)
    store = gambling.GamblingStore(
        Path(tmp) / "gambling.json", rng=rng or random.Random(42))
    economy = economy_core.EconomyPoolStore(Path(tmp) / "economy.json")
    bot = _FakeBot({"WalletCog": wallet})
    cog = GamblingCog(
        bot, store=store,
        balance_reader=lambda uid: wallet.balances.get(uid, 0),
        economy_store=economy)
    return cog, store


def _playing_duel(tmp: str, wallet):
    """creator 19（10,9）／challenger 16（10,6）の対戦中デュエルを作る。"""
    cog, store = _cog(tmp, wallet, cards=[10, 9, 10, 6])
    asyncio.run(cog.execute_duel_create(1, 500))
    asyncio.run(cog.execute_duel_join(2, "1"))
    return cog, store


# ---------------------------------------------------------------------------
# E-13: 既定 RNG
# ---------------------------------------------------------------------------

class DefaultRngTest(unittest.TestCase):
    def test_default_rng_is_system_random(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = gambling.GamblingStore(Path(tmp) / "gambling.json")
            self.assertIsInstance(store._rng, random.SystemRandom)

    def test_explicit_rng_is_still_injectable(self):
        with tempfile.TemporaryDirectory() as tmp:
            rng = random.Random(42)
            store = gambling.GamblingStore(Path(tmp) / "gambling.json", rng=rng)
            self.assertIs(store._rng, rng)


# ---------------------------------------------------------------------------
# E-10: ストア層 cancel_duel の意味論
# ---------------------------------------------------------------------------

class CancelDuelStoreTest(unittest.TestCase):
    def test_waiting_cancel_refunds_creator_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = gambling.GamblingStore(
                Path(tmp) / "gambling.json", rng=_CardRng([]))
            store.create_duel("1", 500)
            result = store.cancel_duel("1")
            self.assertEqual(result["state"], "waiting")
            self.assertEqual(
                result["refunds"], [{"user_id": "1", "amount": 500}])
            self.assertIsNone(store.duel_of("1"))

    def test_playing_cancel_by_creator_forfeits_creator(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = gambling.GamblingStore(
                Path(tmp) / "gambling.json", rng=_CardRng([10, 9, 10, 6]))
            store.create_duel("1", 500)
            store.join_duel("1", "2")
            result = store.cancel_duel("1")
            self.assertEqual(result["state"], "playing")
            self.assertEqual(result["refunds"], [])
            self.assertEqual(result["forfeited_by"], "1")
            self.assertEqual(result["result"]["winner"], "2")
            self.assertEqual(result["result"]["bet"], 500)
            self.assertIsNone(store.duel_of("1"))
            self.assertIsNone(store.duel_of("2"))

    def test_playing_cancel_by_challenger_forfeits_challenger(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = gambling.GamblingStore(
                Path(tmp) / "gambling.json", rng=_CardRng([10, 9, 10, 6]))
            store.create_duel("1", 500)
            store.join_duel("1", "2")
            result = store.cancel_duel("2")
            self.assertEqual(result["forfeited_by"], "2")
            self.assertEqual(result["result"]["winner"], "1")


# ---------------------------------------------------------------------------
# E-10 / E-8b: Cog 層 cancel_duel_for
# ---------------------------------------------------------------------------

class CancelDuelCogTest(unittest.TestCase):
    def test_waiting_cancel_refunds_creator(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _FakeWallet({"1": 10_000})
            cog, _store = _cog(tmp, wallet, cards=[])
            asyncio.run(cog.execute_duel_create(1, 500))
            message = asyncio.run(cog.cancel_duel_for(1))
            self.assertIn("返金", message)
            self.assertEqual(wallet.balances["1"], 10_000)

    def test_playing_cancel_pays_pot_to_opponent(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _FakeWallet({"1": 10_000, "2": 10_000})
            cog, _store = _playing_duel(tmp, wallet)
            # 不利な challenger（16）が中断しても全額返金にはならず、
            # 敗北として creator がポット 1,000 を受け取る。
            message = asyncio.run(cog.cancel_duel_for(2))
            self.assertIn("敗北", message)
            self.assertEqual(wallet.balances["1"], 10_500)
            self.assertEqual(wallet.balances["2"], 9_500)

    def test_playing_timeout_forfeits_timeout_user(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _FakeWallet({"1": 10_000, "2": 10_000})
            cog, _store = _playing_duel(tmp, wallet)
            message = asyncio.run(cog.cancel_duel_for(1, timeout=True))
            self.assertIn("タイムアウト", message)
            self.assertIn("敗北", message)
            self.assertEqual(wallet.balances["1"], 9_500)
            self.assertEqual(wallet.balances["2"], 10_500)

    def test_waiting_timeout_refunds_creator(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _FakeWallet({"1": 10_000})
            cog, _store = _cog(tmp, wallet, cards=[])
            asyncio.run(cog.execute_duel_create(1, 500))
            asyncio.run(cog.cancel_duel_for(1, timeout=True))
            self.assertEqual(wallet.balances["1"], 10_000)

    def test_second_panel_cancel_after_settlement_is_noop(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _FakeWallet({"1": 10_000, "2": 10_000})
            cog, _store = _playing_duel(tmp, wallet)
            asyncio.run(cog.cancel_duel_for(2))
            balances = dict(wallet.balances)
            # 相手パネルのタイムアウト／中断が遅れて来ても二重決着しない。
            message = asyncio.run(cog.cancel_duel_for(1, timeout=True))
            self.assertIn("参加中の対決がありません", message)
            self.assertEqual(wallet.balances, balances)

    def test_manual_cancel_blocked_in_prison_but_timeout_settles(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _FakeWallet({"1": 10_000, "2": 10_000})
            cog, store = _playing_duel(tmp, wallet)
            with mock.patch.object(
                    gambling_pkg.prison_core, "block_message",
                    return_value="🚔 逮捕中です。マネー系の操作はできません。"):
                message = asyncio.run(cog.cancel_duel_for(2))
                self.assertIn("逮捕中", message)
                # 弾かれただけなので対決は残り、残高も動かない。
                self.assertIsNotNone(store.duel_of("2"))
                self.assertEqual(wallet.balances["2"], 9_500)
            # タイムアウトの自動決着は逮捕中でも敗北扱いで確定する。
            message = asyncio.run(cog.cancel_duel_for(2, timeout=True))
            self.assertIn("敗北", message)
            self.assertEqual(wallet.balances["1"], 10_500)
            self.assertEqual(wallet.balances["2"], 9_500)


# ---------------------------------------------------------------------------
# E-5a: スロット6ペナルティのクランプ
# ---------------------------------------------------------------------------

class SlotPenaltyClampTest(unittest.TestCase):
    def test_penalty_clamped_to_balance(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _FakeWallet({"1": 14_000})
            rng = _ScriptedRandom(choices_results=[[6, 6, 1, 2, 3, 4, 5]])
            cog, _store = _cog(tmp, wallet, rng=rng)
            asyncio.run(cog.execute_slot_start(1, 10))
            self.assertEqual(wallet.balances["1"], 4_000)
            message = asyncio.run(cog.execute_slot_spin(1))
            # ペナルティ 9,000 は残高 4,000 までで止まり、負数にならない。
            self.assertEqual(wallet.balances["1"], 0)
            self.assertIn("-4,000", message)

    def test_penalty_with_zero_balance_takes_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _FakeWallet({"1": 10_000})
            rng = _ScriptedRandom(choices_results=[[6, 6, 1, 2, 3, 4, 5]])
            cog, _store = _cog(tmp, wallet, rng=rng)
            asyncio.run(cog.execute_slot_start(1, 10))
            self.assertEqual(wallet.balances["1"], 0)
            asyncio.run(cog.execute_slot_spin(1))
            self.assertEqual(wallet.balances["1"], 0)


# ---------------------------------------------------------------------------
# E-5c: 開始失敗時の返金チェック
# ---------------------------------------------------------------------------

def _raise_item_error(*_args, **_kwargs):
    raise ItemError("開始できません（テスト用の失敗）")


class StartRefundCheckTest(unittest.TestCase):
    #: (開始メソッド名, ストアの開始メソッド名, 引数, ベット額)
    _CASES = (
        ("execute_slot_start", "start_slot", (10,), 10 * gambling.SLOT_BET),
        ("execute_double_start", "start_double", (1000,), 1000),
        ("execute_blackjack_start", "start_blackjack", (1000,), 1000),
    )

    def test_refund_failure_logs_critical_and_tells_user_to_contact(self):
        for execute_name, store_name, args, _bet in self._CASES:
            with self.subTest(execute=execute_name), \
                    tempfile.TemporaryDirectory() as tmp:
                wallet = _RefundFailWallet({"1": 100_000})
                cog, store = _cog(tmp, wallet)
                setattr(store, store_name, _raise_item_error)
                with self.assertLogs("core.game.gambling.cog",
                                     level="CRITICAL"):
                    message = asyncio.run(
                        getattr(cog, execute_name)(1, *args))
                self.assertIn("返金に失敗しました", message)
                self.assertIn("運営に連絡", message)

    def test_refund_success_restores_balance_and_shows_original_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _FakeWallet({"1": 10_000})
            cog, store = _cog(tmp, wallet)
            store.start_double = _raise_item_error
            message = asyncio.run(cog.execute_double_start(1, 1000))
            self.assertIn("開始できません", message)
            self.assertNotIn("運営に連絡", message)
            self.assertEqual(wallet.balances["1"], 10_000)
            self.assertIsNone(store.session("1"))


# ---------------------------------------------------------------------------
# E-1: _refund_orphaned は credit の前に flush する
# ---------------------------------------------------------------------------

class RefundOrphanedFlushOrderTest(unittest.TestCase):
    def test_store_flushed_before_refund_credit(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "gambling.json"
            state = {
                "users": {},
                "sessions": {
                    "1": {"kind": "slot", "remaining": 3, "total": 10},
                },
            }
            path.write_text(json.dumps(state), encoding="utf-8")
            store = gambling.GamblingStore(path, rng=random.Random(42))

            seen: dict[str, bool] = {}

            class _CheckingWallet(_FakeWallet):
                async def _change_balance(self, user_id, delta, **kwargs):
                    on_disk = json.loads(path.read_text(encoding="utf-8"))
                    seen["sessions_on_disk_at_credit"] = bool(
                        on_disk.get("sessions"))
                    return await super()._change_balance(
                        user_id, delta, **kwargs)

            wallet = _CheckingWallet({"1": 0})
            bot = _FakeBot({"WalletCog": wallet})
            cog = GamblingCog(
                bot, store=store,
                balance_reader=lambda uid: wallet.balances.get(uid, 0))
            asyncio.run(cog._refund_orphaned())
            self.assertEqual(wallet.balances["1"], 3 * gambling.SLOT_BET)
            # credit 時点でディスク上のセッションは削除済み（flush 済み）。
            self.assertFalse(seen["sessions_on_disk_at_credit"])


if __name__ == "__main__":
    unittest.main()
