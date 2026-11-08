"""じゃんけんの賭け金預かり台帳（data/janken_escrow.json）のテスト。

ポーカーのチップ台帳と同じ考え方: 徴収のたびに台帳へ同期記録し、
精算前にプロセスが再起動したら起動時返金 (_refund_orphaned) で全額戻る。
再起動は「新しい cog インスタンス + ディスクから読み直した台帳」で模擬する。
"""

import types
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from game_fakes import FakeChannel, FakeGuild, FakeMember, fast_time
import core.game.janken.cog as j
from cogs.general import INSUFFICIENT


class FakeWallet:
    """test_poker_table.FakeWallet と同じ作りの最小ウォレット。"""

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


class JankenEscrowTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "janken_escrow.json"
        self.wallet = FakeWallet({1: 1000, 2: 1000, 3: 1000})
        self.bot = types.SimpleNamespace(
            get_cog=lambda name: self.wallet if name == "WalletCog" else None)

    def make_cog(self):
        cog = j.Janken(self.bot)
        cog.escrow_ledger = j.EscrowLedger(self.path)
        return cog

    def make_game(self, wager=100, players=(1, 2, 3)):
        game = j.JankenGame(700, 77, 1)
        game.wager = wager
        game.players = {uid: types.SimpleNamespace(id=uid) for uid in players}
        return game

    def reload_entries(self):
        return j.EscrowLedger(self.path).entries()

    async def test_collect_records_then_restart_refunds_all(self):
        cog = self.make_cog()
        game = self.make_game()
        self.assertTrue(await cog._collect_wagers(game))
        self.assertEqual(self.wallet.balances, {"1": 900, "2": 900, "3": 900})
        # 台帳はディスク上の実態とも一致する（再起動模擬の前提）。
        self.assertEqual(self.reload_entries(),
                         {700: {"guild_id": 77, "wager": 100, "users": [1, 2, 3]}})

        # プロセス再起動の模擬: 新しい cog が台帳を読み、起動時返金する。
        cog2 = self.make_cog()
        await cog2._refund_orphaned()
        self.assertEqual(self.wallet.balances, {"1": 1000, "2": 1000, "3": 1000})
        self.assertEqual(self.reload_entries(), {})

        # 冪等性: 同じ cog の再実行でも、新しい cog でも二重返金しない。
        await cog2._refund_orphaned()
        cog3 = self.make_cog()
        await cog3._refund_orphaned()
        self.assertEqual(self.wallet.balances, {"1": 1000, "2": 1000, "3": 1000})

    async def test_normal_payout_clears_ledger_no_double_refund(self):
        cog = self.make_cog()
        game = self.make_game()
        self.assertTrue(await cog._collect_wagers(game))
        await cog._pay_winners(game, [1])
        # 勝者 1 が総取り (300)、敗者は預かり分を失う。通常精算どおり。
        self.assertEqual(self.wallet.balances, {"1": 1200, "2": 900, "3": 900})
        self.assertEqual(game.escrow, [])
        self.assertEqual(self.reload_entries(), {})

        cog2 = self.make_cog()
        await cog2._refund_orphaned()
        self.assertEqual(self.wallet.balances, {"1": 1200, "2": 900, "3": 900})

    async def test_refund_failure_keeps_entry_for_next_startup(self):
        cog = self.make_cog()
        game = self.make_game()
        self.assertTrue(await cog._collect_wagers(game))

        self.wallet.fail_credit = True
        cog2 = self.make_cog()
        await cog2._refund_orphaned()
        # 返金できなかった分は台帳に残り、残高も戻っていない。
        self.assertEqual(self.wallet.balances, {"1": 900, "2": 900, "3": 900})
        self.assertEqual(self.reload_entries(),
                         {700: {"guild_id": 77, "wager": 100, "users": [1, 2, 3]}})

        # 次回起動（新しい cog）で返金できる。
        self.wallet.fail_credit = False
        cog3 = self.make_cog()
        await cog3._refund_orphaned()
        self.assertEqual(self.wallet.balances, {"1": 1000, "2": 1000, "3": 1000})
        self.assertEqual(self.reload_entries(), {})

    async def test_collect_failure_rolls_back_and_ledger_matches(self):
        # 3 人目だけ残高不足 → 徴収は失敗し、巻き戻しで全員元どおり。
        # 台帳にも「減算済みなのに記録なし／記録だけ」の不整合が残らない。
        self.wallet.balances["3"] = 50
        cog = self.make_cog()
        game = self.make_game()
        self.assertFalse(await cog._collect_wagers(game))
        self.assertEqual(self.wallet.balances, {"1": 1000, "2": 1000, "3": 50})
        self.assertEqual(game.escrow, [])
        self.assertEqual(self.reload_entries(), {})

        cog2 = self.make_cog()
        await cog2._refund_orphaned()
        self.assertEqual(self.wallet.balances, {"1": 1000, "2": 1000, "3": 50})

    async def test_no_wager_game_writes_nothing(self):
        guild = FakeGuild(77)
        channel = FakeChannel(700, guild)
        cog = self.make_cog()
        game = self.make_game(wager=0, players=(1,))
        game.players = {1: FakeMember(1, guild)}
        with fast_time(scale=0.001):
            await cog.run_game(channel, game)
        # 賭けなし対局では台帳ファイル自体が作られない。
        self.assertFalse(self.path.exists())
        self.assertEqual(self.wallet.balances, {"1": 1000, "2": 1000, "3": 1000})


if __name__ == "__main__":
    unittest.main()
