import asyncio
import io
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
from core.support.api_retry import run_with_retry

from core.game.rta.common import *  # noqa: F401,F403 - shared constants/helpers
from core.game.rta.helpers import _white_embed  # noqa: F401
from core.support.panel_v2 import as_embed_v2, wrap_panel_view
from core.general.user_names import resolve_display_names
from core.game.rta.views import BumpRtaRoleView  # noqa: F401
from core.leaderboard_image import (
    BoardRow, fetch_avatar_bytes, render_leaderboard_png,
)

RTA_BOARD_FILENAME = "rta_leaderboard.png"

logger = logging.getLogger("cogs.disboard_rta")


class SettingsMixin:
    # Web ダッシュボードからも bump_rta_settings を書き換えるため、キャッシュは
    # 60秒で失効させて再読込する（GuildSettings の TTL と同じ考え方）。
    SETTINGS_CACHE_TTL_SECONDS = 60.0

    async def _call(self, fn):
        return await asyncio.get_running_loop().run_in_executor(
            self._executor, lambda: run_with_retry(fn)
        )


    def _cache_get(self, cache, gid):
        """(ヒットしたか, 値)。キャッシュ値は (値, time.monotonic()) のタプル。"""
        entry = cache.get(gid)
        if entry is None:
            return False, None
        if not (isinstance(entry, tuple) and len(entry) == 2):
            return True, entry  # 旧形式（生の値）が直接書かれていた場合はそのまま使う
        value, stored_at = entry
        if time.monotonic() - stored_at > self.SETTINGS_CACHE_TTL_SECONDS:
            return False, None
        return True, value

    def _cache_put(self, cache, gid, value):
        cache[gid] = (value, time.monotonic())

    def _enabled_cached(self, guild_id):
        """送信直前チェック用の同期読み（I/O なし）。最後に知った値を返し、
        未取得なら既定の有効(True)。TTL 失効は非同期側の再読込に任せる。"""
        entry = self._enabled_cache.get(str(guild_id))
        if entry is None:
            return True
        if isinstance(entry, tuple) and len(entry) == 2:
            return bool(entry[0])
        return bool(entry)

    async def _is_enabled(self, guild_id):
        gid = str(guild_id)
        hit, cached = self._cache_get(self._enabled_cache, gid)
        if hit:
            return cached
        if self.db is None:
            return True
        try:
            result = await self._call(lambda: self.db.table("bump_rta_settings").select(
                "notifications_enabled").eq("guild_id", gid).limit(1).execute())
            enabled = bool(result.data[0]["notifications_enabled"]) if result.data else True
            self._cache_put(self._enabled_cache, gid, enabled)
            return enabled
        except Exception:
            logger.exception("bump_rta_settings read failed; using default enabled state: guild=%s", gid)
            return True


    async def _role_id(self, guild_id):
        """通知時にメンションするロールID (任意設定・未設定/取得失敗時は None)。"""
        gid = str(guild_id)
        hit, cached = self._cache_get(self._role_cache, gid)
        if hit:
            return cached
        if self.db is None:
            return None
        try:
            result = await self._call(lambda: self.db.table("bump_rta_settings").select(
                "role_id").eq("guild_id", gid).limit(1).execute())
            raw = result.data[0].get("role_id") if result.data else None
            role_id = int(raw) if raw is not None and str(raw).isdigit() else None
            self._cache_put(self._role_cache, gid, role_id)
            return role_id
        except Exception:
            logger.debug("bump_rta_settings role read failed: guild=%s", gid, exc_info=True)
            return None


    async def _set_role_id(self, guild_id, role_id):
        gid = str(guild_id)
        self._cache_put(self._role_cache, gid, role_id)
        if self.db is None:
            return
        await self._call(lambda: self.db.table("bump_rta_settings").upsert(
            {"guild_id": gid, "role_id": str(role_id) if role_id else None},
            on_conflict="guild_id").execute())


    async def leaderboard(self, interaction: discord.Interaction, event_type: str = "bump", scope: str = "local", slowest: bool = False):
        """/leaderboard から呼び出す bump/up RTA ランキング。

        slowest=True のときは同じ指標（実行可能になってから実際に実行する
        までの経過時間）を降順に並べた「最遅ランキング」を出す。最速側の
        記録（bump_rta_records）とは別テーブル bump_rta_worst_records を
        読み、最速ボードの意味は変えない。
        """
        if self.db is None:
            return await interaction.followup.send(
                embed=_white_embed("Supabase未接続のため順位を取得できません。"), ephemeral=True)
        try:
            if scope == "me":
                uid, gid = str(interaction.user.id), str(interaction.guild_id)
                record_table = "bump_rta_worst_records" if slowest else "bump_rta_records"
                local = await self._call(lambda: self.db.table(record_table).select(
                    "elapsed_ms,completed_at").eq("guild_id", gid).eq("user_id", uid).eq("event_type", event_type).order(
                        "elapsed_ms", desc=slowest).limit(1).execute())
                global_best = await self._call(lambda: self.db.table("bump_rta_events").select(
                    "elapsed_ms,completed_at").eq("user_id", uid).eq("event_type", event_type).order("elapsed_ms", desc=slowest).limit(1).execute())
                local_text = f"{local.data[0]['elapsed_ms'] / 1000:.2f}秒" if local.data else "記録なし"
                global_text = f"{global_best.data[0]['elapsed_ms'] / 1000:.2f}秒" if global_best.data else "記録なし"
                label = "最遅記録" if slowest else "自己ベスト"
                return await interaction.followup.send(
                    embed=_white_embed(
                        f"{interaction.user.display_name} の**{event_type}{label}**\nこのサーバー: **{local_text}**\n全サーバー: **{global_text}**"),
                    allowed_mentions=discord.AllowedMentions.none(),
                )
            # ランキングの氏名はメンションではなく通常表記にする（特に全サーバー
            # ランキングはサーバー外ユーザーのメンションが「不明のユーザー」になる）。
            bot = getattr(self, "bot", None)
            if scope == "global":
                rpc_name = "get_bump_rta_global_slowest_ranking" if slowest else "get_bump_rta_global_ranking"
                rows = await self._call(lambda: self.db.rpc(rpc_name, {
                    "p_event_type": event_type, "p_limit": 10}).execute())
                data = rows.data or []
                title = f"全サーバー {event_type} {'最遅ランキング' if slowest else 'RTAランキング'}"
            else:
                record_table = "bump_rta_worst_records" if slowest else "bump_rta_records"
                rows = await self._call(lambda: self.db.table(record_table).select(
                    "user_id,elapsed_ms,completed_at").eq("guild_id", str(interaction.guild_id)).eq(
                    "event_type", event_type).order("elapsed_ms", desc=slowest).limit(10).execute())
                data = rows.data or []
                title = f"このサーバー {event_type} {'最遅ランキング' if slowest else 'RTAランキング'}"
            if not data:
                return await interaction.followup.send(
                    embed=_white_embed(f"**{title}**\nまだ記録がありません。"),
                    allowed_mentions=discord.AllowedMentions.none(),
                )
            names = await resolve_display_names(bot, [r["user_id"] for r in data])
            board_rows = []
            for r in data:
                board_rows.append(BoardRow(
                    user_id=int(r["user_id"]),
                    name=names.get(int(r["user_id"]), ""),
                    value=f"{r['elapsed_ms'] / 1000:.2f}秒",
                    sub=(f"{r['attempts']}回" if scope == "global"
                         and r.get("attempts") is not None else "")))
            avatars = await fetch_avatar_bytes(
                bot, [row.user_id for row in board_rows])
            accent = (37, 99, 235) if event_type == "bump" else (147, 51, 234)
            png = await asyncio.to_thread(
                render_leaderboard_png,
                title=title, sections=[(None, board_rows)], accent=accent,
                avatars=avatars,
                cache_namespace=f"rta-{event_type}-{scope}")
            embed = discord.Embed(title=title, color=0xFFFFFF)
            embed.set_image(url=f"attachment://{RTA_BOARD_FILENAME}")
            return await interaction.followup.send(
                embed=embed,
                file=discord.File(io.BytesIO(png), filename=RTA_BOARD_FILENAME),
                allowed_mentions=discord.AllowedMentions.none(),
            )
        except Exception as e:
            logger.exception("bump/up leaderboard query failed: scope=%s kind=%s", scope, event_type)
            return await interaction.followup.send(
                view=as_embed_v2(_white_embed(f"ランキングの取得に失敗しました。\n（{type(e).__name__}: {e}）")))


    async def bumprta_command(
        self,
        interaction: discord.Interaction,
        action: app_commands.Choice[str],
    ):
        if interaction.guild_id is None:
            return await interaction.response.send_message(
                view=as_embed_v2(_white_embed("このコマンドはサーバー内でのみ使えます。")), ephemeral=True)
        selected_action = action.value
        if selected_action == "status":
            enabled = await self._is_enabled(interaction.guild_id)
            role_id = await self._role_id(interaction.guild_id)
            role_text = f"<@&{role_id}>" if role_id else "なし"
            return await interaction.response.send_message(
                view=as_embed_v2(_white_embed(
                    f"boardNotify: **{'オン' if enabled else 'オフ'}**（初期状態: オン）"
                    f"\n通知メンションロール: {role_text}")),
                ephemeral=True)
        if selected_action == "role":
            if not getattr(getattr(interaction.user, "guild_permissions", None), "manage_guild", False):
                return await interaction.response.send_message(
                    view=as_embed_v2(_white_embed("この操作にはサーバー管理権限が必要です。")), ephemeral=True)
            current_role = await self._role_id(interaction.guild_id)
            return await interaction.response.send_message(
                view=wrap_panel_view(BumpRtaRoleView(
                    self, interaction.guild_id, current_role,
                    embed=_white_embed("通知時にメンションするロールを選んでください（選択を外すと解除）。"))),
                ephemeral=True)
        if selected_action in {"on", "off"}:
            if not getattr(getattr(interaction.user, "guild_permissions", None), "manage_guild", False):
                return await interaction.response.send_message(
                    view=as_embed_v2(_white_embed("この操作にはサーバー管理権限が必要です。")), ephemeral=True)
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
                        view=as_embed_v2(_white_embed("設定の保存に失敗しました。時間をおいて再度お試しください。")),
                        ephemeral=True)
            self._cache_put(self._enabled_cache, gid, enabled)
            if not enabled:
                self._cancel_guild(interaction.guild_id)
            return await interaction.followup.send(
                view=as_embed_v2(_white_embed(
                    f"boardNotifyを **{'オン' if enabled else 'オフ'}** にしました。")),
                ephemeral=True)
        return await interaction.response.send_message(
            view=as_embed_v2(_white_embed("ランキングは `/leaderboard` から確認してください。")), ephemeral=True)
