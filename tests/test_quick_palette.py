"""/quick クイックパレット（cogs/quick.py）のテスト。

オートコンプリートのフィルタ、root 別 dispatch 委譲、required 引数ありで
補完フローに入ることを、Discord に接続せずモックで確認する。
"""
import types
import unittest
from unittest.mock import AsyncMock

from cogs import quick
from core import action_registry


def registry():
    return action_registry.default_registry()


def fake_interaction(user_id: int = 42):
    response = types.SimpleNamespace(
        is_done=lambda: False,
        send_message=AsyncMock(),
        defer=AsyncMock(),
    )
    followup = types.SimpleNamespace(send=AsyncMock())
    return types.SimpleNamespace(
        user=types.SimpleNamespace(id=user_id),
        guild_id=111,
        response=response,
        followup=followup,
        original_response=AsyncMock(return_value=types.SimpleNamespace(id=999)),
    )


def fake_bot(**cogs):
    return types.SimpleNamespace(get_cog=lambda name: cogs.get(name))


class AutocompleteFilterTest(unittest.TestCase):
    def test_empty_query_returns_up_to_25(self):
        choices = quick.autocomplete_choices("")
        self.assertEqual(len(choices), 25)
        self.assertTrue(all(c.value for c in choices))

    def test_label_substring_match(self):
        values = [c.value for c in quick.autocomplete_choices("翻訳")]
        self.assertIn("general:translation_settings", values)

    def test_id_substring_match(self):
        values = [c.value for c in quick.autocomplete_choices("sns")]
        self.assertIn("support:sns_notify", values)

    def test_genre_match(self):
        # support の genre_label（例: モデレーション）でも絞れる。
        values = [c.value for c in quick.autocomplete_choices("モデレーション")]
        self.assertIn("support:muted", values)
        self.assertTrue(all(v.startswith("support:") for v in values))

    def test_choice_display_format_is_genre_slash_label(self):
        choices = quick.autocomplete_choices("翻訳")
        choice = next(c for c in choices if c.value == "general:translation_settings")
        # 導線最適化 S7: 自動翻訳を設定は「設定・AI」ジャンルへ吸収済み
        self.assertEqual(choice.name, "設定・AI / 自動翻訳を設定")

    def test_only_palette_surface_is_listed(self):
        specs = quick.palette_actions()
        self.assertTrue(specs)
        self.assertTrue(all("palette" in spec.surfaces for spec in specs))
        # shortcut_manage は surfaces が panel のみなのでパレットに出ない。
        self.assertNotIn("general:shortcut_manage", [spec.id for spec in specs])

    def test_filter_limit(self):
        self.assertEqual(len(quick.filter_palette_actions("", limit=5)), 5)


class DispatchDelegationTest(unittest.IsolatedAsyncioTestCase):
    async def test_general_delegates_to_dispatch_general(self):
        general = types.SimpleNamespace(dispatch_general=AsyncMock(return_value="ok"))
        bot = fake_bot(GeneralCog=general)
        spec = registry().by_id("general:status")
        result = await quick.dispatch_action(bot, fake_interaction(), spec)
        self.assertEqual(result, "ok")
        general.dispatch_general.assert_awaited_once()
        args = general.dispatch_general.await_args.args
        self.assertEqual(args[1], "status")

    async def test_vc_delegates_with_filtered_params(self):
        hub = types.SimpleNamespace(dispatch_voice_action=AsyncMock(return_value="ok"))
        bot = fake_bot(VoiceHub=hub)
        spec = registry().by_id("vc:changer_status")
        await quick.dispatch_action(
            bot, fake_interaction(), spec, {"pitch": 3.0, "not_a_param": 1})
        hub.dispatch_voice_action.assert_awaited_once()
        kwargs = hub.dispatch_voice_action.await_args.kwargs
        self.assertEqual(kwargs, {"pitch": 3.0})
        self.assertEqual(hub.dispatch_voice_action.await_args.args[1], "changer_status")

    async def test_support_delegates_to_dispatch(self):
        support = types.SimpleNamespace(dispatch=AsyncMock())
        bot = fake_bot(SupportCog=support)
        spec = registry().by_id("support:muted")
        await quick.dispatch_action(bot, fake_interaction(), spec)
        support.dispatch.assert_awaited_once()
        self.assertEqual(support.dispatch.await_args.args[1], "muted")

    async def test_game_delegates_with_bare_game_id(self):
        hub = types.SimpleNamespace(start_game=AsyncMock())
        bot = fake_bot(GameHub=hub)
        spec = registry().by_id("game:game:uno")
        await quick.dispatch_action(bot, fake_interaction(), spec)
        hub.start_game.assert_awaited_once()
        self.assertEqual(hub.start_game.await_args.args[1], "uno")

    async def test_help_points_to_help_command(self):
        interaction = fake_interaction()
        spec = registry().by_id("help:overview")
        await quick.dispatch_action(fake_bot(), interaction, spec)
        interaction.response.send_message.assert_awaited_once()
        text = interaction.response.send_message.await_args.args[0]
        self.assertIn("/help", text)

    async def test_missing_cog_raises_quick_error(self):
        spec = registry().by_id("general:status")
        with self.assertRaises(quick.QuickError):
            await quick.dispatch_action(fake_bot(), fake_interaction(), spec)


class QuickCommandFlowTest(unittest.IsolatedAsyncioTestCase):
    def make_cog(self, **cogs):
        return quick.QuickCog(fake_bot(**cogs))

    async def run_quick(self, cog, interaction, action):
        return await quick.QuickCog.quick.callback(cog, interaction, action)

    async def test_unknown_action_replies_error(self):
        cog = self.make_cog()
        interaction = fake_interaction()
        await self.run_quick(cog, interaction, "general:no_such_action")
        interaction.response.send_message.assert_awaited_once()
        self.assertTrue(
            interaction.response.send_message.await_args.kwargs.get("ephemeral"))

    async def test_simple_action_dispatches_directly(self):
        general = types.SimpleNamespace(dispatch_general=AsyncMock())
        cog = self.make_cog(GeneralCog=general)
        interaction = fake_interaction()
        await self.run_quick(cog, interaction, "general:status")
        general.dispatch_general.assert_awaited_once()

    async def test_required_param_action_enters_completion_flow(self):
        hub = types.SimpleNamespace(dispatch_voice_action=AsyncMock())
        cog = self.make_cog(VoiceHub=hub)
        interaction = fake_interaction()
        await self.run_quick(cog, interaction, "vc:karaoke_start")
        # dispatch されず、補完ビュー付きの応答になる（第2波方針で公開）。
        hub.dispatch_voice_action.assert_not_awaited()
        interaction.response.send_message.assert_awaited_once()
        kwargs = interaction.response.send_message.await_args.kwargs
        self.assertIsInstance(kwargs.get("view"), quick.QuickParamPromptView)
        self.assertFalse(kwargs.get("ephemeral"))

    async def test_missing_required_params_helper(self):
        karaoke = registry().by_id("vc:karaoke_start")
        self.assertEqual(
            [p.name for p in quick.missing_required_params(karaoke)], ["lyrics"])
        global_start = registry().by_id("vc:global_start")
        self.assertEqual(
            [p.name for p in quick.missing_required_params(global_start)], ["room"])
        changer = registry().by_id("vc:changer_status")
        self.assertEqual(quick.missing_required_params(changer), [])

    async def test_param_modal_submit_validates_and_dispatches(self):
        hub = types.SimpleNamespace(dispatch_voice_action=AsyncMock())
        cog = self.make_cog(VoiceHub=hub)
        spec = registry().by_id("vc:karaoke_start")
        missing = quick.missing_required_params(spec)
        modal = quick.QuickParamModal(cog, spec, missing)
        modal.inputs["lyrics"]._value = "サンプル歌詞"
        interaction = fake_interaction()
        await modal.on_submit(interaction)
        hub.dispatch_voice_action.assert_awaited_once()
        kwargs = hub.dispatch_voice_action.await_args.kwargs
        self.assertEqual(kwargs, {"lyrics": "サンプル歌詞"})

    async def test_autocomplete_callback_returns_choices(self):
        cog = self.make_cog()
        choices = await cog.quick_action_autocomplete(fake_interaction(), "翻訳")
        self.assertIn(
            "general:translation_settings", [c.value for c in choices])


if __name__ == "__main__":
    unittest.main()
