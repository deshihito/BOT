# -*- coding: utf-8 -*-
"""「ライアーズダイス」（Perudo 系の伝統ダイスブラフゲーム）の純ロジック。

ルール（AGO版 v1・適応は実装ログ参照）:
- 各自ダイス5個を伏せて振る（自分の出目だけ ephemeral で確認）。
- 手番の人は「場全体で（値）の目が（個数）個ある」と宣言する。
  次の人は宣言を上げるか、「嘘だ！」で全ダイスを公開して判定する。
- 1の目はワイルド（宣言した値として数える。1そのものの宣言では1だけ数える）。
- 宣言が本当なら指摘者が、嘘なら宣言者がダイスを1個失う。失った人が次の親。
- ダイスを全て失うと脱落。最後に残った1人の勝ち。

伝統ゲーム（パブリックドメイン）なのでルール自体の権利問題はない。
"""
import random

DICE_START = 5


def count_matching(all_dice: list[int], face: int) -> int:
    """場の全ダイスのうち、宣言 face に該当する数（1は face!=1 のときワイルド）。"""
    if face == 1:
        return sum(1 for d in all_dice if d == 1)
    return sum(1 for d in all_dice if d == face or d == 1)


def is_legal_raise(prev: tuple[int, int] | None, new: tuple[int, int]) -> bool:
    """宣言 (個数, 値) が prev より強い正当な上げかどうか。

    - 初回宣言（prev=None）は値2〜6・個数1以上。
    - 値1以外同士: 個数を増やす、または個数同じで値を上げる。
    - 値1へ移る: 個数は ceil(前個数/2) 以上。
    - 値1から戻る: 個数は 前個数×2+1 以上で値2〜6。
    """
    count, face = new
    if count < 1 or face < 1 or face > 6:
        return False
    if prev is None:
        return face != 1
    pcount, pface = prev
    if pface == 1:
        if face == 1:
            return count > pcount
        return count >= pcount * 2 + 1
    if face == 1:
        return count >= (pcount + 1) // 2
    return count > pcount or (count == pcount and face > pface)


class LiarDiceGame:
    def __init__(self, players: list[int], rng=None):
        if len(players) < 2:
            raise ValueError("2人以上必要です")
        self.players = list(players)
        # ダイスの出目は勝敗に直結する抽選なので、既定は SystemRandom（dice cog の流儀）。
        self.rng = rng if rng is not None else random.SystemRandom()
        self.dice_count: dict[int, int] = {uid: DICE_START for uid in self.players}
        self.hands: dict[int, list[int]] = {}
        self.bid: tuple[int, int] | None = None
        self.bidder: int | None = None
        self.turn_index = 0
        self.round_starter: int | None = None
        self.winner: int | None = None
        self.last_result: dict | None = None
        self._roll_all()
        self.round_starter = self.players[0]

    # ------------------------------------------------------------------ 状態
    @property
    def alive(self) -> list[int]:
        return [uid for uid in self.players if self.dice_count[uid] > 0]

    @property
    def current(self) -> int:
        return self.players[self.turn_index % len(self.players)]

    @property
    def finished(self) -> bool:
        return self.winner is not None

    @property
    def total_dice(self) -> int:
        return sum(self.dice_count.values())

    def all_dice(self) -> list[int]:
        out: list[int] = []
        for uid in self.alive:
            out.extend(self.hands.get(uid, []))
        return out

    def _roll_all(self) -> None:
        self.hands = {uid: [self.rng.randint(1, 6) for _ in range(self.dice_count[uid])]
                      for uid in self.alive}

    def _set_turn_to(self, user_id: int) -> None:
        self.turn_index = self.players.index(user_id)

    def _advance_turn(self) -> None:
        for _ in range(len(self.players)):
            self.turn_index = (self.turn_index + 1) % len(self.players)
            if self.dice_count[self.current] > 0:
                return

    # ------------------------------------------------------------------ 行動
    def place_bid(self, user_id: int, count: int, face: int) -> bool:
        if self.finished or user_id != self.current:
            return False
        if self.bid is not None and self.bidder == user_id:
            return False
        if not is_legal_raise(self.bid, (count, face)):
            return False
        self.bid = (count, face)
        self.bidder = user_id
        self._advance_turn()
        return True

    def challenge(self, user_id: int) -> dict | None:
        """「嘘だ！」で判定する。ダイスを失った人を返し、次のラウンドを開始する。"""
        if self.finished or self.bid is None or user_id != self.current or self.bidder == user_id:
            return None
        count, face = self.bid
        actual = count_matching(self.all_dice(), face)
        bid_true = actual >= count
        loser = user_id if bid_true else self.bidder
        revealed = {uid: list(self.hands.get(uid, [])) for uid in self.alive}
        self.dice_count[loser] -= 1
        result = {"bid": self.bid, "bidder": self.bidder, "challenger": user_id,
                  "actual": actual, "bid_true": bid_true, "loser": loser,
                  "revealed": revealed, "eliminated": self.dice_count[loser] <= 0}
        self.last_result = result
        alive = self.alive
        if len(alive) == 1:
            self.winner = alive[0]
            return result
        self.bid = None
        self.bidder = None
        self._roll_all()
        # 次の親はダイスを失った人（脱落していたら次の生存者）
        self.round_starter = loser if self.dice_count[loser] > 0 else self._next_alive(loser)
        self._set_turn_to(self.round_starter)
        return result

    def _next_alive(self, user_id: int) -> int:
        i = self.players.index(user_id)
        for step in range(1, len(self.players) + 1):
            cand = self.players[(i + step) % len(self.players)]
            if self.dice_count[cand] > 0:
                return cand
        return user_id
