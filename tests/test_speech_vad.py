import unittest

import numpy as np

from core.speech_vad import FRAME_BYTES, SpeechDetector


class SpeechDetectorTest(unittest.TestCase):
    @staticmethod
    def pcm_frame(amplitude: int, frequency: int = 180) -> bytes:
        rate = 48_000
        t = np.arange(rate // 50, dtype=np.float32) / rate
        mono = (amplitude * np.sin(2 * np.pi * frequency * t)
                + amplitude * 0.25 * np.sin(2 * np.pi * frequency * 2 * t)).astype(np.int16)
        return np.column_stack((mono, mono)).ravel().tobytes()

    def test_silence_and_very_quiet_background_do_not_start_transcription(self):
        detector = SpeechDetector(aggressiveness=3)
        self.assertFalse(detector.has_speech(self.pcm_frame(0)))
        detector.reset()
        self.assertFalse(detector.has_speech(self.pcm_frame(50)))

    def test_voice_like_audio_is_detected_and_not_text_filtered(self):
        detector = SpeechDetector(aggressiveness=2)
        self.assertTrue(detector.has_speech(self.pcm_frame(700)))

    def test_partial_audio_frames_are_buffered_until_vad_frame_is_complete(self):
        frame = self.pcm_frame(700)
        self.assertEqual(len(frame), FRAME_BYTES * 6)
        detector = SpeechDetector(aggressiveness=2)
        self.assertFalse(detector.has_speech(frame[:len(frame) // 2]))
        self.assertTrue(detector.has_speech(frame[len(frame) // 2:]))

    def test_reset_discards_partial_audio_after_packet_gap(self):
        frame = self.pcm_frame(700)
        detector = SpeechDetector(aggressiveness=2)
        self.assertFalse(detector.has_speech(frame[:100]))
        detector.reset()
        self.assertFalse(detector.has_speech(frame[:100]))

    def test_user_buffer_does_not_start_on_silence(self):
        from cogs.sio_transcription import UserAudioBuffer

        buffer = UserAudioBuffer(1, "speaker")
        silence = self.pcm_frame(0)
        for _ in range(30):
            buffer.append(silence)
        self.assertFalse(buffer.is_speaking)
        self.assertIsNone(buffer.pop_audio())

    def test_user_buffer_accepts_voice_without_text_based_rejection(self):
        from cogs.sio_transcription import UserAudioBuffer

        buffer = UserAudioBuffer(1, "speaker")
        voice = self.pcm_frame(700)
        for index in range(20):
            buffer.append(self.pcm_frame(700, 100 + 30 * (index % 5)))
        self.assertTrue(buffer.is_speaking)
        audio = buffer.pop_audio()
        self.assertIsNotNone(audio)
        self.assertGreaterEqual(audio[1], 6)


if __name__ == "__main__":
    unittest.main()
