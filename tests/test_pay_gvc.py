"""/pay の送金の安全性と !gvc delete の権限のテスト。Discord・DB APIには接続しない。

偽の Discord とDB APIは tests/test_all_commands.py のものを使う。
"""

import asyncio
import os
import sys
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from tests.test_all_commands import USER_ID, FakeDBAPI, fake_context, fake_interaction  # noqa: E402

import discord  # noqa: E402
from discord.ext import commands  # noqa: E402

import config  # noqa: E402
from core.support.api_client import APIError  # noqa: E402
from core.vc.globalvc import entry as gvc  # noqa: E402
from core.general.wallet import cog as wallet_module  # noqa: E402

SENDER, RECEIVER, THIRD = str(USER_ID), str(USER_ID + 1), str(USER_ID + 2)


class ThreadSafeFakeDBAPI(FakeDBAPI):
    """asyncio.to_thread から同時に呼ばれても壊れないように、1 回の execute をロックで守る。

    hooks[(table, action)] に関数を入れると、その操作の直前に呼ばれる（割り込みや失敗の再現用）。
    delay を入れると、読み取りの後に少し待って、同時実行の割り込みを起きやすくする。
    """

    def __init__(self):
        super().__init__()
        self.lock = threading.Lock()
        self.hooks = {}
        self.delay = 0.0

    def table(self, name):
        query = super().table(name)
        db = self
        original = query.execute

        def execute():
            hook = db.hooks.get((name, query.action))
            if hook:
                hook(query)
            with db.lock:
                result = original()
            if query.action == 'select' and db.delay:
                time.sleep(db.delay)
            return result
        query.execute = execute
        return query


def make_interaction(bot, user_id=USER_ID):
    interaction, recorder, objects = fake_interaction(bot)
    interaction.user = MagicMock(spec=discord.Member, id=user_id, bot=False, mention=f'<@{user_id}>')
    sent = []

    def capture(original):
        async def call(*args, **kwargs):
            sent.append({'content': kwargs.get('content', args[0] if args else None),
                         'embed': kwargs.get('embed'), 'ephemeral': kwargs.get('ephemeral', False),
                         'file': kwargs.get('file')})
            return await original(*args, **kwargs)
        return call

    interaction.response.send_message = capture(interaction.response.send_message)
    interaction.followup.send = capture(interaction.followup.send)
    interaction._sent = sent
    return interaction


def user(user_id, bot=False):
    return MagicMock(spec=discord.User, id=int(user_id), bot=bot, mention=f'<@{user_id}>')


class PayTest(unittest.TestCase):
    def setUp(self):
        self.db = ThreadSafeFakeDBAPI()
        self.patch = patch.object(config, 'db_api', self.db)
        self.patch.start()
        self.addCleanup(self.patch.stop)
        def rpc_unavailable(*_args, **_kwargs):
            raise APIError("function is not available", code="RPC_NOT_ALLOWED", status_code=404)
        self.db.rpc = rpc_unavailable
        self.bot = commands.Bot(command_prefix='!', intents=discord.Intents.none())
        self.cog = wallet_module.WalletCog(self.bot)

    def set_balance(self, user_id, balance):
        self.db.table('users').insert({'user_id': user_id, 'balance': balance, 'debt': 0}).execute()

    def balance(self, user_id):
        rows = self.db.table('users').select('balance').eq('user_id', user_id).execute().data
        return rows[0]['balance'] if rows else None

    async def pay(self, receiver, amount, sender=USER_ID):
        interaction = make_interaction(self.bot, sender)
        await self.cog.pay(interaction, receiver, amount)
        return interaction._sent

    def test_successful_pay_moves_coins_and_records_history(self):
        self.set_balance(SENDER, 100)
        self.set_balance(RECEIVER, 5)
        sent = asyncio.run(self.pay(user(RECEIVER), 30))
        self.assertEqual((self.balance(SENDER), self.balance(RECEIVER)), (70, 35))
        self.assertEqual(self.db.tables['transaction_history'][-1]['amount'], 30)
        self.assertIsNotNone(sent[-1]['embed'])
        self.assertFalse(sent[-1]['ephemeral'])

    def test_pay_replies_are_coin_embeds(self):
        self.set_balance(SENDER, 100)
        sent = asyncio.run(self.pay(user(RECEIVER), 30))
        private, public = sent[-2], sent[-1]
        self.assertTrue(private['ephemeral'])
        self.assertEqual(private['embed'].fields[0].value, '70 AGO')
        self.assertIn('30 AGO', public['embed'].description)
        for message in (private, public):
            self.assertEqual(message['embed'].thumbnail.url, 'attachment://coin.png')
            self.assertEqual(message['file'].filename, 'coin.png')

    def test_wallet_reply_is_coin_embed(self):
        self.set_balance(SENDER, 1234)
        interaction = make_interaction(self.bot, SENDER)
        asyncio.run(self.cog.user_status(interaction))
        message = interaction._sent[-1]
        self.assertEqual(message['embed'].fields[0].value, '1,234 AGO')
        self.assertEqual(message['embed'].thumbnail.url, 'attachment://coin.png')
        self.assertEqual(message['file'].filename, 'coin.png')

    def test_coin_image_is_in_assets(self):
        self.assertTrue(os.path.exists(wallet_module.COIN_PATH))
        with patch.object(wallet_module, 'COIN_PATH', '/nonexistent/coin.png'):
            embed, extra = wallet_module.coin_embed('t')
        self.assertEqual(extra, {})
        self.assertIsNone(embed.thumbnail.url)

    def test_new_receiver_gets_starting_balance_plus_amount(self):
        self.set_balance(SENDER, 100)
        asyncio.run(self.pay(user(RECEIVER), 30))
        self.assertEqual(self.balance(RECEIVER), 40)

    def test_self_pay_negative_zero_and_bots_are_rejected(self):
        self.set_balance(SENDER, 100)
        cases = [(user(SENDER), 10, '自分自身'), (user(RECEIVER), -5, '1コイン以上'),
                 (user(RECEIVER), 0, '1コイン以上'), (user(RECEIVER, bot=True), 10, 'Bot には')]
        for receiver, amount, message in cases:
            with self.subTest(amount=amount, message=message):
                sent = asyncio.run(self.pay(receiver, amount))
                self.assertIn(message, sent[0]['content'])
                self.assertTrue(sent[0]['ephemeral'])
        self.assertEqual(self.balance(SENDER), 100)
        self.assertIsNone(self.balance(RECEIVER))
        self.assertNotIn('transaction_history', self.db.tables)

    def test_insufficient_balance_is_rejected(self):
        self.set_balance(SENDER, 10)
        sent = asyncio.run(self.pay(user(RECEIVER), 11))
        self.assertIn('残高が不足', sent[-1]['content'])
        self.assertEqual(self.balance(SENDER), 10)
        self.assertIsNone(self.balance(RECEIVER))

    def test_ambiguous_atomic_rpc_failure_does_not_run_legacy_transfer(self):
        self.set_balance(SENDER, 100)
        self.set_balance(RECEIVER, 5)

        def ambiguous(*_args, **_kwargs):
            raise APIError("connection lost", code="API_CONNECTION_ERROR")
        self.db.rpc = ambiguous

        sent = asyncio.run(self.pay(user(RECEIVER), 30))
        self.assertEqual((self.balance(SENDER), self.balance(RECEIVER)), (100, 5))
        self.assertIn('二重送金を防ぐ', sent[-1]['content'])
        self.assertNotIn('transaction_history', self.db.tables)

    def test_failure_after_debit_refunds_sender(self):
        self.set_balance(SENDER, 100)
        self.set_balance(RECEIVER, 5)

        def fail_receiver_update(query):
            if query.payload and query.payload.get('balance') == 35:
                raise RuntimeError('network blip')
        self.db.hooks[('users', 'update')] = fail_receiver_update
        with self.assertLogs(wallet_module.logger, level='ERROR'):
            sent = asyncio.run(self.pay(user(RECEIVER), 30))
        self.assertEqual((self.balance(SENDER), self.balance(RECEIVER)), (100, 5))
        self.assertIn('取り消しました', sent[-1]['content'])
        self.assertTrue(sent[-1]['ephemeral'])
        self.assertNotIn('transaction_history', self.db.tables)

    def test_refund_failure_is_logged_and_sender_told_privately(self):
        self.set_balance(SENDER, 100)
        self.set_balance(RECEIVER, 5)
        calls = {'update': 0}

        def fail_after_debit(query):
            calls['update'] += 1
            if calls['update'] > 1:  # 1 回目（送り手から引く）だけ成功させる
                raise RuntimeError('supabase down')
        self.db.hooks[('users', 'update')] = fail_after_debit
        with self.assertLogs(wallet_module.logger, level='CRITICAL') as logs:
            sent = asyncio.run(self.pay(user(RECEIVER), 30))
        self.assertIn(f'sender={SENDER}', logs.output[-1])
        self.assertIn('amount=30', logs.output[-1])
        self.assertIn('返金もできませんでした', sent[-1]['content'])
        self.assertTrue(sent[-1]['ephemeral'])

    def test_balance_changed_between_read_and_write_is_not_overwritten(self):
        # 送り手の残高を読んだ直後に、ほかの処理（/guess など）が残高を 100 → 200 に変えた場合
        self.set_balance(SENDER, 100)
        self.set_balance(RECEIVER, 0)
        done = {'value': False}

        def interfere(query):
            if not done['value'] and query.payload.get('balance') == 70:
                done['value'] = True
                for row in self.db.tables['users']:
                    if row['user_id'] == SENDER:
                        row['balance'] = 200
        self.db.hooks[('users', 'update')] = interfere
        asyncio.run(self.pay(user(RECEIVER), 30))
        self.assertEqual((self.balance(SENDER), self.balance(RECEIVER)), (170, 30))

    def test_concurrent_pays_do_not_lose_updates(self):
        self.set_balance(SENDER, 100)
        self.set_balance(THIRD, 100)
        self.set_balance(RECEIVER, 0)
        self.db.delay = 0.01  # 読み取りの後に待たせて、ほかの送金と読み書きが重なるようにする

        async def run_all():
            await asyncio.gather(
                self.pay(user(RECEIVER), 10, sender=USER_ID),
                self.pay(user(RECEIVER), 20, sender=USER_ID),
                self.pay(user(RECEIVER), 30, sender=USER_ID + 2),
                self.pay(user(RECEIVER), 40, sender=USER_ID + 2),
            )
        asyncio.run(run_all())
        self.assertEqual(self.balance(SENDER), 70)
        self.assertEqual(self.balance(THIRD), 30)
        self.assertEqual(self.balance(RECEIVER), 100)
        self.assertEqual(len(self.db.tables['transaction_history']), 4)

    def test_concurrent_pays_cannot_overdraw(self):
        self.set_balance(SENDER, 50)
        self.db.delay = 0.01

        async def run_all():
            return await asyncio.gather(*(self.pay(user(RECEIVER), 30) for _ in range(3)))
        asyncio.run(run_all())
        self.assertEqual(self.balance(SENDER), 20)
        self.assertEqual(self.balance(RECEIVER), 40)  # 最初の 10 + 1 回分の 30


class GvcDeleteTest(unittest.TestCase):
    def setUp(self):
        self.bot = commands.Bot(command_prefix='!', intents=discord.Intents.none())
        self.cog = gvc.GlobalVCCog(self.bot)
        self.saved = (dict(gvc.ROOMS), dict(gvc.GLOBAL_ROOMS), dict(gvc.ROOM_TEXT_LINKS), dict(gvc.CHANNEL_TO_ROOM))
        gvc.ROOMS.clear()
        self.addCleanup(self.restore)
        self.create, self.delete = self.cog.gvc_create, self.cog.gvc_delete

    def restore(self):
        for target, saved in zip((gvc.ROOMS, gvc.GLOBAL_ROOMS, gvc.ROOM_TEXT_LINKS, gvc.CHANNEL_TO_ROOM), self.saved):
            target.clear()
            target.update(saved)

    def ctx(self, user_id, guild_id, manage_guild=False):
        ctx, recorder, objects = fake_context(self.bot, self.delete)
        ctx.author.id = user_id
        ctx.author.guild_permissions = discord.Permissions(manage_guild=manage_guild)
        ctx.guild.id = guild_id
        ctx.send = AsyncMock()
        return ctx

    def make_room(self):
        owner = self.ctx(1, 100)
        asyncio.run(self.create.callback(self.cog, owner, 'lobby', options=None))
        self.assertIn('lobby', gvc.ROOMS)
        self.assertEqual((gvc.ROOMS['lobby'].owner_id, gvc.ROOMS['lobby'].owner_guild_id), (1, 100))

    def test_admin_of_another_server_is_refused(self):
        self.make_room()
        other_admin = self.ctx(2, 200, manage_guild=True)
        asyncio.run(self.delete.callback(self.cog, other_admin, 'lobby'))
        self.assertIn('lobby', gvc.ROOMS)
        self.assertIn('作成者か', other_admin.send.await_args.args[0])

    def test_member_of_owner_server_without_permission_is_refused(self):
        self.make_room()
        member = self.ctx(3, 100)
        asyncio.run(self.delete.callback(self.cog, member, 'lobby'))
        self.assertIn('lobby', gvc.ROOMS)

    def test_owner_can_delete_even_from_another_server(self):
        self.make_room()
        owner = self.ctx(1, 200)
        asyncio.run(self.delete.callback(self.cog, owner, 'lobby'))
        self.assertNotIn('lobby', gvc.ROOMS)

    def test_admin_of_owner_server_can_delete(self):
        self.make_room()
        admin = self.ctx(4, 100, manage_guild=True)
        asyncio.run(self.delete.callback(self.cog, admin, 'lobby'))
        self.assertNotIn('lobby', gvc.ROOMS)


if __name__ == '__main__':
    unittest.main()
