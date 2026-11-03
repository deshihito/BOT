"""放置したプレイヤーの代打ち（core/autoplay.py）と、人狼・UNO への組み込みのテスト。d1 への通信はすべて差し替える。"""

import asyncio
import os
import tempfile
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

from core import autoplay, guild_settings
from core.storage import KVStore
from game_fakes import FakeBot, FakeChannel, FakeGuild, FakeMember, fast_time
from cogs import jinrou, uno

LEGAL = ["グー", "チョキ", "パー"]


def use_temp_settings(test):
    tmp = tempfile.TemporaryDirectory()
    test.addCleanup(tmp.cleanup)
    guild_settings.set_store(guild_settings.GuildSettings(
        KVStore("guild_settings", client=None, path=os.path.join(tmp.name, "kv.json"))))
    test.addCleanup(guild_settings.set_store, None)


class ChooseActionTest(unittest.IsolatedAsyncioTestCase):
    async def choose(self, **kw):
        return await autoplay.choose_action_detailed(None, {"x": 1}, LEGAL, "選んで", timeout=0.2, **kw)

    async def test_valid_answer_is_used(self):
        with patch.object(autoplay, "_ask_d1", AsyncMock(return_value={"answers": {"action": "チョキ"}})) as ask:
            r = await self.choose(fallback="グー")
        self.assertEqual((r.action, r.source), ("チョキ", autoplay.SOURCE_D1))
        payload = ask.call_args.args[0]
        self.assertIn("action", payload["questions"])
        self.assertIn("instructions", payload["questions"]["action"])
        self.assertIn("type", payload["questions"]["action"])
        self.assertIsInstance(payload["state"], str)

    async def test_answer_by_index_and_plain_string(self):
        with patch.object(autoplay, "_ask_d1", AsyncMock(return_value="2")):
            self.assertEqual(await autoplay.choose_action(None, {}, LEGAL, "", timeout=0.2), "パー")
        with patch.object(autoplay, "_ask_d1", AsyncMock(return_value={"action": "「グー」"})):
            self.assertEqual(await autoplay.choose_action(None, {}, LEGAL, "", timeout=0.2), "グー")

    async def test_invalid_answer_falls_back(self):
        with patch.object(autoplay, "_ask_d1", AsyncMock(return_value={"answers": {"action": "ロケット"}})):
            r = await self.choose(fallback="パー")
        self.assertEqual((r.action, r.source), ("パー", autoplay.SOURCE_FALLBACK))
        with patch.object(autoplay, "_ask_d1", AsyncMock(return_value={"answers": {"action": "99"}})):
            self.assertIn((await self.choose()).action, LEGAL)  # fallback なし → ランダムでも一覧のどれか

    async def test_timeout_falls_back(self):
        async def slow(payload, timeout):
            await asyncio.sleep(10)
        with patch.object(autoplay, "_ask_d1", slow):
            r = await autoplay.choose_action_detailed(None, {}, LEGAL, "", timeout=0.05, fallback="グー")
        self.assertEqual((r.action, r.source), ("グー", autoplay.SOURCE_FALLBACK))

    async def test_exception_falls_back(self):
        with patch.object(autoplay, "_ask_d1", AsyncMock(side_effect=OSError("connection refused"))):
            r = await self.choose(fallback=lambda legal: legal[-1])
        self.assertEqual(r.action, "パー")

    async def test_http_session_error_never_raises(self):
        broken = MagicMock(side_effect=RuntimeError("aiohttp broke"))
        with patch.object(autoplay.aiohttp, "ClientSession", broken):
            r = await self.choose(fallback="チョキ")
        self.assertEqual(r.action, "チョキ")

    async def test_endpoint_is_configurable(self):
        self.assertEqual(autoplay.d1_endpoint(), os.getenv("D1_ENDPOINT") or autoplay.DEFAULT_D1_ENDPOINT)
        with patch.dict(os.environ, {"D1_ENDPOINT": "http://pi:9000/v1/systemone"}):
            self.assertEqual(autoplay.d1_endpoint(), "http://pi:9000/v1/systemone")

    async def test_empty_and_single_choice_skip_d1(self):
        with patch.object(autoplay, "_ask_d1", AsyncMock()) as ask:
            self.assertIsNone(await autoplay.choose_action(None, {}, [], ""))
            self.assertEqual(await autoplay.choose_action(None, {}, ["A"], ""), "A")
        ask.assert_not_called()


class TakeIdleTurnTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        use_temp_settings(self)
        self.channel = FakeChannel(1, FakeGuild())

    async def test_posts_notice(self):
        with patch.object(autoplay, "_ask_d1", AsyncMock(return_value="パー")):
            r = await autoplay.take_idle_turn(self.channel, guild_id=5, player_name="ひと でし", state={},
                                              legal_actions=LEGAL, instructions="", describe=lambda a: f"{a}を出")
        self.assertEqual(r.notice, "ひと でしさんが放置したため、代わりにパーを出しました")
        self.assertIn(r.notice, self.channel.sent[-1].text())

    async def test_disabled_server_returns_none(self):
        self.assertTrue(guild_settings.autoplay_enabled(5))  # 既定はオン
        await guild_settings.get_store().update(5, guild_settings.AUTOPLAY_SECTION, enabled=False)
        self.assertFalse(guild_settings.autoplay_enabled(5))
        with patch.object(autoplay, "_ask_d1", AsyncMock()) as ask:
            r = await autoplay.take_idle_turn(self.channel, guild_id=5, player_name="x", state={},
                                              legal_actions=LEGAL, instructions="")
        self.assertIsNone(r)
        ask.assert_not_called()
        self.assertEqual(self.channel.sent, [])


class UnoAutoplayTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        use_temp_settings(self)
        self.guild = FakeGuild()
        self.channel = FakeChannel(200, self.guild)
        self.players = [FakeMember(i, self.guild) for i in (1, 2, 3)]
        self.cog = uno.Uno(FakeBot(self.channel))
        game = uno.UnoGame(self.channel.id, 1)
        game.players = [1, 2, 3]
        game.hands = {1: ['赤の1', '青の2'], 2: ['赤の3'], 3: ['青の1']}
        game.deck = ['黄の9'] * 30
        game.discard_pile = ['赤の5']
        game.current_color = '赤'
        game.is_started = True
        self.cog.games[self.channel.id] = game
        self.game = game

    async def test_d1_plays_a_card_on_timeout(self):
        await self.cog.send_game_panel(self.channel, self.game)
        with patch.object(autoplay, "_ask_d1", AsyncMock(return_value="赤の1")):
            await self.game.active_view.on_timeout()
        self.assertEqual(self.game.hands[1], ['青の2'])
        self.assertEqual(self.game.discard_pile[-1], '赤の1')
        self.assertEqual(self.game.players[self.game.current_player_idx], 2)
        self.assertTrue(any('放置したため、代わりに[赤の1] を出しました' in m.text() for m in self.channel.sent))

    async def test_d1_down_draws_like_before(self):
        await self.cog.send_game_panel(self.channel, self.game)
        with patch.object(autoplay, "_ask_d1", AsyncMock(side_effect=OSError("down"))):
            await self.game.active_view.on_timeout()
        self.assertEqual(len(self.game.hands[1]), 3)
        self.assertTrue(any('代わりに山札から1枚引いてパスしました' in m.text() for m in self.channel.sent))

    async def test_off_keeps_original_message(self):
        await guild_settings.get_store().update(self.guild.id, guild_settings.AUTOPLAY_SECTION, enabled=False)
        await self.cog.send_game_panel(self.channel, self.game)
        with patch.object(autoplay, "_ask_d1", AsyncMock()) as ask:
            await self.game.active_view.on_timeout()
        ask.assert_not_called()
        self.assertEqual(len(self.game.hands[1]), 3)
        self.assertTrue(any('時間切れのため、山札から1枚引いてパス' in m.text() for m in self.channel.sent))


class JinrouAutoplayTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        use_temp_settings(self)
        self.guild = FakeGuild()
        self.channel = FakeChannel(300, self.guild)
        self.players = [FakeMember(i, self.guild) for i in range(1, 5)]
        self.cog = jinrou.JinrouCog(FakeBot(self.channel))
        p = patch.object(jinrou, 'db_api', MagicMock())
        p.start()
        self.addCleanup(p.stop)
        game = self.cog.get_game(self.channel.id)
        game.is_running = True
        game.started = True
        game.game_channel = self.channel
        game.players = list(self.players)
        game.alive_players = list(self.players)
        game.roles = {1: '人狼', 2: '騎士', 3: '一般通過あごむに', 4: 'あごむに破道砲'}
        game.day_count = 3
        self.game = game

    async def test_night_fills_idle_wolf_and_knight(self):
        with patch.object(autoplay, "_ask_d1", AsyncMock(side_effect=asyncio.TimeoutError())):
            await self.cog._autoplay_night(self.game)
        self.assertIn(self.game.night_actions[1], {2, 3, 4})
        self.assertIn(self.game.night_actions[2], {1, 3, 4})
        self.assertNotIn(4, self.game.night_actions)  # 破道砲は代わりに撃たない
        self.assertTrue(any('放置したため、代わりに' in m.text() for m in self.channel.sent))

    async def test_vote_falls_back_to_skip_and_uses_d1_answer(self):
        self.game.voted_count = {1: "skip", 2: "skip"}
        answers = iter([self.players[0].display_name, "わからない"])
        with patch.object(autoplay, "_ask_d1", AsyncMock(side_effect=lambda *a: next(answers))):
            await self.cog._autoplay_votes(self.game)
        self.assertEqual(self.game.voted_count[3], "1")
        self.assertEqual(self.game.voted_count[4], "skip")

    async def test_off_leaves_night_and_vote_untouched(self):
        await guild_settings.get_store().update(self.guild.id, guild_settings.AUTOPLAY_SECTION, enabled=False)
        self.game.voted_count = {}
        with patch.object(autoplay, "_ask_d1", AsyncMock()) as ask:
            await self.cog._autoplay_night(self.game)
            await self.cog._autoplay_votes(self.game)
        ask.assert_not_called()
        self.assertEqual(self.game.night_actions, {})
        self.assertEqual(self.game.voted_count, {})


if __name__ == "__main__":
    unittest.main()
