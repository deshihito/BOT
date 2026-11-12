import tempfile
import unittest
from pathlib import Path

import numpy as np

from core.vc.music import measured


class LoadMeasuredTest(unittest.TestCase):
    def setUp(self):
        measured._speaker_cache = None

    def tearDown(self):
        measured._speaker_cache = None

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
        # 距離補正（遠いほど持ち上げる固定カーブ）が入ったため、純粋な 1/d の
        # 10 倍よりは小さいが、距離による音量差ははっきり残る
        self.assertGreater(near / far, 3.0)

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
            gaps = [pts[i + 1] - pts[i] for i in range(len(pts) - 1)]
            gaps.append(pts[0] + 2 * _math.pi - pts[-1])
            spread = 2 * _math.pi - max(gaps)
            max_spread = max(max_spread, spread)
            seen.append(angles[1])
        # 帯域間の角度差は常に 55 度以内（設計上の上限は約 50 度。
        # 帯域ごとに独立回転していた旧方式は最大 180 度までバラけた）
        self.assertLessEqual(_math.degrees(max_spread), 55.0)
        # 主回転は進んでいる
        self.assertGreater(max(seen) - min(seen), 1.0)

    def test_band_angles_zero_when_off(self):
        src = self._make_src({"eq": "spatial", "volume": 1.0, "spatial_rot_mode": "off"})
        src.read()
        self.assertEqual(src._last_band_angles, [0.0, 0.0, 0.0, 0.0, 0.0])

    def test_distance_compensation_keeps_level(self):
        import math as _math
        import struct as _struct
        import sys as _sys
        import types as _types

        import numpy as _np

        _sys.modules.setdefault("yt_dlp", _types.ModuleType("yt_dlp"))
        from core.vc.music import spatial

        class _NoiseSource:
            def __init__(self):
                self.t = 0

            def read(self):
                out = []
                for i in range(960):
                    tt = (self.t + i) / 48000
                    v = int(6000 * _math.sin(2 * _math.pi * 110 * tt)
                            + 6000 * _math.sin(2 * _math.pi * 900 * tt)
                            + 6000 * _math.sin(2 * _math.pi * 6000 * tt))
                    out += [v, v]
                self.t += 960
                return _struct.pack(f"<{len(out)}h", *out)

            def cleanup(self):
                pass

        def rms_at(distance):
            src = spatial.PythonSpatialAudioSource(_NoiseSource(), {
                "eq": "spatial", "volume": 1.0, "spatial_rot_mode": "off",
                "spatial_room_size": 0.0, "spatial_distance": distance,
            })
            # 周期信号だと測定がぶれるため、フレームごとに違う波形を使う
            total = 0.0
            count = 0
            for f in range(60):
                frame = _np.frombuffer(src.read(), dtype=_np.int16).astype(_np.float64)
                if f >= 20:
                    total += float(_np.sum(frame ** 2))
                    count += frame.size
            return (total / max(1, count)) ** 0.5

        near = rms_at(2.0)
        far = rms_at(8.0)
        # 補正なしでは 1/d で 0.25 倍になる。距離補正で 0.5 倍以上を保つ
        self.assertGreater(far / near, 0.5)


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


class LiveModeTest(unittest.TestCase):
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

        return spatial.PythonSpatialAudioSource(_FakeSource(), state), spatial

    def test_live_band_angles(self):
        import math as _math

        src, _spatial = self._make_src({
            "eq": "spatial", "volume": 1.0, "spatial_rot_mode": "live",
        })
        vocal_angles = []
        for _ in range(400):
            src.read()
            angles = src._last_band_angles
            # 低音は正面に固定、その他（ボーカル以外）は固定配置
            self.assertEqual(angles[0], 0.0)
            self.assertAlmostEqual(angles[1], -0.18)
            self.assertAlmostEqual(angles[3], 0.21)
            self.assertAlmostEqual(angles[4], 0.35)
            # ボーカル帯域は前方の範囲内だけで動く
            self.assertLessEqual(abs(angles[2]), 0.87)
            vocal_angles.append(angles[2])
        self.assertGreater(max(vocal_angles) - min(vocal_angles), 1.0)

    def test_wfs_tap_tables(self):
        _src, spatial = self._make_src({"eq": "spatial", "volume": 1.0})
        for table in (spatial._LIVE_TAPS_NARROW, spatial._LIVE_TAPS_WIDE):
            self.assertAlmostEqual(sum(w for _o, w in table), 1.0, places=6)
            offsets = [o for o, _w in table]
            self.assertEqual(offsets, sorted(offsets))
            self.assertEqual(offsets[0], -offsets[-1])
        self.assertGreater(len(spatial._LIVE_TAPS_WIDE), len(spatial._LIVE_TAPS_NARROW))

    def test_live_mode_renders(self):
        import numpy as _np

        src, _spatial = self._make_src({
            "eq": "spatial", "volume": 1.0, "spatial_rot_mode": "live",
            "spatial_room_size": 0.3,
        })
        frame = _np.frombuffer(src.read(), dtype=_np.int16)
        self.assertEqual(frame.size, 1920)
        self.assertGreater(float(_np.max(_np.abs(frame))), 0.0)


class FdnReverbTest(unittest.TestCase):
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

    def test_fdn_wet_level_and_room_difference(self):
        import numpy as _np

        def wet_rms(room_m, frames=100):
            src = self._make_src({"eq": "spatial", "volume": 1.0})
            rng = _np.random.default_rng(42)
            sig = rng.standard_normal(960 * frames).astype(_np.float32) * 0.3
            total = 0.0
            count = 0
            for f in range(frames):
                wl, wr = src._fdn_reverb(sig[f * 960:(f + 1) * 960], sig[f * 960:(f + 1) * 960], room_m)
                if f >= 50:
                    total += float(_np.sum(wl ** 2) + _np.sum(wr ** 2))
                    count += wl.size * 2
            return (total / max(1, count)) ** 0.5

        small = wet_rms(3.0)
        # ウェット音が十分なレベルで返る（無音や過大でない）
        self.assertGreater(small, 0.05)
        self.assertLess(small, 0.6)

    def test_fdn_room_size_changes_tail(self):
        import numpy as _np

        def tail_energy(room_m):
            src = self._make_src({"eq": "spatial", "volume": 1.0})
            rng = _np.random.default_rng(7)
            sig = rng.standard_normal(960).astype(_np.float32) * 0.3
            silence = _np.zeros(960, dtype=_np.float32)
            for _ in range(50):  # 1 秒間鳴らして残響を育てる
                src._fdn_reverb(sig, sig, room_m)
            energy = 0.0
            for f in range(75):  # 止めてから 0.5〜2.0 秒の尾を測る
                wl, wr = src._fdn_reverb(silence, silence, room_m)
                if f >= 25:
                    energy += float(_np.sum(wl ** 2) + _np.sum(wr ** 2))
            return energy

        # 部屋が広いほど尾が長く残る（反響による音の変化）
        self.assertGreater(tail_energy(25.0), tail_energy(3.0) * 2.0)

    def test_fdn_tail_decays(self):
        import numpy as _np

        src = self._make_src({"eq": "spatial", "volume": 1.0})
        impulse = _np.zeros(960, dtype=_np.float32)
        impulse[0] = 1.0
        silence = _np.zeros(960, dtype=_np.float32)
        src._fdn_reverb(impulse, impulse, 25.0)
        energies = []
        for f in range(100):  # 2 秒分
            wl, wr = src._fdn_reverb(silence, silence, 25.0)
            if f % 25 == 0:
                energies.append(float(_np.sum(wl ** 2) + _np.sum(wr ** 2)))
        # 尾は残りつつ、時間とともに減衰する
        self.assertGreater(energies[0], 0.0)
        self.assertLess(energies[-1], energies[0])


if __name__ == "__main__":
    unittest.main()
