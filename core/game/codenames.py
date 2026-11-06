# -*- coding: utf-8 -*-
"""コードネーム型チーム連想ゲームの純粋ロジックと単語バンク。

25 単語の盤面に、赤9・青8（先手チームが1枚多い）・中立7・暗殺者1 を割り付ける。
リーダーは「ヒント単語＋個数」を出し、味方はその数＋1 回まで単語を選べる。
自チームの単語を全部当てるか、相手チームが当て切ると勝利。暗殺者を選んだ
チームは即負け。単語バンクは一般名詞のみの自作リスト。
"""
from __future__ import annotations

import random

WORD_BANK = [
    "りんご", "みかん", "バナナ", "ぶどう", "もも", "すいか", "メロン", "レモン", "いちご", "さくらんぼ",
    "犬", "猫", "うさぎ", "馬", "牛", "豚", "鳥", "魚", "亀", "蛇",
    "象", "ライオン", "熊", "狐", "狸", "猿", "鹿", "狼", "蝶", "蜂",
    "海", "山", "川", "森", "島", "湖", "砂漠", "谷", "滝", "洞窟",
    "太陽", "月", "星", "雲", "雨", "雪", "雷", "虹", "風", "霧",
    "桜", "梅", "松", "竹", "菊", "紅葉", "薔薇", "向日葵", "朝顔", "たんぽぽ",
    "学校", "病院", "駅", "空港", "港", "城", "寺", "神社", "図書館", "美術館",
    "橋", "塔", "公園", "市場", "劇場", "ホテル", "レストラン", "パン屋", "温泉", "牧場",
    "電車", "バス", "飛行機", "船", "自転車", "バイク", "トラック", "タクシー", "ロケット", "気球",
    "傘", "眼鏡", "時計", "鍵", "椅子", "机", "ベッド", "鏡", "はさみ", "包丁",
    "本", "新聞", "手紙", "写真", "地図", "辞書", "ノート", "鉛筆", "消しゴム", "定規",
    "ギター", "ピアノ", "太鼓", "笛", "バイオリン", "トランペット", "鈴", "ハープ", "三味線", "琴",
    "剣", "盾", "槍", "弓", "冠", "指輪", "宝石", "金貨", "宝箱", "鍵穴",
    "王様", "女王", "騎士", "魔法使い", "勇者", "海賊", "忍者", "侍", "農民", "商人",
    "医師", "看護師", "先生", "警察官", "消防士", "大工", "漁師", "画家", "歌手", "選手",
    "春", "夏", "秋", "冬", "朝", "昼", "夜", "昨日", "今日", "明日",
    "水", "火", "土", "金", "木", "石", "鉄", "ガラス", "氷", "炎",
    "赤", "青", "黄", "緑", "紫", "黒", "白", "金色", "銀色", "桃色",
    "頭", "目", "耳", "鼻", "口", "手", "足", "心臓", "翼", "尻尾",
    "卵", "牛乳", "チーズ", "バター", "塩", "砂糖", "醤油", "味噌", "米", "麦",
    "寿司", "ラーメン", "カレー", "パン", "ケーキ", "クッキー", "飴", "餅", "蕎麦", "うどん",
    "東京", "大阪", "京都", "北海道", "沖縄", "富士山", "日本", "地球", "宇宙", "月面",
    "夢", "愛", "力", "光", "影", "声", "歌", "踊り", "涙", "笑顔",
    "時", "運命", "秘密", "約束", "希望", "勇気", "知恵", "真実", "嘘", "奇跡",
    "鐘", "太鼓橋", "旗", "船出", "収穫", "祭り", "花火", "雪だるま", "凧", "独楽",
]

TEAMS = ("red", "blue")
TEAM_LABEL = {"red": "🔴 赤チーム", "blue": "🔵 青チーム"}
BOARD_SIZE = 25


def other_team(team: str) -> str:
    return "blue" if team == "red" else "red"


class CodenamesGame:
    def __init__(self, first_team: str = "red", rng: random.Random = None):
        self.rng = rng or random.Random()
        self.words = self.rng.sample(WORD_BANK, BOARD_SIZE)
        second = other_team(first_team)
        key = [first_team] * 9 + [second] * 8 + ["neutral"] * 7 + ["assassin"]
        self.rng.shuffle(key)
        self.key = key                      # index -> 'red'|'blue'|'neutral'|'assassin'
        self.revealed = [False] * BOARD_SIZE
        self.turn = first_team              # ヒントを出すチーム
        self.phase = "hint"                 # 'hint' -> 'guess' -> 'hint' ... / 'done'
        self.guesses_left = 0
        self.winner = None
        self.loser_reason = ""

    # ------------------------------------------------------------------
    def remaining(self, team: str) -> int:
        return sum(1 for i, k in enumerate(self.key) if k == team and not self.revealed[i])

    def give_hint(self, team: str, word: str, count: int) -> None:
        if self.phase != "hint" or team != self.turn:
            raise ValueError("今はヒントを出せる状態ではありません")
        if not word or not word.strip():
            raise ValueError("ヒントの単語を入力してください")
        if any(word.strip() == w for w in self.words):
            raise ValueError("盤面にある単語そのものはヒントにできません")
        if count < 0 or count > 9:
            raise ValueError("個数は0〜9です")
        self.phase = "guess"
        self.guesses_left = count + 1  # ヒントの個数＋1回まで選べる
        self.last_hint = (word.strip(), count)

    def guess(self, team: str, index: int) -> dict:
        """単語を選ぶ。結果 dict: kind（選んだマスの正体）, turn_end, winner。"""
        if self.phase != "guess" or team != self.turn:
            raise ValueError("今は選べる状態ではありません")
        if not (0 <= index < BOARD_SIZE) or self.revealed[index]:
            raise ValueError("その単語は選べません")
        self.revealed[index] = True
        kind = self.key[index]
        event = {"index": index, "word": self.words[index], "kind": kind,
                 "turn_end": False, "winner": None}
        if kind == "assassin":
            self.winner = other_team(team)
            self.loser_reason = "assassin"
            self.phase = "done"
            event["winner"] = self.winner
            return event
        for t in TEAMS:
            if self.remaining(t) == 0:
                self.winner = t
                self.phase = "done"
                event["winner"] = t
                return event
        if kind == team:
            self.guesses_left -= 1
            if self.guesses_left <= 0:
                self._end_turn(event)
        else:
            self._end_turn(event)
        return event

    def pass_turn(self, team: str) -> None:
        if self.phase != "guess" or team != self.turn:
            raise ValueError("今はパスできません")
        self._end_turn({})

    def _end_turn(self, event: dict) -> None:
        self.turn = other_team(self.turn)
        self.phase = "hint"
        self.guesses_left = 0
        event["turn_end"] = True
