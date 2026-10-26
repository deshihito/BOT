"""Reaction roles: map emoji reactions on a message to roles."""
from __future__ import annotations

import logging
import re
from typing import Any

import discord

from core.server_assist import Feature, get_settings, update_settings
from core.server_assist.ui import AssistFeatureView, channel_label, notice_line

logger = logging.getLogger(__name__)

KEY = "reactionroles"
MAX_MAPPINGS = 25

FEATURE = Feature(
    key=KEY,
    label="リアクションロール",
    description="対象メッセージの絵文字リアクションでロールを付与・解除します。",
    order=120,
    module_name=__name__,
)


def settings(guild_id: int) -> dict[str, Any]:
    raw = get_settings(guild_id, KEY)
    mappings: dict[str, int] = {}
    raw_mappings = raw.get("mappings")
    if isinstance(raw_mappings, dict):
        for emoji, role_id in raw_mappings.items():
            try:
                role_int = int(role_id)
            except (TypeError, ValueError):
                continue
            emoji_text = str(emoji).strip()
            if emoji_text and role_int > 0:
                mappings[emoji_text] = role_int
    return {
        "enabled": bool(raw.get("enabled", False)),
        "channel_id": raw.get("channel_id") if isinstance(raw.get("channel_id"), int) else None,
        "message_id": raw.get("message_id") if isinstance(raw.get("message_id"), int) else None,
        "mappings": dict(list(mappings.items())[:MAX_MAPPINGS]),
    }


def _channels(guild: Any) -> list[Any]:
    me = getattr(guild, "me", None)
    channels = list(getattr(guild, "text_channels", []) or [])
    usable: list[Any] = []
    for channel in channels:
        if me is not None:
            try:
                if not channel.permissions_for(me).send_messages:
                    continue
            except Exception:
                pass
        usable.append(channel)
    return usable[:25]


def parse_mappings(value: str) -> dict[str, int]:
    mappings: dict[str, int] = {}
    for token in re.split(r"[\n,]+", value or ""):
        token = token.strip()
        if not token:
            continue
        separator = "=" if "=" in token else ":" if ":" in token else None
        if separator is None:
            raise ValueError("絵文字=ロールID の形式で入力してください。")
        emoji, role_text = token.split(separator, 1)
        emoji = emoji.strip()
        role_id = int(role_text.strip())
        if not emoji or role_id <= 0:
            raise ValueError("絵文字とロールIDを確認してください。")
        mappings[emoji] = role_id
    if len(mappings) > MAX_MAPPINGS:
        raise ValueError(f"リアクションロールは最大{MAX_MAPPINGS}件です。")
    return mappings


def _emoji(value: str) -> Any:
    try:
        return discord.PartialEmoji.from_str(value)
    except Exception:
        return value


async def _target_message(guild: Any, current: dict[str, Any]) -> Any | None:
    channel = guild.get_channel(current["channel_id"]) if current["channel_id"] else None
    if channel is None or current["message_id"] is None:
        return None
    try:
        return await channel.fetch_message(int(current["message_id"]))
    except (discord.NotFound, discord.Forbidden, discord.HTTPException, AttributeError):
        return None


async def apply_reactions(guild: Any, current: dict[str, Any]) -> int:
    message = await _target_message(guild, current)
    if message is None:
        return 0
    existing = {str(getattr(reaction, "emoji", "")) for reaction in (getattr(message, "reactions", []) or [])}
    added = 0
    for emoji in current.get("mappings", {}):
        if emoji in existing:
            continue
        try:
            await message.add_reaction(_emoji(emoji))
            added += 1
        except (discord.Forbidden, discord.HTTPException, AttributeError):
            logger.debug("リアクションを追加できませんでした: %s", emoji)
    return added


async def _member(guild: Any, user_id: int) -> Any | None:
    member = guild.get_member(user_id)
    if member is not None:
        return member
    try:
        return await guild.fetch_member(user_id)
    except (discord.NotFound, discord.Forbidden, discord.HTTPException, AttributeError):
        return None


def _role_allowed(guild: Any, role: Any) -> bool:
    if role is None or getattr(role, "managed", False):
        return False
    top_role = getattr(getattr(guild, "me", None), "top_role", None)
    if top_role is not None:
        try:
            if role >= top_role:
                return False
        except TypeError:
            pass
    return True


async def _toggle(cog: Any, payload: Any, adding: bool) -> None:
    guild = getattr(cog.bot, "get_guild", lambda _id: None)(getattr(payload, "guild_id", None))
    if guild is None:
        return
    current = settings(guild.id)
    if not current["enabled"] or current["message_id"] != getattr(payload, "message_id", None):
        return
    if current["channel_id"] != getattr(payload, "channel_id", None):
        return
    role_id = current["mappings"].get(str(getattr(payload, "emoji", "")))
    if role_id is None:
        return
    member = await _member(guild, int(payload.user_id))
    if member is None or getattr(member, "bot", False):
        return
    role = guild.get_role(role_id)
    if not _role_allowed(guild, role):
        return
    try:
        if adding:
            await member.add_roles(role, reason="Reaction role")
        else:
            await member.remove_roles(role, reason="Reaction role")
    except (discord.Forbidden, discord.HTTPException):
        logger.debug("リアクションロールを変更できませんでした: guild=%s user=%s", guild.id, payload.user_id)


async def on_raw_reaction_add(cog: Any, payload: Any) -> None:
    await _toggle(cog, payload, True)


async def on_raw_reaction_remove(cog: Any, payload: Any) -> None:
    await _toggle(cog, payload, False)


class ReactionRoleChannelSelect(discord.ui.Select):
    def __init__(self, parent: "ReactionRoleSettingsView"):
        self.parent_view = parent
        current = parent.settings["channel_id"]
        options = [
            discord.SelectOption(
                label=str(getattr(channel, "name", "チャンネル"))[:100],
                value=str(channel.id),
                default=channel.id == current,
            )
            for channel in _channels(parent.guild)
        ]
        if not options:
            options = [discord.SelectOption(label="送信できるチャンネルがありません", value="__none__")]
        super().__init__(placeholder="対象メッセージのチャンネル", options=options[:25], row=0)

    async def callback(self, interaction: discord.Interaction):
        if not self.parent_view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定には「サーバーの管理」権限が必要です。", ephemeral=True,
            )
        if self.values[0] == "__none__":
            return await interaction.response.send_message("送信できるチャンネルがありません。", ephemeral=True)
        channel_id = int(self.values[0])
        await update_settings(self.parent_view.guild_id, KEY, channel_id=channel_id, message_id=None, mappings={})
        self.parent_view.settings.update({"channel_id": channel_id, "message_id": None, "mappings": {}})
        await self.parent_view.refresh(interaction, "対象チャンネルを保存しました。")


class ReactionRoleMessageButton(discord.ui.Button):
    def __init__(self):
        super().__init__(label="対象メッセージ", style=discord.ButtonStyle.primary, row=2)

    async def callback(self, interaction: discord.Interaction):
        view: ReactionRoleSettingsView = self.view
        if not view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定には「サーバーの管理」権限が必要です。", ephemeral=True,
            )
        return await interaction.response.send_modal(ReactionRoleMessageModal(view))


class ReactionRoleMappingButton(discord.ui.Button):
    def __init__(self):
        super().__init__(label="絵文字とロール", style=discord.ButtonStyle.primary, row=2)

    async def callback(self, interaction: discord.Interaction):
        view: ReactionRoleSettingsView = self.view
        if not view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定には「サーバーの管理」権限が必要です。", ephemeral=True,
            )
        if view.settings["message_id"] is None:
            return await interaction.response.send_message("先に対象メッセージを設定してください。", ephemeral=True)
        return await interaction.response.send_modal(ReactionRoleMappingModal(view))


class ReactionRoleRefreshButton(discord.ui.Button):
    def __init__(self):
        super().__init__(label="リアクションを反映", style=discord.ButtonStyle.success, row=2)

    async def callback(self, interaction: discord.Interaction):
        view: ReactionRoleSettingsView = self.view
        if not view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定には「サーバーの管理」権限が必要です。", ephemeral=True,
            )
        if interaction.guild is None:
            return await interaction.response.send_message("サーバー内で実行してください。", ephemeral=True)
        added = await apply_reactions(interaction.guild, view.settings)
        return await interaction.response.send_message(
            f"{added}件のリアクションを追加しました。", ephemeral=True,
        )


class ReactionRoleToggleButton(discord.ui.Button):
    def __init__(self):
        super().__init__(label="リアクションロール", style=discord.ButtonStyle.secondary, row=2)

    async def callback(self, interaction: discord.Interaction):
        view: ReactionRoleSettingsView = self.view
        if not view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定には「サーバーの管理」権限が必要です。", ephemeral=True,
            )
        if not view.settings["enabled"] and (
            view.settings["channel_id"] is None
            or view.settings["message_id"] is None
            or not view.settings["mappings"]
        ):
            return await interaction.response.send_message(
                "チャンネル・メッセージ・絵文字マッピングを先に設定してください。", ephemeral=True,
            )
        value = not view.settings["enabled"]
        await update_settings(view.guild_id, KEY, enabled=value)
        view.settings["enabled"] = value
        await view.refresh(interaction, f"リアクションロールを{'オン' if value else 'オフ'}にしました。")


class ReactionRoleMessageModal(discord.ui.Modal, title="対象メッセージ"):
    def __init__(self, parent: "ReactionRoleSettingsView"):
        super().__init__()
        self.parent_view = parent
        self.text = discord.ui.TextInput(
            label="メッセージID",
            default=str(parent.settings.get("message_id") or ""),
            max_length=20,
            required=True,
        )
        self.add_item(self.text)

    async def on_submit(self, interaction: discord.Interaction):
        if not self.parent_view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定には「サーバーの管理」権限が必要です。", ephemeral=True,
            )
        try:
            message_id = int(str(self.text.value).strip())
        except (TypeError, ValueError):
            return await interaction.response.send_message("メッセージIDが正しくありません。", ephemeral=True)
        await update_settings(
            self.parent_view.guild_id, KEY,
            message_id=message_id, mappings={},
        )
        self.parent_view.settings.update({"message_id": message_id, "mappings": {}})
        await self.parent_view.refresh(interaction, "対象メッセージを保存しました。")


class ReactionRoleMappingModal(discord.ui.Modal, title="絵文字とロール"):
    def __init__(self, parent: "ReactionRoleSettingsView"):
        super().__init__()
        self.parent_view = parent
        current = "\n".join(f"{emoji}={role_id}" for emoji, role_id in parent.settings["mappings"].items())
        self.text = discord.ui.TextInput(
            label="絵文字=ロールID（1行1個）",
            style=discord.TextStyle.paragraph,
            default=current[:1500],
            max_length=1500,
            required=True,
            placeholder="例:\n🎮=123456789012345678\n📚=123456789012345679",
        )
        self.add_item(self.text)

    async def on_submit(self, interaction: discord.Interaction):
        if not self.parent_view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定には「サーバーの管理」権限が必要です。", ephemeral=True,
            )
        try:
            mappings = parse_mappings(str(self.text.value or ""))
        except (TypeError, ValueError) as exc:
            return await interaction.response.send_message(f"保存できませんでした: {exc}", ephemeral=True)
        await update_settings(self.parent_view.guild_id, KEY, mappings=mappings)
        self.parent_view.settings["mappings"] = mappings
        if interaction.guild is not None:
            await apply_reactions(interaction.guild, self.parent_view.settings)
        await self.parent_view.refresh(interaction, "絵文字とロールを保存しました。")


class ReactionRoleSettingsView(AssistFeatureView):
    feature_key = KEY
    feature_title = "リアクションロール"

    def __init__(self, cog: Any, guild_id: int):
        self.guild = getattr(cog.bot, "get_guild", lambda _id: None)(guild_id)
        self.settings = settings(guild_id)
        super().__init__(cog, guild_id)
        if self.guild is not None:
            self.add_item(ReactionRoleChannelSelect(self))
        self.add_item(ReactionRoleMessageButton())
        self.add_item(ReactionRoleMappingButton())
        self.add_item(ReactionRoleRefreshButton())
        self.add_item(ReactionRoleToggleButton())

    def embed(self) -> discord.Embed:
        mappings = self.settings["mappings"]
        lines = [f"{emoji} → <@&{role_id}>" for emoji, role_id in mappings.items()]
        message = (
            f"https://discord.com/channels/{self.guild_id}/{self.settings['channel_id']}/{self.settings['message_id']}"
            if self.settings["channel_id"] and self.settings["message_id"] else "未設定"
        )
        return discord.Embed(
            title="リアクションロール",
            description=(
                "対象メッセージに絵文字リアクションすると、対応するロールを付与します。"
                "リアクションを外すとロールも外れます。"
                f"\n\n**状態**: {'オン' if self.settings['enabled'] else 'オフ'}"
                f"\n**対象メッセージ**: {message}"
                f"\n**マッピング**: {len(mappings)}件"
                f"\n\n{chr(10).join(lines) if lines else 'マッピングはありません。'}"
                + notice_line(self.notice)
            )[:4096],
            color=0xFFFFFF,
        )


def build_view(cog: Any, guild_id: int) -> ReactionRoleSettingsView:
    return ReactionRoleSettingsView(cog, guild_id)
