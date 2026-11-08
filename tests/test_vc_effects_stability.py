# -*- coding: utf-8 -*-
"""やまびこ（echo）とボイスチェンジャーの安定化テスト。

Discord には接続しない。対象:
- RecordingSink(echo): 再生ループが1本だけ、play 失敗時の自己修復、cleanup で停止
- VoiceChangerSink: write の例外ガード、play の自己修復、ウォッチドッグ停止
- AdaptiveWSOLAPitchShifter: 長さ保存・フレーム不整合入力でも例外なし
"""

import asyncio
import os
import sys
import time
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

for _name, _value in {'BOT_API_BASE_URL': 'http://127.0.0.1:8787', 'BOT_API_KEY': 'dummy-key'}.items():
    os.environ.setdefault(_name, _value)

CHUNK = 3840  # 20ms 分の PCM (48kHz ステレオ 16bit)


class FakeVC:
    def __init__(self, fail_play=False):
        self._playing = False
        self.fail_play = fail_play
        self.played_source = None

    def is_connected(self):
        return True

    def is_playing(self):
        return self._playing

    def play(self, source):
        if self.fail_play:
            raise RuntimeError("already playing")
        self.played_source = source
        self._playing = True

    def stop(self):
        self._playing = False


class FakeBot:
    def __init__(self, loop):
        self.loop = loop


class EchoSinkTest(unittest.IsolatedAsyncioTestCase):
    def make_sink(self, vc):
        from core.vc.rec.sink import RecordingSink

        bot = FakeBot(asyncio.get_running_loop())
        return RecordingSink(bot=bot, vc=vc, is_echo=True, echo_delay=0.05)

    async def test_single_loop_and_play_starts(self):
        vc = FakeVC()
        sink = self.make_sink(vc)
        try:
            self.assertEqual(len(sink._echo_tasks), 1)
            self.assertIs(vc.played_source, sink.echo_source)
            self.assertTrue(sink.playback_active)
        finally:
            sink.cleanup()
            await asyncio.sleep(0.02)

    async def test_play_failure_self_heals_on_due_packet(self):
        vc = FakeVC(fail_play=True)
        sink = self.make_sink(vc)
        try:
            self.assertGreaterEqual(sink._play_error_count, 1)
            self.assertFalse(sink.playback_active)
            vc.fail_play = False
            sink.packet_queue.append((time.time() - 1.0, b"\x01" * CHUNK))
            await asyncio.sleep(0.06)
            self.assertTrue(vc.is_playing())
            self.assertEqual(sink.echo_source.read(), b"\x01" * CHUNK)
        finally:
            sink.cleanup()
            await asyncio.sleep(0.02)

    async def test_cleanup_cancels_loop(self):
        sink = self.make_sink(FakeVC())
        tasks = list(sink._echo_tasks)
        sink.cleanup()
        await asyncio.sleep(0.02)
        self.assertTrue(all(t.cancelled() or t.done() for t in tasks))
        self.assertEqual(sink._echo_tasks, [])

    async def test_recording_sink_has_no_echo_loop(self):
        from core.vc.rec.sink import RecordingSink

        sink = RecordingSink(bot=FakeBot(asyncio.get_running_loop()), vc=FakeVC())
        self.assertIsNone(sink.echo_source)
        self.assertEqual(sink._echo_tasks, [])


class ChangerSinkTest(unittest.IsolatedAsyncioTestCase):
    def make_sink(self, vc):
        from core.vc.voicechanger.sink import VoiceChangerSink

        bot = FakeBot(asyncio.get_running_loop())
        return VoiceChangerSink(bot=bot, vc=vc, semitones=5.0)

    async def test_play_failure_then_ensure_playing_recovers(self):
        vc = FakeVC(fail_play=True)
        sink = self.make_sink(vc)
        try:
            self.assertGreaterEqual(sink._play_error_count, 1)
            self.assertFalse(sink.playback_active)
            vc.fail_play = False
            sink._ensure_playing()
            self.assertTrue(vc.is_playing())
            self.assertIs(vc.played_source, sink.audio_source)
        finally:
            sink.cleanup()
            await asyncio.sleep(0.02)

    async def test_write_swallows_processing_errors(self):
        sink = self.make_sink(FakeVC())
        try:
            sink._resolve_pcm = lambda user_id, data: b"\x00" * CHUNK

            def boom(pcm, pitch):
                raise RuntimeError("shifter died")

            sink.shifter.process = boom
            data = types.SimpleNamespace(opus=b"\xf8\xff\xfe")
            sink.write(types.SimpleNamespace(id=7), data)  # 例外が伝播しないこと
            self.assertEqual(sink.error_count, 1)
            self.assertEqual(len(sink.audio_source._buffer), 0)
        finally:
            sink.cleanup()
            await asyncio.sleep(0.02)

    async def test_write_feeds_source_on_success(self):
        sink = self.make_sink(FakeVC())
        try:
            sink._resolve_pcm = lambda user_id, data: b"\x00" * CHUNK
            sink.shifter.process = lambda pcm, pitch: pcm
            data = types.SimpleNamespace(opus=b"\xf8\xff\xfe")
            sink.write(types.SimpleNamespace(id=7), data)
            self.assertEqual(sink.error_count, 0)
            self.assertEqual(len(sink.audio_source._buffer), CHUNK)
        finally:
            sink.cleanup()
            await asyncio.sleep(0.02)

    async def test_cleanup_cancels_watchdog(self):
        sink = self.make_sink(FakeVC())
        task = sink._watchdog_task
        self.assertIsNotNone(task)
        sink.cleanup()
        await asyncio.sleep(0.02)
        self.assertTrue(task.cancelled() or task.done())
        self.assertIsNone(sink._watchdog_task)


class ShifterTest(unittest.TestCase):
    def setUp(self):
        from core.vc.voicechanger.shifter import AdaptiveWSOLAPitchShifter

        self.shifter = AdaptiveWSOLAPitchShifter()

    def test_zero_pitch_preserves_length_and_silence(self):
        out = self.shifter.process(b"\x00" * CHUNK, 0.0)
        self.assertEqual(out, b"\x00" * CHUNK)

    def test_pitch_shift_preserves_frame_length(self):
        # 簡単な正弦波っぽい入力
        pcm = b"".join(int(10000 * ((i % 48) / 48.0 - 0.5)).to_bytes(2, "little", signed=True)
                       for i in range(CHUNK // 2))
        out_up = self.shifter.process(pcm, 12.0)
        self.assertEqual(len(out_up), CHUNK)
        out_down = self.shifter.process(pcm, -12.0)
        self.assertEqual(len(out_down), CHUNK)

    def test_unaligned_input_does_not_raise(self):
        out = self.shifter.process(b"\x00" * (CHUNK + 1), 5.0)
        self.assertEqual(len(out) % 4, 0)
        self.assertLessEqual(len(out), CHUNK)

    def test_mark_gap_then_process(self):
        self.shifter.process(b"\x00" * CHUNK, 3.0)
        self.shifter.mark_gap()
        out = self.shifter.process(b"\x00" * CHUNK, 3.0)
        self.assertEqual(len(out), CHUNK)


class WaitSourceTest(unittest.TestCase):
    def test_feed_then_read_and_underrun_silence(self):
        from core.vc.voicechanger.source import WaitAndConnectAudioSource

        source = WaitAndConnectAudioSource()
        self.assertEqual(source.read(), b"\x00" * CHUNK)  # データなしは無音
        source.feed(b"\x02" * CHUNK)
        chunk = source.read()
        self.assertEqual(len(chunk), CHUNK)
        self.assertIn(b"\x02", chunk)


if __name__ == "__main__":
    unittest.main()
