# -*- coding: utf-8 -*-
"""ノノグラム（ピクロス）の絵柄・ヒント計算・盤面状態。

絵柄は同梱のピクセルアート（'#' が正解の塗りマス）。行・列のヒント数字は
絵柄から自動計算する。プレイヤーの盤面は 未定0 / 塗り1 / バツ2 で持つ。
クリア判定は「塗りマスの集合が絵柄と一致すること」（バツは不問）。
"""
from __future__ import annotations

import random

PATTERNS = {
    "5x5": [
        ("ハート", ["01110", "11111", "11111", "01110", "00100"]),
        ("星", ["00100", "01110", "11111", "01110", "10101"]),
        ("家", ["00100", "01110", "11111", "01110", "01110"]),
        ("きのこ", ["01110", "11111", "00100", "00100", "01110"]),
        ("魚", ["01100", "11110", "11111", "11110", "01100"]),
        ("矢印", ["00100", "01100", "11111", "01100", "00100"]),
    ],
    "8x8": [
        ("ロケット", ["00011000", "00111100", "00111100", "01111110",
                      "01111110", "00111100", "01011010", "10000001"]),
        ("城", ["01010101", "01111110", "01111110", "01111110",
                "01111110", "01111110", "01011010", "01111110"]),
        ("猫", ["01000010", "01100110", "01111110", "01111110",
               "00111100", "00111100", "01111110", "00000000"]),
        ("船", ["00001000", "00001100", "00011110", "00001000",
                "10001001", "11011111", "01111110", "00111100"]),
        ("木", ["00011000", "00111100", "01111110", "11111111",
                "00111100", "00011000", "00011000", "00111100"]),
        ("笑顔", ["00111100", "01111110", "01011010", "01111110",
                  "01111110", "01000010", "00111100", "00000000"]),
    ],
}
SIZES = ("5x5", "8x8")


def clues_for(line) -> list:
    """1 行（'0'/'1' の列）から連続する 1 の長さのリストを作る。"""
    clues, run = [], 0
    for ch in line:
        if ch == "1":
            run += 1
        elif run:
            clues.append(run)
            run = 0
    if run:
        clues.append(run)
    return clues or [0]


class NonogramPuzzle:
    def __init__(self, size_key: str, name: str, rows: list):
        self.size_key = size_key
        self.name = name
        self.solution = [[1 if ch == "1" else 0 for ch in row] for row in rows]
        self.n = len(rows)
        self.row_clues = [clues_for(row) for row in rows]
        self.col_clues = [clues_for("".join(rows[r][c] for r in range(self.n)))
                          for c in range(self.n)]

    @classmethod
    def pick(cls, size_key: str, rng: random.Random = None):
        rng = rng or random.Random()
        name, rows = rng.choice(PATTERNS[size_key])
        return cls(size_key, name, rows)


class NonogramBoard:
    def __init__(self, puzzle: NonogramPuzzle):
        self.puzzle = puzzle
        self.n = puzzle.n
        self.grid = [[0] * self.n for _ in range(self.n)]

    def cycle(self, r: int, c: int) -> int:
        """未定→塗り→バツ→未定 と回す。"""
        self.grid[r][c] = (self.grid[r][c] + 1) % 3
        return self.grid[r][c]

    def set_cell(self, r: int, c: int, value: int) -> None:
        self.grid[r][c] = value

    def wrong_filled(self) -> int:
        """塗ったが正解でないマスの数。"""
        return sum(1 for r in range(self.n) for c in range(self.n)
                   if self.grid[r][c] == 1 and self.puzzle.solution[r][c] == 0)

    def cleared(self) -> bool:
        return all(self.grid[r][c] == 1 or self.puzzle.solution[r][c] == 0
                   for r in range(self.n) for c in range(self.n)) and \
            all(self.puzzle.solution[r][c] == 0 or self.grid[r][c] == 1
                for r in range(self.n) for c in range(self.n))

    def text(self) -> str:
        """ヒント付きの盤面テキスト。塗り=■、バツ=×、未定=·。"""
        n = self.n
        max_row = max(len(c) for c in self.puzzle.row_clues)
        max_col = max(len(c) for c in self.puzzle.col_clues)
        marks = {0: "·", 1: "■", 2: "×"}
        lines = []
        for level in range(max_col):
            head = " " * (max_row * 2 + 1)
            cells = []
            for c in range(n):
                clues = self.puzzle.col_clues[c]
                idx = level - (max_col - len(clues))
                cells.append(f"{clues[idx]:>2}" if idx >= 0 else "  ")
            lines.append(head + " ".join(cells))
        for r in range(n):
            clues = self.puzzle.row_clues[r]
            pad = [0] * (max_row - len(clues)) + clues
            head = " ".join(f"{v:>2}" if v else "  " for v in pad)
            body = " ".join(f" {marks[self.grid[r][c]]}" for c in range(n))
            lines.append(f"{head} |{body}")
        return "\n".join(lines)
