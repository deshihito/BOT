# -*- coding: utf-8 -*-
"""機能数再編（support 55→81）の dispatch・preset・互換の固定テスト。"""
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import AsyncMock

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from cogs.support import SUPPORT_ACTIONS, SUPPORT_ACTIONS_BY_GENRE, SUPPORT_GENRES, SupportCog  # noqa: E402

NEW_VALUES = {
    "bumprta_bump", "bumprta_up", "bumprta_vote", "bumprta_takasumi", "bumprta_dicoall",
    "bumprta_dcafe", "bumprta_sharkbot", "bumprta_settings",
    "sns_youtube", "sns_x", "sns_github", "sns_rss", "sns_youtube_live",
    "bot_fixer_bots", "bot_fixer_rates", "muted_settings",
    "ticket_types", "ticket_transcript", "ticket_assign", "auth_questions",
    "assist_reminder", "assist_goodbye", "globalchat_mod", "tempvoice_panel",
    "assist_embed_templates", "assist_warning_escalation", "assist_application_review",
    "assist_events_link", "levelup_card_theme", "binjou_custom", "quest_manual",
}
REMOVED_VALUES = {"bumprta_status", "bumprta_on", "bumprta_off", "bumprta_role", "sns_notify"}


def make_interaction():
    return types.SimpleNamespace(
        user=types.SimpleNamespace(
            id=42,
            guild_permissions=types.SimpleNamespace(
                administrator=True, manage_guild=True, manage_roles=True,
                manage_channels=True, manage_messages=True),
        ),
        guild_id=1,
        guild=types.SimpleNamespace(id=1),
        channel=types.SimpleNamespace(id=10),
        message=types.SimpleNamespace(id=99),
        response=types.SimpleNamespace(send_message=AsyncMock(), is_done=lambda: False),
    )


def make_cog(cogs):
    bot = types.SimpleNamespace(get_cog=lambda name: cogs.get(name))
    return SupportCog(bot)


class RegistryShapeTest(unittest.TestCase):
    def test_counts(self):
        self.assertEqual(len(SUPPORT_ACTIONS), 87)
        counts = {genre: len(items) for genre, items in SUPPORT_ACTIONS_BY_GENRE.items()}
        self.assertEqual(counts, {
            "moderation": 17, "roles": 8, "logs": 5, "automation": 35,
            "rta": 5, "boardnotify": 10, "sns": 5, "analysis": 2,
        })
        values = {choice.value for choice in SUPPORT_ACTIONS}
        self.assertTrue(NEW_VALUES <= values)
        self.assertFalse(REMOVED_VALUES & values)
        self.assertEqual(SUPPORT_GENRES["boardnotify"], ("boardNotify", ""))
        self.assertEqual(SUPPORT_GENRES["sns"], ("SNS通知", ""))
        # ジャンル配置と SUPPORT_ACTIONS の集合が一致すること
        by_genre = {value for items in SUPPORT_ACTIONS_BY_GENRE.values() for _l, value in items}
        self.assertEqual(by_genre, values)

    def test_all_values_have_permission(self):
        perms = SupportCog.SUPPORT_REQUIRED_PERMISSIONS
        for value in NEW_VALUES:
            self.assertIn(value, perms, value)
        for choice in SUPPORT_ACTIONS:
            # voice_trigger は再編前から未登録の既存値（今回の対象外）。
            self.assertTrue(
                choice.value in perms or choice.value.startswith("assist_")
                or choice.value == "voice_trigger",
                choice.value,
            )


class DispatchTest(unittest.IsolatedAsyncioTestCase):
    async def test_legacy_bumprta_values_still_dispatch(self):
        rta = types.SimpleNamespace(bumprta_command=AsyncMock())
        cog = make_cog({"BumpRta": rta})
        interaction = make_interaction()
        await cog.dispatch(interaction, "bumprta_status")
        rta.bumprta_command.assert_awaited_once()
        choice = rta.bumprta_command.await_args.args[1]
        self.assertEqual(choice.value, "status")

    async def test_bumprta_service_opens_service_panel_not_fallthrough(self):
        rta = types.SimpleNamespace(
            bumprta_command=AsyncMock(),
            _is_enabled=AsyncMock(return_value=True),
            _role_id=AsyncMock(return_value=None),
            _reminders={},
        )
        cog = make_cog({"BumpRta": rta})
        interaction = make_interaction()
        await cog.dispatch(interaction, "bumprta_bump")
        rta.bumprta_command.assert_not_awaited()
        interaction.response.send_message.assert_awaited_once()
        embed = interaction.response.send_message.await_args.kwargs["embed"]
        self.assertIn("DISBOARD", embed.title)
        self.assertIn("オン", embed.description)

    async def test_bumprta_settings_opens_settings_view(self):
        from core.support.panel import BumpRtaSettingsView

        rta = types.SimpleNamespace(
            bumprta_command=AsyncMock(),
            _is_enabled=AsyncMock(return_value=False),
            _role_id=AsyncMock(return_value=123),
            _reminders={},
        )
        cog = make_cog({"BumpRta": rta})
        interaction = make_interaction()
        await cog.dispatch(interaction, "bumprta_settings")
        kwargs = interaction.response.send_message.await_args.kwargs
        self.assertIsInstance(kwargs["view"], BumpRtaSettingsView)

    async def test_assist_preset_uses_preset_route_not_generic(self):
        assistant = types.SimpleNamespace(
            show_feature=AsyncMock(), show_feature_preset=AsyncMock())
        cog = make_cog({"ServerAssistCog": assistant})
        interaction = make_interaction()
        await cog.dispatch(interaction, "assist_reminder")
        assistant.show_feature.assert_not_awaited()
        assistant.show_feature_preset.assert_awaited_once()
        args, kwargs = assistant.show_feature_preset.await_args
        self.assertEqual(args[1], "timed")
        self.assertEqual(kwargs["preset"], "reminders")

    async def test_assist_goodbye_preset_maps_to_welcome(self):
        assistant = types.SimpleNamespace(
            show_feature=AsyncMock(), show_feature_preset=AsyncMock())
        cog = make_cog({"ServerAssistCog": assistant})
        await cog.dispatch(make_interaction(), "assist_goodbye")
        args, kwargs = assistant.show_feature_preset.await_args
        self.assertEqual(args[1], "welcome")
        self.assertEqual(kwargs["preset"], "goodbye")

    async def test_sns_platform_dispatch(self):
        cog = make_cog({})
        cog.show_sns_notify_settings = AsyncMock()
        interaction = make_interaction()
        await cog.dispatch(interaction, "sns_youtube")
        cog.show_sns_notify_settings.assert_awaited_once_with(interaction, platform="youtube")
        cog.show_sns_notify_settings.reset_mock()
        await cog.dispatch(interaction, "sns_youtube_live")
        cog.show_sns_notify_settings.assert_awaited_once_with(interaction, live=True)
        cog.show_sns_notify_settings.reset_mock()
        await cog.dispatch(interaction, "sns_notify")  # 旧 value 互換
        cog.show_sns_notify_settings.assert_awaited_once_with(interaction)

    async def test_bot_fixer_presets(self):
        cog = make_cog({})
        cog.show_bot_fixer_settings = AsyncMock()
        interaction = make_interaction()
        await cog.dispatch(interaction, "bot_fixer_bots")
        cog.show_bot_fixer_settings.assert_awaited_once_with(
            interaction, preset={"area": "bot"})
        cog.show_bot_fixer_settings.reset_mock()
        await cog.dispatch(interaction, "bot_fixer_rates")
        cog.show_bot_fixer_settings.assert_awaited_once_with(
            interaction, preset={"area": "command", "purpose": "rates"})

    async def test_ticket_splits(self):
        ticket = types.SimpleNamespace(
            show_advanced_settings=AsyncMock(), show_assign_guide=AsyncMock(),
            show_settings=AsyncMock())
        cog = make_cog({"TicketCog": ticket})
        interaction = make_interaction()
        await cog.dispatch(interaction, "ticket_types")
        ticket.show_advanced_settings.assert_awaited_once_with(interaction)
        await cog.dispatch(interaction, "ticket_transcript")
        self.assertEqual(ticket.show_advanced_settings.await_count, 2)
        await cog.dispatch(interaction, "ticket_assign")
        ticket.show_assign_guide.assert_awaited_once_with(interaction)


class PresetUnitTest(unittest.TestCase):
    def test_bot_fixer_panel_preset(self):
        from core.support.bot_fixer import BotFixerPanel

        settings = {"mode": "off", "actions": [], "rates": {}}
        panel = BotFixerPanel(None, settings, {}, preset={"area": "bot"})
        self.assertEqual(panel.area, "bot")
        panel = BotFixerPanel(None, settings, {}, preset={"area": "command", "purpose": "rates"})
        self.assertEqual(panel.area, "command")
        self.assertEqual(panel.purpose, "rate")

    def test_command_control_self_excludes_new_bot_fixer_ids(self):
        from core.support import command_control

        settings = command_control.normalize_settings({
            "mode": "deny",
            "actions": ["support:bot_fixer", "support:bot_fixer_bots",
                        "support:bot_fixer_rates", "general:pay"],
            "rates": {"support:bot_fixer_rates": {"count": 1, "window_seconds": 60}},
        })
        self.assertEqual(settings["actions"], ["general:pay"])
        self.assertEqual(settings["rates"], {})
        for action_id in ("support:bot_fixer", "support:bot_fixer_bots", "support:bot_fixer_rates"):
            self.assertFalse(command_control.mode_blocks(
                {"mode": "allow", "actions": []}, action_id))

    def test_sns_panel_preset_filters_subs(self):
        from core.support.sns import SnsNotifyPanel

        settings = {
            "enabled": True, "channel_id": None, "role_id": None, "live_role_id": None,
            "live_enabled": True, "uploads_enabled": True,
            "subs": [
                {"platform": "youtube", "key": "a", "name": "YT", "uid": None,
                 "seen": [], "error": None, "options": {}},
                {"platform": "x", "key": "b", "name": "X", "uid": None,
                 "seen": [], "error": None, "options": {}},
            ],
        }
        panel = SnsNotifyPanel(None, settings, platform="x")
        self.assertEqual([s["platform"] for s in panel.visible_subs()], ["x"])
        live = SnsNotifyPanel(None, settings, live=True)
        self.assertEqual(live.platform, "youtube")
        self.assertEqual([s["platform"] for s in live.visible_subs()], ["youtube"])


if __name__ == "__main__":
    unittest.main()
