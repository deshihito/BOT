# -*- coding: utf-8 -*-
import tempfile
import unittest
from pathlib import Path

from core.game.game.game_records import GameRecordsStore


class Round5RecordsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = GameRecordsStore(Path(self.tmp.name) / "records.json")

    def tearDown(self):
        self.tmp.cleanup()

    def test_wirecut(self):
        entry = self.store.record_wirecut(42, True)
        self.assertEqual(entry, {"plays": 1, "clears": 1})
        entry = self.store.record_wirecut(42, False)
        self.assertEqual(entry, {"plays": 2, "clears": 1})
        self.assertEqual(self.store.get_wirecut(42), {"plays": 2, "clears": 1})
        self.assertIsNone(self.store.get_wirecut(99))

    def test_yotsuba_best_and_total(self):
        entry = self.store.record_yotsuba(42, 9)
        self.assertEqual(entry["best_score"], 9)
        entry = self.store.record_yotsuba(42, 5)
        self.assertEqual(entry["best_score"], 9)
        self.assertFalse(entry["best_updated"])
        self.assertEqual(entry["total_score"], 14)
        self.assertEqual(entry["plays"], 2)

    def test_reload(self):
        self.store.record_wirecut(7, True)
        self.store.record_yotsuba(7, 11)
        self.store.flush()
        loaded = GameRecordsStore(Path(self.tmp.name) / "records.json")
        self.assertEqual(loaded.get_wirecut(7), {"plays": 1, "clears": 1})
        self.assertEqual(loaded.get_yotsuba(7)["best_score"], 11)


if __name__ == "__main__":
    unittest.main()
