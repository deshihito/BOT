# -*- coding: utf-8 -*-
"""ハイ＆ロー（ソロ・ストリーク型）の純粋ロジック。

山札（52枚）から1枚を見せ、次のカードが「高い」か「低い」かを当て続ける。
連続正解（ストリーク）がスコア。同点（同じ数字）は外れにせず、その札を
今のカードにして「続ける／ここでやめる」を選べる引き分け扱いにする
（2026-11-07 仕様変更。以前は同点=外れだった）。賭け要素は無く、記録は
core/game/game_records.py の highlow 区分に残す。
"""
from __future__ import annotations

import random

RANKS = range(2, 15)  # 2..14（11=J, 12=Q, 13=K, 14=A）
SUITS = ("♠", "♥", "♦", "♣")


def rank_label(rank: int) -> str:
    return {11: "J", 12: "Q", 13: "K", 14: "A"}.get(rank, str(rank))


def card_label(card) -> str:
    rank, suit = card
    return f"{suit}{rank_label(rank)}"


def new_deck(rng: random.Random) -> list:
    deck = [(rank, suit) for rank in RANKS for suit in SUITS]
    rng.shuffle(deck)
    return deck


class HighLowGame:
    """1プレイ分の状態。current を見て guess('high'|'low') を繰り返す。"""

    def __init__(self, rng: random.Random = None):
        self.rng = rng or random.Random()
        self.deck = new_deck(self.rng)
        self.current = self.deck.pop()
        self.streak = 0
        self.finished = False
        self.cleared = False  # 山札を最後まで当て切った
        self.last_drawn = None
        self.last_outcome = None  # "correct" / "wrong" / "tie" / None

    @property
    def remaining(self) -> int:
        return len(self.deck)

    def guess(self, direction: str) -> bool:
        """次のカードをめくり、正解なら True。

        同点は引き分け: 外れにせず、その札を今のカードにしてゲームは
        続く（``last_outcome == "tie"``。戻り値は従来互換で False）。
        続けるかやめるかは表示側がボタンで選ばせる。ただし同点の札が
        山札の最後の1枚だった場合は、そこで終了する（ストリークは保持）。
        """
        if self.finished or not self.deck:
            return False
        nxt = self.deck.pop()
        self.last_drawn = nxt
        if nxt[0] == self.current[0]:
            self.last_outcome = "tie"
            self.current = nxt
            if not self.deck:
                self.finished = True
            return False
        if direction == "high":
            correct = nxt[0] > self.current[0]
        else:
            correct = nxt[0] < self.current[0]
        self.current = nxt
        self.last_outcome = "correct" if correct else "wrong"
        if correct:
            self.streak += 1
            if not self.deck:
                self.finished = True
                self.cleared = True
        else:
            self.finished = True
        return correct
