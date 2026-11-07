# -*- coding: utf-8 -*-
"""ボイスチェンジャー（core/vc/voicechanger/entry.py）のテスト（監査 #9）。

実音声／Discord 接続なしで検証できる部分:
WSOLA ピッチシフターの入出力形状、待機バッファの状態遷移、
バッファ設定の検証ロジック、_changer_impl の振り分け。
"""
import struct
import types
import unittest
from unittest.mock import AsyncMock

import numpy as np

from cogs.vc import (
    CHUNK_BYTES,
    FRAME_SIZE,
    AdaptiveWSOLAPitchShifter,
    VoiceChangerCog,
    WaitAndConnectAudioSource,
)


def _pcm(frames, value=1000):
    return np.full((frames, 2), value, dtype=np.int16).tobytes()


class PitchShifterTests(unittest.TestCase):
    def setUp(self):
        self.shifter = AdaptiveWSOLAPitchShifter()

    def test_empty_input_returned_as_is(self):
        self.assertEqual(self.shifter.process(b"", 5.0), b"")

    def test_zero_semitones_preserves_length_and_signal(self):
        src = _pcm(960, 1234)
        out = self.shifter.process(src, 0)
        self.assertEqual(len(out), len(src))
        samples = np.frombuffer(out, dtype=np.int16).astype(np.int32)
        # float 往復（/32768 → ×32767）のため ±1 LSB の誤差は許容する
        self.assertTrue(np.all(np.abs(samples - 1234) <= 1))

    def test_pitch_shift_keeps_frame_count(self):
        src = _pcm(960, 800)
        for semitones in (12.0, -12.0, 5.0):
            out = self.shifter.process(src, semitones)
            self.assertEqual(len(out), len(src), f"semitones={semitones}")
            self.assertEqual(len(out) % FRAME_SIZE, 0)

    def test_silence_stays_silent_when_shifted(self):
        out = self.shifter.process(_pcm(960, 0), 7.0)
        self.assertTrue(np.all(np.frombuffer(out, dtype=np.int16) == 0))

    def test_mark_gap_resets_tail_flag(self):
        self.shifter.process(_pcm(960), 0)
        self.assertFalse(self.shifter.reset_tail)
        self.shifter.mark_gap()
        self.assertTrue(self.shifter.reset_tail)


class WaitAndConnectBufferTests(unittest.TestCase):
    def test_ms_to_frame_bytes_alignment(self):
        f = WaitAndConnectAudioSource._ms_to_frame_bytes
        self.assertEqual(f(20.0), int(0.020 * 48000) * FRAME_SIZE)
        self.assertEqual(f(0.0), FRAME_SIZE)  # 最小 1 フレーム
        self.assertEqual(f(33.3) % FRAME_SIZE, 0)

    def test_starts_waiting_and_read_returns_silence(self):
        src = WaitAndConnectAudioSource()
        self.assertTrue(src.is_waiting_for_data)
        out = src.read()
        self.assertEqual(len(out), CHUNK_BYTES)
        self.assertTrue(np.all(np.frombuffer(out, dtype=np.int16) == 0))
        self.assertEqual(src.underrun_count, 0)  # 再生開始前は数えない

    def test_feed_below_target_keeps_waiting(self):
        src = WaitAndConnectAudioSource(target_buffer_ms=40.0, max_buffer_ms=80.0)
        src.feed(_pcm(480))  # 10ms 分 < 目標 40ms
        self.assertTrue(src.is_waiting_for_data)

    def test_feed_reaching_target_then_read_returns_audio(self):
        src = WaitAndConnectAudioSource(target_buffer_ms=20.0, max_buffer_ms=40.0)
        src.feed(_pcm(960, 2000))  # ちょうど 20ms
        self.assertFalse(src.is_waiting_for_data)
        out = src.read()
        self.assertEqual(len(out), CHUNK_BYTES)
        samples = np.frombuffer(out, dtype=np.int16).reshape(-1, 2)
        # 復帰直後はフェードインするが、末尾は元の信号に一致する
        self.assertTrue(np.all(samples[-1] == 2000))

    def test_underrun_after_playback_counts_and_waits(self):
        src = WaitAndConnectAudioSource(target_buffer_ms=20.0, max_buffer_ms=40.0)
        src.feed(_pcm(960, 1500))
        src.read()
        out = src.read()  # バッファ切れ → 無音 + アンダーラン計上
        self.assertEqual(len(out), CHUNK_BYTES)
        self.assertEqual(src.underrun_count, 1)
        self.assertTrue(src.is_waiting_for_data)

    def test_overflow_is_trimmed_to_max_buffer(self):
        src = WaitAndConnectAudioSource(target_buffer_ms=20.0, max_buffer_ms=40.0)
        src.feed(_pcm(960 * 4, 1000))  # 80ms 分 > 上限 40ms
        self.assertLessEqual(len(src._buffer), src.max_buffer_bytes)
        self.assertAlmostEqual(src.buffered_ms, 40.0, places=1)

    def test_update_settings_recalculates_bytes(self):
        src = WaitAndConnectAudioSource()
        src.update_settings(target_buffer_ms=60.0, max_buffer_ms=120.0)
        self.assertEqual(src.target_buffer_ms, 60.0)
        self.assertEqual(src.target_prebuffer_bytes, int(0.060 * 48000) * FRAME_SIZE)
        self.assertEqual(src.max_buffer_bytes, int(0.120 * 48000) * FRAME_SIZE)
        src.update_settings()  # None は無変更
        self.assertEqual(src.target_buffer_ms, 60.0)

    def test_is_opus_false(self):
        self.assertFalse(WaitAndConnectAudioSource().is_opus())


class ResolveBufferTests(unittest.TestCase):
    resolve = staticmethod(VoiceChangerCog._resolve_buffer)

    def test_defaults_from_current(self):
        target, resolved_max, error = self.resolve(20.0, None, None)
        self.assertEqual((target, resolved_max), (20.0, 40.0))
        self.assertIsNone(error)

    def test_explicit_values(self):
        target, resolved_max, error = self.resolve(20.0, 30.0, 90.0)
        self.assertEqual((target, resolved_max), (30.0, 90.0))
        self.assertIsNone(error)

    def test_target_below_minimum_rejected(self):
        target, resolved_max, error = self.resolve(20.0, 10.0, None)
        self.assertIsNone(target)
        self.assertIn("20ms以上", error)

    def test_max_below_target_rejected(self):
        target, resolved_max, error = self.resolve(50.0, None, 30.0)
        self.assertIsNone(target)
        self.assertIn("目標バッファ以上", error)


class _FakeResponder:
    def __init__(self, guild_id=1):
        self.guild = types.SimpleNamespace(id=guild_id)
        self.user = types.SimpleNamespace(id=9, voice=None)
        self.channel = types.SimpleNamespace(id=3)
        self.sent = []

    async def send(self, embed=None, ephemeral=False, **kwargs):
        self.sent.append((embed, ephemeral))

    async def defer(self):
        pass


def _cog(sessions=None):
    cog = VoiceChangerCog.__new__(VoiceChangerCog)
    cog.bot = types.SimpleNamespace()
    cog.vc_sessions = sessions if sessions is not None else {}
    cog.voice_sessions = types.SimpleNamespace(release=AsyncMock(return_value=True))
    return cog


class ChangerImplDispatchTests(unittest.IsolatedAsyncioTestCase):
    async def test_stop_without_session_warns(self):
        cog = _cog()
        r = _FakeResponder()
        await cog._changer_impl(r, "stop")
        self.assertIn("実行されていません", r.sent[0][0].description)
        self.assertTrue(r.sent[0][1])

    async def test_start_while_running_without_options_warns(self):
        cog = _cog({1: {"sink": object(), "vc": object()}})
        r = _FakeResponder()
        await cog._changer_impl(r, "start")
        self.assertIn("既にボイスチェンジャーが実行中です", r.sent[0][0].description)

    async def test_options_without_session_warns(self):
        cog = _cog()
        r = _FakeResponder()
        await cog._changer_impl(r, "status", pitch=3.0)
        self.assertIn("開始されていません", r.sent[0][0].description)

    async def test_status_without_session_reports_stopped(self):
        cog = _cog()
        r = _FakeResponder()
        await cog._changer_impl(r, "status")
        self.assertIn("停止中", r.sent[0][0].description)

    async def test_apply_rejects_bad_buffer(self):
        src = WaitAndConnectAudioSource()
        sink = types.SimpleNamespace(audio_source=src, set_semitones=lambda v: None)
        cog = _cog({1: {"sink": sink, "vc": object()}})
        r = _FakeResponder()
        await cog._changer_impl(r, "status", buffer_ms=5.0)
        self.assertIn("20ms以上", r.sent[0][0].description)

    async def test_apply_updates_settings(self):
        src = WaitAndConnectAudioSource()
        applied = []
        sink = types.SimpleNamespace(audio_source=src, set_semitones=applied.append)
        cog = _cog({1: {"sink": sink, "vc": object()}})
        r = _FakeResponder()
        await cog._changer_impl(r, "status", pitch=2.0, buffer_ms=30.0)
        self.assertEqual(applied, [2.0])
        self.assertEqual(src.target_buffer_ms, 30.0)
        self.assertIn("設定を変更しました", r.sent[0][0].description)


if __name__ == "__main__":
    unittest.main()
