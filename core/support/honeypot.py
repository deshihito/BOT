# -*- coding: utf-8 -*-
"""ハニーポットの UI と設定取得。元 cogs/support.py から分割。"""
from __future__ import annotations

from .common import *


def get_honeypot_settings(store, guild_id: int) -> dict[str, int | bool | None]:
    """Return the configured honeypot channel and its warning-panel message."""
    raw = store.get(guild_id, HONEYPOT_SECTION)
    if not isinstance(raw, dict):
        raw = {}

    channel_id = raw.get("channel_id")
    if not isinstance(channel_id, int) or isinstance(channel_id, bool):
        channel_id = None

    message_id = raw.get("message_id")
    if not isinstance(message_id, int) or isinstance(message_id, bool):
        message_id = None

    enabled = raw.get("enabled") if isinstance(raw.get("enabled"), bool) else bool(channel_id)

    return {"enabled": enabled, "channel_id": channel_id, "message_id": message_id}


class HoneypotPanelView(discord.ui.LayoutView):
    """The intentionally visible warning shown in the honeypot channel."""

    def __init__(self):
        super().__init__(timeout=None)
        self.add_item(
            discord.ui.Container(
                discord.ui.TextDisplay(
                    """## ⚠️ 警告
このチャンネルはハニーポットです。
ここにメッセージを送信すると、自動的にサーバーからキックされ、メッセージも削除されます。"""
                ),
                accent_colour=0xFFFFFF,
            )
        )


class HoneypotChannelSelect(discord.ui.ChannelSelect):
    def __init__(self, parent: "HoneypotSettingsView"):
        self.parent_view = parent
        super().__init__(
            placeholder="ハニーポットにするテキストチャンネルを選択",
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
            old = self.parent_view.settings

            if old.get("channel_id") and old.get("message_id") and old["channel_id"] != channel.id:
                old_channel = self.parent_view.cog.bot.get_channel(old["channel_id"])
                if old_channel is not None:
                    try:
                        await (await old_channel.fetch_message(old["message_id"])).delete()
                    except discord.NotFound:
                        logger.debug("旧ハニーポットメッセージが見つかりませんでした", exc_info=True)
                    except (discord.Forbidden, discord.HTTPException):
                        logger.warning(
                            "旧ハニーポット警告パネルを削除できません (guild=%s)",
                            interaction.guild_id,
                        )

            await guild_settings.get_store().update(
                interaction.guild_id,
                HONEYPOT_SECTION,
                channel_id=channel.id,
                message_id=None,
                enabled=True,
            )

            self.parent_view.settings.update(
                {"channel_id": channel.id, "message_id": None, "enabled": True}
            )

            await self.parent_view.cog.send_honeypot_panel(interaction.guild, force=True)
            await self.parent_view.refresh(
                interaction,
                "ハニーポットを有効にし、警告パネルを設置しました。",
            )
        except Exception:
            logger.exception("ハニーポットの設置に失敗しました")
            await interaction.followup.send(
                "ハニーポットの設置に失敗しました。時間をおいて再度お試しください。解決しない場合はBotの運営に連絡してください。",
                ephemeral=True,
            )


class HoneypotSettingsView(discord.ui.View):
    def __init__(self, cog: "SupportCog", settings: dict):
        super().__init__(timeout=300)
        self.cog = cog
        self.settings = settings
        self.add_item(HoneypotChannelSelect(self))

    @staticmethod
    def can_manage(interaction: discord.Interaction) -> bool:
        permissions = getattr(interaction.user, "guild_permissions", None)
        return bool(
            getattr(permissions, "manage_guild", False)
            or getattr(permissions, "administrator", False)
        )

    def embed(self, notice: str | None = None) -> discord.Embed:
        if notice is None:
            notice = getattr(self, "notice", None)

        channel_id = self.settings.get("channel_id")

        description = (
            f"状態: **{'オン' if self.settings.get('enabled') else 'オフ'}**\n"
            f"設置先: {f'<#{channel_id}>' if channel_id else '未設定'}\n\n"
            "選択したチャンネルに警告パネルを設置します。ユーザーが投稿すると、"
            "その投稿を削除して対象ユーザーをソフトバン（7日分のメッセージ削除後に解除）します。"
        )

        if notice:
            description = f"{notice}\n\n{description}"

        return discord.Embed(title="ハニーポットの設定", description=description, color=0xFFFFFF)

    async def refresh(self, interaction: discord.Interaction, notice: str | None = None):
        store = guild_settings.get_store()
        await store.ensure_loaded()
        self.settings = get_honeypot_settings(store, interaction.guild_id)
        self.notice = notice
        await edit_panel_v2(interaction, as_panel_v2(self))


class HoneypotSupportMixin:
    """SupportCog の一部。cogs/support.py で合成される。"""

    async def show_honeypot_settings(self, interaction: discord.Interaction):
        if interaction.guild_id is None:
            return await interaction.response.send_message(
                "この設定はサーバー内で利用できます。",
                ephemeral=True,
            )

        store = guild_settings.get_store()
        await store.ensure_loaded()
        settings = get_honeypot_settings(store, interaction.guild_id)

        await interaction.response.send_message(
            view=as_panel_v2(HoneypotSettingsView(self, settings)),
            ephemeral=True,
        )


    async def _honeypot_channel(self, guild: discord.Guild, channel_id: int):
        target = self.bot.get_channel(channel_id)
        if target is None:
            try:
                target = await self.bot.fetch_channel(channel_id)
            except (discord.NotFound, discord.Forbidden, discord.HTTPException):
                logger.warning(
                    "ハニーポットチャンネルを取得できません (guild=%s channel=%s)",
                    guild.id,
                    channel_id,
                )
                return None

        if getattr(getattr(target, "guild", None), "id", guild.id) != guild.id:
            logger.warning(
                "ハニーポットチャンネルが別サーバーです (guild=%s channel=%s)",
                guild.id,
                channel_id,
            )
            return None

        return target


    async def send_honeypot_panel(self, guild: discord.Guild, *, force: bool = False):
        store = guild_settings.get_store()
        await store.ensure_loaded()
        settings = get_honeypot_settings(store, guild.id)

        if not settings["enabled"] or settings["channel_id"] is None:
            return None

        target = await self._honeypot_channel(guild, settings["channel_id"])
        if target is None:
            return None

        old_id = settings.get("message_id")
        if old_id:
            try:
                await (await target.fetch_message(old_id)).delete()
            except discord.NotFound:
                logger.debug("旧ハニーポットメッセージが見つかりませんでした", exc_info=True)
            except (discord.Forbidden, discord.HTTPException):
                logger.warning(
                    "ハニーポット警告パネルを削除できません (guild=%s message=%s)",
                    guild.id,
                    old_id,
                )

        try:
            panel = await target.send(view=HoneypotPanelView())
        except (discord.Forbidden, discord.HTTPException):
            logger.exception(
                "ハニーポット警告パネルを送信できません (guild=%s channel=%s)",
                guild.id,
                target.id,
            )
            return None

        await store.update(guild.id, HONEYPOT_SECTION, message_id=panel.id)
        return panel


    async def _handle_honeypot_message(self, message: discord.Message) -> bool:
        store = guild_settings.get_store()
        await store.ensure_loaded()
        settings = get_honeypot_settings(store, message.guild.id)

        if not settings["enabled"] or settings["channel_id"] != message.channel.id:
            return False

        author = message.author
        if getattr(author, "bot", False):
            return False

        permissions = getattr(author, "guild_permissions", None)
        if any(
            getattr(permissions, name, False)
            for name in ("administrator", "manage_guild", "ban_members")
        ):
            return False

        try:
            await message.delete()
        except (discord.NotFound, discord.Forbidden, discord.HTTPException):
            logger.warning(
                "ハニーポット投稿を削除できません (guild=%s message=%s)",
                message.guild.id,
                message.id,
            )

        try:
            await message.guild.ban(
                author,
                delete_message_days=7,
                reason="ハニーポットチャンネルへの投稿",
            )
            await message.guild.unban(author, reason="ハニーポットによる一時BAN解除")
        except (discord.Forbidden, discord.HTTPException):
            logger.exception(
                "ハニーポット対象者のソフトバンに失敗しました (guild=%s user=%s)",
                message.guild.id,
                author.id,
            )

        return True
