# -*- coding: utf-8 -*-
"""クイズ大会の進行ロジック（Discord 非依存）。

スコア: 正解で 100 点 ＋ 速度ボーナス（制限時間の残り割合 × 50 を切り捨て）
＋ 連続正解ボーナス（連続正解数 × 10、上限 50）。不正解で連続はリセット。
途中参加は、次の問題からそのまま回答に参加できる。
"""

BASE_POINTS = 100
SPEED_BONUS_MAX = 50
STREAK_BONUS_PER = 10
STREAK_BONUS_MAX = 50


def points_for(is_correct: bool, remaining_ratio: float, streak_after: int) -> int:
    if not is_correct:
        return 0
    speed = int(max(0.0, min(1.0, remaining_ratio)) * SPEED_BONUS_MAX)
    streak_bonus = min(STREAK_BONUS_MAX, max(0, streak_after - 1) * STREAK_BONUS_PER)
    return BASE_POINTS + speed + streak_bonus


class QuizSession:
    def __init__(self, questions: list):
        self.questions = list(questions)
        self.players: dict = {}   # user_id -> {"score": int, "streak": int, "correct": int, "answered": int}
        self.index = -1           # 現在の問題番号（-1 は未開始）
        self.answers: dict = {}   # user_id -> (choice, remaining_ratio)
        self.finished = False

    # ------------------------------------------------------------------ 参加
    def add_player(self, user_id) -> bool:
        if user_id in self.players:
            return False
        self.players[user_id] = {"score": 0, "streak": 0, "correct": 0, "answered": 0}
        return True

    # ------------------------------------------------------------------ 進行
    @property
    def current(self):
        if 0 <= self.index < len(self.questions):
            return self.questions[self.index]
        return None

    def next_question(self):
        self.index += 1
        self.answers = {}
        if self.index >= len(self.questions):
            self.finished = True
            return None
        return self.current

    def submit(self, user_id, choice: int, remaining_ratio: float) -> bool:
        """回答を受ける。途中参加もここで自動的に参加扱いになる。"""
        if self.finished or self.current is None:
            return False
        if user_id in self.answers:
            return False
        self.add_player(user_id)
        self.answers[user_id] = (int(choice), float(remaining_ratio))
        return True

    def all_answered(self) -> bool:
        return bool(self.players) and all(uid in self.answers for uid in self.players)

    def close_question(self) -> dict:
        """現在の問題を締め切り、得点を確定する。{user_id: 獲得点} を返す。"""
        q = self.current
        gained = {}
        if q is None:
            return gained
        for uid, entry in self.players.items():
            if uid not in self.answers:
                entry["streak"] = 0
                gained[uid] = 0
                continue
            choice, ratio = self.answers[uid]
            is_correct = choice == q["answer"]
            entry["answered"] += 1
            if is_correct:
                entry["streak"] += 1
                entry["correct"] += 1
            else:
                entry["streak"] = 0
            pts = points_for(is_correct, ratio, entry["streak"])
            entry["score"] += pts
            gained[uid] = pts
        return gained

    # ------------------------------------------------------------------ 結果
    def standings(self) -> list:
        """[(user_id, score, correct, answered), ...] をスコア順に返す。"""
        rows = [(uid, e["score"], e["correct"], e["answered"]) for uid, e in self.players.items()]
        return sorted(rows, key=lambda r: (-r[1], -r[2], r[0]))

    def winners(self) -> list:
        rows = self.standings()
        if not rows:
            return []
        top = rows[0][1]
        return [uid for uid, score, _c, _a in rows if score == top]
