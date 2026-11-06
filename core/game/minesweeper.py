# -*- coding: utf-8 -*-
"""マインスイーパーの盤面ロジック（Discord 非依存）。

地雷は最初のマスを開いた時点で、そのマスと周囲を避けて配置する
（初回クリックで即爆発しない古典的な仕様）。

盤面画像化タスク（2026-11-06）でサイズを難易度ごとに可変にした。
従来の3難易度（easy/normal/hard = 5列×4行）はベストタイム記録の
キー互換のためサイズ・地雷数を一切変えず、大盤面は新キー
（wide/expert）として追加している。COLS/ROWS は従来サイズの定数として
互換のために残す。
"""
import random

COLS = 5
ROWS = 4

# key: (表示名, 地雷数, 行数, 列数)
DIFFICULTIES = {
    "easy": ("かんたん", 4, ROWS, COLS),
    "normal": ("ふつう", 6, ROWS, COLS),
    "hard": ("むずかしい", 8, ROWS, COLS),
    "wide": ("ひろびろ", 10, 9, 9),
    "expert": ("エキスパート", 35, 12, 16),
}


def difficulty_size(difficulty: str) -> tuple[int, int]:
    """(行数, 列数) を返す。"""
    _, _, rows, cols = DIFFICULTIES[difficulty]
    return rows, cols


class MinesweeperBoard:
    def __init__(self, difficulty: str = "normal", *, rng: random.Random = None):
        if difficulty not in DIFFICULTIES:
            raise ValueError(f"unknown difficulty: {difficulty}")
        self.difficulty = difficulty
        _, self.mine_total, self.rows, self.cols = DIFFICULTIES[difficulty]
        self.rng = rng or random.Random()
        self.mines: set = set()
        self.opened: set = set()
        self.flags: set = set()
        self.started = False
        self.exploded = None  # 爆発したマス (row, col)。None の間は継続中
        self.cleared = False

    # ------------------------------------------------------------------ 座標
    def neighbors(self, cell):
        r, c = cell
        for dr in (-1, 0, 1):
            for dc in (-1, 0, 1):
                if dr == 0 and dc == 0:
                    continue
                nr, nc = r + dr, c + dc
                if 0 <= nr < self.rows and 0 <= nc < self.cols:
                    yield (nr, nc)

    def count_around(self, cell) -> int:
        return sum(1 for n in self.neighbors(cell) if n in self.mines)

    # ------------------------------------------------------------------ 進行
    def _place_mines(self, safe_cell):
        safe = {safe_cell} | set(self.neighbors(safe_cell))
        candidates = [(r, c) for r in range(self.rows) for c in range(self.cols) if (r, c) not in safe]
        self.rng.shuffle(candidates)
        self.mines = set(candidates[: self.mine_total])
        self.started = True

    def open(self, cell):
        """マスを開く。開いたマスの集合を返す。地雷なら exploded を立てる。"""
        if self.cleared or self.exploded is not None:
            return set()
        if cell in self.flags or cell in self.opened:
            return set()
        if not self.started:
            self._place_mines(cell)
        if cell in self.mines:
            self.exploded = cell
            return set()
        newly = set()
        stack = [cell]
        while stack:
            cur = stack.pop()
            if cur in self.opened or cur in self.flags or cur in self.mines:
                continue
            self.opened.add(cur)
            newly.add(cur)
            if self.count_around(cur) == 0:
                stack.extend(n for n in self.neighbors(cur) if n not in self.opened)
        if len(self.opened) == self.rows * self.cols - self.mine_total:
            self.cleared = True
        return newly

    def toggle_flag(self, cell) -> bool:
        """旗を立てる/外す。現在の旗の状態を返す（立てたら True）。"""
        if self.cleared or self.exploded is not None or cell in self.opened:
            return cell in self.flags
        if cell in self.flags:
            self.flags.discard(cell)
            return False
        self.flags.add(cell)
        return True

    @property
    def mines_left(self) -> int:
        return self.mine_total - len(self.flags)
