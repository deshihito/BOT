"""Shared UI helpers for server-assist feature views."""
from __future__ import annotations

from typing import Any

import discord

from core.support.panel_v2 import as_panel_v2


class BackToSupportButton(discord.ui.Button):
    """設定画面から /support パネル（その機能のジャンル）へ戻るボタン。"""

    def __init__(self, row: int = 4):
        super().__init__(label="サポートへ戻る", style=discord.ButtonStyle.secondary, row=row)

    async def callback(self, interaction: discord.Interaction):
        cog = getattr(self.view, "cog", None)
        if cog is None:
            return await interaction.response.send_message("設定画面を開き直してください。", ephemeral=True)
        await cog.show_panel_edit(interaction, getattr(self.view, "feature_key", "") or None)


class AssistFeatureView(discord.ui.View):
    """Base class for a server-assist feature settings screen under /support."""

    feature_key = ""

    def __init__(self, cog: Any, guild_id: int):
        super().__init__(timeout=300)
        self.cog = cog
        self.guild_id = guild_id
        self.notice: str | None = None
        self.add_item(BackToSupportButton())

    def can_manage(self, interaction: discord.Interaction) -> bool:
        from core.support.server_assist import has_manage_permission

        return has_manage_permission(interaction)

    def embed(self) -> discord.Embed:
        raise NotImplementedError

    async def refresh(self, interaction: discord.Interaction, notice: str | None = None):
        self.notice = notice
        view = as_panel_v2(self)
        if interaction.response.is_done():
            return await interaction.edit_original_response(
                content=None, embed=None, attachments=[], view=view,
            )
        return await interaction.response.edit_message(
            content=None, embed=None, attachments=[], view=view,
        )


def channel_label(channel_id: Any) -> str:
    return f"<#{channel_id}>" if isinstance(channel_id, int) and channel_id else "未設定"


def notice_line(notice: str | None) -> str:
    return f"\n\n**{notice}**" if notice else ""


def channel_permission_check(permission: str, message: str):
    """セレクトの values（部分チャンネル）に対する権限確認 check を作る。"""

    def check(view: Any, channel: Any) -> str | None:
        me = getattr(getattr(view, "guild", None), "me", None)
        if me is not None and not getattr(channel.permissions_for(me), permission, False):
            return message
        return None

    return check


class AssistChannelSelect(discord.ui.ChannelSelect):
    """(field, placeholder, notice) でパラメータ化した汎用チャンネルセレクト。

    check: None=確認なし / "send"=実チャンネルに解決して送信権限を確認
    （文面は check_error）/ callable(view, selected) -> str | None。
    min_values=0 のとき現在値を default_values に表示し、未選択は
    empty_message があればその文面で中断、無ければ未設定（None）として保存する。
    extra は一緒に保存する追加フィールド。reopen な機能は refresh でなく
    view.reopen で再表示する（settings の手元同期もしない）。
    """

    def __init__(
        self,
        parent: Any,
        *,
        field: str,
        placeholder: str,
        notice: Any,
        channel_types: list[discord.ChannelType] | None = None,
        min_values: int = 1,
        row: int = 0,
        check: Any = None,
        check_error: str = "そのチャンネルには送信できません。",
        empty_message: str | None = None,
        extra: dict[str, Any] | None = None,
        reopen: bool = False,
    ):
        self.parent_view = parent
        self.field = field
        self.notice = notice
        self.check = check
        self.check_error = check_error
        self.empty_message = empty_message
        self.extra = extra
        self.reopen = reopen
        kwargs: dict[str, Any] = {}
        if min_values == 0:
            current = parent.settings.get(field)
            kwargs["min_values"] = 0
            kwargs["max_values"] = 1
            kwargs["default_values"] = (
                [discord.SelectDefaultValue(id=current, type=discord.SelectDefaultValueType.channel)]
                if current is not None else []
            )
        super().__init__(
            placeholder=placeholder,
            channel_types=channel_types or [discord.ChannelType.text, discord.ChannelType.news],
            row=row,
            **kwargs,
        )

    async def callback(self, interaction: discord.Interaction):
        from core.support.messages import ASSIST_MANAGE_REQUIRED
        from core.support.server_assist import update_settings

        view = self.parent_view
        if not view.can_manage(interaction):
            return await interaction.response.send_message(ASSIST_MANAGE_REQUIRED, ephemeral=True)
        selected = self.values[0] if self.values else None
        if selected is None:
            if self.empty_message is not None:
                return await interaction.response.send_message(self.empty_message, ephemeral=True)
            channel_id = None
        else:
            channel_id = selected.id
            if self.check == "send":
                guild = getattr(view, "guild", None)
                channel = guild.get_channel(channel_id) if guild is not None else None
                me = getattr(guild, "me", None)
                if channel is not None and me is not None:
                    try:
                        if not channel.permissions_for(me).send_messages:
                            return await interaction.response.send_message(self.check_error, ephemeral=True)
                    except Exception:
                        pass
            elif callable(self.check):
                error = self.check(view, selected)
                if error:
                    return await interaction.response.send_message(error, ephemeral=True)
        values = {self.field: channel_id, **(self.extra or {})}
        await update_settings(view.guild_id, view.feature_key, **values)
        notice = self.notice(channel_id) if callable(self.notice) else self.notice
        if self.reopen:
            return await view.reopen(interaction, notice)
        view.settings.update(values)
        return await view.refresh(interaction, notice)


class AssistToggleButton(discord.ui.Button):
    """(key, label) でパラメータ化した汎用トグル（stickyroles/serverlog 型の昇格）。

    require: (view, interaction, value) -> str | None。前提チェックで、
    文字列を返したらその文面で中断する。notice は完了文の差し替え
    （文字列、または value から作る callable）。reopen な機能は refresh でなく
    view.reopen で再表示する（settings の手元同期もしない）。
    """

    def __init__(
        self,
        key: str,
        label: str,
        *,
        feature_label: str | None = None,
        row: int = 2,
        require: Any = None,
        reopen: bool = False,
        notice: Any = None,
    ):
        super().__init__(label=label, style=discord.ButtonStyle.secondary, row=row)
        self.key = key
        self.feature_label = feature_label if feature_label is not None else label
        self.require = require
        self.reopen = reopen
        self.notice_text = notice

    async def callback(self, interaction: discord.Interaction):
        from core.support.messages import ASSIST_MANAGE_REQUIRED
        from core.support.server_assist import update_settings

        view = self.view
        if not view.can_manage(interaction):
            return await interaction.response.send_message(ASSIST_MANAGE_REQUIRED, ephemeral=True)
        value = not bool(view.settings.get(self.key, False))
        if self.require is not None:
            error = self.require(view, interaction, value)
            if error:
                return await interaction.response.send_message(error, ephemeral=True)
        await update_settings(view.guild_id, view.feature_key, **{self.key: value})
        if self.notice_text is not None:
            notice = self.notice_text(value) if callable(self.notice_text) else self.notice_text
        else:
            notice = f"{self.feature_label}を{'オン' if value else 'オフ'}にしました。"
        if self.reopen:
            return await view.reopen(interaction, notice)
        view.settings[self.key] = value
        return await view.refresh(interaction, notice)


def required_field(field: str, message: str):
    """有効化時に field が未設定なら message で中断する require を作る。"""

    def require(view: Any, interaction: discord.Interaction, value: bool) -> str | None:
        if value and view.settings.get(field) is None:
            return message
        return None

    return require
