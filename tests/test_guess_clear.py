"""数字当て（/game）の残高チェックと /clear の権限・件数制限のテスト。Discord・Supabase には接続しない。

偽の Discord と偽の Supabase は tests/test_all_commands.py のものを使う。
"""

import asyncio
import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from tests.test_all_commands import USER_ID, FakeDBAPI, fake_interaction  # noqa: E402  (環境変数もここで用意される)

import discord  # noqa: E402
from discord.ext import commands  # noqa: E402

import config  # noqa: E402
import core.game.guess.cog as guess_module
from cogs.support import MAX_CLEAR, ClearCog  # noqa: E402


def run(coro):
    return asyncio.run(coro)


def sent_text(entry):
    """送信内容（content と V2 パネルのテキスト）をまとめた文字列。"""
    parts = [entry.get('content') or '']
    view = entry.get('view')
    if view is not None:
        for item in view.walk_children():
            text = getattr(item, 'content', None)
            if text:
                parts.append(text)
    return "\n".join(parts)


def make_interaction(bot):
    interaction, recorder, objects = fake_interaction(bot)
    sent = []

    def capture(original):
        async def call(*args, **kwargs):
            sent.append({'content': kwargs.get('content', args[0] if args else None),
                         'embed': kwargs.get('embed'), 'view': kwargs.get('view'),
                         'ephemeral': kwargs.get('ephemeral', False)})
            return await original(*args, **kwargs)
        return call

    interaction.response.send_message = capture(interaction.response.send_message)
    interaction.followup.send = capture(interaction.followup.send)
    interaction._sent = sent
    return interaction, objects


class GuessTest(unittest.TestCase):
    def setUp(self):
        self.db = FakeDBAPI()
        self.patch = patch.object(config, 'db_api', self.db)
        self.patch.start()
        self.addCleanup(self.patch.stop)
        self.bot = commands.Bot(command_prefix='!', intents=discord.Intents.none())
        self.cog = guess_module.Guess(self.bot)

    def set_balance(self, balance):
        self.db.table('users').insert({'user_id': str(USER_ID), 'balance': balance}).execute()

    def balance(self):
        return self.db.table('users').select('balance').eq('user_id', str(USER_ID)).execute().data[0]['balance']

    def history(self):
        return self.db.tables.get('transaction_history', [])

    def play(self, bet, choice=1, answer=1):
        interaction, _ = make_interaction(self.bot)
        with patch.object(guess_module.random, 'randint', return_value=answer) as randint:
            run(self.cog.play(interaction, bet, choice))
        return interaction._sent, randint.called

    def test_zero_balance_cannot_bet_even_if_it_would_win(self):
        self.set_balance(0)
        sent, played = self.play(1_000_000, choice=1, answer=1)
        self.assertFalse(played, 'ゲームを始める前に断るはず')
        self.assertEqual(self.balance(), 0)
        self.assertTrue(sent[0]['ephemeral'])
        self.assertIn('賭けられません', sent[0]['content'])
        self.assertEqual(self.history(), [])

    def test_new_user_without_row_cannot_bet(self):
        sent, played = self.play(10)
        self.assertFalse(played)
        self.assertEqual(self.balance(), 0)

    def test_loss_deducts_one_and_a_half_times(self):
        self.set_balance(100)
        sent, played = self.play(10, choice=1, answer=2)
        self.assertTrue(played)
        self.assertEqual(self.balance(), 85)
        self.assertIn('-15', sent_text(sent[0]))
        self.assertEqual(self.history()[-1]['reason'], 'guess_loss')
        self.assertEqual(self.history()[-1]['amount'], 15)

    def test_win_adds_two_point_eight_times(self):
        self.set_balance(100)
        sent, played = self.play(10, choice=3, answer=3)
        self.assertTrue(played)
        self.assertEqual(self.balance(), 128)
        self.assertIn('+28', sent_text(sent[0]))
        self.assertEqual(self.history()[-1]['reason'], 'guess_win')

    def test_bet_above_balance_is_rejected(self):
        self.set_balance(50)
        sent, played = self.play(51)
        self.assertFalse(played)
        self.assertEqual(self.balance(), 50)
        self.assertIn('残高が足りません', sent[0]['content'])

    def test_bet_whose_loss_exceeds_balance_is_rejected(self):
        # 負けると 1.5 倍引かれるので、残高 100 で賭けられるのは 67 まで（67 なら 100 引き、68 なら 102 引き）。
        self.set_balance(100)
        sent, played = self.play(68)
        self.assertFalse(played)
        self.assertIn('67 ago までです', sent[0]['content'])
        sent, played = self.play(67, choice=1, answer=2)
        self.assertTrue(played)
        self.assertEqual(self.balance(), 0)

    def test_non_positive_bet_is_rejected(self):
        self.set_balance(100)
        for bet in (0, -5):
            with self.subTest(bet=bet):
                sent, played = self.play(bet)
                self.assertFalse(played)
                self.assertIn('1以上', sent[0]['content'])
        self.assertEqual(self.balance(), 100)

    def test_balance_never_goes_negative_when_it_drops_during_the_game(self):
        self.set_balance(100)
        original = self.cog._apply_delta

        async def spend_first(user_id, delta, won):
            # ゲーム中に別の処理で残高が 5 まで減った場合
            self.db.table('users').update({'balance': 5}).eq('user_id', user_id).execute()
            return await original(user_id, delta, won)

        self.cog._apply_delta = spend_first
        sent, played = self.play(60, choice=1, answer=2)
        self.assertEqual(self.balance(), 0)
        self.assertIn('-5', sent_text(sent[0]))

    def test_update_failure_is_reported_not_silent(self):
        self.set_balance(100)
        self.cog._apply_delta = AsyncMock(return_value=None)
        sent, played = self.play(10, choice=1, answer=2)
        self.assertIn('無効になりました', sent[0]['content'])
        self.assertTrue(sent[0]['ephemeral'])


class ClearTest(unittest.TestCase):
    def setUp(self):
        self.bot = commands.Bot(command_prefix='!', intents=discord.Intents.none())
        self.cog = ClearCog(self.bot)

    def invoke(self, amount, user_permissions, bot_permissions=None, purge=None):
        interaction, objects = make_interaction(self.bot)
        interaction.permissions = user_permissions
        if bot_permissions is not None:
            interaction.app_permissions = bot_permissions
        interaction.channel.purge = purge or AsyncMock(side_effect=lambda limit, check: [object()] * limit)
        run(self.cog.clear(interaction, amount))
        return interaction

    def test_command_is_hidden_from_members_without_manage_messages(self):
        # 再編後は独立コマンドではなく /support の入口が clear の必要権限を持つ。
        from core.support.entry import SupportCog
        self.assertEqual(
            SupportCog.SUPPORT_REQUIRED_PERMISSIONS['clear'], 'manage_messages')
        amount = self.cog.clear.__annotations__['amount']
        self.assertEqual((amount.min_value, amount.max_value), (1, MAX_CLEAR))

    def test_rejected_without_manage_messages(self):
        interaction = self.invoke(5, discord.Permissions(send_messages=True, read_message_history=True))
        interaction.channel.purge.assert_not_awaited()
        self.assertIn('メッセージの管理', interaction._sent[0]['content'])
        self.assertTrue(interaction._sent[0]['ephemeral'])

    def test_allowed_with_manage_messages(self):
        interaction = self.invoke(5, discord.Permissions(manage_messages=True))
        interaction.channel.purge.assert_awaited_once()
        self.assertEqual(interaction.channel.purge.await_args.kwargs['limit'], 5)
        self.assertIn('5 件削除しました', interaction._sent[-1]['content'])
        # 完了通知は公開が既定（ephemeral はエラー系だけ）。
        self.assertFalse(interaction._sent[-1]['ephemeral'])

    def test_amount_is_capped(self):
        for amount in (0, -1, MAX_CLEAR + 1, 10_000):
            with self.subTest(amount=amount):
                interaction = self.invoke(amount, discord.Permissions(manage_messages=True))
                interaction.channel.purge.assert_not_awaited()
                self.assertIn(f'1〜{MAX_CLEAR}', interaction._sent[0]['content'])
        interaction = self.invoke(MAX_CLEAR, discord.Permissions(manage_messages=True))
        self.assertEqual(interaction.channel.purge.await_args.kwargs['limit'], MAX_CLEAR)

    def test_bot_without_permission_gets_friendly_message(self):
        interaction = self.invoke(5, discord.Permissions(manage_messages=True),
                                  bot_permissions=discord.Permissions(send_messages=True))
        interaction.channel.purge.assert_not_awaited()
        self.assertIn('Bot に', interaction._sent[0]['content'])

    def test_forbidden_during_purge_gets_friendly_message(self):
        forbidden = discord.Forbidden(type('R', (), {'status': 403, 'reason': 'Forbidden'})(), 'Missing Permissions')
        interaction = self.invoke(5, discord.Permissions(manage_messages=True), purge=AsyncMock(side_effect=forbidden))
        self.assertIn('削除できませんでした', interaction._sent[-1]['content'])
        self.assertTrue(interaction._sent[-1]['ephemeral'])


if __name__ == '__main__':
    unittest.main()
