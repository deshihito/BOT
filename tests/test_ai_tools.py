import asyncio
import json
import os
import types
import unittest
from unittest.mock import AsyncMock, patch

import aiohttp

from cogs.general import GENERIC_FAILURE_MESSAGE, AIToolsCog, _enabled, _resolve_invoker
from cogs.general import ShortcutMessageInteraction
from core.general.ai import logfare
from core.general.ai_tools import ai_tools_router
class AIToolsTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.candidates = {
            "vc:join": {"root": "vc", "value": "join", "label": "VC参加", "genre": "VC"},
            "general:status": {"root": "general", "value": "status", "label": "状態", "genre": "一般"},
        }

    async def test_default_candidates_include_all_safe_and_exclude_sensitive_tools(self):
        from core.general import action_registry

        candidates = ai_tools_router.action_candidates()
        # 候補はアクションレジストリから生成される（surfaces に aitools を含み
        # risk が blocked でないアクションのみ）。
        expected = {
            spec.id.lower()
            for spec in action_registry.default_registry().all()
            if "aitools" in spec.surfaces and spec.risk != "blocked"
            # E-9: 表示系ショートカットは AI 経由では実行時に拒否されるため
            # 候補からも除外される（選ばれて無反応になるのを防ぐ）。
            and spec.id not in action_registry.MESSAGE_SHORTCUT_BLOCKED_IDS
        }
        self.assertEqual(set(candidates), expected)
        # 即抜けRTAは設定パネル（sokunuke_settings）へ統合され、設定系パネルは
        # AI 候補に入らない。旧 value（sokunuke_status 等）はレジストリから
        # 外れたため候補にも存在しない。
        self.assertNotIn("support:sokunuke_settings", candidates)
        self.assertNotIn("support:sokunuke_status", candidates)
        # 機能数再編: sns_notify は SNS ジャンルへ分割され、設定系の新入口は
        # いずれも AI 候補に入らない。boardNotify のサービス別状態表示は
        # 読み取り専用なので候補に入る。
        self.assertNotIn("support:sns_youtube", candidates)
        self.assertIn("support:bumprta_bump", candidates)
        self.assertNotIn("support:sticky", candidates)
        self.assertTrue(candidates)
        self.assertNotIn("support:clear", candidates)
        self.assertNotIn("general:pay", candidates)
        # D-3 で confirm に格上げされた件は、確認ビュー付きの候補として入る。
        # 旧 bumprta_on/off は boardNotify 統合でレジストリから外れたため、
        # confirm は vc の5件のみが残る。
        for key in ("vc:echo_start",
                    "vc:karaoke_start", "vc:global_start", "vc:match_start", "vc:changer_start"):
            self.assertIn(key, candidates)
            self.assertEqual(candidates[key]["risk"], "confirm")
        for key in ("vc:record_start", "vc:transcribe_start"):
            self.assertNotIn(key, candidates)

        # 後から追加されたVC操作も、フォーム入力を必要としないものはAI toolsから選べる。
        for key in (
            "vc:record_status", "vc:record_pitch", "vc:echo_status", "vc:karaoke_score",
            "vc:changer_stop", "vc:changer_status", "vc:gvc_room_list",
            "vc:gvc_chat_disconnect", "vc:tts_stop", "vc:trigger_panel",
        ):
            self.assertIn(key, candidates)

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
            "cogs.general.logfare.api_key", return_value=None
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
            "cogs.general.logfare.api_key", return_value="configured"
        ), patch("cogs.general.ai_tools_router.decide_action", new_callable=AsyncMock) as decide:
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
        with patch("core.general.ai_tools.ai_tools_router.logfare.decision", decision):
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
            with self.subTest(selected=selected), patch("core.general.ai_tools.ai_tools_router.logfare.decision", decision):
                with self.assertRaises(ai_tools_router.AIToolsDecisionError):
                    await ai_tools_router.decide_action("依頼", self.candidates)
            decision.assert_awaited_once()

    async def test_no_action_does_not_send_a_notification(self):
        bot_user = types.SimpleNamespace(id=123)
        bot = types.SimpleNamespace(user=bot_user)
        cog = AIToolsCog(bot)
        message = types.SimpleNamespace(
            author=types.SimpleNamespace(bot=False, id=456),
            guild=types.SimpleNamespace(id=67),
            mentions=[bot_user],
            content="<@123> こんにちは",
            reply=AsyncMock(),
            channel=types.SimpleNamespace(typing=AsyncMock()),
        )
        with patch.dict(os.environ, {"AITOOLS_ENABLED": "true"}), patch(
            "cogs.general.logfare.api_key", return_value="configured"
        ), patch(
            "cogs.general.ai_tools_router.decide_action",
            new_callable=AsyncMock,
            side_effect=ai_tools_router.AIToolsNoAction("不要"),
        ):
            await cog.on_message(message)
        message.reply.assert_not_awaited()

    async def test_rejects_failed_envelope_and_missing_choice(self):
        for result in (
            {"success": False, "errors": [{"message": "no access"}]},
            {"result": {"answers": {"action": {"probabilities": {"vc:join": 1.0}}}}},
        ):
            with self.subTest(result=result), patch(
                "core.general.ai_tools.ai_tools_router.logfare.decision", AsyncMock(return_value=result)
            ):
                with self.assertRaises(ai_tools_router.AIToolsDecisionError):
                    await ai_tools_router.decide_action("依頼", self.candidates)

    async def test_logfare_forbidden_error_is_descriptive_and_not_retried(self):
        decision = AsyncMock(side_effect=logfare.LogfareHTTPError(403))
        with patch("core.general.ai_tools.ai_tools_router.logfare.decision", decision):
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
        with patch.dict(os.environ, {"LOGFARE_API_KEY": "test-key"}), patch(
            "core.general.ai.logfare.aiohttp.ClientSession", return_value=session
        ):
            response = await logfare.decision("clef", "state", question, timeout=aiohttp.ClientTimeout(total=2))
        self.assertIn("/v1/decisions", session.request[0])
        self.assertEqual(session.request[1]["headers"]["Authorization"], "Bearer test-key")
        self.assertEqual(session.request[1]["json"], {"model": "clef", "state": "state", "questions": question})
        self.assertEqual(response["result"]["answers"]["action"]["choice"], "vc:join")

    async def test_missing_logfare_key_fails_before_network(self):
        env = {k: v for k, v in os.environ.items() if not k.startswith("LOGFARE_API_KEY")}
        with patch.dict(os.environ, env, clear=True), patch(
            "core.general.ai.logfare.aiohttp.ClientSession"
        ) as session:
            with self.assertRaisesRegex(RuntimeError, "LOGFARE_API_KEY"):
                await logfare.decision("clef", "state", {"action": {"type": "choice"}})
        session.assert_not_called()


class AIToolsUnavailableTest(unittest.IsolatedAsyncioTestCase):
    """インフラ系失敗（AIToolsUnavailable）と利用者向け理由の切り分け。

    実機バグ: タイムアウト時に asyncio.TimeoutError の str() が空で、
    「AI toolsは実行されませんでした。理由: Clefの判定に失敗しました: 」と
    理由が空の公開返信になった。インフラ系は汎用文だけを返し、詳細は
    ログ専用とする。利用者向けの DecisionError は理由表示を維持する。
    """

    def setUp(self):
        self.candidates = {
            "vc:join": {"root": "vc", "value": "join", "label": "VC参加", "genre": "VC"},
            "general:status": {"root": "general", "value": "status", "label": "状態", "genre": "一般"},
        }

    def _mention_message(self):
        bot_user = types.SimpleNamespace(id=123)
        return bot_user, types.SimpleNamespace(
            author=types.SimpleNamespace(bot=False, id=456),
            guild=types.SimpleNamespace(id=67),
            mentions=[bot_user],
            reference=None,
            content="<@123> VCに入って",
            reply=AsyncMock(),
            channel=types.SimpleNamespace(typing=AsyncMock()),
        )

    # --- router 側の分類 -------------------------------------------------

    async def test_timeout_exhaustion_is_unavailable_with_nonempty_detail(self):
        decision = AsyncMock(side_effect=asyncio.TimeoutError())
        with patch("core.general.ai_tools.ai_tools_router.logfare.decision", decision):
            with self.assertRaises(ai_tools_router.AIToolsUnavailable) as ctx:
                await ai_tools_router.decide_action("VCに参加して", self.candidates)
        # 後方互換: DecisionError としても捕捉できる。
        self.assertIsInstance(ctx.exception, ai_tools_router.AIToolsDecisionError)
        # str が空の例外でも理由が空にならず、型名で追跡できる。
        self.assertIn("TimeoutError", str(ctx.exception))
        self.assertFalse(str(ctx.exception).rstrip().endswith(":"))
        self.assertFalse(str(ctx.exception).rstrip().endswith(":"))

    async def test_unauthorized_is_unavailable_keeping_ops_detail_for_logs(self):
        decision = AsyncMock(side_effect=logfare.LogfareHTTPError(401))
        with patch("core.general.ai_tools.ai_tools_router.logfare.decision", decision):
            with self.assertRaises(ai_tools_router.AIToolsUnavailable) as ctx:
                await ai_tools_router.decide_action("VCに参加して", self.candidates)
        # 詳細（運用者向けの確認指示）は例外＝ログ側には残る。
        self.assertIn("LOGFARE_API_KEY", str(ctx.exception))
        decision.assert_awaited_once()

    async def test_retryable_http_error_exhaustion_is_unavailable(self):
        decision = AsyncMock(side_effect=logfare.LogfareHTTPError(503))
        with patch("core.general.ai_tools.ai_tools_router.logfare.decision", decision):
            with self.assertRaises(ai_tools_router.AIToolsUnavailable) as ctx:
                await ai_tools_router.decide_action("VCに参加して", self.candidates)
        self.assertIn("503", str(ctx.exception))

    async def test_failed_envelope_is_unavailable(self):
        decision = AsyncMock(return_value={"success": False, "errors": [{"message": "no access"}]})
        with patch("core.general.ai_tools.ai_tools_router.logfare.decision", decision):
            with self.assertRaises(ai_tools_router.AIToolsUnavailable):
                await ai_tools_router.decide_action("依頼", self.candidates)

    async def test_blocked_action_error_stays_user_facing(self):
        bot = types.SimpleNamespace(get_cog=lambda name: None)
        message = types.SimpleNamespace(author=types.SimpleNamespace(id=45))
        item = {"root": "general", "value": "miq_settings"}
        with self.assertRaises(ai_tools_router.AIToolsDecisionError) as ctx:
            await ai_tools_router.invoke_action(bot, message, item)
        self.assertNotIsInstance(ctx.exception, ai_tools_router.AIToolsUnavailable)
        self.assertIn("実行できません", str(ctx.exception))

    # --- cog 側の表示 ----------------------------------------------------

    async def test_timeout_failure_replies_generic_message_only(self):
        bot_user, message = self._mention_message()
        cog = AIToolsCog(types.SimpleNamespace(user=bot_user))
        decision = AsyncMock(side_effect=asyncio.TimeoutError())
        with patch.dict(os.environ, {"AITOOLS_ENABLED": "true"}), patch(
            "cogs.general.logfare.api_key", return_value="configured"
        ), patch("core.general.ai_tools.ai_tools_router.logfare.decision", decision):
            await cog.on_message(message)
        message.reply.assert_awaited_once()
        text = message.reply.await_args.args[0]
        self.assertEqual(text, GENERIC_FAILURE_MESSAGE)
        self.assertNotIn("理由", text)
        self.assertNotIn("失敗しました: ", text)
        self.assertNotIn("LOGFARE_API_KEY", text)

    async def test_auth_failure_replies_generic_without_internal_instructions(self):
        bot_user, message = self._mention_message()
        cog = AIToolsCog(types.SimpleNamespace(user=bot_user))
        decision = AsyncMock(side_effect=logfare.LogfareHTTPError(401))
        with patch.dict(os.environ, {"AITOOLS_ENABLED": "true"}), patch(
            "cogs.general.logfare.api_key", return_value="configured"
        ), patch("core.general.ai_tools.ai_tools_router.logfare.decision", decision):
            await cog.on_message(message)
        message.reply.assert_awaited_once()
        text = message.reply.await_args.args[0]
        self.assertEqual(text, GENERIC_FAILURE_MESSAGE)
        self.assertNotIn("APIキー", text)
        self.assertNotIn("LOGFARE_API_KEY", text)

    async def test_user_facing_decision_error_still_shows_reason(self):
        bot_user, message = self._mention_message()
        cog = AIToolsCog(types.SimpleNamespace(user=bot_user))
        with patch.dict(os.environ, {"AITOOLS_ENABLED": "true"}), patch(
            "cogs.general.logfare.api_key", return_value="configured"
        ), patch(
            "cogs.general.ai_tools_router.decide_action",
            new_callable=AsyncMock,
            side_effect=ai_tools_router.AIToolsDecisionError(
                "MIQ設定はfastoolerから実行できません。/general から開いてください。"
            ),
        ):
            await cog.on_message(message)
        message.reply.assert_awaited_once()
        text = message.reply.await_args.args[0]
        self.assertIn("fastoolerは実行されませんでした。理由: ", text)
        self.assertIn("MIQ設定はfastoolerから実行できません。/general から開いてください。", text)


if __name__ == "__main__":
    unittest.main()
