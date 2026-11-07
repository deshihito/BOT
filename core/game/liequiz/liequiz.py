# -*- coding: utf-8 -*-
"""「うそ答えクイズ」（Fibbage 系）の純ロジックと問題バンク。

- お題（本当の答えのあるトリビア）に各自が嘘の答えを書く。
- 本物＋全員の嘘をシャッフルして提示し、全員が「本物だと思うもの」に投票。
- 得点: 本物を選ぶと +2点、自分の嘘が1人に選ばれるごとに +1点。
- 嘘が本物と一致した場合は提出を認めない（書き直し扱い）。

問題・答えは一般知識ベースの自作バンク。
"""
import random
import unicodedata

QUESTIONS = [
    ("日本で一番高い山は富士山ですが、二番目に高い山は？", "北岳"),
    ("パンダの主食として有名な植物は？", "竹"),
    ("東京スカイツリーの高さは何メートル？", "634"),
    ("人間の体で一番大きな臓器は？", "皮膚"),
    ("寿司のシャリを漢字で書くと？", "舎利"),
    ("将棋の駒で、成ると「と」になる駒は？", "歩"),
    ("日本最古の貨幣とされる硬貨の名前は？", "和同開珎"),
    ("月までの距離はおよそ何万キロメートル？", "38万キロ"),
    ("カレーの辛さを示す単位として知られるのは？", "スコヴィル"),
    ("世界で一番大きな砂漠は？", "南極大陸"),
    ("ピアノの鍵盤は全部で何鍵？", "88"),
    ("トランプのジョーカーを除いた枚数は？", "52"),
    ("日本の都道府県で一番面積が小さいのは？", "香川県"),
    ("金魚の祖先とされる魚は？", "フナ"),
    ("富士山が最後に噴火したのは何年？", "1707年"),
    ("英語で「ありがとう」を表す“thank”の語源となった言葉の意味は？", "考える"),
    ("蜂が一度に運べる花の蜜は、体の重さのおよそ何倍まで？", "半分ほど"),
    ("オリンピックの五輪の色に含まれない色は？", "紫"),
    ("日本で初めて地下鉄が開通した都市は？", "東京"),
    ("サッカーボールの面の数は全部でいくつ？", "32"),
    ("人間の味覚で、舌の先端が特に感じやすいとされた味は？", "甘味"),
    ("カタツムリの歯はおよそ何本あると言われる？", "1万本以上"),
    ("世界一深い湖の名前は？", "バイカル湖"),
    ("漢字の「鬱」は全部で何画？", "29画"),
    ("日本最長の川は？", "信濃川"),
    ("飛行機のブラックボックスの実際の色は？", "オレンジ色"),
    ("チョコレートの原料であるカカオの原産地は？", "中南米"),
    ("月に初めて降り立った宇宙飛行士は？", "ニール・アームストロング"),
    ("パリのエッフェル塔は夏と冬で高さが変わる。その差はおよそ何センチ？", "15センチ"),
    ("タコの心臓はいくつある？", "3つ"),
    ("世界で一番売れた小説シリーズとされるのは？", "ハリー・ポッター"),
    ("寿司ネタの「玉子」は何の卵？", "鶏の卵"),
    ("日本の硬貨で、真ん中に穴が開いているのは五円玉と何円玉？", "五十円玉"),
    ("バイオリンの弦は全部で何本？", "4本"),
    ("太陽の表面温度はおよそ何度？", "6000度"),
    ("カメレオンが色を変える主な理由は？", "体温調節と感情表現"),
    ("世界一小さい鳥の名前は？", "マメハチドリ"),
    ("囲碁の碁盤は縦横何路？", "19路"),
    ("日本で一番古い木造建築とされる建物は？", "法隆寺の五重塔"),
    ("マグロの英語名は？", "ツナ"),
    ("人間の指紋は一人ひとり違うが、同じだとされる動物の鼻の紋がある。その動物は？", "犬"),
    ("富士山の山頂にある施設は郵便局と何？", "神社"),
    ("世界の海で一番面積が大きいのは？", "太平洋"),
    ("アルファベットで一番使用頻度が高い文字は？", "E"),
    ("将棋で最初に動かせる駒の手数は何通り？", "30通り"),
    ("日本の国歌「君が代」の歌詞が載っている最古の歌集は？", "古今和歌集"),
    ("カレーライスが日本に伝わったのはどこの国の料理経由？", "イギリス"),
    ("ペンギンが住んでいない大陸は？", "北アメリカ大陸"),
    ("エレベーターが落ちたとき一番安全とされる姿勢は？", "床に寝そべる"),
    ("世界一長い万里の長城の長さはおよそ何キロ？", "2万キロ以上"),
    ("日本で一番降水量が多いとされる地域の県は？", "屋久島のある鹿児島県"),
    ("ハチミツが腐りにくい主な理由は？", "水分が少なく糖度が高いから"),
    ("オリンピックのマラソンの距離はおよそ何キロ？", "42キロ"),
    ("トランプのキングに髭がないのは何のキング？", "ハートのキング"),
    ("月は地球から毎年およそ何センチ離れている？", "3.8センチ"),
    ("日本最古の温泉とされる3つの温泉「日本三古湯」の一つ、兵庫県にある温泉は？", "有馬温泉"),
    ("サメの骨はほとんど何でできている？", "軟骨"),
    ("世界一高いビル「ブルジュ・ハリファ」の高さはおよそ何メートル？", "828メートル"),
    ("カレーの「ナン」は何語で「パン」という意味？", "ペルシア語"),
    ("人間の体で一番硬い部分は？", "歯のエナメル質"),
    ("日本の信号機の「進め」の色は緑ではなく何色と法律で定められている？", "青色"),
    ("コアラが起きている時間は1日およそ何時間？", "4時間ほど"),
    ("最初のビデオゲームとされる「スペースウォー!」が作られたのは何年？", "1962年"),
    ("富士山の高さ3,776メートルは、覚え方で「ミナナロウ」と読むが、実際の標高に最も近い言い換えは？", "3,775.51メートル"),
]

ROUNDS_DEFAULT = 5
POINTS_TRUTH = 2
POINTS_FOOL = 1


def normalize(text: str) -> str:
    return unicodedata.normalize("NFKC", str(text or "")).replace(" ", "").replace("　", "").strip().lower()


class LieQuizSession:
    def __init__(self, players: list[int], questions: list[tuple[str, str]],
                 rng: random.Random | None = None):
        if len(players) < 3:
            raise ValueError("3人以上必要です")
        self.players = list(players)
        self.questions = list(questions)
        self.rng = rng or random.Random()
        self.round_index = -1
        self.scores: dict[int, int] = {uid: 0 for uid in players}
        self.lies: dict[int, str] = {}
        self.choices: list[dict] = []  # {"text":..., "author": uid or None}
        self.votes: dict[int, int] = {}  # voter -> choice index

    @property
    def current_q(self) -> tuple[str, str]:
        return self.questions[self.round_index]

    @property
    def finished(self) -> bool:
        return self.round_index >= len(self.questions)

    def next_round(self) -> str | None:
        self.round_index += 1
        self.lies = {}
        self.choices = []
        self.votes = {}
        if self.finished:
            return None
        return self.current_q[0]

    def submit_lie(self, user_id: int, text: str) -> str:
        """戻り値: ok / is_truth（本物と一致）/ duplicate（他人の嘘と一致）/ invalid"""
        if self.finished or user_id not in self.players:
            return "invalid"
        text = str(text or "").strip()
        if not text or user_id in self.lies:
            return "invalid"
        if normalize(text) == normalize(self.current_q[1]):
            return "is_truth"
        if any(normalize(t) == normalize(text) for t in self.lies.values()):
            return "duplicate"
        self.lies[user_id] = text
        return "ok"

    def build_choices(self) -> list[dict]:
        self.choices = [{"text": self.current_q[1], "author": None}]
        self.choices += [{"text": t, "author": uid} for uid, t in self.lies.items()]
        self.rng.shuffle(self.choices)
        return self.choices

    def vote(self, user_id: int, choice_index: int) -> bool:
        if user_id not in self.players or user_id in self.votes:
            return False
        if not 0 <= choice_index < len(self.choices):
            return False
        if self.choices[choice_index]["author"] == user_id:
            return False  # 自分の嘘には投票できない
        self.votes[user_id] = choice_index
        return True

    def tally(self) -> dict:
        """得点を加算し、内訳を返す。"""
        gained = {uid: 0 for uid in self.players}
        fooled_by = {}
        for voter, idx in self.votes.items():
            choice = self.choices[idx]
            if choice["author"] is None:
                gained[voter] += POINTS_TRUTH
            else:
                gained[choice["author"]] += POINTS_FOOL
                fooled_by.setdefault(choice["author"], []).append(voter)
        for uid, pts in gained.items():
            self.scores[uid] += pts
        return {"gained": gained, "fooled_by": fooled_by}

    def standings(self) -> list[tuple[int, int]]:
        return sorted(self.scores.items(), key=lambda kv: (-kv[1], kv[0]))

    def winners(self) -> list[int]:
        rows = self.standings()
        if not rows:
            return []
        best = rows[0][1]
        return [uid for uid, s in rows if s == best]
