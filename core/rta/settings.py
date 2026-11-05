import asyncio
import logging
import re
import socket
import struct
import time
from collections import OrderedDict, deque
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from statistics import median
import discord
from discord import app_commands
from discord.ext import commands, tasks
from core.api_retry import run_with_retry

from core.rta.common import *  # noqa: F401,F403 - shared constants/helpers
from core.rta.helpers import _white_embed  # noqa: F401
from core.rta.views import BumpRtaRoleView  # noqa: F401

logger = logging.getLogger("cogs.disboard_rta")


class SettingsMixin:
    async def _call(self, fn):
        return await asyncio.get_running_loop().run_in_executor(
            self._executor, lambda: run_with_retry(fn)
        )


    async def _is_enabled(self, guild_id):
        gid = str(guild_id)
        if gid in self._enabled_cache:
            return self._enabled_cache[gid]
        if self.db is None:
            return True
        try:
            result = await self._call(lambda: self.db.table("bump_rta_settings").select(
                "notifications_enabled").eq("guild_id", gid).limit(1).execute())
            enabled = bool(result.data[0]["notifications_enabled"]) if result.data else True
            self._enabled_cache[gid] = enabled
            return enabled
        except Exception:
            logger.exception("bump_rta_settings read failed; using default enabled state: guild=%s", gid)
            return True


    async def _role_id(self, guild_id):
        """通知時にメンションするロールID (任意設定・未設定/取得失敗時は None)。"""
        gid = str(guild_id)
        if gid in self._role_cache:
            return self._role_cache[gid]
        if self.db is None:
            return None
        try:
            result = await self._call(lambda: self.db.table("bump_rta_settings").select(
                "role_id").eq("guild_id", gid).limit(1).execute())
            raw = result.data[0].get("role_id") if result.data else None
            role_id = int(raw) if raw is not None and str(raw).isdigit() else None
            self._role_cache[gid] = role_id
            return role_id
        except Exception:
            logger.debug("bump_rta_settings role read failed: guild=%s", gid, exc_info=True)
            return None


    async def _set_role_id(self, guild_id, role_id):
        gid = str(guild_id)
        self._role_cache[gid] = role_id
        if self.db is None:
            return
        await self._call(lambda: self.db.table("bump_rta_settings").upsert(
            {"guild_id": gid, "role_id": str(role_id) if role_id else None},
            on_conflict="guild_id").execute())


    async def leaderboard(self, interaction: discord.Interaction, event_type: str = "bump", scope: str = "local"):
        """/leaderboard から呼び出す bump/up RTA ランキング。"""
        if self.db is None:
            return await interaction.followup.send(
                embed=_white_embed("Supabase未接続のため順位を取得できません。"), ephemeral=True)
        try:
            if scope == "me":
                uid, gid = str(interaction.user.id), str(interaction.guild_id)
                local = await self._call(lambda: self.db.table("bump_rta_records").select(
                    "elapsed_ms,completed_at").eq("guild_id", gid).eq("user_id", uid).eq("event_type", event_type).order(
                        "elapsed_ms").limit(1).execute())
                global_best = await self._call(lambda: self.db.table("bump_rta_events").select(
                    "elapsed_ms,completed_at").eq("user_id", uid).eq("event_type", event_type).order("elapsed_ms").limit(1).execute())
                local_text = f"{local.data[0]['elapsed_ms'] / 1000:.2f}秒" if local.data else "記録なし"
                global_text = f"{global_best.data[0]['elapsed_ms'] / 1000:.2f}秒" if global_best.data else "記録なし"
                return await interaction.followup.send(
                    embed=_white_embed(
                        f"<@{uid}> の**{event_type}自己ベスト**\nこのサーバー: **{local_text}**\n全サーバー: **{global_text}**"),
                    allowed_mentions=discord.AllowedMentions.none(),
                )
            if scope == "global":
                rows = await self._call(lambda: self.db.rpc("get_bump_rta_global_ranking", {
                    "p_event_type": event_type, "p_limit": 10}).execute())
                data = rows.data or []
                lines = [f"**{i}.** <@{r['user_id']}> — **{r['elapsed_ms'] / 1000:.2f}秒**（{r['attempts']}回）" for i, r in enumerate(data, 1)]
                title = f"全サーバー {event_type} RTAランキング"
            else:
                rows = await self._call(lambda: self.db.table("bump_rta_records").select(
                    "user_id,elapsed_ms,completed_at").eq("guild_id", str(interaction.guild_id)).eq(
                    "event_type", event_type).order("elapsed_ms").limit(10).execute())
                data = rows.data or []
                lines = [f"**{i}.** <@{r['user_id']}> — **{r['elapsed_ms'] / 1000:.2f}秒**" for i, r in enumerate(data, 1)]
                title = f"このサーバー {event_type} RTAランキング"
            return await interaction.followup.send(
                embed=_white_embed(f"**{title}**\n" + ("\n".join(lines) if lines else "まだ記録がありません。")),
                allowed_mentions=discord.AllowedMentions.none(),
            )
        except Exception as e:
            logger.exception("bump/up leaderboard query failed: scope=%s kind=%s", scope, event_type)
            return await interaction.followup.send(
                embed=_white_embed(f"ランキングの取得に失敗しました。\n（{type(e).__name__}: {e}）"))


    async def bumprta_command(
        self,
        interaction: discord.Interaction,
        action: app_commands.Choice[str],
    ):
        if interaction.guild_id is None:
            return await interaction.response.send_message(
                embed=_white_embed("このコマンドはサーバー内でのみ使えます。"), ephemeral=True)
        selected_action = action.value
        if selected_action == "status":
            enabled = await self._is_enabled(interaction.guild_id)
            role_id = await self._role_id(interaction.guild_id)
            role_text = f"<@&{role_id}>" if role_id else "なし"
            return await interaction.response.send_message(
                embed=_white_embed(
                    f"bump/up通知とRTA計測: **{'オン' if enabled else 'オフ'}**（初期状態: オン）"
                    f"\n通知メンションロール: {role_text}"),
                ephemeral=True)
        if selected_action == "role":
            if not getattr(getattr(interaction.user, "guild_permissions", None), "manage_guild", False):
                return await interaction.response.send_message(
                    embed=_white_embed("この操作にはサーバー管理権限が必要です。"), ephemeral=True)
            current_role = await self._role_id(interaction.guild_id)
            return await interaction.response.send_message(
                embed=_white_embed("通知時にメンションするロールを選んでください（選択を外すと解除）。"),
                view=BumpRtaRoleView(self, interaction.guild_id, current_role),
                ephemeral=True)
        if selected_action in {"on", "off"}:
            if not getattr(getattr(interaction.user, "guild_permissions", None), "manage_guild", False):
                return await interaction.response.send_message(
                    embed=_white_embed("この操作にはサーバー管理権限が必要です。"), ephemeral=True)
            enabled = selected_action == "on"
            gid = str(interaction.guild_id)
            await interaction.response.defer(ephemeral=True)
            if self.db is not None:
                try:
                    await self._call(lambda: self.db.table("bump_rta_settings").upsert(
                        {"guild_id": gid, "notifications_enabled": enabled}, on_conflict="guild_id").execute())
                    if not enabled:
                        await self._call(lambda: self.db.table("bump_rta_reminders").update(
                            {"sent_at": discord.utils.utcnow().isoformat()}).eq("guild_id", gid).is_(
                            "sent_at", "null").execute())
                        await self._call(lambda: self.db.table("bump_rta_pending").delete().eq(
                            "guild_id", gid).execute())
                except Exception:
                    logger.exception("bump_rta settings update failed: guild=%s", gid)
                    return await interaction.followup.send(
                        embed=_white_embed("設定の保存に失敗しました。時間をおいて再度お試しください。"),
                        ephemeral=True)
            self._enabled_cache[gid] = enabled
            if not enabled:
                self._cancel_guild(interaction.guild_id)
            return await interaction.followup.send(
                embed=_white_embed(
                    f"bump/up通知とRTA計測を **{'オン' if enabled else 'オフ'}** にしました。"),
                ephemeral=True)
        return await interaction.response.send_message(
            embed=_white_embed("ランキングは `/leaderboard` から確認してください。"), ephemeral=True)
