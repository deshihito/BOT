"""NGワードの制限時間・一文字モード（core/support/ngword/cog.py と /game の設定）のテスト。通信はしない。"""

import asyncio
import random
import types
import unittest

from game_fakes import FakeChannel, FakeGuild, FakeInteraction, FakeMember, FakeMessage, choose, fast_time, press, real_sleep
import core.game.game.cog as game
from core.support.ngword import cog as ngword


def msg(author, channel, content):
    return types.SimpleNamespace(author=author, channel=channel, content=content)


class CharLogicTest(unittest.TestCase):
    def test_normalize_kana(self):
        self.assertEqual(ngword.normalize_kana('アッキャ'), 'あつきや')
        self.assertEqual(ngword.normalize_kana('がっこう'), 'がつこう')

    def test_contains_ng_char(self):
        self.assertTrue(ngword.contains_ng_char('アイス', 'あ'))
        self.assertTrue(ngword.contains_ng_char('ちょっと', 'よ'))   # 小さい「ょ」も数える
        self.assertTrue(ngword.contains_ng_char('ちょっと', 'つ'))   # 小さい「っ」も数える
        self.assertFalse(ngword.contains_ng_char('がんばる', 'か'))  # 濁点つきは別
        self.assertFalse(ngword.contains_ng_char('雨', 'あ'))        # 漢字は読まない
        self.assertFalse(ngword.contains_ng_char(None, 'あ'))

    def test_char_pool(self):
        pool = ngword.NG_CHARS
        self.assertEqual(len(pool), len(set(pool)))
        self.assertGreaterEqual(len(pool), ngword.MAX_PLAYERS)
        for c in 'のはにてたいかしるとをぬへゐゑん':
            self.assertNotIn(c, pool)
        for c in pool:
            self.assertEqual(len(c), 1)
            self.assertTrue('あ' <= c <= 'ゖ')

    def test_game_options(self):
        g = ngword.NGGame(1, 1, 1, minutes=10, mode='char')
        self.assertEqual((g.seconds, g.mode), (600, 'char'))
        bad = ngword.NGGame(1, 1, 1, minutes=7, mode='x')
        self.assertEqual((bad.minutes, bad.mode), (3, 'word'))
        for uid in (1, 2, 3):
            g.players[uid] = uid
        g.deal(random.Random(0))
        self.assertTrue(all(w in ngword.NG_CHARS for w in g.words.values()))
        self.assertEqual(game.NG_TIME_CHOICES, ngword.TIME_CHOICES)
        self.assertEqual({v for v, _ in game.NG_MODES}, set(ngword.MODES))


class CharModeFlowTest(unittest.IsolatedAsyncioTestCase):
    async def test_char_mode_elimination_and_time(self):
        guild = FakeGuild()
        channel = FakeChannel(510, guild)
        members = [FakeMember(i, guild) for i in (1, 2, 3)]
        cog = ngword.NGWord(types.SimpleNamespace())
        with fast_time(scale=0.0002):
            task = asyncio.create_task(cog.start_recruit(FakeInteraction(members[0], channel), minutes=5, mode='char'))
            await real_sleep(0.01)
            self.assertIn('一文字モード・5分', channel.sent[-1].text())
            for m in members[1:]:
                await press(channel.sent[-1].view, 'join', FakeInteraction(m, channel))
            while channel.id not in cog.games or cog.games[channel.id].phase != 'playing':
                await real_sleep(0.002)
            g = cog.games[channel.id]
            self.assertIn('制限時間は5分', ' '.join(channel.texts()))
            g.words = {1: 'あ', 2: 'つ', 3: 'よ'}
            self.assertFalse(await cog.handle_message(msg(members[0], channel, 'いいね')))
            self.assertTrue(await cog.handle_message(msg(members[0], channel, 'アイス食べたい')))
            self.assertTrue(await cog.handle_message(msg(members[1], channel, 'ちょっと')))
            await task
        self.assertIn('<@3>', channel.sent[-1].text())


class HubOptionsTest(unittest.IsolatedAsyncioTestCase):
    async def test_hub_passes_time_and_mode(self):
        guild = FakeGuild()
        channel = FakeChannel(520, guild)
        host = FakeMember(1, guild)
        seen = {}

        class FakeNG:
            async def start_recruit(self, interaction, minutes=3, mode='word'):
                seen.update(minutes=minutes, mode=mode)
                await interaction.response.send_message('ok')

        hub = game.GameHub(types.SimpleNamespace(get_cog=lambda name: FakeNG() if name == 'NGWord' else None))
        view = game.GameDetailView(hub, 'ngword')
        message = FakeMessage(channel, view=view)
        time_select = next(c for c in view.children if isinstance(c, game.NGTimeSelect))
        mode_select = next(c for c in view.children if isinstance(c, game.NGModeSelect))
        await press(view, 'recruit', FakeInteraction(host, channel))
        self.assertEqual(seen, {'minutes': 3, 'mode': 'word'})  # 既定は3分・ワード
        await choose(time_select, '10', FakeInteraction(host, channel, message=message))
        await choose(mode_select, 'char', FakeInteraction(host, channel, message=message))
        await press(view, 'recruit', FakeInteraction(host, channel))
        self.assertEqual(seen, {'minutes': 10, 'mode': 'char'})

    def test_other_games_have_no_ng_selects(self):
        view = game.GameDetailView(types.SimpleNamespace(), 'uno')
        self.assertFalse(any(isinstance(c, (game.NGTimeSelect, game.NGModeSelect)) for c in view.children))


if __name__ == '__main__':
    unittest.main()
