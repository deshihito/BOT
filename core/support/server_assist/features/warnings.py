"""Warning panel: record a warning, log it, and notify the member."""
from __future__ import annotations

import asyncio
import datetime
import logging
import time
import uuid
from typing import Any

import discord

from core.support.server_assist import as_int, Feature, get_settings, register_persistent_views, update_settings
from core.support.server_assist.ui import AssistFeatureView, channel_label, notice_line
from core.support.server_assist.ui import AssistChannelSelect, AssistToggleButton, required_field
from core.support.messages import ASSIST_MANAGE_REQUIRED
from core.support.storage import KVStore

logger = logging.getLogger(__name__)

KEY = "warnings"
MAX_WARNINGS = 100
WARN_COOLDOWN = 3.0

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
_last_warn: dict[tuple[int, int, int], float] = {}


def reset_cache() -> None:
    global _entries, _cache
    _entries = None
    _cache = None
    _locks.clear()
    _last_warn.clear()


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


ESCALATION_ACTIONS = ("timeout", "kick")
ESCALATION_THRESHOLDS = (2, 3, 4, 5, 10)
# 処罰サイクル: (action, timeout_minutes)
ESCALATION_PRESETS = (("timeout", 10), ("timeout", 60), ("timeout", 1440), ("kick", 0))


def settings(guild_id: int) -> dict[str, Any]:
    raw = get_settings(guild_id, KEY)
    threshold = as_int(raw.get("escalation_threshold"))
    timeout_minutes = as_int(raw.get("escalation_timeout_minutes"))
    action = raw.get("escalation_action")
    return {
        "enabled": bool(raw.get("enabled", False)),
        "panel_channel_id": as_int(raw.get("panel_channel_id")),
        "log_channel_id": as_int(raw.get("log_channel_id")),
        "mod_role_id": as_int(raw.get("mod_role_id")),
        "escalation_enabled": bool(raw.get("escalation_enabled", False)),
        "escalation_threshold": threshold if threshold in ESCALATION_THRESHOLDS else 3,
        "escalation_action": action if action in ESCALATION_ACTIONS else "timeout",
        "escalation_timeout_minutes": (
            timeout_minutes if timeout_minutes is not None and 1 <= timeout_minutes <= 40320 else 60
        ),
    }


def escalation_action_for(total: int, current: dict[str, Any]) -> str | None:
    """通算警告数が閾値の倍数に達したら適用する処罰を返す。既定は無効。"""
    if not current.get("escalation_enabled"):
        return None
    threshold = int(current.get("escalation_threshold") or 3)
    if total <= 0 or total % threshold != 0:
        return None
    return str(current.get("escalation_action") or "timeout")


def escalation_label(current: dict[str, Any]) -> str:
    if current.get("escalation_action") == "kick":
        return "キック"
    minutes = int(current.get("escalation_timeout_minutes") or 60)
    return f"タイムアウト{minutes}分"


async def apply_escalation(guild: Any, user_id: int, total: int, current: dict[str, Any]) -> str | None:
    """閾値到達時に処罰を適用し、適用した処罰の表示名を返す (未適用・失敗時は None)。"""
    action = escalation_action_for(total, current)
    if action is None or guild is None:
        return None
    member = guild.get_member(user_id) if hasattr(guild, "get_member") else None
    if member is None:
        return None
    me = getattr(guild, "me", None)
    permissions = getattr(me, "guild_permissions", None)
    try:
        if action == "kick":
            if not getattr(permissions, "kick_members", False):
                return None
            await member.kick(reason=f"警告{total}件到達による自動エスカレーション")
        else:
            if not getattr(permissions, "moderate_members", False):
                return None
            minutes = int(current.get("escalation_timeout_minutes") or 60)
            await member.timeout(
                datetime.timedelta(minutes=minutes),
                reason=f"警告{total}件到達による自動エスカレーション",
            )
    except (discord.Forbidden, discord.HTTPException):
        logger.warning("警告エスカレーションを適用できませんでした: guild=%s user=%s", getattr(guild, "id", None), user_id)
        return None
    return escalation_label(current)


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
            "警告の理由を入力すると、記録・ログ・DM通知を行います。"
            "\n操作できるのは「サーバーの管理」権限か、設定したモデレーターロールを持つ人だけです。"
        ),
        color=0xFFFFFF,
    )


def build_log_embed(
    target_name: str, target_id: int, moderator_id: int, reason: str, total: int,
    escalation: str | None = None,
) -> discord.Embed:
    embed = discord.Embed(title="警告を記録しました", color=0xFFFFFF)
    embed.add_field(name="対象", value=f"{target_name} (<@{target_id}>)"[:1024], inline=False)
    embed.add_field(name="理由", value=reason[:1024], inline=False)
    embed.add_field(name="実行者", value=f"<@{moderator_id}>", inline=True)
    embed.add_field(name="通算", value=f"{total}件", inline=True)
    if escalation:
        embed.add_field(name="自動エスカレーション", value=escalation, inline=True)
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
    register_persistent_views(cog, "警告パネルの永続ビューを登録できませんでした", WarningPanelView)


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
        cooldown_key = (interaction.guild_id, interaction.user.id, self.user_id)
        now = time.monotonic()
        if now - _last_warn.get(cooldown_key, 0.0) < WARN_COOLDOWN:
            return await interaction.response.send_message(
                "同じメンバーへの連続警告は少し待ってください。", ephemeral=True,
            )
        _last_warn[cooldown_key] = now
        await interaction.response.defer()
        reason = str(self.reason_input.value or "").strip()[:500] or "理由なし"
        warning = {
            "id": uuid.uuid4().hex[:12],
            "moderator_id": interaction.user.id,
            "reason": reason,
            "created_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        }
        entry, total = await _record(interaction.guild_id, self.user_id, warning)

        applied = await apply_escalation(interaction.guild, self.user_id, total, current)

        log_channel = None
        if current["log_channel_id"] is not None:
            log_channel = interaction.guild.get_channel(current["log_channel_id"])
        if log_channel is not None:
            try:
                await log_channel.send(
                    embed=build_log_embed(
                        self.user_name, self.user_id, interaction.user.id, reason, total,
                        escalation=applied,
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
        if applied:
            note += f" / エスカレーション: {applied}を適用しました"
        return await interaction.followup.send(
            f"{self.user_name} に警告を記録しました（通算{total}件）{note}",
        )


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
                ASSIST_MANAGE_REQUIRED, ephemeral=True,
            )
        value = None if self.values[0] == "__none__" else int(self.values[0])
        await update_settings(self.parent_view.guild_id, KEY, mod_role_id=value)
        self.parent_view.settings["mod_role_id"] = value
        await self.parent_view.refresh(interaction, "モデレーターロールを保存しました。")


class WarningPanelButton(discord.ui.Button):
    def __init__(self):
        super().__init__(label="パネルを送信", style=discord.ButtonStyle.primary, row=3)

    async def callback(self, interaction: discord.Interaction):
        view: WarningSettingsView = self.view
        if not view.can_manage(interaction):
            return await interaction.response.send_message(
                ASSIST_MANAGE_REQUIRED, ephemeral=True,
            )
        channel_id = view.settings["panel_channel_id"]
        channel = interaction.guild.get_channel(channel_id) if interaction.guild and channel_id else None
        if channel is None:
            return await interaction.response.send_message("先に警告パネルのチャンネルを選んでください。", ephemeral=True)
        await interaction.response.defer()
        try:
            await channel.send(embed=build_panel_embed(), view=WarningPanelView(view.cog))
        except (discord.Forbidden, discord.HTTPException):
            return await interaction.followup.send("パネルを送信できませんでした。", ephemeral=True)
        return await interaction.followup.send("警告パネルを送信しました。")


class WarningEscalationThresholdButton(discord.ui.Button):
    def __init__(self):
        super().__init__(label="エスカレーション閾値", style=discord.ButtonStyle.secondary, row=3)

    async def callback(self, interaction: discord.Interaction):
        view: WarningSettingsView = self.view
        if not view.can_manage(interaction):
            return await interaction.response.send_message(
                ASSIST_MANAGE_REQUIRED, ephemeral=True,
            )
        current = int(view.settings.get("escalation_threshold") or 3)
        index = ESCALATION_THRESHOLDS.index(current) if current in ESCALATION_THRESHOLDS else 1
        value = ESCALATION_THRESHOLDS[(index + 1) % len(ESCALATION_THRESHOLDS)]
        await update_settings(view.guild_id, KEY, escalation_threshold=value)
        view.settings["escalation_threshold"] = value
        await view.refresh(interaction, f"エスカレーション閾値を{value}件にしました。")


class WarningEscalationActionButton(discord.ui.Button):
    def __init__(self):
        super().__init__(label="エスカレーション処罰", style=discord.ButtonStyle.secondary, row=3)

    async def callback(self, interaction: discord.Interaction):
        view: WarningSettingsView = self.view
        if not view.can_manage(interaction):
            return await interaction.response.send_message(
                ASSIST_MANAGE_REQUIRED, ephemeral=True,
            )
        current = (
            str(view.settings.get("escalation_action") or "timeout"),
            int(view.settings.get("escalation_timeout_minutes") or 60),
        )
        index = ESCALATION_PRESETS.index(current) if current in ESCALATION_PRESETS else 1
        action, minutes = ESCALATION_PRESETS[(index + 1) % len(ESCALATION_PRESETS)]
        await update_settings(
            view.guild_id, KEY, escalation_action=action, escalation_timeout_minutes=minutes,
        )
        view.settings["escalation_action"] = action
        view.settings["escalation_timeout_minutes"] = minutes
        label = "キック" if action == "kick" else f"タイムアウト{minutes}分"
        await view.refresh(interaction, f"エスカレーション処罰を{label}にしました。")


class WarningSettingsView(AssistFeatureView):
    feature_key = KEY

    def __init__(self, cog: Any, guild_id: int):
        self.guild = getattr(cog.bot, "get_guild", lambda _id: None)(guild_id)
        self.settings = settings(guild_id)
        super().__init__(cog, guild_id)
        if self.guild is not None:
            self.add_item(AssistChannelSelect(self, field="panel_channel_id", placeholder="警告パネルを置くチャンネル", notice="警告のチャンネルを保存しました。", row=0, check="send"))
            self.add_item(AssistChannelSelect(self, field="log_channel_id", placeholder="警告ログを送るチャンネル", notice="警告のチャンネルを保存しました。", row=1, check="send"))
            self.add_item(WarningRoleSelect(self))
        self.add_item(AssistToggleButton("enabled", "警告", row=3, require=required_field("panel_channel_id", "先に警告パネルのチャンネルを選んでください。")))
        self.add_item(WarningPanelButton())
        self.add_item(AssistToggleButton("escalation_enabled", "エスカレーション", feature_label="警告エスカレーション", row=3))
        self.add_item(WarningEscalationThresholdButton())
        self.add_item(WarningEscalationActionButton())

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
                f"\n**エスカレーション**: {'オン' if self.settings['escalation_enabled'] else 'オフ'}"
                f"（{self.settings['escalation_threshold']}件ごとに{escalation_label(self.settings)}）"
                "\n\nエスカレーションは既定オフです。オンにすると、警告が閾値の倍数に達するたび処罰を自動適用します。"
                + notice_line(self.notice)
            )[:4096],
            color=0xFFFFFF,
        )


def build_view(cog: Any, guild_id: int) -> WarningSettingsView:
    return WarningSettingsView(cog, guild_id)

