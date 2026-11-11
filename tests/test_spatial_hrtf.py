import unittest
from pathlib import Path

import numpy as np

from core.vc.music import hrtf


def _onset(ir: np.ndarray) -> int:
    return int(np.argmax(np.abs(ir) > 0.1 * np.max(np.abs(ir))))


class LoadHrtfTablesTest(unittest.TestCase):
    def setUp(self):
        hrtf._cache = None

    def tearDown(self):
        hrtf._cache = None

    def test_tables_shape(self):
        result = hrtf.load_hrtf_tables()
        self.assertIsNotNone(result)
        num_directions, hrir_len, table_l, table_r = result
        self.assertEqual(num_directions, 72)
        self.assertEqual(hrir_len, 144)
        self.assertEqual(len(table_l), 3 * 72)
        self.assertEqual(len(table_r), 3 * 72)
        self.assertEqual({y for y, _ in table_l}, {-4.0, 0.0, 4.0})
        for ir in table_l.values():
            self.assertEqual(ir.dtype, np.float32)
            self.assertTrue(np.all(np.isfinite(ir)))

    def test_front_is_symmetric(self):
        _, _, table_l, table_r = hrtf.load_hrtf_tables()
        np.testing.assert_allclose(table_l[(0.0, 0)], table_r[(0.0, 0)], atol=1e-6)

    def test_left_source_reaches_left_ear_first(self):
        # 方位index 18 = 90° (左側): 左耳が先に・大きく届く (実測HRTFの耳間時間差/レベル差)
        _, _, table_l, table_r = hrtf.load_hrtf_tables()
        left = table_l[(0.0, 18)]
        right = table_r[(0.0, 18)]
        self.assertLess(_onset(left), _onset(right))
        self.assertGreater(np.max(np.abs(left)), np.max(np.abs(right)))
        # 反対側 (270°) では左右が入れ替わる
        left270 = table_l[(0.0, 54)]
        right270 = table_r[(0.0, 54)]
        self.assertLess(_onset(right270), _onset(left270))

    def test_elevations_differ(self):
        _, _, table_l, _ = hrtf.load_hrtf_tables()
        self.assertFalse(np.allclose(table_l[(-4.0, 6)], table_l[(4.0, 6)]))

    def test_missing_file_falls_back_to_none(self):
        original = hrtf._HRTF_PATH
        hrtf._HRTF_PATH = Path("/nonexistent/kemar_hrir_48k.npz")
        try:
            self.assertIsNone(hrtf.load_hrtf_tables())
        finally:
            hrtf._HRTF_PATH = original


if __name__ == "__main__":
    unittest.main()
