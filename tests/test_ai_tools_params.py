"""AI tools の params 対応（レジストリ PR 4）のテスト。

- 候補に ParamSpec スキーマと risk が載ること
- decide_action の criteria に引数情報が伝わること
- 抽出ステージ: ParamSpec がなければ decision API を追加で呼ばないこと、
  数値引数のローカル抽出（キーワード近傍のみ・範囲外は落とす・曖昧なら埋めない）、
  choice / bool 引数の choice 質問（none・不正値は落とす）
- required 不足は直接実行せず補完ビューへ、risk="confirm" は確認なしに実行しないこと
- invoke_action が検証済み params を execute_shortcut へ渡すこと
"""
import os
import types
import unittest
from unittest.mock import AsyncMock, patch

from cogs.ai_tools import (
    AIToolsCog,
    AIToolsConfirmView,
    AIToolsParamCompletionView,
    AIToolsParamModal,
    _parse_param_input,
)
from core.general import ai_tools_router


def _param(name, label, ptype, **kwargs):
    base = {
        "name": name, "label": label, "type": ptype, "required": False,
        "default": None, "choices": [], "min_value": None, "max_value": None,
        "help": "",
    }
    base.update(kwargs)
    return base


def _candidate(root="vc", value="changer_status", label="ボイスチェンジャー状態", **kwargs):
    base = {
        "root": root, "value": value, "label": label,
        "genre": f"/{root}", "risk": "safe", "params": [],
    }
    base.update(kwargs)
    return base


class _Typing:
    async def __aenter__(self):
        return None

    async def __aexit__(self, *args):
        return False


class CandidateSchemaTest(unittest.TestCase):
    def test_candidates_carry_param_schema_and_risk(self):
        candidates = ai_tools_router.action_candidates()
        changer = candidates["vc:changer_status"]
        self.assertEqual(changer["risk"], "safe")
        by_name = {p["name"]: p for p in changer["params"]}
        self.assertEqual(set(by_name), {"pitch", "buffer_ms", "max_ms"})
        self.assertEqual(by_name["pitch"]["type"], "number")
        self.assertEqual(by_name["pitch"]["min_value"], -24.0)
        self.assertEqual(by_name["pitch"]["max_value"], 24.0)
        # 引数のないアクションは空スキーマ。
        self.assertEqual(candidates["vc:join"]["params"], [])
        # blocked（録音開始）は引き続き候補に現れない。
        self.assertNotIn("vc:record_start", candidates)
        # D-3 で confirm に格上げされた開始系は、risk="confirm" で候補に残る。
        self.assertEqual(candidates["vc:echo_start"]["risk"], "confirm")
        self.assertEqual(candidates["vc:changer_start"]["risk"], "confirm")


class DecideActionCriteriaTest(unittest.IsolatedAsyncioTestCase):
    async def test_criteria_mentions_params_for_param_candidates(self):
        with_params = _candidate(params=[_param("pitch", "ピッチ（半音）", "number")])
        plain = _candidate(value="join", label="VC参加")
        candidates = {"vc:changer_status": with_params, "vc:join": plain}
        decision = AsyncMock(return_value={"answers": {"action": {"choice": "vc:join"}}})
        with patch("core.general.ai_tools_router.logfare.decision", decision):
            selected = await ai_tools_router.decide_action("依頼", candidates)
        self.assertEqual(selected, "vc:join")
        criteria = decision.await_args.args[2]["action"]["criteria"]
        self.assertIn("引数あり", criteria["vc:changer_status"])
        self.assertIn("ピッチ（半音）", criteria["vc:changer_status"])
        self.assertNotIn("引数あり", criteria["vc:join"])


class ExtractParamsTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.changer = ai_tools_router.action_candidates()["vc:changer_status"]

    async def test_no_param_spec_makes_no_decision_call(self):
        decision = AsyncMock()
        with patch("core.general.ai_tools_router.logfare.decision", decision):
            self.assertEqual(await ai_tools_router.extract_params("VCに入って", _candidate(value="join", params=[])), {})
            item = {"root": "vc", "value": "join", "label": "VC参加", "genre": "/vc"}
            self.assertEqual(await ai_tools_router.extract_params("VCに入って", item), {})
        decision.assert_not_awaited()

    async def test_numeric_params_extracted_by_keyword_without_api_call(self):
        decision = AsyncMock()
        with patch("core.general.ai_tools_router.logfare.decision", decision):
            self.assertEqual(
                await ai_tools_router.extract_params("ボイスチェンジャーの音程を+3にして", self.changer),
                {"pitch": 3.0},
            )
            self.assertEqual(
                await ai_tools_router.extract_params("バッファを500msにして、上限は3000で", self.changer),
                {"buffer_ms": 500.0, "max_ms": 3000.0},
            )
            self.assertEqual(
                await ai_tools_router.extract_params("ピッチを-2、バッファを250にして", self.changer),
                {"pitch": -2.0, "buffer_ms": 250.0},
            )
        decision.assert_not_awaited()

    async def test_out_of_range_numeric_values_are_dropped(self):
        self.assertEqual(await ai_tools_router.extract_params("音程を100にして", self.changer), {})
        self.assertEqual(await ai_tools_router.extract_params("バッファを10msにして", self.changer), {})

    async def test_ambiguous_lone_number_is_not_guessed(self):
        # 数値引数が3つある状態で、キーワードなしの数値1つは割り当てない。
        self.assertEqual(await ai_tools_router.extract_params("3にして", self.changer), {})
        self.assertEqual(await ai_tools_router.extract_params("状態を見せて", self.changer), {})

    async def test_lone_number_assigned_when_single_numeric_param(self):
        item = _candidate(value="echo_status", label="やまびこ状態", params=[
            _param("delay", "遅延（秒）", "number", min_value=0.1, max_value=30.0),
        ])
        self.assertEqual(await ai_tools_router.extract_params("3秒ずらして", item), {"delay": 3.0})

    async def test_choice_param_extracted_via_decision_question(self):
        item = _candidate(params=[
            _param("mode", "モード", "choice",
                   choices=[["低", "low"], ["高", "high"]]),
        ])
        decision = AsyncMock(return_value={"answers": {"mode": {"choice": "high"}}})
        with patch("core.general.ai_tools_router.logfare.decision", decision):
            self.assertEqual(await ai_tools_router.extract_params("モードを高くして", item), {"mode": "high"})
        decision.assert_awaited_once()
        questions = decision.await_args.args[2]
        self.assertEqual(questions["mode"]["type"], "choice")
        self.assertEqual(set(questions["mode"]["criteria"]), {"low", "high", "none"})

    async def test_choice_none_and_invalid_answers_are_dropped(self):
        item = _candidate(params=[
            _param("mode", "モード", "choice",
                   choices=[["低", "low"], ["高", "high"]]),
        ])
        for answer in ("none", "bogus"):
            decision = AsyncMock(return_value={"answers": {"mode": {"choice": answer}}})
            with self.subTest(answer=answer), patch("core.general.ai_tools_router.logfare.decision", decision):
                self.assertEqual(await ai_tools_router.extract_params("依頼", item), {})

    async def test_bool_param_extracted_via_decision_question(self):
        item = _candidate(params=[_param("enabled", "有効化", "bool")])
        for answer, expected in (("true", True), ("false", False)):
            decision = AsyncMock(return_value={"answers": {"enabled": {"choice": answer}}})
            with self.subTest(answer=answer), patch("core.general.ai_tools_router.logfare.decision", decision):
                self.assertEqual(
                    await ai_tools_router.extract_params("依頼", item), {"enabled": expected})


class MissingAndSummaryTest(unittest.TestCase):
    def test_missing_required_params(self):
        item = _candidate(params=[
            _param("room", "ルーム名", "text", required=True),
            _param("password", "パスワード", "text"),
        ])
        missing = ai_tools_router.missing_required_params(item, {})
        self.assertEqual([p["name"] for p in missing], ["room"])
        self.assertEqual(ai_tools_router.missing_required_params(item, {"room": "a"}), [])

    def test_format_params_summary(self):
        item = _candidate(params=[_param("pitch", "ピッチ（半音）", "number")])
        self.assertEqual(ai_tools_router.format_params_summary(item, {"pitch": 3.0}), "ピッチ（半音）: 3.0")
        self.assertEqual(ai_tools_router.format_params_summary(item, {}), "")

    def test_requires_confirmation(self):
        self.assertTrue(ai_tools_router.requires_confirmation(_candidate(risk="confirm")))
        self.assertFalse(ai_tools_router.requires_confirmation(_candidate(risk="safe")))
        # risk キーが無い候補はレジストリへフォールバックする。
        item = _candidate()
        del item["risk"]
        self.assertFalse(ai_tools_router.requires_confirmation(item))

    def test_parse_param_input(self):
        self.assertEqual(_parse_param_input(_param("n", "数", "int"), "42"), 42)
        self.assertEqual(_parse_param_input(_param("n", "数", "number"), "1.5"), 1.5)
        self.assertIs(_parse_param_input(_param("b", "設定", "bool"), "オン"), True)
        self.assertIs(_parse_param_input(_param("b", "設定", "bool"), "off"), False)
        choice = _param("m", "モード", "choice", choices=[["低", "low"], ["高", "high"]])
        self.assertEqual(_parse_param_input(choice, "高"), "high")
        with self.assertRaises(ValueError):
            _parse_param_input(_param("n", "数", "int"), "abc")
        with self.assertRaises(ValueError):
            _parse_param_input(choice, "中")


class InvokeActionParamsTest(unittest.IsolatedAsyncioTestCase):
    async def _run_invoke(self, item, params):
        author = types.SimpleNamespace(id=45)
        message = types.SimpleNamespace(author=author)
        dispatcher = types.SimpleNamespace(execute_shortcut=AsyncMock())
        bot = types.SimpleNamespace(get_cog=lambda name: dispatcher)
        result = await ai_tools_router.invoke_action(bot, message, item, params=params)
        return dispatcher, result

    async def test_invoke_forwards_only_validated_params(self):
        item = ai_tools_router.action_candidates()["vc:changer_status"]
        dispatcher, result = await self._run_invoke(
            item, {"pitch": 3, "buffer_ms": 99999, "unknown": 1})
        # 範囲外と未知キーは落とされ、検証済みの pitch だけが渡る。
        self.assertEqual(result, {"pitch": 3.0})
        dispatcher.execute_shortcut.assert_awaited_once_with(
            unittest.mock.ANY,
            {"user_id": "45",
             "action": {"root": "vc", "value": "changer_status"},
             "params": {"pitch": 3.0}},
            invoker=None,
        )

    async def test_invoke_without_params_keeps_legacy_item_shape(self):
        item = ai_tools_router.action_candidates()["vc:changer_status"]
        dispatcher, result = await self._run_invoke(item, None)
        self.assertEqual(result, {})
        called_item = dispatcher.execute_shortcut.await_args.args[1]
        self.assertNotIn("params", called_item)


class CogFlowTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.bot_user = types.SimpleNamespace(id=123)
        self.bot = types.SimpleNamespace(user=self.bot_user)
        self.cog = AIToolsCog(self.bot)
        self.sent = types.SimpleNamespace(edit=AsyncMock())

    def _message(self, content):
        return types.SimpleNamespace(
            author=types.SimpleNamespace(bot=False, id=456),
            guild=types.SimpleNamespace(id=67),
            mentions=[self.bot_user],
            reference=None,
            interaction_metadata=None,
            interaction=None,
            content=content,
            reply=AsyncMock(return_value=self.sent),
            channel=types.SimpleNamespace(typing=lambda: _Typing()),
        )

    def _patches(self, candidates, selected, invoke):
        return (
            patch.dict(os.environ, {"AITOOLS_ENABLED": "true"}),
            patch("cogs.ai_tools.logfare.api_key", return_value="configured"),
            patch.object(ai_tools_router, "action_candidates", return_value=candidates),
            patch.object(ai_tools_router, "decide_action", new_callable=AsyncMock, return_value=selected),
            patch.object(ai_tools_router, "invoke_action", invoke),
        )

    async def test_confirm_action_is_not_executed_without_confirmation(self):
        item = _candidate(risk="confirm")
        invoke = AsyncMock()
        patches = self._patches({"vc:changer_status": item}, "vc:changer_status", invoke)
        message = self._message("<@123> 状態を変えて")
        with patches[0], patches[1], patches[2], patches[3], patches[4]:
            await self.cog.on_message(message)
            invoke.assert_not_awaited()
            message.reply.assert_awaited_once()
            view = message.reply.await_args.kwargs["view"]
            self.assertIsInstance(view, AIToolsConfirmView)
            # 押せるのは依頼者だけで、実行コールバックを踏むと初めて invoke される。
            other = types.SimpleNamespace(user=types.SimpleNamespace(id=999))
            self.assertFalse(await view.interaction_check(other))
            mine = types.SimpleNamespace(user=types.SimpleNamespace(id=456))
            self.assertTrue(await view.interaction_check(mine))
            await view.on_execute()
            invoke.assert_awaited_once()

    async def test_missing_required_param_goes_to_completion_view(self):
        item = _candidate(value="global_start", label="グローバルVC開始", params=[
            _param("room", "ルーム名", "text", required=True),
        ])
        invoke = AsyncMock()
        patches = self._patches({"vc:global_start": item}, "vc:global_start", invoke)
        message = self._message("<@123> グローバルVCに入って")
        with patches[0], patches[1], patches[2], patches[3], patches[4]:
            await self.cog.on_message(message)
            invoke.assert_not_awaited()
            view = message.reply.await_args.kwargs["view"]
            self.assertIsInstance(view, AIToolsParamCompletionView)
            # モーダル相当の入力が確定すると、検証済み params で実行される。
            interaction = types.SimpleNamespace(
                user=types.SimpleNamespace(id=456),
                response=types.SimpleNamespace(defer=AsyncMock(), send_message=AsyncMock()),
            )
            await view.accept_values(interaction, {"room": "room-a"})
            invoke.assert_awaited_once()
            self.assertEqual(invoke.await_args.kwargs["params"], {"room": "room-a"})
            # モーダルが組み立てられること（不足分だけが入力欄になる）。
            modal = AIToolsParamModal(view)
            self.assertEqual(list(modal.inputs), ["room"])

    async def test_safe_action_with_params_executes_directly_with_summary(self):
        candidates = ai_tools_router.action_candidates()
        invoke = AsyncMock()
        patches = self._patches(candidates, "vc:changer_status", invoke)
        message = self._message("<@123> ボイスチェンジャーの音程を+3にして")
        with patches[0], patches[1], patches[2], patches[3], patches[4]:
            await self.cog.on_message(message)
        invoke.assert_awaited_once()
        self.assertEqual(invoke.await_args.kwargs["params"], {"pitch": 3.0})
        summary_text = message.reply.await_args.args[0]
        self.assertIn("ピッチ（半音）: 3.0", summary_text)


class RealConfirmFlowTest(unittest.IsolatedAsyncioTestCase):
    """D-3 で格上げされた実在アクションが、実際の候補データで確認経路に乗ること。

    合成候補ではなく ai_tools_router.action_candidates() の実データを使い、
    decide_action と invoke_action だけをモックする。
    """

    def setUp(self):
        self.bot_user = types.SimpleNamespace(id=123)
        self.bot = types.SimpleNamespace(user=self.bot_user)
        self.cog = AIToolsCog(self.bot)
        self.sent = types.SimpleNamespace(edit=AsyncMock())

    def _message(self, content):
        return types.SimpleNamespace(
            author=types.SimpleNamespace(bot=False, id=456),
            guild=types.SimpleNamespace(id=67),
            mentions=[self.bot_user],
            reference=None,
            interaction_metadata=None,
            interaction=None,
            content=content,
            reply=AsyncMock(return_value=self.sent),
            channel=types.SimpleNamespace(typing=lambda: _Typing()),
        )

    def _patches(self, selected, invoke):
        return (
            patch.dict(os.environ, {"AITOOLS_ENABLED": "true"}),
            patch("cogs.ai_tools.logfare.api_key", return_value="configured"),
            patch.object(ai_tools_router, "decide_action", new_callable=AsyncMock, return_value=selected),
            patch.object(ai_tools_router, "invoke_action", invoke),
        )

    def _interaction(self):
        return types.SimpleNamespace(
            user=types.SimpleNamespace(id=456),
            response=types.SimpleNamespace(
                defer=AsyncMock(), send_message=AsyncMock(), edit_message=AsyncMock()),
        )

    async def test_real_echo_start_confirm_cancel_never_executes(self):
        invoke = AsyncMock()
        patches = self._patches("vc:echo_start", invoke)
        message = self._message("<@123> やまびこ開始して")
        with patches[0], patches[1], patches[2], patches[3]:
            await self.cog.on_message(message)
            invoke.assert_not_awaited()
            view = message.reply.await_args.kwargs["view"]
            self.assertIsInstance(view, AIToolsConfirmView)
            # キャンセルしても実行されない。
            await view.cancel_button.callback(self._interaction())
            invoke.assert_not_awaited()

    async def test_real_changer_start_confirm_executes_with_extracted_params(self):
        invoke = AsyncMock()
        patches = self._patches("vc:changer_start", invoke)
        message = self._message("<@123> ボイスチェンジャーを開始して、ピッチを+3にして")
        with patches[0], patches[1], patches[2], patches[3]:
            await self.cog.on_message(message)
            invoke.assert_not_awaited()
            view = message.reply.await_args.kwargs["view"]
            self.assertIsInstance(view, AIToolsConfirmView)
            # 任意引数は抽出済みで、確認文に要約が載る。
            self.assertIn("ピッチ（半音）: 3.0", message.reply.await_args.args[0])
            await view.on_execute()
            invoke.assert_awaited_once()
            self.assertEqual(invoke.await_args.kwargs["params"], {"pitch": 3.0})

    async def _karaoke_until_confirm(self, invoke):
        """カラオケ開始を補完ビュー→確認ビューまで進め、確認ビューを返す。

        呼び出し側のパッチ有効範囲の中で呼ぶこと（実行コールバックが
        パッチ済み invoke_action を参照するため）。
        """
        message = self._message("<@123> カラオケ開始して")
        await self.cog.on_message(message)
        invoke.assert_not_awaited()
        view = message.reply.await_args.kwargs["view"]
        # 必須引数（歌詞）が無いので、まず補完ビューが出る（確認はまだ）。
        self.assertIsInstance(view, AIToolsParamCompletionView)
        await view.accept_values(self._interaction(), {"lyrics": "テスト歌詞"})
        invoke.assert_not_awaited()
        # 補完後は同じメッセージが確認ビューに切り替わる（二重表示にならない）。
        confirm_view = self.sent.edit.await_args.kwargs["view"]
        self.assertIsInstance(confirm_view, AIToolsConfirmView)
        return confirm_view

    async def test_real_karaoke_start_completion_then_confirm_executes(self):
        invoke = AsyncMock()
        patches = self._patches("vc:karaoke_start", invoke)
        with patches[0], patches[1], patches[2], patches[3]:
            confirm_view = await self._karaoke_until_confirm(invoke)
            await confirm_view.on_execute()
            invoke.assert_awaited_once()
            self.assertEqual(invoke.await_args.kwargs["params"], {"lyrics": "テスト歌詞"})

    async def test_real_karaoke_start_completion_then_confirm_cancel_never_executes(self):
        invoke = AsyncMock()
        patches = self._patches("vc:karaoke_start", invoke)
        with patches[0], patches[1], patches[2], patches[3]:
            confirm_view = await self._karaoke_until_confirm(invoke)
            await confirm_view.cancel_button.callback(self._interaction())
            invoke.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
