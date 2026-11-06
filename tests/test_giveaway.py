"""抽選（cogs/giveaway.py）のテスト。Supabase は使わず、一時フォルダの bot_kv.json にだけ書く。"""
import asyncio
import os
import random
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

ROOT = Path(__file__).resolve().parents[1]
for p in (ROOT, ROOT / "tests"):
    if str(p) not in sys.path:
        sys.path.insert(0, str(p))

import game_fakes  # noqa: E402,F401
from cogs import giveaway as gw  # noqa: E402
from cogs.wallet import INSUFFICIENT  # noqa: E402
from core.support.storage import KVStore  # noqa: E402


class FakeWallet:
    def __init__(self, balances):
        self.balances = dict(balances)
        self.fail = False

    async def _change_balance(self, user_id, delta, *, require_funds=False, create_with=None):
        if self.fail:
            return None
        uid = int(user_id)
        new = self.balances.get(uid, 0) + delta
        if require_funds and new < 0:
            return INSUFFICIENT
        self.balances[uid] = new
        return new


def member(uid, roles=(), manage=False):
    return types.SimpleNamespace(id=uid, bot=False, roles=[types.SimpleNamespace(id=r) for r in roles],
                                 guild_permissions=types.SimpleNamespace(manage_guild=manage))


class Base(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.path = os.path.join(tmp.name, "kv.json")
        self.now = [1_000_000.0]
        self.channel = types.SimpleNamespace(id=50, send=AsyncMock(),
                                             get_partial_message=lambda mid: types.SimpleNamespace(id=mid, edit=AsyncMock()))
        self.wallet = FakeWallet({1: 100, 2: 5, 3: 100})
        self.cogs = {"WalletCog": self.wallet}
        self.bot = types.SimpleNamespace(get_channel=lambda cid: self.channel if cid == 50 else None,
                                         get_cog=self.cogs.get)
        self.cog = self.new_cog()

    def new_cog(self):
        cog = gw.GiveawayCog(self.bot, kv=KVStore("giveaway", client=None, path=self.path), clock=lambda: self.now[0])
        self.addCleanup(cog.cog_unload)
        return cog

    async def start(self, mid=900, **kw):
        args = dict(message_id=mid, guild_id=1, channel_id=50, host_id=10, prize="ギフト券", winners=1, minutes=10)
        args.update(kw)
        return await self.cog.create(**args)


class EntryTest(Base):
    async def test_toggle_entry(self):
        await self.start()
        self.assertIn("参加しました", await self.cog.toggle_entry(900, member(1)))
        self.assertEqual(self.cog.data["900"]["entrants"], [1])
        self.assertIn("取り消しました", await self.cog.toggle_entry(900, member(1)))
        self.assertEqual(self.cog.data["900"]["entrants"], [])

    async def test_required_role(self):
        await self.start(role_id=77)
        self.assertIn("ロールが必要", await self.cog.toggle_entry(900, member(1)))
        self.assertIn("参加しました", await self.cog.toggle_entry(900, member(1, roles=[77])))

    async def test_cost_charged_and_refunded(self):
        await self.start(cost=10)
        await self.cog.toggle_entry(900, member(1))
        self.assertEqual(self.wallet.balances[1], 90)
        self.assertIn("残高が足りません", await self.cog.toggle_entry(900, member(2)))
        self.assertEqual(self.wallet.balances[2], 5)
        await self.cog.toggle_entry(900, member(1))
        self.assertEqual(self.wallet.balances[1], 100)

    async def test_wallet_error_does_not_enter(self):
        await self.start(cost=10)
        self.wallet.fail = True
        self.assertIn("エラー", await self.cog.toggle_entry(900, member(1)))
        self.assertEqual(self.cog.data["900"]["entrants"], [])

    async def test_cancel_refunds_everyone(self):
        await self.start(cost=10)
        await self.cog.toggle_entry(900, member(1))
        await self.cog.toggle_entry(900, member(3))
        self.assertTrue(await self.cog.cancel(900))
        self.assertEqual((self.wallet.balances[1], self.wallet.balances[3]), (100, 100))
        self.assertEqual(self.cog.data["900"]["status"], gw.CANCELLED)
        self.assertIn("締め切られて", await self.cog.toggle_entry(900, member(1)))


class DrawTest(Base):
    async def test_winner_dm_is_sent_with_optional_comment_and_link(self):
        winner = types.SimpleNamespace(send=AsyncMock())
        self.bot.get_user = lambda uid: winner if uid == 1 else None
        await self.start(winner_dm_message="おめでとう", winner_dm_link="https://example.com")
        await self.cog.toggle_entry(900, member(1))
        await self.cog.finish(900)
        message = winner.send.await_args.args[0]
        self.assertIn("おめでとう", message)
        self.assertIn("https://example.com", message)

    async def test_end_early_and_reroll(self):
        await self.start(winners=2)
        for uid in (1, 2, 3):
            await self.cog.toggle_entry(900, member(uid))
        random.seed(1)
        self.assertTrue(await self.cog.finish(900))
        first = self.cog.data["900"]["winner_ids"]
        self.assertEqual(len(first), 2)
        self.assertFalse(await self.cog.finish(900))
        new = await self.cog.reroll(900)
        self.assertEqual(len(new), 1)
        self.assertNotIn(new[0], first)
        self.channel.send.assert_awaited()

    async def test_no_entrants(self):
        await self.start()
        await self.cog.finish(900)
        self.assertEqual(self.cog.data["900"]["winner_ids"], [])
        self.assertIn("当選者はいません", self.channel.send.await_args.args[0])

    def test_draw_helper(self):
        self.assertEqual(sorted(gw.draw([1, 2, 2, 3], 5)), [1, 2, 3])
        self.assertEqual(gw.draw([1, 2], 1, exclude=(1,)), [2])

    async def test_timer_finishes(self):
        await self.start(minutes=1)
        self.now[0] += 120  # 時間が過ぎた
        self.cog.schedule("900")
        await asyncio.sleep(0.01)
        self.assertEqual(self.cog.data["900"]["status"], gw.ENDED)


class PersistenceTest(Base):
    async def test_resume_after_restart(self):
        await self.start(minutes=10)
        await self.cog.toggle_entry(900, member(1))
        self.cog.cog_unload()
        cog2 = self.new_cog()
        await cog2.resume(wait_ready=False)
        self.assertEqual(cog2.data["900"]["entrants"], [1])
        self.assertIn("900", cog2.tasks)
        self.assertFalse(cog2.tasks["900"].done())

    async def test_overdue_giveaway_finishes_on_resume(self):
        await self.start(minutes=1)
        await self.cog.toggle_entry(900, member(1))
        self.cog.cog_unload()
        self.now[0] += 3600
        cog2 = self.new_cog()
        await cog2.resume(wait_ready=False)
        await asyncio.sleep(0.01)
        self.assertEqual(cog2.data["900"]["winner_ids"], [1])

    async def test_old_finished_ones_are_dropped(self):
        await self.start()
        await self.cog.finish(900)
        self.now[0] += gw.KEEP_FINISHED_SECONDS + 10
        cog2 = self.new_cog()
        await cog2.resume(wait_ready=False)
        self.assertNotIn("900", cog2.data)


class UiTest(Base):
    def test_embed_and_view(self):
        g = {"prize": "P", "winners": 2, "entrants": [1], "host_id": 10, "role_id": 7, "cost": 5,
             "ends_at": 100, "status": gw.RUNNING}
        embed, _ = gw.build_embed(g)
        self.assertEqual(embed.color.value, 0xf1c40f)
        self.assertIn("P", embed.title)
        ids = [i.custom_id for i in gw.build_view(900, g).children]
        self.assertEqual(ids, ["giveaway:join:900", "giveaway:manage:900"])
        g["status"] = gw.ENDED
        self.assertEqual([i.custom_id for i in gw.build_view(900, g).children], ["giveaway:manage:900"])

    async def test_buttons_route(self):
        await self.start()
        it = types.SimpleNamespace(type=gw.discord.InteractionType.component, data={"custom_id": "giveaway:join:900"},
                                   user=member(1), response=types.SimpleNamespace(defer=AsyncMock(), send_message=AsyncMock()),
                                   followup=types.SimpleNamespace(send=AsyncMock()))
        await self.cog.on_interaction(it)
        self.assertIn("参加しました", it.followup.send.await_args.args[0])
        it.data = {"custom_id": "giveaway:manage:900"}
        it.user = member(2)
        await self.cog.on_interaction(it)
        self.assertIn("主催者", it.response.send_message.await_args.args[0])
        it.user = member(10)
        await self.cog.on_interaction(it)
        self.assertIsInstance(it.response.send_message.await_args.kwargs["view"], gw.ManageView)


if __name__ == "__main__":
    unittest.main()
