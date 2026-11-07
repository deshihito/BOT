# -*- coding: utf-8 -*-
"""マジョリティ連想ゲームのお題バンクと集計ロジック（Discord 非依存）。

お題に対して全員が答えを出し、同じ答えを書いた人数が多いほど得点。
表記ゆれの吸収は v1 では「前後の空白を取り、英字を小文字にそろえる」
まで（曖昧なマッチはしない）。得点は同じ答えの人数（自分を含む）で、
1人だけの答えは 0 点。
"""
import unicodedata

TOPICS = [
    "赤い食べ物といえば？",
    "コンビニで買う飲み物といえば？",
    "動物園で一番人気の動物といえば？",
    "冬に食べたい鍋の具材といえば？",
    "学校の教科といえば？",
    "丸いものといえば？",
    "日本の都道府県といえば？",
    "誕生日ケーキに乗っているものといえば？",
    "雨の日に必要なものといえば？",
    "楽器といえば？",
    "スポーツといえば？",
    "黄色い果物といえば？",
    "朝ごはんの定番といえば？",
    "海の生き物といえば？",
    "四季の中で一番人気の季節は？",
    "カレーの辛さの好みは？",
    "文房具といえば？",
    "乗り物といえば？",
    "花といえば？",
    "甘いお菓子といえば？",
    "休みの日にすることといえば？",
    "色といえば？",
    "犬の名前で多そうなのは？",
    "魔法で使ってみたい能力といえば？",
    "寿司のネタといえば？",
]


def normalize_answer(text: str) -> str:
    """表記ゆれの正規化（NFKC＋前後空白除去＋小文字化）。"""
    return unicodedata.normalize("NFKC", str(text)).strip().lower()


class MajoritySession:
    def __init__(self, topics: list):
        self.topics = list(topics)
        self.players: dict = {}   # user_id -> {"score": int}
        self.index = -1
        self.answers: dict = {}   # user_id -> 表示用の元の答え
        self.finished = False

    def add_player(self, user_id) -> bool:
        if user_id in self.players:
            return False
        self.players[user_id] = {"score": 0}
        return True

    @property
    def current_topic(self):
        if 0 <= self.index < len(self.topics):
            return self.topics[self.index]
        return None

    def next_round(self):
        self.index += 1
        self.answers = {}
        if self.index >= len(self.topics):
            self.finished = True
            return None
        return self.current_topic

    def submit(self, user_id, answer: str) -> bool:
        if self.finished or self.current_topic is None:
            return False
        if not normalize_answer(answer):
            return False
        if user_id in self.answers:
            return False
        self.add_player(user_id)
        self.answers[user_id] = str(answer)
        return True

    def all_answered(self) -> bool:
        return bool(self.players) and all(uid in self.answers for uid in self.players)

    def tally(self) -> dict:
        """集計して得点を加算する。{正規化答え: (人数, [user_id])} と {user_id: 獲得点} を含む辞書を返す。"""
        groups: dict = {}
        for uid, raw in self.answers.items():
            groups.setdefault(normalize_answer(raw), []).append(uid)
        gained = {}
        for uid in self.players:
            raw = self.answers.get(uid)
            if raw is None:
                gained[uid] = 0
                continue
            count = len(groups[normalize_answer(raw)])
            pts = count if count >= 2 else 0
            self.players[uid]["score"] += pts
            gained[uid] = pts
        return {"groups": groups, "gained": gained}

    def standings(self) -> list:
        rows = [(uid, e["score"]) for uid, e in self.players.items()]
        return sorted(rows, key=lambda r: (-r[1], r[0]))

    def winners(self) -> list:
        rows = self.standings()
        if not rows or rows[0][1] <= 0:
            return []
        top = rows[0][1]
        return [uid for uid, score in rows if score == top]
