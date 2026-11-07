# -*- coding: utf-8 -*-
"""四目並べ（7列×6行）の純粋ロジックと簡易 CPU。

CPU は脅威検出（勝ち手 > 相手の勝ち手阻止）を先に行い、残りは深さ4の
ミニマックス（中央重視の評価）で選ぶ。決定的（同点は列番号の小さい順）。
"""
from __future__ import annotations

COLS, ROWS = 7, 6
EMPTY, RED, YELLOW = ".", "🔴", "🟡"
CENTER_ORDER = (3, 2, 4, 1, 5, 0, 6)


def new_board():
    return [[EMPTY] * COLS for _ in range(ROWS)]


def opponent(player: str) -> str:
    return YELLOW if player == RED else RED


def drop_row(board, col: int):
    """その列に落としたとき着地する行。満杯なら None。"""
    for r in range(ROWS - 1, -1, -1):
        if board[r][col] == EMPTY:
            return r
    return None


def legal_moves(board):
    return [c for c in range(COLS) if drop_row(board, c) is not None]


def drop(board, col: int, player: str) -> bool:
    r = drop_row(board, col)
    if r is None:
        return False
    board[r][col] = player
    return True


def is_win_at(board, player, r, c) -> bool:
    for dr, dc in ((0, 1), (1, 0), (1, 1), (1, -1)):
        total = 1
        for sign in (1, -1):
            nr, nc = r + dr * sign, c + dc * sign
            while 0 <= nr < ROWS and 0 <= nc < COLS and board[nr][nc] == player:
                total += 1
                nr += dr * sign
                nc += dc * sign
        if total >= 4:
            return True
    return False


def winner(board):
    for r in range(ROWS):
        for c in range(COLS):
            p = board[r][c]
            if p != EMPTY and is_win_at(board, p, r, c):
                return p
    return None


def is_full(board) -> bool:
    return all(board[0][c] != EMPTY for c in range(COLS))


def _window_score(window, player, foe) -> float:
    mine = window.count(player)
    theirs = window.count(foe)
    empty = window.count(EMPTY)
    if mine == 4:
        return 100000
    if mine == 3 and empty == 1:
        return 100
    if mine == 2 and empty == 2:
        return 10
    if theirs == 3 and empty == 1:
        return -80
    if theirs == 2 and empty == 2:
        return -8
    return 0


def _evaluate(board, player) -> float:
    foe = opponent(player)
    score = 0.0
    for c in range(COLS):  # 中央列の占有ボーナス
        if board[ROWS // 2][c] == player:
            score += 3 if c == 3 else 1
    windows = []
    for r in range(ROWS):
        for c in range(COLS - 3):
            windows.append([board[r][c + i] for i in range(4)])
    for c in range(COLS):
        for r in range(ROWS - 3):
            windows.append([board[r + i][c] for i in range(4)])
    for r in range(ROWS - 3):
        for c in range(COLS - 3):
            windows.append([board[r + i][c + i] for i in range(4)])
            windows.append([board[r + 3 - i][c + i] for i in range(4)])
    for w in windows:
        score += _window_score(w, player, foe)
    return score


def _minimax(board, turn, ai, depth, alpha, beta) -> float:
    win = winner(board)
    if win == ai:
        return 1_000_000 + depth
    if win is not None:
        return -1_000_000 - depth
    if is_full(board) or depth == 0:
        return _evaluate(board, ai)
    moves = [c for c in CENTER_ORDER if drop_row(board, c) is not None]
    if turn == ai:
        best = -float("inf")
        for col in moves:
            r = drop_row(board, col)
            board[r][col] = turn
            best = max(best, _minimax(board, opponent(turn), ai, depth - 1, alpha, beta))
            board[r][col] = EMPTY
            alpha = max(alpha, best)
            if beta <= alpha:
                break
        return best
    best = float("inf")
    for col in moves:
        r = drop_row(board, col)
        board[r][col] = turn
        best = min(best, _minimax(board, opponent(turn), ai, depth - 1, alpha, beta))
        board[r][col] = EMPTY
        beta = min(beta, best)
        if beta <= alpha:
            break
    return best


def choose_ai_move(board, player: str, depth: int = 4):
    moves = legal_moves(board)
    if not moves:
        return None
    foe = opponent(player)
    for col in CENTER_ORDER:  # ① 自分の勝ち手
        if col in moves:
            r = drop_row(board, col)
            board[r][col] = player
            win = is_win_at(board, player, r, col)
            board[r][col] = EMPTY
            if win:
                return col
    for col in CENTER_ORDER:  # ② 相手の勝ち手を阻止
        if col in moves:
            r = drop_row(board, col)
            board[r][col] = foe
            win = is_win_at(board, foe, r, col)
            board[r][col] = EMPTY
            if win:
                return col
    best_col, best_score = None, -float("inf")
    for col in [c for c in CENTER_ORDER if c in moves]:
        r = drop_row(board, col)
        board[r][col] = player
        score = _minimax(board, foe, player, depth - 1, -float("inf"), float("inf"))
        board[r][col] = EMPTY
        if score > best_score:
            best_col, best_score = col, score
    return best_col
