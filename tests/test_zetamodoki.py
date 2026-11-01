import unittest
from unittest.mock import AsyncMock, patch

from cogs.zetamodoki import (
    ChatButtonView,
    CharacterSelectView,
    PRESETS,
    SessionModeSelect,
    ZetaModoki,
)


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
            result = await cog._generate_response(
                123, "本が好き？", on_delta=collect_delta, requester_id=7
            )

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
        self.assertNotIn(123, cog.failed_requests)

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
            result = await cog._generate_response(123, "こんにちは", requester_id=7)

        self.assertIn("AIから返答がありませんでした", result)
        self.assertEqual(cog.chat_histories[123], [])
        self.assertEqual(cog.failed_requests[123], {"user_id": 7, "user_input": "こんにちは"})

    async def test_error_is_available_for_the_original_user_to_retry(self):
        cog = ZetaModoki(bot=None)
        cog.active_personas[123] = PRESETS["alice"]
        cog.chat_histories[123] = []

        async def failing_stream(*args, **kwargs):
            raise RuntimeError("temporary error")
            yield ""

        with patch("cogs.zetamodoki.logfare.chat_stream", new=failing_stream):
            result = await cog._generate_response(123, "もう一度", requester_id=99)

        self.assertIn("temporary error", result)
        self.assertEqual(cog.failed_requests[123], {"user_id": 99, "user_input": "もう一度"})

    async def test_views_show_only_relevant_buttons(self):
        cog = ZetaModoki(bot=None)
        public = ChatButtonView(cog)
        public_error = ChatButtonView(cog, retry_owner_id=1, retry_input="失敗した入力")
        private = ChatButtonView(cog, private_thread=True)
        private_error = ChatButtonView(
            cog, retry_owner_id=1, retry_input="失敗した入力", private_thread=True
        )

        self.assertEqual([item.label for item in public.children], ["返信する"])
        self.assertEqual([item.label for item in public_error.children], ["返信する", "再試行"])
        self.assertEqual([item.label for item in private.children], ["返信する", "このスレッドを削除"])
        self.assertEqual(
            [item.label for item in private_error.children],
            ["返信する", "再試行", "このスレッドを削除"],
        )

        selection = CharacterSelectView(cog)
        mode_menu = next(item for item in selection.children if isinstance(item, SessionModeSelect))
        self.assertEqual([option.value for option in mode_menu.options], ["public", "private"])

    async def test_split_messages_have_controls_only_on_the_last_part(self):
        cog = ZetaModoki(bot=None)
        cog.active_personas[123] = PRESETS["alice"]

        class FakeWebhook:
            def __init__(self):
                self.calls = []

            async def send(self, **kwargs):
                self.calls.append(kwargs)
                return object()

        webhook = FakeWebhook()
        with patch.object(cog, "_get_or_create_webhook", new=AsyncMock(return_value=webhook)):
            sent = await cog._send_webhook_message(object(), 123, "あ" * 1801)

        self.assertEqual(len(sent), 2)
        self.assertIsNone(webhook.calls[0]["view"])
        self.assertIsInstance(webhook.calls[1]["view"], ChatButtonView)
        self.assertTrue(all(call["wait"] for call in webhook.calls))

        webhook.calls.clear()
        with patch.object(cog, "_get_or_create_webhook", new=AsyncMock(return_value=webhook)):
            await cog._send_webhook_message(object(), 123, "あ" * 1801, include_view=False)
        self.assertTrue(all(call["view"] is None for call in webhook.calls))

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
