# -*- coding: utf-8 -*-
"""2048（ソロ・スコアアタック）の純粋ロジック。

4×4 の盤を上下左右にスライドさせ、同じ数字同士を合体させる。
移動のたびに空きマスへ 2（90%）か 4（10%）が 1 つ現れる。
2048 タイルに到達しても続行でき、動けなくなったらゲームオーバー。
"""
from __future__ import annotations

import random

SIZE = 4
DIRECTIONS = ("up", "down", "left", "right")


def _merge_line(line):
    """1 列（行）を左詰めで合体させる。(新しい列, 得点) を返す。"""
    tiles = [v for v in line if v]
    merged = []
    score = 0
    i = 0
    while i < len(tiles):
        if i + 1 < len(tiles) and tiles[i] == tiles[i + 1]:
            value = tiles[i] * 2
            merged.append(value)
            score += value
            i += 2
        else:
            merged.append(tiles[i])
            i += 1
    merged.extend([0] * (len(line) - len(merged)))
    return merged, score


class Game2048:
    def __init__(self, rng: random.Random = None, board=None):
        self.rng = rng or random.Random()
        self.board = [row[:] for row in board] if board else [[0] * SIZE for _ in range(SIZE)]
        self.score = 0
        self.moves = 0
        self.won = False  # 2048 に到達したことがある
        if board is None:
            self._spawn()
            self._spawn()

    def _spawn(self) -> None:
        empty = [(r, c) for r in range(SIZE) for c in range(SIZE) if self.board[r][c] == 0]
        if not empty:
            return
        r, c = self.rng.choice(empty)
        self.board[r][c] = 4 if self.rng.random() < 0.1 else 2

    @property
    def max_tile(self) -> int:
        return max(max(row) for row in self.board)

    def _lines(self, direction):
        """方向ごとに、合体対象の列を取り出すための座標列を返す。"""
        b = self.board
        if direction == "left":
            return [[(r, c) for c in range(SIZE)] for r in range(SIZE)]
        if direction == "right":
            return [[(r, c) for c in reversed(range(SIZE))] for r in range(SIZE)]
        if direction == "up":
            return [[(r, c) for r in range(SIZE)] for c in range(SIZE)]
        return [[(r, c) for r in reversed(range(SIZE))] for c in range(SIZE)]

    def move(self, direction: str) -> bool:
        """スライドできたら True（盤が変わった場合のみスポーンと得点加算）。"""
        if direction not in DIRECTIONS:
            raise ValueError(direction)
        changed = False
        total_score = 0
        new_board = [row[:] for row in self.board]
        for coords in self._lines(direction):
            line = [self.board[r][c] for r, c in coords]
            merged, score = _merge_line(line)
            total_score += score
            for (r, c), value in zip(coords, merged):
                new_board[r][c] = value
                if value != self.board[r][c]:
                    changed = True
        if not changed:
            return False
        self.board = new_board
        self.score += total_score
        self.moves += 1
        if self.max_tile >= 2048:
            self.won = True
        self._spawn()
        return True

    def game_over(self) -> bool:
        for r in range(SIZE):
            for c in range(SIZE):
                if self.board[r][c] == 0:
                    return False
                if c + 1 < SIZE and self.board[r][c] == self.board[r][c + 1]:
                    return False
                if r + 1 < SIZE and self.board[r][c] == self.board[r + 1][c]:
                    return False
        return True

    def text(self) -> str:
        rows = []
        for row in self.board:
            rows.append(" ".join(f"{v:>5}" if v else "    ·" for v in row))
        return "\n".join(rows)
