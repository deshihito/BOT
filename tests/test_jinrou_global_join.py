"""グローバル人狼の合流パネル（GlobalJoinView）のテスト。Discord には接続しない。"""

import asyncio
import sys
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import core.game.jinrou.entry as J


class Chan:
    def __init__(self, cid):
        self.id, self.sent = cid, []

    async def send(self, *a, **k):
        self.sent.append(a[0] if a else k)


def interaction(uid, chan):
    replies = []

    async def send_message(*a, **k):
        replies.append(a[0] if a else k.get("content"))
    return types.SimpleNamespace(user=types.SimpleNamespace(id=uid, display_name=f"u{uid}"), channel=chan,
                                 response=types.SimpleNamespace(send_message=send_message)), replies


class GlobalJoinTest(unittest.TestCase):
    def setUp(self):
        self.origin, self.other = Chan(1), Chan(2)
        self.game = J.JinrouGame()
        self.game.is_global, self.game.is_running = True, True
        self.game.channels = [self.origin, self.other]
        self.cog = types.SimpleNamespace(games={"global": self.game})

    def press(self, uid, chan):
        it, replies = interaction(uid, chan)

        async def go():
            view = J.GlobalJoinView(self.cog, self.game)
            await view.join.callback(it)
        asyncio.run(go())
        return replies

    def test_join_during_recruit(self):
        replies = self.press(10, self.other)
        self.assertEqual([p.id for p in self.game.players], [10])
        self.assertIn("参加しました", replies[0])
        self.assertTrue(self.origin.sent)  # 元のサーバーにも知らせる

    def test_no_double_join(self):
        self.press(10, self.other)
        self.assertIn("既に", self.press(10, self.other)[0])
        self.assertEqual(len(self.game.players), 1)

    def test_refuse_after_start(self):
        self.game.started = True
        self.assertIn("進行中", self.press(10, self.other)[0])
        self.assertEqual(self.game.players, [])

    def test_refuse_when_recruit_over(self):
        self.game.is_running = False
        self.assertIn("終わりました", self.press(10, self.other)[0])


class GlobalRelayLookupTest(unittest.TestCase):
    def test_origin_channel_with_stale_local_game_finds_global(self):
        cog = J.JinrouCog.__new__(J.JinrouCog)
        origin = Chan(1)
        stale = J.JinrouGame()  # 止まっているローカル用のゲーム
        g = J.JinrouGame()
        g.is_global, g.is_running, g.channels = True, True, [origin, Chan(2)]
        cog.games = {1: stale, "global": g}
        g.is_dead_player = lambda uid: True  # 見つかったら削除まで進むので、それで判定する
        deleted = []

        async def delete():
            deleted.append(1)
        msg = types.SimpleNamespace(author=types.SimpleNamespace(bot=False, id=5), channel=origin, delete=delete)
        asyncio.run(J.JinrouCog.on_message(cog, msg))
        self.assertEqual(deleted, [1])


class GlobalNightSilenceTest(unittest.TestCase):
    def run_msg(self, in_discussion):
        cog = J.JinrouCog.__new__(J.JinrouCog)
        cog.games = {}
        g = J.JinrouGame()
        user = types.SimpleNamespace(bot=False, id=5)
        g.is_global, g.is_running, g.started, g.channels = True, True, True, [Chan(1), Chan(2)]
        g.players, g.alive_players, g.in_discussion = [user], [user], in_discussion
        if not in_discussion:
            g.silenced_players = {5}  # 夜は生きている参加者が全員ここに入る（ローカルと同じ仕組み）
        cog.games[2] = J.JinrouGame()  # 合流側にも止まっているローカル用のゲームが残っている
        g.last_speak_time = {}
        cog.games["global"] = g
        deleted = []

        async def delete():
            deleted.append(1)
        msg = types.SimpleNamespace(author=user, channel=g.channels[1], delete=delete, content="やあ",
                                    guild=types.SimpleNamespace(name="s"))
        cog.webhook_cache = {}
        asyncio.run(J.JinrouCog.on_message(cog, msg))
        return deleted

    def test_night_message_deleted(self):
        self.assertEqual(self.run_msg(False), [1])

    def test_discussion_message_kept(self):
        self.assertEqual(self.run_msg(True), [])


if __name__ == "__main__":
    unittest.main()
