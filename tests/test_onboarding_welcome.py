"""導入メッセージ v2（welcome_stats / WelcomeView / welcome:* リスナー）のテスト。"""

import os
import sys
import tempfile
import types
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import discord  # noqa: E402

from core.support import guild_settings  # noqa: E402
from core.support.storage import KVStore  # noqa: E402
from core.support.localization import localization  # noqa: E402
from core.support.server_setup import cog as setup_cog  # noqa: E402
from tests.fake_kv_supabase import FakeKVSupabase  # noqa: E402


def view_texts(view):
    texts = []

    def walk(item):
        if isinstance(item, discord.ui.TextDisplay):
            texts.append(item.content)
        for child in getattr(item, "children", []) or []:
            walk(child)

    for top in view.children:
        walk(top)
    return texts


def find_select(view):
    found = []

    def walk(item):
        if isinstance(item, discord.ui.Select):
            found.append(item)
        for child in getattr(item, "children", []) or []:
            walk(child)

    for top in view.children:
        walk(top)
    return found[0] if found else None


class WelcomeStatsTest(unittest.TestCase):
    def test_stats_come_from_single_sources_of_truth(self):
        from core.general.action_registry import ROOT_ORDER, default_registry
        from core.game.game.game_guides import GAME_ORDER

        stats = setup_cog.welcome_stats()
        self.assertEqual(stats["commands"], len(ROOT_ORDER) + 1)
        self.assertEqual(stats["actions"], len(default_registry()))
        self.assertEqual(stats["games"], len(GAME_ORDER))

    def test_command_count_matches_current_top_level(self):
        # トップレベルは /general /vc /game /support /help /quick の6つ。
        # ルートが増えたら ROOT_ORDER と一緒にこの数字も見直すこと。
        self.assertEqual(setup_cog.welcome_stats()["commands"], 6)

    def test_stats_follow_registry_changes(self):
        import core.general.action_registry as registry_module
        import core.game.game.game_guides as guides_module

        class FakeRegistry:
            def __len__(self):
                return 321

        with patch.object(registry_module, "default_registry", return_value=FakeRegistry()), \
                patch.object(guides_module, "GAME_ORDER", ["a", "b", "c"]):
            stats = setup_cog.welcome_stats()
        self.assertEqual(stats["actions"], 321)
        self.assertEqual(stats["games"], 3)

    def test_stats_failure_returns_none(self):
        import core.general.action_registry as registry_module

        with patch.object(registry_module, "default_registry", side_effect=RuntimeError("boom")):
            self.assertIsNone(setup_cog.welcome_stats())

    def test_view_omits_stats_line_when_stats_unavailable(self):
        view = setup_cog.build_welcome_view("AGOBOT", "ja", guild_id=1, stats={})
        joined = "\n".join(view_texts(view))
        self.assertNotIn("-# コマンド", joined)


class WelcomeViewTest(unittest.TestCase):
    def test_language_options_disclose_support_status(self):
        view = setup_cog.build_welcome_view("AGOBOT", "ja", guild_id=1)
        select = find_select(view)
        self.assertEqual(select.custom_id, "welcome:language")
        by_value = {option.value: option for option in select.options}
        self.assertEqual(set(by_value), set(localization.SUPPORTED_LOCALES))
        self.assertTrue(by_value["ja"].default)
        self.assertIn("一部の表示が英語", by_value["en"].description)
        for locale in ("zh", "ko", "id", "th", "ar", "hi"):
            self.assertIn("準備中", by_value[locale].description)

    def test_no_single_feature_spotlight(self):
        for locale in ("ja", "en"):
            joined = "\n".join(view_texts(setup_cog.build_welcome_view("AGOBOT", locale, guild_id=1)))
            self.assertNotIn("今北産業", joined)
            self.assertNotIn("引用画像", joined)
            self.assertNotIn("MIQ", joined)


class ResendGuardTest(unittest.TestCase):
    def test_recent_welcome_blocks_resend(self):
        now = datetime.now(timezone.utc)
        self.assertTrue(setup_cog._welcomed_recently(
            {"welcomed_at": (now - timedelta(minutes=5)).isoformat()}, now))
        self.assertFalse(setup_cog._welcomed_recently(
            {"welcomed_at": (now - timedelta(minutes=30)).isoformat()}, now))
        self.assertFalse(setup_cog._welcomed_recently({}, now))
        self.assertFalse(setup_cog._welcomed_recently({"welcomed_at": "not-a-date"}, now))


class FakePanel(discord.ui.View):
    def __init__(self, cog, genre=None, owner_id=None, **kwargs):
        super().__init__()
        self.cog, self.genre, self.owner_id = cog, genre, owner_id

    def embed(self):
        return discord.Embed(title="panel")


def fake_interaction(guild_id=77, custom_id="welcome:game", values=None, admin=False, guild=None, channel=None):
    permissions = types.SimpleNamespace(administrator=admin, manage_guild=False)
    user = types.SimpleNamespace(id=42, guild_permissions=permissions)
    response = types.SimpleNamespace(
        send_message=AsyncMock(), edit_message=AsyncMock(), is_done=lambda: False)
    return types.SimpleNamespace(
        type=discord.InteractionType.component,
        data={"custom_id": custom_id, "values": values or []},
        guild_id=guild_id, guild=guild, channel=channel, user=user,
        response=response, followup=types.SimpleNamespace(send=AsyncMock()),
    )


def fake_guild(guild_perms, channel_perms=None):
    channel = types.SimpleNamespace(
        permissions_for=lambda me: channel_perms if channel_perms is not None else guild_perms)
    guild = types.SimpleNamespace(
        id=77, me=types.SimpleNamespace(guild_permissions=guild_perms))
    return guild, channel


class OnboardingPermissionsTest(unittest.TestCase):
    def test_all_permissions_ok(self):
        guild, channel = fake_guild(discord.Permissions.all())
        results = setup_cog.check_onboarding_permissions(guild, channel)
        self.assertFalse(setup_cog.has_missing_permissions(results))
        report = setup_cog.format_onboarding_report(results)
        self.assertIn("OK", report)
        self.assertIn("サーバー設定 → ロール", report)

    def test_missing_permissions_use_japanese_labels(self):
        guild, channel = fake_guild(discord.Permissions(view_channel=True, send_messages=True))
        results = setup_cog.check_onboarding_permissions(guild, channel)
        self.assertTrue(setup_cog.has_missing_permissions(results))
        by_label = {r["label"]: r["missing"] for r in results}
        self.assertEqual(by_label["基本（このチャンネル）"], [])
        self.assertIn("ロールの管理", by_label["ロールの管理（認証・ミュート・ロールショップ）"])
        self.assertIn("ウェブフックの管理", by_label["ウェブフックの管理（グローバルチャット・自動翻訳）"])
        report = setup_cog.format_onboarding_report(results)
        self.assertIn("足りない権限: ロールの管理", report)

    def test_status_line_and_button_follow_flags(self):
        view = setup_cog.build_welcome_view("AGOBOT", "ja", guild_id=1,
                                             permissions_button=True, missing_permissions=True)
        joined = "\n".join(view_texts(view))
        self.assertIn("不足している権限があります", joined)
        custom_ids = set()

        def walk(item):
            if getattr(item, "custom_id", None):
                custom_ids.add(item.custom_id)
            for child in getattr(item, "children", []) or []:
                walk(child)

        for top in view.children:
            walk(top)
        self.assertIn("welcome:permissions", custom_ids)


class WelcomeListenerTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.db = FakeKVSupabase()
        store = guild_settings.GuildSettings(
            KVStore("guild_settings", client=self.db, path=os.path.join(self.tmp.name, "bot_kv.json")))
        guild_settings.set_store(store)
        self.addCleanup(guild_settings.set_store, None)
        self.cogs = {}
        self.bot = types.SimpleNamespace(get_cog=self.cogs.get,
                                         user=types.SimpleNamespace(id=1, name="AGOBOT"))
        self.cog = setup_cog.ServerSetup(self.bot)

    async def test_panel_button_opens_panel_ephemerally(self):
        panel = FakePanel(MagicMock())
        with patch.object(setup_cog, "build_panel", return_value=panel) as build:
            interaction = fake_interaction(custom_id="welcome:game")
            await self.cog.on_interaction(interaction)
        build.assert_called_once_with(self.bot, "game")
        kwargs = interaction.response.send_message.await_args.kwargs
        self.assertTrue(kwargs["ephemeral"])
        from core.support.panel_v2 import PanelLayoutView
        self.assertIsInstance(kwargs["view"], PanelLayoutView)

    async def test_panel_button_fallback_names_the_command(self):
        with patch.object(setup_cog, "build_panel", return_value=None):
            interaction = fake_interaction(custom_id="welcome:music")
            await self.cog.on_interaction(interaction)
        message = interaction.response.send_message.await_args.args[0]
        self.assertIn("/vc", message)

    async def test_money_button_opens_general_panel_with_money_genre(self):
        self.cogs["GeneralCog"] = MagicMock()
        import core.general.panel as general_panel

        with patch.object(general_panel, "GeneralPanel", FakePanel):
            interaction = fake_interaction(custom_id="welcome:money")
            await self.cog.on_interaction(interaction)
        view = interaction.response.send_message.await_args.kwargs["view"]
        self.assertEqual(view.panel.genre, "money")
        self.assertEqual(view.panel.owner_id, 42)

    async def test_money_button_fallback_without_general_cog(self):
        interaction = fake_interaction(custom_id="welcome:money")
        await self.cog.on_interaction(interaction)
        message = interaction.response.send_message.await_args.args[0]
        self.assertIn("/general", message)

    async def test_language_change_requires_manage_permission(self):
        interaction = fake_interaction(custom_id="welcome:language", values=["en"], admin=False)
        await self.cog.on_interaction(interaction)
        message = interaction.response.send_message.await_args.args[0]
        self.assertIn("サーバー管理権限", message)
        self.assertEqual(guild_settings.get_store().get(77, "localization"), {})

    async def test_language_change_to_english_edits_message(self):
        set_locale = AsyncMock(return_value="en")
        self.cogs["LocalizationCog"] = types.SimpleNamespace(set_locale=set_locale)
        interaction = fake_interaction(custom_id="welcome:language", values=["en"], admin=True)
        await self.cog.on_interaction(interaction)
        set_locale.assert_awaited_once_with(77, "en")
        view = interaction.response.edit_message.await_args.kwargs["view"]
        self.assertIn("Thanks for adding", view_texts(view)[0])
        note = interaction.followup.send.await_args.args[0]
        self.assertIn("English", note)

    async def test_language_change_to_pending_locale_keeps_japanese_body(self):
        set_locale = AsyncMock(return_value="zh")
        self.cogs["LocalizationCog"] = types.SimpleNamespace(set_locale=set_locale)
        interaction = fake_interaction(custom_id="welcome:language", values=["zh"], admin=True)
        await self.cog.on_interaction(interaction)
        set_locale.assert_awaited_once_with(77, "zh")
        interaction.response.edit_message.assert_not_awaited()
        note = interaction.response.send_message.await_args.args[0]
        self.assertIn("语言已更改为", note)  # language_saved はカタログ内蔵文で返る

    async def test_permissions_button_reports_for_admin(self):
        guild, channel = fake_guild(discord.Permissions(view_channel=True, send_messages=True))
        interaction = fake_interaction(custom_id="welcome:permissions", admin=True,
                                        guild=guild, channel=channel)
        await self.cog.on_interaction(interaction)
        message = interaction.response.send_message.await_args.args[0]
        self.assertIn("足りない権限: ロールの管理", message)
        self.assertTrue(interaction.response.send_message.await_args.kwargs["ephemeral"])

    async def test_permissions_button_rejects_non_admin(self):
        guild, channel = fake_guild(discord.Permissions.all())
        interaction = fake_interaction(custom_id="welcome:permissions", admin=False,
                                        guild=guild, channel=channel)
        await self.cog.on_interaction(interaction)
        message = interaction.response.send_message.await_args.args[0]
        self.assertIn("管理者だけ", message)

    async def test_unrelated_custom_id_is_ignored(self):
        interaction = fake_interaction(custom_id="panel:game:select")
        await self.cog.on_interaction(interaction)
        interaction.response.send_message.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
