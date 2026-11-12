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


class IrNormalizationTest(unittest.TestCase):
    def test_ir_energy_normalized_to_one(self):
        irs = measured.load_room_irs()
        for key, (l, r) in irs.items():
            norm = float(np.sqrt(np.sum(l.astype(np.float64) ** 2) + np.sum(r.astype(np.float64) ** 2)))
            self.assertAlmostEqual(norm, 1.0, places=3, msg=key)


class DistanceSelectTest(unittest.TestCase):
    def _make_src(self, state):
        import struct as _struct
        import sys as _sys
        import types as _types

        _sys.modules.setdefault("yt_dlp", _types.ModuleType("yt_dlp"))
        from core.vc.music import spatial

        class _FakeSource:
            def __init__(self):
                self.t = 0

            def read(self):
                import math as _math

                out = []
                for i in range(960):
                    tt = (self.t + i) / 48000
                    v = int(9000 * _math.sin(2 * _math.pi * 440 * tt))
                    out += [v, v]
                self.t += 960
                return _struct.pack("<1920h", *out)

            def cleanup(self):
                pass

        return spatial.PythonSpatialAudioSource(_FakeSource(), state), spatial

    def test_distance_changes_output_level(self):
        import numpy as _np

        def rms(distance):
            state = {"eq": "spatial", "volume": 1.0, "spatial_room_size": 0.0,
                     "spatial_distance": distance}
            src, _ = self._make_src(state)
            frames = [_np.frombuffer(src.read(), dtype=_np.int16).astype(_np.float32) for _ in range(60)]
            out = _np.concatenate(frames[20:])
            return float(_np.sqrt(_np.mean(out ** 2)))

        near = rms(0.5)
        far = rms(5.0)
        self.assertGreater(near / far, 5.0)

    def test_panel_has_distance_select_and_no_agc(self):
        _, spatial = self._make_src({"eq": "spatial"})

        class FakeCog:
            def get_state(self, gid):
                return {"eq": "spatial", "spatial_distance": 2.0, "spatial_room_size": 0.3,
                        "spatial_speaker": "studio", "is_rotating": True}

        view = spatial.SpatialControlView(FakeCog(), 1)
        placeholders = [getattr(c, "placeholder", "") or "" for c in view.children]
        self.assertTrue(any("距離" in p for p in placeholders))
        self.assertFalse(any("AGC" in p or "引き上げ" in p for p in placeholders))


class RotationCoherenceTest(unittest.TestCase):
    def _make_src(self, state):
        import struct as _struct
        import sys as _sys
        import types as _types

        _sys.modules.setdefault("yt_dlp", _types.ModuleType("yt_dlp"))
        from core.vc.music import spatial

        class _FakeSource:
            def read(self):
                return _struct.pack("<1920h", *([1000, 1000] * 960))

            def cleanup(self):
                pass

        return spatial.PythonSpatialAudioSource(_FakeSource(), state)

    def test_band_angles_stay_coherent(self):
        import math as _math

        src = self._make_src({"eq": "spatial", "volume": 1.0})
        max_spread = 0.0
        seen = []
        for _ in range(600):
            src.read()
            angles = [a % (2 * _math.pi) for a in src._last_band_angles]
            pts = sorted(angles)
            gaps = [pts[1] - pts[0], pts[2] - pts[1], pts[0] + 2 * _math.pi - pts[2]]
            spread = 2 * _math.pi - max(gaps)
            max_spread = max(max_spread, spread)
            seen.append(angles[1])
        # 帯域間の角度差は常に 50 度以内（旧方式は最大 180 度までバラけた）
        self.assertLessEqual(_math.degrees(max_spread), 50.0)
        # 主回転は進んでいる
        self.assertGreater(max(seen) - min(seen), 1.0)

    def test_band_angles_zero_when_off(self):
        src = self._make_src({"eq": "spatial", "volume": 1.0, "spatial_rot_mode": "off"})
        src.read()
        self.assertEqual(src._last_band_angles, [0.0, 0.0, 0.0])


class SpatialPanelFixesTest(unittest.IsolatedAsyncioTestCase):
    def _make_view(self, state):
        import sys as _sys
        import types as _types

        _sys.modules.setdefault("yt_dlp", _types.ModuleType("yt_dlp"))
        from core.vc.music import spatial

        class _FakeCog:
            def get_state(self, guild_id):
                return state

        return spatial.SpatialControlView(_FakeCog(), 123), spatial

    def test_select_defaults_follow_state(self):
        state = {
            "spatial_room_size": 0.75,
            "spatial_distance": 8.0,
            "spatial_speaker": "pa",
        }
        view, _spatial = self._make_view(state)
        for select, expected in (
            (view.select_reverb, "0.75"),
            (view.select_distance, "8.0"),
            (view.select_speaker, "pa"),
        ):
            defaults = [o.value for o in select.options if o.default]
            self.assertEqual(defaults, [expected])

    async def test_toggle_spatial_defers_before_reload(self):
        from unittest.mock import AsyncMock, MagicMock

        state = {"eq": "flat"}
        view, spatial = self._make_view(state)
        order = []

        interaction = MagicMock()
        interaction.response.is_done = MagicMock(return_value=False)

        async def _defer():
            order.append("defer")

        async def _apply(_interaction):
            order.append("apply")

        async def _update(_interaction):
            order.append("update")

        interaction.response.defer = AsyncMock(side_effect=_defer)
        view.cog.apply_immediate_setting = AsyncMock(side_effect=_apply)
        view.update_panel = AsyncMock(side_effect=_update)
        spatial._require_same_vc = AsyncMock(return_value=True)

        await view.toggle_spatial.callback(interaction)

        self.assertEqual(order, ["defer", "apply", "update"])
        self.assertEqual(state["eq"], "spatial")


if __name__ == "__main__":
    unittest.main()
