"""Warning panel: record a warning, log it, and notify the member."""
from __future__ import annotations

import asyncio
import datetime
import logging
import uuid
from typing import Any

import discord

from core.server_assist import Feature, get_settings, update_settings
from core.server_assist.ui import AssistFeatureView, channel_label, notice_line
from core.storage import KVStore

logger = logging.getLogger(__name__)

KEY = "warnings"
MAX_WARNINGS = 100

FEATURE = Feature(
    key=KEY,
    label="警告",
    description="メンバーへの警告を記録し、ログとDMで通知します。",
    order=100,
    module_name=__name__,
)

_entries: KVStore | None = None
_cache: dict[str, dict[str, Any]] | None = None
_locks: dict[str, asyncio.Lock] = {}


def reset_cache() -> None:
    global _entries, _cache
    _entries = None
    _cache = None
    _locks.clear()


def _store() -> KVStore:
    global _entries
    if _entries is None:
        _entries = KVStore("server_assist_warnings")
    return _entries


async def _cache_data() -> dict[str, dict[str, Any]]:
    global _cache
    if _cache is None:
        _cache = dict(await _store().load_all())
    return _cache


def _cache_key(guild_id: int, user_id: int) -> str:
    return f"{guild_id}:{user_id}"


def _lock(key: str) -> asyncio.Lock:
    return _locks.setdefault(key, asyncio.Lock())


def _as_int(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def settings(guild_id: int) -> dict[str, Any]:
    raw = get_settings(guild_id, KEY)
    return {
        "enabled": bool(raw.get("enabled", False)),
        "panel_channel_id": _as_int(raw.get("panel_channel_id")),
        "log_channel_id": _as_int(raw.get("log_channel_id")),
        "mod_role_id": _as_int(raw.get("mod_role_id")),
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


def can_warn(interaction: discord.Interaction) -> bool:
    permissions = getattr(getattr(interaction, "user", None), "guild_permissions", None)
    if getattr(permissions, "administrator", False) or getattr(permissions, "manage_guild", False):
        return True
    guild_id = getattr(interaction, "guild_id", None)
    if guild_id is None:
        return False
    role_id = settings(guild_id).get("mod_role_id")
    if role_id is None:
        return False
    roles = getattr(getattr(interaction, "user", None), "roles", []) or []
    return any(getattr(role, "id", None) == role_id for role in roles)


def build_panel_embed() -> discord.Embed:
    return discord.Embed(
        title="警告",
        description=(
            "下のメニューから警告するメンバーを選んでください。"
            "\n警告の理由を入力すると、記録・ログ・DM通知を行います。"
            "\n操作できるのは「サーバーの管理」権限か、設定したモデレーターロールを持つ人だけです。"
        ),
        color=0xFFFFFF,
    )


def build_log_embed(
    target_name: str, target_id: int, moderator_id: int, reason: str, total: int,
) -> discord.Embed:
    embed = discord.Embed(title="警告を記録しました", color=0xFFFFFF)
    embed.add_field(name="対象", value=f"{target_name} (<@{target_id}>)"[:1024], inline=False)
    embed.add_field(name="理由", value=reason[:1024], inline=False)
    embed.add_field(name="実行者", value=f"<@{moderator_id}>", inline=True)
    embed.add_field(name="通算", value=f"{total}件", inline=True)
    return embed


async def _record(guild_id: int, user_id: int, warning: dict[str, Any]) -> tuple[dict[str, Any], int]:
    key = _cache_key(guild_id, user_id)
    async with _lock(key):
        cache = await _cache_data()
        entry = dict(cache.get(key) or {})
        warnings = list(entry.get("warnings") or [])
        warnings.append(warning)
        entry.update({
            "guild_id": guild_id,
            "user_id": user_id,
            "warnings": warnings[-MAX_WARNINGS:],
            "total": int(entry.get("total", 0)) + 1,
        })
        cache[key] = entry
        await _store().set(key, dict(entry), wait=False)
        return entry, int(entry["total"])


class WarningMemberSelect(discord.ui.UserSelect):
    def __init__(self, cog: Any):
        self.cog = cog
        super().__init__(
            placeholder="警告するメンバーを選ぶ",
            min_values=1,
            max_values=1,
            custom_id="assist:warn:member",
            row=0,
        )

    async def callback(self, interaction: discord.Interaction):
        if not can_warn(interaction):
            return await interaction.response.send_message(
                "警告を出せるのは「サーバーの管理」権限か、設定したモデレーターロールを持つ人だけです。",
                ephemeral=True,
            )
        target = self.values[0]
        name = getattr(target, "display_name", None) or getattr(target, "name", "メンバー")
        return await interaction.response.send_modal(
            WarningReasonModal(self.cog, interaction.guild_id, target.id, name)
        )


class WarningPanelView(discord.ui.View):
    def __init__(self, cog: Any):
        self.cog = cog
        super().__init__(timeout=None)
        self.add_item(WarningMemberSelect(cog))


def register_views(cog: Any) -> None:
    add_view = getattr(getattr(cog, "bot", None), "add_view", None)
    if not callable(add_view):
        return
    try:
        add_view(WarningPanelView(cog))
    except Exception:
        logger.exception("警告パネルの永続ビューを登録できませんでした")


class WarningReasonModal(discord.ui.Modal, title="警告"):
    def __init__(self, cog: Any, guild_id: int | None, user_id: int, user_name: str):
        super().__init__()
        self.cog = cog
        self.guild_id = guild_id
        self.user_id = user_id
        self.user_name = user_name
        self.reason_input = discord.ui.TextInput(
            label="理由",
            style=discord.TextStyle.paragraph,
            max_length=500,
            required=True,
        )
        self.add_item(self.reason_input)

    async def on_submit(self, interaction: discord.Interaction):
        if interaction.guild is None or interaction.guild_id is None:
            return await interaction.response.send_message("サーバー内で実行してください。", ephemeral=True)
        if not can_warn(interaction):
            return await interaction.response.send_message(
                "警告を出せるのは「サーバーの管理」権限か、設定したモデレーターロールを持つ人だけです。",
                ephemeral=True,
            )
        current = settings(interaction.guild_id)
        if not current["enabled"]:
            return await interaction.response.send_message("警告機能は現在オフです。", ephemeral=True)
        await interaction.response.defer(ephemeral=True)
        reason = str(self.reason_input.value or "").strip()[:500] or "理由なし"
        warning = {
            "id": uuid.uuid4().hex[:12],
            "moderator_id": interaction.user.id,
            "reason": reason,
            "created_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        }
        entry, total = await _record(interaction.guild_id, self.user_id, warning)

        log_channel = None
        if current["log_channel_id"] is not None:
            log_channel = interaction.guild.get_channel(current["log_channel_id"])
        if log_channel is not None:
            try:
                await log_channel.send(
                    embed=build_log_embed(
                        self.user_name, self.user_id, interaction.user.id, reason, total,
                    )
                )
            except Exception:
                logger.exception("警告ログを送信できませんでした: guild=%s", interaction.guild_id)

        target = interaction.guild.get_member(self.user_id)
        if target is None:
            try:
                target = await interaction.client.fetch_user(self.user_id)
            except Exception:
                target = None
        dm_sent = False
        if target is not None:
            try:
                await target.send(
                    f"{interaction.guild.name} で警告を受けました。\n理由: {reason}\n通算: {total}件"
                )
                dm_sent = True
            except Exception:
                logger.debug("警告DMを送信できませんでした: user=%s", self.user_id)
        note = "" if dm_sent else "（DMは送れませんでした）"
        return await interaction.followup.send(
            f"{self.user_name} に警告を記録しました（通算{total}件）{note}", ephemeral=True,
        )


class WarningChannelSelect(discord.ui.Select):
    def __init__(self, parent: "WarningSettingsView", kind: str):
        self.parent_view = parent
        self.kind = kind
        field = f"{kind}_channel_id"
        current = parent.settings[field]
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
        labels = {"panel": "警告パネルを置くチャンネル", "log": "警告ログを送るチャンネル"}
        super().__init__(
            placeholder=labels.get(kind, "チャンネル"),
            options=options[:25],
            row=0 if kind == "panel" else 1,
        )

    async def callback(self, interaction: discord.Interaction):
        if not self.parent_view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定には「サーバーの管理」権限が必要です。", ephemeral=True,
            )
        if self.values[0] == "__none__":
            return await interaction.response.send_message("送信できるチャンネルがありません。", ephemeral=True)
        channel_id = int(self.values[0])
        field = f"{self.kind}_channel_id"
        await update_settings(self.parent_view.guild_id, KEY, **{field: channel_id})
        self.parent_view.settings[field] = channel_id
        await self.parent_view.refresh(interaction, "警告のチャンネルを保存しました。")


class WarningRoleSelect(discord.ui.Select):
    def __init__(self, parent: "WarningSettingsView"):
        self.parent_view = parent
        current = parent.settings["mod_role_id"]
        options = [discord.SelectOption(label="なし", value="__none__", default=current is None)]
        roles = [
            role for role in list(getattr(parent.guild, "roles", []) or [])
            if not getattr(role, "is_default", lambda: False)()
            and not getattr(role, "managed", False)
        ]
        for role in roles[:24]:
            options.append(
                discord.SelectOption(
                    label=str(getattr(role, "name", "ロール"))[:100],
                    value=str(role.id),
                    default=role.id == current,
                )
            )
        super().__init__(placeholder="警告できるモデレーターロール（任意）", options=options, row=2)

    async def callback(self, interaction: discord.Interaction):
        if not self.parent_view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定には「サーバーの管理」権限が必要です。", ephemeral=True,
            )
        value = None if self.values[0] == "__none__" else int(self.values[0])
        await update_settings(self.parent_view.guild_id, KEY, mod_role_id=value)
        self.parent_view.settings["mod_role_id"] = value
        await self.parent_view.refresh(interaction, "モデレーターロールを保存しました。")


class WarningToggleButton(discord.ui.Button):
    def __init__(self):
        super().__init__(label="警告", style=discord.ButtonStyle.secondary, row=3)

    async def callback(self, interaction: discord.Interaction):
        view: WarningSettingsView = self.view
        if not view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定には「サーバーの管理」権限が必要です。", ephemeral=True,
            )
        if not view.settings["enabled"] and view.settings["panel_channel_id"] is None:
            return await interaction.response.send_message("先に警告パネルのチャンネルを選んでください。", ephemeral=True)
        value = not view.settings["enabled"]
        await update_settings(view.guild_id, KEY, enabled=value)
        view.settings["enabled"] = value
        await view.refresh(interaction, f"警告を{'オン' if value else 'オフ'}にしました。")


class WarningPanelButton(discord.ui.Button):
    def __init__(self):
        super().__init__(label="パネルを送信", style=discord.ButtonStyle.primary, row=3)

    async def callback(self, interaction: discord.Interaction):
        view: WarningSettingsView = self.view
        if not view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定には「サーバーの管理」権限が必要です。", ephemeral=True,
            )
        channel_id = view.settings["panel_channel_id"]
        channel = interaction.guild.get_channel(channel_id) if interaction.guild and channel_id else None
        if channel is None:
            return await interaction.response.send_message("先に警告パネルのチャンネルを選んでください。", ephemeral=True)
        try:
            await channel.send(embed=build_panel_embed(), view=WarningPanelView(view.cog))
        except (discord.Forbidden, discord.HTTPException):
            return await interaction.response.send_message("パネルを送信できませんでした。", ephemeral=True)
        return await interaction.response.send_message("警告パネルを送信しました。", ephemeral=True)


class WarningSettingsView(AssistFeatureView):
    feature_key = KEY
    feature_title = "警告"

    def __init__(self, cog: Any, guild_id: int):
        self.guild = getattr(cog.bot, "get_guild", lambda _id: None)(guild_id)
        self.settings = settings(guild_id)
        super().__init__(cog, guild_id)
        if self.guild is not None:
            self.add_item(WarningChannelSelect(self, "panel"))
            self.add_item(WarningChannelSelect(self, "log"))
            self.add_item(WarningRoleSelect(self))
        self.add_item(WarningToggleButton())
        self.add_item(WarningPanelButton())

    def embed(self) -> discord.Embed:
        role_id = self.settings["mod_role_id"]
        role_label = f"<@&{role_id}>" if role_id else "なし"
        return discord.Embed(
            title="警告",
            description=(
                "警告パネルを設置し、メンバーへの警告を記録します。"
                f"\n\n**状態**: {'オン' if self.settings['enabled'] else 'オフ'}"
                f"\n**パネル**: {channel_label(self.settings['panel_channel_id'])}"
                f"\n**ログ**: {channel_label(self.settings['log_channel_id'])}"
                f"\n**モデレーターロール**: {role_label}"
                "\n\n警告は記録・ログ・DM通知のみで、自動のタイムアウトやBANは行いません。"
                + notice_line(self.notice)
            )[:4096],
            color=0xFFFFFF,
        )


def build_view(cog: Any, guild_id: int) -> WarningSettingsView:
    return WarningSettingsView(cog, guild_id)

