"""即抜けRTAと、開始時のVC自動参加。"""
from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
import io
import logging

import discord
from discord import app_commands
from discord.ext import commands

from core.support import guild_settings
from core.general.user_names import resolve_display_names
from core.leaderboard_image import (
    BoardRow, fetch_avatar_bytes, render_leaderboard_png,
)

SOKUNUKE_BOARD_FILENAME = "sokunuke_leaderboard.png"
SOKUNUKE_ACCENT = (234, 88, 12)

logger = logging.getLogger(__name__)
SECTION = "sokunuke_rta"
LIMIT = timedelta(days=1)


def _settings(store, guild_id: int) -> dict:
    raw = store.get(guild_id, SECTION)
    return raw if isinstance(raw, dict) else {}


def _enabled(settings: dict, key: str) -> bool:
    value = settings.get(key)
    return value if isinstance(value, bool) else True


def _duration(seconds: float) -> str:
    total = max(0, int(seconds))
    return f"{total // 3600}時間{(total % 3600) // 60}分{total % 60}秒"


def _human_voice_states(guild) -> list[object]:
    """Return human voice states across voice/stage channels.

    ``Guild.voice_states`` is not exposed by every supported discord.py build;
    channel-level ``voice_states`` is the portable source of truth.
    """
    channels = list(getattr(guild, "voice_channels", ()) or ())
    channels.extend(getattr(guild, "stage_channels", ()) or ())
    states = []
    seen_users = set()
    for channel in channels:
        for user_id, state in (getattr(channel, "voice_states", {}) or {}).items():
            if user_id in seen_users or getattr(state, "channel", None) is None:
                continue
            member = getattr(state, "member", None) or guild.get_member(user_id)
            if member is not None and not getattr(member, "bot", False):
                states.append(state)
                seen_users.add(user_id)
    return states


class SokuNukeRta(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot
        self._locks: dict[int, asyncio.Lock] = {}

    def _lock(self, guild_id: int) -> asyncio.Lock:
        return self._locks.setdefault(guild_id, asyncio.Lock())

    async def _get_settings(self, guild_id: int) -> dict:
        store = guild_settings.get_store()
        await store.ensure_loaded()
        return _settings(store, guild_id)

    async def _save(self, guild_id: int, **values):
        return await guild_settings.get_store().update(guild_id, SECTION, **values)

    @commands.Cog.listener()
    async def on_member_join(self, member: discord.Member):
        if member.bot:
            return
        settings = await self._get_settings(member.guild.id)
        joins = dict(settings.get("joins") or {})
        joins[str(member.id)] = discord.utils.utcnow().isoformat()
        await self._save(member.guild.id, joins=joins)

    @commands.Cog.listener()
    async def on_member_remove(self, member: discord.Member):
        if member.bot:
            return
        async with self._lock(member.guild.id):
            settings = await self._get_settings(member.guild.id)
            joins = dict(settings.get("joins") or {})
            joined = joins.pop(str(member.id), None)
            if not joined:
                return
            await self._save(member.guild.id, joins=joins)
            if not _enabled(settings, "measurement_enabled"):
                return
            try:
                joined_at = datetime.fromisoformat(joined)
                if joined_at.tzinfo is None:
                    joined_at = joined_at.replace(tzinfo=timezone.utc)
            except (TypeError, ValueError):
                return
            elapsed = discord.utils.utcnow() - joined_at
            if elapsed < timedelta(0) or elapsed > LIMIT:
                return
            records = list(settings.get("records") or [])
            records.append({"user_id": str(member.id), "elapsed": elapsed.total_seconds(), "at": discord.utils.utcnow().isoformat()})
            await self._save(member.guild.id, records=records[-1000:])

    @commands.Cog.listener()
    async def on_voice_state_update(self, member: discord.Member, before: discord.VoiceState, after: discord.VoiceState):
        if member.bot or before.channel is not None or after.channel is None:
            return
        settings = await self._get_settings(member.guild.id)
        if not _enabled(settings, "vc_auto_join_enabled"):
            return
        humans = _human_voice_states(member.guild)
        voice_client = member.guild.voice_client
        try:
            connected = voice_client is not None and voice_client.is_connected()
        except (AttributeError, TypeError):
            connected = voice_client is not None
        if len(humans) != 1 or connected:
            return
        try:
            await after.channel.connect(self_deaf=True)
        except (discord.ClientException, discord.Forbidden, discord.HTTPException):
            logger.exception("VC自動参加に失敗しました: guild=%s channel=%s", member.guild.id, after.channel.id)

    async def leaderboard(self, interaction: discord.Interaction, scope: str = "local"):
        if interaction.guild_id is None:
            return await interaction.followup.send("この機能はサーバー内でのみ使えます。", ephemeral=True)
        settings = await self._get_settings(interaction.guild_id)
        records = list(settings.get("records") or [])
        if scope == "me":
            # 自分の記録一覧は個人の履歴表示なので、従来どおりテキストで出す。
            records = [row for row in records if str(row.get("user_id")) == str(interaction.user.id)]
            records.sort(key=lambda row: float(row.get("elapsed", 0)))
            names = await resolve_display_names(
                self.bot, [row["user_id"] for row in records[:10]])
            lines = [f"**{i}.** {names.get(int(row['user_id']), '')} — **{_duration(row['elapsed'])}**" for i, row in enumerate(records[:10], 1)]
            embed = discord.Embed(title="即抜けRTAランキング（自分）", description="\n".join(lines) if lines else "まだ記録がありません。", color=0xFFFFFF)
            await interaction.followup.send(embed=embed, allowed_mentions=discord.AllowedMentions.none())
            return
        records.sort(key=lambda row: float(row.get("elapsed", 0)))
        # 氏名はメンションではなく通常表記（サーバー外だと「不明のユーザー」になる）
        names = await resolve_display_names(
            self.bot, [row["user_id"] for row in records[:10]])
        rows = [BoardRow(user_id=int(row["user_id"]),
                         name=names.get(int(row["user_id"]), ""),
                         value=_duration(row["elapsed"]))
                for row in records[:10]]
        if not rows:
            embed = discord.Embed(title="即抜けRTAランキング（このサーバー）", description="まだ記録がありません。", color=0xFFFFFF)
            await interaction.followup.send(embed=embed, allowed_mentions=discord.AllowedMentions.none())
            return
        avatars = await fetch_avatar_bytes(
            self.bot, [row.user_id for row in rows])
        png = await asyncio.to_thread(
            render_leaderboard_png,
            title="即抜けRTAランキング", sections=[(None, rows)],
            accent=SOKUNUKE_ACCENT, subtitle="このサーバー", avatars=avatars,
            cache_namespace="sokunuke-leaderboard")
        embed = discord.Embed(title="即抜けRTAランキング（このサーバー）", color=0xFFFFFF)
        embed.set_image(url=f"attachment://{SOKUNUKE_BOARD_FILENAME}")
        await interaction.followup.send(
            embed=embed,
            file=discord.File(io.BytesIO(png), filename=SOKUNUKE_BOARD_FILENAME),
            allowed_mentions=discord.AllowedMentions.none())

    async def sokunuke_command(self, interaction: discord.Interaction, action: app_commands.Choice[str]):
        if interaction.guild_id is None:
            return await interaction.response.send_message("この機能はサーバー内でのみ使えます。", ephemeral=True)
        settings = await self._get_settings(interaction.guild_id)
        if action.value == "status":
            return await interaction.response.send_message(
                embed=discord.Embed(
                    title="即抜けRTA設定",
                    description=(f"計測: {'オン' if _enabled(settings, 'measurement_enabled') else 'オフ'}\n"
                                 f"VC自動参加: {'オン' if _enabled(settings, 'vc_auto_join_enabled') else 'オフ'}"),
                    color=0xFFFFFF,
                ), ephemeral=True)
        key, enabled = {
            "on": ("measurement_enabled", True),
            "off": ("measurement_enabled", False),
            "vc_on": ("vc_auto_join_enabled", True),
            "vc_off": ("vc_auto_join_enabled", False),
        }[action.value]
        await self._save(interaction.guild_id, **{key: enabled})
        label = "計測" if key == "measurement_enabled" else "VC自動参加"
        await interaction.response.send_message(f"{label}を{'オン' if enabled else 'オフ'}にしました。", ephemeral=True)


async def setup(bot: commands.Bot):
    await bot.add_cog(SokuNukeRta(bot))
