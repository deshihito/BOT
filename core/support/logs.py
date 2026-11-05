# -*- coding: utf-8 -*-
"""活動ログ / モデレーションログ / VCログの UI。元 cogs/support.py から分割。"""
from __future__ import annotations

from .common import *


class ActivityLogChannelSelect(discord.ui.ChannelSelect):
    def __init__(self, parent: "ActivityLogSettingsView"):
        self.parent_view = parent
        super().__init__(
            placeholder="履歴を送るテキストチャンネルを選択",
            channel_types=[discord.ChannelType.text, discord.ChannelType.news],
            min_values=1,
            max_values=1,
        )

    async def callback(self, interaction: discord.Interaction):
        if not self.parent_view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定にはサーバー管理権限が必要です。",
                ephemeral=True,
            )

        await interaction.response.defer()

        try:
            channel = self.values[0]
            await guild_settings.get_store().update(
                interaction.guild_id,
                self.parent_view.section,
                channel_id=channel.id,
            )
            await self.parent_view.refresh(interaction, "送信先を設定しました。")
        except Exception:
            logger.exception("履歴送信先の更新に失敗しました")
            await interaction.followup.send(
                "送信先の更新に失敗しました。Botのログを確認してください。",
                ephemeral=True,
            )


class ModerationActionToggle(discord.ui.Button):
    def __init__(self, parent: "ActivityLogSettingsView", action: str, label: str, row: int = 2):
        self.parent_view, self.action, self.action_label = parent, action, label
        super().__init__(label=self.button_label(), style=discord.ButtonStyle.secondary, row=row)

    def button_label(self) -> str:
        enabled = self.parent_view.settings.get(f"{self.action}_enabled", False)
        next_state = "オフにする" if enabled else "オンにする"
        return f"{self.action_label}履歴を{next_state}"

    async def callback(self, interaction: discord.Interaction):
        await self.parent_view.toggle_action(interaction, self.action)


class ActivityLogSettingsView(discord.ui.View):
    def __init__(
        self,
        cog: "SupportCog",
        section: str,
        title: str,
        description: str,
        settings: dict,
    ):
        super().__init__(timeout=300)
        self.cog = cog
        self.section = section
        self.title = title
        self.log_description = description
        self.settings = settings

        self.add_item(ActivityLogChannelSelect(self))

        if section == MODERATION_LOG_SECTION:
            self.add_item(ModerationActionToggle(self, "timeout", "TO"))
            self.add_item(ModerationActionToggle(self, "kick", "KICK"))
            self.add_item(ModerationActionToggle(self, "ban", "BAN"))

    @staticmethod
    def can_manage(interaction: discord.Interaction) -> bool:
        permissions = getattr(interaction.user, "guild_permissions", None)
        return bool(
            getattr(permissions, "manage_guild", False)
            or getattr(permissions, "administrator", False)
        )

    def embed(self, notice: str | None = None) -> discord.Embed:
        channel_id = self.settings.get("channel_id")
        channel_label = f"<#{channel_id}>" if channel_id else "未設定"

        description = (
            f"状態: **{'オン' if self.settings['enabled'] else 'オフ'}**\n"
            f"送信先: {channel_label}"
        )

        if notice:
            description = f"{notice}\n\n{description}"

        description += f"\n\n{self.log_description}"

        if self.section == MODERATION_LOG_SECTION:
            description += (
                "\n\n個別設定: "
                f"TO {'オン' if self.settings['timeout_enabled'] else 'オフ'} / "
                f"KICK {'オン' if self.settings['kick_enabled'] else 'オフ'} / "
                f"BAN {'オン' if self.settings['ban_enabled'] else 'オフ'}"
            )

        return discord.Embed(title=self.title, description=description, color=0x3498DB)

    async def refresh(self, interaction: discord.Interaction, notice: str | None = None):
        self.settings = get_activity_log_settings(
            guild_settings.get_store(),
            interaction.guild_id,
            self.section,
        )

        for item in self.children:
            if isinstance(item, ModerationActionToggle):
                item.label = item.button_label()

        await edit_panel_v2(interaction, as_panel_v2(self))

    async def set_enabled(self, interaction: discord.Interaction, enabled: bool):
        if not self.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定にはサーバー管理権限が必要です。",
                ephemeral=True,
            )

        if enabled and self.settings.get("channel_id") is None:
            return await interaction.response.send_message(
                "先に履歴を送るテキストチャンネルを選択してください。",
                ephemeral=True,
            )

        await interaction.response.defer()

        try:
            await guild_settings.get_store().update(
                interaction.guild_id,
                self.section,
                enabled=enabled,
            )
            await self.refresh(interaction, f"履歴を{'オン' if enabled else 'オフ'}にしました。")
        except Exception:
            logger.exception("履歴設定の更新に失敗しました (section=%s)", self.section)
            await interaction.followup.send(
                "設定の更新に失敗しました。Botのログを確認してください。",
                ephemeral=True,
            )

    async def toggle_action(self, interaction: discord.Interaction, action: str):
        if not self.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定にはサーバー管理権限が必要です。",
                ephemeral=True,
            )

        key = f"{action}_enabled"
        enabled = not self.settings.get(key, False)

        await interaction.response.defer()

        try:
            await guild_settings.get_store().update(
                interaction.guild_id,
                self.section,
                **{key: enabled},
            )
            await self.refresh(
                interaction,
                f"{action.upper()}履歴を{'オン' if enabled else 'オフ'}にしました。",
            )
        except Exception:
            logger.exception("個別モデレート履歴設定の更新に失敗しました (action=%s)", action)
            await interaction.followup.send(
                "設定の更新に失敗しました。Botのログを確認してください。",
                ephemeral=True,
            )

    @discord.ui.button(label="履歴をオンにする", style=discord.ButtonStyle.success, row=1)
    async def turn_on(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self.set_enabled(interaction, True)

    @discord.ui.button(label="履歴をオフにする", style=discord.ButtonStyle.secondary, row=1)
    async def turn_off(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self.set_enabled(interaction, False)


class VCLogChannelSelect(discord.ui.ChannelSelect):
    def __init__(self, parent: "VCLogSettingsView"):
        self.parent_view = parent
        super().__init__(
            placeholder="履歴を送るテキストチャンネルを選択",
            channel_types=[discord.ChannelType.text, discord.ChannelType.news],
            min_values=1,
            max_values=1,
        )

    async def callback(self, interaction: discord.Interaction):
        if not self.parent_view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定にはサーバー管理権限が必要です。",
                ephemeral=True,
            )

        await interaction.response.defer()

        try:
            channel = self.values[0]
            await guild_settings.get_store().update(
                interaction.guild_id,
                VC_LOG_SECTION,
                channel_id=channel.id,
            )
            await self.parent_view.refresh(interaction, "送信先を設定しました。")
        except Exception:
            logger.exception("VC履歴送信先の更新に失敗しました")
            await interaction.followup.send(
                "送信先の更新に失敗しました。Botのログを確認してください。",
                ephemeral=True,
            )


class VCLogSettingsView(discord.ui.View):
    def __init__(self, cog: "SupportCog", settings: dict):
        super().__init__(timeout=300)
        self.cog = cog
        self.settings = settings
        self.add_item(VCLogChannelSelect(self))

    @staticmethod
    def can_manage(interaction: discord.Interaction) -> bool:
        permissions = getattr(interaction.user, "guild_permissions", None)
        return bool(
            getattr(permissions, "manage_guild", False)
            or getattr(permissions, "administrator", False)
        )

    def embed(self, notice: str | None = None) -> discord.Embed:
        channel_id = self.settings.get("channel_id")
        channel_label = f"<#{channel_id}>" if channel_id else "未設定"

        description = (
            f"状態: **{'オン' if self.settings['enabled'] else 'オフ'}**\n"
            f"送信先: {channel_label}"
        )

        if notice:
            description = f"{notice}\n\n{description}"

        description += "\n\nVC入室・退出・VC間の移動を記録します。"

        return discord.Embed(
            title="VC入退室履歴の設定",
            description=description,
            color=0x3498DB,
        )

    async def refresh(self, interaction: discord.Interaction, notice: str | None = None):
        self.settings = get_vc_log_settings(guild_settings.get_store(), interaction.guild_id)
        await edit_panel_v2(interaction, as_panel_v2(self))

    async def set_enabled(self, interaction: discord.Interaction, enabled: bool):
        if not self.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定にはサーバー管理権限が必要です。",
                ephemeral=True,
            )

        if enabled and self.settings.get("channel_id") is None:
            return await interaction.response.send_message(
                "先に履歴を送るテキストチャンネルを選択してください。",
                ephemeral=True,
            )

        await interaction.response.defer()

        try:
            await guild_settings.get_store().update(
                interaction.guild_id,
                VC_LOG_SECTION,
                enabled=enabled,
            )
            await self.refresh(interaction, f"履歴を{'オン' if enabled else 'オフ'}にしました。")
        except Exception:
            logger.exception("VC履歴設定の更新に失敗しました")
            await interaction.followup.send(
                "設定の更新に失敗しました。Botのログを確認してください。",
                ephemeral=True,
            )

    @discord.ui.button(label="オン", style=discord.ButtonStyle.success, row=1)
    async def turn_on(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self.set_enabled(interaction, True)

    @discord.ui.button(label="オフ", style=discord.ButtonStyle.secondary, row=1)
    async def turn_off(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self.set_enabled(interaction, False)


class LogSupportMixin:
    """SupportCog の一部。cogs/support.py で合成される。"""

    async def show_activity_log_settings(
        self,
        interaction: discord.Interaction,
        section: str,
        title: str,
        description: str,
    ):
        if interaction.guild_id is None:
            return await interaction.response.send_message(
                "この設定はサーバー内で利用できます。",
                ephemeral=True,
            )

        store = guild_settings.get_store()
        await store.ensure_loaded()
        settings = get_activity_log_settings(store, interaction.guild_id, section)

        view = ActivityLogSettingsView(self, section, title, description, settings)
        await interaction.response.send_message(view=as_panel_v2(view), ephemeral=True)


    async def _activity_target(self, guild: discord.Guild, section: str):
        store = guild_settings.get_store()
        await store.ensure_loaded()
        settings = get_activity_log_settings(store, guild.id, section)

        if not settings["enabled"] or settings["channel_id"] is None:
            return None

        target = self.bot.get_channel(settings["channel_id"])
        if target is None:
            try:
                target = await self.bot.fetch_channel(settings["channel_id"])
            except (discord.NotFound, discord.Forbidden, discord.HTTPException):
                logger.warning(
                    "履歴の送信先を取得できません (guild=%s section=%s)",
                    guild.id,
                    section,
                )
                return None

        if getattr(getattr(target, "guild", None), "id", guild.id) != guild.id:
            logger.warning(
                "履歴の送信先が別サーバーです (guild=%s section=%s)",
                guild.id,
                section,
            )
            return None

        return target


    async def _moderation_action_enabled(self, guild: discord.Guild, action: str) -> bool:
        store = guild_settings.get_store()
        await store.ensure_loaded()
        settings = get_activity_log_settings(store, guild.id, MODERATION_LOG_SECTION)
        return bool(settings["enabled"] and settings.get(f"{action}_enabled", False))


    async def _send_activity(self, guild: discord.Guild, section: str, embed: discord.Embed):
        target = await self._activity_target(guild, section)
        if target is None:
            return

        try:
            await target.send(embed=embed)
        except (discord.Forbidden, discord.HTTPException):
            logger.exception("履歴を送信できません (guild=%s section=%s)", guild.id, section)


    @staticmethod
    def _clip(value, limit=1024):
        text = str(value or "(内容なし)")
        return text if len(text) <= limit else text[:limit - 1] + "…"


    @staticmethod
    def message_edit_embed(before: discord.Message, after: discord.Message) -> discord.Embed:
        embed = discord.Embed(
            title="メッセージ編集",
            color=0xF1C40F,
            timestamp=discord.utils.utcnow(),
        )
        embed.set_author(
            name=before.author.display_name,
            icon_url=before.author.display_avatar.url,
        )
        embed.add_field(
            name="ユーザー",
            value=f"{before.author.mention} (`{before.author.id}`)",
            inline=False,
        )
        embed.add_field(
            name="チャンネル",
            value=f"{before.channel.mention} (`{before.channel.id}`)",
            inline=False,
        )
        embed.add_field(name="編集前", value=self_clip(before.content), inline=False)
        embed.add_field(name="編集後", value=self_clip(after.content), inline=False)
        embed.add_field(
            name="メッセージ",
            value=f"[元のメッセージへ]({after.jump_url})",
            inline=False,
        )
        return embed


    async def _recent_audit_entry(self, guild: discord.Guild, action, target_id: int):
        try:
            async for entry in guild.audit_logs(limit=10, action=action):
                if getattr(getattr(entry, "target", None), "id", None) == target_id:
                    age = (discord.utils.utcnow() - entry.created_at).total_seconds()
                    if -5 <= age <= 60:
                        return entry
        except (discord.Forbidden, discord.HTTPException):
            logger.info("監査ログを取得できません (guild=%s action=%s)", guild.id, action)

        return None


    @staticmethod
    def moderation_embed(title: str, target, entry, detail: str) -> discord.Embed:
        executor = getattr(entry, "user", None) if entry else None
        reason = getattr(entry, "reason", None) if entry else None

        embed = discord.Embed(title=title, color=0xE74C3C, timestamp=discord.utils.utcnow())
        embed.add_field(name="対処したユーザー", value=mention_with_id(executor), inline=True)
        embed.add_field(name="適用されたユーザー", value=mention_with_id(target), inline=True)
        embed.add_field(name="対処詳細", value=LogSupportMixin._clip(detail), inline=False)
        embed.add_field(name="理由", value=LogSupportMixin._clip(reason or "理由なし"), inline=False)

        if executor is not None:
            avatar = getattr(getattr(executor, "display_avatar", None), "url", None)
            embed.set_author(
                name=getattr(executor, "display_name", str(executor)),
                icon_url=avatar,
            )

        return embed


    @commands.Cog.listener()
    async def on_message_edit(self, before: discord.Message, after: discord.Message):
        if before.guild is None or before.author.bot or before.content == after.content:
            return

        await self._send_activity(
            before.guild,
            MESSAGE_LOG_SECTION,
            self.message_edit_embed(before, after),
        )


    @commands.Cog.listener()
    async def on_member_update(self, before: discord.Member, after: discord.Member):
        old_until = getattr(before, "timed_out_until", None)
        if old_until is None:
            old_until = getattr(before, "communication_disabled_until", None)

        new_until = getattr(after, "timed_out_until", None)
        if new_until is None:
            new_until = getattr(after, "communication_disabled_until", None)

        if before.guild is None or old_until == new_until:
            return

        if not await self._moderation_action_enabled(before.guild, "timeout"):
            return

        entry = await self._recent_audit_entry(
            before.guild,
            discord.AuditLogAction.member_update,
            after.id,
        )

        if new_until is not None:
            detail = f"タイムアウト期限: {new_until.isoformat()}"
            title = "タイムアウト（TO）"
        else:
            detail = "タイムアウト解除"
            title = "タイムアウト解除（TO）"

        await self._send_activity(
            before.guild,
            MODERATION_LOG_SECTION,
            self.moderation_embed(title, after, entry, detail),
        )


    @commands.Cog.listener()
    async def on_member_remove(self, member: discord.Member):
        if member.guild is None or member.bot:
            return

        if not await self._moderation_action_enabled(member.guild, "kick"):
            return

        ban_entry = await self._recent_audit_entry(
            member.guild,
            discord.AuditLogAction.ban,
            member.id,
        )
        if ban_entry is not None:
            return

        entry = await self._recent_audit_entry(
            member.guild,
            discord.AuditLogAction.kick,
            member.id,
        )
        if entry is not None:
            await self._send_activity(
                member.guild,
                MODERATION_LOG_SECTION,
                self.moderation_embed("KICK", member, entry, "サーバーからキック"),
            )


    @commands.Cog.listener()
    async def on_member_ban(self, guild: discord.Guild, user: discord.User):
        if not await self._moderation_action_enabled(guild, "ban"):
            return

        entry = await self._recent_audit_entry(guild, discord.AuditLogAction.ban, user.id)
        await self._send_activity(
            guild,
            MODERATION_LOG_SECTION,
            self.moderation_embed("BAN", user, entry, "サーバーからBAN"),
        )


    async def show_vc_log_settings(self, interaction: discord.Interaction):
        if interaction.guild_id is None:
            return await interaction.response.send_message(
                "この設定はサーバー内で利用できます。",
                ephemeral=True,
            )

        store = guild_settings.get_store()
        await store.ensure_loaded()
        settings = get_vc_log_settings(store, interaction.guild_id)

        view = VCLogSettingsView(self, settings)
        await interaction.response.send_message(view=as_panel_v2(view), ephemeral=True)


    @commands.Cog.listener()
    async def on_voice_state_update(
        self,
        member: discord.Member,
        before: discord.VoiceState,
        after: discord.VoiceState,
    ):
        if member.bot or member.guild is None:
            return

        old_channel = getattr(before, "channel", None)
        new_channel = getattr(after, "channel", None)

        old_id = getattr(old_channel, "id", None)
        new_id = getattr(new_channel, "id", None)

        if old_id == new_id:
            return

        store = guild_settings.get_store()
        await store.ensure_loaded()
        settings = get_vc_log_settings(store, member.guild.id)

        channel_id = settings["channel_id"]
        if not settings["enabled"] or channel_id is None:
            return

        target = self.bot.get_channel(channel_id)
        if target is None:
            try:
                target = await self.bot.fetch_channel(channel_id)
            except (discord.NotFound, discord.Forbidden, discord.HTTPException):
                logger.warning(
                    "VC入退室ログの送信先を取得できません (guild=%s channel=%s)",
                    member.guild.id,
                    channel_id,
                )
                return

        if getattr(getattr(target, "guild", None), "id", member.guild.id) != member.guild.id:
            logger.warning(
                "VC入退室ログの送信先が別サーバーです (guild=%s channel=%s)",
                member.guild.id,
                channel_id,
            )
            return

        try:
            if old_channel is not None:
                await target.send(embed=vc_log_embed(member, old_channel, joined=False))
            if new_channel is not None:
                await target.send(embed=vc_log_embed(member, new_channel, joined=True))
        except (discord.Forbidden, discord.HTTPException):
            logger.exception(
                "VC入退室ログを送信できません (guild=%s channel=%s)",
                member.guild.id,
                channel_id,
            )
