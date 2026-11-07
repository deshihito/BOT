# -*- coding: utf-8 -*-
"""ビンゴのカードと進行ロジック（Discord 非依存）。

カードは 5×5（中央はフリースポット）。列ごとに数字の範囲が決まる
古典的な 75 球ビンゴ。抽選は全 75 球をシャッフルした順に行い、
全て引けば必ずどこかのラインが揃う。
"""
import random

COLUMN_RANGES = [(1, 15), (16, 30), (31, 45), (46, 60), (61, 75)]
SIZE = 5


class BingoCard:
    def __init__(self, grid):
        """grid: 5行×5列。中央 (2,2) は None（フリースポット）。"""
        self.grid = grid
        self.marked = [[False] * SIZE for _ in range(SIZE)]
        self.marked[2][2] = True

    @classmethod
    def generate(cls, rng: random.Random):
        columns = []
        for lo, hi in COLUMN_RANGES:
            nums = list(range(lo, hi + 1))
            rng.shuffle(nums)
            columns.append(nums[:SIZE])
        grid = [[columns[c][r] for c in range(SIZE)] for r in range(SIZE)]
        grid[2][2] = None
        return cls(grid)

    def mark(self, number: int) -> bool:
        for r in range(SIZE):
            for c in range(SIZE):
                if self.grid[r][c] == number:
                    self.marked[r][c] = True
                    return True
        return False

    def _lines(self):
        lines = []
        for r in range(SIZE):
            lines.append([(r, c) for c in range(SIZE)])
        for c in range(SIZE):
            lines.append([(r, c) for r in range(SIZE)])
        lines.append([(i, i) for i in range(SIZE)])
        lines.append([(i, SIZE - 1 - i) for i in range(SIZE)])
        return lines

    def has_bingo(self) -> bool:
        return any(all(self.marked[r][c] for r, c in line) for line in self._lines())

    def is_reach(self) -> bool:
        """あと1つでビンゴになるラインがあるか。"""
        if self.has_bingo():
            return False
        return any(sum(1 for r, c in line if not self.marked[r][c]) == 1 for line in self._lines())

    def marks_needed(self) -> int:
        """ビンゴ成立まで最短であと何個のマークが必要か（成立済みは0）。"""
        return min(sum(1 for r, c in line if not self.marked[r][c])
                   for line in self._lines())


class BingoSession:
    def __init__(self, player_ids, *, rng: random.Random = None):
        rng = rng or random.Random()
        self.cards = {uid: BingoCard.generate(rng) for uid in player_ids}
        deck = list(range(1, 76))
        rng.shuffle(deck)
        self.deck = deck
        self.drawn: list = []
        self.winners: list = []
        self.reached: set = set()  # リーチを通知済みのプレイヤー
        self.finished = False

    def draw_next(self):
        """次の球を引く。(番号, 新たにビンゴした人, 新たにリーチした人) を返す。"""
        if self.finished or not self.deck:
            return None, [], []
        number = self.deck.pop()
        self.drawn.append(number)
        new_winners, new_reach = [], []
        for uid, card in self.cards.items():
            if card.mark(number) and card.has_bingo():
                new_winners.append(uid)
        for uid, card in self.cards.items():
            if uid not in new_winners and uid not in self.reached and card.is_reach():
                self.reached.add(uid)
                new_reach.append(uid)
        if new_winners:
            self.winners = new_winners
            self.finished = True
        return number, new_winners, new_reach


def format_card(card: BingoCard) -> str:
    """カードをコードブロック用のテキストにする（マーク済みは [ ] で囲む）。"""
    rows = []
    for r in range(SIZE):
        cells = []
        for c in range(SIZE):
            value = card.grid[r][c]
            if value is None:
                cells.append(" ★ ")
            elif card.marked[r][c]:
                cells.append(f"[{value:2d}]")
            else:
                cells.append(f" {value:2d} ")
        rows.append(" ".join(cells))
    return "\n".join(rows)
