import unittest
from unittest.mock import AsyncMock, patch

from cogs.zetamodoki import ZetaModoki, PRESETS


class ZetaModokiLogfareTests(unittest.IsolatedAsyncioTestCase):
    async def test_logfare_receives_persona_and_ordered_conversation_history(self):
        cog = ZetaModoki(bot=None)
        cog.active_personas[123] = PRESETS["alice"]
        cog.chat_histories[123] = [{"user": "雨が強いね", "bot": "そうですね。"}]

        with patch("cogs.zetamodoki.logfare.chat", new_callable=AsyncMock) as chat:
            chat.return_value = "窓の外を見ます。"
            result = await cog._generate_response(123, "本が好き？")

        self.assertEqual(result, "窓の外を見ます。")
        chat.assert_awaited_once()
        args, kwargs = chat.await_args
        self.assertEqual(args[0], "deepseek-v4.1-flash-1017")
        self.assertEqual(args[1][0], {
            "role": "system",
            "content": PRESETS["alice"].build_system_instruction(),
        })
        self.assertEqual(args[1][1], {
            "role": "assistant",
            "content": PRESETS["alice"].first_message,
        })
        self.assertEqual(args[1][2:], [
            {"role": "user", "content": "雨が強いね"},
            {"role": "assistant", "content": "そうですね。"},
            {"role": "user", "content": "本が好き？"},
        ])
        self.assertEqual(kwargs["max_tokens"], 1200)
        self.assertEqual(cog.chat_histories[123][-1], {
            "user": "本が好き？", "bot": "窓の外を見ます。"
        })

    async def test_model_can_be_overridden_for_this_feature(self):
        with patch.dict("os.environ", {"LOGFARE_ZETAMODOKI_MODEL": "model-x"}):
            cog = ZetaModoki(bot=None)
        self.assertEqual(cog.model_name, "model-x")


if __name__ == "__main__":
    unittest.main()
