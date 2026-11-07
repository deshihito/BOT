# -*- coding: utf-8 -*-
"""「暗号バトル」（Decrypto 系のチーム対抗ワードゲーム）の純ロジックと単語バンク。

ルール（AGO版）:
- 2チーム対抗。各チームは自分たちだけが知る4つの合言葉（番号1〜4）を持つ。
- 毎ラウンド、暗号担当が3つの数字のコード（1〜4から重複なし）を引き、
  各数字の合言葉を連想させるヒントを3つ出す。
- 相手チームはヒントの履歴からコードの傍受を試みる（初ラウンドは傍受なし）。
- 自チームの解読失敗が2回、または相手に2回傍受されると負け。
- 8ラウンドで決着しない場合は「傍受トークン−失敗トークン」の多い方の勝ち。

合言葉バンクは全て自作（商業作品の単語は使わない）。
"""
import itertools
import random

WORDS = [
    "りんご", "バナナ", "みかん", "ぶどう", "もも", "すいか", "メロン", "いちご", "レモン", "パイナップル",
    "ねこ", "いぬ", "うさぎ", "パンダ", "ペンギン", "ライオン", "ぞう", "きりん", "さる", "くま",
    "とり", "さかな", "かめ", "へび", "かえる", "ちょう", "とんぼ", "あり", "はち", "いるか",
    "がっこう", "びょういん", "えき", "くうこう", "としょかん", "こうえん", "うみ", "やま", "かわ", "もり",
    "たいよう", "つき", "ほし", "ゆき", "あめ", "そら", "かぜ", "なみ", "ひかり", "ゆめ",
    "ピアノ", "ギター", "たいこ", "フルート", "バイオリン", "トランペット", "ハーモニカ", "タンバリン", "オルガン", "木琴",
    "サッカー", "野球", "テニス", "水泳", "スキー", "ボクシング", "柔道", "剣道", "マラソン", "卓球",
    "カレー", "ラーメン", "すし", "ピザ", "ハンバーガー", "パンケーキ", "プリン", "アイス", "チョコ", "クッキー",
    "コーヒー", "お茶", "ジュース", "ミルク", "ワイン", "ビール", "スープ", "みそ汁", "サラダ", "オムライス",
    "傘", "時計", "眼鏡", "帽子", "靴", "鞄", "鍵", "本", "鉛筆", "消しゴム",
    "車", "電車", "飛行機", "船", "自転車", "バス", "バイク", "ロケット", "気球", "ヘリコプター",
    "春", "夏", "秋", "冬", "朝", "夜", "歌", "映画", "写真", "手紙",
    "医者", "先生", "警察", "消防士", "料理人", "歌手", "画家", "農家", "漁師", "大工",
    "東京", "大阪", "京都", "北海道", "沖縄", "富士山", "桜", "紅葉", "雪だるま", "花火",
    "誕生日", "結婚", "卒業", "旅行", "祭り", "運動会", "試験", "仕事", "休日", "約束",
    "笑顔", "涙", "怒り", "驚き", "眠気", "空腹", "勇気", "優しさ", "秘密", "宝物",
]

MAX_ROUNDS = 8
LOSE_TOKENS = 2

ALL_CODES = list(itertools.permutations((1, 2, 3, 4), 3))


def code_label(code) -> str:
    return "-".join(str(d) for d in code)


class CipherGame:
    """2チーム対抗の暗号戦。teams は [チーム0のuid列, チーム1のuid列]。"""

    def __init__(self, teams: list[list[int]], keywords: dict[int, list[str]], rng=None):
        if len(teams) != 2 or any(len(t) < 2 for t in teams):
            raise ValueError("2チーム・各2名以上が必要です")
        self.teams = [list(t) for t in teams]
        self.keywords = {i: list(keywords[i]) for i in (0, 1)}
        self.rng = rng if rng is not None else random
        self.round_index = -1
        self.codes: dict[int, tuple] = {}
        self.hints: dict[int, list[str]] = {}
        self.intercepts: dict[int, tuple] = {}
        self.decodes: dict[int, tuple] = {}
        self.intercept_tokens = [0, 0]   # そのチームが「奪った」傍受トークン
        self.miscom_tokens = [0, 0]      # そのチームの解読失敗トークン
        self.history: dict[int, list[dict]] = {0: [], 1: []}
        self.winner: int | None = None   # 勝ちチーム番号。引き分けは -1
        self.phase = "hints"             # hints -> guesses -> resolved -> (次へ or done)

    # ------------------------------------------------------------------ 基本
    def team_of(self, user_id: int) -> int | None:
        for i, team in enumerate(self.teams):
            if user_id in team:
                return i
        return None

    @property
    def finished(self) -> bool:
        return self.winner is not None

    def encryptor(self, team: int) -> int:
        return self.teams[team][self.round_index % len(self.teams[team])]

    def start_round(self) -> bool:
        """次のラウンドを開始する。開始できなければ False（ゲーム終了済み）。"""
        if self.finished:
            return False
        self.round_index += 1
        if self.round_index >= MAX_ROUNDS:
            self._finish_by_score()
            return False
        self.codes = {t: tuple(self.rng.sample([1, 2, 3, 4], 3)) for t in (0, 1)}
        self.hints = {}
        self.intercepts = {}
        self.decodes = {}
        self.phase = "hints"
        return True

    # ------------------------------------------------------------------ 提出
    def submit_hints(self, team: int, user_id: int, hints: list[str]) -> bool:
        if self.phase != "hints" or team in self.hints:
            return False
        if user_id != self.encryptor(team):
            return False
        cleaned = [str(h or "").strip() for h in hints]
        if len(cleaned) != 3 or any(not h for h in cleaned):
            return False
        self.hints[team] = cleaned
        if len(self.hints) == 2:
            self.phase = "guesses"
        return True

    def all_hints_in(self) -> bool:
        return len(self.hints) == 2

    def submit_intercept(self, team: int, user_id: int, code) -> bool:
        """team が相手チームのコードを傍受として提出する（初ラウンドは不可）。"""
        if self.phase != "guesses" or self.round_index <= 0:
            return False
        if self.team_of(user_id) != team or team in self.intercepts:
            return False
        code = tuple(int(d) for d in code)
        if code not in ALL_CODES:
            return False
        self.intercepts[team] = code
        return True

    def submit_decode(self, team: int, user_id: int, code) -> bool:
        if self.phase != "guesses":
            return False
        if self.team_of(user_id) != team or team in self.decodes:
            return False
        code = tuple(int(d) for d in code)
        if code not in ALL_CODES:
            return False
        self.decodes[team] = code
        return True

    def guesses_complete(self) -> bool:
        if len(self.decodes) < 2:
            return False
        if self.round_index > 0 and len(self.intercepts) < 2:
            return False
        return True

    # ------------------------------------------------------------------ 解決
    def resolve_round(self) -> dict:
        """このラウンドを解決し、結果の内訳を返す（未提出は失敗扱い）。"""
        if self.phase != "guesses":
            return {}
        events = {}
        for team in (0, 1):
            opp = 1 - team
            intercepted = self.round_index > 0 and self.intercepts.get(opp) == self.codes[team]
            if intercepted:
                self.intercept_tokens[opp] += 1
            decoded = self.decodes.get(team) == self.codes[team]
            if not decoded:
                self.miscom_tokens[team] += 1
            self.history[team].append({
                "code": self.codes[team],
                "hints": list(self.hints.get(team, [])),
                "intercepted": intercepted,
                "decoded": decoded,
            })
            events[team] = {"intercepted": intercepted, "decoded": decoded}
        self.phase = "resolved"
        self._check_end()
        return events

    def _team_lost(self, team: int) -> bool:
        return self.miscom_tokens[team] >= LOSE_TOKENS or self.intercept_tokens[1 - team] >= LOSE_TOKENS

    def _check_end(self) -> None:
        lost = [self._team_lost(t) for t in (0, 1)]
        if lost[0] and lost[1]:
            self.winner = -1
        elif lost[0]:
            self.winner = 1
        elif lost[1]:
            self.winner = 0
        elif self.round_index >= MAX_ROUNDS - 1:
            self._finish_by_score()

    def _finish_by_score(self) -> None:
        scores = [self.intercept_tokens[t] - self.miscom_tokens[t] for t in (0, 1)]
        if scores[0] == scores[1]:
            self.winner = -1
        else:
            self.winner = 0 if scores[0] > scores[1] else 1
        self.phase = "done"

    # ------------------------------------------------------------------ 表示補助
    def hints_by_slot(self, team: int) -> dict[int, list[str]]:
        """公開済みヒントを合言葉の番号ごとに蓄積して返す（推理材料の表示用）。"""
        slots: dict[int, list[str]] = {1: [], 2: [], 3: [], 4: []}
        for entry in self.history[team]:
            for digit, hint in zip(entry["code"], entry["hints"]):
                slots[digit].append(hint)
        return slots
