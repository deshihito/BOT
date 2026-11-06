# -*- coding: utf-8 -*-
"""「たとえナンバー」（ito 系の協力ゲーム）の純ロジックとテーマバンク。

ルール（AGO版・v1簡略化）:
- 各自が 1〜100 の数字を1枚だけ本人限定で受け取る。
- テーマに沿って数字の大きさを言葉で例え合い、話し合って小さいと思う人から
  「出す」ボタンでカードを出す。全員が昇順に出せたら成功。
- 原典の複数枚配布・ライフ制は v1 では入れず、1人1枚・テーマ3本の成績制にした
  （判断理由は実装ログ参照）。

テーマは全て自作。
"""
import random

THEMES = [
    "強い武器", "弱い武器", "人気のある食べ物", "人気のない食べ物", "高い建物", "小さい生き物",
    "大きい生き物", "速い乗り物", "遅い乗り物", "怖いもの", "かわいいもの", "重いもの",
    "軽いもの", "暑い場所", "寒い場所", "うるさい音", "静かな場所", "甘い食べ物", "辛い食べ物",
    "苦い食べ物", "すっぱい食べ物", "やわらかいもの", "かたいもの", "長いもの", "短いもの",
    "遠い場所", "近い場所", "明るいもの", "暗いもの", "新しいもの", "古いもの",
    "便利な道具", "役に立たない道具", "かっこいい職業", "大変な職業", "楽しい行事", "眠くなる場面",
    "うれしい言葉", "悲しい言葉", "強い動物", "弱い動物", "賢い行動", "危ない行動",
    "冷たい飲み物", "温かい飲み物", "丸いもの", "四角いもの", "鋭いもの", "なめらかなもの",
    "重そうな荷物", "高そうな宝石", "安そうな日用品", "人気のスポーツ", "過酷なスポーツ", "静かなスポーツ",
    "大きな音の楽器", "小さな音の楽器", "難しい勉強", "簡単な作業", "長い映画", "短い動画",
    "強い匂い", "弱い匂い", "滑りやすい場所", "歩きにくい道", "高い山", "深い海",
    "広い場所", "狭い場所", "賑やかな場所", "寂しい場所", "重い責任", "軽い約束",
    "速い動物", "遅い動物", "強いキャラクター", "弱いキャラクター", "人気の色", "渋い色",
    "熱い食べ物", "冷たい食べ物", "大きな買い物", "小さな買い物", "難しいゲーム", "簡単なゲーム",
    "強い風", "弱い風", "大きな波", "小さな波", "重い扉", "軽い扉",
    "長い髪", "短い髪", "高い声", "低い声", "強い光", "弱い光",
    "人気の観光地", "穴場の観光地", "重い本", "軽い本", "難しい言葉", "簡単な言葉",
    "強いチーム", "弱いチーム", "大きな家", "小さな家", "速い電車", "遅い電車",
]

ROUNDS_DEFAULT = 3


class ItoSession:
    """テーマごとに数字を配り直し、出された順の成否を判定する。"""

    def __init__(self, players: list[int], themes: list[str], rng: random.Random | None = None):
        if len(players) < 2:
            raise ValueError("2人以上必要です")
        self.players = list(players)
        self.themes = list(themes)
        self.rng = rng or random.Random()
        self.round_index = -1
        self.numbers: dict[int, int] = {}
        self.played: list[int] = []  # 出した順の user_id
        self.successes = 0

    @property
    def theme(self) -> str:
        return self.themes[self.round_index]

    @property
    def finished(self) -> bool:
        return self.round_index >= len(self.themes)

    @property
    def round_done(self) -> bool:
        return len(self.played) >= len(self.players)

    @property
    def round_success(self) -> bool:
        seq = [self.numbers[uid] for uid in self.played]
        return self.round_done and seq == sorted(seq)

    def next_round(self) -> str | None:
        self.round_index += 1
        self.played = []
        if self.finished:
            return None
        values = self.rng.sample(range(1, 101), len(self.players))
        self.numbers = dict(zip(self.players, values))
        return self.theme

    def play(self, user_id: int) -> bool:
        if self.finished or self.round_done:
            return False
        if user_id not in self.numbers or user_id in self.played:
            return False
        self.played.append(user_id)
        if self.round_done and self.round_success:
            self.successes += 1
        return True

    def revealed(self) -> list[tuple[int, int]]:
        """出された順に (user_id, 数字) を返す（公開情報）。"""
        return [(uid, self.numbers[uid]) for uid in self.played]
