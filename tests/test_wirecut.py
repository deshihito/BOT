# -*- coding: utf-8 -*-
import unittest
from collections import Counter

from core.game.wirecut.wirecut import RED, WireCutGame


class WireCutGameTest(unittest.TestCase):
    def test_tile_composition(self):
        game = WireCutGame([1, 2, 3])
        all_tiles = [t for rack in game.racks.values() for t in rack]
        counts = Counter(all_tiles)
        for n in range(1, 13):
            self.assertEqual(counts[n], 4)
        self.assertEqual(counts[RED], 3)
        self.assertEqual(len(all_tiles), 51)

    def test_racks_sorted_with_red_inserted(self):
        game = WireCutGame([1, 2])
        for rack in game.racks.values():
            numbers = [t for t in rack if t != RED]
            self.assertEqual(numbers, sorted(numbers))

    def test_declare_cut_and_miss(self):
        game = WireCutGame([1, 2])
        actor = game.current
        target = 2 if actor == 1 else 1
        # 自分が持つ数字で、相手も持つものを探す
        own = {t for i, t in enumerate(game.rack(actor)) if t != RED and not game.is_cut(actor, i)}
        hit_pos = next(i for i, t in enumerate(game.rack(target)) if t in own)
        hit_num = game.rack(target)[hit_pos]
        result = game.declare(actor, target, hit_pos, hit_num)
        self.assertEqual(result["result"], "cut")
        self.assertTrue(game.is_cut(target, hit_pos))
        # ミス: 相手の数字タイル位置に、別の数字を宣言
        actor2 = game.current
        target2 = 2 if actor2 == 1 else 1
        pos2 = next(i for i, t in enumerate(game.rack(target2)) if t != RED and not game.is_cut(target2, i))
        real = game.rack(target2)[pos2]
        wrong = next(n for n in range(1, 13) if n != real)
        result2 = game.declare(actor2, target2, pos2, wrong)
        self.assertIsNotNone(result2)
        self.assertEqual(result2["result"], "miss")
        self.assertEqual(game.misses, 1)

    def test_declare_requires_remaining_pair(self):
        game = WireCutGame([1, 2])
        actor = game.current
        target = 2 if actor == 1 else 1
        # 数字1のタイルを全てカット済みにすると、もう宣言できない
        for uid in game.players:
            for i, t in enumerate(game.rack(uid)):
                if t == 1:
                    game.cut.add((uid, i))
        pos = next(i for i, t in enumerate(game.rack(target)) if t != RED and not game.is_cut(target, i))
        self.assertIsNone(game.declare(actor, target, pos, 1))

    def test_bomb_ends_game(self):
        game = WireCutGame([1, 2])
        actor = game.current
        target = next(uid for uid in game.players if RED in game.rack(uid))
        red_pos = game.rack(target).index(RED)
        result = game.declare(actor, target, red_pos, 5)
        self.assertEqual(result["result"], "bomb")
        self.assertTrue(game.failed)
        self.assertFalse(game.cleared)

    def test_info_token_reveals_parity(self):
        game = WireCutGame([1, 2])
        actor = game.current
        target = 2 if actor == 1 else 1
        result = game.use_info(actor, target, 0)
        self.assertIsNotNone(result)
        self.assertIn(result["parity"], ("red", "even", "odd"))
        self.assertEqual(game.info_left[actor], 1)
        marks = game.public_rack(target)
        self.assertNotEqual(marks[0], "?")

    def test_public_rack_hides_values(self):
        game = WireCutGame([1, 2])
        for uid in game.players:
            for mark in game.public_rack(uid):
                self.assertEqual(mark, "?")

    def test_board_slots_never_leak_hidden_values(self):
        """共有盤面データ（board_slots）に未カットタイルの数字が含まれないこと。

        盤面画像化（2026-11-06）の秘匿担保: レンダラーへ渡るのは
        ("cut", 公知の数字) と ("hidden", 偶奇 or None, ≠メモ) だけ。
        """
        from core.game.wirecut.cog import board_slots

        game = WireCutGame([1, 2, 3])
        # 公開情報を少し作る: 情報トークンで偶奇を公開し、ミスで≠メモを付ける
        actor = game.current
        target = next(u for u in game.players if u != actor)
        game.use_info(actor, target, 0)
        actor = game.current
        target = next(u for u in game.players if u != actor)
        pos = next(i for i, t in enumerate(game.rack(target)) if t != RED)
        wrong = next(n for n in range(1, 13) if n != game.rack(target)[pos])
        game.declare(actor, target, pos, wrong)

        for uid in game.players:
            slots = board_slots(game, uid)
            self.assertEqual(len(slots), len(game.rack(uid)))
            for i, slot in enumerate(slots):
                actual = game.rack(uid)[i]
                if game.is_cut(uid, i):
                    self.assertEqual(slot, ("cut", actual))  # カット済みは公知
                    continue
                self.assertEqual(slot[0], "hidden")
                self.assertEqual(len(slot), 3)
                # 偶奇は公開情報として整合していること（それ以外の数字情報は無い）
                if slot[1] == "even":
                    self.assertEqual(actual % 2, 0)
                elif slot[1] == "odd":
                    self.assertEqual(actual % 2, 1)
                elif slot[1] == "red":
                    self.assertEqual(actual, RED)
                else:
                    self.assertIsNone(slot[1])
                # ≠メモに本当の数字が入ることは決してない
                self.assertNotIn(actual, slot[2])

    def test_full_clear_simulation(self):
        game = WireCutGame([1, 2])
        guard = 0
        while not game.finished and guard < 300:
            guard += 1
            actor = game.current
            acted = False
            for target in game.players:
                for i, t in enumerate(game.rack(target)):
                    if t != RED and not game.is_cut(target, i):
                        # 正しい数字を宣言すればペアが必ず見つかりカットできる
                        self.assertEqual(game.declare(actor, target, i, t)["result"], "cut")
                        acted = True
                        break
                if acted:
                    break
            if not acted:
                self.fail("カットできるペアが無くなったのに未終了")
        self.assertTrue(game.cleared)


if __name__ == "__main__":
    unittest.main()
