# -*- coding: utf-8 -*-
"""31ゲーム（カウントゲーム）の純粋ロジック。

順番に 1〜3 個ずつ数字を数え進める。自分の番で「31」を口にした人が脱落し、
カウントは 0 から仕切り直す。最後の 1 人が勝者。
2 人のときは、31 を言った相手ではない方がそのまま勝者になる。
"""
from __future__ import annotations

TARGET = 31
MAX_STEP = 3


class ThirtyOneGame:
    def __init__(self, player_ids):
        ids = list(player_ids)
        if not (2 <= len(ids) <= 8):
            raise ValueError("31ゲームは2〜8人です")
        self.players = ids              # 参加順
        self.alive = list(ids)          # 生存者（参加順）
        self.total = 0                  # 現在のカウント
        self.turn_index = 0             # alive のインデックス
        self.eliminated = []            # 脱落した順
        self.last_said = []             # 直前の手番で言った数字
        self.finished = False
        self.winner = None

    @property
    def current(self):
        if self.finished:
            return None
        return self.alive[self.turn_index % len(self.alive)]

    def apply(self, step: int) -> dict:
        """現在のプレイヤーが step 個数える。結果を dict で返す。

        said: その手番で言った数字のリスト / hit31: 31を言って脱落したか /
        eliminated: 脱落者（いなければ None）/ winner: 決着した場合の勝者
        """
        if self.finished:
            raise ValueError("ゲームは終了しています")
        if not (1 <= step <= MAX_STEP):
            raise ValueError("1〜3個までです")
        player = self.current
        said = list(range(self.total + 1, self.total + step + 1))
        self.last_said = said
        hit31 = TARGET in said
        eliminated = None
        if hit31:
            eliminated = player
            self.eliminated.append(player)
            idx = self.alive.index(player)
            self.alive.pop(idx)
            self.total = 0
            if len(self.alive) == 1:
                self.finished = True
                self.winner = self.alive[0]
                self.turn_index = 0
            else:
                # 脱落者の次の人から再開
                self.turn_index = idx % len(self.alive)
        else:
            self.total += step
            self.turn_index = (self.turn_index + 1) % len(self.alive)
        return {"player": player, "said": said, "hit31": hit31,
                "eliminated": eliminated, "winner": self.winner}
