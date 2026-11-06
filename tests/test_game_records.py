"""ソロゲーム記録（core/game/game_records.py）のテスト。

フラッシュ暗算の設定別ベストと、数字当ての通算成績の集計・永続化、
および各 cog の結果表示への接続を確かめる。
"""

import sys
import tempfile
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
if str(Path(__file__).resolve().parent) not in sys.path:
    sys.path.insert(0, str(Path(__file__).resolve().parent))

from game_fakes import FakeChannel, FakeGuild, FakeInteraction, FakeMember  # noqa: E402

from cogs import flash as flash_module  # noqa: E402
from cogs import guess as guess_module  # noqa: E402
from core.game import game_records  # noqa: E402


class StoreTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "game_records.json"
        self.store = game_records.GameRecordsStore(self.path)

    def tearDown(self):
        self.tmp.cleanup()


class FlashRecordTest(StoreTestCase):
    def test_streak_and_best(self):
        e1 = self.store.record_flash(1, 5, 1, 1.0, True)
        self.assertEqual((e1["plays"], e1["correct"], e1["best_streak"]), (1, 1, 1))
        self.assertTrue(e1["best_updated"])
        e2 = self.store.record_flash(1, 5, 1, 1.0, True)
        self.assertEqual(e2["best_streak"], 2)
        self.assertTrue(e2["best_updated"])
        e3 = self.store.record_flash(1, 5, 1, 1.0, False)
        self.assertEqual((e3["plays"], e3["correct"], e3["best_streak"], e3["streak"]), (3, 2, 2, 0))
        self.assertFalse(e3["best_updated"])
        e4 = self.store.record_flash(1, 5, 1, 1.0, True)
        self.assertEqual(e4["best_streak"], 2)  # 連続1回ではベストに届かない
        self.assertFalse(e4["best_updated"])

    def test_settings_are_separate(self):
        self.store.record_flash(1, 5, 1, 1.0, True)
        other = self.store.record_flash(1, 10, 2, 0.5, False)
        self.assertEqual((other["plays"], other["correct"]), (1, 0))
        mine = self.store.get_flash(1, 5, 1, 1.0)
        self.assertEqual((mine["plays"], mine["correct"]), (1, 1))
        self.assertIsNone(self.store.get_flash(2, 5, 1, 1.0))

    def test_persistence(self):
        self.store.record_flash(1, 5, 1, 1.0, True)
        self.store.record_guess(1, 100, True, 280)
        self.store.flush()
        loaded = game_records.GameRecordsStore(self.path)
        self.assertEqual(loaded.get_flash(1, 5, 1, 1.0)["correct"], 1)
        self.assertEqual(loaded.get_guess(1)["net"], 280)


class GuessRecordTest(StoreTestCase):
    def test_aggregation(self):
        self.store.record_guess(7, 100, True, 280)
        stats = self.store.record_guess(7, 200, False, -300)
        self.assertEqual((stats["plays"], stats["wins"], stats["total_bet"], stats["net"]), (2, 1, 300, -20))
        text = game_records.format_guess_stats(stats)
        self.assertIn("2回中1勝", text)
        self.assertIn("勝率 50%", text)
        self.assertIn("総収支 -20 ago", text)
        self.assertIn("総賭け額 300 ago", text)


class CogConnectionTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.saved = game_records._shared
        game_records._shared = game_records.GameRecordsStore(Path(self.tmp.name) / "records.json")
        self.guild = FakeGuild(7)
        self.channel = FakeChannel(401, self.guild)
        self.member = FakeMember(42, self.guild)

    def tearDown(self):
        game_records._shared = self.saved
        self.tmp.cleanup()

    def test_flash_record_line(self):
        cog = flash_module.FlashMentalArithmetic(types.SimpleNamespace())
        line = cog._record_line(42, 5, 1.0, 1, True)
        self.assertIn("1回中1回正解", line)
        self.assertIn("自己ベスト更新", line)
        line = cog._record_line(42, 5, 1.0, 1, False)
        self.assertIn("2回中1回正解", line)
        self.assertNotIn("自己ベスト更新", line)

    async def test_guess_play_records_stats(self):
        cog = guess_module.Guess(types.SimpleNamespace())

        async def fake_profile(user_id):
            return {"balance": 1000}

        async def fake_apply(user_id, delta, won):
            return delta, 1000 + delta

        cog._get_profile = fake_profile
        cog._apply_delta = fake_apply
        inter = FakeInteraction(self.member, self.channel)
        await cog.play(inter, 100, 2)
        text = inter.response.sent[0].text()
        self.assertIn("あなたの通算成績", text)
        self.assertIn("1回中", text)
        stats = game_records.shared().get_guess("42")
        self.assertEqual(stats["plays"], 1)
        self.assertEqual(stats["total_bet"], 100)


if __name__ == "__main__":
    unittest.main()
