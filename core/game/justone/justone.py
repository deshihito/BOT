# -*- coding: utf-8 -*-
"""「ひとことヒント」（Just One 系の協力ワードゲーム）の純ロジックとお題バンク。

ルール（AGO版）:
- 回答者1人以外がお題を見て、1単語だけのヒントを出す。
- 完全に一致したヒント（正規化後に同値）は回答者に見せる前に消える。
- 残ったヒントだけで回答者が当てれば成功。ラウンド数ぶん繰り返し成功数を競う。

お題・ヒントのデータは全て自作バンク（商業作品のお題は使わない）。
"""
import unicodedata

WORDS = [
    "りんご", "バナナ", "みかん", "ぶどう", "もも", "すいか", "メロン", "いちご", "レモン", "さくらんぼ",
    "ねこ", "いぬ", "うさぎ", "パンダ", "ペンギン", "ライオン", "ぞう", "きりん", "さる", "くま",
    "とり", "さかな", "かめ", "へび", "かえる", "ちょう", "とんぼ", "あり", "はち", "くも",
    "がっこう", "びょういん", "えき", "くうこう", "としょかん", "こうえん", "うみ", "やま", "かわ", "もり",
    "たいよう", "つき", "ほし", "ゆき", "あめ", "そら", "かぜ", "なみ", "ひかり", "かげ",
    "ピアノ", "ギター", "たいこ", "フルート", "バイオリン", "トランペット", "ハーモニカ", "タンバリン", "カスタネット", "木琴",
    "サッカー", "野球", "テニス", "水泳", "スキー", "ボクシング", "柔道", "剣道", "マラソン", "卓球",
    "カレー", "ラーメン", "すし", "ピザ", "ハンバーガー", "パンケーキ", "プリン", "アイス", "チョコ", "クッキー",
    "コーヒー", "お茶", "ジュース", "ミルク", "ワイン", "ビール", "水", "ソーダ", "スープ", "みそ汁",
    "傘", "時計", "眼鏡", "帽子", "靴", "鞄", "鍵", "本", "鉛筆", "消しゴム",
    "車", "電車", "飛行機", "船", "自転車", "バス", "バイク", "ロケット", "気球", "ヘリコプター",
    "春", "夏", "秋", "冬", "朝", "夜", "夢", "歌", "映画", "写真",
    "医者", "先生", "警察", "消防士", "料理人", "歌手", "画家", "農家", "漁師", "大工",
    "東京", "大阪", "京都", "北海道", "沖縄", "富士山", "桜", "紅葉", "雪だるま", "花火",
    "誕生日", "結婚", "卒業", "旅行", "祭り", "運動会", "試験", "仕事", "休日", "約束",
    "笑顔", "涙", "怒り", "驚き", "眠気", "空腹", "勇気", "優しさ", "秘密", "宝物",
]

ROUNDS_DEFAULT = 5


def normalize(text: str) -> str:
    """ヒント・回答の同一判定用正規化（NFKC＋空白除去＋小文字化）。"""
    return unicodedata.normalize("NFKC", str(text or "")).replace(" ", "").replace("　", "").strip().lower()


def eliminate_duplicates(hints: dict) -> tuple[dict, list]:
    """{user_id: ヒント} から、重複したヒントを消した残りと消えたヒント一覧を返す。

    重複判定は normalize 後の完全一致のみ（同義語は消えない）。
    """
    groups: dict[str, list] = {}
    for uid, hint in hints.items():
        groups.setdefault(normalize(hint), []).append(uid)
    kept = {uid: hint for uid, hint in hints.items() if len(groups[normalize(hint)]) == 1}
    removed = [hint for key, uids in groups.items() if len(uids) > 1
               for hint in [hints[uids[0]]]]
    return kept, removed


class JustOneSession:
    """1セッション（複数ラウンド）の進行状態。"""

    def __init__(self, players: list[int], words: list[str]):
        if len(players) < 3:
            raise ValueError("3人以上必要です")
        self.players = list(players)
        self.words = list(words)
        self.round_index = -1
        self.successes = 0
        self.hints: dict[int, str] = {}
        self.guess: str | None = None

    @property
    def guesser(self) -> int:
        return self.players[self.round_index % len(self.players)]

    @property
    def word(self) -> str:
        return self.words[self.round_index]

    @property
    def finished(self) -> bool:
        return self.round_index >= len(self.words)

    def next_round(self) -> str | None:
        self.round_index += 1
        self.hints = {}
        self.guess = None
        if self.finished:
            return None
        return self.word

    def submit_hint(self, user_id: int, hint: str) -> bool:
        if self.finished or user_id == self.guesser or user_id not in self.players:
            return False
        hint = str(hint or "").strip()
        if not hint or user_id in self.hints:
            return False
        # ヒントは1単語だけ（空白を含むものは受け付けない）
        if any(ch.isspace() for ch in hint):
            return False
        self.hints[user_id] = hint
        return True

    def all_hints_in(self) -> bool:
        return len(self.hints) >= len(self.players) - 1

    def kept_hints(self) -> tuple[dict, list]:
        return eliminate_duplicates(self.hints)

    def answer(self, text: str) -> bool:
        """回答者の回答を判定し、成功なら successes を増やす。"""
        self.guess = str(text or "")
        ok = normalize(self.guess) == normalize(self.word)
        if ok:
            self.successes += 1
        return ok
