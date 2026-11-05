# -*- coding: utf-8 -*-
"""レベルアップ通知パネルの UI。元 cogs/support.py から分割。"""
from __future__ import annotations

from .common import *


class LevelUpChannelSelect(discord.ui.ChannelSelect):
    def __init__(self, parent: "LevelUpNotifyPanel"):
        self.parent_view = parent
        channel = parent.channel()
        super().__init__(
            placeholder="レベルアップ通知を送るテキストチャンネルを選択",
            channel_types=[discord.ChannelType.text, discord.ChannelType.news],
            min_values=1,
            max_values=1,
            default_values=(
                [discord.SelectDefaultValue(id=channel.id, type=discord.SelectDefaultValueType.channel)]
                if channel is not None
                else []
            ),
        )

    async def callback(self, interaction: discord.Interaction):
        await self.parent_view.save(interaction, "送信先を設定しました。", channel_id=self.values[0].id)


class LevelUpToggleButton(discord.ui.Button):
    def __init__(self, parent: "LevelUpNotifyPanel"):
        self.parent_view = parent
        enabled = parent.settings["enabled"]
        super().__init__(
            label="通知をオフにする" if enabled else "通知をオンにする",
            style=discord.ButtonStyle.secondary if enabled else discord.ButtonStyle.success,
        )

    async def callback(self, interaction: discord.Interaction):
        enabled = not self.parent_view.settings["enabled"]
        await self.parent_view.save(
            interaction,
            f"通知を{'オン' if enabled else 'オフ'}にしました。",
            enabled=enabled,
        )


class LevelUpResetChannelButton(discord.ui.Button):
    def __init__(self, parent: "LevelUpNotifyPanel"):
        self.parent_view = parent
        super().__init__(
            label="送信先の指定を解除",
            style=discord.ButtonStyle.secondary,
            disabled=not parent.settings.get("channel_id"),
        )

    async def callback(self, interaction: discord.Interaction):
        await self.parent_view.save(
            interaction,
            "送信先の指定を解除しました。発言したチャンネルへ通知します。",
            channel_id=None,
        )


class LevelUpPreviewButton(discord.ui.Button):
    def __init__(self, parent: "LevelUpNotifyPanel"):
        self.parent_view = parent
        super().__init__(label="画像プレビュー", style=discord.ButtonStyle.primary)

    async def callback(self, interaction: discord.Interaction):
        await interaction.response.defer(ephemeral=True)
        cog = interaction.client.get_cog("GeneralCog")
        if cog is None or not hasattr(cog, "render_levelup_image"):
            return await interaction.followup.send("general が読み込まれていないためプレビューできません。", ephemeral=True)
        png = await cog.render_levelup_image(interaction.user, 4, 5)
        if png is None:
            return await interaction.followup.send(
                "画像を生成できませんでした。Pillow が入っているか確認してください（`pip install pillow`）。"
                "未導入の間は、レベルアップ通知は画像なしのテキストで送られます。",
                ephemeral=True,
            )
        import io

        await interaction.followup.send(
            "プレビューです（Lv.4 → Lv.5 の例）。実際は、レベルが上がったユーザー本人のアイコンと前後のレベルが入ります。",
            file=discord.File(io.BytesIO(png), filename="levelup_preview.png"),
            ephemeral=True,
        )


class LevelUpCardThemeButton(discord.ui.Button):
    """押したユーザー本人のレベルアップカードのテーマを切り替える (ユーザー別設定)。"""

    def __init__(self, parent: "LevelUpNotifyPanel"):
        self.parent_view = parent
        super().__init__(label="自分のカードテーマ", style=discord.ButtonStyle.secondary)

    async def callback(self, interaction: discord.Interaction):
        from core import levelup_card

        current = levelup_card.get_theme(interaction.user.id)
        nxt = levelup_card.next_theme(current)
        await levelup_card.set_theme(interaction.user.id, nxt)
        await interaction.response.send_message(
            f"自分のレベルアップカードのテーマを「{levelup_card.theme_label(nxt)}」にしました。"
            "「画像プレビュー」で確認できます。",
            ephemeral=True,
        )


class LevelUpNotifyPanel(discord.ui.LayoutView):
    """レベルアップ通知の設定パネル（Components V2・サーバー管理権限）。"""

    def __init__(self, cog: "SupportCog", settings: dict, guild: discord.Guild, notice: str | None = None):
        super().__init__(timeout=300)
        self.cog = cog
        self.settings = settings
        self.guild = guild
        self.notice = notice
        self._build()

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        permissions = getattr(interaction.user, "guild_permissions", None)
        if getattr(permissions, "administrator", False) or getattr(permissions, "manage_guild", False):
            return True
        await interaction.response.send_message(
            "この設定にはサーバー管理権限が必要です。",
            ephemeral=True,
        )
        return False

    async def on_error(self, interaction: discord.Interaction, error: Exception, item: discord.ui.Item):
        logger.error("レベルアップ通知パネルでエラー", exc_info=error)
        await report_callback_error(interaction, "レベルアップ通知パネルでエラー")

    def channel(self):
        """指定済みで実在するチャンネル。無ければ None。"""
        channel_id = self.settings.get("channel_id")
        return self.guild.get_channel_or_thread(channel_id) if channel_id else None

    def _status_text(self) -> str:
        s = self.settings
        channel = self.channel()
        if channel is not None:
            target = channel.mention
        elif s.get("channel_id"):
            target = "⚠️ 指定のチャンネルが見つかりません（発言したチャンネルへ通知します）"
        else:
            target = "未指定（レベルが上がった時に発言していたチャンネル／VCの場合はそのVCのチャット）"
        text = (
            f"状態: **{'オン' if s['enabled'] else 'オフ'}**\n"
            f"送信先: {target}\n"
            "対象: generalレベル（チャットとVCのレベルから算出）\n"
            "内容: ユーザーのアイコン・前のレベル・上がった後のレベルの画像\n"
            "カードの色テーマは「自分のカードテーマ」でユーザーごとに変更できます"
        )
        me = self.guild.me
        if channel is not None and me is not None:
            perms = channel.permissions_for(me)
            if not (perms.view_channel and perms.send_messages):
                text += "\n-# ⚠️ Botがこのチャンネルに投稿できません。権限を確認してください。"
            elif not perms.attach_files:
                text += "\n-# ⚠️ Botに「ファイルを添付」権限がないため、画像なしのテキストで通知されます。"
        return text

    def _build(self):
        self.clear_items()
        head = "## 🎉 レベルアップ通知\nEXPのgeneralレベルが上がった時に、画像つきで通知します。"
        if self.notice:
            head = f"{self.notice}\n\n{head}"

        self.add_item(
            discord.ui.Container(
                discord.ui.TextDisplay(head),
                discord.ui.TextDisplay(self._status_text()),
                discord.ui.Separator(),
                discord.ui.ActionRow(LevelUpChannelSelect(self)),
                discord.ui.ActionRow(
                    LevelUpToggleButton(self),
                    LevelUpResetChannelButton(self),
                    LevelUpPreviewButton(self),
                    LevelUpCardThemeButton(self),
                ),
                accent_colour=0xF1C40F,
            )
        )

    async def refresh(self, interaction: discord.Interaction, notice: str | None = None):
        from cogs.general import get_levelup_settings

        store = guild_settings.get_store()
        await store.ensure_loaded()
        self.settings = get_levelup_settings(store, interaction.guild_id)
        self.notice = notice
        self._build()
        await edit_interaction_message(interaction, view=self)

    async def save(self, interaction: discord.Interaction, notice: str, **values):
        from cogs.general import LEVELUP_SECTION

        await interaction.response.defer()
        try:
            await guild_settings.get_store().update(interaction.guild_id, LEVELUP_SECTION, **values)
        except Exception:
            logger.exception("レベルアップ通知設定の更新に失敗しました")
            return await interaction.followup.send(
                "設定の更新に失敗しました。Botのログを確認してください。",
                ephemeral=True,
            )
        await self.refresh(interaction, notice)


class LevelUpSupportMixin:
    """SupportCog の一部。cogs/support.py で合成される。"""

    async def show_levelup_notify_settings(self, interaction: discord.Interaction):
        if interaction.guild is None:
            return await interaction.response.send_message(
                "この機能はサーバー内で利用できます。",
                ephemeral=True,
            )

        from cogs.general import get_levelup_settings

        store = guild_settings.get_store()
        await store.ensure_loaded()
        settings = get_levelup_settings(store, interaction.guild.id)
        await interaction.response.send_message(
            view=LevelUpNotifyPanel(self, settings, interaction.guild),
            ephemeral=True,
        )
