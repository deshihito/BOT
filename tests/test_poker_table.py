"""ポーカー作り直し（A3）のテスト。

- ベットラウンドの状態機械（コール一致・レイズの再オープン・オールイン）
- ポット分配（サイドポット・分割・端数・レーキ）と保存則
- チップ預かり台帳の読み書き
- バイイン／精算／未精算返金（偽 wallet 経由、コインが増殖しないこと）
"""
import random
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import game_fakes  # noqa: F401
from core.game.game import party_ranking
import core.game.poker.cog as poker
from cogs.game import BettingRound, PokerTable, distribute_pot, settle_hand
from cogs.general import INSUFFICIENT, NEW_USER_BALANCE


def user(uid):
    return SimpleNamespace(id=uid, mention=f"<@{uid}>")


class BettingRoundTest(unittest.TestCase):
    def test_all_check_completes(self):
        stacks = {1: 100, 2: 100, 3: 100}
        r = BettingRound([1, 2, 3], stacks)
        for uid in (1, 2, 3):
            self.assertEqual(r.current_player(), uid)
            r.act(uid, "call")
        self.assertTrue(r.is_complete())
        self.assertEqual(r.contributions, {1: 0, 2: 0, 3: 0})

    def test_bet_and_call_match(self):
        stacks = {1: 100, 2: 100, 3: 100}
        r = BettingRound([1, 2, 3], stacks)
        r.act(1, "raise")
        self.assertEqual(r.current_bet, 20)
        r.act(2, "call")
        r.act(3, "fold")
        self.assertTrue(r.is_complete())
        self.assertEqual(r.contributions, {1: 20, 2: 20, 3: 0})
        self.assertEqual(stacks, {1: 80, 2: 80, 3: 100})

    def test_raise_reopens_action(self):
        stacks = {1: 100, 2: 100, 3: 100}
        r = BettingRound([1, 2, 3], stacks)
        r.act(1, "call")
        r.act(2, "raise")
        r.act(3, "call")
        self.assertFalse(r.is_complete())
        self.assertEqual(r.current_player(), 1)
        r.act(1, "call")
        self.assertTrue(r.is_complete())

    def test_turn_order_after_raise(self):
        stacks = {1: 100, 2: 100, 3: 100}
        r = BettingRound([1, 2, 3], stacks)
        r.act(1, "raise")
        # レイズの次は着席順どおり 2 の番（先頭に戻らない）
        self.assertEqual(r.current_player(), 2)

    def test_allin_call_for_less(self):
        stacks = {1: 100, 2: 5}
        r = BettingRound([1, 2], stacks)
        r.act(1, "raise")
        r.act(2, "call")
        self.assertEqual(r.contributions[2], 5)
        self.assertTrue(r.is_complete())

    def test_out_of_turn_rejected(self):
        r = BettingRound([1, 2], {1: 100, 2: 100})
        with self.assertRaises(ValueError):
            r.act(2, "call")


class DistributePotTest(unittest.TestCase):
    def test_single_survivor_takes_all_minus_rake(self):
        payouts, rake = distribute_pot({1: 30, 2: 30, 3: 30}, {2, 3}, {})
        self.assertEqual(rake, 4)  # 90 * 5% = 4.5 → 受取 90 から切り捨て 4
        self.assertEqual(payouts, {1: 86, 2: 0, 3: 0})

    def test_split_pot_with_remainder(self):
        # 同役2人の山分け: 75 を 38/37（端数は着席順）、各受取から 5% 切り捨て
        scores = {1: (1, 9), 2: (1, 9), 3: (0, 9)}
        payouts, rake = distribute_pot({1: 25, 2: 25, 3: 25}, set(), scores)
        self.assertEqual(sum(payouts.values()) + rake, 75)
        self.assertEqual(payouts[1], 37)   # 38 - 1（レーキ）
        self.assertEqual(payouts[2], 36)   # 37 - 1（レーキ）
        self.assertEqual(payouts[3], 0)
        self.assertEqual(rake, 2)

    def test_uneven_contributions_make_side_tiers(self):
        scores = {1: (1, 9), 2: (1, 9), 3: (1, 9)}
        payouts, rake = distribute_pot({1: 40, 2: 30, 3: 30}, set(), scores)
        # 30の段（90）は3人で30ずつ、40の段（10）は拠出した1だけのもの
        self.assertEqual(sum(payouts.values()) + rake, 100)
        self.assertEqual(payouts[1], 38)   # 40 - 2（レーキ）
        self.assertEqual(payouts[2], 29)   # 30 - 1（レーキ）
        self.assertEqual(payouts[3], 29)

    def test_side_pot(self):
        # 2 は 5 までしか出していないので、20 の段は 1 だけのもの
        scores = {1: (0, 2), 2: (8, 14)}  # 手は 2 が強い
        payouts, rake = distribute_pot({1: 20, 2: 5}, set(), scores)
        self.assertEqual(sum(payouts.values()) + rake, 25)
        self.assertEqual(payouts[2], 10 - 0)  # 5の段（10）を総取り、レーキ 0（10*5%<1）
        self.assertEqual(payouts[1], 15 - 0)  # 20の段（15）は 1 のもの、レーキ 0

    def test_conservation_randomized(self):
        rng = random.Random(20261106)
        for _ in range(300):
            n = rng.randint(2, 6)
            contributions = {uid: rng.choice([0, 5, 10, 20, 40, 60]) for uid in range(1, n + 1)}
            if sum(contributions.values()) == 0:
                continue
            folded = {uid for uid in contributions if rng.random() < 0.3}
            if len(folded) == len(contributions):
                folded.pop()
            scores = {uid: (rng.randint(0, 8), rng.randint(2, 14)) for uid in contributions if uid not in folded}
            payouts, rake = distribute_pot(contributions, folded, scores)
            self.assertEqual(sum(payouts.values()) + rake, sum(contributions.values()))
            self.assertTrue(all(amount >= 0 for amount in payouts.values()))
            for uid in folded:
                self.assertEqual(payouts[uid], 0)

    def test_settle_hand_conservation(self):
        stacks = {1: 70, 2: 80, 3: 90}
        contributions = {1: 30, 2: 20, 3: 10}
        scores = {1: (2, 14), 2: (1, 9), 3: (0, 5)}
        before = sum(stacks.values()) + sum(contributions.values())
        payouts, rake = settle_hand(stacks, contributions, set(), scores)
        self.assertEqual(sum(stacks.values()) + rake, before)
        self.assertGreater(payouts[1], 0)


class FakeWallet:
    def __init__(self, balances):
        self.balances = {str(k): v for k, v in balances.items()}
        self.fail_credit = False

    async def _change_balance(self, user_id, delta, *, require_funds=False, create_with=None):
        uid = str(user_id)
        if delta > 0 and self.fail_credit:
            return None
        if uid not in self.balances:
            if require_funds:
                return INSUFFICIENT
            if create_with is None:
                return None
            self.balances[uid] = create_with
        new_balance = self.balances[uid] + delta
        if require_funds and new_balance < 0:
            return INSUFFICIENT
        self.balances[uid] = new_balance
        return new_balance


class PokerMoneyTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        party_ranking._shared = party_ranking.PartyRanking(client=None)
        self.wallet = FakeWallet({1: 1000, 2: 100})
        bot = SimpleNamespace(get_cog=lambda name: self.wallet if name == "WalletCog" else None)
        self.cog = poker.Poker(bot)
        self.tmp = Path(self.id().replace(".", "_") + "_chips.json")
        self.cog.custody = poker.ChipCustodyStore(self.tmp)
        self.history = []

        async def record(sender, receiver, amount, reason):
            self.history.append((sender, receiver, amount, reason))
        self.cog._record_history = record
        self.table = PokerTable(555, 66, 1)
        self.table.players = {1: user(1), 2: user(2)}
        self.table.phase = "buyin"

    def tearDown(self):
        self.tmp.unlink(missing_ok=True)

    async def test_buyin_moves_coins_to_chips(self):
        ok, _ = await self.cog.buy_in(self.table, user(1), 500)
        self.assertTrue(ok)
        self.assertEqual(self.wallet.balances["1"], 500)
        self.assertEqual(self.table.stacks[1], 500)
        self.assertEqual(self.cog.custody.entries(), {555: {1: 500}})
        self.assertEqual(self.history[0][3], "poker_buyin")

    async def test_buyin_insufficient_rejected(self):
        ok, _ = await self.cog.buy_in(self.table, user(2), 500)
        self.assertFalse(ok)
        self.assertEqual(self.wallet.balances["2"], 100)
        self.assertNotIn(2, self.table.stacks)

    async def test_buyin_wrong_phase_rejected(self):
        self.table.phase = "betting"
        ok, _ = await self.cog.buy_in(self.table, user(1), 100)
        self.assertFalse(ok)
        self.assertEqual(self.wallet.balances["1"], 1000)

    async def test_rebuy_only_when_low(self):
        self.table.phase = "continue"
        self.table.stacks[1] = 500
        ok, _ = await self.cog.buy_in(self.table, user(1), 100)
        self.assertFalse(ok)
        self.table.stacks[1] = 50
        ok, _ = await self.cog.buy_in(self.table, user(1), 100)
        self.assertTrue(ok)
        self.assertEqual(self.table.stacks[1], 150)

    async def test_cashout_returns_coins_and_clears_custody(self):
        await self.cog.buy_in(self.table, user(1), 500)
        ok = await self.cog.cash_out(self.table, 1)
        self.assertTrue(ok)
        self.assertEqual(self.wallet.balances["1"], 1000)
        self.assertEqual(self.cog.custody.entries(), {})
        self.assertEqual(self.history[-1][3], "poker_cashout")

    async def test_cashout_failure_keeps_custody(self):
        await self.cog.buy_in(self.table, user(1), 500)
        self.wallet.fail_credit = True
        ok = await self.cog.cash_out(self.table, 1)
        self.assertFalse(ok)
        self.assertEqual(self.cog.custody.entries(), {555: {1: 500}})

    async def test_orphaned_chips_refunded_on_startup(self):
        self.cog.custody.set(999, 7, 250)
        await self.cog._refund_orphaned()
        # 新規ユーザー行は NEW_USER_BALANCE で作られてから 250 が足される
        self.assertEqual(self.wallet.balances["7"],
                         NEW_USER_BALANCE + 250)
        self.assertEqual(self.cog.custody.entries(), {})

    def test_poker_registered_for_ranking(self):
        self.assertIn("poker", party_ranking.KNOWN_GAMES)
        self.assertTrue(party_ranking.is_ranked("poker"))


class CustodyStoreTest(unittest.TestCase):
    def test_roundtrip(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "chips.json"
            store = poker.ChipCustodyStore(path)
            store.set(10, 1, 300)
            store.set(10, 2, 100)
            store.set(10, 2, 0)
            reloaded = poker.ChipCustodyStore(path)
            self.assertEqual(reloaded.entries(), {10: {1: 300}})


if __name__ == "__main__":
    unittest.main()
