import array
import unittest

from core.voice_media import (
    FRAME_BYTES, SharedAudioSource, SharedReceiveSink, _mix_frames,
    add_audio_source, remove_audio_source,
)


class FakeSource:
    def __init__(self, *frames):
        self.frames = list(frames)
        self.cleaned = False

    def read(self):
        return self.frames.pop(0) if self.frames else b""

    def is_opus(self):
        return False

    def cleanup(self):
        self.cleaned = True


class FakeVoiceClient:
    def __init__(self):
        self.source = None
        self.play_calls = 0
        self.playing = False

    def is_playing(self):
        return self.playing

    def play(self, source, after=None):
        self.source = source
        self.playing = True
        self.play_calls += 1


class FakeReceiveSink:
    def __init__(self):
        self.packets = []
        self.cleaned = False

    def wants_opus(self):
        return True

    def write(self, user, data):
        self.packets.append((user, data))

    def cleanup(self):
        self.cleaned = True


def pcm(value):
    samples = array.array("h", [value] * (FRAME_BYTES // 2))
    return samples.tobytes()


class SharedAudioSourceTest(unittest.TestCase):
    def test_idle_bus_produces_exact_silence_frame(self):
        self.assertEqual(SharedAudioSource().read(), b"\x00" * FRAME_BYTES)

    def test_simultaneous_sources_are_summed_with_headroom(self):
        mixed = array.array("h")
        mixed.frombytes(_mix_frames([pcm(1000), pcm(1000)]))
        self.assertTrue(all(value == 1414 for value in mixed))

    def test_peak_output_is_saturated_to_pcm_range(self):
        mixed = array.array("h")
        mixed.frombytes(_mix_frames([pcm(32767), pcm(32767), pcm(32767), pcm(32767)]))
        self.assertTrue(all(-32768 <= value <= 32767 for value in mixed))

    def test_eof_removes_only_ended_source_and_notifies_callback(self):
        bus = SharedAudioSource()
        ending = FakeSource(pcm(500))
        continuing = FakeSource(pcm(1000), pcm(1000))
        completed = []
        bus.add("tts", ending, completed.append)
        bus.add("music", continuing)

        bus.read()
        bus.read()

        self.assertTrue(ending.cleaned)
        self.assertEqual(completed, [None])
        self.assertTrue(bus.contains("music"))
        self.assertFalse(bus.contains("tts"))

    def test_removing_one_source_does_not_clean_other_layers(self):
        bus = SharedAudioSource()
        music, tts = FakeSource(pcm(1000)), FakeSource(pcm(500))
        bus.add("music", music)
        bus.add("tts", tts)

        self.assertTrue(bus.remove("tts"))
        self.assertTrue(tts.cleaned)
        self.assertFalse(music.cleaned)
        self.assertTrue(bus.contains("music"))

    def test_features_share_one_voice_client_player_and_mix_concurrently(self):
        vc = FakeVoiceClient()
        music, tts = FakeSource(pcm(1000), pcm(1000)), FakeSource(pcm(1000))
        add_audio_source(vc, "music", music)
        add_audio_source(vc, "tts", tts)

        self.assertEqual(vc.play_calls, 1)
        mixed = array.array("h")
        mixed.frombytes(vc.source.read())
        self.assertTrue(all(value == 1414 for value in mixed))
        self.assertTrue(remove_audio_source(vc, "tts"))
        remaining = array.array("h")
        remaining.frombytes(vc.source.read())
        self.assertTrue(all(value == 1000 for value in remaining))
        self.assertFalse(music.cleaned)

    def test_receive_fanout_delivers_the_packet_to_both_sinks(self):
        mux = SharedReceiveSink()
        gvc, transcription = FakeReceiveSink(), FakeReceiveSink()
        mux.add("gvc", gvc)
        mux.add("transcribe", transcription)
        packet = object()
        user = object()

        mux.write(user, packet)

        self.assertEqual(gvc.packets, [(user, packet)])
        self.assertEqual(transcription.packets, [(user, packet)])
        self.assertTrue(mux.remove("transcribe"))
        self.assertTrue(transcription.cleaned)
        self.assertFalse(gvc.cleaned)
        self.assertTrue(mux.remove("gvc"))
        self.assertTrue(gvc.cleaned)


if __name__ == "__main__":
    unittest.main()
