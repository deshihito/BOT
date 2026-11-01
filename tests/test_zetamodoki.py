import unittest
from unittest.mock import patch

from cogs.zetamodoki import ZetaModoki, PRESETS


class ZetaModokiLogfareTests(unittest.IsolatedAsyncioTestCase):
    async def test_logfare_receives_persona_and_ordered_conversation_history(self):
        cog = ZetaModoki(bot=None)
        cog.active_personas[123] = PRESETS["alice"]
        cog.chat_histories[123] = [{"user": "雨が強いね", "bot": "そうですね。"}]
        request = {}
        sent_deltas = []

        async def fake_stream(model, messages, *, max_tokens):
            request.update(model=model, messages=messages, max_tokens=max_tokens)
            yield "窓の外を"
            yield "見ます。"

        async def collect_delta(delta):
            sent_deltas.append(delta)

        with patch("cogs.zetamodoki.logfare.chat_stream", new=fake_stream):
            result = await cog._generate_response(123, "本が好き？", on_delta=collect_delta)

        self.assertEqual(result, "窓の外を見ます。")
        self.assertEqual(request["model"], "gemma-4-26b")
        self.assertEqual(request["messages"][0], {
            "role": "system",
            "content": PRESETS["alice"].build_system_instruction(),
        })
        self.assertEqual(request["messages"][1], {
            "role": "assistant",
            "content": PRESETS["alice"].first_message,
        })
        self.assertEqual(request["messages"][2:], [
            {"role": "user", "content": "雨が強いね"},
            {"role": "assistant", "content": "そうですね。"},
            {"role": "user", "content": "本が好き？"},
        ])
        self.assertEqual(request["max_tokens"], 2400)
        self.assertEqual(sent_deltas, ["窓の外を", "見ます。"])
        self.assertEqual(cog.chat_histories[123][-1], {
            "user": "本が好き？", "bot": "窓の外を見ます。"
        })

    async def test_model_can_be_overridden_for_this_feature(self):
        with patch.dict("os.environ", {"LOGFARE_ZETAMODOKI_MODEL": "model-x"}):
            cog = ZetaModoki(bot=None)
        self.assertEqual(cog.model_name, "model-x")

    async def test_empty_model_reply_does_not_add_an_invalid_turn(self):
        cog = ZetaModoki(bot=None)
        cog.active_personas[123] = PRESETS["alice"]
        cog.chat_histories[123] = []

        async def empty_stream(*args, **kwargs):
            if False:
                yield ""

        with patch("cogs.zetamodoki.logfare.chat_stream", new=empty_stream):
            result = await cog._generate_response(123, "こんにちは")

        self.assertIn("AIから返答がありませんでした", result)
        self.assertEqual(cog.chat_histories[123], [])

    def test_discord_content_is_split_without_losing_characters(self):
        text = ("あ" * 1801) + "。" + ("い" * 1900)
        parts = ZetaModoki._split_long_message(text)
        self.assertTrue(all(len(part) <= 1800 for part in parts))
        self.assertEqual("".join(parts), text)

    def test_stream_flushes_a_completed_sentence(self):
        text = "今日は雨が降っていますが、あなたとここで話せるのは少し嬉しいです。晴れの日にも、またこうしてゆっくり話せたらいいなと思います。まだ続きます"
        cut = ZetaModoki._ready_stream_cut(text)
        self.assertIsNotNone(cut)
        self.assertTrue(text[:cut].endswith("。"))


if __name__ == "__main__":
    unittest.main()
