# -*- coding: utf-8 -*-
"""「めんどうパス」（Cockroach Poker 系の押し付け合いブラフゲーム）の純ロジック。

ルール（AGO版）: 害虫カードを「めんどうな用事」カードに読み替えた。
- 用事カード8種×各4枚を全員に配り切る。
- 手番の人は手札1枚を裏向きで相手に渡し、「これは『○○』だ」と宣言する
  （宣言は嘘でもよい）。
- 渡された人は次のどれかを選ぶ:
  (a)「本当だと思う」: 宣言が本当なら渡した人が、外れていれば自分が引き取る。
  (b)「嘘だと思う」: 宣言が嘘なら渡した人が、本当なら自分が引き取る。
  (c)「回す」: 中身を自分だけ見て、まだこのカードを持っていない別の人に
      宣言し直して渡す。全員が一度持ったカードは最後の人が引き取るしかない。
- 引き取ったカードは表向きで自分の前に置く。同じ用事が4枚溜まった人の負け。
  チェーン開始時に手札が無い人も負け。敗者以外は全員勝ち。
"""
import random
from collections import Counter

KINDS = ["宿題", "残業", "掃除当番", "ゴミ出し", "買い出し", "プレゼン", "修理", "洗濯"]
COPIES = 4
LOSE_COUNT = 4


class MendouGame:
    def __init__(self, players: list[int], rng=None):
        if len(players) < 2:
            raise ValueError("2人以上必要です")
        self.players = list(players)
        self.rng = rng if rng is not None else random
        deck = [k for k in KINDS for _ in range(COPIES)]
        self.rng.shuffle(deck)
        self.hands: dict[int, Counter] = {uid: Counter() for uid in self.players}
        for i, kind in enumerate(deck):
            self.hands[self.players[i % len(self.players)]][kind] += 1
        self.fronts: dict[int, Counter] = {uid: Counter() for uid in self.players}
        # チェーン状態
        self.card: str | None = None          # いま回っているカードの本当の種類
        self.passer: int | None = None        # 直近に渡した人
        self.holder: int | None = None        # 判断する人
        self.declaration: str | None = None   # 直近の宣言
        self.visited: set[int] = set()        # このチェーンで既に持った人
        self.starter: int = self.players[0]   # 次チェーンの開始者
        self.loser: int | None = None

    # ------------------------------------------------------------------ 状態
    @property
    def finished(self) -> bool:
        return self.loser is not None

    @property
    def chain_active(self) -> bool:
        return self.card is not None

    @property
    def winners(self) -> list[int]:
        if self.loser is None:
            return []
        return [uid for uid in self.players if uid != self.loser]

    def hand_size(self, user_id: int) -> int:
        return sum(self.hands[user_id].values())

    def must_accept(self) -> bool:
        """回す先が残っていなければ、引き取るしかない。"""
        if not self.chain_active:
            return False
        return not self.pass_targets(self.holder)

    def pass_targets(self, user_id: int) -> list[int]:
        return [uid for uid in self.players
                if uid != user_id and uid not in self.visited and uid != self.holder]

    def check_starter_can_play(self) -> bool:
        """チェーン開始者が手札を持っていなければ、その人が負けになる。"""
        if not self.chain_active and self.loser is None and self.hand_size(self.starter) == 0:
            self.loser = self.starter
            return False
        return True

    # ------------------------------------------------------------------ 行動
    def start_chain(self, user_id: int, kind: str, target_id: int, declaration: str) -> bool:
        if self.finished or self.chain_active or user_id != self.starter:
            return False
        if self.hands[user_id].get(kind, 0) <= 0:
            return False
        if target_id == user_id or target_id not in self.players:
            return False
        if declaration not in KINDS:
            return False
        self.hands[user_id][kind] -= 1
        if self.hands[user_id][kind] <= 0:
            del self.hands[user_id][kind]
        self.card = kind
        self.passer = user_id
        self.holder = target_id
        self.declaration = declaration
        self.visited = {user_id}
        return True

    def peek(self, user_id: int) -> str | None:
        if self.chain_active and user_id == self.holder:
            return self.card
        return None

    def pass_on(self, user_id: int, target_id: int, declaration: str) -> bool:
        """中身を見たうえで、別の人へ宣言し直して回す。"""
        if not self.chain_active or user_id != self.holder:
            return False
        if declaration not in KINDS:
            return False
        if target_id not in self.pass_targets(user_id):
            return False
        self.visited.add(user_id)
        self.passer = user_id
        self.holder = target_id
        self.declaration = declaration
        return True

    def accept(self, user_id: int, guess_true: bool) -> dict | None:
        """宣言の真偽を当てて引き取りを決める。チェーンを終了する。"""
        if not self.chain_active or user_id != self.holder:
            return None
        truth = self.declaration == self.card
        guessed_right = guess_true == truth
        taker = self.passer if guessed_right else self.holder
        card = self.card
        self.fronts[taker][card] += 1
        result = {"card": card, "declaration": self.declaration, "truth": truth,
                  "guessed_right": guessed_right, "taker": taker}
        self.card = None
        self.passer = None
        self.holder = None
        self.declaration = None
        self.visited = set()
        self.starter = taker
        if self.fronts[taker][card] >= LOSE_COUNT:
            self.loser = taker
        return result
