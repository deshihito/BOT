"""こいこい（core/game/koikoi/koikoi.py）のテスト。役の得点計算と対局進行を固める。"""

import random
import unittest

from core.game.koikoi.koikoi import (CARDS, TOTAL_ROUNDS, KoikoiMatch, cpu_choose_capture,
                         cpu_choose_play, cpu_decide, evaluate)


def by_tag(tag):
    return next(i for i, c in CARDS.items() if c["tag"] == tag)


def by_kind(kind, skip=0):
    ids = [i for i, c in CARDS.items() if c["kind"] == kind]
    return ids[skip:]


class CardTableTest(unittest.TestCase):
    def test_48_cards_12_months_4_each(self):
        self.assertEqual(len(CARDS), 48)
        for month in range(1, 13):
            self.assertEqual(sum(1 for c in CARDS.values() if c["month"] == month), 4)
        self.assertEqual(sum(1 for c in CARDS.values() if c["kind"] == "hikari"), 5)


class EvaluateTest(unittest.TestCase):
    def test_empty(self):
        self.assertEqual(evaluate([]), (0, []))

    def test_three_lights_without_rain(self):
        points, yaku = evaluate([by_tag("crane"), by_tag("curtain"), by_tag("moon")])
        self.assertEqual(points, 5)
        self.assertTrue(any("三光" in y for y in yaku))

    def test_three_lights_with_rain_is_no_yaku(self):
        points, _ = evaluate([by_tag("crane"), by_tag("curtain"), by_tag("rain")])
        self.assertEqual(points, 0)

    def test_four_and_five_lights(self):
        four = [by_tag(t) for t in ("crane", "curtain", "moon", "phoenix")]
        self.assertEqual(evaluate(four)[0], 8)
        four_rain = [by_tag(t) for t in ("crane", "curtain", "moon", "rain")]
        self.assertEqual(evaluate(four_rain)[0], 7)
        five = [by_tag(t) for t in ("crane", "curtain", "moon", "rain", "phoenix")]
        self.assertEqual(evaluate(five)[0], 10)

    def test_inoshikacho_and_extra_tane(self):
        base = [by_tag(t) for t in ("boar", "butterfly", "deer")]
        self.assertEqual(evaluate(base)[0], 5)
        extra = base + [by_kind("tane")[0] if by_kind("tane")[0] not in base else by_kind("tane")[1]]
        # 種が4枚になれば 猪鹿蝶 は 5 + (4-3) = 6点
        tane_count = sum(1 for c in extra if CARDS[c]["kind"] == "tane")
        self.assertEqual(evaluate(extra)[0], 5 + (tane_count - 3))

    def test_akatan_aotan(self):
        red = [i for i, c in CARDS.items() if c["tag"] == "redtan"]
        self.assertEqual(len(red), 3)
        points, yaku = evaluate(red)
        self.assertEqual(points, 5)
        self.assertTrue(any("赤短" in y for y in yaku))
        blue = [i for i, c in CARDS.items() if c["tag"] == "bluetan"]
        self.assertEqual(len(blue), 3)
        points, yaku = evaluate(blue)
        self.assertEqual(points, 5)
        self.assertTrue(any("青短" in y for y in yaku))

    def test_count_yaku(self):
        # 赤短・青短が成立しない短冊の組で、枚数役だけを見る
        plain5 = [13, 17, 21, 25, 33]        # 藤・菖蒲・牡丹青・萩・菊青
        self.assertEqual(evaluate(plain5)[0], 5)   # 短冊5枚
        self.assertEqual(evaluate(plain5 + [42])[0], 6)   # 短冊6枚（+柳）
        self.assertEqual(evaluate(by_kind("tane")[:5])[0], 5)      # 種5枚（猪鹿蝶なしの組）
        self.assertEqual(evaluate(by_kind("kasu")[:10])[0], 5)     # カス10枚
        self.assertEqual(evaluate(by_kind("kasu")[:12])[0], 7)     # カス12枚

    def test_tsukimi_hanami(self):
        points, yaku = evaluate([by_tag("moon"), by_tag("sake")])
        self.assertEqual(points, 5)
        self.assertTrue(any("月見" in y for y in yaku))
        points, yaku = evaluate([by_tag("curtain"), by_tag("sake")])
        self.assertEqual(points, 5)
        self.assertTrue(any("花見" in y for y in yaku))

    def test_yaku_stack(self):
        # 月見＋花見＋赤短が重なる取り札（光は2枚なので三光は不成立）
        cards = [by_tag("moon"), by_tag("curtain"), by_tag("sake")]
        cards += [i for i, c in CARDS.items() if c["tag"] == "redtan"]
        points, yaku = evaluate(cards)
        self.assertEqual(points, 5 + 5 + 5)
        self.assertEqual(len(yaku), 3)


class MatchFlowTest(unittest.TestCase):
    def test_cpu_vs_cpu_match_completes(self):
        for seed in range(5):
            match = KoikoiMatch([1, 2], rng=random.Random(seed))
            steps = 0
            while match.phase != "match_end" and steps < 5000:
                steps += 1
                if match.phase == "round_end":
                    match.start_round()
                elif match.phase == "play":
                    match.play_hand(match.current, cpu_choose_play(match, match.current))
                elif match.phase in ("choose_hand_capture", "choose_draw_capture"):
                    match.choose_capture(match.current,
                                         cpu_choose_capture(match, match.current, match.pending["candidates"]))
                elif match.phase == "decision":
                    match.decide(match.current, cpu_decide(match, match.current, match.pending["points"]))
            self.assertEqual(match.phase, "match_end")
            self.assertEqual(match.round_no, TOTAL_ROUNDS)
            if match.match_winner is not None:
                loser = 2 if match.match_winner == 1 else 1
                self.assertGreater(match.scores[match.match_winner], match.scores[loser])

    def test_play_validation(self):
        match = KoikoiMatch([1, 2], rng=random.Random(0))
        not_in_hand = next(i for i in CARDS if i not in match.hands[match.current])
        with self.assertRaises(ValueError):
            match.play_hand(match.current, not_in_hand)
        other = 2 if match.current == 1 else 1
        with self.assertRaises(ValueError):
            match.play_hand(other, match.hands[other][0])

    def test_capture_same_month(self):
        match = KoikoiMatch([1, 2], rng=random.Random(0))
        pid = match.current
        hand_card = match.hands[pid][0]
        month = CARDS[hand_card]["month"]
        field_card = next(i for i, c in CARDS.items()
                          if c["month"] == month and i != hand_card
                          and i not in match.hands[1] and i not in match.hands[2])
        match.field = [field_card]
        # 山からは場にない月の札が出るように調整（取り合いを単純化）
        deck_card = next(i for i, c in CARDS.items()
                         if c["month"] != month and i not in (hand_card, field_card)
                         and i not in match.hands[1] and i not in match.hands[2])
        match.deck = [deck_card]
        match.captured = {1: [], 2: []}
        event = match.play_hand(pid, hand_card)
        self.assertIn(hand_card, match.captured[pid])
        self.assertIn(field_card, match.captured[pid])
        self.assertIn(deck_card, match.field)  # めくった札は場に残る


if __name__ == "__main__":
    unittest.main()
