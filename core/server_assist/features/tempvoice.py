"""Temporary voice channels with a persistent control panel."""
from __future__ import annotations

import logging
from typing import Any

import discord

from core.server_assist import Feature, get_settings, update_settings
from core.server_assist.ui import AssistFeatureView, channel_label, notice_line
from core.storage import KVStore

logger = logging.getLogger(__name__)

KEY = "tempvoice"
DEFAULT_TEMPLATE = "{user}のVC"

FEATURE = Feature(
    key=KEY,
    label="一時VC",
    description="参加すると専用のボイスチャンネルを自動作成し、名前変更やロックができます。",
    order=50,
    module_name=__name__,
)

_entries: KVStore | None = None
_cache: dict[str, dict[str, Any]] | None = None


def reset_cache() -> None:
    global _entries, _cache
    _entries = None
    _cache = None


def _entry_store() -> KVStore:
    global _entries
    if _entries is None:
        _entries = KVStore("server_assist_tempvoice")
    return _entries


async def _entries_cache() -> dict[str, dict[str, Any]]:
    global _cache
    if _cache is None:
        _cache = dict(await _entry_store().load_all())
    return _cache


async def _put_entry(channel_id: int, entry: dict[str, Any]) -> None:
    cache = await _entries_cache()
    key = str(channel_id)
    cache[key] = dict(entry)
    await _entry_store().set(key, dict(entry))


async def _pop_entry(channel_id: int) -> dict[str, Any] | None:
    cache = await _entries_cache()
    key = str(channel_id)
    entry = cache.pop(key, None)
    if entry is not None:
        await _entry_store().delete(key)
    return entry


async def _find_owned(guild_id: int, owner_id: int) -> dict[str, Any] | None:
    for entry in (await _entries_cache()).values():
        if entry.get("guild_id") == guild_id and entry.get("owner_id") == owner_id:
            return entry
    return None


def settings(guild_id: int) -> dict[str, Any]:
    raw = get_settings(guild_id, KEY)
    template = raw.get("name_template")
    if not isinstance(template, str) or not template.strip():
        template = DEFAULT_TEMPLATE
    try:
        limit = int(raw.get("user_limit", 0))
    except (TypeError, ValueError):
        limit = 0
    return {
        "enabled": bool(raw.get("enabled", False)),
        "join_channel_id": raw.get("join_channel_id") if isinstance(raw.get("join_channel_id"), int) else None,
        "name_template": template[:100],
        "user_limit": max(0, min(99, limit)),
    }


def _voice_channels(guild: Any) -> list[Any]:
    me = getattr(guild, "me", None)
    channels = list(getattr(guild, "voice_channels", []) or [])
    usable: list[Any] = []
    for channel in channels:
        if me is not None:
            try:
                permissions = channel.permissions_for(me)
                if not getattr(permissions, "connect", True):
                    continue
            except Exception:
                pass
        usable.append(channel)
    return usable[:25]


def _build_name(template: str, member: Any) -> str:
    name = template or DEFAULT_TEMPLATE
    name = name.replace("{user}", getattr(member, "display_name", None) or getattr(member, "name", "メンバー"))
    name = name.replace("{name}", getattr(member, "display_name", None) or "メンバー")
    name = name.replace("{id}", str(getattr(member, "id", "")))
    return (name.strip() or "VC")[:100]


def build_panel_embed(channel: Any, owner_id: int) -> discord.Embed:
    embed = discord.Embed(
        title="一時VC",
        description=(
            f"作成者: <@{owner_id}>"
            "\n\n下のボタンから、名前変更・人数制限・ロック・削除ができます。"
            "\n退出して誰もいなくなると、自動で削除されます。"
        ),
        color=0xFFFFFF,
    )
    channel_name = getattr(channel, "name", "")
    if channel_name:
        embed.set_footer(text=f"#{channel_name}"[:2048])
    return embed


class TempVoiceControlView(discord.ui.View):
    def __init__(self, cog: Any):
        self.cog = cog
        super().__init__(timeout=None)

    @discord.ui.button(label="名前変更", style=discord.ButtonStyle.primary,
                       custom_id="assist:tempvoice:rename", row=0)
    async def rename(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self.cog.handle_temp_voice_action(interaction, "rename")

    @discord.ui.button(label="人数制限", style=discord.ButtonStyle.secondary,
                       custom_id="assist:tempvoice:limit", row=0)
    async def limit(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self.cog.handle_temp_voice_action(interaction, "limit")

    @discord.ui.button(label="ロック", style=discord.ButtonStyle.danger,
                       custom_id="assist:tempvoice:lock", row=0)
    async def lock(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self.cog.handle_temp_voice_action(interaction, "lock")

    @discord.ui.button(label="解除", style=discord.ButtonStyle.success,
                       custom_id="assist:tempvoice:unlock", row=0)
    async def unlock(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self.cog.handle_temp_voice_action(interaction, "unlock")

    @discord.ui.button(label="削除", style=discord.ButtonStyle.danger,
                       custom_id="assist:tempvoice:delete", row=0)
    async def delete(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self.cog.handle_temp_voice_action(interaction, "delete")


def register_views(cog: Any) -> None:
    add_view = getattr(getattr(cog, "bot", None), "add_view", None)
    if callable(add_view):
        try:
            add_view(TempVoiceControlView(cog))
        except Exception:
            logger.exception("一時VCの操作パネルを永続登録できませんでした")


def _allowed(interaction: discord.Interaction, entry: dict[str, Any]) -> bool:
    user = interaction.user
    if getattr(user, "id", None) == entry.get("owner_id"):
        return True
    permissions = getattr(user, "guild_permissions", None)
    return bool(
        getattr(permissions, "administrator", False)
        or getattr(permissions, "manage_channels", False)
    )


async def _update_panel(guild: Any, channel: Any, entry: dict[str, Any], cog: Any) -> None:
    panel_id = entry.get("panel_id")
    if not panel_id:
        return
    try:
        panel = await channel.fetch_message(int(panel_id))
        await panel.edit(
            embed=build_panel_embed(channel, int(entry.get("owner_id", 0))),
            view=TempVoiceControlView(cog),
        )
    except (discord.NotFound, discord.Forbidden, discord.HTTPException, AttributeError):
        logger.debug("一時VCの操作パネルを更新できませんでした: channel=%s", getattr(channel, "id", None))


async def _delete_temp(guild: Any, channel: Any) -> None:
    entry = (await _entries_cache()).get(str(channel.id))
    if entry is None:
        return
    try:
        await channel.delete(reason="TempVoice empty")
    except (discord.NotFound, discord.Forbidden, discord.HTTPException):
        logger.debug("一時VCを削除できませんでした: channel=%s", getattr(channel, "id", None))
    await _pop_entry(channel.id)


async def _create_temp(cog: Any, guild: Any, member: Any, join_channel: Any, current: dict[str, Any]) -> None:
    existing = await _find_owned(guild.id, member.id)
    if existing is not None:
        channel = guild.get_channel(existing.get("channel_id"))
        if channel is not None:
            try:
                await member.move_to(channel, reason="TempVoice existing")
            except (discord.Forbidden, discord.HTTPException):
                logger.debug("既存の一時VCへ移動できませんでした: member=%s", getattr(member, "id", None))
            return
    kwargs: dict[str, Any] = {"reason": "TempVoice"}
    category = getattr(join_channel, "category", None)
    if category is not None:
        kwargs["category"] = category
    if current.get("user_limit"):
        kwargs["user_limit"] = current["user_limit"]
    try:
        channel = await guild.create_voice_channel(_build_name(current["name_template"], member), **kwargs)
    except (discord.Forbidden, discord.HTTPException):
        logger.exception("一時VCを作成できませんでした: guild=%s", getattr(guild, "id", None))
        return
    try:
        await member.move_to(channel, reason="TempVoice")
    except (discord.Forbidden, discord.HTTPException):
        logger.debug("一時VCへ移動できませんでした: member=%s", getattr(member, "id", None))
    try:
        panel = await channel.send(
            embed=build_panel_embed(channel, member.id),
            view=TempVoiceControlView(cog),
        )
    except (discord.Forbidden, discord.HTTPException):
        panel = None
        logger.debug("一時VCの操作パネルを送信できませんでした: channel=%s", getattr(channel, "id", None))
    await _put_entry(channel.id, {
        "channel_id": channel.id,
        "guild_id": guild.id,
        "owner_id": member.id,
        "panel_id": getattr(panel, "id", None),
    })


async def on_voice_state_update(cog: Any, member: Any, before: Any, after: Any) -> None:
    if getattr(member, "bot", False):
        return
    guild = getattr(member, "guild", None)
    if guild is None:
        return
    current = settings(guild.id)
    if not current["enabled"] or current["join_channel_id"] is None:
        return
    cache = await _entries_cache()
    before_channel = getattr(before, "channel", None)
    if before_channel is not None and str(before_channel.id) in cache:
        if not getattr(before_channel, "members", None):
            await _delete_temp(guild, before_channel)
    join_channel = guild.get_channel(current["join_channel_id"])
    if join_channel is None:
        return
    after_channel = getattr(after, "channel", None)
    if after_channel is not None and after_channel.id == join_channel.id:
        if before_channel is None or before_channel.id != join_channel.id:
            await _create_temp(cog, guild, member, join_channel, current)


async def handle_action(cog: Any, interaction: discord.Interaction, action: str) -> None:
    if interaction.guild is None or interaction.channel_id is None:
        return await interaction.response.send_message("サーバー内で実行してください。", ephemeral=True)
    key = str(interaction.channel_id)
    entry = (await _entries_cache()).get(key)
    if entry is None:
        return await interaction.response.send_message("このVCは一時VCではありません。", ephemeral=True)
    if not _allowed(interaction, entry):
        return await interaction.response.send_message(
            "この操作はVCの作成者か「チャンネルの管理」権限を持つ人だけが実行できます。", ephemeral=True,
        )
    channel = interaction.guild.get_channel(interaction.channel_id)
    if channel is None:
        await _pop_entry(interaction.channel_id)
        return await interaction.response.send_message("VCが見つかりません。", ephemeral=True)
    if action == "rename":
        return await interaction.response.send_modal(TempVoiceRenameModal(cog, interaction.guild_id, channel))
    if action == "limit":
        return await interaction.response.send_modal(TempVoiceLimitModal(cog, interaction.guild_id, channel))
    if action in {"lock", "unlock"}:
        default_role = getattr(interaction.guild, "default_role", None)
        if default_role is None:
            return await interaction.response.send_message("サーバーのロールを取得できませんでした。", ephemeral=True)
        try:
            await channel.set_permissions(
                default_role,
                connect=action == "unlock",
                reason="TempVoice lock" if action == "lock" else "TempVoice unlock",
            )
        except (discord.Forbidden, discord.HTTPException):
            return await interaction.response.send_message("権限を変更できませんでした。", ephemeral=True)
        await _update_panel(interaction.guild, channel, entry, cog)
        return await interaction.response.send_message(
            "VCをロックしました。" if action == "lock" else "VCのロックを解除しました。",
            ephemeral=True,
        )
    if action == "delete":
        try:
            await channel.delete(reason="TempVoice owner deleted")
        except (discord.Forbidden, discord.HTTPException):
            return await interaction.response.send_message("VCを削除できませんでした。", ephemeral=True)
        await _pop_entry(interaction.channel_id)
        return await interaction.response.send_message("VCを削除しました。", ephemeral=True)
    return await interaction.response.send_message("不明な操作です。", ephemeral=True)


class TempVoiceRenameModal(discord.ui.Modal, title="一時VCの名前変更"):
    def __init__(self, cog: Any, guild_id: int, channel: Any):
        super().__init__()
        self.cog = cog
        self.guild_id = guild_id
        self.channel_id = channel.id
        self.text = discord.ui.TextInput(
            label="新しい名前",
            default=str(getattr(channel, "name", ""))[:100],
            max_length=100,
            required=True,
        )
        self.add_item(self.text)

    async def on_submit(self, interaction: discord.Interaction):
        entry = (await _entries_cache()).get(str(self.channel_id))
        if entry is None or not _allowed(interaction, entry):
            return await interaction.response.send_message("操作できません。", ephemeral=True)
        channel = interaction.guild.get_channel(self.channel_id) if interaction.guild else None
        if channel is None:
            return await interaction.response.send_message("VCが見つかりません。", ephemeral=True)
        try:
            await channel.edit(name=str(self.text.value)[:100], reason="TempVoice rename")
        except (discord.Forbidden, discord.HTTPException):
            return await interaction.response.send_message("名前を変更できませんでした。", ephemeral=True)
        await _update_panel(interaction.guild, channel, entry, self.cog)
        return await interaction.response.send_message("名前を変更しました。", ephemeral=True)


class TempVoiceLimitModal(discord.ui.Modal, title="一時VCの人数制限"):
    def __init__(self, cog: Any, guild_id: int, channel: Any):
        super().__init__()
        self.cog = cog
        self.guild_id = guild_id
        self.channel_id = channel.id
        self.text = discord.ui.TextInput(
            label="人数上限（0で無制限）",
            default=str(getattr(channel, "user_limit", 0) or 0),
            max_length=2,
            required=True,
        )
        self.add_item(self.text)

    async def on_submit(self, interaction: discord.Interaction):
        entry = (await _entries_cache()).get(str(self.channel_id))
        if entry is None or not _allowed(interaction, entry):
            return await interaction.response.send_message("操作できません。", ephemeral=True)
        try:
            limit = max(0, min(99, int(self.text.value)))
        except (TypeError, ValueError):
            return await interaction.response.send_message("0〜99の数字を入力してください。", ephemeral=True)
        channel = interaction.guild.get_channel(self.channel_id) if interaction.guild else None
        if channel is None:
            return await interaction.response.send_message("VCが見つかりません。", ephemeral=True)
        try:
            await channel.edit(user_limit=limit, reason="TempVoice limit")
        except (discord.Forbidden, discord.HTTPException):
            return await interaction.response.send_message("人数制限を変更できませんでした。", ephemeral=True)
        await _update_panel(interaction.guild, channel, entry, self.cog)
        return await interaction.response.send_message("人数制限を変更しました。", ephemeral=True)


class TempVoiceChannelSelect(discord.ui.Select):
    def __init__(self, parent: "TempVoiceSettingsView"):
        self.parent_view = parent
        current = parent.settings["join_channel_id"]
        options = [
            discord.SelectOption(
                label=str(getattr(channel, "name", "VC"))[:100],
                value=str(channel.id),
                default=channel.id == current,
            )
            for channel in _voice_channels(parent.guild)
        ]
        if not options:
            options = [discord.SelectOption(label="作成できるVCがありません", value="__none__")]
        super().__init__(placeholder="参加すると作成されるVC", options=options[:25], row=0)

    async def callback(self, interaction: discord.Interaction):
        if not self.parent_view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定には「サーバーの管理」権限が必要です。", ephemeral=True,
            )
        if self.values[0] == "__none__":
            return await interaction.response.send_message("作成できるVCがありません。", ephemeral=True)
        channel_id = int(self.values[0])
        await update_settings(self.parent_view.guild_id, KEY, join_channel_id=channel_id)
        self.parent_view.settings["join_channel_id"] = channel_id
        await self.parent_view.refresh(interaction, "作成用VCを保存しました。")


class TempVoiceToggleButton(discord.ui.Button):
    def __init__(self):
        super().__init__(label="一時VC", style=discord.ButtonStyle.secondary, row=2)

    async def callback(self, interaction: discord.Interaction):
        view: TempVoiceSettingsView = self.view
        if not view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定には「サーバーの管理」権限が必要です。", ephemeral=True,
            )
        if not view.settings["enabled"] and not view.settings["join_channel_id"]:
            return await interaction.response.send_message(
                "先に作成用VCを選んでください。", ephemeral=True,
            )
        value = not view.settings["enabled"]
        await update_settings(view.guild_id, KEY, enabled=value)
        view.settings["enabled"] = value
        await view.refresh(interaction, f"一時VCを{'オン' if value else 'オフ'}にしました。")


class TempVoiceTemplateButton(discord.ui.Button):
    def __init__(self):
        super().__init__(label="名前テンプレート", style=discord.ButtonStyle.primary, row=2)

    async def callback(self, interaction: discord.Interaction):
        view: TempVoiceSettingsView = self.view
        if not view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定には「サーバーの管理」権限が必要です。", ephemeral=True,
            )
        return await interaction.response.send_modal(TempVoiceTemplateModal(view))


class TempVoiceLimitButton(discord.ui.Button):
    def __init__(self):
        super().__init__(label="既定の人数上限", style=discord.ButtonStyle.primary, row=2)

    async def callback(self, interaction: discord.Interaction):
        view: TempVoiceSettingsView = self.view
        if not view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定には「サーバーの管理」権限が必要です。", ephemeral=True,
            )
        return await interaction.response.send_modal(TempVoiceDefaultLimitModal(view))


class TempVoiceTemplateModal(discord.ui.Modal, title="一時VCの名前テンプレート"):
    def __init__(self, parent: "TempVoiceSettingsView"):
        super().__init__()
        self.parent_view = parent
        self.text = discord.ui.TextInput(
            label="名前テンプレート",
            default=parent.settings["name_template"][:100],
            max_length=100,
            required=True,
            placeholder="例: {user}のVC",
        )
        self.add_item(self.text)

    async def on_submit(self, interaction: discord.Interaction):
        if not self.parent_view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定には「サーバーの管理」権限が必要です。", ephemeral=True,
            )
        value = str(self.text.value or "").strip() or DEFAULT_TEMPLATE
        await update_settings(self.parent_view.guild_id, KEY, name_template=value[:100])
        self.parent_view.settings["name_template"] = value[:100]
        await self.parent_view.refresh(interaction, "名前テンプレートを保存しました。")


class TempVoiceDefaultLimitModal(discord.ui.Modal, title="一時VCの既定人数"):
    def __init__(self, parent: "TempVoiceSettingsView"):
        super().__init__()
        self.parent_view = parent
        self.text = discord.ui.TextInput(
            label="人数上限（0で無制限）",
            default=str(parent.settings["user_limit"]),
            max_length=2,
            required=True,
        )
        self.add_item(self.text)

    async def on_submit(self, interaction: discord.Interaction):
        if not self.parent_view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定には「サーバーの管理」権限が必要です。", ephemeral=True,
            )
        try:
            limit = max(0, min(99, int(self.text.value)))
        except (TypeError, ValueError):
            return await interaction.response.send_message("0〜99の数字を入力してください。", ephemeral=True)
        await update_settings(self.parent_view.guild_id, KEY, user_limit=limit)
        self.parent_view.settings["user_limit"] = limit
        await self.parent_view.refresh(interaction, "既定の人数上限を保存しました。")


class TempVoiceSettingsView(AssistFeatureView):
    feature_key = KEY
    feature_title = "一時VC"

    def __init__(self, cog: Any, guild_id: int):
        self.guild = getattr(cog.bot, "get_guild", lambda _id: None)(guild_id)
        self.settings = settings(guild_id)
        super().__init__(cog, guild_id)
        if self.guild is not None:
            self.add_item(TempVoiceChannelSelect(self))
        self.add_item(TempVoiceToggleButton())
        self.add_item(TempVoiceTemplateButton())
        self.add_item(TempVoiceLimitButton())

    def embed(self) -> discord.Embed:
        embed = discord.Embed(
            title="一時VC",
            description=(
                "指定したVCに参加すると、専用のVCを作成して移動します。"
                f"\n\n**状態**: {'オン' if self.settings['enabled'] else 'オフ'}"
                f"\n**作成用VC**: {channel_label(self.settings['join_channel_id'])}"
                f"\n**名前**: {self.settings['name_template']}"
                f"\n**既定の人数上限**: {self.settings['user_limit'] or '無制限'}"
                "\n\n作成されたVCのパネルから、名前変更・人数制限・ロック・削除ができます。"
                + notice_line(self.notice)
            )[:4096],
            color=0xFFFFFF,
        )
        return embed


def build_view(cog: Any, guild_id: int) -> TempVoiceSettingsView:
    return TempVoiceSettingsView(cog, guild_id)
