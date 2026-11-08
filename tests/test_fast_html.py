# -*- coding: utf-8 -*-
"""fastHTML（Bot 側: core/general/fast_html.py）のテスト。

添付検証・API クライアントのエラー変換・待ちフローの分岐を、
Discord / 実 API に接続せず偽オブジェクトで確かめる。
"""
import asyncio
import os
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

os.environ.setdefault("BOT_API_BASE_URL", "http://127.0.0.1:8787")
os.environ.setdefault("BOT_API_KEY", "test-key")

from core.general import fast_html
from core.general.fast_html import (
    FAST_HTML_MAX_BYTES,
    FastHtmlApiError,
    FastHtmlMixin,
    FastHtmlResultView,
    _fast_html_attachment,
    fast_html_api_create,
    fast_html_api_delete,
    fast_html_attachment_error,
    fast_html_public_url,
)


class _Att:
    def __init__(self, filename="page.html", size=100, data=b"<html></html>"):
        self.filename = filename
        self.size = size
        self._data = data

    async def read(self):
        return self._data


class _Msg:
    def __init__(self, attachments):
        self.attachments = attachments


class AttachmentTest(unittest.TestCase):
    def test_picks_html_and_htm_case_insensitive(self):
        att = _Att("PAGE.HTML")
        self.assertIs(_fast_html_attachment(_Msg([_Att("a.png"), att])), att)
        att2 = _Att("x.htm")
        self.assertIs(_fast_html_attachment(_Msg([att2])), att2)

    def test_skips_non_html(self):
        self.assertIsNone(_fast_html_attachment(_Msg([_Att("a.png")])))
        self.assertIsNone(_fast_html_attachment(_Msg([])))

    def test_size_limit_precheck(self):
        self.assertIsNone(fast_html_attachment_error(_Att(size=FAST_HTML_MAX_BYTES)))
        error = fast_html_attachment_error(_Att(size=FAST_HTML_MAX_BYTES + 1))
        self.assertIn("大きすぎます", error)

    def test_public_url(self):
        self.assertEqual(
            fast_html_public_url("abc123"), "https://fast.agobot.app/fast/abc123",
        )


class _FakeResponse:
    def __init__(self, status_code, body):
        self.status_code = status_code
        self._body = body
        self.ok = 200 <= status_code < 300

    def json(self):
        return self._body


class ApiClientTest(unittest.TestCase):
    def test_create_returns_data(self):
        fake = _FakeResponse(200, {"data": {"token": "tok", "expires_at": 1, "size": 3}})
        with patch("requests.request", return_value=fake) as req:
            result = fast_html_api_create("a.html", 42, b"abc")
        self.assertEqual(result["token"], "tok")
        args, kwargs = req.call_args
        self.assertEqual(args[0], "POST")
        self.assertTrue(args[1].endswith("/v1/fast"))
        self.assertEqual(kwargs["json"]["owner_id"], "42")

    def test_create_maps_limit_error(self):
        fake = _FakeResponse(429, {"detail": {"code": "FASTHTML_LIMIT", "message": "x"}})
        with patch("requests.request", return_value=fake):
            with self.assertRaises(FastHtmlApiError) as ctx:
                fast_html_api_create("a.html", 42, b"abc")
        self.assertEqual(ctx.exception.code, "FASTHTML_LIMIT")
        self.assertEqual(ctx.exception.status_code, 429)

    def test_delete_404_is_false_not_error(self):
        fake = _FakeResponse(404, {"detail": {"code": "NOT_FOUND", "message": "x"}})
        with patch("requests.request", return_value=fake):
            self.assertFalse(fast_html_api_delete("tok", 42))

    def test_not_configured(self):
        with patch.dict(os.environ, {"BOT_API_BASE_URL": "", "BOT_API_KEY": ""}):
            with self.assertRaises(FastHtmlApiError) as ctx:
                fast_html_api_create("a.html", 42, b"abc")
        self.assertEqual(ctx.exception.code, "API_NOT_CONFIGURED")


class _FakeUser:
    def __init__(self, user_id):
        self.id = user_id


class _FakeChannel:
    def __init__(self, channel_id):
        self.id = channel_id


class _FakeMessage:
    def __init__(self, user_id, channel_id, attachments):
        self.author = _FakeUser(user_id)
        self.channel = _FakeChannel(channel_id)
        self.attachments = attachments
        self.replies = []

    async def reply(self, *args, **kwargs):
        self.replies.append((args, kwargs))


class _FakeInteraction:
    def __init__(self, user_id=42, channel_id=7):
        self.user = _FakeUser(user_id)
        self.channel = _FakeChannel(channel_id)
        self.response = MagicMock()
        self.response.send_message = AsyncMock()
        self.edit_original_response = AsyncMock()


class _Harness(FastHtmlMixin):
    def __init__(self, bot):
        self.bot = bot
        self._fast_html_waits = {}
        self._fast_html_last_issue = {}
        self.spawned = []

    def _spawn(self, coro):
        self.spawned.append(coro)


class FlowTest(unittest.IsolatedAsyncioTestCase):
    async def _run(self, harness, interaction):
        await harness._fast_html_start(interaction)
        self.assertEqual(len(harness.spawned), 1)
        await harness.spawned[0]

    async def test_success_posts_result_with_view(self):
        att = _Att()
        message = _FakeMessage(42, 7, [att])

        class Bot:
            async def wait_for(self, event, check=None):
                assert check(message)
                return message

        harness = _Harness(Bot())
        interaction = _FakeInteraction()
        created = {"token": "t" * 32, "expires_at": 1899999999, "size": 10}
        with patch.object(fast_html, "fast_html_api_create", return_value=created) as create:
            await self._run(harness, interaction)
        create.assert_called_once()
        self.assertEqual(len(message.replies), 1)
        _args, kwargs = message.replies[0]
        self.assertIsInstance(kwargs["view"], FastHtmlResultView)
        self.assertEqual(kwargs["view"].token, "t" * 32)
        embed = kwargs["embed"]
        self.assertEqual(embed.fields[0].value, "page.html")
        # 待ちセッションは掃除される
        self.assertEqual(harness._fast_html_waits, {})

    async def test_oversize_attachment_ends_with_message(self):
        att = _Att(size=FAST_HTML_MAX_BYTES + 1)
        message = _FakeMessage(42, 7, [att])

        class Bot:
            async def wait_for(self, event, check=None):
                return message

        harness = _Harness(Bot())
        interaction = _FakeInteraction()
        with patch.object(fast_html, "fast_html_api_create") as create:
            await self._run(harness, interaction)
        create.assert_not_called()
        self.assertIn("大きすぎます", message.replies[0][0][0])

    async def test_timeout_edits_guide_message(self):
        class Bot:
            async def wait_for(self, event, check=None):
                await asyncio.sleep(60)

        harness = _Harness(Bot())
        interaction = _FakeInteraction()
        with patch.object(fast_html, "FAST_HTML_WAIT_TIMEOUT", 0.05):
            await self._run(harness, interaction)
        interaction.edit_original_response.assert_awaited()
        content = interaction.edit_original_response.call_args.kwargs["content"]
        self.assertIn("時間切れ", content)

    async def test_second_start_rejected_while_waiting(self):
        harness = _Harness(MagicMock())
        harness._fast_html_waits[(7, 42)] = asyncio.Event()
        interaction = _FakeInteraction()
        interaction.response.send_message = AsyncMock()
        await harness._fast_html_start(interaction)
        text = interaction.response.send_message.call_args.args[0]
        self.assertIn("待ち中", text)
        self.assertEqual(harness.spawned, [])


class RegistryTest(unittest.TestCase):
    def test_genre_and_actions_registered(self):
        from cogs.general import GENERAL_ACTIONS, GENERAL_GENRES

        self.assertIn("make_image", GENERAL_GENRES)
        values = [value for _label, value in GENERAL_ACTIONS["make_image"]]
        self.assertIn("fast_html", values)

    def test_fast_html_blocked_for_ai(self):
        from core.general import action_registry
        from core.general.ai_tools import ai_tools_router

        spec = action_registry.default_registry().get("general:fast_html")
        self.assertIsNotNone(spec)
        self.assertEqual(spec.risk, "blocked")
        candidates = ai_tools_router.action_candidates()
        ids = {
            c["id"] if isinstance(c, dict) else getattr(c, "id", str(c))
            for c in candidates
        }
        self.assertNotIn("general:fast_html", ids)
        self.assertIn("general:fast_html", ai_tools_router.BLOCKED_ACTIONS)


if __name__ == "__main__":
    unittest.main()
