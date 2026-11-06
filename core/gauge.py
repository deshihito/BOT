# -*- coding: utf-8 -*-
"""「価値観ゲージ」（Wavelength 系）の純ロジックと軸ペアバンク。

ルール（AGO版）:
- 軸は 0〜10 の11目盛りに離散化する（レポートの指摘どおり、連続スライダーは
  ボタン式の離散目盛りに置換。設計判断は実装ログに明記）。
- サイキック（出題者）がターゲットの中心位置を本人限定で見て、軸に沿った
  ヒントを1つ出す。味方チームは目盛りボタンで位置を予想する。
- 得点: 中心一致=4点 / ±1=3点 / ±2=2点 / それ以外=0点。
- 相手チームは「正解は予想より左寄りか右寄りか」を当てると+1点
  （予想が中心一致のときは相手に得点機会なし）。
- チーム交互にサイキックを回し、先に目標点数に届いたチームの勝ち
  （同ラウンドで両方届いたら高得点側、それも同点なら引き分け）。

軸ペアは全て自作。
"""
import random

AXES = [
    ("冷たい", "熱い"), ("まずい", "おいしい"), ("安い", "高い"), ("小さい", "大きい"),
    ("軽い", "重い"), ("遅い", "速い"), ("静か", "うるさい"), ("暗い", "明るい"),
    ("弱い", "強い"), ("やさしい", "厳しい"), ("単純", "複雑"), ("古い", "新しい"),
    ("地味", "派手"), ("地味な能力", "派手な能力"), ("マイナー", "メジャー"), ("マニアック", "大衆的"),
    ("短い", "長い"), ("狭い", "広い"), ("浅い", "深い"), ("低い", "高い"),
    ("柔らかい", "硬い"), ("甘い", "辛い"), ("爽やか", "濃厚"), ("素朴", "豪華"),
    ("地味な服", "目立つ服"), ("穏やか", "激しい"), ("慎重", "大胆"), ("真面目", "ふざけている"),
    ("日常的", "非日常的"), ("現実的", "幻想的"), ("古典的", "未来的"), ("和風", "洋風"),
    ("子供向け", "大人向け"), ("初心者向け", "上級者向け"), ("家庭的", "プロ的"), ("手作り感", "工業的"),
    ("自然", "人工"), ("田舎", "都会"), ("過去", "未来"), ("朝型", "夜型"),
    ("インドア", "アウトドア"), ("一人用", "大人数用"), ("短時間", "長時間"), ("低カロリー", "高カロリー"),
    ("安眠できる", "眠れない"), ("忘れやすい", "忘れられない"), ("ありふれた", "珍しい"), ("地味な色", "鮮やかな色"),
    ("丸い", "尖っている"), ("滑らか", "ざらざら"), ("温かい人", "冷たい人"), ("話しやすい", "話しにくい"),
    ("読みやすい本", "読みにくい本"), ("覚えやすい名前", "覚えにくい名前"), ("地味な音", "派手な音"), ("弱い匂い", "強い匂い"),
    ("軽い話題", "重い話題"), ("安全", "危険"), ("地味な仕事", "華やかな仕事"), ("静かな場所", "賑やかな場所"),
]

SCALE = 10          # 目盛り 0..10
TARGET_SCORE = 10   # 勝利に必要な点数
MAX_ROUNDS = 12     # 決着がつかない場合の上限（その時点で高得点側の勝ち）


def points_for(center: int, guess: int) -> int:
    d = abs(center - guess)
    return {0: 4, 1: 3, 2: 2}.get(d, 0)


class GaugeGame:
    def __init__(self, team_a: list[int], team_b: list[int], rng: random.Random | None = None):
        if len(team_a) < 1 or len(team_b) < 1 or len(team_a) + len(team_b) < 4:
            raise ValueError("4人以上・両チーム1人以上必要です")
        self.teams = {"A": list(team_a), "B": list(team_b)}
        self.rng = rng or random.Random()
        self.scores = {"A": 0, "B": 0}
        self.round_index = -1
        self.axis: tuple[str, str] | None = None
        self.center: int | None = None
        self.hint: str | None = None
        self.guess: int | None = None
        self.finished = False
        self.winner: str | None = None  # "A" / "B" / "draw"

    @property
    def turn_team(self) -> str:
        return "A" if self.round_index % 2 == 0 else "B"

    @property
    def other_team(self) -> str:
        return "B" if self.turn_team == "A" else "A"

    @property
    def psychic(self) -> int:
        members = self.teams[self.turn_team]
        return members[(self.round_index // 2) % len(members)]

    def team_of(self, user_id: int) -> str | None:
        for name, members in self.teams.items():
            if user_id in members:
                return name
        return None

    def next_round(self) -> bool:
        if self.finished:
            return False
        self.round_index += 1
        if self.round_index >= MAX_ROUNDS:
            self._finish_by_score()
            return False
        self.axis = self.rng.choice(AXES)
        self.center = self.rng.randint(2, SCALE - 2)
        self.hint = None
        self.guess = None
        return True

    def set_hint(self, user_id: int, text: str) -> bool:
        if self.finished or user_id != self.psychic or not str(text or "").strip():
            return False
        self.hint = str(text).strip()
        return True

    def set_guess(self, position: int) -> bool:
        if self.finished or self.hint is None or self.guess is not None:
            return False
        if not 0 <= position <= SCALE:
            return False
        self.guess = position
        return True

    def settle(self, counter: str | None) -> dict:
        """counter は相手チームの予想 "left"（中心は予想より左）/"right"/None。"""
        if self.guess is None or self.center is None:
            raise ValueError("予想がまだ決まっていません")
        gained = points_for(self.center, self.guess)
        self.scores[self.turn_team] += gained
        counter_point = 0
        if gained < 4 and counter in ("left", "right"):
            actual = "left" if self.center < self.guess else "right" if self.center > self.guess else None
            if actual is not None and counter == actual:
                counter_point = 1
                self.scores[self.other_team] += 1
        result = {"points": gained, "counter_point": counter_point,
                  "center": self.center, "guess": self.guess}
        a, b = self.scores["A"], self.scores["B"]
        if a >= TARGET_SCORE or b >= TARGET_SCORE:
            self._finish_by_score()
        return result

    def _finish_by_score(self) -> None:
        self.finished = True
        a, b = self.scores["A"], self.scores["B"]
        self.winner = "A" if a > b else "B" if b > a else "draw"
