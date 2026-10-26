"""Automatic role assignment for new members."""
from __future__ import annotations

import logging
from typing import Any

import discord

from core.server_assist import Feature, can_assign_roles, get_settings, update_settings
from core.server_assist.ui import AssistFeatureView, notice_line

logger = logging.getLogger(__name__)

KEY = "autorole"
MAX_ROLES = 10

FEATURE = Feature(
    key=KEY,
    label="自動ロール",
    description="メンバーが参加したときに、指定したロールを自動で付与します。",
    order=20,
    module_name=__name__,
)


def settings(guild_id: int) -> dict[str, Any]:
    raw = get_settings(guild_id, KEY)
    role_ids: list[int] = []
    values = raw.get("role_ids")
    if isinstance(values, list):
        for value in values:
            if isinstance(value, int) and not isinstance(value, bool) and value not in role_ids:
                role_ids.append(value)
    return {
        "enabled": bool(raw.get("enabled", False)),
        "role_ids": role_ids[:MAX_ROLES],
        "include_bots": bool(raw.get("include_bots", False)),
    }


def _is_default(role: Any) -> bool:
    marker = getattr(role, "is_default", False)
    return bool(marker() if callable(marker) else marker)


def _assignable_roles(guild: Any, limit: int | None = 25) -> list[Any]:
    me = getattr(guild, "me", None)
    top = getattr(me, "top_role", None)
    roles: list[Any] = []
    for role in getattr(guild, "roles", []) or []:
        if _is_default(role) or getattr(role, "managed", False):
            continue
        if top is not None:
            try:
                if role >= top:
                    continue
            except TypeError:
                pass
        roles.append(role)
    return roles[:limit] if limit is not None else roles


def _resolve_roles(guild: Any, role_ids: list[int]) -> list[Any]:
    assignable = {getattr(role, "id", None): role for role in _assignable_roles(guild, None)}
    return [assignable[role_id] for role_id in role_ids if role_id in assignable]


async def apply_roles(guild: Any, member: Any, role_ids: list[int], *, reason: str = "AutoRole") -> int:
    roles = _resolve_roles(guild, role_ids)
    if not roles:
        return 0
    try:
        await member.add_roles(*roles, reason=reason)
    except discord.Forbidden:
        logger.warning(
            "自動ロールを付与できません（権限不足）: guild=%s member=%s",
            getattr(guild, "id", None), getattr(member, "id", None),
        )
        return 0
    except discord.HTTPException:
        logger.exception(
            "自動ロールの付与に失敗しました: guild=%s member=%s",
            getattr(guild, "id", None), getattr(member, "id", None),
        )
        return 0
    return len(roles)


class AutoRoleSelect(discord.ui.Select):
    def __init__(self, parent: "AutoRoleSettingsView"):
        self.parent_view = parent
        roles = _assignable_roles(parent.guild)
        options = [
            discord.SelectOption(
                label=str(getattr(role, "name", "ロール"))[:100],
                value=str(role.id),
                default=role.id in parent.settings["role_ids"],
            )
            for role in roles
        ]
        if not options:
            options = [discord.SelectOption(label="設定できるロールがありません", value="__none__")]
        super().__init__(
            placeholder="自動付与するロール（最大10個）",
            options=options[:25],
            min_values=0 if roles else 1,
            max_values=min(MAX_ROLES, len(options)),
            disabled=not roles,
            row=0,
        )

    async def callback(self, interaction: discord.Interaction):
        if not self.parent_view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定には「サーバーの管理」権限が必要です。", ephemeral=True,
            )
        if self.values == ["__none__"]:
            return await interaction.response.send_message(
                "Botが付与できるロールがありません。ロールの位置を確認してください。", ephemeral=True,
            )
        role_ids = [int(value) for value in self.values][:MAX_ROLES]
        if not can_assign_roles(interaction, self.parent_view.guild, role_ids):
            return await interaction.response.send_message(
                "ロールの管理権限、または自分より上のロールを付与しようとしています。",
                ephemeral=True,
            )
        await update_settings(self.parent_view.guild_id, KEY, role_ids=role_ids)
        self.parent_view.settings["role_ids"] = role_ids
        await self.parent_view.refresh(interaction, "自動付与するロールを保存しました。")


class AutoRoleToggleButton(discord.ui.Button):
    def __init__(self):
        super().__init__(label="自動ロール", style=discord.ButtonStyle.secondary, row=2)

    async def callback(self, interaction: discord.Interaction):
        view: AutoRoleSettingsView = self.view
        if not view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定には「サーバーの管理」権限が必要です。", ephemeral=True,
            )
        value = not view.settings["enabled"]
        if value and view.settings["role_ids"] and not can_assign_roles(
            interaction, view.guild, view.settings["role_ids"],
        ):
            return await interaction.response.send_message(
                "ロールの管理権限、または自分より上のロールが設定されています。",
                ephemeral=True,
            )
        await update_settings(view.guild_id, KEY, enabled=value)
        view.settings["enabled"] = value
        await view.refresh(interaction, f"自動ロールを{'オン' if value else 'オフ'}にしました。")


class AutoRoleBotsButton(discord.ui.Button):
    def __init__(self):
        super().__init__(label="BOTにも付与", style=discord.ButtonStyle.secondary, row=2)

    async def callback(self, interaction: discord.Interaction):
        view: AutoRoleSettingsView = self.view
        if not view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定には「サーバーの管理」権限が必要です。", ephemeral=True,
            )
        value = not view.settings["include_bots"]
        await update_settings(view.guild_id, KEY, include_bots=value)
        view.settings["include_bots"] = value
        await view.refresh(interaction, f"BOTへの付与を{'オン' if value else 'オフ'}にしました。")


class AutoRoleTestButton(discord.ui.Button):
    def __init__(self):
        super().__init__(label="自分に適用して確認", style=discord.ButtonStyle.success, row=2)

    async def callback(self, interaction: discord.Interaction):
        view: AutoRoleSettingsView = self.view
        if not view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定には「サーバーの管理」権限が必要です。", ephemeral=True,
            )
        member = interaction.user
        if not hasattr(member, "add_roles"):
            return await interaction.response.send_message(
                "サーバー内で実行してください。", ephemeral=True,
            )
        if not can_assign_roles(interaction, view.guild, view.settings["role_ids"]):
            return await interaction.response.send_message(
                "ロールの管理権限、または自分より上のロールを付与しようとしています。",
                ephemeral=True,
            )
        count = await apply_roles(view.guild, member, view.settings["role_ids"], reason="AutoRole test")
        if count:
            return await interaction.response.send_message(
                f"{count} 個のロールを付与しました。", ephemeral=True,
            )
        return await interaction.response.send_message(
            "付与できませんでした。ロールの位置とBotの権限を確認してください。", ephemeral=True,
        )


class AutoRoleSettingsView(AssistFeatureView):
    feature_key = KEY
    feature_title = "自動ロール"

    def __init__(self, cog: Any, guild_id: int):
        self.guild = getattr(cog.bot, "get_guild", lambda _id: None)(guild_id)
        self.settings = settings(guild_id)
        super().__init__(cog, guild_id)
        if self.guild is not None:
            self.add_item(AutoRoleSelect(self))
        self.add_item(AutoRoleToggleButton())
        self.add_item(AutoRoleBotsButton())
        self.add_item(AutoRoleTestButton())

    def embed(self) -> discord.Embed:
        role_ids = self.settings["role_ids"]
        role_text = ", ".join(f"<@&{role_id}>" for role_id in role_ids) if role_ids else "未設定"
        embed = discord.Embed(
            title="自動ロール",
            description=(
                "メンバーが参加したときに、選んだロールを自動で付与します。"
                f"\n\n**状態**: {'オン' if self.settings['enabled'] else 'オフ'}"
                f"\n**BOTにも付与**: {'オン' if self.settings['include_bots'] else 'オフ'}"
                f"\n**付与するロール**: {role_text}"
                f"\n\nBotの最上位ロールより下のロールだけ選べます。"
                "管理者専用ロールなど、意図しない権限は付与しないでください。"
                + notice_line(self.notice)
            )[:4096],
            color=0xFFFFFF,
        )
        if self.guild is None:
            embed.add_field(name="注意", value="サーバー情報を取得できませんでした。", inline=False)
        return embed


async def on_member_join(cog: Any, member: Any) -> None:
    guild = getattr(member, "guild", None)
    if guild is None:
        return
    current = settings(guild.id)
    if not current["enabled"]:
        return
    if getattr(member, "bot", False) and not current["include_bots"]:
        return
    await apply_roles(guild, member, current["role_ids"])


def build_view(cog: Any, guild_id: int) -> AutoRoleSettingsView:
    return AutoRoleSettingsView(cog, guild_id)
