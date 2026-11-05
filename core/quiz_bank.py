# -*- coding: utf-8 -*-
"""クイズ大会の問題バンクと問題供給インターフェース。

v1 は同梱バンクのみ（一般常識レベル、自作問題）。将来 AI 生成などに
差し替える場合は QuizSource を実装したクラスを用意し、
``default_source()`` の戻り値を差し替えるだけでよい。
"""
import random

# 各問題: q=問題文, choices=選択肢4つ, answer=正解のインデックス
QUESTIONS = [
    # 一般常識
    {"category": "一般常識", "q": "日本の首都はどこでしょう？", "choices": ["大阪", "東京", "京都", "名古屋"], "answer": 1},
    {"category": "一般常識", "q": "1年は何日あるでしょう（うるう年でない年）？", "choices": ["360日", "365日", "366日", "364日"], "answer": 1},
    {"category": "一般常識", "q": "日本の紙幣で、千円札の肖像は誰でしょう（2024年からの新紙幣）？", "choices": ["北里柴三郎", "津田梅子", "渋沢栄一", "夏目漱石"], "answer": 0},
    {"category": "一般常識", "q": "水の化学式はどれでしょう？", "choices": ["CO2", "O2", "H2O", "NaCl"], "answer": 2},
    {"category": "一般常識", "q": "電話の緊急通報（警察）は何番でしょう？", "choices": ["110番", "119番", "104番", "117番"], "answer": 0},
    {"category": "一般常識", "q": "1ダースは何個でしょう？", "choices": ["10個", "12個", "20個", "24個"], "answer": 1},
    {"category": "一般常識", "q": "将棋の駒で、最初から2枚あるのはどれでしょう？", "choices": ["飛車", "角行", "金将", "王将"], "answer": 2},
    {"category": "一般常識", "q": "日本の国鳥はどれでしょう？", "choices": ["ツル", "キジ", "トキ", "ハト"], "answer": 1},
    # 科学
    {"category": "科学", "q": "地球から一番近い恒星はどれでしょう？", "choices": ["シリウス", "太陽", "北極星", "ベガ"], "answer": 1},
    {"category": "科学", "q": "光の速さはおよそ秒速何kmでしょう？", "choices": ["約300km", "約3,000km", "約30,000km", "約300,000km"], "answer": 3},
    {"category": "科学", "q": "人間の体で、骨の数は成人でおよそいくつでしょう？", "choices": ["約100個", "約200個", "約400個", "約600個"], "answer": 1},
    {"category": "科学", "q": "元素記号「Fe」は何の元素でしょう？", "choices": ["金", "銀", "鉄", "銅"], "answer": 2},
    {"category": "科学", "q": "絶対零度は摂氏でおよそ何度でしょう？", "choices": ["-100度", "-173度", "-273度", "-373度"], "answer": 2},
    {"category": "科学", "q": "植物が光合成で吸収する気体はどれでしょう？", "choices": ["酸素", "窒素", "二酸化炭素", "水素"], "answer": 2},
    {"category": "科学", "q": "月が地球を1周する周期はおよそ何日でしょう？", "choices": ["約7日", "約14日", "約27日", "約60日"], "answer": 2},
    {"category": "科学", "q": "音が伝わらないのはどんな場所でしょう？", "choices": ["水中", "真空中", "鉄の中", "空気中"], "answer": 1},
    # 歴史・地理
    {"category": "歴史・地理", "q": "日本で一番高い山はどれでしょう？", "choices": ["北岳", "富士山", "槍ヶ岳", "白馬岳"], "answer": 1},
    {"category": "歴史・地理", "q": "江戸幕府を開いたのは誰でしょう？", "choices": ["織田信長", "豊臣秀吉", "徳川家康", "源頼朝"], "answer": 2},
    {"category": "歴史・地理", "q": "世界で一番大きい大陸はどれでしょう？", "choices": ["アフリカ大陸", "ユーラシア大陸", "北アメリカ大陸", "南アメリカ大陸"], "answer": 1},
    {"category": "歴史・地理", "q": "鎌倉幕府が成立したのは何年とされるでしょう（現在の通説）？", "choices": ["1192年", "1185年", "1333年", "1603年"], "answer": 1},
    {"category": "歴史・地理", "q": "エジプトのピラミッドで有名な川はどれでしょう？", "choices": ["ナイル川", "アマゾン川", "ドナウ川", "黄河"], "answer": 0},
    {"category": "歴史・地理", "q": "日本の都道府県で一番面積が大きいのはどこでしょう？", "choices": ["岩手県", "北海道", "長野県", "福島県"], "answer": 1},
    {"category": "歴史・地理", "q": "第二次世界大戦が終わった年はどれでしょう？", "choices": ["1943年", "1944年", "1945年", "1946年"], "answer": 2},
    {"category": "歴史・地理", "q": "オーストラリアの首都はどこでしょう？", "choices": ["シドニー", "メルボルン", "キャンベラ", "パース"], "answer": 2},
    # 言葉・文化
    {"category": "言葉・文化", "q": "「犬も歩けば棒に当たる」の意味として近いのはどれでしょう？", "choices": ["何かすれば災いや幸運に遭う", "散歩は危険である", "犬は棒が好きである", "歩くと疲れる"], "answer": 0},
    {"category": "言葉・文化", "q": "英語で「ありがとう」を意味するのはどれでしょう？", "choices": ["Hello", "Thank you", "Sorry", "Please"], "answer": 1},
    {"category": "言葉・文化", "q": "『源氏物語』の作者は誰でしょう？", "choices": ["清少納言", "紫式部", "小野小町", "和泉式部"], "answer": 1},
    {"category": "言葉・文化", "q": "俳句の基本の音数はどれでしょう？", "choices": ["5・7・5", "7・7・5", "5・5・7", "7・5・7"], "answer": 0},
    {"category": "言葉・文化", "q": "「蛙の子は蛙」は何のたとえでしょう？", "choices": ["努力は実る", "子は親に似る", "自然は美しい", "成長は早い"], "answer": 1},
    {"category": "言葉・文化", "q": "フランス語で「こんにちは」はどれでしょう？", "choices": ["Gracias", "Bonjour", "Ciao", "Danke"], "answer": 1},
    {"category": "言葉・文化", "q": "日本の国歌の題名はどれでしょう？", "choices": ["君が代", "ふるさと", "さくら", "荒城の月"], "answer": 0},
    {"category": "言葉・文化", "q": "竹取物語で、竹の中から生まれた姫の名前はどれでしょう？", "choices": ["かぐや姫", "乙姫", "織姫", "雪女"], "answer": 0},
    # スポーツ・芸能
    {"category": "スポーツ・芸能", "q": "サッカーの試合で、1チームがフィールドに出す選手は何人でしょう？", "choices": ["9人", "10人", "11人", "12人"], "answer": 2},
    {"category": "スポーツ・芸能", "q": "オリンピックの五輪マークの輪は何色あるでしょう？", "choices": ["4色", "5色", "6色", "7色"], "answer": 1},
    {"category": "スポーツ・芸能", "q": "野球で満塁ホームランを打つと何点入るでしょう？", "choices": ["2点", "3点", "4点", "5点"], "answer": 2},
    {"category": "スポーツ・芸能", "q": "マラソンの距離はおよそ何kmでしょう？", "choices": ["約32km", "約37km", "約42km", "約47km"], "answer": 2},
    {"category": "スポーツ・芸能", "q": "将棋と並ぶ代表的なボードゲームで、白と黒の石を使うのはどれでしょう？", "choices": ["囲碁", "チェス", "オセロ", "麻雀"], "answer": 0},
    {"category": "スポーツ・芸能", "q": "テニスの試合で、ゲームを取るのに必要なポイントの最小数はどれでしょう（デュースなし）？", "choices": ["2ポイント", "3ポイント", "4ポイント", "5ポイント"], "answer": 2},
    {"category": "スポーツ・芸能", "q": "相撲の最高位はどれでしょう？", "choices": ["大関", "横綱", "関脇", "小結"], "answer": 1},
    {"category": "スポーツ・芸能", "q": "バレーボールで、1セット取るのに必要な点数は通常何点でしょう（最終セット除く）？", "choices": ["15点", "21点", "25点", "30点"], "answer": 2},
]

CATEGORIES = sorted({q["category"] for q in QUESTIONS})


class QuizSource:
    """問題供給インターフェース。将来の AI 生成などはこれを実装して差し替える。"""

    def get_questions(self, count: int, *, rng: random.Random = None) -> list:
        raise NotImplementedError


class BankQuizSource(QuizSource):
    """同梱バンクからランダムに出題する供給。"""

    def __init__(self, questions=None):
        self.questions = list(questions if questions is not None else QUESTIONS)

    def get_questions(self, count: int, *, rng: random.Random = None) -> list:
        rng = rng or random.Random()
        pool = list(self.questions)
        rng.shuffle(pool)
        picked = pool[: max(0, min(count, len(pool)))]
        result = []
        for q in picked:
            order = list(range(len(q["choices"])))
            rng.shuffle(order)
            result.append({
                "category": q["category"],
                "q": q["q"],
                "choices": [q["choices"][i] for i in order],
                "answer": order.index(q["answer"]),
            })
        return result


def default_source() -> QuizSource:
    return BankQuizSource()
