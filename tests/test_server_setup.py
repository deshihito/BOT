"""/setup ウィザード・サーバー参加時のあいさつ・認証の改善のテスト。Supabase は偽物、ファイルは一時フォルダにだけ書く。"""

import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import discord  # noqa: E402

from core import guild_settings  # noqa: E402
from core.storage import KVStore  # noqa: E402
from tests.fake_kv_supabase import FakeKVSupabase  # noqa: E402
from cogs import auth, server_setup  # noqa: E402

ALL = discord.Permissions.all()
NONE = discord.Permissions.none()
BASIC = discord.Permissions(view_channel=True, send_messages=True, embed_links=True)


class FakeRole:
    def __init__(self, role_id, name, position):
        self.id, self.name, self.position = role_id, name, position
        self.mention = f"<@&{role_id}>"

    def __ge__(self, other):
        return self.position >= other.position

    def __lt__(self, other):
        return self.position < other.position


class FakeChannel:
    def __init__(self, channel_id, name, position=0, perms=ALL):
        self.id, self.name, self.position, self.perms = channel_id, name, position, perms
        self.mention = f"<#{channel_id}>"
        self.send = AsyncMock()
        self.hooks = []
        self.created = []

    def permissions_for(self, member):
        return self.perms

    async def webhooks(self):
        return list(self.hooks)

    async def create_webhook(self, name):
        hook = FakeWebhook(owner_id=1, name=name)
        self.created.append(hook)
        return hook


class FakeWebhook:
    def __init__(self, owner_id, name="hook", token="t"):
        self.user = types.SimpleNamespace(id=owner_id) if owner_id else None
        self.name, self.token = name, token
        self.send = AsyncMock()


class FakeGuild:
    def __init__(self, guild_perms=ALL, bot_top=10):
        self.id = 77
        self.top = FakeRole(900, "AGOBOT", bot_top)
        self.me = types.SimpleNamespace(guild_permissions=guild_perms, top_role=self.top)
        self.verified = FakeRole(501, "認証済み", 5)
        self.mod = FakeRole(502, "モデレーター", 6)
        self.roles = {r.id: r for r in (self.top, self.verified, self.mod)}
        self.general = FakeChannel(601, "general", 0)
        self.intro = FakeChannel(602, "自己紹介", 1)
        self.channels = {c.id: c for c in (self.general, self.intro)}
        self.system_channel = None

    @property
    def text_channels(self):
        return list(self.channels.values())

    def get_role(self, role_id):
        return self.roles.get(role_id)

    def get_channel(self, channel_id):
        return self.channels.get(channel_id)


class FakeResponse:
    def __init__(self):
        self.edit_message = AsyncMock()
        self.send_message = AsyncMock()
        self.send_modal = AsyncMock()
        self.defer = AsyncMock()


def fake_interaction(guild, user_id=42, roles=()):
    user = types.SimpleNamespace(id=user_id, roles=list(roles), display_name="Discordたろう",
                                 display_avatar=types.SimpleNamespace(url="https://example.com/a.png"),
                                 add_roles=AsyncMock())
    return types.SimpleNamespace(guild=guild, guild_id=guild.id, user=user, channel=guild.general,
                                 response=FakeResponse(), followup=types.SimpleNamespace(send=AsyncMock()),
                                 client=types.SimpleNamespace(user=types.SimpleNamespace(id=1)))


class Base(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = os.path.join(self.tmp.name, "bot_kv.json")
        self.db = FakeKVSupabase()
        guild_settings.set_store(self.new_store())
        self.addCleanup(guild_settings.set_store, None)
        self.guild = FakeGuild()
        self.cogs = {}
        self.bot = types.SimpleNamespace(get_cog=self.cogs.get, user=types.SimpleNamespace(id=1, name="AGOBOT"))
        self.cog = server_setup.ServerSetup(self.bot)

    def new_store(self):
        return guild_settings.GuildSettings(KVStore("guild_settings", client=self.db, path=self.path))

    def wizard(self, user_id=42):
        return server_setup.SetupWizard(self.cog, self.guild, self.guild.general, user_id)

    def reload(self, section="auth"):
        """Supabase に保存された内容。"""
        return (self.db.value("guild_settings", str(self.guild.id)) or {}).get(section, {})

    @staticmethod
    def labels(view):
        return [getattr(item, "label", None) or getattr(item, "placeholder", None) for item in view.children]


class WizardAuthTest(Base):
    async def test_steps_without_optional_cogs(self):
        self.assertEqual(self.wizard().steps, ["auth", "global", "nation", "summary"])

    async def test_auth_selections_persist_and_show_on_rerun(self):
        view = self.wizard()
        await view.on_auth_role(fake_interaction(self.guild), types.SimpleNamespace(values=[self.guild.verified]))
        await view.on_auth_channel(fake_interaction(self.guild), types.SimpleNamespace(values=[self.guild.intro]))
        await view.on_auth_toggle(fake_interaction(self.guild))
        self.assertEqual(self.reload(), {"role_id": 501, "intro_channel_id": 602, "enabled": False})

        os.remove(self.path)  # ローカルのファイルが消えて再起動しても
        guild_settings.set_store(self.new_store())
        await guild_settings.get_store().ensure_loaded()  # 旧/setup画面なしでも保存済み設定を読み直せる
        again = self.wizard()
        fields = {f.name: f.value for f in again.embed().fields}
        self.assertEqual(fields, {"フォーム": "停止中", "付けるロール": "<@&501>", "自己紹介チャンネル": "<#602>"})
        role_select = next(i for i in again.children if isinstance(i, discord.ui.RoleSelect))
        self.assertEqual([d.id for d in role_select.default_values], [501])
        self.assertIn("フォームを有効にする", self.labels(again))

    async def test_refresh_edits_message_with_note(self):
        view = self.wizard()
        interaction = fake_interaction(self.guild)
        await view.on_auth_role(interaction, types.SimpleNamespace(values=[self.guild.verified]))
        kwargs = interaction.response.edit_message.await_args.kwargs
        self.assertIn("<@&501>", kwargs["embed"].description)
        self.assertIs(kwargs["view"], view)

    async def test_send_panel_needs_role_and_uses_settings_panel(self):
        view = self.wizard()
        await view.on_send_panel(fake_interaction(self.guild))
        self.guild.general.send.assert_not_awaited()
        await view.set_auth(role_id=501)
        await view.on_send_panel(fake_interaction(self.guild))
        sent_view = self.guild.general.send.await_args.kwargs["view"]
        self.assertEqual(sent_view.children[0].custom_id, auth.PANEL_SETTINGS_ID)

    async def test_category_perms_needs_role_then_syncs(self):
        view = self.wizard()
        children = [MagicMock(edit=AsyncMock()), MagicMock(edit=AsyncMock())]
        category = types.SimpleNamespace(id=777, name="会員", channels=children, edit=AsyncMock(),
                                         guild=types.SimpleNamespace(default_role="EVERYONE"))
        self.guild.get_channel = lambda cid, _orig=self.guild.get_channel: category if cid == 777 else _orig(cid)
        select = types.SimpleNamespace(values=[types.SimpleNamespace(id=777)])
        await view.on_category_perms(fake_interaction(self.guild), select)
        category.edit.assert_not_awaited()
        await view.set_auth(role_id=501)
        interaction = fake_interaction(self.guild)
        await view.on_category_perms(interaction, select)
        overwrites = category.edit.await_args.kwargs["overwrites"]
        self.assertFalse(overwrites["EVERYONE"].view_channel)
        self.assertTrue(overwrites[self.guild.verified].view_channel)
        for child in children:
            child.edit.assert_awaited_with(sync_permissions=True)
        self.assertIn("2 チャンネル", interaction.response.edit_message.await_args.kwargs["embed"].description)

    async def test_only_invoker_can_operate(self):
        view = self.wizard(user_id=42)
        other = fake_interaction(self.guild, user_id=99)
        self.assertFalse(await view.interaction_check(other))
        other.response.send_message.assert_awaited()
        self.assertTrue(await view.interaction_check(fake_interaction(self.guild, user_id=42)))

    async def test_navigation_skips(self):
        view = self.wizard()
        for expected in ("global", "nation", "summary", "summary"):
            await view.on_next(fake_interaction(self.guild))
            self.assertEqual(view.step, expected)
        self.assertIn("完了", self.labels(view))
        await view.on_back(fake_interaction(self.guild))
        self.assertEqual(view.step, "nation")
        self.assertEqual(self.reload(), {})  # 飛ばしただけでは何も保存しない


class WizardOtherStepsTest(Base):
    async def test_global_chat_toggle_uses_existing_store(self):
        chat = types.SimpleNamespace(active_channels={12345}, save_channels=MagicMock())
        self.cogs["GlobalChatCog"] = chat
        view = self.wizard()
        view.index = view.steps.index("global")
        view.build()
        self.assertIn("このチャンネルをつなぐ", self.labels(view))
        await view.on_global_toggle(fake_interaction(self.guild))
        self.assertEqual(chat.active_channels, {12345, 601})
        chat.save_channels.assert_called_once()
        self.assertIn("このチャンネルを外す", self.labels(view))
        await view.on_global_toggle(fake_interaction(self.guild))
        self.assertEqual(chat.active_channels, {12345})

    async def test_mute_step_only_when_muted_can_save(self):
        self.cogs["Muted"] = types.SimpleNamespace(admin_roles={})  # メモリだけの古い版
        self.assertNotIn("mute", self.wizard().steps)

        muted = types.SimpleNamespace(admin_roles={}, save=AsyncMock())
        self.cogs["Muted"] = muted
        view = self.wizard()
        self.assertEqual(view.steps, ["auth", "global", "mute", "nation", "summary"])
        await view.on_mute_role(fake_interaction(self.guild), types.SimpleNamespace(values=[self.guild.mod]))
        self.assertEqual(muted.admin_roles, {77: 502})
        muted.save.assert_awaited_once_with(77)


class NationSetupTest(Base):
    def nation_view(self):
        view = self.wizard()
        view.index = view.steps.index("nation")
        view.build()
        return view

    async def test_defaults_without_settings(self):
        self.assertEqual(guild_settings.nation_settings(77), {"enabled": True, "channel_id": None, "notify": "major"})
        self.assertIsNone(guild_settings.nation_should_notify(77, major=True))
        view = self.nation_view()
        self.assertIn("参加をやめる", self.labels(view))
        self.assertIn("通知: 大きな出来事だけ", self.labels(view))
        self.assertIn("通知: 全部", self.labels(view))

    async def test_settings_persist_and_helper_reads_them(self):
        view = self.nation_view()
        await view.on_nation_channel(fake_interaction(self.guild), types.SimpleNamespace(values=[self.guild.intro]))
        self.assertEqual(guild_settings.nation_should_notify(77, major=True), 602)
        self.assertIsNone(guild_settings.nation_should_notify(77, major=False))
        await view.on_nation_notify(fake_interaction(self.guild), "all")
        self.assertEqual(guild_settings.nation_should_notify(77, major=False), 602)
        self.assertEqual(self.reload("nation"), {"channel_id": 602, "notify": "all"})
        await view.on_nation_toggle(fake_interaction(self.guild))
        self.assertFalse(guild_settings.nation_settings(77)["enabled"])
        self.assertIsNone(guild_settings.nation_should_notify(77, major=True))
        self.assertIn("参加する", self.labels(view))
        # 読み直しても残っている
        guild_settings.set_store(self.new_store())
        await guild_settings.get_store().ensure_loaded()
        self.assertEqual(guild_settings.nation_settings(77), {"enabled": False, "channel_id": 602, "notify": "all"})

    async def test_bad_stored_values_fall_back_to_defaults(self):
        await guild_settings.get_store().update(77, "nation", enabled="yes", channel_id="x", notify="loud")
        self.assertEqual(guild_settings.nation_settings(77), {"enabled": True, "channel_id": None, "notify": "major"})

    async def test_summary_and_permission_check(self):
        await guild_settings.get_store().update(77, "nation", channel_id=602)
        self.guild.intro.perms = server_setup.discord.Permissions(view_channel=True)
        view = self.wizard()
        view.index = len(view.steps) - 1
        fields = {f.name: f.value for f in view.embed().fields}
        self.assertIn("<#602>", fields["国づくり"])
        self.assertIn("<:failed:1490986584676368535> **国づくり**", fields["Bot の権限チェック"])
        await view.set_nation(enabled=False)
        fields = {f.name: f.value for f in view.embed().fields}
        self.assertEqual(fields["国づくり"], "参加しない")
        self.assertIn("➖ **国づくり**", fields["Bot の権限チェック"])


class SettingsStorageTest(Base):
    async def test_missing_table_falls_back_to_local_file(self):
        from tests.fake_kv_supabase import missing_table_error
        self.db.error = missing_table_error()
        with self.assertLogs("core.storage", level="WARNING"):
            await guild_settings.get_store().update(self.guild.id, "auth", role_id=501)
        restarted = self.new_store()  # Supabase が使えなくても、ローカルの控えから戻る
        self.assertEqual(restarted.get(self.guild.id, "auth"), {"role_id": 501})

    async def test_clearing_last_value_deletes_row(self):
        store = guild_settings.get_store()
        await store.update(self.guild.id, "auth", role_id=501)
        await store.update(self.guild.id, "auth", role_id=None)
        self.assertIsNone(self.db.value("guild_settings", str(self.guild.id)))

    async def test_mute_step_with_real_muted_cog(self):
        from cogs import muted
        cog = muted.Muted(types.SimpleNamespace(get_guild=lambda gid: None, is_ready=lambda: False),
                          store=KVStore("muted", client=self.db, path=self.path))
        self.addCleanup(cog.cog_unload)
        self.cogs["Muted"] = cog
        view = self.wizard()
        self.assertIn("mute", view.steps)
        await view.on_mute_role(fake_interaction(self.guild), types.SimpleNamespace(values=[self.guild.mod]))
        self.assertEqual(self.db.value("muted", "77"), {"admin_role_id": 502})


class PermissionCheckTest(Base):
    async def test_missing_permissions_listed_per_feature(self):
        self.guild = FakeGuild(guild_perms=discord.Permissions(connect=True), bot_top=3)
        self.guild.intro.perms = BASIC
        get_store = guild_settings.get_store()
        await get_store.update(self.guild.id, "auth", role_id=501, intro_channel_id=602)
        results = {r["label"]: r for r in self.wizard().permission_results()}
        self.assertEqual(results["基本（このチャンネル）"]["missing"], [])
        self.assertEqual(results["認証"]["missing"], ["ロールの管理", "ウェブフックの管理"])
        self.assertIn("Bot のロールを「認証済み」より上に移動してください", results["認証"]["notes"])
        self.assertEqual(results["ボイス・音楽"]["missing"], ["ボイスチャンネルで発言"])
        self.assertTrue(results["グローバルチャット"]["skipped"])

        report = server_setup.format_permission_report(list(results.values()))
        self.assertIn("<:failed:1490986584676368535> **認証**: 足りない権限: ロールの管理、ウェブフックの管理", report)
        self.assertIn("<:success:1490985168100659322> **基本（このチャンネル）**: OK", report)
        self.assertIn("➖ **グローバルチャット**", report)

    async def test_summary_all_ok(self):
        await guild_settings.get_store().update(self.guild.id, "auth", role_id=501, intro_channel_id=602)
        view = self.wizard()
        view.index = len(view.steps) - 1
        report = next(f.value for f in view.embed().fields if f.name == "Bot の権限チェック")
        self.assertNotIn("<:failed:1490986584676368535>", report)
        self.assertIn("<:success:1490985168100659322> **認証**: OK", report)

    async def test_disabled_auth_not_checked(self):
        await guild_settings.get_store().update(self.guild.id, "auth", enabled=False)
        results = {r["label"]: r for r in self.wizard().permission_results()}
        self.assertTrue(results["認証"]["skipped"])


class WelcomeTest(Base):
    async def test_prefers_writable_system_channel(self):
        self.guild.system_channel = self.guild.intro
        self.assertIs(server_setup.pick_welcome_channel(self.guild), self.guild.intro)

    async def test_falls_back_to_first_writable_channel(self):
        self.guild.system_channel = FakeChannel(700, "system", perms=NONE)
        self.guild.general.perms = discord.Permissions(view_channel=True, send_messages=True)  # 埋め込み不可
        self.assertIs(server_setup.pick_welcome_channel(self.guild), self.guild.intro)

    async def test_no_writable_channel_sends_nothing(self):
        for channel in self.guild.channels.values():
            channel.perms = NONE
        self.assertIsNone(server_setup.pick_welcome_channel(self.guild))
        await self.cog.on_guild_join(self.guild)
        for channel in self.guild.channels.values():
            channel.send.assert_not_awaited()

    async def test_on_guild_join_posts_welcome(self):
        await self.cog.on_guild_join(self.guild)
        embed = self.guild.general.send.await_args.kwargs["embed"]
        for text in ("/help", "/game", "今北産業"):
            self.assertIn(text, embed.description)
        self.assertNotIn("/setup", embed.description)


class AuthTest(Base):
    def modal(self, role_id=501, intro_channel_id=602):
        modal = auth.QuestionModal(role_id, intro_channel_id)
        for item, value in ((modal.q1, "たろう"), (modal.q2, "@everyone 元気"), (modal.q3, "発想型"), (modal.q4, "Y")):
            item._value = value
        return modal

    async def test_sanitize_webhook_name(self):
        name = auth.sanitize_webhook_name("Discordたろう")
        self.assertNotIn("discord", name.lower())
        self.assertIn("たろう", name)
        self.assertNotIn("clyde", auth.sanitize_webhook_name("Clyde").lower())
        self.assertEqual(auth.sanitize_webhook_name("  "), "名無し")
        self.assertEqual(auth.sanitize_webhook_name("everyone"), "everyoneさん")
        self.assertEqual(len(auth.sanitize_webhook_name("あ" * 100)), 80)

    async def test_verified_user_refused_at_button_and_submit(self):
        interaction = fake_interaction(self.guild, roles=[self.guild.verified])
        await self.cogs_auth().start_verification(interaction, "501")
        interaction.response.send_modal.assert_not_awaited()
        self.assertIn("すでに認証済み", interaction.response.send_message.await_args.args[0])

        interaction = fake_interaction(self.guild, roles=[self.guild.verified])
        await self.modal().on_submit(interaction)
        interaction.user.add_roles.assert_not_awaited()
        self.assertIn("すでに認証済み", interaction.response.send_message.await_args.args[0])

    def cogs_auth(self):
        return auth.VerificationCog(self.bot)

    async def test_settings_panel_and_disabled_form(self):
        cog = self.cogs_auth()
        interaction = fake_interaction(self.guild)
        await cog.start_verification(interaction, "settings")
        self.assertIn("サーバー管理者にお問い合わせ", interaction.response.send_message.await_args.args[0])  # ロール未設定

        await guild_settings.get_store().update(self.guild.id, "auth", role_id=501, intro_channel_id=602)
        interaction = fake_interaction(self.guild)
        await cog.start_verification(interaction, "settings")
        modal = interaction.response.send_modal.await_args.args[0]
        self.assertEqual((modal.role_id, modal.intro_channel_id), (501, 602))

        await guild_settings.get_store().update(self.guild.id, "auth", enabled=False)
        interaction = fake_interaction(self.guild)
        await cog.start_verification(interaction, "501")
        interaction.response.send_modal.assert_not_awaited()
        self.assertIn("停止", interaction.response.send_message.await_args.args[0])

    async def test_old_panel_uses_old_intro_channel_by_default(self):
        interaction = fake_interaction(self.guild)
        await self.cogs_auth().start_verification(interaction, "501")
        modal = interaction.response.send_modal.await_args.args[0]
        self.assertEqual((modal.role_id, modal.intro_channel_id), (501, auth.INTRO_CHANNEL_ID))

    async def test_success_posts_with_mentions_disabled_via_own_webhook(self):
        foreign, own = FakeWebhook(owner_id=555, name="他のBot"), FakeWebhook(owner_id=1, name=auth.WEBHOOK_NAME)
        self.guild.intro.hooks = [foreign, own]
        interaction = fake_interaction(self.guild)
        await self.modal().on_submit(interaction)
        interaction.user.add_roles.assert_awaited_once()
        foreign.send.assert_not_awaited()
        kwargs = own.send.await_args.kwargs
        self.assertEqual(kwargs["allowed_mentions"].to_dict()["parse"], [])
        self.assertNotIn("discord", kwargs["username"].lower())
        self.assertIn("@everyone 元気", kwargs["content"])
        self.assertIn("認証が完了", interaction.followup.send.await_args.args[0])

    async def test_creates_own_webhook_when_only_foreign_exist(self):
        self.guild.intro.hooks = [FakeWebhook(owner_id=555)]
        await self.modal().on_submit(fake_interaction(self.guild))
        self.assertEqual(len(self.guild.intro.created), 1)
        self.assertEqual(self.guild.intro.created[0].name, auth.WEBHOOK_NAME)
        self.guild.intro.created[0].send.assert_awaited_once()

    async def test_add_roles_failure_tells_reason_and_skips_intro(self):
        own = FakeWebhook(owner_id=1)
        self.guild.intro.hooks = [own]
        self.guild.top.position = 2  # Bot のロールが認証ロールより下
        interaction = fake_interaction(self.guild)
        interaction.user.add_roles.side_effect = discord.Forbidden(types.SimpleNamespace(status=403, reason="x"), "x")
        await self.modal().on_submit(interaction)
        own.send.assert_not_awaited()
        text = interaction.followup.send.await_args.args[0]
        self.assertIn("認証できませんでした", text)
        self.assertIn("「認証済み」より下", text)

    async def test_failure_reason_missing_manage_roles(self):
        self.guild.me.guild_permissions = NONE
        self.assertIn("ロールの管理", auth.role_failure_reason(self.guild, self.guild.verified))


if __name__ == "__main__":
    unittest.main()


class WizardModerationTest(Base):
    async def test_moderation_button_and_save(self):
        self.cogs["GlobalChatCog"] = types.SimpleNamespace(active_channels=set(), save_channels=MagicMock())
        view = self.wizard()
        view.index = view.steps.index("global")
        view.build()
        self.assertIn("荒らし対策（NG ワード・ブロック）", self.labels(view))
        it = fake_interaction(self.guild)
        await view.on_moderation(it)
        modal = it.response.send_modal.await_args.args[0]
        self.assertIsInstance(modal, server_setup.ModerationModal)
        await view.save_moderation(fake_interaction(self.guild), "スパム, 宣伝\nスパム",
                                   "<@111> 222", f"333, {self.guild.id}, abc")
        saved = self.reload("globalchat")
        self.assertEqual(saved, {"ng_words": ["スパム", "宣伝"], "blocked_users": [111, 222], "blocked_guilds": [333]})
        await view.save_moderation(fake_interaction(self.guild), "", "", "")
        self.assertEqual(self.reload("globalchat"), {})
