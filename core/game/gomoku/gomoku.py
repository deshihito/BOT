# -*- coding: utf-8 -*-
"""五目並べ（15×15）の純粋ロジックと脅威検出ベースの簡易 CPU。

CPU の選点は決定的: ① 自分の五連完成 > ② 相手の五連阻止 >
③ パターン評価（連の長さと両端の空き）で攻撃＋防御を最大化するマス。
同点は中央に近い順→座標順で選ぶ。
"""
from __future__ import annotations

SIZE = 15
EMPTY, BLACK, WHITE = ".", "●", "○"
DIRECTIONS = ((0, 1), (1, 0), (1, 1), (1, -1))


def new_board():
    return [[EMPTY] * SIZE for _ in range(SIZE)]


def opponent(player: str) -> str:
    return WHITE if player == BLACK else BLACK


def _in(r, c):
    return 0 <= r < SIZE and 0 <= c < SIZE


def line_run(board, player, r, c, dr, dc):
    """(r,c) を起点に (dr,dc) 方向へ player の石が続く数（起点を含まない）。"""
    count = 0
    r, c = r + dr, c + dc
    while _in(r, c) and board[r][c] == player:
        count += 1
        r += dr
        c += dc
    return count, (r, c)


def is_win_at(board, player, r, c) -> bool:
    """(r,c) に player の石があるとして五連になるか。"""
    for dr, dc in DIRECTIONS:
        total = 1
        for sign in (1, -1):
            count, _ = line_run(board, player, r, c, dr * sign, dc * sign)
            total += count
        if total >= 5:
            return True
    return False


def winner(board):
    for r in range(SIZE):
        for c in range(SIZE):
            p = board[r][c]
            if p != EMPTY and is_win_at(board, p, r, c):
                return p
    return None


def legal_moves(board):
    return [(r, c) for r in range(SIZE) for c in range(SIZE) if board[r][c] == EMPTY]


def is_full(board) -> bool:
    return all(cell != EMPTY for row in board for cell in row)


def _pattern_score(board, player, r, c) -> float:
    """(r,c) に置いたときの、そのマスを通る4方向の連評価の合計。"""
    total = 0.0
    for dr, dc in DIRECTIONS:
        run = 1
        open_ends = 0
        for sign in (1, -1):
            count, (er, ec) = line_run(board, player, r, c, dr * sign, dc * sign)
            run += count
            if _in(er, ec) and board[er][ec] == EMPTY:
                open_ends += 1
        if run >= 5:
            total += 1_000_000
        elif run == 4:
            total += 100_000 if open_ends == 2 else 10_000 if open_ends == 1 else 0
        elif run == 3:
            total += 1_000 if open_ends == 2 else 100 if open_ends == 1 else 0
        elif run == 2:
            total += 50 if open_ends == 2 else 10 if open_ends == 1 else 0
        else:
            total += 1
    return total


def candidates(board):
    """石の周囲2マス以内の空きマス（序盤は中央）。"""
    stones = [(r, c) for r in range(SIZE) for c in range(SIZE) if board[r][c] != EMPTY]
    if not stones:
        return [(SIZE // 2, SIZE // 2)]
    found = set()
    for r, c in stones:
        for dr in range(-2, 3):
            for dc in range(-2, 3):
                nr, nc = r + dr, c + dc
                if _in(nr, nc) and board[nr][nc] == EMPTY:
                    found.add((nr, nc))
    return sorted(found)


def choose_ai_move(board, player: str):
    """脅威検出ベースの決定的選点。合法手が無ければ None。"""
    moves = candidates(board)
    if not moves:
        return None
    foe = opponent(player)
    for move in moves:  # ① 自分の五連
        if is_win_at(board, player, *move):
            return move
    for move in moves:  # ② 相手の五連阻止
        if is_win_at(board, foe, *move):
            return move
    center = SIZE // 2

    def score(move):
        r, c = move
        attack = _pattern_score(board, player, r, c)
        defense = _pattern_score(board, foe, r, c)
        dist = abs(r - center) + abs(c - center)
        return (attack + defense * 0.9, -dist, -r, -c)

    return max(moves, key=score)
