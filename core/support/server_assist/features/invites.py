"""Invite tracker: identify which invite a new member used."""
from __future__ import annotations

import asyncio
import logging
from typing import Any

import discord

from core.support.server_assist import Feature, get_settings, update_settings
from core.support.server_assist.ui import AssistFeatureView, channel_label, notice_line
from core.support.server_assist.ui import AssistChannelSelect, AssistToggleButton, required_field
from core.support.messages import ASSIST_MANAGE_REQUIRED

logger = logging.getLogger(__name__)

KEY = "invites"

FEATURE = Feature(
    key=KEY,
    label="招待トラッカー",
    description="新しいメンバーがどの招待リンクから参加したかを記録します。",
    order=110,
    module_name=__name__,
)

_invites: dict[str, int] = {}
_primed: set[int] = set()


def reset_cache() -> None:
    _invites.clear()
    _primed.clear()


def _key(guild_id: int, code: str) -> str:
    return f"{guild_id}:{code}"


def settings(guild_id: int) -> dict[str, Any]:
    raw = get_settings(guild_id, KEY)
    return {
        "enabled": bool(raw.get("enabled", False)),
        "channel_id": raw.get("channel_id") if isinstance(raw.get("channel_id"), int) else None,
    }


def _remember(invites: list[Any]) -> None:
    for invite in invites:
        guild = getattr(invite, "guild", None)
        code = getattr(invite, "code", None)
        if guild is None or not code:
            continue
        _invites[_key(guild.id, code)] = int(getattr(invite, "uses", 0) or 0)


async def prime(cog: Any) -> None:
    await cog.bot.wait_until_ready()
    for guild in list(getattr(cog.bot, "guilds", []) or []):
        try:
            invites = await guild.invites()
        except (discord.Forbidden, discord.HTTPException, AttributeError):
            continue
        _remember(list(invites))
        _primed.add(guild.id)


def start_tasks(cog: Any) -> None:
    task = asyncio.create_task(prime(cog), name="server-assist-invites")
    getattr(cog, "_feature_tasks", []).append(task)


async def on_invite_create(cog: Any, invite: Any) -> None:
    _remember([invite])


async def on_invite_delete(cog: Any, invite: Any) -> None:
    guild = getattr(invite, "guild", None)
    code = getattr(invite, "code", None)
    if guild is not None and code:
        _invites.pop(_key(guild.id, code), None)


def build_embed(member: Any, invite: Any | None) -> discord.Embed:
    embed = discord.Embed(
        title="招待で参加",
        description=getattr(member, "mention", ""),
        color=0xFFFFFF,
    )
    embed.add_field(name="ユーザーID", value=str(getattr(member, "id", "")), inline=True)
    if invite is not None:
        inviter = getattr(invite, "inviter", None)
        embed.add_field(
            name="招待した人",
            value=(
                f"{getattr(inviter, 'mention', '不明')} / ID {getattr(inviter, 'id', '不明')}"
                if inviter is not None else "不明"
            ),
            inline=False,
        )
        embed.add_field(name="招待コード", value=str(getattr(invite, "code", ""))[:100], inline=True)
        embed.add_field(name="使用回数", value=str(getattr(invite, "uses", 0) or 0), inline=True)
    else:
        embed.add_field(name="招待した人", value="不明（招待の特定に失敗）", inline=False)
    created = getattr(member, "created_at", None)
    if created is not None:
        embed.add_field(name="アカウント作成", value=discord.utils.format_dt(created, "R"), inline=True)
    return embed


async def on_member_join(cog: Any, member: Any) -> None:
    guild = getattr(member, "guild", None)
    if guild is None:
        return
    current = settings(guild.id)
    if not current["enabled"] or current["channel_id"] is None:
        return
    fetched = True
    try:
        invites = list(await guild.invites())
    except (discord.Forbidden, discord.HTTPException, AttributeError):
        invites = []
        fetched = False
    primed = guild.id in _primed
    used = None
    best = 0
    if primed and fetched:
        for invite in invites:
            code = getattr(invite, "code", None)
            if not code:
                continue
            old = _invites.get(_key(guild.id, code), 0)
            now = int(getattr(invite, "uses", 0) or 0)
            if now > old and now - old > best:
                used, best = invite, now - old
    _remember(invites)
    if fetched:
        _primed.add(guild.id)
    channel = guild.get_channel(current["channel_id"])
    if channel is None:
        return
    try:
        await channel.send(embed=build_embed(member, used))
    except (discord.Forbidden, discord.HTTPException):
        logger.debug("招待ログを送信できませんでした: guild=%s", getattr(guild, "id", None))


class InviteSettingsView(AssistFeatureView):
    feature_key = KEY

    def __init__(self, cog: Any, guild_id: int):
        self.guild = getattr(cog.bot, "get_guild", lambda _id: None)(guild_id)
        self.settings = settings(guild_id)
        super().__init__(cog, guild_id)
        if self.guild is not None:
            self.add_item(AssistChannelSelect(self, field="channel_id", placeholder="招待ログの送信先", notice="招待ログの送信先を保存しました。", min_values=0, empty_message="送信できるチャンネルがありません。"))
        self.add_item(AssistToggleButton("enabled", "招待トラッカー", require=required_field("channel_id", "先に送信先を選んでください。")))

    def embed(self) -> discord.Embed:
        return discord.Embed(
            title="招待トラッカー",
            description=(
                "新しいメンバーがどの招待リンクから参加したかをログに残します。"
                f"\n\n**状態**: {'オン' if self.settings['enabled'] else 'オフ'}"
                f"\n**送信先**: {channel_label(self.settings['channel_id'])}"
                "\n\nBotに「サーバーの管理」権限が必要です。"
                + notice_line(self.notice)
            )[:4096],
            color=0xFFFFFF,
        )


def build_view(cog: Any, guild_id: int) -> InviteSettingsView:
    return InviteSettingsView(cog, guild_id)
