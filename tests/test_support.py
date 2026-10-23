import types
import unittest
from datetime import timedelta
from unittest.mock import AsyncMock, patch

from cogs.support import (
    ActivityLogSettingsView, BINJOU_SECTION, EmojiBinjouView, MESSAGE_LOG_SECTION, MODERATION_LOG_SECTION,
    RoleBulkView, RoleTargetSelect, SupportCog, SUPPORT_ACTIONS, THINKING_EMOJI,
    THINKING_SECTION, VC_LOG_SECTION, get_activity_log_settings, get_binjou_settings,
    get_vc_log_settings,
)


class FakeRole:
    def __init__(self, role_id=10):
        self.id = role_id
        self.mention = f"<@&{role_id}>"

    def __eq__(self, other):
        return isinstance(other, FakeRole) and self.id == other.id
    def __ge__(self, other):
        return self.id >= other.id
    def is_default(self):
        return self.id == 0
    managed = False


def role_guild(members):
    return types.SimpleNamespace(
        members=members,
        me=types.SimpleNamespace(
            guild_permissions=types.SimpleNamespace(manage_roles=True),
            top_role=FakeRole(999),
        ),
    )


class FakeMember:
    def __init__(self, member_id, roles=(), *, bot=False):
        self.id = member_id
        self.roles = list(roles)
        self.bot = bot
        self.add_roles = AsyncMock(side_effect=self._add)
        self.remove_roles = AsyncMock(side_effect=self._remove)

    async def _add(self, role, **kwargs):
        if role not in self.roles:
            self.roles.append(role)

    async def _remove(self, role, **kwargs):
        if role in self.roles:
            self.roles.remove(role)


class SupportRoleBulkTest(unittest.IsolatedAsyncioTestCase):
    async def test_adds_only_members_without_role(self):
        cog = SupportCog(None)
        role = FakeRole()
        members = [FakeMember(1), FakeMember(2, [role]), FakeMember(3)]
        guild = role_guild(members)
        affected, skipped, failed = await cog.bulk_role_update(guild, role, True)
        self.assertEqual((affected, skipped, failed), (2, 1, 0))
        self.assertIn(role, members[0].roles)
        self.assertIn(role, members[2].roles)
        members[1].add_roles.assert_not_awaited()

    async def test_removes_only_members_with_role(self):
        cog = SupportCog(None)
        role = FakeRole()
        members = [FakeMember(1, [role]), FakeMember(2), FakeMember(3, [role])]
        guild = role_guild(members)
        affected, skipped, failed = await cog.bulk_role_update(guild, role, False)
        self.assertEqual((affected, skipped, failed), (2, 1, 0))
        self.assertNotIn(role, members[0].roles)
        self.assertNotIn(role, members[2].roles)
        members[1].remove_roles.assert_not_awaited()

    async def test_bots_are_excluded_by_default(self):
        cog = SupportCog(None)
        role = FakeRole()
        human = FakeMember(1)
        bot = FakeMember(2, bot=True)
        guild = role_guild([human, bot])
        affected, skipped, failed = await cog.bulk_role_update(guild, role, True)
        self.assertEqual((affected, skipped, failed), (1, 1, 0))
        human.add_roles.assert_awaited_once()
        bot.add_roles.assert_not_awaited()

    async def test_bots_can_be_included_with_all_mode(self):
        cog = SupportCog(None)
        role = FakeRole()
        bot = FakeMember(2, bot=True)
        guild = role_guild([bot])
        affected, skipped, failed = await cog.bulk_role_update(guild, role, True, target_mode="all")
        self.assertEqual((affected, skipped, failed), (1, 0, 0))
        bot.add_roles.assert_awaited_once()

    async def test_bots_only_mode_excludes_human_members(self):
        cog = SupportCog(None)
        role = FakeRole()
        human = FakeMember(1)
        bot = FakeMember(2, bot=True)
        guild = role_guild([human, bot])
        affected, skipped, failed = await cog.bulk_role_update(guild, role, True, target_mode="bots")
        self.assertEqual((affected, skipped, failed), (1, 1, 0))
        human.add_roles.assert_not_awaited()
        bot.add_roles.assert_awaited_once()

    def test_support_has_role_bulk_action_and_panel(self):
        self.assertIn("role_bulk", [choice.value for choice in SUPPORT_ACTIONS])
        self.assertIn("binjou", [choice.value for choice in SUPPORT_ACTIONS])
        view = RoleBulkView(SupportCog(None), types.SimpleNamespace(), FakeRole())
        self.assertEqual(len(view.children), 4)
        self.assertEqual(view.target_mode, "humans")
        self.assertIn("人間のみ", view.description())
        target_select = next(item for item in view.children if isinstance(item, RoleTargetSelect))
        self.assertIn("bots", [option.value for option in target_select.options])

    def test_selected_role_is_checked_against_bot_hierarchy(self):
        role = FakeRole(20)
        guild = role_guild([])
        guild.me.top_role = FakeRole(10)
        view = RoleBulkView(SupportCog(None), guild, role)
        self.assertIn("上位", view.role_error())


class SupportThinkingReactionTest(unittest.IsolatedAsyncioTestCase):
    def test_raw_reaction_listener_is_registered_on_the_cog(self):
        listeners = dict(SupportCog.__cog_listeners__)
        self.assertEqual(listeners.get("on_raw_reaction_add"), "on_raw_reaction_add")
        self.assertEqual(THINKING_EMOJI._as_reaction(), "thinking:1561695212814995596")

    def make_cog(self, enabled):
        message = types.SimpleNamespace(reactions=[], add_reaction=AsyncMock())
        channel = types.SimpleNamespace(fetch_message=AsyncMock(return_value=message))
        bot = types.SimpleNamespace(
            user=types.SimpleNamespace(id=999),
            get_channel=lambda channel_id: channel,
        )
        cog = SupportCog(bot)
        store = types.SimpleNamespace(
            ensure_loaded=AsyncMock(),
            get=lambda guild_id, section: (
                {"enabled": enabled} if section == THINKING_SECTION and enabled is not None else {}
            ),
        )
        return cog, store, channel, message

    async def test_adds_custom_reaction_when_enabled(self):
        cog, store, channel, message = self.make_cog(True)
        payload = types.SimpleNamespace(
            guild_id=1, user_id=2, emoji="🤔", member=types.SimpleNamespace(bot=False),
            channel_id=3, message_id=4,
        )
        with patch("cogs.support.guild_settings.get_store", return_value=store):
            await cog.on_raw_reaction_add(payload)
        message.add_reaction.assert_awaited_once_with(THINKING_EMOJI)
        channel.fetch_message.assert_awaited_once_with(4)

    async def test_setting_defaults_to_enabled_for_unconfigured_guild(self):
        cog, store, channel, message = self.make_cog(None)
        store.get = lambda guild_id, section: {}
        payload = types.SimpleNamespace(
            guild_id=1, user_id=2, emoji="🤔", member=types.SimpleNamespace(bot=False),
            channel_id=3, message_id=4,
        )
        with patch("cogs.support.guild_settings.get_store", return_value=store):
            await cog.on_raw_reaction_add(payload)
        message.add_reaction.assert_awaited_once_with(THINKING_EMOJI)

    async def test_thumbsup_reaction_is_mirrored_with_same_emoji(self):
        cog, store, channel, message = self.make_cog(None)
        payload = types.SimpleNamespace(
            guild_id=1, user_id=2, emoji="👍", member=types.SimpleNamespace(bot=False),
            channel_id=3, message_id=4,
        )
        with patch("cogs.support.guild_settings.get_store", return_value=store):
            await cog.on_raw_reaction_add(payload)
        message.add_reaction.assert_awaited_once_with("👍")

    async def test_explicitly_disabled_thumbsup_setting_does_not_mirror(self):
        cog, store, channel, message = self.make_cog(None)
        store.get = lambda guild_id, section: (
            {"thumbsup": False} if section == BINJOU_SECTION else {}
        )
        payload = types.SimpleNamespace(
            guild_id=1, user_id=2, emoji="👍", member=types.SimpleNamespace(bot=False),
            channel_id=3, message_id=4,
        )
        with patch("cogs.support.guild_settings.get_store", return_value=store):
            await cog.on_raw_reaction_add(payload)
        channel.fetch_message.assert_not_awaited()
        message.add_reaction.assert_not_awaited()

    def test_binjou_settings_preserve_legacy_thinking_choice_and_default_thumbsup_on(self):
        store = types.SimpleNamespace(
            get=lambda guild_id, section: (
                {"enabled": False} if section == THINKING_SECTION else {}
            )
        )
        self.assertEqual(
            get_binjou_settings(store, 1),
            {"thinking": False, "thumbsup": True, "custom": []},
        )

    def test_binjou_controls_are_separately_configurable(self):
        view = EmojiBinjouView(SupportCog(None), {"thinking": True, "thumbsup": False})
        self.assertEqual(len(view.children), 6)
        self.assertEqual(view.settings, {"thinking": True, "thumbsup": False})
        self.assertEqual(BINJOU_SECTION, "binjou")

    async def test_custom_rule_adds_configured_reaction(self):
        cog, store, channel, message = self.make_cog(None)
        store.get = lambda guild_id, section: (
            {"custom": [{"source": "✨", "target": "🎉"}]} if section == BINJOU_SECTION else {}
        )
        payload = types.SimpleNamespace(
            guild_id=1, user_id=2, emoji="✨", member=types.SimpleNamespace(bot=False),
            channel_id=3, message_id=4,
        )
        with patch("cogs.support.guild_settings.get_store", return_value=store):
            await cog.on_raw_reaction_add(payload)
        message.add_reaction.assert_awaited_once_with("🎉")

    async def test_explicitly_disabled_setting_does_not_mirror(self):
        cog, store, channel, message = self.make_cog(False)
        payload = types.SimpleNamespace(
            guild_id=1, user_id=2, emoji="🤔", member=types.SimpleNamespace(bot=False),
            channel_id=3, message_id=4,
        )
        with patch("cogs.support.guild_settings.get_store", return_value=store):
            await cog.on_raw_reaction_add(payload)
        channel.fetch_message.assert_not_awaited()
        message.add_reaction.assert_not_awaited()


class SupportVCLogTest(unittest.IsolatedAsyncioTestCase):
    def make_event(self, enabled=True, channel_id=90):
        guild = types.SimpleNamespace(id=1)
        target = types.SimpleNamespace(guild=guild, send=AsyncMock())
        bot = types.SimpleNamespace(
            get_channel=lambda _channel_id: target if _channel_id == channel_id else None,
            fetch_channel=AsyncMock(return_value=target),
        )
        cog = SupportCog(bot)
        store = types.SimpleNamespace(
            ensure_loaded=AsyncMock(),
            get=lambda _guild_id, section: (
                {"enabled": enabled, "channel_id": channel_id} if section == VC_LOG_SECTION else {}
            ),
        )
        member = types.SimpleNamespace(bot=False, guild=guild, mention="<@5>")
        return cog, store, member, target

    def test_vc_log_defaults_to_off_without_destination(self):
        store = types.SimpleNamespace(get=lambda _guild_id, _section: {})
        self.assertEqual(get_vc_log_settings(store, 1), {"enabled": False, "channel_id": None})
        self.assertIn("vc_log", [choice.value for choice in SUPPORT_ACTIONS])

    async def test_join_and_leave_send_embeds_when_enabled(self):
        cog, store, member, target = self.make_event()
        voice = types.SimpleNamespace(id=20, name="ゲームVC")
        with patch("cogs.support.guild_settings.get_store", return_value=store):
            await cog.on_voice_state_update(member, types.SimpleNamespace(channel=None), types.SimpleNamespace(channel=voice))
            await cog.on_voice_state_update(member, types.SimpleNamespace(channel=voice), types.SimpleNamespace(channel=None))
        self.assertEqual(target.send.await_count, 2)
        sent = [call.kwargs["embed"] for call in target.send.await_args_list]
        self.assertEqual([embed.title for embed in sent], ["VC入室", "VC退室"])
        self.assertIn("<@5>", sent[0].description)
        self.assertIn("ゲームVC", sent[1].description)
        self.assertIn("ゲームVC** に入室しました", sent[0].description)
        self.assertIn("ゲームVC** から退室しました", sent[1].description)

    async def test_switching_voice_channels_sends_exit_then_join(self):
        cog, store, member, target = self.make_event()
        before = types.SimpleNamespace(channel=types.SimpleNamespace(id=20, name="旧VC"))
        after = types.SimpleNamespace(channel=types.SimpleNamespace(id=21, name="新VC"))
        with patch("cogs.support.guild_settings.get_store", return_value=store):
            await cog.on_voice_state_update(member, before, after)
        sent = [call.kwargs["embed"] for call in target.send.await_args_list]
        self.assertEqual([embed.title for embed in sent], ["VC退室", "VC入室"])

    async def test_disabled_vc_log_sends_nothing(self):
        cog, store, member, target = self.make_event(enabled=False)
        voice = types.SimpleNamespace(id=20, name="ゲームVC")
        with patch("cogs.support.guild_settings.get_store", return_value=store):
            await cog.on_voice_state_update(member, types.SimpleNamespace(channel=None), types.SimpleNamespace(channel=voice))
        target.send.assert_not_awaited()


class SupportActivityLogTest(unittest.IsolatedAsyncioTestCase):
    def make_cog(self, section, enabled=True):
        guild = types.SimpleNamespace(id=1)
        target = types.SimpleNamespace(guild=guild, send=AsyncMock())
        bot = types.SimpleNamespace(
            get_channel=lambda _channel_id: target,
            fetch_channel=AsyncMock(return_value=target),
        )
        cog = SupportCog(bot)
        store = types.SimpleNamespace(
            ensure_loaded=AsyncMock(),
            get=lambda _guild_id, requested: (
                ({"enabled": enabled, "channel_id": 90}
                 | ({"timeout_enabled": True, "kick_enabled": True, "ban_enabled": True}
                    if section == MODERATION_LOG_SECTION else {}))
                if requested == section else {}
            ),
        )
        return cog, store, guild, target

    def test_activity_log_defaults_to_off(self):
        store = types.SimpleNamespace(get=lambda _guild_id, _section: {})
        self.assertEqual(get_activity_log_settings(store, 1, MESSAGE_LOG_SECTION), {"enabled": False, "channel_id": None})
        moderation = get_activity_log_settings(store, 1, MODERATION_LOG_SECTION)
        self.assertEqual(
            {moderation[key] for key in ("timeout_enabled", "kick_enabled", "ban_enabled")},
            {False},
        )
        self.assertIn("message_log", [choice.value for choice in SUPPORT_ACTIONS])
        self.assertIn("moderation_log", [choice.value for choice in SUPPORT_ACTIONS])

    def test_moderation_view_has_individual_toggles(self):
        view = ActivityLogSettingsView(
            SupportCog(None), MODERATION_LOG_SECTION, "モデレート", "説明", {
                "enabled": True, "channel_id": 90,
                "timeout_enabled": True, "kick_enabled": False, "ban_enabled": True,
            },
        )
        labels = [item.label for item in view.children if hasattr(item, "label")]
        self.assertIn("TO履歴をオフにする", labels)
        self.assertIn("KICK履歴をオンにする", labels)
        self.assertIn("BAN履歴をオフにする", labels)

    async def test_message_edit_sends_before_and_after_in_embed(self):
        cog, store, guild, target = self.make_cog(MESSAGE_LOG_SECTION)
        author = types.SimpleNamespace(
            id=5, bot=False, mention="<@5>", display_name="編集者",
            display_avatar=types.SimpleNamespace(url="https://avatar"),
        )
        channel = types.SimpleNamespace(id=20, mention="<#20>")
        before = types.SimpleNamespace(guild=guild, author=author, channel=channel, content="編集前")
        after = types.SimpleNamespace(guild=guild, author=author, channel=channel, content="編集後", jump_url="https://message")
        with patch("cogs.support.guild_settings.get_store", return_value=store):
            await cog.on_message_edit(before, after)
        embed = target.send.await_args.kwargs["embed"]
        self.assertEqual(embed.title, "メッセージ編集")
        self.assertEqual({field.name: field.value for field in embed.fields}["編集前"], "編集前")
        self.assertEqual({field.name: field.value for field in embed.fields}["編集後"], "編集後")

    async def test_timeout_sends_executor_target_and_reason(self):
        cog, store, guild, target = self.make_cog(MODERATION_LOG_SECTION)
        target_member = types.SimpleNamespace(id=5, mention="<@5>")
        executor = types.SimpleNamespace(id=7, mention="<@7>", display_name="管理者", display_avatar=types.SimpleNamespace(url="https://avatar"))
        entry = types.SimpleNamespace(target=target_member, user=executor, reason="迷惑行為", created_at=__import__("discord").utils.utcnow())
        async def audit_logs(**kwargs):
            yield entry
        guild.audit_logs = audit_logs
        before = types.SimpleNamespace(guild=guild, id=5, communication_disabled_until=None)
        after = types.SimpleNamespace(guild=guild, id=5, mention="<@5>", communication_disabled_until=__import__("discord").utils.utcnow() + timedelta(hours=1))
        with patch("cogs.support.guild_settings.get_store", return_value=store):
            await cog.on_member_update(before, after)
        embed = target.send.await_args.kwargs["embed"]
        values = {field.name: field.value for field in embed.fields}
        self.assertEqual(embed.title, "タイムアウト（TO）")
        self.assertIn("<@7>", values["対処したユーザー"])
        self.assertIn("<@5>", values["適用されたユーザー"])
        self.assertEqual(values["理由"], "迷惑行為")

    async def test_timeout_uses_discord_py_timed_out_until_and_logs_release(self):
        cog, store, guild, target = self.make_cog(MODERATION_LOG_SECTION)
        executor = types.SimpleNamespace(id=7, mention="<@7>", display_name="管理者")
        guild.audit_logs = lambda **kwargs: self._audit_entry(executor)
        before = types.SimpleNamespace(guild=guild, id=5, timed_out_until=__import__("discord").utils.utcnow())
        after = types.SimpleNamespace(guild=guild, id=5, mention="<@5>", timed_out_until=None)
        with patch("cogs.support.guild_settings.get_store", return_value=store):
            await cog.on_member_update(before, after)
        self.assertEqual(target.send.await_args.kwargs["embed"].title, "タイムアウト解除（TO）")

    @staticmethod
    async def _audit_entry(executor):
        if False:
            yield None

    async def test_kick_and_ban_are_logged(self):
        cog, store, guild, target = self.make_cog(MODERATION_LOG_SECTION)
        user = types.SimpleNamespace(id=5, mention="<@5>", bot=False)
        executor = types.SimpleNamespace(id=7, mention="<@7>", display_name="管理者")
        async def audit_logs(**kwargs):
            action = kwargs["action"]
            if action == __import__("discord").AuditLogAction.kick:
                yield types.SimpleNamespace(target=user, user=executor, reason="ルール違反", created_at=__import__("discord").utils.utcnow())
        guild.audit_logs = audit_logs
        with patch("cogs.support.guild_settings.get_store", return_value=store):
            await cog.on_member_remove(types.SimpleNamespace(guild=guild, id=5, mention="<@5>", bot=False))
        self.assertEqual(target.send.await_args.kwargs["embed"].title, "KICK")

        target.send.reset_mock()
        guild.audit_logs = lambda **kwargs: audit_logs(**kwargs)
        with patch("cogs.support.guild_settings.get_store", return_value=store):
            await cog.on_member_ban(guild, user)
        self.assertEqual(target.send.await_args.kwargs["embed"].title, "BAN")

    async def test_disabled_kick_is_not_sent(self):
        cog, store, guild, target = self.make_cog(MODERATION_LOG_SECTION)
        store.get = lambda _guild_id, section: (
            {"enabled": True, "channel_id": 90, "kick_enabled": False} if section == MODERATION_LOG_SECTION else {}
        )
        with patch("cogs.support.guild_settings.get_store", return_value=store):
            await cog.on_member_remove(types.SimpleNamespace(guild=guild, id=5, mention="<@5>", bot=False))
        target.send.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
