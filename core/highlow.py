# -*- coding: utf-8 -*-
"""ハイ＆ロー（ソロ・ストリーク型）の純粋ロジック。

山札（52枚）から1枚を見せ、次のカードが「高い」か「低い」かを当て続ける。
連続正解（ストリーク）がスコア。同点（同じ数字）は外れとして扱う
（ガイドにも明記）。賭け要素は無く、記録は core/game_records.py の
highlow 区分に残す。
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

    @property
    def remaining(self) -> int:
        return len(self.deck)

    def guess(self, direction: str) -> bool:
        """次のカードをめくり、正解なら True。外れたらゲーム終了。"""
        if self.finished or not self.deck:
            return False
        nxt = self.deck.pop()
        self.last_drawn = nxt
        if nxt[0] == self.current[0]:
            correct = False  # 同点は外れ（ガイド明記）
        elif direction == "high":
            correct = nxt[0] > self.current[0]
        else:
            correct = nxt[0] < self.current[0]
        self.current = nxt
        if correct:
            self.streak += 1
            if not self.deck:
                self.finished = True
                self.cleared = True
        else:
            self.finished = True
        return correct
