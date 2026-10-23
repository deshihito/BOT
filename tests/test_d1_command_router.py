import asyncio
import unittest
from unittest.mock import AsyncMock, patch

import aiohttp

from core import d1_command_router, logfare


class D1CommandRouterTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.candidates = {
            "vc:join": {"root": "vc", "value": "join", "label": "VC参加", "genre": "VC"},
            "general:status": {"root": "general", "value": "status", "label": "状態", "genre": "一般"},
        }

    async def test_uses_clef_and_parses_cloudflare_result_envelope(self):
        decision = AsyncMock(return_value={
            "result": {
                "model": "clef",
                "answers": {"action": {
                    "type": "choice", "choice": "vc:join",
                    "probabilities": {"vc:join": 0.91, "general:status": 0.06, "none": 0.03},
                    "confidence": 0.91,
                }},
            },
            "success": True,
            "errors": [],
            "messages": [],
        })
        with patch("core.d1_command_router.logfare.decision", decision):
            selected = await d1_command_router.decide_action("VCに参加して", self.candidates, "安全に判断")
        self.assertEqual(selected, "vc:join")
        args, kwargs = decision.await_args
        self.assertEqual(args[0], "clef")
        self.assertEqual(kwargs["timeout"].total, d1_command_router.D1_TIMEOUT)
        self.assertIn("user_request", __import__("json").loads(args[1]))
        self.assertIn("none", args[2]["action"]["criteria"])

    async def test_rejects_none_or_unlisted_choice(self):
        for selected in ("none", "support:clear"):
            result = {"answers": {"action": {"choice": selected}}}
            with self.subTest(selected=selected), patch(
                "core.d1_command_router.logfare.decision", AsyncMock(return_value=result)
            ):
                with self.assertRaises(d1_command_router.D1DecisionError):
                    await d1_command_router.decide_action("依頼", self.candidates, "")

    async def test_rejects_failed_envelope_and_missing_choice(self):
        for result in (
            {"success": False, "errors": [{"message": "no access"}]},
            {"result": {"answers": {"action": {"probabilities": {"vc:join": 1.0}}}}},
        ):
            with self.subTest(result=result), patch(
                "core.d1_command_router.logfare.decision", AsyncMock(return_value=result)
            ):
                with self.assertRaises(d1_command_router.D1DecisionError):
                    await d1_command_router.decide_action("依頼", self.candidates, "")

    async def test_does_not_call_provider_without_candidates(self):
        decision = AsyncMock()
        with patch("core.d1_command_router.logfare.decision", decision):
            with self.assertRaises(d1_command_router.D1DecisionError):
                await d1_command_router.decide_action("依頼", {}, "")
        decision.assert_not_awaited()

    async def test_logfare_decision_posts_system_one_payload_with_bearer_key(self):
        class FakeResponse:
            status = 200
            headers = {}

            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                return None

            async def json(self):
                return {"result": {"answers": {"action": {"choice": "vc:join"}}}}

        class FakeSession:
            def __init__(self):
                self.request = None

            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                return None

            def post(self, url, **kwargs):
                self.request = (url, kwargs)
                return FakeResponse()

        session = FakeSession()
        question = {"action": {"type": "choice", "criteria": {"vc:join": "VC参加", "none": "なし"}}}
        with patch("core.logfare.api_key", return_value="test-key"), patch(
            "core.logfare.aiohttp.ClientSession", return_value=session
        ):
            response = await logfare.decision("clef", "state", question, timeout=aiohttp.ClientTimeout(total=2))
        self.assertIn("/v1/decisions", session.request[0])
        self.assertEqual(session.request[1]["headers"]["Authorization"], "Bearer test-key")
        self.assertEqual(session.request[1]["json"], {"model": "clef", "state": "state", "questions": question})
        self.assertEqual(response["result"]["answers"]["action"]["choice"], "vc:join")

    async def test_missing_logfare_key_fails_before_network(self):
        with patch("core.logfare.api_key", return_value=None), patch(
            "core.logfare.aiohttp.ClientSession"
        ) as session:
            with self.assertRaisesRegex(RuntimeError, "LOGFARE_API_KEY"):
                await logfare.decision("clef", "state", {"action": {"type": "choice"}})
        session.assert_not_called()


if __name__ == "__main__":
    unittest.main()
