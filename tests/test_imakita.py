import types
import unittest
from unittest.mock import AsyncMock, patch

import httpx
from groq import NotFoundError, RateLimitError
from cogs.imakita import FAILURE_MESSAGE, MODEL, ImakitaSummaryCog


class FakeChannel:
    def __init__(self, messages):
        self.id = 10
        self.messages = messages

    async def history(self, *, limit):
        self.requested_limit = limit
        for message in self.messages:
            yield message


class FakeMessage:
    def __init__(self, message_id, content, name="user", *, bot=False):
        self.id = message_id
        self.content = content
        self.author = types.SimpleNamespace(display_name=name, bot=bot)
        self.reply = AsyncMock()


class ImakitaSummaryTest(unittest.IsolatedAsyncioTestCase):
    def make_client(self, result=None, error=None):
        create = AsyncMock(side_effect=error) if error else AsyncMock(return_value=result)
        client = types.SimpleNamespace(
            chat=types.SimpleNamespace(completions=types.SimpleNamespace(create=create))
        )
        return client, create

    def completion(self, text):
        return types.SimpleNamespace(
            choices=[types.SimpleNamespace(message=types.SimpleNamespace(content=text))]
        )

    async def test_trigger_summarizes_recent_non_bot_chat_in_chronological_order(self):
        trigger = FakeMessage(3, "今北産業", "asker")
        newest = FakeMessage(2, "新しい話題", "alice")
        oldest = FakeMessage(1, "最初の話題", "bob")
        bot_message = FakeMessage(4, "bot output", "bot", bot=True)
        channel = FakeChannel([trigger, newest, oldest, bot_message])
        trigger.channel = channel
        client, create = self.make_client(self.completion("・話題は最初の話題から新しい話題へ移行。\n・決定事項なし。"))
        cog = ImakitaSummaryCog(types.SimpleNamespace(command_prefix="!"), client=client, clock=lambda: 100)

        await cog.on_message(trigger)

        create.assert_awaited_once()
        kwargs = create.await_args.kwargs
        self.assertEqual(kwargs["model"], MODEL)
        self.assertEqual(kwargs["max_completion_tokens"], 220)
        self.assertEqual(kwargs["reasoning_effort"], "low")
        prompt = kwargs["messages"][1]["content"]
        self.assertLess(prompt.index("bob: 最初の話題"), prompt.index("alice: 新しい話題"))
        self.assertNotIn("今北産業", prompt)
        self.assertNotIn("bot output", prompt)
        trigger.reply.assert_awaited_once()
        self.assertIn("・話題は最初", trigger.reply.await_args.args[0])

    async def test_api_error_details_are_not_sent_to_the_channel(self):
        trigger = FakeMessage(3, "今北産業")
        trigger.channel = FakeChannel([trigger, FakeMessage(1, "最近の会話")])
        client, _ = self.make_client(error=RuntimeError("HTTP 429 rate limit details"))
        cog = ImakitaSummaryCog(types.SimpleNamespace(command_prefix="!"), client=client, clock=lambda: 100)

        with self.assertLogs("cogs.imakita", level="ERROR"):
            await cog.on_message(trigger)

        trigger.reply.assert_awaited_once_with(FAILURE_MESSAGE, mention_author=False)
        self.assertNotIn("429", trigger.reply.await_args.args[0])

    async def test_groq_404_and_429_use_generic_user_message(self):
        for status, error_type in ((404, NotFoundError), (429, RateLimitError)):
            with self.subTest(status=status):
                trigger = FakeMessage(3, "今北産業")
                trigger.channel = FakeChannel([trigger, FakeMessage(1, "最近の会話")])
                response = httpx.Response(status, request=httpx.Request("POST", "https://api.groq.com"))
                error = error_type(
                    f"technical status {status}", response=response,
                    body={"error": {"message": f"private detail {status}"}},
                )
                client, _ = self.make_client(error=error)
                cog = ImakitaSummaryCog(types.SimpleNamespace(command_prefix="!"), client=client, clock=lambda: 100)

                with self.assertLogs("cogs.imakita", level="WARNING"):
                    await cog.on_message(trigger)

                trigger.reply.assert_awaited_once_with(FAILURE_MESSAGE, mention_author=False)
                self.assertNotIn(str(status), trigger.reply.await_args.args[0])

    async def test_messages_without_trigger_are_ignored(self):
        message = FakeMessage(5, "普通のメッセージ")
        message.channel = FakeChannel([])
        client, create = self.make_client(self.completion("unused"))
        cog = ImakitaSummaryCog(types.SimpleNamespace(command_prefix="!"), client=client, clock=lambda: 100)

        await cog.on_message(message)

        create.assert_not_awaited()
        message.reply.assert_not_awaited()

    async def test_missing_api_key_uses_generic_message(self):
        trigger = FakeMessage(3, "今北産業")
        trigger.channel = FakeChannel([])
        cog = ImakitaSummaryCog(types.SimpleNamespace(command_prefix="!"), client=None, clock=lambda: 100)
        cog.client = None

        await cog.on_message(trigger)

        trigger.reply.assert_awaited_once_with(FAILURE_MESSAGE, mention_author=False)

    async def test_english_server_does_not_run_japanese_summary(self):
        trigger = FakeMessage(3, "今北産業")
        trigger.channel = FakeChannel([trigger, FakeMessage(1, "recent English chat")])
        trigger.guild = types.SimpleNamespace(id=99)
        client, create = self.make_client(self.completion("should not be used"))
        cog = ImakitaSummaryCog(types.SimpleNamespace(command_prefix="!"), client=client, clock=lambda: 100)

        with patch("cogs.imakita.guild_locale", return_value="en"):
            await cog.on_message(trigger)

        create.assert_not_awaited()
        trigger.reply.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
