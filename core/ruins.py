# -*- coding: utf-8 -*-
"""「アゴ遺跡の秘宝」（Incan Gold / Diamant 系チキンレース）の純ロジック。

構成は原典準拠を目安にした自作デッキ:
- 宝石カード15枚: 1,2,3,4,5,5,7,7,9,11,11,13,14,15,17（合計124）
- 危険カード5種×3枚=15枚: 落石/毒蛇/大蜘蛛/炎/ミイラ（テーマは汎用の遺跡表現）
- 秘宝（アーティファクト）: ラウンドごとに1枚だけデッキに入る（値 5,5,8,10,12）

進行:
- カードを1枚めくる。宝石なら中にいる全員で等分し、端数は道に残る。
- 危険は同種2枚目でバースト: 中にいる全員、そのラウンドの所持宝石を全て失い、
  その危険カードはゲームから除かれる。
- 秘宝は道に置かれる。各ステップの公開後に全員が「進む/帰る」を同時選択:
  帰る人は所持宝石を確定し、道の端数を帰る人で等分。1人だけ帰った場合は
  道の秘宝も全て獲得する。
- 5ラウンド行い、確定宝石の合計が多い人の勝ち。
"""
import random

TREASURES = [1, 2, 3, 4, 5, 5, 7, 7, 9, 11, 11, 13, 14, 15, 17]
HAZARDS = ["落石", "毒蛇", "大蜘蛛", "炎", "ミイラ"]
HAZARD_COPIES = 3
ARTIFACT_VALUES = [5, 5, 8, 10, 12]
TOTAL_ROUNDS = 5


def build_deck(round_index: int, rng: random.Random) -> list[tuple]:
    """カードは ("treasure", 値) / ("hazard", 種類) / ("artifact", 値)。"""
    deck: list[tuple] = [("treasure", v) for v in TREASURES]
    deck += [("hazard", h) for h in HAZARDS for _ in range(HAZARD_COPIES)]
    deck.append(("artifact", ARTIFACT_VALUES[round_index]))
    rng.shuffle(deck)
    return deck


class RuinsGame:
    def __init__(self, players: list[int], rng: random.Random | None = None):
        if len(players) < 3:
            raise ValueError("3人以上必要です")
        self.players = list(players)
        self.rng = rng or random.Random()
        self.banked: dict[int, int] = {uid: 0 for uid in players}
        self.removed_hazards: set[str] = set()
        self.round_index = -1
        self.deck: list[tuple] = []
        self.in_ruin: set[int] = set()
        self.carrying: dict[int, int] = {}
        self.path_gems = 0                    # 道に残った端数
        self.path_artifacts: list[int] = []    # 道にある秘宝の値
        self.seen_hazards: dict[str, int] = {}
        self.path: list[tuple] = []            # これまで公開されたカード
        self.decisions: dict[int, bool] = {}   # uid -> 進む(True)/帰る(False)
        self.phase = "done"                    # reveal直後=decide / round_end / done
        self.last_event: dict | None = None

    @property
    def game_finished(self) -> bool:
        return self.round_index >= TOTAL_ROUNDS

    def start_round(self) -> None:
        self.round_index += 1
        if self.game_finished:
            self.phase = "done"
            return
        self.deck = build_deck(self.round_index, self.rng)
        # バーストで除かれた危険は次ラウンド以降も1枚欠けた状態にする
        for hazard in self.removed_hazards:
            for i, card in enumerate(self.deck):
                if card == ("hazard", hazard):
                    del self.deck[i]
                    break
        self.in_ruin = set(self.players)
        self.carrying = {uid: 0 for uid in self.players}
        self.path_gems = 0
        self.path_artifacts = []
        self.seen_hazards = {}
        self.path = []
        self.phase = "decide"

    def reveal(self) -> dict:
        """次のカードを公開しイベントを返す。呼び出し前に全員帰還していないこと。"""
        if not self.deck:
            return self._end_round("山札が尽きました")
        card = self.deck.pop()
        self.path.append(card)
        kind, value = card
        if kind == "treasure":
            share, rest = divmod(value, len(self.in_ruin))
            for uid in self.in_ruin:
                self.carrying[uid] += share
            self.path_gems += rest
            self.last_event = {"type": "treasure", "value": value, "share": share, "path_gems": self.path_gems}
        elif kind == "artifact":
            self.path_artifacts.append(value)
            self.last_event = {"type": "artifact", "value": value}
        else:
            self.seen_hazards[value] = self.seen_hazards.get(value, 0) + 1
            if self.seen_hazards[value] >= 2:
                lost = {uid: self.carrying[uid] for uid in self.in_ruin}
                for uid in self.in_ruin:
                    self.carrying[uid] = 0
                self.removed_hazards.add(value)
                event = self._end_round(f"危険「{value}」が2枚目！ バーストしました")
                event["lost"] = lost
                event["hazard"] = value
                self.last_event = event
                return event
            self.last_event = {"type": "hazard", "value": value, "count": 1}
        self.decisions = {}
        self.phase = "decide"
        return self.last_event

    def decide(self, user_id: int, go_further: bool) -> bool:
        if self.phase != "decide" or user_id not in self.in_ruin:
            return False
        self.decisions[user_id] = bool(go_further)
        return True

    @property
    def all_decided(self) -> bool:
        return all(uid in self.decisions for uid in self.in_ruin)

    def resolve_decisions(self, default_go: bool = False) -> dict:
        """未決定者は default_go（既定: 帰る=False）として同時選択を解決する。"""
        leavers = []
        for uid in sorted(self.in_ruin):
            if not self.decisions.get(uid, default_go):
                leavers.append(uid)
        gained: dict[int, int] = {}
        if leavers:
            share, rest = divmod(self.path_gems, len(leavers))
            for uid in leavers:
                total = self.carrying[uid] + share
                if len(leavers) == 1 and self.path_artifacts:
                    total += sum(self.path_artifacts)
                    gained_artifacts = list(self.path_artifacts)
                    self.path_artifacts = []
                else:
                    gained_artifacts = []
                self.banked[uid] += total
                gained[uid] = total
                if gained_artifacts:
                    gained[f"artifact:{uid}"] = gained_artifacts  # type: ignore[assignment]
                self.carrying[uid] = 0
                self.in_ruin.discard(uid)
            self.path_gems = rest
        self.decisions = {}
        if not self.in_ruin:
            return self._end_round("全員が帰還しました")
        self.phase = "decide"
        return {"type": "continue", "leavers": leavers, "gained": gained, "path_gems": self.path_gems}

    def _end_round(self, reason: str) -> dict:
        # 中に残っていた人の所持宝石は確定しない（バースト/全員帰還/山札切れ共通）
        for uid in self.in_ruin:
            self.carrying[uid] = 0
        self.in_ruin = set()
        self.phase = "round_end"
        return {"type": "round_end", "reason": reason, "round": self.round_index + 1}

    def winners(self) -> list[int]:
        best = max(self.banked.values())
        return [uid for uid, v in self.banked.items() if v == best]
