import unittest

from core import logfare


class TranscriptionHallucinationTest(unittest.TestCase):
    def test_detects_common_japanese_outro_hallucinations(self):
        for text in (
            "ご視聴ありがとうございました",
            "ご視聴ありがとうございました。",
            "またお会いしましょう！",
            "ご視聴ありがとうございました。またお会いしましょう。",
            "ご視聴ありがとうございました。ご視聴ありがとうございました。",
            "ご覧いただきありがとうございました！",
        ):
            with self.subTest(text=text):
                self.assertTrue(logfare.is_likely_transcription_hallucination(text))

    def test_keeps_normal_speech_even_if_it_mentions_an_outro_phrase(self):
        self.assertFalse(logfare.is_likely_transcription_hallucination(
            "司会者がご視聴ありがとうございましたと言っていました"
        ))
        self.assertFalse(logfare.is_likely_transcription_hallucination("今日はいい天気ですね"))
        self.assertFalse(logfare.is_likely_transcription_hallucination(""))


if __name__ == "__main__":
    unittest.main()
