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


class RoomIrTruncationTest(unittest.TestCase):
    def test_hall_ir_truncated_to_1p5s_with_fade(self):
        irs = measured.load_room_irs()
        hall_l = irs["hall"][0]
        self.assertLessEqual(len(hall_l), 72000)
        # 末尾はフェードで 0 になっている
        self.assertAlmostEqual(float(hall_l[-1]), 0.0, places=6)
        # 先頭は切り取られていない
        room_l = irs["room"][0]
        self.assertLess(len(room_l), 48000)


class SpatialErrorFallbackTest(unittest.TestCase):
    def test_read_falls_back_to_passthrough_on_dsp_error(self):
        import struct as _struct
        import sys as _sys
        import types as _types

        # ローカル環境に yt_dlp が無い場合のスタブ（本番では実物が入る）
        _sys.modules.setdefault("yt_dlp", _types.ModuleType("yt_dlp"))
        from core.vc.music import spatial

        class _FakeSource:
            def read(self):
                samples = []
                for i in range(960):
                    samples += [1000, 1000]
                return _struct.pack("<1920h", *samples)

            def cleanup(self):
                pass

        state = {"eq": "spatial", "volume": 1.0, "spatial_distance": "abc"}
        src = spatial.PythonSpatialAudioSource(_FakeSource(), state)
        frame = src.read()  # 例外にならず、そのままの音が返る
        self.assertEqual(len(frame), 3840)
        self.assertTrue(src._spatial_failed)
        frame2 = src.read()
        self.assertEqual(len(frame2), 3840)


class BlockConvolverTest(unittest.TestCase):
    def test_block_convolution_matches_reference_with_block_delay(self):
        import sys as _sys
        import types as _types

        _sys.modules.setdefault("yt_dlp", _types.ModuleType("yt_dlp"))
        from core.vc.music.spatial import _BlockConvolver

        rng = np.random.default_rng(42)
        sig = rng.standard_normal(20000).astype(np.float32)
        ir = rng.standard_normal(3000).astype(np.float32) * 0.1
        ref = np.convolve(sig, ir)[: len(sig)]
        conv = _BlockConvolver()
        outs = []
        for i in range(0, len(sig), 960):
            chunk = sig[i : i + 960]
            if len(chunk) < 960:
                chunk = np.pad(chunk, (0, 960 - len(chunk)))
            o, _ = conv.process(chunk, chunk, ir, ir, ("room", 0.5))
            outs.append(o)
        out = np.concatenate(outs)
        # ウェット出力は「ブロックが満ちたフレーム」から出始めるため、
        # 960サンプルフレームでは 3840 サンプル遅れて一致する
        delay = 3840
        delayed = out[delay : delay + 10000]
        self.assertTrue(np.allclose(delayed, ref[:10000], atol=1e-4))


if __name__ == "__main__":
    unittest.main()
