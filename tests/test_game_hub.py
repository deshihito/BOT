"""/game（cogs/game.py）のテスト。偽の Discord 部品（tests/game_fakes.py）で動かし、通信はしない。"""

import asyncio
import unittest

import discord

from game_fakes import (FakeBot, FakeChannel, FakeGuild, FakeInteraction, FakeMember, FakeMessage, choose, fast_time,
                        press, real_sleep)
from cogs import babanuki, daifugo, doubt, flash, game, guess, janken, jinrou, ngword, shiritori, shinkei, uno, wordle, wordwolf
from core.game.game import game_guides as guides
from core.game.game import party_ranking
from core.game.game.game_guides import GAME_GUIDES, GAME_ORDER


class HubBot(FakeBot):
    def __init__(self, *channels):
        super().__init__(*channels)
        self.loop = asyncio.get_event_loop()
        self.cogs = {}

    def add(self, cog):
        self.cogs[type(cog).__name__] = cog
        return cog

    def get_cog(self, name):
        return self.cogs.get(name)


def embed_size_ok(testcase, embed):
    testcase.assertLessEqual(len(embed), 6000)
    testcase.assertLessEqual(len(embed.description or ''), 4096)
    testcase.assertLessEqual(len(embed.fields), 25)
    for field in embed.fields:
        testcase.assertLessEqual(len(field.value), 1024)


class GameHubTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.guild = FakeGuild()
        self.channel = FakeChannel(400, self.guild)
        self.host = FakeMember(1, self.guild)
        self.bot = HubBot(self.channel)
        self.hub = self.bot.add(game.GameHub(self.bot))
        self.jinrou = self.bot.add(jinrou.JinrouCog(self.bot))
        self.wordwolf = self.bot.add(wordwolf.CustomWordWolf(self.bot))
        self.uno = self.bot.add(uno.Uno(self.bot))
        self.doubt = self.bot.add(doubt.Doubt(self.bot))
        self.ngword = self.bot.add(ngword.NGWord(self.bot))
        self.shiritori = self.bot.add(shiritori.OdaiShiritori(self.bot))
        self.janken = self.bot.add(janken.Janken(self.bot))
        self.wordle = self.bot.add(wordle.Wordle(self.bot))
        self.shinkei = self.bot.add(shinkei.Shinkei(self.bot))
        self.babanuki = self.bot.add(babanuki.Babanuki(self.bot))
        self.guess = self.bot.add(guess.Guess(self.bot))
        self.flash = self.bot.add(flash.FlashMentalArithmetic(self.bot))
        self.daifugo = self.bot.add(daifugo.Daifugo(self.bot))

    async def open_hub(self):
        inter = FakeInteraction(self.host, self.channel)
        await self.hub.game.callback(self.hub, inter)
        return inter.response.sent[0]

    async def open_detail(self, game_id):
        hub_message = await self.open_hub()
        select = next(c for c in hub_message.view.children if isinstance(c, discord.ui.Select))
        message = FakeMessage(self.channel, embed=hub_message.embed, view=hub_message.view)
        await choose(select, game_id, FakeInteraction(self.host, self.channel, message=message))
        return message

    def test_guides_schema(self):
        self.assertEqual(sorted(GAME_ORDER), sorted(GAME_GUIDES))
        self.assertEqual(sorted(game.GAME_COGS), sorted(GAME_GUIDES))
        for game_id, guide in GAME_GUIDES.items():
            with self.subTest(game=game_id):
                self.assertEqual(guide['id'], game_id)
                self.assertEqual(guide['category'], 'game')  # web/data/commands.json のカテゴリ id
                for key in ('name', 'summary', 'players', 'duration', 'guide', 'commands', 'min_players', 'max_players'):
                    self.assertIn(key, guide)
                self.assertTrue(guide['guide'].strip())
                for heading in ('## 概要', '## 人数', '## 所要時間', '## 遊び方', '## コマンド'):
                    self.assertIn(heading, guide['guide'])
                for command in guide['commands']:
                    self.assertIn(f'`{command}`', guide['guide'])
                self.assertLessEqual(len(guides.guide_for_discord(game_id)), 4096)

    async def test_hub_lists_all_games(self):
        message = await self.open_hub()
        self.assertEqual([f.name for f in message.embed.fields], [GAME_GUIDES[g]['name'] for g in GAME_ORDER])
        for g in GAME_ORDER:
            self.assertIn(GAME_GUIDES[g]['players'], message.text())
            self.assertIn(GAME_GUIDES[g]['duration'], message.text())
        embed_size_ok(self, message.embed)
        select = next(c for c in message.view.children if isinstance(c, discord.ui.Select))
        self.assertEqual([o.value for o in select.options], GAME_ORDER)

    async def test_detail_and_rules_for_every_game(self):
        for game_id in GAME_ORDER:
            with self.subTest(game=game_id):
                message = await self.open_detail(game_id)
                self.assertEqual(message.embed.title, GAME_GUIDES[game_id]['name'])
                self.assertIsInstance(message.view, game.GameDetailView)
                labels = [c.label for c in message.view.children if isinstance(c, discord.ui.Button)]
                self.assertEqual(labels, ['ルール', '募集する'] + (['ランキング'] if game_id in game.RANKED_GAMES or party_ranking.is_ranked(game_id) else []) + (['レート'] if game_id == 'jinrou' else []) + (['ゲームを終了'] if game_id in ('jinrou', 'uno') else []) + ['戻る'])

                inter = FakeInteraction(self.host, self.channel)
                await press(message.view, 'rules', inter)
                rules = inter.response.sent[0]
                self.assertIn('**遊び方**', rules.embed.description)
                self.assertNotIn('## ', rules.embed.description)
                embed_size_ok(self, rules.embed)

                back = FakeMessage(self.channel)
                await press(message.view, 'back', FakeInteraction(self.host, self.channel, message=back))
                self.assertIsInstance(back.view, game.GameHubView)

    async def test_global_mode_only_on_jinrou(self):
        for game_id in GAME_ORDER:
            message = await self.open_detail(game_id)
            selects = [c for c in message.view.children if isinstance(c, game.JinrouModeSelect)]
            self.assertEqual(bool(selects), game_id == 'jinrou', game_id)

    async def test_recruit_jinrou_global_from_hub(self):
        message = await self.open_detail('jinrou')
        mode = next(c for c in message.view.children if isinstance(c, game.JinrouModeSelect))
        await choose(mode, 'global', FakeInteraction(self.host, self.channel, message=message))
        self.assertEqual(message.view.jinrou_mode, 'global')
        inter = FakeInteraction(self.host, self.channel)
        await press(message.view, 'recruit', inter)
        self.assertIn('global', self.jinrou.games)
        self.assertTrue(self.jinrou.games['global'].is_global)

    async def test_end_and_rating_buttons_only_where_needed(self):
        for game_id in GAME_ORDER:
            message = await self.open_detail(game_id)
            ids = {getattr(c, 'callback', None) and c.label for c in message.view.children if isinstance(c, discord.ui.Button)}
            self.assertEqual('ゲームを終了' in ids, game_id in ('jinrou', 'uno'), game_id)
            self.assertEqual('レート' in ids, game_id == 'jinrou', game_id)

    async def test_jinrou_end_button_stops_game(self):
        message = await self.open_detail('jinrou')
        await press(message.view, 'recruit', FakeInteraction(self.host, self.channel))
        g = self.jinrou.games[self.channel.id]
        self.assertTrue(g.is_running)
        inter = FakeInteraction(self.host, self.channel)
        await press(message.view, 'end_game', inter)
        self.assertFalse(g.is_running)

    async def start_jinrou_for_end(self):
        message = await self.open_detail('jinrou')
        await press(message.view, 'recruit', FakeInteraction(self.host, self.channel))
        g = self.jinrou.games[self.channel.id]
        return message, g

    def plain_member(self, user_id):
        member = FakeMember(user_id, self.guild)
        member.guild_permissions = discord.Permissions.none()
        return member

    async def test_jinrou_end_by_participant_and_admin(self):
        for kind in ('participant', 'admin'):
            with self.subTest(kind=kind):
                message, g = await self.start_jinrou_for_end()
                user = self.plain_member(50)
                if kind == 'participant':
                    g.players.append(user)
                else:
                    user.guild_permissions = discord.Permissions(manage_guild=True)
                await press(message.view, 'end_game', FakeInteraction(user, self.channel))
                self.assertFalse(g.is_running)
                g.is_running = False
                self.jinrou.games.pop(self.channel.id, None)

    async def test_jinrou_end_refused_for_outsider(self):
        message, g = await self.start_jinrou_for_end()
        inter = FakeInteraction(self.plain_member(77), self.channel)
        await press(message.view, 'end_game', inter)
        self.assertTrue(g.is_running)
        self.assertIn('参加者・ホスト・管理者だけ', inter.response.sent[0].embed.description)

    async def test_uno_end_button_needs_member(self):
        message = await self.open_detail('uno')
        await press(message.view, 'end_game', FakeInteraction(self.host, self.channel))  # ゲームなし
        self.assertNotIn(self.channel.id, self.uno.games)

    async def test_guess_and_flash_open_forms(self):
        for game_id, modal_cls in (('guess', guess.GuessModal), ('flash', flash.FlashModal)):
            with self.subTest(game=game_id):
                message = await self.open_detail(game_id)
                inter = FakeInteraction(self.host, self.channel)
                await press(message.view, 'recruit', inter)
                self.assertIsInstance(inter.response.modal, modal_cls)

    async def test_recruit_jinrou_opens_local_setup(self):
        message = await self.open_detail('jinrou')
        inter = FakeInteraction(self.host, self.channel)
        await press(message.view, 'recruit', inter)
        sent = inter.response.sent[0]
        self.assertIsInstance(sent.view, jinrou.SetupView)
        g = self.jinrou.games[self.channel.id]
        self.assertTrue(g.is_running)
        self.assertFalse(g.is_global)
        self.assertEqual(g.host_id, self.host.id)
        self.assertNotIn('global', self.jinrou.games)

    async def test_recruit_uno(self):
        message = await self.open_detail('uno')
        with fast_time():
            inter = FakeInteraction(self.host, self.channel)
            task = asyncio.create_task(press(message.view, 'recruit', inter))
            await real_sleep(0.01)
            self.assertIn(self.channel.id, self.uno.games)
            self.assertIsInstance(self.channel.sent[-1].view, uno.JoinView)
            self.assertIn('募集を開始', inter.texts()[0])
            await task
        self.assertNotIn(self.channel.id, self.uno.games)  # 1 人だけなので募集終了

    async def test_recruit_doubt_and_refuse_duplicate(self):
        message = await self.open_detail('doubt')
        with fast_time():
            inter = FakeInteraction(self.host, self.channel)
            task = asyncio.create_task(press(message.view, 'recruit', inter))
            await real_sleep(0.01)
            self.assertIn('募集を開始', inter.texts()[0])
            self.assertIsInstance(self.channel.sent[-1].view, doubt.DoubtJoinView)
            again = FakeInteraction(self.host, self.channel)
            await press(message.view, 'recruit', again)
            self.assertIn('既にダウトが進行中', again.texts()[0])
            await task
        self.assertIn('人数不足', self.channel.texts()[-1])
        self.assertEqual(self.doubt.recruiting, set())

    async def test_recruit_wordwolf_with_selected_list(self):
        message = await self.open_detail('wordwolf')
        view = message.view
        wordlist = next(c for c in view.children if isinstance(c, game.WordlistSelect))
        await choose(wordlist, 'genshin', FakeInteraction(self.host, self.channel, message=message))
        self.assertEqual(view.wordlist, 'genshin')
        with fast_time():
            inter = FakeInteraction(self.host, self.channel)
            await press(view, 'recruit', inter)
        self.assertIn('原神', inter.texts()[0])
        self.assertIn('人数不足', self.channel.texts()[-1])

    def test_guide_for_discord_truncates_at_section(self):
        text = guides.guide_for_discord('jinrou', limit=600)
        self.assertLessEqual(len(text), 600)
        self.assertTrue(text.startswith('**概要**'))
        self.assertIn('続き', text)
        full = guides.guide_for_discord('jinrou')
        self.assertNotIn('**人数**', full)  # 人数・所要時間・コマンドは埋め込みの欄に出す
        self.assertIn('**役職**', full)

    async def test_missing_cog_is_reported(self):
        del self.bot.cogs['Uno']
        message = await self.open_detail('uno')
        inter = FakeInteraction(self.host, self.channel)
        await press(message.view, 'recruit', inter)
        self.assertIn('現在利用できません', inter.texts()[0])


if __name__ == '__main__':
    unittest.main()
