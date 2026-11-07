# -*- coding: utf-8 -*-
"""「星か爆弾か」（Skull 系ブラフ＆競りゲーム）の純ロジック。

- 各自ディスク4枚（星3・爆弾1）を持つ。ラウンドでは順番に自分の前に
  1枚ずつ伏せて置いていく。置く代わりに「挑戦」を宣言すると競りが始まる。
- 競り: 宣言数（場の全ディスクからめくれる枚数）を +1 で競り上げ、パスで脱落。
  最高宣言者はまず自分の山から、次に他人の山を選んで上からめくる。
- 爆弾をめくったら失敗: 自分のディスクをランダムに1枚失う（全て失うと脱落）。
  宣言数ぶん全て星なら成功: マットを1枚返し、2回成功で勝利。
- v1簡略化: 失敗時の喪失ディスクは「相手が選ぶ」ではなくランダム（原典準拠の
  選択式はUI往復が増えるため。判断は実装ログに明記）。
"""
import random

FLOWER = "star"
BOMB = "bomb"
START_DISCS = 4


class HoshiGame:
    def __init__(self, players: list[int], rng: random.Random | None = None):
        if not 3 <= len(players) <= 6:
            raise ValueError("3〜6人必要です")
        self.players = list(players)
        self.rng = rng or random.Random()
        # 所有ディスク（伏せていない分）の内訳
        self.owned: dict[int, dict[str, int]] = {
            uid: {FLOWER: 3, BOMB: 1} for uid in players
        }
        self.wins: dict[int, int] = {uid: 0 for uid in players}
        self.eliminated: set[int] = set()
        self.phase = "place"  # place -> bid -> reveal -> (next round / done)
        self.stacks: dict[int, list[str]] = {uid: [] for uid in players}
        self.turn_order: list[int] = []
        self.turn_pos = 0
        self.bids: dict[int, int] = {}
        self.passed: set[int] = set()
        self.challenger: int | None = None
        self.bid_amount = 0
        self.flipped: list[tuple[int, str]] = []  # (持ち主, 種類)
        self.winner: int | None = None
        self.last_loser: int | None = None
        self._start_round(self.players[0])

    # ------------------------------------------------------------------ 内部
    def _alive(self) -> list[int]:
        return [uid for uid in self.players if uid not in self.eliminated]

    def _start_round(self, starter: int) -> None:
        alive = self._alive()
        if starter not in alive:
            starter = alive[0]
        idx = alive.index(starter)
        self.turn_order = alive[idx:] + alive[:idx]
        self.turn_pos = 0
        self.stacks = {uid: [] for uid in self.players}
        self.bids = {}
        self.passed = set()
        self.challenger = None
        self.bid_amount = 0
        self.flipped = []
        self.phase = "place"

    @property
    def current(self) -> int:
        if self.phase == "place":
            return self.turn_order[self.turn_pos % len(self.turn_order)]
        if self.phase == "bid":
            return self._bid_turn()
        return self.challenger  # type: ignore[return-value]

    def total_on_table(self) -> int:
        return sum(len(s) for s in self.stacks.values())

    # ------------------------------------------------------------------ 配置
    def place(self, user_id: int, kind: str) -> bool:
        if self.phase != "place" or user_id != self.current:
            return False
        if kind not in (FLOWER, BOMB) or self.owned[user_id][kind] <= 0:
            return False
        # 手持ちから出すのではなく「所有ディスクの中から伏せる」モデル:
        # 伏せた分は owned から差し引く（ラウンド終了時に戻る。喪失分は戻らない）
        self.owned[user_id][kind] -= 1
        self.stacks[user_id].append(kind)
        self.turn_pos += 1
        return True

    # ------------------------------------------------------------------ 競り
    def challenge(self, user_id: int, amount: int) -> bool:
        """配置の代わりに挑戦を宣言する（最低1枚は自分の山に必要）。"""
        if self.phase != "place" or user_id != self.current:
            return False
        if not self.stacks[user_id]:
            return False
        if not 1 <= amount <= self.total_on_table():
            return False
        self.phase = "bid"
        self.challenger = user_id
        self.bid_amount = amount
        self.bids = {user_id: amount}
        self.passed = set()
        self._bid_pos = self.turn_order.index(user_id)
        return True

    def _bid_turn(self) -> int:
        order = [uid for uid in self.turn_order if uid not in self.passed and uid != self.challenger]
        # challenger の次の人から時計回り
        alive_order = self.turn_order
        start = alive_order.index(self.challenger)  # type: ignore[arg-type]
        for step in range(1, len(alive_order) + 1):
            uid = alive_order[(start + step) % len(alive_order)]
            if uid not in self.passed and uid != self.challenger:
                return uid
        return self.challenger  # type: ignore[return-value]

    def raise_bid(self, user_id: int, amount: int) -> bool:
        if self.phase != "bid" or user_id != self._bid_turn():
            return False
        if not self.bid_amount < amount <= self.total_on_table():
            return False
        self.bid_amount = amount
        self.bids[user_id] = amount
        self.challenger = user_id
        if amount >= self.total_on_table():
            self.phase = "reveal"
        return True

    def pass_bid(self, user_id: int) -> bool:
        if self.phase != "bid" or user_id != self._bid_turn():
            return False
        self.passed.add(user_id)
        remaining = [uid for uid in self.turn_order if uid not in self.passed and uid != self.challenger]
        if not remaining:
            self.phase = "reveal"
        return True

    # ------------------------------------------------------------------ めくり
    def flip(self, user_id: int, target: int) -> dict:
        """宣言者が target の山の上を1枚めくる。自分の山から先にめくる規則。"""
        if self.phase != "reveal" or user_id != self.challenger:
            return {"ok": False}
        if self.stacks[user_id] and target != user_id:
            return {"ok": False, "reason": "まず自分の山からめくってください"}
        if target not in self.stacks or not self.stacks[target]:
            return {"ok": False}
        kind = self.stacks[target].pop()
        self.flipped.append((target, kind))
        if kind == BOMB:
            return self._fail(user_id)
        if len([1 for _, k in self.flipped if k == FLOWER]) >= self.bid_amount:
            return self._succeed(user_id)
        return {"ok": True, "kind": kind, "done": False}

    def _discard_random(self, user_id: int) -> str | None:
        """所有＋伏せ分＋めくり済み分を含めた全ディスクからランダムに1枚を永久喪失させる。"""
        pool = []
        for kind in (FLOWER, BOMB):
            pool += [kind] * self.owned[user_id][kind]
            pool += [kind] * self.stacks[user_id].count(kind)
            pool += [kind] * sum(1 for owner, k in self.flipped if owner == user_id and k == kind)
        if not pool:
            return None
        lost = self.rng.choice(pool)
        # めくり済み→伏せ分→手持ちの順に実物を引く
        flipped_idx = next((i for i, (owner, k) in enumerate(self.flipped)
                            if owner == user_id and k == lost), None)
        if flipped_idx is not None:
            del self.flipped[flipped_idx]
        elif lost in self.stacks[user_id]:
            self.stacks[user_id].remove(lost)
        else:
            self.owned[user_id][lost] -= 1
        return lost

    def _return_stacks(self) -> None:
        for uid, stack in self.stacks.items():
            for kind in stack:
                self.owned[uid][kind] += 1
            self.stacks[uid] = []
        # めくられたディスクも持ち主に戻る（喪失分は _discard_random で除去済み）
        for owner, kind in self.flipped:
            self.owned[owner][kind] += 1
        self.flipped = []

    def _fail(self, challenger: int) -> dict:
        lost = self._discard_random(challenger)
        self._return_stacks()
        total = sum(self.owned[challenger].values())
        self.last_loser = challenger
        if total <= 0:
            self.eliminated.add(challenger)
        alive = self._alive()
        if len(alive) == 1:
            self.phase = "done"
            self.winner = alive[0]
        else:
            # 次ラウンドは失敗者の次の生存者から（失敗者が残っていれば本人）
            nxt = challenger if challenger not in self.eliminated else alive[0]
            self._start_round(nxt)
        return {"ok": True, "kind": BOMB, "done": True, "success": False, "lost": lost}

    def _succeed(self, challenger: int) -> dict:
        self.wins[challenger] += 1
        self._return_stacks()
        if self.wins[challenger] >= 2:
            self.phase = "done"
            self.winner = challenger
        else:
            self._start_round(challenger)
        return {"ok": True, "kind": FLOWER, "done": True, "success": True}
