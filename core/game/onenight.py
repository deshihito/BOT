# -*- coding: utf-8 -*-
"""ワンナイト人狼のロジック（Discord 非依存）。

3〜6人・夜は1回だけの短縮版人狼。プレイヤー人数＋2枚のカードを使い、
余った2枚は中央に置かれる。役職は 狼×2・占い・怪盗・村人（残り）。

夜の行動（解決順は 占い → 怪盗。占いは交換前の役職を見る）:
- 狼: 仲間の狼が分かる（1人だけなら中央のカード1枚を見られる）
- 占い: プレイヤー1人の役職を見るか、中央の2枚を見る
- 怪盗: プレイヤー1人と自分のカードを交換し、交換後の自分の役職を確認する

勝敗は「最終的なカード」で判定する。処刑は最多票（同票は全員処刑）。
プレイヤーの中に狼が1人もいない場合は「平和な夜」として村人陣営の勝ち。
"""
import random

WOLF = "人狼"
SEER = "占い師"
ROBBER = "怪盗"
VILLAGER = "村人"

ROLE_INFO = {
    WOLF: "人狼陣営。仲間の人狼が分かります。正体がばれずに誰か村人側が処刑されれば勝ちです。",
    SEER: "村人陣営。プレイヤー1人の役職か、中央のカード2枚を見られます。",
    ROBBER: "村人陣営。プレイヤー1人と自分のカードを交換します。勝敗は交換後の役職で決まります。",
    VILLAGER: "村人陣営。特別な能力はありません。話し合いで人狼を見つけましょう。",
}

MIN_PLAYERS = 3
MAX_PLAYERS = 6


def build_deck(player_count: int, rng: random.Random) -> list:
    if not MIN_PLAYERS <= player_count <= MAX_PLAYERS:
        raise ValueError("player_count out of range")
    deck = [WOLF, WOLF, SEER, ROBBER] + [VILLAGER] * (player_count + 2 - 4)
    rng.shuffle(deck)
    return deck


class OneNightSession:
    def __init__(self, player_ids, *, rng: random.Random = None):
        rng = rng or random.Random()
        self.players = list(player_ids)
        deck = build_deck(len(self.players), rng)
        self.initial = {uid: deck[i] for i, uid in enumerate(self.players)}
        self.center = deck[len(self.players):]
        self.final = dict(self.initial)
        self.seer_views = {}     # 占いのぞいた結果のメモ（表示用）
        self.robber_target = None
        self.robber_done = False
        self.votes = {}          # voter_id -> target_id

    # ------------------------------------------------------------------ 夜
    def wolf_partners(self, user_id) -> list:
        return [uid for uid in self.players if uid != user_id and self.initial[uid] == WOLF]

    def seer_view_player(self, user_id, target_id) -> str:
        role = self.initial[target_id]
        self.seer_views[user_id] = ("player", target_id, role)
        return role

    def seer_view_center(self, user_id) -> list:
        self.seer_views[user_id] = ("center", None, list(self.center))
        return list(self.center)

    def set_robber_target(self, user_id, target_id) -> None:
        if self.initial.get(user_id) == ROBBER:
            self.robber_target = target_id

    def resolve_night(self) -> None:
        """怪盗の交換を適用する（占いの結果は交換前のまま）。"""
        if self.robber_done:
            return
        self.robber_done = True
        robber = next((uid for uid in self.players if self.initial[uid] == ROBBER), None)
        if robber is not None and self.robber_target is not None:
            target = self.robber_target
            self.final[robber], self.final[target] = self.final[target], self.final[robber]

    def robber_new_role(self, user_id):
        return self.final.get(user_id)

    # ------------------------------------------------------------------ 投票と勝敗
    def vote(self, user_id, target_id) -> bool:
        if user_id not in self.players or target_id not in self.players:
            return False
        if user_id in self.votes:
            return False
        self.votes[user_id] = target_id
        return True

    def executed(self) -> list:
        if not self.votes:
            return []
        counts = {}
        for target in self.votes.values():
            counts[target] = counts.get(target, 0) + 1
        top = max(counts.values())
        if top <= 1 and len(self.votes) < len(self.players):
            pass  # 票が割れていても最多票は処刑される（1票でも全員が投票すれば処刑）
        return [uid for uid, n in counts.items() if n == top]

    def result(self) -> dict:
        """{"executed": [...], "village_win": bool, "winners": [user_id], "peaceful": bool}"""
        executed = self.executed()
        wolves = [uid for uid in self.players if self.final[uid] == WOLF]
        peaceful = not wolves
        if peaceful:
            village_win = True
        else:
            village_win = any(uid in wolves for uid in executed)
        if village_win:
            winners = [uid for uid in self.players if self.final[uid] != WOLF]
        else:
            winners = list(wolves)
        return {"executed": executed, "village_win": village_win, "winners": winners, "peaceful": peaceful}
