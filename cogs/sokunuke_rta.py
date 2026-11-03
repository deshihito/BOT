"""即抜けRTAと、開始時のVC自動参加。"""
from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
import logging

import discord
from discord import app_commands
from discord.ext import commands

from core import guild_settings

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
        humans = [
            state for state in member.guild.voice_states.values()
            if state.channel and not getattr(state.member, "bot", False)
        ]
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
            records = [row for row in records if str(row.get("user_id")) == str(interaction.user.id)]
        records.sort(key=lambda row: float(row.get("elapsed", 0)))
        lines = [f"**{i}.** <@{row['user_id']}> — **{_duration(row['elapsed'])}**" for i, row in enumerate(records[:10], 1)]
        embed = discord.Embed(title=f"即抜けRTAランキング（{'自分' if scope == 'me' else 'このサーバー'}）", description="\n".join(lines) if lines else "まだ記録がありません。", color=0xFFFFFF)
        await interaction.followup.send(embed=embed, allowed_mentions=discord.AllowedMentions.none())

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
