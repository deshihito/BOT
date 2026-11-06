# -*- coding: utf-8 -*-
"""「潜入者」（Insider 系の正体隠匿・質問推理ゲーム）の純ロジックとお題バンク。

ルール（AGO版）:
- マスター1人だけがお題を知り、質問への「はい/いいえ/関係ない」に答える。
- 参加者のうち1人（潜入者）も密かにお題を知っていて、バレないよう誘導する。
- 誰かがお題を当てたら投票フェーズ: 潜入者だと思う人に投票し、
  当てれば市民の勝ち、外せば（同票も）潜入者の勝ち。
- 制限は時間ではなく「マスターの回答回数」制（Discord向け適応。既定40回）。
  回答を使い切ってもお題が出なければ潜入者の勝ち。

お題は全て自作バンク。
"""
import random
import unicodedata

TOPICS = [
    "りんご", "自転車", "飛行機", "図書館", "花火大会", "雪だるま", "ラーメン", "サッカー",
    "ピアノ", "猫", "温泉", "キャンプ", "結婚式", "誕生日", "卒業式", "運動会",
    "映画館", "遊園地", "水族館", "動物園", "博物館", "駅", "空港", "港",
    "山", "海", "川", "森", "砂漠", "島", "星", "月",
    "傘", "眼鏡", "時計", "鍵", "椅子", "ベッド", "冷蔵庫", "洗濯機",
    "医者", "先生", "警察官", "消防士", "料理人", "歌手", "画家", "農家",
    "桜", "紅葉", "雪", "雨", "虹", "雷", "風", "雲",
    "寿司", "カレー", "パン", "ケーキ", "アイスクリーム", "チョコレート", "コーヒー", "お茶",
    "野球", "テニス", "水泳", "スキー", "ボードゲーム", "将棋", "ギター", "ダンス",
    "東京タワー", "富士山", "桜島", "沖縄", "北海道", "京都", "大阪", "名古屋",
    "電車", "バス", "船", "ロケット", "気球", "エレベーター", "階段", "橋",
]

QUESTION_LIMIT = 40


def normalize(text: str) -> str:
    return unicodedata.normalize("NFKC", str(text or "")).replace(" ", "").replace("　", "").strip().lower()


class InsiderGame:
    def __init__(self, players: list[int], topic: str | None = None,
                 rng: random.Random | None = None, question_limit: int = QUESTION_LIMIT):
        if len(players) < 4:
            raise ValueError("4人以上必要です")
        self.players = list(players)
        rng = rng or random.Random()
        self.topic = topic or rng.choice(TOPICS)
        self.master, self.insider = rng.sample(self.players, 2)
        self.question_limit = question_limit
        self.answers_used = 0
        self.phase = "question"  # question -> vote -> done
        self.guesser: int | None = None
        self.votes: dict[int, int] = {}  # voter -> suspect
        self.result: str | None = None  # citizens / insider

    @property
    def citizens(self) -> list[int]:
        return [p for p in self.players if p != self.insider]

    def answer_question(self) -> bool:
        """マスターの回答1回を数える。制限に達したら潜入者の勝ちで終了。"""
        if self.phase != "question":
            return False
        self.answers_used += 1
        if self.answers_used >= self.question_limit:
            self.phase = "done"
            self.result = "insider"
        return True

    def guess_topic(self, user_id: int, text: str) -> bool:
        """お題当て。正解なら投票フェーズへ。"""
        if self.phase != "question" or user_id == self.master or user_id not in self.players:
            return False
        if normalize(text) == normalize(self.topic):
            self.guesser = user_id
            self.phase = "vote"
            return True
        return False

    def vote(self, user_id: int, suspect: int) -> bool:
        if self.phase != "vote" or user_id not in self.players or suspect not in self.players:
            return False
        if suspect == self.master:
            return False  # マスターは潜入者ではない（周知の事実）
        self.votes[user_id] = suspect
        return True

    @property
    def all_voted(self) -> bool:
        return len(self.votes) >= len(self.players)

    def settle(self) -> str:
        """投票を集計し勝敗を確定する。同票トップは潜入者の勝ち。"""
        if self.phase != "vote":
            return self.result or "insider"
        counts: dict[int, int] = {}
        for suspect in self.votes.values():
            counts[suspect] = counts.get(suspect, 0) + 1
        self.phase = "done"
        if not counts:
            self.result = "insider"
            return self.result
        top = max(counts.values())
        leaders = [uid for uid, c in counts.items() if c == top]
        self.result = "citizens" if leaders == [self.insider] else "insider"
        return self.result
