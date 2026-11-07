# -*- coding: utf-8 -*-
"""数独（9×9）の生成・検証ロジック。

完成盤面をランダムに作り、唯一解を保ちながら穴を開ける。難易度は
開けるマス数の目標で調整する（かんたん36／ふつう44／むずかしい50。
唯一解チェックで目標に届かない場合は届いたところまでで確定する）。
一意性チェックは解の数え上げ（2つ見つけたら打ち切り）で行う。
デイリーは日付文字列をシードにした決定的生成で、全員が同じ問題になる。
"""
from __future__ import annotations

import hashlib
import random

SIZE = 9
DIFFICULTIES = {
    "easy": ("かんたん", 36),
    "normal": ("ふつう", 44),
    "hard": ("むずかしい", 50),
    "daily": ("デイリー（ふつう）", 44),
}


def _candidates(grid, r, c):
    used = set(grid[r]) | {grid[i][c] for i in range(SIZE)}
    br, bc = (r // 3) * 3, (c // 3) * 3
    used |= {grid[i][j] for i in range(br, br + 3) for j in range(bc, bc + 3)}
    return [n for n in range(1, 10) if n not in used]


def _find_empty_mrv(grid):
    """候補が最も少ない空きマスを返す（無ければ None）。"""
    best, best_cands = None, None
    for r in range(SIZE):
        for c in range(SIZE):
            if grid[r][c] == 0:
                cands = _candidates(grid, r, c)
                if best_cands is None or len(cands) < len(best_cands):
                    best, best_cands = (r, c), cands
                    if len(cands) <= 1:
                        return best, best_cands
    return best, best_cands


def count_solutions(grid, limit: int = 2) -> int:
    """解の数を limit まで数える（盤面は書き換えない）。"""
    work = [row[:] for row in grid]

    def search() -> int:
        found = _find_empty_mrv(work)
        if found is None or found[0] is None:
            return 1
        (r, c), cands = found
        if not cands:
            return 0
        total = 0
        for n in cands:
            work[r][c] = n
            total += search()
            work[r][c] = 0
            if total >= limit:
                break
        return total

    return search()


def solve(grid):
    """解を1つ返す（無ければ None）。盤面は書き換えない。"""
    work = [row[:] for row in grid]

    def search() -> bool:
        found = _find_empty_mrv(work)
        if found is None or found[0] is None:
            return True
        (r, c), cands = found
        for n in cands:
            work[r][c] = n
            if search():
                return True
            work[r][c] = 0
        return False

    return work if search() else None


def _full_solution(rng: random.Random):
    grid = [[0] * SIZE for _ in range(SIZE)]

    def fill() -> bool:
        found = _find_empty_mrv(grid)
        if found is None or found[0] is None:
            return True
        (r, c), cands = found
        order = list(cands)
        rng.shuffle(order)
        for n in order:
            grid[r][c] = n
            if fill():
                return True
            grid[r][c] = 0
        return False

    fill()
    return grid


def generate(rng: random.Random, difficulty: str):
    """(問題, 解) を返す。唯一解を保ちながら目標数まで穴を開ける。"""
    _, target = DIFFICULTIES[difficulty]
    solution = _full_solution(rng)
    puzzle = [row[:] for row in solution]
    cells = [(r, c) for r in range(SIZE) for c in range(SIZE)]
    rng.shuffle(cells)
    removed = 0
    for r, c in cells:
        if removed >= target:
            break
        backup = puzzle[r][c]
        puzzle[r][c] = 0
        if count_solutions(puzzle, limit=2) == 1:
            removed += 1
        else:
            puzzle[r][c] = backup
    return puzzle, solution


def daily_seed(date_key: str) -> int:
    return int(hashlib.sha256(f"sudoku-daily:{date_key}".encode()).hexdigest()[:12], 16)


def daily_puzzle(date_key: str):
    return generate(random.Random(daily_seed(date_key)), "daily")


def is_complete_and_valid(board) -> bool:
    """全マスが埋まり、行・列・ブロックに重複が無いか。"""
    want = set(range(1, 10))
    for r in range(SIZE):
        if set(board[r]) != want:
            return False
    for c in range(SIZE):
        if {board[r][c] for r in range(SIZE)} != want:
            return False
    for br in range(0, SIZE, 3):
        for bc in range(0, SIZE, 3):
            if {board[r][c] for r in range(br, br + 3) for c in range(bc, bc + 3)} != want:
                return False
    return True


def board_text(board, givens) -> str:
    """コードブロック用の盤面表示（初期マスは括弧で示す）。"""
    lines = []
    for r in range(SIZE):
        cells = []
        for c in range(SIZE):
            v = board[r][c]
            cells.append(f"[{v}]" if givens[r][c] and v else (str(v) if v else "·"))
        lines.append(" ".join(cells))
        if r in (2, 5):
            lines.append("―" * 17)
    return "\n".join(lines)
