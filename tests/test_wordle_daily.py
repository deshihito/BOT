"""Wordle デイリー（cogs/wordle.py の daily_answer + game_records の wordle_daily）のテスト。"""
import tempfile
import unittest
from pathlib import Path

from cogs.wordle import ANSWERS, daily_answer, daily_key
from core import game_records


class DailyAnswerTest(unittest.TestCase):
    def test_same_date_same_answer(self):
        self.assertEqual(daily_answer("2026-11-06"), daily_answer("2026-11-06"))

    def test_answer_is_from_answers(self):
        for key in ("2026-11-06", "2026-11-07", "2027-01-01", "2026-02-28"):
            self.assertIn(daily_answer(key), ANSWERS)

    def test_varies_across_dates(self):
        answers = {daily_answer(f"2026-11-{d:02d}") for d in range(1, 29)}
        self.assertGreater(len(answers), 10)

    def test_daily_key_format(self):
        self.assertRegex(daily_key(), r"^\d{4}-\d{2}-\d{2}$")


class DailyRecordTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = game_records.GameRecordsStore(Path(self.tmp.name) / "records.json")

    def tearDown(self):
        self.tmp.cleanup()

    def test_best_result_is_kept(self):
        self.store.record_wordle_daily(1, 100, "2026-11-06", 6, False)
        entry = self.store.record_wordle_daily(1, 100, "2026-11-06", 4, True)
        self.assertTrue(entry["won"])
        self.assertEqual(entry["attempts"], 4)
        entry = self.store.record_wordle_daily(1, 100, "2026-11-06", 6, False)
        self.assertTrue(entry["won"])  # 負けで上書きしない
        entry = self.store.record_wordle_daily(1, 100, "2026-11-06", 3, True)
        self.assertEqual(entry["attempts"], 3)  # より少ない手数の勝ちで更新

    def test_daily_for_filters_guild_and_sorts(self):
        self.store.record_wordle_daily(1, 100, "2026-11-06", 5, True)
        self.store.record_wordle_daily(2, 100, "2026-11-06", 3, True)
        self.store.record_wordle_daily(3, 100, "2026-11-06", 6, False)
        self.store.record_wordle_daily(4, 200, "2026-11-06", 2, True)
        rows = self.store.wordle_daily_for("2026-11-06", 100)
        self.assertEqual([r[0] for r in rows], [2, 1, 3])


if __name__ == "__main__":
    unittest.main()
