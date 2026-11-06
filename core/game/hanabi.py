# -*- coding: utf-8 -*-
"""「花火大会」（Hanabi 系の協力カードゲーム）の純ロジック。

- 5色×数字1〜5。枚数構成は 1×3, 2×2, 3×2, 4×2, 5×1（色ごとに10枚、計50枚）。
- 自分の手札は自分だけ見えない。各カードについて「ヒントで判明した色/数字」だけを
  knowledge として保持する（v1: 否定情報＝「この色ではない」等は保持しない簡略化。
  判断は実装ログに明記）。
- アクション: 出す / 捨てる（ヒント+1） / ヒント（対象者の全該当カードに色か数字を伝える、ヒント-1）。
- ミス3回で終了。山札が尽きたら全員あと1手ずつで終了。スコアは完成した花火の合計。
"""
import random

COLORS = ["赤", "青", "黄", "緑", "白"]
COLOR_EMOJI = {"赤": "🟥", "青": "🟦", "黄": "🟨", "緑": "🟩", "白": "⬜"}
COUNTS = {1: 3, 2: 2, 3: 2, 4: 2, 5: 1}
MAX_HINTS = 8
MAX_FUSE = 3


def build_deck(rng: random.Random) -> list[tuple[str, int]]:
    deck = [(color, num) for color in COLORS for num, cnt in COUNTS.items() for _ in range(cnt)]
    rng.shuffle(deck)
    return deck


def hand_size(player_count: int) -> int:
    return 5 if player_count <= 3 else 4


class HanabiGame:
    def __init__(self, players: list[int], rng: random.Random | None = None):
        if not 2 <= len(players) <= 5:
            raise ValueError("2〜5人必要です")
        self.players = list(players)
        rng = rng or random.Random()
        self.deck = build_deck(rng)
        size = hand_size(len(players))
        self.hands: dict[int, list[tuple[str, int]]] = {
            uid: [self.deck.pop() for _ in range(size)] for uid in self.players
        }
        # knowledge[uid][i] = {"color": 色 or None, "number": 数字 or None}
        self.knowledge: dict[int, list[dict]] = {
            uid: [{"color": None, "number": None} for _ in self.hands[uid]] for uid in self.players
        }
        self.piles: dict[str, int] = {color: 0 for color in COLORS}
        self.discards: list[tuple[str, int]] = []
        self.hints = MAX_HINTS
        self.fuse = MAX_FUSE
        self.turn = 0
        self.final_turns_left: int | None = None
        self.finished = False
        self.fail_reason: str | None = None

    @property
    def current(self) -> int:
        return self.players[self.turn % len(self.players)]

    @property
    def score(self) -> int:
        return sum(self.piles.values())

    def _after_action(self, actor: int) -> None:
        if self.fuse <= 0:
            self.finished = True
            self.fail_reason = "導火線が尽きました（ミス3回）"
            return
        if self.score >= 25:
            self.finished = True
            return
        # 山札から補充
        if self.deck:
            card = self.deck.pop()
            self.hands[actor].append(card)
            self.knowledge[actor].append({"color": None, "number": None})
            if not self.deck and self.final_turns_left is None:
                self.final_turns_left = len(self.players)
        elif self.final_turns_left is not None:
            self.final_turns_left -= 1
            if self.final_turns_left <= 0:
                self.finished = True
                return
        self.turn += 1

    def _take(self, user_id: int, index: int) -> tuple[str, int]:
        card = self.hands[user_id].pop(index)
        self.knowledge[user_id].pop(index)
        return card

    def play(self, user_id: int, index: int) -> dict:
        if self.finished or user_id != self.current:
            return {"ok": False}
        if not 0 <= index < len(self.hands[user_id]):
            return {"ok": False}
        card = self._take(user_id, index)
        color, num = card
        success = num == self.piles[color] + 1
        if success:
            self.piles[color] = num
            if num == 5 and self.hints < MAX_HINTS:
                self.hints += 1
        else:
            self.discards.append(card)
            self.fuse -= 1
        self._after_action(user_id)
        return {"ok": True, "card": card, "success": success}

    def discard(self, user_id: int, index: int) -> dict:
        if self.finished or user_id != self.current:
            return {"ok": False}
        if not 0 <= index < len(self.hands[user_id]):
            return {"ok": False}
        if self.hints >= MAX_HINTS:
            return {"ok": False, "reason": "ヒントが満タンのときは捨てられません"}
        card = self._take(user_id, index)
        self.discards.append(card)
        self.hints += 1
        self._after_action(user_id)
        return {"ok": True, "card": card}

    def hint(self, giver: int, target: int, kind: str, value) -> dict:
        """kind は "color" / "number"。対象者の該当カード全てに情報を付ける。"""
        if self.finished or giver != self.current or target == giver or target not in self.hands:
            return {"ok": False}
        if self.hints <= 0:
            return {"ok": False, "reason": "ヒントがありません"}
        matched = []
        for i, (color, num) in enumerate(self.hands[target]):
            if (kind == "color" and color == value) or (kind == "number" and num == value):
                matched.append(i)
                self.knowledge[target][i][kind] = value
        if not matched:
            return {"ok": False, "reason": "該当するカードがありません"}
        self.hints -= 1
        self._after_action(giver)
        return {"ok": True, "matched": matched, "count": len(matched)}
