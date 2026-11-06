"""対局中ゲームセッションの再起動復旧テスト（core/game/game_restore.py と各ゲーム cog）。

Discord には接続しない。検証すること:

- 各対象ゲーム: 状態の保存 → （新しい cog = 再起動を模す）復旧で対局が一致し、
  そのまま続行・終了まで進んで後片付けされる
- チャンネルが消えたスナップショットは復旧されず掃除される
- ストアの JSON が壊れていても、またエントリの中身が壊れていても、
  復旧処理が例外なく終わり対象エントリが掃除される
"""

import tempfile
import time
import unittest
from pathlib import Path

from game_fakes import (FakeBot, FakeChannel, FakeGuild, FakeInteraction,
                        FakeMember, FakeMessage, choose, fast_time, real_sleep)

from core.game import game_restore
from core.game.shogi_engine import Color as ShogiColor
from cogs import babanuki as babanuki_mod
from cogs import chess as chess_mod
from cogs import daifugo as daifugo_mod
from cogs import othello as othello_mod
from cogs import shinkei as shinkei_mod
from cogs import shiritori as shiritori_mod
from cogs import shogi as shogi_mod
from cogs import uno as uno_mod
from cogs import wordle as wordle_mod


class FetchChannel(FakeChannel):
    """fetch_message で過去メッセージを引ける FakeChannel。"""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.messages = {}

    def add_message(self, message_id):
        message = FakeMessage(self)
        message.id = message_id
        self.messages[message_id] = message
        return message

    async def fetch_message(self, message_id):
        message = self.messages.get(message_id)
        if message is None:
            raise Exception("message not found")
        return message


def make_world(channel_id, guild_id=777, user_ids=(101, 102, 103)):
    guild = FakeGuild(guild_id)
    channel = FetchChannel(channel_id, guild)
    members = {uid: FakeMember(uid, guild) for uid in user_ids}
    bot = FakeBot(channel)
    return bot, guild, channel, members


class StoreTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store_path = Path(self.tmp.name) / "game_restore.json"
        game_restore.reset_store(self.store_path)

    def tearDown(self):
        game_restore.reset_store(Path(self.tmp.name) / "unused.json")
        self.tmp.cleanup()


class StoreBasicsTest(StoreTestCase):
    def test_save_flush_reload_and_clear(self):
        game_restore.save_session("shogi", 555, 777, {"turn": "SENTE"})
        game_restore.flush_store()
        self.assertTrue(self.store_path.exists())
        game_restore.reset_store(self.store_path)   # 再読み込み（再起動を模す）
        entries = game_restore.session_entries("shogi")
        self.assertEqual(entries[555]["state"], {"turn": "SENTE"})
        game_restore.clear_session("shogi", 555)
        self.assertEqual(game_restore.session_entries("shogi"), {})

    def test_broken_json_does_not_break_store(self):
        self.store_path.write_text("{これは壊れたJSON", encoding="utf-8")
        store = game_restore.reset_store(self.store_path)
        self.assertEqual(store.section("shogi"), {})   # 例外なく空で始まる


class ShogiRestoreTest(StoreTestCase, unittest.IsolatedAsyncioTestCase):
    async def test_restore_resumes_same_position_and_finishes(self):
        bot, guild, channel, members = make_world(6101)
        cog = shogi_mod.Shogi(bot)
        s = shogi_mod.ShogiSession(6101, 777, 101, "human", 5)
        s.players = {ShogiColor.SENTE: members[101], ShogiColor.GOTE: members[102]}
        s.phase = "playing"
        src = s.game.get_legal_selectable_pieces()[0]
        dst = s.game.legal_destinations(*src)[0]
        self.assertTrue(s.game.make_move(src, dst))
        cog._save_snapshot(s)
        saved = game_restore.session_entries("shogi")
        self.assertIn(6101, saved)

        # 再起動: 新しい bot / cog で復旧する
        bot2, guild2, channel2, members2 = make_world(6101)
        cog2 = shogi_mod.Shogi(bot2)
        with fast_time():
            await cog2.restore_after_restart()
            restored = cog2.sessions.get(6101)
            self.assertIsNotNone(restored)
            self.assertEqual(shogi_mod.serialize_shogi_game(restored.game),
                             shogi_mod.serialize_shogi_game(s.game))
            self.assertEqual(restored.game.turn, ShogiColor.GOTE)
            self.assertEqual(restored.players[ShogiColor.SENTE].id, 101)
            # 両者放置 → 時間切れパスが続いて対局が終わり、後片付けされる
            # （盤面レンダリングが1回2秒弱かかるため長めに待つ）
            await real_sleep(6.0)
        self.assertNotIn(6101, cog2.sessions)
        self.assertEqual(game_restore.session_entries("shogi"), {})

    async def test_missing_channel_entry_is_cleaned(self):
        bot, guild, channel, members = make_world(6102)
        cog = shogi_mod.Shogi(bot)
        s = shogi_mod.ShogiSession(6102, 777, 101, "human", 5)
        s.players = {ShogiColor.SENTE: members[101], ShogiColor.GOTE: members[102]}
        s.phase = "playing"
        cog._save_snapshot(s)
        empty_bot = FakeBot()   # チャンネルが無い世界
        cog2 = shogi_mod.Shogi(empty_bot)
        await cog2.restore_after_restart()
        self.assertEqual(cog2.sessions, {})
        self.assertEqual(game_restore.session_entries("shogi"), {})

    async def test_broken_entry_is_cleaned_without_raising(self):
        store = game_restore.get_store()
        store.set_entry("shogi", 6103, {"game": "shogi", "channel_id": 6103,
                                        "guild_id": 777, "saved_at": 0,
                                        "state": {"mode": "human"}})   # game 本体が無い
        bot, *_ = make_world(6103)
        cog = shogi_mod.Shogi(bot)
        await cog.restore_after_restart()   # 例外なく終わる
        self.assertEqual(cog.sessions, {})
        self.assertEqual(game_restore.session_entries("shogi"), {})


class ChessRestoreTest(StoreTestCase, unittest.IsolatedAsyncioTestCase):
    async def test_restore_resumes_same_position_and_finishes(self):
        bot, guild, channel, members = make_world(6201)
        cog = chess_mod.Chess(bot)
        g = chess_mod.ChessGame(6201, 777, 101, "human", 5)
        g.players = {"white": members[101], "black": members[102]}
        g.phase = "playing"
        g.push_move(((6, 4), (4, 4)))
        cog._save_snapshot(g)

        bot2, guild2, channel2, members2 = make_world(6201)
        cog2 = chess_mod.Chess(bot2)
        with fast_time():
            await cog2.restore_after_restart()
            restored = cog2.games.get(6201)
            self.assertIsNotNone(restored)
            self.assertEqual(restored.board, g.board)
            self.assertEqual(restored.turn, "black")
            self.assertEqual(restored.castling, g.castling)
            self.assertEqual(restored.players["white"].id, 101)
            await real_sleep(1.5)   # 黒が放置 → 時間切れで終局し後片付けされる
        self.assertNotIn(6201, cog2.games)
        self.assertEqual(game_restore.session_entries("chess"), {})


class OthelloRestoreTest(StoreTestCase, unittest.IsolatedAsyncioTestCase):
    async def test_restore_resumes_same_position_and_finishes(self):
        bot, guild, channel, members = make_world(6301)
        cog = othello_mod.Othello(bot)
        g = othello_mod.OthelloGame(6301, 777, 101, "human", 5)
        g.players = {othello_mod.BLACK: members[101], othello_mod.WHITE: members[102]}
        g.phase = "playing"
        self.assertTrue(othello_mod.play_move(g.board, othello_mod.BLACK, 2, 3))
        g.turn = othello_mod.WHITE
        cog._save_snapshot(g)

        bot2, guild2, channel2, members2 = make_world(6301)
        cog2 = othello_mod.Othello(bot2)
        with fast_time():
            await cog2.restore_after_restart()
            restored = cog2.games.get(6301)
            self.assertIsNotNone(restored)
            self.assertEqual(restored.board, g.board)
            self.assertEqual(restored.turn, othello_mod.WHITE)
            self.assertEqual(restored.score(), g.score())
            await real_sleep(1.5)   # 両者放置 → パスが続いて終局し後片付けされる
        self.assertNotIn(6301, cog2.games)
        self.assertEqual(game_restore.session_entries("othello"), {})


class DaifugoRestoreTest(StoreTestCase, unittest.IsolatedAsyncioTestCase):
    async def test_restore_resumes_same_hands(self):
        bot, guild, channel, members = make_world(6401)
        cog = daifugo_mod.Daifugo(bot)
        g = daifugo_mod.DaifugoGame(6401, 777, 101)
        g.players = {101: members[101], 102: members[102], -1: None}
        g.hands = {101: ["S3", "H5"], 102: ["D7"], -1: ["C9", "S10"]}
        g.turn = 101
        g.phase = "playing"
        cog._save_snapshot(g)

        bot2, guild2, channel2, members2 = make_world(6401)
        cog2 = daifugo_mod.Daifugo(bot2)
        with fast_time():
            await cog2.restore_after_restart()
            restored = cog2.games.get(6401)
            self.assertIsNotNone(restored)
            self.assertEqual(list(restored.players), [101, 102, -1])
            self.assertIsNone(restored.players[-1])   # Bot 枠は None のまま
            self.assertEqual(restored.hands, g.hands)
            self.assertEqual(restored.turn, 101)
            self.assertIsNone(restored.table)
            await real_sleep(0.3)
            restored.phase = "done"   # ループを終わらせて後片付けを確認する
            await real_sleep(0.5)
        self.assertNotIn(6401, cog2.games)
        self.assertEqual(game_restore.session_entries("daifugo"), {})


class BabanukiRestoreTest(StoreTestCase, unittest.IsolatedAsyncioTestCase):
    async def test_restore_resumes_same_hands(self):
        bot, guild, channel, members = make_world(6501)
        cog = babanuki_mod.Babanuki(bot)
        g = babanuki_mod.BabanukiGame(6501, 777, 101)
        g.players = {101: members[101], 102: members[102]}
        g.hands = {101: ["S5", "JOKER"], 102: ["H9"]}
        g.turn_index = 1
        g.phase = "playing"
        cog._save_snapshot(g)

        bot2, guild2, channel2, members2 = make_world(6501)
        cog2 = babanuki_mod.Babanuki(bot2)
        with fast_time():
            await cog2.restore_after_restart()
            restored = cog2.games.get(6501)
            self.assertIsNotNone(restored)
            self.assertEqual(restored.hands, g.hands)
            self.assertEqual(restored.turn_index, 1)
            self.assertEqual(restored.current, 102)
            await real_sleep(0.3)
            restored.phase = "done"
            await real_sleep(0.8)
        self.assertNotIn(6501, cog2.games)
        self.assertEqual(game_restore.session_entries("babanuki"), {})


class ShinkeiRestoreTest(StoreTestCase, unittest.IsolatedAsyncioTestCase):
    async def test_restore_resumes_same_board_and_reattaches_view(self):
        bot, guild, channel, members = make_world(6601)
        cog = shinkei_mod.Shinkei(bot)
        cards = shinkei_mod.deal()
        g = shinkei_mod.ShinkeiGame(6601, 777, 101, cards=cards)
        g.players = {101: members[101], 102: members[102]}
        g.phase = "playing"
        # ペアを1組そろえた状態にする
        first = cards[0]
        pair_idx = cards.index(first, 1)
        g.matched = {0: 101, pair_idx: 101}
        g.scores = {101: 1}
        board_msg = await channel.send("board")
        g.message = board_msg
        cog._save_snapshot(g)

        bot2, guild2, channel2, members2 = make_world(6601)
        fetched = channel2.add_message(board_msg.id)
        cog2 = shinkei_mod.Shinkei(bot2)
        with fast_time():
            await cog2.restore_after_restart()
            restored = cog2.games.get(6601)
            self.assertIsNotNone(restored)
            self.assertEqual(restored.cards, cards)
            self.assertEqual(restored.matched, g.matched)
            self.assertEqual(restored.scores, {101: 1})
            # 既存の盤面メッセージへ新しい BoardView が付け直されている
            self.assertIs(restored.message, fetched)
            self.assertTrue(any(isinstance(kw.get("view"), shinkei_mod.BoardView)
                                for kw in [e for e in fetched.edits]))
            # 全部そろえたことにして終局させる
            restored.matched = {i: 101 for i in range(len(cards))}
            await real_sleep(1.0)
        self.assertNotIn(6601, cog2.games)
        self.assertEqual(game_restore.session_entries("shinkei"), {})


class ShiritoriRestoreTest(StoreTestCase, unittest.IsolatedAsyncioTestCase):
    async def test_restore_resumes_same_chain(self):
        bot, guild, channel, members = make_world(6701)
        cog = shiritori_mod.OdaiShiritori(bot)
        g = shiritori_mod.ShiritoriGame(6701, 777, 101)
        g.players = {101: members[101], 102: members[102], 103: members[103]}
        g.phase = "playing"
        g.topic = "動物"
        g.last_word = "ぞう"
        g.used = {"ぞう", "うま"}
        g.history = [(102, "うま")]
        g.turn_index = 0
        cog._save_snapshot(g)

        bot2, guild2, channel2, members2 = make_world(6701)
        cog2 = shiritori_mod.OdaiShiritori(bot2)
        with fast_time():
            await cog2.restore_after_restart()
            restored = cog2.games.get(6701)
            self.assertIsNotNone(restored)
            self.assertEqual(restored.topic, "動物")
            self.assertEqual(restored.last_word, "ぞう")
            self.assertEqual(restored.used, {"ぞう", "うま"})
            self.assertEqual(restored.history, [(102, "うま")])
            await real_sleep(0.3)
            restored.out = [102, 103]   # 残り1人 → 終局して後片付けされる
            restored.phase = "done"
            await real_sleep(0.8)
        self.assertNotIn(6701, cog2.games)
        self.assertEqual(game_restore.session_entries("shiritori"), {})


class UnoRestoreTest(StoreTestCase, unittest.IsolatedAsyncioTestCase):
    def _make_started_game(self, cog, channel, members):
        game = uno_mod.UnoGame(6801, 101)
        game.players = [101, 102]
        game.hands = {101: ["赤の7", "青の3"], 102: ["緑の2"]}
        game.deck = ["黄の1", "青の9", "緑の5"]
        game.discard_pile = ["赤の5"]
        game.is_started = True
        cog.games[6801] = game
        return game

    async def test_panel_send_saves_and_restore_resumes(self):
        bot, guild, channel, members = make_world(6801, user_ids=(101, 102))
        cog = uno_mod.Uno(bot)
        game = self._make_started_game(cog, channel, members)
        await cog.send_game_panel(channel, game, info_msg="開始")
        self.assertIn(6801, game_restore.session_entries("uno"))

        bot2, guild2, channel2, members2 = make_world(6801, user_ids=(101, 102))
        cog2 = uno_mod.Uno(bot2)
        await cog2.restore_after_restart()
        restored = cog2.games.get(6801)
        self.assertIsNotNone(restored)
        self.assertEqual(restored.hands, game.hands)
        self.assertEqual(restored.deck, game.deck)
        self.assertEqual(restored.discard_pile, ["赤の5"])
        self.assertEqual(restored.current_player_idx, 0)
        # 新しい操作パネル（GameControlView つき）が送り直されている
        self.assertIsNotNone(restored.active_panel_message)
        self.assertIsInstance(restored.active_view, uno_mod.GameControlView)

        # 続きをプレイできる: 手番プレイヤーが出せるカードを出す
        select = next(c for c in restored.active_view.children
                      if isinstance(c, uno_mod.CardSelect))
        interaction = FakeInteraction(members2[101], channel2)
        await choose(select, "赤の7", interaction)
        self.assertEqual(restored.discard_pile[-1], "赤の7")
        self.assertEqual(restored.hands[101], ["青の3"])
        self.assertEqual(restored.current_player_idx, 1)

    async def test_missing_channel_entry_is_cleaned(self):
        bot, guild, channel, members = make_world(6801, user_ids=(101, 102))
        cog = uno_mod.Uno(bot)
        game = self._make_started_game(cog, channel, members)
        await cog.send_game_panel(channel, game, info_msg="開始")
        cog2 = uno_mod.Uno(FakeBot())
        await cog2.restore_after_restart()
        self.assertEqual(cog2.games, {})
        self.assertEqual(game_restore.session_entries("uno"), {})


class WordleRestoreTest(StoreTestCase, unittest.IsolatedAsyncioTestCase):
    async def test_restore_resumes_same_guesses_and_can_finish(self):
        bot, guild, channel, members = make_world(6901, user_ids=(101, 102))
        cog = wordle_mod.Wordle(bot)
        g = wordle_mod.WordleGame(6901, 777, members[101], "crane", "shared")
        colors = wordle_mod.score("slate", "crane")
        g.guesses.append((members[102], "slate", colors))
        g.message = await channel.send("board")
        g.started_at = time.time()
        cog.games[6901] = g
        cog._save_snapshot(g)
        self.assertIn(6901, game_restore.session_entries("wordle"))

        bot2, guild2, channel2, members2 = make_world(6901, user_ids=(101, 102))
        fetched = channel2.add_message(g.message.id)
        cog2 = wordle_mod.Wordle(bot2)
        await cog2.restore_after_restart()
        restored = cog2.games.get(6901)
        self.assertIsNotNone(restored)
        self.assertEqual(restored.answer, "crane")
        self.assertEqual(len(restored.guesses), 1)
        self.assertEqual(restored.guesses[0][1], "slate")
        self.assertEqual(restored.guesses[0][2], colors)
        # 既存の盤面メッセージへ BoardView が付け直されている
        self.assertTrue(any(isinstance(kw.get("view"), wordle_mod.BoardView)
                            for kw in fetched.edits))
        # 続きをプレイして当てれば通常どおり終わり、後片付けされる
        interaction = FakeInteraction(members2[102], channel2)
        await cog2.submit_guess(interaction, restored, "crane")
        await real_sleep(0.5)
        self.assertNotIn(6901, cog2.games)
        self.assertEqual(game_restore.session_entries("wordle"), {})


if __name__ == "__main__":
    unittest.main()
