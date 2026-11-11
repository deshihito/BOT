import tempfile
import unittest
from pathlib import Path

import numpy as np

from core.vc.music import measured


class LoadMeasuredTest(unittest.TestCase):
    def setUp(self):
        measured._room_cache = None
        measured._speaker_cache = None

    def tearDown(self):
        measured._room_cache = None
        measured._speaker_cache = None

    def test_room_irs(self):
        rooms = measured.load_room_irs()
        self.assertIsNotNone(rooms)
        self.assertEqual(set(rooms), {"room", "hall"})
        room_l, room_r = rooms["room"]
        hall_l, hall_r = rooms["hall"]
        self.assertEqual(len(room_l), len(room_r))
        self.assertGreater(len(hall_l), len(room_l))  # ホールは部屋より長い
        for ir in (room_l, hall_l):
            self.assertTrue(np.all(np.isfinite(ir)))
            head = float(np.sqrt(np.mean(ir[:4800] ** 2)))
            tail = float(np.sqrt(np.mean(ir[-4800:] ** 2)))
            self.assertGreater(head, tail)  # 減衰している

    def test_speakers(self):
        speakers = measured.load_speakers()
        self.assertIsNotNone(speakers)
        self.assertEqual(set(speakers), {"studio", "theater", "pa", "small"})
        for data in speakers.values():
            self.assertEqual(data["fir"].shape, (256,))
            self.assertEqual(data["directivity"].shape, (3, 72))
            d = data["directivity"]
            self.assertAlmostEqual(float(d[2, 0]), 1.0, places=5)   # 正面 = 1
            self.assertLess(float(d[2, 36]), 0.35)                   # 背面は高音が大きく減衰（実測）
            self.assertGreater(float(d[0, 36]), float(d[2, 36]))     # 低音は背面でも残る

    def test_missing_files_fall_back_to_none(self):
        original = measured._ASSETS
        measured._ASSETS = Path(tempfile.mkdtemp())
        try:
            self.assertIsNone(measured.load_room_irs())
            self.assertIsNone(measured.load_speakers())
        finally:
            measured._ASSETS = original


class AirAbsorptionTest(unittest.TestCase):
    def test_iso9613_values(self):
        alpha = measured._BAND_ALPHA
        self.assertLess(alpha[0], alpha[1])
        self.assertLess(alpha[1], alpha[2])
        self.assertTrue(0.08 < alpha[2] < 0.12)  # 9kHz は約 0.1 dB/m

    def test_gains(self):
        self.assertEqual(measured.air_absorption_gains(0.0), (1.0, 1.0, 1.0))
        near = measured.air_absorption_gains(2.0)
        far = measured.air_absorption_gains(30.0)
        for g_near, g_far in zip(near, far):
            self.assertGreater(g_near, g_far)
        self.assertLess(far[2], far[0])  # 遠距離では高音が最も減る


if __name__ == "__main__":
    unittest.main()
