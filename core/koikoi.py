# -*- coding: utf-8 -*-
"""花札こいこい（2人・3局戦）の純粋ロジック。

札は月（1〜12）×4枚の48枚。種別は 光／種／短冊／カス で、役判定に使う
固有タグ（鶴・幕・月・雨・鳳凰・猪・蝶・鹿・盃など）を持つ。

役（主要役のみ）:
- 五光10 / 四光8（雨入りは7）/ 三光5（雨は含まない3枚）
- 猪鹿蝶5（種が1枚増えるごとに+1）
- 赤短5・青短5（短冊が1枚増えるごとに+1）
- 短冊5枚5（+1/枚）/ 種5枚5（+1/枚）/ カス10枚5（+1/枚）
- 月見5（月＋盃）/ 花見5（幕＋盃）
複数の役は合算する。

進行: 手札から1枚出す（同じ月の札が場にあれば取り、2枚あれば選ぶ、
3枚あれば全部取る）→ 山から1枚めくって同じ処理 → 役が増えていたら
「こいこい（続行）」か「勝負（確定）」を選ぶ。勝負で局終了。
得点の倍加: 相手がこいこいしていたら×2、勝者の役点が7点以上でも×2
（両方なら×4）。手札が尽きたら、役のある側（両方あれば高得点側）が
その点数で局を取り、両方なければ流局。3局の合計点で勝敗を決める。
場に同じ月が3枚配られた場合は配り直す。
"""
from __future__ import annotations

import random

# (月, 種別, 表示名, タグ) 種別: hikari/tane/tanzaku/kasu
_CARD_TABLE = [
    (1, "hikari", "松に鶴", "crane"), (1, "tanzaku", "松の赤短", "redtan"), (1, "kasu", "松のカス", None), (1, "kasu", "松のカス", None),
    (2, "tane", "梅に鶯", "bird"), (2, "tanzaku", "梅の赤短", "redtan"), (2, "kasu", "梅のカス", None), (2, "kasu", "梅のカス", None),
    (3, "hikari", "桜に幕", "curtain"), (3, "tanzaku", "桜の赤短", "redtan"), (3, "kasu", "桜のカス", None), (3, "kasu", "桜のカス", None),
    (4, "tane", "藤に郭公", None), (4, "tanzaku", "藤の短冊", None), (4, "kasu", "藤のカス", None), (4, "kasu", "藤のカス", None),
    (5, "tane", "菖蒲に八橋", None), (5, "tanzaku", "菖蒲の短冊", None), (5, "kasu", "菖蒲のカス", None), (5, "kasu", "菖蒲のカス", None),
    (6, "tane", "牡丹に蝶", "butterfly"), (6, "tanzaku", "牡丹の青短", "bluetan"), (6, "kasu", "牡丹のカス", None), (6, "kasu", "牡丹のカス", None),
    (7, "tane", "萩に猪", "boar"), (7, "tanzaku", "萩の短冊", None), (7, "kasu", "萩のカス", None), (7, "kasu", "萩のカス", None),
    (8, "hikari", "芒に月", "moon"), (8, "tane", "芒に雁", None), (8, "kasu", "芒のカス", None), (8, "kasu", "芒のカス", None),
    (9, "tane", "菊に盃", "sake"), (9, "tanzaku", "菊の青短", "bluetan"), (9, "kasu", "菊のカス", None), (9, "kasu", "菊のカス", None),
    (10, "tane", "紅葉に鹿", "deer"), (10, "tanzaku", "紅葉の青短", "bluetan"), (10, "kasu", "紅葉のカス", None), (10, "kasu", "紅葉のカス", None),
    (11, "hikari", "雨（小野道風）", "rain"), (11, "tane", "柳に燕", None), (11, "tanzaku", "柳の短冊", None), (11, "kasu", "柳のカス", None),
    (12, "hikari", "桐に鳳凰", "phoenix"), (12, "kasu", "桐のカス", None), (12, "kasu", "桐のカス", None), (12, "kasu", "桐のカス", None),
]
CARDS = {i: {"month": m, "kind": k, "name": n, "tag": t}
         for i, (m, k, n, t) in enumerate(_CARD_TABLE)}
MONTH_NAMES = {1: "松", 2: "梅", 3: "桜", 4: "藤", 5: "菖蒲", 6: "牡丹",
               7: "萩", 8: "芒", 9: "菊", 10: "紅葉", 11: "雨", 12: "桐"}
KIND_VALUES = {"hikari": 20, "tane": 10, "tanzaku": 5, "kasu": 1}
TOTAL_ROUNDS = 3


def card_label(card_id: int) -> str:
    c = CARDS[card_id]
    return f"{c['month']}月・{c['name']}"


def evaluate(cards) -> tuple:
    """取り札から (得点, 役名リスト) を計算する純関数。"""
    cards = list(cards)
    kinds = [CARDS[c]["kind"] for c in cards]
    tags = {CARDS[c]["tag"] for c in cards if CARDS[c]["tag"]}
    months_tan = {CARDS[c]["month"] for c in cards if CARDS[c]["kind"] == "tanzaku"}
    hikari = kinds.count("hikari")
    tane = kinds.count("tane")
    tanzaku = kinds.count("tanzaku")
    kasu = kinds.count("kasu")
    points = 0
    yaku = []
    if hikari == 5:
        points += 10
        yaku.append("五光")
    elif hikari == 4:
        if "rain" in tags:
            points += 7
            yaku.append("雨入り四光")
        else:
            points += 8
            yaku.append("四光")
    elif hikari == 3 and "rain" not in tags:
        points += 5
        yaku.append("三光")
    if {"boar", "butterfly", "deer"} <= tags:
        value = 5 + max(0, tane - 3)
        points += value
        yaku.append(f"猪鹿蝶（{value}点）")
    elif tane >= 5:
        value = 5 + (tane - 5)
        points += value
        yaku.append(f"種（{value}点）")
    if {1, 2, 3} <= months_tan and all(
            any(CARDS[c]["tag"] == "redtan" and CARDS[c]["month"] == m for c in cards) for m in (1, 2, 3)):
        value = 5 + max(0, tanzaku - 3)
        points += value
        yaku.append(f"赤短（{value}点）")
    if all(any(CARDS[c]["tag"] == "bluetan" and CARDS[c]["month"] == m for c in cards) for m in (6, 9, 10)):
        value = 5 + max(0, tanzaku - 3)
        points += value
        yaku.append(f"青短（{value}点）")
    if tanzaku >= 5:
        value = 5 + (tanzaku - 5)
        points += value
        yaku.append(f"短冊（{value}点）")
    if kasu >= 10:
        value = 5 + (kasu - 10)
        points += value
        yaku.append(f"カス（{value}点）")
    if "moon" in tags and "sake" in tags:
        points += 5
        yaku.append("月見")
    if "curtain" in tags and "sake" in tags:
        points += 5
        yaku.append("花見")
    return points, yaku


class KoikoiMatch:
    """3局戦の対局状態機械。cog から操作する。"""

    def __init__(self, player_ids, rng: random.Random = None):
        ids = list(player_ids)
        if len(ids) != 2:
            raise ValueError("こいこいは2人です")
        self.players = ids
        self.rng = rng or random.Random()
        self.scores = {pid: 0 for pid in ids}
        self.round_no = 0
        self.match_winner = None
        self.start_round()

    # ------------------------------------------------------------------
    def start_round(self) -> None:
        self.round_no += 1
        dealer = self.players[(self.round_no - 1) % 2]
        self.dealer = dealer
        while True:  # 場に同じ月が3枚なら配り直し
            deck = list(range(48))
            self.rng.shuffle(deck)
            self.hands = {self.players[0]: [], self.players[1]: []}
            for _ in range(8):
                for pid in self.players:
                    self.hands[pid].append(deck.pop())
            self.field = [deck.pop() for _ in range(8)]
            counts = {}
            for c in self.field:
                counts[CARDS[c]["month"]] = counts.get(CARDS[c]["month"], 0) + 1
            if max(counts.values()) < 3:
                self.deck = deck
                break
        self.captured = {pid: [] for pid in self.players}
        self.koikoi_counts = {pid: 0 for pid in self.players}
        self.checked_points = {pid: 0 for pid in self.players}
        self.current = dealer
        self.phase = "play"  # play -> choose_hand_capture -> draw -> choose_draw_capture -> decision
        self.pending = None  # 選択待ちの情報
        self.round_over = False
        self.round_result = None

    def opponent(self, player):
        return self.players[1] if player == self.players[0] else self.players[0]

    def _field_matches(self, card_id: int) -> list:
        month = CARDS[card_id]["month"]
        return [c for c in self.field if CARDS[c]["month"] == month]

    # ------------------------------------------------------------------ 手番の処理
    def play_hand(self, player, card_id: int) -> dict:
        """手札を1枚出す。取り札の選択が必要なら phase=choose_hand_capture。"""
        if self.phase != "play" or player != self.current:
            raise ValueError("今は出せません")
        if card_id not in self.hands[player]:
            raise ValueError("その札は手札にありません")
        self.hands[player].remove(card_id)
        matches = self._field_matches(card_id)
        event = {"played": card_id, "phase": self.phase}
        if len(matches) == 2:
            self.phase = "choose_hand_capture"
            self.pending = {"source": card_id, "candidates": matches, "after": "draw"}
            event["phase"] = self.phase
            return event
        self._resolve_placement(player, card_id, matches[0] if matches else None)
        return self._draw_step(player, event)

    def choose_capture(self, player, card_id: int) -> dict:
        """2枚から1枚取る選択を解決し、次の段階へ進める。"""
        if self.phase not in ("choose_hand_capture", "choose_draw_capture") or player != self.current:
            raise ValueError("今は選べません")
        if card_id not in self.pending["candidates"]:
            raise ValueError("その札は取れません")
        source = self.pending["source"]
        after = self.pending["after"]
        self.pending = None
        self._take(player, source, card_id)
        if after == "draw":
            return self._draw_step(player, {"played": source})
        return self._after_draw(player, {"played": source})

    def _resolve_placement(self, player, card_id: int, take_id) -> None:
        if take_id is None:
            self.field.append(card_id)
        else:
            self._take(player, card_id, take_id)

    def _take(self, player, card_a: int, card_b: int) -> None:
        """2枚（同月ペア）を取り札へ。場に同月が3枚ある場合は全部取る。"""
        month = CARDS[card_a]["month"]
        same = [c for c in self.field if CARDS[c]["month"] == month]
        self.captured[player].append(card_a)
        if len(same) >= 3:
            for c in same:
                self.field.remove(c)
                self.captured[player].append(c)
        else:
            self.field.remove(card_b)
            self.captured[player].append(card_b)

    def _draw_step(self, player, event: dict) -> dict:
        """山から1枚めくり、場と合わせる。"""
        self.phase = "draw"
        drawn = self.deck.pop()
        event["drawn"] = drawn
        matches = self._field_matches(drawn)
        if len(matches) == 2:
            self.phase = "choose_draw_capture"
            self.pending = {"source": drawn, "candidates": matches, "after": "decision"}
            event["phase"] = self.phase
            return event
        if matches:
            self._take(player, drawn, matches[0])
        else:
            self.field.append(drawn)
        return self._after_draw(player, event)

    def _after_draw(self, player, event: dict) -> dict:
        """役の増加チェック→（あれば）こいこい判断、無ければ手番交代か局終了。"""
        points, yaku = evaluate(self.captured[player])
        event["points"] = points
        event["yaku"] = yaku
        if points > self.checked_points[player] and points > 0:
            self.phase = "decision"
            self.pending = {"points": points, "yaku": yaku}
            event["phase"] = "decision"
            return event
        self._next_turn_or_finish(event)
        event["phase"] = self.phase
        return event

    def decide(self, player, koikoi: bool) -> dict:
        """こいこい/勝負の判断。勝負なら局終了し得点を確定する。"""
        if self.phase != "decision" or player != self.current:
            raise ValueError("今は判断できません")
        points = self.pending["points"]
        self.pending = None
        event = {"koikoi": koikoi, "points": points}
        if koikoi:
            self.koikoi_counts[player] += 1
            self.checked_points[player] = points
            self._advance(event)
        else:
            self._finish_round(winner=player, base_points=points, event=event)
        event["phase"] = self.phase
        return event

    # ------------------------------------------------------------------
    def _next_turn_or_finish(self, event: dict) -> None:
        if not self.hands[self.players[0]] and not self.hands[self.players[1]]:
            # 手札が尽きた: 役のある側（高得点側）が取る。両方無ければ流局
            p0, _ = evaluate(self.captured[self.players[0]])
            p1, _ = evaluate(self.captured[self.players[1]])
            if p0 == 0 and p1 == 0:
                self._finish_round(winner=None, base_points=0, event=event)
            elif p0 == p1:
                self._finish_round(winner=None, base_points=0, event=event)
            else:
                winner = self.players[0] if p0 > p1 else self.players[1]
                self._finish_round(winner=winner, base_points=max(p0, p1), event=event)
            return
        self._advance(event)

    def _advance(self, event: dict) -> None:
        self.current = self.opponent(self.current)
        self.phase = "play"
        event["next"] = self.current

    def _finish_round(self, winner, base_points: int, event: dict) -> None:
        self.round_over = True
        self.phase = "round_end"
        gained = 0
        multiplier = 1
        if winner is not None:
            loser = self.opponent(winner)
            if self.koikoi_counts[loser] >= 1:
                multiplier *= 2
            if base_points >= 7:
                multiplier *= 2
            gained = base_points * multiplier
            self.scores[winner] += gained
        self.round_result = {"winner": winner, "base_points": base_points,
                             "multiplier": multiplier, "gained": gained}
        event["round_result"] = self.round_result
        if self.round_no >= TOTAL_ROUNDS:
            s0, s1 = self.scores[self.players[0]], self.scores[self.players[1]]
            self.match_winner = None if s0 == s1 else (self.players[0] if s0 > s1 else self.players[1])
            self.phase = "match_end"
        else:
            self.phase = "round_end"


# ---------------------------------------------------------------------- CPU
def _capture_gain(state: KoikoiMatch, player, hand_card: int, take_id) -> float:
    """その手で取る場合の見込み値（取る札の価値＋役の伸び）。"""
    gained = [hand_card] + ([take_id] if take_id is not None else [])
    before, _ = evaluate(state.captured[player])
    after, _ = evaluate(state.captured[player] + gained)
    return sum(KIND_VALUES[CARDS[c]["kind"]] for c in gained) + (after - before) * 8


def cpu_choose_play(state: KoikoiMatch, player) -> int:
    """CPU の手札選択（決定的）。取れる手を優先し、無ければ最も価値の低い札を捨てる。"""
    hand = state.hands[player]
    best_card, best_gain = None, -1.0
    for card in hand:
        matches = state._field_matches(card)
        if matches:
            gain = max(_capture_gain(state, player, card, m) for m in matches)
            if gain > best_gain:
                best_card, best_gain = card, gain
    if best_card is not None:
        return best_card
    # 取れない: 場に同月が無いカス→短冊→種→光の順で価値の低いものから
    def discard_key(card):
        month_on_field = any(CARDS[c]["month"] == CARDS[card]["month"] for c in state.field)
        return (KIND_VALUES[CARDS[card]["kind"]], 0 if not month_on_field else 1, card)
    return min(hand, key=discard_key)


def cpu_choose_capture(state: KoikoiMatch, player, candidates) -> int:
    return max(candidates, key=lambda c: (KIND_VALUES[CARDS[c]["kind"]], c))


def cpu_decide(state: KoikoiMatch, player, points: int) -> bool:
    """こいこいするなら True。点が高い・残り手札が少ないときは勝負する。"""
    if points >= 6:
        return False
    remaining_turns = len(state.hands[player])
    if remaining_turns <= 1:
        return False
    return points <= 4
