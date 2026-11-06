"""ビンゴ（core/game/bingo.py）のテスト。"""

import random
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

from core.game.bingo import COLUMN_RANGES, BingoCard, BingoSession, format_card


class CardTest(unittest.TestCase):
    def test_generated_card_ranges_and_uniqueness(self):
        card = BingoCard.generate(random.Random(3))
        seen = set()
        for c, (lo, hi) in enumerate(COLUMN_RANGES):
            for r in range(5):
                value = card.grid[r][c]
                if value is None:
                    self.assertEqual((r, c), (2, 2))
                    continue
                self.assertTrue(lo <= value <= hi)
                self.assertNotIn(value, seen)
                seen.add(value)
        self.assertEqual(len(seen), 24)
        self.assertTrue(card.marked[2][2])

    def test_row_bingo(self):
        grid = [[c * 10 + r + 1 for c in range(5)] for r in range(5)]
        grid[2][2] = None
        card = BingoCard(grid)
        for c in range(5):
            if grid[0][c] is not None:
                card.mark(grid[0][c])
        self.assertTrue(card.has_bingo())

    def test_reach_detection(self):
        grid = [[c * 10 + r + 1 for c in range(5)] for r in range(5)]
        grid[2][2] = None
        card = BingoCard(grid)
        for c in range(4):
            card.mark(grid[0][c])
        self.assertTrue(card.is_reach())
        self.assertFalse(card.has_bingo())

    def test_format_card(self):
        card = BingoCard.generate(random.Random(1))
        text = format_card(card)
        self.assertIn("★", text)
        self.assertEqual(len(text.splitlines()), 5)

    def test_marks_needed(self):
        grid = [[c * 10 + r + 1 for c in range(5)] for r in range(5)]
        grid[2][2] = None
        card = BingoCard(grid)
        # フリーのみマーク済み → 中央を通るラインが最短で残り4個
        self.assertEqual(card.marks_needed(), 4)
        for c in range(4):
            card.mark(grid[0][c])
        self.assertEqual(card.marks_needed(), 1)  # リーチ
        card.mark(grid[0][4])
        self.assertEqual(card.marks_needed(), 0)  # ビンゴ成立


class SessionTest(unittest.TestCase):
    def test_game_finishes_with_winner_within_75_draws(self):
        session = BingoSession([1, 2, 3], rng=random.Random(11))
        draws = 0
        while not session.finished and draws < 75:
            number, winners, _reach = session.draw_next()
            self.assertIsNotNone(number)
            draws += 1
            if winners:
                self.assertEqual(session.winners, winners)
        self.assertTrue(session.finished)
        self.assertTrue(session.winners)
        for uid in session.winners:
            self.assertTrue(session.cards[uid].has_bingo())

    def test_drawn_numbers_are_unique(self):
        session = BingoSession([1], rng=random.Random(5))
        seen = []
        while not session.finished:
            number, _w, _r = session.draw_next()
            seen.append(number)
        self.assertEqual(len(seen), len(set(seen)))
        self.assertTrue(all(1 <= n <= 75 for n in seen))


class FakeMessage:
    def __init__(self, content):
        self.content = content
        self.initial_content = content
        self.edits = []

    async def edit(self, **kwargs):
        self.edits.append(kwargs)
        if "content" in kwargs:
            self.content = kwargs["content"]
        return self


class FakeChannel:
    def __init__(self):
        self.sent = []
        self.guild = None

    async def send(self, content=None, **kwargs):
        msg = FakeMessage(content)
        self.sent.append((msg, kwargs))
        return msg


class DrawCycleTest(unittest.IsolatedAsyncioTestCase):
    """抽選サイクル（2026-11-06）: 10秒間隔、7秒でローディング送信→編集で開示。"""

    async def test_draw_once_is_single_message_tease_then_reveal(self):
        from core.game.bingo_cog.cog import DRAW_INTERVAL, TEASE_SECONDS, Bingo

        self.assertEqual(DRAW_INTERVAL, 10)
        self.assertEqual(TEASE_SECONDS, 7)

        cog = Bingo(MagicMock())
        session = BingoSession([1, 2], rng=random.Random(0))
        channel = FakeChannel()
        sleeps = []

        async def fake_sleep(seconds):
            sleeps.append(seconds)

        with patch("asyncio.sleep", fake_sleep):
            number, _winners, _reach = await cog._draw_once(channel, session)

        self.assertEqual(sleeps, [TEASE_SECONDS, DRAW_INTERVAL - TEASE_SECONDS])
        # 送信は1通だけ（ローディング）で、開示はその編集で完結する。
        # V2 化で本文はパネルの TextDisplay に移ったため、ビュー側を読む。
        def panel_text(view):
            return "\n".join(
                getattr(child, "content", "") or ""
                for child in view.walk_children()
                if child.__class__.__name__ == "TextDisplay")

        self.assertEqual(len(channel.sent), 1)
        msg, send_kwargs = channel.sent[0]
        self.assertIn("抽選中", panel_text(send_kwargs["view"]))
        self.assertEqual(len(msg.edits), 1)
        edit = msg.edits[0]
        self.assertIn(f"**{number}**", panel_text(edit["view"]))
        self.assertIn("これまで:", panel_text(edit["view"]))
        # 開示メッセージには「手札を確認」ボタンが付く
        view = edit["view"]
        labels = [getattr(child, "label", None) for child in view.walk_children()]
        self.assertIn("手札を確認", labels)

    async def test_card_check_sends_png_ephemerally(self):
        from core.game.bingo_cog.cog import CardCheckView

        session = BingoSession([1, 2], rng=random.Random(0))
        view = CardCheckView(MagicMock(), session)
        button = view.check
        interaction = MagicMock()
        interaction.user.id = 1
        interaction.response.send_message = AsyncMock()
        await button.callback(interaction)
        _args, kwargs = interaction.response.send_message.call_args
        self.assertTrue(kwargs["ephemeral"])
        self.assertEqual(kwargs["file"].filename, "bingo_card.png")
        self.assertEqual(kwargs["embed"].image.url, "attachment://bingo_card.png")
        self.assertIn("あと", kwargs["embed"].description)


if __name__ == "__main__":
    unittest.main()
