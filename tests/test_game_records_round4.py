# -*- coding: utf-8 -*-
import tempfile
import unittest
from pathlib import Path

from core.game.game.game_records import GameRecordsStore


class Round4RecordsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = GameRecordsStore(Path(self.tmp.name) / "records.json")

    def tearDown(self):
        self.tmp.cleanup()

    def test_justone_best(self):
        entry = self.store.record_justone(42, 3)
        self.assertEqual(entry["best_successes"], 3)
        entry = self.store.record_justone(42, 2)
        self.assertEqual(entry["best_successes"], 3)
        self.assertEqual(entry["plays"], 2)
        self.assertEqual(entry["total_successes"], 5)
        self.assertFalse(entry["best_updated"])

    def test_ito(self):
        self.store.record_ito(42, 2, 3)
        entry = self.store.record_ito(42, 1, 3)
        self.assertEqual(entry, {"plays": 2, "clears": 3})

    def test_hanabi_best_and_reload(self):
        self.store.record_hanabi(42, 18)
        entry = self.store.record_hanabi(42, 12)
        self.assertEqual(entry["best_score"], 18)
        self.store.flush()
        loaded = GameRecordsStore(Path(self.tmp.name) / "records.json")
        self.assertEqual(loaded.get_hanabi(42)["best_score"], 18)
        self.assertEqual(loaded.get_justone(42), None)


if __name__ == "__main__":
    unittest.main()
