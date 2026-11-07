# -*- coding: utf-8 -*-
"""Sticky パネルの UI。元 cogs/support.py から分割。"""
from __future__ import annotations

from .common import *
from core.support.messages import SETTINGS_UPDATE_FAILED


class StickyChannelSelect(discord.ui.ChannelSelect):
    def __init__(self, parent: "StickySettingsView"):
        self.parent_view = parent
        super().__init__(
            placeholder="Stickyパネルを置くテキストチャンネルを選択",
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

            old_channel_id = self.parent_view.settings.get("channel_id")
            old_message_id = self.parent_view.settings.get("message_id")

            if old_channel_id and old_message_id and old_channel_id != channel.id:
                old_channel = await self.parent_view.cog._sticky_channel(
                    interaction.guild,
                    old_channel_id,
                )
                if old_channel is not None:
                    try:
                        await (await old_channel.fetch_message(old_message_id)).delete()
                    except discord.NotFound:
                        logger.debug("旧Stickyメッセージが見つかりませんでした", exc_info=True)
                    except (discord.Forbidden, discord.HTTPException):
                        logger.warning(
                            "旧Stickyパネルを削除できません (guild=%s message=%s)",
                            interaction.guild_id,
                            old_message_id,
                        )

            await guild_settings.get_store().update(
                interaction.guild_id,
                STICKY_SECTION,
                channel_id=channel.id,
                message_id=None,
            )

            self.parent_view.settings["channel_id"] = channel.id
            self.parent_view.settings["message_id"] = None

            await self.parent_view.refresh(interaction, "Stickyパネルの設置先を設定しました。")

            if self.parent_view.settings.get("enabled") and self.parent_view.settings.get("content"):
                await self.parent_view.cog.send_sticky_panel(interaction.guild, force=True)
        except Exception:
            logger.exception("Stickyパネル設置先の更新に失敗しました")
            await interaction.followup.send(
                "Stickyパネル設置先の更新に失敗しました。時間をおいて再度お試しください。解決しない場合はBotの運営に連絡してください。",
                ephemeral=True,
            )


class StickyTextModal(discord.ui.Modal, title="Stickyパネルの文言"):
    def __init__(self, view: "StickySettingsView"):
        super().__init__()
        self.parent_view = view

        self.text = discord.ui.TextInput(
            label="パネルに表示する文言",
            style=discord.TextStyle.paragraph,
            placeholder="例: お問い合わせはこのチャンネルに送信してください。",
            default=view.settings.get("content", "")[:2000],
            max_length=2000,
            required=True,
        )
        self.add_item(self.text)

    async def on_submit(self, interaction: discord.Interaction):
        if not self.parent_view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定にはサーバー管理権限が必要です。",
                ephemeral=True,
            )

        if self.parent_view.settings.get("channel_id") is None:
            return await interaction.response.send_message(
                "先にStickyパネルを置くチャンネルを選択してください。",
                ephemeral=True,
            )

        await interaction.response.defer(ephemeral=True, thinking=True)

        try:
            await guild_settings.get_store().update(
                interaction.guild_id,
                STICKY_SECTION,
                content=self.text.value,
                enabled=True,
            )

            self.parent_view.settings["content"] = self.text.value
            self.parent_view.settings["enabled"] = True

            await interaction.edit_original_response(
                content="文言を保存しました。Stickyパネルを送信しています。"
            )
            await self.parent_view.cog.send_sticky_panel(interaction.guild, force=True)
        except Exception:
            logger.exception("Stickyパネル文言の保存・送信に失敗しました")
            try:
                await interaction.edit_original_response(
                    content="文言の保存またはパネル送信に失敗しました。時間をおいて再度お試しください。解決しない場合はBotの運営に連絡してください。"
                )
            except discord.HTTPException:
                logger.exception("Sticky文言保存エラーの通知に失敗しました")


class StickySettingsView(discord.ui.View):
    def __init__(self, cog: "SupportCog", settings: dict):
        super().__init__(timeout=300)
        self.cog = cog
        self.settings = settings
        self.add_item(StickyChannelSelect(self))

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

        content = self.settings.get("content") or "未設定"
        if len(content) > 200:
            content = content[:199] + "…"

        description = (
            f"状態: **{'オン' if self.settings.get('enabled') else 'オフ'}**\n"
            f"設置先: {channel_label}\n"
            f"文言: {content}\n\n"
            "設置先のチャンネルに誰かが投稿すると、直前のStickyパネルを削除して再送信します。"
        )

        if notice:
            description = f"{notice}\n\n{description}"

        return discord.Embed(title="Stickyパネルの設定", description=description, color=0x3498DB)

    async def refresh(self, interaction: discord.Interaction, notice: str | None = None):
        self.settings = get_sticky_settings(guild_settings.get_store(), interaction.guild_id)
        await edit_panel_v2(interaction, as_panel_v2(self))

    async def set_enabled(self, interaction: discord.Interaction, enabled: bool):
        if not self.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定にはサーバー管理権限が必要です。",
                ephemeral=True,
            )

        if enabled and (self.settings.get("channel_id") is None or not self.settings.get("content")):
            return await interaction.response.send_message(
                "先に設置先と文言を設定してください。",
                ephemeral=True,
            )

        await interaction.response.defer()

        try:
            await guild_settings.get_store().update(
                interaction.guild_id,
                STICKY_SECTION,
                enabled=enabled,
            )
            self.settings["enabled"] = enabled

            notice = "Stickyパネルをオンにしました。" if enabled else "Stickyパネルをオフにしました。"
            await edit_panel_v2(interaction, as_panel_v2(self))

            if enabled:
                await self.cog.send_sticky_panel(interaction.guild, force=True)
        except Exception:
            logger.exception("Stickyパネル有効状態の更新に失敗しました")
            await interaction.followup.send(
                f"Sticky{SETTINGS_UPDATE_FAILED}",
                ephemeral=True,
            )

    @discord.ui.button(label="文言を設定・更新", style=discord.ButtonStyle.primary, row=1)
    async def edit_text(self, interaction: discord.Interaction, button: discord.ui.Button):
        if not self.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定にはサーバー管理権限が必要です。",
                ephemeral=True,
            )

        await interaction.response.send_modal(StickyTextModal(self))

    @discord.ui.button(label="オン", style=discord.ButtonStyle.success, row=1)
    async def turn_on(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self.set_enabled(interaction, True)

    @discord.ui.button(label="オフ", style=discord.ButtonStyle.secondary, row=1)
    async def turn_off(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self.set_enabled(interaction, False)


class StickySupportMixin:
    """SupportCog の一部。cogs/support.py で合成される。"""

    async def show_sticky_settings(self, interaction: discord.Interaction):
        if interaction.guild_id is None:
            return await interaction.response.send_message(
                "この設定はサーバー内で利用できます。",
                ephemeral=True,
            )

        store = guild_settings.get_store()
        await store.ensure_loaded()
        settings = get_sticky_settings(store, interaction.guild_id)

        view = StickySettingsView(self, settings)
        await interaction.response.send_message(view=as_panel_v2(view), ephemeral=True)


    async def _sticky_channel(self, guild: discord.Guild, channel_id: int):
        target = self.bot.get_channel(channel_id)
        if target is None:
            try:
                target = await self.bot.fetch_channel(channel_id)
            except (discord.NotFound, discord.Forbidden, discord.HTTPException):
                logger.warning(
                    "Stickyパネルの送信先を取得できません (guild=%s channel=%s)",
                    guild.id,
                    channel_id,
                )
                return None

        if getattr(getattr(target, "guild", None), "id", guild.id) != guild.id:
            logger.warning(
                "Stickyパネルの送信先が別サーバーです (guild=%s channel=%s)",
                guild.id,
                channel_id,
            )
            return None

        return target


    async def send_sticky_panel(self, guild: discord.Guild, *, force: bool = False):
        """現在のStickyパネルを削除して、設定された文言を同じチャンネルへ送る。"""
        store = guild_settings.get_store()
        await store.ensure_loaded()
        settings = get_sticky_settings(store, guild.id)

        if not settings["enabled"] or settings["channel_id"] is None or not settings["content"]:
            return None

        lock = self._sticky_locks.setdefault(guild.id, asyncio.Lock())
        async with lock:
            settings = get_sticky_settings(store, guild.id)
            if not settings["enabled"] or settings["channel_id"] is None or not settings["content"]:
                return None

            target = await self._sticky_channel(guild, settings["channel_id"])
            if target is None:
                return None

            old_id = settings.get("message_id")
            if old_id:
                try:
                    old_message = await target.fetch_message(old_id)
                    await old_message.delete()
                except discord.NotFound:
                    logger.debug("旧Stickyメッセージが見つかりませんでした", exc_info=True)
                except (discord.Forbidden, discord.HTTPException):
                    logger.warning(
                        "Stickyパネルを削除できません (guild=%s message=%s)",
                        guild.id,
                        old_id,
                    )

            try:
                panel = await target.send(settings["content"])
            except (discord.Forbidden, discord.HTTPException):
                logger.exception(
                    "Stickyパネルを送信できません (guild=%s channel=%s)",
                    guild.id,
                    target.id,
                )
                return None

            await store.update(guild.id, STICKY_SECTION, message_id=panel.id)
            return panel
