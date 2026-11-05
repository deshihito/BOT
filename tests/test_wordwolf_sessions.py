"""ワードウルフがチャンネルごとに独立して同時進行できることのテスト。

以前は Cog の単一フィールドで状態を持っていたため、Bot 全体で同時に
1 ゲームしか開けなかった。セッション化（channel_id -> WordWolfSession）で
2 チャンネルが干渉せずに進むことを確かめる。
"""

import asyncio
import sys
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
if str(Path(__file__).resolve().parent) not in sys.path:
    sys.path.insert(0, str(Path(__file__).resolve().parent))

from game_fakes import FakeChannel, FakeGuild, FakeInteraction, FakeMember, fast_time, press, real_sleep  # noqa: E402

from cogs import wordwolf  # noqa: E402
from core import party_ranking  # noqa: E402


class WordWolfSessionsTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.saved = party_ranking._shared
        party_ranking._shared = party_ranking.PartyRanking(client=None)
        self.guild = FakeGuild(7)
        self.channel_a = FakeChannel(301, self.guild)
        self.channel_b = FakeChannel(302, self.guild)
        self.members_a = [FakeMember(i, self.guild) for i in (11, 12, 13)]
        self.members_b = [FakeMember(i, self.guild) for i in (21, 22, 23)]
        self.cog = wordwolf.CustomWordWolf(types.SimpleNamespace())

    async def asyncTearDown(self):
        party_ranking._shared = self.saved

    async def _start(self, channel, members):
        inter = FakeInteraction(members[0], channel)
        task = asyncio.create_task(self.cog.start_recruit(inter))
        await real_sleep(0.02)
        view = inter.response.sent[0].view
        for member in members:
            await press(view, "join", FakeInteraction(member, channel))
        await task
        return self.cog.sessions[channel.id]

    async def test_two_channels_run_concurrently(self):
        with fast_time():
            session_a, session_b = await asyncio.gather(
                self._start(self.channel_a, self.members_a),
                self._start(self.channel_b, self.members_b),
            )
            # 両チャンネルとも本編が始まり、状態は別々
            self.assertTrue(session_a.game_running)
            self.assertTrue(session_b.game_running)
            self.assertIsNot(session_a, session_b)
            self.assertEqual([p.id for p in session_a.players], [11, 12, 13])
            self.assertEqual([p.id for p in session_b.players], [21, 22, 23])
            self.assertEqual(len(session_a.player_words), 3)
            self.assertEqual(len(session_b.player_words), 3)

            # 進行中チャンネルでの二重開始は断る（他チャンネルには影響しない）
            dup = FakeInteraction(self.members_b[0], self.channel_b)
            await self.cog.start_recruit(dup)
            self.assertIn("既にゲームが進行中です", dup.texts()[0])
            self.assertTrue(session_a.game_running)

            # A で村人がウルフを指名して勝利 → A だけが終わり、B は続く
            wolf_a = session_a.wolf
            challenger = next(p for p in session_a.alive_players if p != wolf_a)
            await session_a.execute_challenge(challenger, wolf_a)
            self.assertNotIn(self.channel_a.id, self.cog.sessions)
            self.assertIn(self.channel_b.id, self.cog.sessions)
            self.assertTrue(session_b.game_running)
            self.assertEqual(
                await party_ranking.shared().top(7, "wordwolf"),
                [(p.id, 1) for p in self.members_a if p != wolf_a],
            )

            await self.cog.end_game(self.channel_b, "wolf_win")
            self.assertEqual(self.cog.sessions, {})
            await real_sleep(0.2)  # タイマーの後片付け

    async def test_recruit_shortage_cleans_up_only_that_channel(self):
        with fast_time():
            inter = FakeInteraction(self.members_a[0], self.channel_a)
            await self.cog.start_recruit(inter)  # 誰も参加しない → 人数不足で中止
            self.assertIn("人数不足", self.channel_a.texts()[-1])
            self.assertEqual(self.cog.sessions, {})


if __name__ == "__main__":
    unittest.main()
