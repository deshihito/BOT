"""Sticky roles: restore a member's roles when they rejoin."""
from __future__ import annotations

import logging
from typing import Any

import discord

from core.server_assist import Feature, get_settings, update_settings
from core.server_assist.ui import AssistFeatureView, notice_line
from core.storage import KVStore

logger = logging.getLogger(__name__)

KEY = "stickyroles"
MAX_ROLES = 25

FEATURE = Feature(
    key=KEY,
    label="ロール復元",
    description="退出したメンバーのロールを保存し、再参加時に戻します。",
    order=130,
    module_name=__name__,
)

_entries: KVStore | None = None
_cache: dict[str, list[int]] | None = None


def reset_cache() -> None:
    global _entries, _cache
    _entries = None
    _cache = None


def _store() -> KVStore:
    global _entries
    if _entries is None:
        _entries = KVStore("server_assist_stickyroles")
    return _entries


async def _cache_data() -> dict[str, list[int]]:
    global _cache
    if _cache is None:
        _cache = dict(await _store().load_all())
    return _cache


def _key(guild_id: int, user_id: int) -> str:
    return f"{guild_id}:{user_id}"


def settings(guild_id: int) -> dict[str, Any]:
    raw = get_settings(guild_id, KEY)
    return {
        "enabled": bool(raw.get("enabled", False)),
        "ignore_bots": bool(raw.get("ignore_bots", True)),
    }


def _assignable_roles(guild: Any, roles: list[Any]) -> list[Any]:
    top = getattr(getattr(guild, "me", None), "top_role", None)
    result = []
    for role in roles:
        if role is None or getattr(role, "is_default", lambda: False)() or getattr(role, "managed", False):
            continue
        if top is not None:
            try:
                if role >= top:
                    continue
            except TypeError:
                pass
        if role not in result:
            result.append(role)
    return result[:MAX_ROLES]


async def on_member_remove(cog: Any, member: Any) -> None:
    current = settings(member.guild.id)
    if not current["enabled"] or (current["ignore_bots"] and getattr(member, "bot", False)):
        return
    roles = _assignable_roles(member.guild, list(getattr(member, "roles", []) or []))
    role_ids = [int(role.id) for role in roles]
    cache = await _cache_data()
    key = _key(member.guild.id, member.id)
    if role_ids:
        cache[key] = role_ids
        await _store().set(key, role_ids)
    else:
        cache.pop(key, None)
        await _store().delete(key)


async def on_member_join(cog: Any, member: Any) -> None:
    current = settings(member.guild.id)
    if not current["enabled"] or (current["ignore_bots"] and getattr(member, "bot", False)):
        return
    cache = await _cache_data()
    key = _key(member.guild.id, member.id)
    role_ids = cache.get(key)
    if not role_ids:
        return
    roles = [member.guild.get_role(int(role_id)) for role_id in role_ids]
    roles = _assignable_roles(member.guild, roles)
    try:
        if roles:
            await member.add_roles(*roles, reason="Sticky roles restore")
    except (discord.Forbidden, discord.HTTPException):
        logger.warning("ロール復元に失敗しました: guild=%s member=%s", member.guild.id, member.id)
        return
    cache.pop(key, None)
    await _store().delete(key)


class StickyToggleButton(discord.ui.Button):
    def __init__(self, key: str, label: str):
        self.key = key
        super().__init__(label=label, style=discord.ButtonStyle.secondary, row=2)

    async def callback(self, interaction: discord.Interaction):
        view: StickySettingsView = self.view
        if not view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定には「サーバーの管理」権限が必要です。", ephemeral=True,
            )
        value = not bool(view.settings[self.key])
        await update_settings(view.guild_id, KEY, **{self.key: value})
        view.settings[self.key] = value
        label = "オン" if value else "オフ"
        await view.refresh(interaction, f"{self.label}を{label}にしました。")


class StickySettingsView(AssistFeatureView):
    feature_key = KEY
    feature_title = "ロール復元"

    def __init__(self, cog: Any, guild_id: int):
        self.settings = settings(guild_id)
        super().__init__(cog, guild_id)
        self.add_item(StickyToggleButton("enabled", "ロール復元"))
        self.add_item(StickyToggleButton("ignore_bots", "BOTを除外"))

    def embed(self) -> discord.Embed:
        return discord.Embed(
            title="ロール復元",
            description=(
                "退出したメンバーのロールを保存し、再参加時に戻します。"
                f"\n\n**状態**: {'オン' if self.settings['enabled'] else 'オフ'}"
                f"\n**BOTを除外**: {'オン' if self.settings['ignore_bots'] else 'オフ'}"
                "\n\nBotの最上位ロール以上、managedロール、@everyoneは復元しません。"
                "ロールを戻すには「ロールの管理」権限が必要です。"
                + notice_line(self.notice)
            )[:4096],
            color=0xFFFFFF,
        )


def build_view(cog: Any, guild_id: int) -> StickySettingsView:
    return StickySettingsView(cog, guild_id)
