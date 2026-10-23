import json
import os
import types
import unittest
from unittest.mock import AsyncMock, patch

import aiohttp

from cogs.ai_tools import AIToolsCog, _enabled, _resolve_invoker
from cogs.general import ShortcutMessageInteraction
from core import ai_tools_router, logfare


class AIToolsTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.candidates = {
            "vc:join": {"root": "vc", "value": "join", "label": "VC参加", "genre": "VC"},
            "general:status": {"root": "general", "value": "status", "label": "状態", "genre": "一般"},
        }

    async def test_default_candidates_include_all_safe_and_exclude_sensitive_tools(self):
        from cogs.general import SHORTCUT_ROOTS

        candidates = ai_tools_router.action_candidates()
        expected = {
            f"{root}:{value}".lower()
            for root, (_, items) in SHORTCUT_ROOTS.items()
            for _, value in items
            if f"{root}:{value}".lower() not in ai_tools_router.BLOCKED_ACTIONS
        }
        self.assertEqual(set(candidates), expected)
        self.assertTrue(candidates)
        self.assertNotIn("support:clear", candidates)
        self.assertNotIn("general:pay", candidates)
        self.assertNotIn("support:bumprta_on", candidates)
        for key in ("vc:record_start", "vc:transcribe_start", "vc:global_start", "vc:match_start"):
            self.assertNotIn(key, candidates)

    async def test_ai_tools_is_enabled_by_default_without_legacy_d1_flag(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertTrue(_enabled())
        with patch.dict(os.environ, {"AITOOLS_ENABLED": "false"}, clear=True):
            self.assertFalse(_enabled())

    async def test_public_command_is_aitools_not_d1tools(self):
        self.assertEqual(AIToolsCog.aitools.name, "aitools")

    async def test_invoker_is_forwarded_to_existing_tool_dispatch(self):
        author = types.SimpleNamespace(id=45)
        message = types.SimpleNamespace(author=author)
        invoker = types.SimpleNamespace(id=67)
        dispatcher = types.SimpleNamespace(execute_shortcut=AsyncMock())
        bot = types.SimpleNamespace(get_cog=lambda name: dispatcher)
        item = {"root": "vc", "value": "join", "label": "VC参加", "genre": "VC"}

        await ai_tools_router.invoke_action(bot, message, item, invoker=invoker)

        dispatcher.execute_shortcut.assert_awaited_once_with(
            message,
            {"user_id": "45", "action": {"root": "vc", "value": "join"}},
            invoker=invoker,
        )

    async def test_message_interaction_uses_resolved_human_member(self):
        message_author = types.SimpleNamespace(id=45)
        human = types.SimpleNamespace(id=67, voice="voice-state")
        message = types.SimpleNamespace(
            author=message_author,
            channel=types.SimpleNamespace(),
            guild=types.SimpleNamespace(id=89),
        )
        source = ShortcutMessageInteraction(None, message, message_author.id, invoker=human)
        self.assertIs(source.user, human)
        self.assertEqual(source.user_id, human.id)

    async def test_bot_requester_uses_only_unambiguous_voice_member(self):
        bot_user = types.SimpleNamespace(id=123)
        human = types.SimpleNamespace(id=67, bot=False)
        source_bot = types.SimpleNamespace(id=45, bot=True)
        message = types.SimpleNamespace(
            author=source_bot,
            guild=types.SimpleNamespace(
                voice_channels=[types.SimpleNamespace(members=[human])],
                get_member=lambda user_id: None,
            ),
            mentions=[bot_user],
            reference=None,
            interaction_metadata=None,
            interaction=None,
        )
        self.assertIs(_resolve_invoker(message, bot_user), human)
        second_human = types.SimpleNamespace(id=68, bot=False)
        message.guild.voice_channels[0].members.append(second_human)
        self.assertIsNone(_resolve_invoker(message, bot_user))

    async def test_mention_with_missing_key_gets_actionable_reply(self):
        bot_user = types.SimpleNamespace(id=123)
        human = types.SimpleNamespace(id=456, bot=False)
        bot = types.SimpleNamespace(user=bot_user)
        cog = AIToolsCog(bot)
        message = types.SimpleNamespace(
            author=types.SimpleNamespace(bot=True, id=45),
            guild=types.SimpleNamespace(id=67),
            mentions=[bot_user],
            reference=types.SimpleNamespace(resolved=types.SimpleNamespace(author=human)),
            interaction_metadata=None,
            interaction=None,
            content="<@123> VCに入って",
            reply=AsyncMock(),
        )
        with patch.dict(os.environ, {"AITOOLS_ENABLED": "true"}), patch(
            "cogs.ai_tools.logfare.api_key", return_value=None
        ):
            await cog.on_message(message)
        message.reply.assert_awaited_once()
        self.assertIn("LOGFARE_API_KEY", message.reply.await_args.args[0])

    async def test_bot_message_without_human_context_is_not_silently_ignored_or_sent_to_model(self):
        bot_user = types.SimpleNamespace(id=123)
        cog = AIToolsCog(types.SimpleNamespace(user=bot_user))
        message = types.SimpleNamespace(
            author=types.SimpleNamespace(bot=True, id=45),
            guild=types.SimpleNamespace(id=67, voice_channels=[]),
            mentions=[bot_user],
            reference=None,
            interaction_metadata=None,
            interaction=None,
            content="<@123> VCに入って",
            reply=AsyncMock(),
        )
        with patch.dict(os.environ, {"AITOOLS_ENABLED": "true"}), patch(
            "cogs.ai_tools.logfare.api_key", return_value="configured"
        ), patch("cogs.ai_tools.ai_tools_router.decide_action", new_callable=AsyncMock) as decide:
            await cog.on_message(message)
        message.reply.assert_awaited_once()
        self.assertIn("人間を特定できません", message.reply.await_args.args[0])
        decide.assert_not_awaited()

    async def test_global_disabled_mention_gets_actionable_reply(self):
        bot_user = types.SimpleNamespace(id=123)
        cog = AIToolsCog(types.SimpleNamespace(user=bot_user))
        message = types.SimpleNamespace(
            author=types.SimpleNamespace(bot=False, id=45),
            guild=types.SimpleNamespace(id=67),
            mentions=[bot_user],
            content="<@123> VCに入って",
            reply=AsyncMock(),
        )
        with patch.dict(os.environ, {"AITOOLS_ENABLED": "false"}, clear=True):
            await cog.on_message(message)
        message.reply.assert_awaited_once()
        self.assertIn("停止中", message.reply.await_args.args[0])

    async def test_clef_request_and_result_envelope(self):
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
        with patch("core.ai_tools_router.logfare.decision", decision):
            selected = await ai_tools_router.decide_action("VCに参加して", self.candidates)
        self.assertEqual(selected, "vc:join")
        args, kwargs = decision.await_args
        self.assertEqual(args[0], "clef")
        self.assertEqual(kwargs["timeout"].total, ai_tools_router.AITOOLS_TIMEOUT)
        state = json.loads(args[1])
        self.assertIn("user_request", state)
        self.assertNotIn("custom_policy", state)
        self.assertIn("none", args[2]["action"]["criteria"])

    async def test_rejects_none_or_unavailable_action_without_retry(self):
        for selected in ("none", "support:clear"):
            decision = AsyncMock(return_value={"answers": {"action": {"choice": selected}}})
            with self.subTest(selected=selected), patch("core.ai_tools_router.logfare.decision", decision):
                with self.assertRaises(ai_tools_router.AIToolsDecisionError):
                    await ai_tools_router.decide_action("依頼", self.candidates)
            decision.assert_awaited_once()

    async def test_rejects_failed_envelope_and_missing_choice(self):
        for result in (
            {"success": False, "errors": [{"message": "no access"}]},
            {"result": {"answers": {"action": {"probabilities": {"vc:join": 1.0}}}}},
        ):
            with self.subTest(result=result), patch(
                "core.ai_tools_router.logfare.decision", AsyncMock(return_value=result)
            ):
                with self.assertRaises(ai_tools_router.AIToolsDecisionError):
                    await ai_tools_router.decide_action("依頼", self.candidates)

    async def test_logfare_forbidden_error_is_descriptive_and_not_retried(self):
        decision = AsyncMock(side_effect=logfare.LogfareHTTPError(403))
        with patch("core.ai_tools_router.logfare.decision", decision):
            with self.assertRaisesRegex(ai_tools_router.AIToolsDecisionError, "トレーニング利用オプトイン"):
                await ai_tools_router.decide_action("VCに参加して", self.candidates)
        decision.assert_awaited_once()

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
