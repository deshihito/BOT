# -*- coding: utf-8 -*-
"""「よつば合わせ」（So Clover! 系の協力ワードゲーム）の純ロジックと単語バンク。

ルール（AGO版）:
- 各プレイヤーは単語カード1枚（単語4つが 上/右/下/左 に並んだもの）を受け取る。
- 隣り合う2語ずつ4ペア（右上/右下/左下/左上）について、共通ヒントを1語ずつ書く。
- 全員のカードを集めてシャッフルし、ダミーカード1枚を加える。
- ヒント盤ごとに、出題者以外の全員で「どのカードが・どの向きで」入るかを当てる。
- カードが合っていて向きも合っている単語の数がチームスコアになる。

単語バンクは全て自作（商業作品のキーワードは使わない）。
"""
import random

WORDS = [
    "りんご", "バナナ", "みかん", "ぶどう", "もも", "すいか", "メロン", "いちご", "レモン", "さくらんぼ",
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
    "温泉", "神社", "城", "橋", "塔", "島", "砂浜", "洞窟", "滝", "湖",
    "漫画", "小説", "新聞", "辞書", "日記", "地図", "切手", "絵はがき", "カレンダー", "ノート",
    "冷蔵庫", "洗濯機", "掃除機", "テレビ", "電話", "パソコン", "カメラ", "エアコン", "扇風機", "ストーブ",
    "薔薇", "向日葵", "桜の花", "チューリップ", "タンポポ", "朝顔", "菊", "梅", "竹", "松",
]

EDGES = ("上", "右", "下", "左")
PAIRS = ((0, 1), (1, 2), (2, 3), (3, 0))
PAIR_NAMES = ("右上", "右下", "左下", "左上")
ROTATION_LABELS = ("そのまま", "右へ90°", "180°", "左へ90°")


def placed_words(card_words: tuple, rotation: int) -> tuple:
    """カードを rotation（時計回りの90°単位）回して置いたときの、辺ごとの単語。

    元の向きで辺 j にあった単語は、辺 (j + rotation) % 4 に移る。
    """
    return tuple(card_words[(i - rotation) % 4] for i in range(4))


class YotsubaGame:
    """boards: {出題者uid: (単語×4)}。pool は (持ち主uid or None, 単語×4) の列。"""

    def __init__(self, players: list[int], boards: dict[int, tuple], dummy_words: tuple, rng=None):
        if len(players) < 3:
            raise ValueError("3人以上必要です")
        self.players = list(players)
        self.boards = {uid: tuple(boards[uid]) for uid in self.players}
        self.rng = rng if rng is not None else random
        self.hints: dict[int, list[str]] = {}
        pool = [(uid, self.boards[uid]) for uid in self.players] + [(None, tuple(dummy_words))]
        self.rng.shuffle(pool)
        self.pool: list[tuple[int | None, tuple]] = pool
        self.used: set[int] = set()                    # 配置済みの pool 添字
        self.placements: dict[int, tuple[int, int]] = {}  # 出題者uid -> (pool添字, 回転)
        self.solve_order = list(self.players)
        self.rng.shuffle(self.solve_order)
        self.solve_index = 0

    # ------------------------------------------------------------------ ヒント
    def submit_hints(self, user_id: int, hints: list[str]) -> bool:
        if user_id not in self.boards or user_id in self.hints:
            return False
        cleaned = [str(h or "").strip() for h in hints]
        if len(cleaned) != 4 or any(not h for h in cleaned):
            return False
        if any(any(ch.isspace() for ch in h) for h in cleaned):
            return False
        self.hints[user_id] = cleaned
        return True

    def all_hints_in(self) -> bool:
        return len(self.hints) == len(self.players)

    # ------------------------------------------------------------------ 配置
    @property
    def current_board_owner(self) -> int | None:
        if self.solve_index >= len(self.solve_order):
            return None
        return self.solve_order[self.solve_index]

    @property
    def finished(self) -> bool:
        return self.current_board_owner is None

    def available_cards(self) -> list[int]:
        return [i for i in range(len(self.pool)) if i not in self.used]

    def place(self, solver_id: int, card_index: int, rotation: int) -> dict | None:
        """現在のヒント盤にカードを配置する。出題者本人は配置できない。"""
        owner = self.current_board_owner
        if owner is None or solver_id == owner or solver_id not in self.players:
            return None
        if card_index not in self.available_cards() or rotation not in (0, 1, 2, 3):
            return None
        self.used.add(card_index)
        self.placements[owner] = (card_index, rotation)
        result = self.score_board(owner)
        self.solve_index += 1
        return {"owner": owner, "card_index": card_index, "rotation": rotation,
                "score": result, "card_owner": self.pool[card_index][0]}

    def skip_board(self) -> None:
        """時間切れ等で現在の盤を配置なしで終える。"""
        if self.current_board_owner is not None:
            self.solve_index += 1

    # ------------------------------------------------------------------ 採点
    def score_board(self, owner: int) -> int:
        """その盤の得点（正しい位置に来た単語の数 0〜4）。"""
        if owner not in self.placements:
            return 0
        card_index, rotation = self.placements[owner]
        card_owner, card_words = self.pool[card_index]
        if card_owner != owner:
            return 0
        placed = placed_words(card_words, rotation)
        return sum(1 for i in range(4) if placed[i] == self.boards[owner][i])

    @property
    def total_score(self) -> int:
        return sum(self.score_board(uid) for uid in self.players)

    @property
    def max_score(self) -> int:
        return 4 * len(self.players)
