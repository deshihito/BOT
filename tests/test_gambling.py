"""ギャンブル系（core/gambling.py と GamblingCog）のテスト。

見るもの: 原典準拠の確率・配当の境界（シード／スクリプト固定）、slot7 の
内部状態遷移（確変突入・倍率・延長・減少・終了、sixカウンタ、天井、
66666 全額没収、6ペナルティ）、double の連鎖と確定・内部モード遷移、
blackjack の勝敗判定とセッション保存則（ベット→決済で残高が正しく
増減し、再起動相当の再ロードで未完了セッションが返金対象になる）、
残高不足で不変、レジストリ登録。
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

from core import action_registry, gambling
from core.items import ItemError
from cogs import wallet as wallet_module
from cogs.gambling import GamblingCog


class _ScriptedRandom(random.Random):
    """random/choices/choice/randint がキュー順の値を返す rng。"""

    def __init__(self, randoms=(), choices_results=(), choice_results=(), randints=()):
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


def _store(tmp: str, rng=None, state: dict | None = None) -> gambling.GamblingStore:
    path = Path(tmp) / "gambling.json"
    if state is not None:
        path.write_text(json.dumps(state), encoding="utf-8")
    return gambling.GamblingStore(path, rng=rng or random.Random(42))


def _user_state(**overrides) -> dict:
    base = {"kakuhen": 0, "six_counter": 0, "lose_streak": 0,
            "win_streak": 0, "internal_mode": "NORMAL"}
    base.update(overrides)
    return base


def _slot_session(remaining: int = 10, total: int = 10) -> dict:
    return {"kind": "slot", "remaining": remaining, "total": total}


# ---------------------------------------------------------------------------
# 定義
# ---------------------------------------------------------------------------

class DefinitionTest(unittest.TestCase):
    def test_slot_tables_match_original(self):
        self.assertEqual(gambling.SLOT_BET, 1000)
        self.assertEqual(gambling.SLOT_BASE_MULTIPLIERS,
                         {2: 1.1, 3: 6, 4: 25, 5: 120, 6: 500, 7: 2000})
        self.assertEqual((gambling.SLOT_MIN_SPINS, gambling.SLOT_MAX_SPINS), (10, 1000))
        weights = gambling._reel_weights(False)
        self.assertEqual(len(weights), 10)
        self.assertEqual(weights[6], 16)
        self.assertEqual(weights[7], 5)
        self.assertEqual(sum(weights), 85)
        kakuhen_weights = gambling._reel_weights(True)
        self.assertEqual(kakuhen_weights[6], 14)
        self.assertEqual(sum(kakuhen_weights), 83)

    def test_calc_total_matches_original(self):
        self.assertEqual(gambling.calc_total([10, 9]), 19)
        self.assertEqual(gambling.calc_total([11, 10]), 21)
        self.assertEqual(gambling.calc_total([11, 9, 5]), 15)
        self.assertEqual(gambling.calc_total([10, 10, 5]), 25)


# ---------------------------------------------------------------------------
# slot7
# ---------------------------------------------------------------------------

class SlotStoreTest(unittest.TestCase):
    def test_start_validation_and_conflict(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = _store(tmp)
            with self.assertRaises(ItemError):
                store.start_slot("1", gambling.SLOT_MIN_SPINS - 1)
            with self.assertRaises(ItemError):
                store.start_slot("1", gambling.SLOT_MAX_SPINS + 1)
            store.start_slot("1", 10)
            with self.assertRaises(ItemError):
                store.start_slot("1", 10)
            with self.assertRaises(ItemError):
                store.spin_slot("2")

    def test_pair_pays_base_multiplier(self):
        with tempfile.TemporaryDirectory() as tmp:
            rng = _ScriptedRandom(choices_results=[[1, 1, 2, 3, 4, 5, 9]])
            store = _store(tmp, rng=rng)
            store.start_slot("1", 10)
            result = store.spin_slot("1")
            self.assertEqual(result["max_match"], 2)
            self.assertEqual(result["reward"], int(1000 * 1.1))
            self.assertEqual(result["remaining"], 9)
            self.assertFalse(result["finished"])
            self.assertEqual(store.user_state("1")["lose_streak"], 0)

    def test_miss_increments_lose_streak(self):
        with tempfile.TemporaryDirectory() as tmp:
            rng = _ScriptedRandom(choices_results=[[0, 1, 2, 3, 4, 5, 9]])
            store = _store(tmp, rng=rng)
            store.start_slot("1", 10)
            result = store.spin_slot("1")
            self.assertEqual(result["reward"], 0)
            self.assertEqual(store.user_state("1")["lose_streak"], 1)

    def test_pity_after_three_loses(self):
        with tempfile.TemporaryDirectory() as tmp:
            rng = _ScriptedRandom(choices_results=[[0, 1, 2, 3, 4, 5, 9]])
            state = {"users": {"1": _user_state(lose_streak=3)},
                     "sessions": {"1": _slot_session()}}
            store = _store(tmp, rng=rng, state=state)
            result = store.spin_slot("1")
            self.assertIn("pity", result["events"])
            self.assertEqual(result["reward"], 1000 * 50)
            self.assertEqual(store.user_state("1")["lose_streak"], 0)

    def test_seven_bonus_enters_kakuhen(self):
        with tempfile.TemporaryDirectory() as tmp:
            rng = _ScriptedRandom(choices_results=[[7, 7, 7, 1, 2, 3, 4]])
            store = _store(tmp, rng=rng)
            store.start_slot("1", 10)
            result = store.spin_slot("1")
            self.assertIn("seven_bonus", result["events"])
            self.assertIn("kakuhen_start", result["events"])
            self.assertEqual(result["reward"], int(1000 * 6) * 5)
            self.assertEqual(store.user_state("1")["kakuhen"], gambling.SLOT_KAKUHEN_SPINS)

    def test_kakuhen_multiplier_and_end(self):
        with tempfile.TemporaryDirectory() as tmp:
            rng = _ScriptedRandom(choices_results=[
                [3, 3, 1, 2, 4, 5, 9],   # ペア → 確変倍率×3、終了間際
                [0, 1, 2, 3, 4, 5, 9],   # ハズレ → 確変終了
            ])
            state = {"users": {"1": _user_state(kakuhen=2)},
                     "sessions": {"1": _slot_session()}}
            store = _store(tmp, rng=rng, state=state)
            first = store.spin_slot("1")
            self.assertIn("kakuhen_multiplier", first["events"])
            self.assertEqual(first["reward"], int(1000 * 1.1) * 3)
            self.assertEqual(store.user_state("1")["kakuhen"], 1)
            second = store.spin_slot("1")
            self.assertIn("kakuhen_end", second["events"])
            self.assertEqual(store.user_state("1")["kakuhen"], 0)
            # 確変中は six_counter がスピンごとに増える。
            self.assertEqual(store.user_state("1")["six_counter"], 2)

    def test_kakuhen_decrease_on_six_match(self):
        with tempfile.TemporaryDirectory() as tmp:
            rng = _ScriptedRandom(choices_results=[[6, 6, 6, 1, 2, 3, 4]])
            state = {"users": {"1": _user_state(kakuhen=5)},
                     "sessions": {"1": _slot_session()}}
            store = _store(tmp, rng=rng, state=state)
            result = store.spin_slot("1")
            self.assertIn("kakuhen_decrease", result["events"])
            self.assertNotIn("kakuhen_multiplier", result["events"])
            self.assertEqual(result["reward"], int(1000 * 6))
            # 減少1＋終了時デクリメント1で 5→3。
            self.assertEqual(store.user_state("1")["kakuhen"], 3)

    def test_kakuhen_extend_on_two_sevens(self):
        with tempfile.TemporaryDirectory() as tmp:
            rng = _ScriptedRandom(choices_results=[[7, 7, 1, 2, 3, 4, 5]])
            state = {"users": {"1": _user_state(kakuhen=3)},
                     "sessions": {"1": _slot_session()}}
            store = _store(tmp, rng=rng, state=state)
            result = store.spin_slot("1")
            self.assertIn("kakuhen_extend", result["events"])
            self.assertEqual(result["reward"], int(1000 * 1.1) * 5 * 3)
            # 延長+1と終了時-1で相殺され 3 のまま。
            self.assertEqual(store.user_state("1")["kakuhen"], 3)

    def test_super_jackpot(self):
        with tempfile.TemporaryDirectory() as tmp:
            rng = _ScriptedRandom(choices_results=[[7, 7, 7, 7, 7, 7, 7]])
            state = {"users": {"1": _user_state(kakuhen=2)},
                     "sessions": {"1": _slot_session()}}
            store = _store(tmp, rng=rng, state=state)
            result = store.spin_slot("1")
            self.assertIn("super_jackpot", result["events"])
            self.assertEqual(result["reward"], 1000 * gambling.SLOT_SUPER_JACKPOT_MULTIPLIER)

    def test_six_penalty(self):
        with tempfile.TemporaryDirectory() as tmp:
            rng = _ScriptedRandom(choices_results=[[6, 6, 1, 2, 3, 4, 5]])
            store = _store(tmp, rng=rng)
            store.start_slot("1", 10)
            result = store.spin_slot("1")
            self.assertIn("six_penalty", result["events"])
            self.assertEqual(result["reward"], -1000 * gambling.SLOT_SIX_PENALTY_MULTIPLIER)

    def test_six_confiscate(self):
        with tempfile.TemporaryDirectory() as tmp:
            rng = _ScriptedRandom(choices_results=[[6, 6, 6, 6, 6, 1, 2]])
            store = _store(tmp, rng=rng)
            store.start_slot("1", 10)
            result = store.spin_slot("1")
            self.assertIn("six_confiscate", result["events"])
            self.assertTrue(result["confiscate"])
            self.assertEqual(result["reward"], 0)

    def test_force_six_from_counter(self):
        with tempfile.TemporaryDirectory() as tmp:
            # six_counter=100 → 確率 100×0.01=1.0 で必ず発動しカウンタは0に。
            # 2回目の random が 0.5 未満で force_six が真になる。
            rng = _ScriptedRandom(
                randoms=[0.99, 0.4], choices_results=[[1, 2]])
            state = {"users": {"1": _user_state(six_counter=100)},
                     "sessions": {"1": _slot_session()}}
            store = _store(tmp, rng=rng, state=state)
            result = store.spin_slot("1")
            self.assertEqual(result["reels"], [6, 6, 6, 6, 6, 1, 2])
            self.assertTrue(result["confiscate"])
            self.assertEqual(store.user_state("1")["six_counter"], 0)

    def test_session_finishes_after_last_spin(self):
        with tempfile.TemporaryDirectory() as tmp:
            rng = _ScriptedRandom(choices_results=[[0, 1, 2, 3, 4, 5, 9]])
            state = {"users": {}, "sessions": {"1": _slot_session(remaining=1)}}
            store = _store(tmp, rng=rng, state=state)
            result = store.spin_slot("1")
            self.assertTrue(result["finished"])
            self.assertIsNone(store.session("1"))


# ---------------------------------------------------------------------------
# double
# ---------------------------------------------------------------------------

class DoubleStoreTest(unittest.TestCase):
    def test_start_validation_and_conflict(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = _store(tmp)
            with self.assertRaises(ItemError):
                store.start_double("1", 0)
            store.start_double("1", 100)
            with self.assertRaises(ItemError):
                store.start_double("1", 100)
            with self.assertRaises(ItemError):
                store.double_go("2")

    def test_go_win_grows_multiplier(self):
        with tempfile.TemporaryDirectory() as tmp:
            rng = _ScriptedRandom(randoms=[0.5])
            store = _store(tmp, rng=rng)
            store.start_double("1", 1000)
            result = store.double_go("1")
            self.assertTrue(result["win"])
            self.assertAlmostEqual(result["multiplier"], 1.9)
            self.assertEqual(result["current_value"], 1900)
            self.assertFalse(result["finished"])

    def test_go_lose_ends_session_and_counts_streak(self):
        with tempfile.TemporaryDirectory() as tmp:
            rng = _ScriptedRandom(randoms=[0.99])
            store = _store(tmp, rng=rng)
            store.start_double("1", 1000)
            result = store.double_go("1")
            self.assertFalse(result["win"])
            self.assertTrue(result["finished"])
            self.assertIsNone(store.session("1"))
            self.assertEqual(store.user_state("1")["lose_streak"], 1)

    def test_internal_rate_fever(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = {"users": {"1": _user_state(internal_mode="FEVER"),
                                "2": _user_state(internal_mode="HELL")},
                     "sessions": {}}
            store = _store(tmp, state=state)
            self.assertEqual(store.internal_rate("1"), gambling.DOUBLE_RATE_FEVER)
            self.assertEqual(store.internal_rate("2"), gambling.DOUBLE_RATE_NORMAL)

    def test_fever_win_rate_applies(self):
        with tempfile.TemporaryDirectory() as tmp:
            # 0.7 は通常率0.60では負け、FEVER率0.75では勝ち。
            rng = _ScriptedRandom(randoms=[0.7])
            state = {"users": {"1": _user_state(internal_mode="FEVER")},
                     "sessions": {}}
            store = _store(tmp, rng=rng, state=state)
            store.start_double("1", 100)
            self.assertTrue(store.double_go("1")["win"])

    def test_charge_turns_fever_on_win(self):
        with tempfile.TemporaryDirectory() as tmp:
            rng = _ScriptedRandom(randoms=[0.5])
            state = {"users": {"1": _user_state(internal_mode="CHARGE")},
                     "sessions": {}}
            store = _store(tmp, rng=rng, state=state)
            store.start_double("1", 100)
            store.double_go("1")
            self.assertEqual(store.user_state("1")["internal_mode"], "FEVER")

    def test_fever_exits_after_three_wins(self):
        with tempfile.TemporaryDirectory() as tmp:
            rng = _ScriptedRandom(randoms=[0.5])
            state = {"users": {"1": _user_state(internal_mode="FEVER", win_streak=2)},
                     "sessions": {}}
            store = _store(tmp, rng=rng, state=state)
            store.start_double("1", 100)
            store.double_go("1")
            state_after = store.user_state("1")
            self.assertEqual(state_after["internal_mode"], "NORMAL")
            self.assertEqual(state_after["win_streak"], 0)

    def test_lose_streak_modes(self):
        with tempfile.TemporaryDirectory() as tmp:
            rng = _ScriptedRandom(randoms=[0.99, 0.99])
            state = {"users": {"1": _user_state(lose_streak=2),
                                "2": _user_state(lose_streak=5)},
                     "sessions": {}}
            store = _store(tmp, rng=rng, state=state)
            store.start_double("1", 100)
            store.double_go("1")
            self.assertEqual(store.user_state("1")["internal_mode"], "HELL")
            store.start_double("2", 100)
            store.double_go("2")
            self.assertEqual(store.user_state("2")["internal_mode"], "CHARGE")

    def test_lose_streak_is_shared_with_slot(self):
        # 連敗は slot7 の天井と同じカウンタ。double で貯めた連敗が
        # スロットの天井に届くことを確認する。
        with tempfile.TemporaryDirectory() as tmp:
            rng = _ScriptedRandom(randoms=[0.99, 0.99, 0.99],
                                  choices_results=[[0, 1, 2, 3, 4, 5, 9]])
            store = _store(tmp, rng=rng)
            for _ in range(3):
                store.start_double("1", 100)
                store.double_go("1")
            self.assertEqual(store.user_state("1")["lose_streak"], 3)
            store.start_slot("1", 10)
            result = store.spin_slot("1")
            self.assertIn("pity", result["events"])

    def test_cashout_payout_and_hell_drop(self):
        with tempfile.TemporaryDirectory() as tmp:
            rng = _ScriptedRandom(randoms=[0.5])
            store = _store(tmp, rng=rng)
            store.start_double("1", 1000)
            store.double_go("1")
            result = store.double_cashout("1")
            self.assertEqual(result["payout"], 1900)
            self.assertIsNone(store.session("1"))
            # 500超の確定で HELL に落ちる（原典どおり）。
            self.assertEqual(store.user_state("1")["internal_mode"], "HELL")

    def test_cashout_small_payout_keeps_mode(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = _store(tmp)
            store.start_double("1", 100)
            result = store.double_cashout("1")
            self.assertEqual(result["payout"], 100)
            self.assertEqual(store.user_state("1")["internal_mode"], "NORMAL")


# ---------------------------------------------------------------------------
# blackjack
# ---------------------------------------------------------------------------

class BlackjackStoreTest(unittest.TestCase):
    def test_start_validation_and_deal(self):
        with tempfile.TemporaryDirectory() as tmp:
            rng = _ScriptedRandom(choice_results=[5, 6, 10, 9])
            store = _store(tmp, rng=rng)
            with self.assertRaises(ItemError):
                store.start_blackjack("1", gambling.BLACKJACK_MIN_BET - 1)
            session = store.start_blackjack("1", 100)
            self.assertEqual(session["player"], [5, 6])
            self.assertEqual(session["dealer"], [10, 9])
            with self.assertRaises(ItemError):
                store.start_blackjack("1", 100)

    def test_hit_without_bust(self):
        with tempfile.TemporaryDirectory() as tmp:
            rng = _ScriptedRandom(choice_results=[5, 6, 10, 9, 3])
            store = _store(tmp, rng=rng)
            store.start_blackjack("1", 100)
            result = store.blackjack_hit("1")
            self.assertFalse(result["bust"])
            self.assertEqual(result["total"], 14)
            self.assertIsNotNone(store.session("1"))

    def test_hit_bust_ends_session(self):
        with tempfile.TemporaryDirectory() as tmp:
            rng = _ScriptedRandom(choice_results=[10, 9, 10, 9, 5])
            store = _store(tmp, rng=rng)
            store.start_blackjack("1", 100)
            result = store.blackjack_hit("1")
            self.assertTrue(result["bust"])
            self.assertEqual(result["payout"], 0)
            self.assertIsNone(store.session("1"))

    def test_stand_dealer_draws_and_busts(self):
        with tempfile.TemporaryDirectory() as tmp:
            rng = _ScriptedRandom(choice_results=[10, 9, 10, 6, 10])
            store = _store(tmp, rng=rng)
            store.start_blackjack("1", 100)
            result = store.blackjack_stand("1")
            self.assertEqual(result["dealer"], [10, 6, 10])
            self.assertEqual(result["outcome"], "win")
            self.assertEqual(result["payout"], 200)
            self.assertIsNone(store.session("1"))

    def test_stand_lose_and_push(self):
        with tempfile.TemporaryDirectory() as tmp:
            rng = _ScriptedRandom(choice_results=[10, 8, 10, 9, 10, 9, 10, 9])
            store = _store(tmp, rng=rng)
            store.start_blackjack("1", 100)
            lose = store.blackjack_stand("1")
            self.assertEqual(lose["outcome"], "lose")
            self.assertEqual(lose["payout"], 0)
            store.start_blackjack("2", 100)
            push = store.blackjack_stand("2")
            self.assertEqual(push["outcome"], "push")
            self.assertEqual(push["payout"], 100)


# ---------------------------------------------------------------------------
# dice
# ---------------------------------------------------------------------------

class DiceStoreTest(unittest.TestCase):
    def test_hit_and_miss(self):
        with tempfile.TemporaryDirectory() as tmp:
            rng = _ScriptedRandom(randints=[7, 3])
            store = _store(tmp, rng=rng)
            self.assertTrue(store.play_dice(100, 7)["hit"])
            result = store.play_dice(100, 7)
            self.assertFalse(result["hit"])
            self.assertEqual(result["rolled"], 3)

    def test_validation(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = _store(tmp)
            with self.assertRaises(ItemError):
                store.play_dice(gambling.DICE_MIN_MAX - 1, 1)
            with self.assertRaises(ItemError):
                store.play_dice(gambling.DICE_MAX_MAX + 1, 1)
            with self.assertRaises(ItemError):
                store.play_dice(100, 0)
            with self.assertRaises(ItemError):
                store.play_dice(100, 101)


# ---------------------------------------------------------------------------
# 永続化・返金
# ---------------------------------------------------------------------------

class PersistenceTest(unittest.TestCase):
    def test_roundtrip_keeps_state_and_session(self):
        with tempfile.TemporaryDirectory() as tmp:
            rng = _ScriptedRandom(randoms=[0.5])
            store = _store(tmp, rng=rng)
            store.start_double("1", 1000)
            store.double_go("1")
            store.flush()
            reloaded = gambling.GamblingStore(Path(tmp) / "gambling.json")
            session = reloaded.session("1")
            self.assertIsNotNone(session)
            self.assertAlmostEqual(session["multiplier"], 1.9)
            self.assertEqual(reloaded.user_state("1")["win_streak"], 1)

    def test_orphaned_refunds_cover_all_kinds(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = {
                "users": {},
                "sessions": {
                    "1": _slot_session(remaining=3),
                    "2": {"kind": "double", "bet": 500, "multiplier": 1.9, "streak": 1},
                    "3": {"kind": "blackjack", "bet": 200,
                          "player": [10, 9], "dealer": [10, 9]},
                },
            }
            store = _store(tmp, state=state)
            refunds = store.orphaned_refunds()
            by_user = {r["user_id"]: r for r in refunds}
            self.assertEqual(by_user["1"]["amount"], 3 * gambling.SLOT_BET)
            self.assertEqual(by_user["2"]["amount"], 500)
            self.assertEqual(by_user["3"]["amount"], 200)
            self.assertIsNone(store.session("1"))
            self.assertEqual(store.orphaned_refunds(), [])


# ---------------------------------------------------------------------------
# Cog フロー
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


class _FakeBot:
    def __init__(self, cogs: dict):
        self._cogs = cogs

    def get_cog(self, name):
        return self._cogs.get(name)


class CogFlowTest(unittest.TestCase):
    def _cog(self, tmp: str, wallet: _FakeWallet, rng=None):
        store = gambling.GamblingStore(
            Path(tmp) / "gambling.json", rng=rng or random.Random(42))
        bot = _FakeBot({"WalletCog": wallet})
        cog = GamblingCog(
            bot, store=store,
            balance_reader=lambda uid: wallet.balances.get(uid, 0))
        return cog, store

    def test_slot_start_insufficient_keeps_balance(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _FakeWallet({"1": 5000})
            cog, store = self._cog(tmp, wallet)
            message = asyncio.run(cog.execute_slot_start(1, 10))
            self.assertIn("不足", message)
            self.assertEqual(wallet.balances["1"], 5000)
            self.assertIsNone(store.session("1"))

    def test_slot_start_and_spin_payout(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _FakeWallet({"1": 100000})
            rng = _ScriptedRandom(choices_results=[[1, 1, 2, 3, 4, 5, 9]])
            cog, store = self._cog(tmp, wallet, rng=rng)
            message = asyncio.run(cog.execute_slot_start(1, 10))
            self.assertIn("スロット開始", message)
            self.assertEqual(wallet.balances["1"], 100000 - 10 * gambling.SLOT_BET)
            message = asyncio.run(cog.execute_slot_spin(1))
            self.assertIn("2揃い", message)
            self.assertEqual(wallet.balances["1"],
                             100000 - 10 * gambling.SLOT_BET + 1100)

    def test_slot_spin_confiscates_all(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _FakeWallet({"1": 100000})
            rng = _ScriptedRandom(choices_results=[[6, 6, 6, 6, 6, 1, 2]])
            cog, store = self._cog(tmp, wallet, rng=rng)
            asyncio.run(cog.execute_slot_start(1, 10))
            message = asyncio.run(cog.execute_slot_spin(1))
            self.assertIn("全額没収", message)
            self.assertEqual(wallet.balances["1"], 0)

    def test_slot_spin_penalty_can_take_balance_negative(self):
        # 原典どおり 6ペナルティは残高を割って引き落とされる。
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _FakeWallet({"1": 10000})
            rng = _ScriptedRandom(choices_results=[[6, 6, 1, 2, 3, 4, 5]])
            cog, store = self._cog(tmp, wallet, rng=rng)
            asyncio.run(cog.execute_slot_start(1, 10))
            self.assertEqual(wallet.balances["1"], 0)
            asyncio.run(cog.execute_slot_spin(1))
            self.assertEqual(wallet.balances["1"], -9000)

    def test_double_flow_win_and_cashout(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _FakeWallet({"1": 10000})
            rng = _ScriptedRandom(randoms=[0.5])
            cog, store = self._cog(tmp, wallet, rng=rng)
            asyncio.run(cog.execute_double_start(1, 1000))
            self.assertEqual(wallet.balances["1"], 9000)
            message = asyncio.run(cog.execute_double_go(1))
            self.assertIn("成功", message)
            message = asyncio.run(cog.execute_double_cashout(1))
            self.assertIn("確定", message)
            self.assertEqual(wallet.balances["1"], 9000 + 1900)

    def test_double_flow_lose_loses_bet(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _FakeWallet({"1": 10000})
            rng = _ScriptedRandom(randoms=[0.99])
            cog, store = self._cog(tmp, wallet, rng=rng)
            asyncio.run(cog.execute_double_start(1, 1000))
            message = asyncio.run(cog.execute_double_go(1))
            self.assertIn("失敗", message)
            self.assertEqual(wallet.balances["1"], 9000)
            self.assertIsNone(store.session("1"))

    def test_blackjack_flow_stand_win(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _FakeWallet({"1": 10000})
            rng = _ScriptedRandom(choice_results=[10, 9, 10, 6, 10])
            cog, store = self._cog(tmp, wallet, rng=rng)
            asyncio.run(cog.execute_blackjack_start(1, 1000))
            self.assertEqual(wallet.balances["1"], 9000)
            message = asyncio.run(cog.execute_blackjack_stand(1))
            self.assertIn("勝ち", message)
            self.assertEqual(wallet.balances["1"], 9000 + 2000)

    def test_blackjack_start_insufficient_keeps_balance(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _FakeWallet({"1": 100})
            cog, store = self._cog(tmp, wallet)
            message = asyncio.run(cog.execute_blackjack_start(1, 1000))
            self.assertIn("不足", message)
            self.assertEqual(wallet.balances["1"], 100)
            self.assertIsNone(store.session("1"))

    def test_dice_flow_hit_and_miss(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _FakeWallet({"1": 10000})
            rng = _ScriptedRandom(randints=[7, 3])
            cog, store = self._cog(tmp, wallet, rng=rng)
            message = asyncio.run(cog.execute_dice(1, 100, 7, 100))
            self.assertIn("当たり", message)
            self.assertEqual(wallet.balances["1"], 10000 - 100 + 100 * 100)
            message = asyncio.run(cog.execute_dice(1, 100, 7, 100))
            self.assertIn("はずれ", message)
            self.assertEqual(wallet.balances["1"], 10000 - 100 + 100 * 100 - 100)

    def test_dice_below_min_keeps_balance(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _FakeWallet({"1": 10000})
            cog, store = self._cog(tmp, wallet)
            message = asyncio.run(cog.execute_dice(1, 100, 7, 5))
            self.assertIn("以上", message)
            self.assertEqual(wallet.balances["1"], 10000)

    def test_refund_orphaned_sessions(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _FakeWallet({"1": 0, "2": 100})
            state = {
                "users": {},
                "sessions": {
                    "1": _slot_session(remaining=3),
                    "2": {"kind": "blackjack", "bet": 200,
                          "player": [10, 9], "dealer": [10, 9]},
                },
            }
            store = _store(tmp, state=state)
            bot = _FakeBot({"WalletCog": wallet})
            cog = GamblingCog(
                bot, store=store,
                balance_reader=lambda uid: wallet.balances.get(uid, 0))
            asyncio.run(cog._refund_orphaned())
            self.assertEqual(wallet.balances["1"], 3 * gambling.SLOT_BET)
            self.assertEqual(wallet.balances["2"], 300)
            self.assertIsNone(store.session("1"))
            # 二度目は返金しない。
            asyncio.run(cog._refund_orphaned())
            self.assertEqual(wallet.balances["1"], 3 * gambling.SLOT_BET)


# ---------------------------------------------------------------------------
# レジストリ
# ---------------------------------------------------------------------------

class RegistryTest(unittest.TestCase):
    def test_gambling_actions_are_registered_and_blocked(self):
        from core.general.common import GENERAL_ACTIONS

        values = {value for _label, value in GENERAL_ACTIONS["money"]}
        for value in ("slot", "double", "blackjack", "dice"):
            self.assertIn(value, values)
            self.assertIn(f"general:{value}", action_registry.AI_BLOCKED_IDS)

    def test_gambling_specs_are_blocked_risk(self):
        registry = action_registry.default_registry()
        for value in ("slot", "double", "blackjack", "dice"):
            spec = registry.by_id(f"general:{value}")
            self.assertEqual(spec.risk, "blocked")
            self.assertNotIn("aitools", spec.surfaces)
