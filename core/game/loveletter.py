# -*- coding: utf-8 -*-
"""ラブレター型カードゲーム（AGO オリジナル名称）の純粋ロジック。

アゴ姫へ手紙を届ける宮廷が舞台。カードは全て AGO オリジナルの名前で、
構成（16枚）と効果の型だけを古典的な小箱ゲームに倣う。

- 1 門番（×5）: 相手の手札を当てる。当たれば相手は脱落
- 2 密偵（×2）: 相手の手札を見る
- 3 騎士（×2）: 相手と手札を見せ合い、数字の小さい方が脱落
- 4 侍女（×2）: 次の自分の番まで、他人のカードの対象にならない
- 5 道化（×2）: 指名した相手（自分も可）の手札を捨てさせ、1枚引かせる
- 6 王子（×2）: 指名した相手と手札を交換する
- 7 女伯爵（×1）: 道化か王子を手札に持っている間は必ず出さなければならない
- 8 アゴ姫（×1）: 捨てたら脱落

ラウンド制で、先に規定数の「届いた手紙」（トークン）を集めた人が勝ち。
規定数は人数で変わる（2人: 3、3人: 2、4人: 2）。最大6ラウンドで打ち切り、
その場合はトークン数→最終ラウンド勝者の順で決める。
"""
from __future__ import annotations

import random

CARD_INFO = {
    1: ("門番", 5, "相手の手札（門番以外）を当てると相手が脱落"),
    2: ("密偵", 2, "相手の手札を見る"),
    3: ("騎士", 2, "相手と手札を見せ合い、小さい方が脱落"),
    4: ("侍女", 2, "次の自分の番まで対象にならない"),
    5: ("道化", 2, "相手（自分可）の手札を捨てさせ、1枚引かせる"),
    6: ("王子", 1, "相手と手札を交換する"),
    7: ("女伯爵", 1, "道化か王子を持っている間は必ず出す"),
    8: ("アゴ姫", 1, "捨てたら脱落"),
}
TARGET_TOKENS = {2: 3, 3: 2, 4: 2}
MAX_ROUNDS = 6
NEEDS_TARGET = {1, 2, 3, 5, 6}  # 5 は自分も対象にできる
SELF_TARGET_OK = {5}


def card_name(rank: int) -> str:
    return CARD_INFO[rank][0]


def build_deck(rng: random.Random) -> list:
    deck = [rank for rank, (_, count, _) in CARD_INFO.items() for _ in range(count)]
    rng.shuffle(deck)
    return deck


class LoveLetterGame:
    def __init__(self, player_ids, rng: random.Random = None):
        ids = list(player_ids)
        if not (2 <= len(ids) <= 4):
            raise ValueError("2〜4人です")
        self.players = ids
        self.rng = rng or random.Random()
        self.tokens = {pid: 0 for pid in ids}
        self.round_no = 0
        self.game_winner = None
        self.last_round_winners = []
        self.start_round(first=True)

    # ------------------------------------------------------------------ ラウンド準備
    def start_round(self, first: bool = False) -> None:
        self.round_no += 1
        deck = build_deck(self.rng)
        self.burn = deck.pop()  # 表向きにしない伏せ札
        self.removed = []
        if len(self.players) == 2:
            self.removed = [deck.pop() for _ in range(3)]  # 2人時は追加で3枚を公開除外
        self.deck = deck
        self.hands = {pid: self.deck.pop() for pid in self.players}
        self.discards = {pid: [] for pid in self.players}
        self.alive = list(self.players)
        self.protected = set()
        if first or not self.last_round_winners:
            starter = self.players[0]
        else:
            starter = self.last_round_winners[0]
        self.turn_index = self.players.index(starter)
        self.round_over = False
        self.round_winners = []
        self.drawn = None  # 現在の手番で引いたカード（手札は hands + drawn で持つ）

    @property
    def current(self):
        if self.round_over:
            return None
        return self.players[self.turn_index % len(self.players)]

    def current_cards(self, player=None) -> list:
        """現在の手番プレイヤーの手札（引いた札を含む2枚 or 1枚）。"""
        player = player or self.current
        cards = [self.hands[player]]
        if self.drawn is not None and player == self.current:
            cards.append(self.drawn)
        return cards

    def begin_turn(self):
        """手番開始: 自分の守りが解け、山札から1枚引く。"""
        player = self.current
        self.protected.discard(player)
        if self.deck:
            self.drawn = self.deck.pop()
        else:
            self.drawn = None
        return player

    def legal_cards(self) -> list:
        """現在の手番プレイヤーが出せるカード（女伯爵の縛り適用済み）。"""
        cards = self.current_cards()
        if 7 in cards and (5 in cards or 6 in cards):
            return [7]
        return list(cards)

    def valid_targets(self, rank: int) -> list:
        """指名できる相手（生存・守られていない）。自分を含められる札は自分も。"""
        if rank not in NEEDS_TARGET:
            return []
        me = self.current
        targets = [pid for pid in self.alive if pid != me and pid not in self.protected]
        if rank in SELF_TARGET_OK:
            targets.append(me)
        return targets

    # ------------------------------------------------------------------ プレイ解決
    def play(self, rank: int, target=None, guess=None) -> dict:
        """カードを1枚出す。イベント dict を返す。

        event の主なキー: actor / rank / target / eliminated（脱落者リスト）/
        peek（{プレイヤー: 見えた札}、表示先の制御は cog 側）/ note（補足キー）
        """
        if self.round_over:
            raise ValueError("ラウンドは終了しています")
        actor = self.current
        if rank not in self.legal_cards():
            raise ValueError("そのカードは出せません")
        # 状態を変える前に、対象と推測の妥当性を検証する
        targets = self.valid_targets(rank)
        if rank in NEEDS_TARGET:
            if targets:
                if target is None:
                    raise ValueError("対象を選んでください")
                if target not in targets:
                    raise ValueError("その相手は対象にできません")
                if rank == 1 and (guess is None or guess == 1):
                    raise ValueError("当てるカード（門番以外）を選んでください")
            else:
                target = None  # 全員が守られていて効果なし
        cards = self.current_cards()
        cards.remove(rank)
        kept = cards[0] if cards else None
        self.drawn = None
        if kept is None:  # あり得ないが安全側
            kept = rank
            rank = self.hands[actor]
        self.hands[actor] = kept
        self.discards[actor].append(rank)
        event = {"actor": actor, "rank": rank, "target": target,
                 "eliminated": [], "peek": {}, "note": ""}
        if rank in NEEDS_TARGET and not targets:
            event["note"] = "no_target"

        if target is not None:
            if rank == 1:
                event["guessed"] = guess
                if self.hands[target] == guess:
                    self._eliminate(target, event)
            elif rank == 2:
                event["peek"][actor] = self.hands[target]
            elif rank == 3:
                event["peek"][actor] = self.hands[target]
                event["peek"][target] = self.hands[actor]
                mine, theirs = self.hands[actor], self.hands[target]
                if mine < theirs:
                    self._eliminate(actor, event)
                elif theirs < mine:
                    self._eliminate(target, event)
            elif rank == 5:
                dropped = self.hands[target]
                self.discards[target].append(dropped)
                event["dropped"] = dropped
                if dropped == 8:
                    self._eliminate(target, event, already_discarded=True)
                elif self.deck:
                    self.hands[target] = self.deck.pop()
                else:
                    self.hands[target] = self.burn  # 山札切れ時は伏せ札から
            elif rank == 6:
                self.hands[actor], self.hands[target] = self.hands[target], self.hands[actor]

        if rank == 4:
            self.protected.add(actor)

        self._after_play(event)
        return event

    def _eliminate(self, player, event: dict, already_discarded: bool = False) -> None:
        if player not in self.alive:
            return
        if not already_discarded:
            self.discards[player].append(self.hands[player])
        self.alive.remove(player)
        self.protected.discard(player)
        event["eliminated"].append(player)

    def _after_play(self, event: dict) -> None:
        if len(self.alive) == 1:
            self._finish_round([self.alive[0]], event)
            return
        if not self.deck:
            # 山札切れ: 手札の数字→捨て札合計で比べる
            best = max(self.hands[pid] for pid in self.alive)
            cands = [pid for pid in self.alive if self.hands[pid] == best]
            if len(cands) > 1:
                sums = {pid: sum(self.discards[pid]) for pid in cands}
                top = max(sums.values())
                cands = [pid for pid in cands if sums[pid] == top]
            self._finish_round(cands, event)
            return
        # 次の生存者へ
        idx = self.players.index(event["actor"])
        for step in range(1, len(self.players) + 1):
            nxt = self.players[(idx + step) % len(self.players)]
            if nxt in self.alive:
                self.turn_index = self.players.index(nxt)
                break

    def _finish_round(self, winners: list, event: dict) -> None:
        self.round_over = True
        self.round_winners = list(winners)
        self.last_round_winners = list(winners)
        for pid in winners:
            self.tokens[pid] += 1
        event["round_winners"] = list(winners)
        target = TARGET_TOKENS[len(self.players)]
        reached = [pid for pid in self.players if self.tokens[pid] >= target]
        if reached:
            self.game_winner = max(reached, key=lambda pid: self.tokens[pid])
        elif self.round_no >= MAX_ROUNDS:
            best = max(self.tokens.values())
            cands = [pid for pid in self.players if self.tokens[pid] == best]
            self.game_winner = cands[0] if len(cands) == 1 else self.last_round_winners[0]
