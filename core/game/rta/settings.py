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

logger = logging.getLogger("cogs.disboard_rta")

# 統合ボードのアクセント色（全サービス一括のため単色）。
RTA_BOARD_ACCENT = (37, 99, 235)


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


    def _rta_board_title(self, scope: str, slowest: bool) -> str:
        kind = "最遅ランキング" if slowest else "RTAランキング"
        if scope == "global":
            return f"全サーバー {kind}"
        return f"このサーバー {kind}"

    async def _rta_ranking_rows(self, scope: str, slowest: bool, guild_id):
        """local / global スコープの (表題, 行データ) を取得する。

        ランキングの行は「ユーザー × サービス種類」のエントリ単位:
        同じユーザーが bump と up の記録を持てば両方の行が載る。
        最速ボードは記録テーブル（bump_rta_records）の全行、最遅ボードは
        bump_rta_worst_records の全行を、そのまま pooled で並べる。
        local はギルド分を読み、global は events を (user_id, event_type)
        で集計する統合 RPC を使う。legacy（分離前の混在履歴）はサービス
        ではないためエントリにしない。
        """
        title = self._rta_board_title(scope, slowest)
        if scope == "global":
            rpc_name = ("get_bump_rta_global_combined_slowest_ranking" if slowest
                        else "get_bump_rta_global_combined_ranking")
            rows = await self._call(lambda: self.db.rpc(rpc_name, {
                "p_limit": 10}).execute())
            return title, rows.data or []
        record_table = "bump_rta_worst_records" if slowest else "bump_rta_records"
        rows = await self._call(lambda: self.db.table(record_table).select(
            "user_id,event_type,elapsed_ms,completed_at").eq(
            "guild_id", str(guild_id)).order(
            "elapsed_ms", desc=slowest).limit(10000).execute())
        data = [r for r in rows.data or []
                if r.get("event_type") in SERVICE_LABELS]
        data.sort(key=lambda r: int(r["elapsed_ms"]), reverse=slowest)
        return title, data[:10]

    async def _rta_me_embed(self, slowest: bool, guild_id, user_id, user_name):
        """me スコープ: 自分の種類別エントリ（このサーバー / 全サーバー）。

        サービスごとに、このサーバーでの記録（記録テーブルの自分の行）と
        全サーバーでの記録（events を種類別に集計した最小 / 最大）を並べる。
        """
        uid, gid = str(user_id), str(guild_id)
        record_table = "bump_rta_worst_records" if slowest else "bump_rta_records"
        local_rows = await self._call(lambda: self.db.table(record_table).select(
            "event_type,elapsed_ms").eq("guild_id", gid).eq(
            "user_id", uid).limit(100).execute())
        event_rows = await self._call(lambda: self.db.table("bump_rta_events").select(
            "event_type,elapsed_ms").eq("user_id", uid).limit(10000).execute())
        local_by_type = {
            str(r["event_type"]): int(r["elapsed_ms"])
            for r in local_rows.data or []
            if r.get("event_type") in SERVICE_LABELS}
        global_by_type: dict[str, int] = {}
        for r in event_rows.data or []:
            event_type = r.get("event_type")
            if event_type not in SERVICE_LABELS:
                continue
            elapsed = int(r["elapsed_ms"])
            current = global_by_type.get(str(event_type))
            if current is None or (elapsed > current if slowest
                                    else elapsed < current):
                global_by_type[str(event_type)] = elapsed

        def fmt(by_type, event_type):
            if event_type not in by_type:
                return "記録なし"
            return f"**{by_type[event_type] / 1000:.2f}秒**"

        label = "最遅記録" if slowest else "自己ベスト"
        lines = [f"{user_name} の**{label}**"]
        shown = [t for t in RTA_SERVICE_TYPES
                 if t in local_by_type or t in global_by_type]
        if not shown:
            lines.append("まだ記録がありません。")
        for event_type in shown:
            lines.append(
                f"{SERVICE_LABELS[event_type]}: "
                f"このサーバー {fmt(local_by_type, event_type)} / "
                f"全サーバー {fmt(global_by_type, event_type)}")
        return _white_embed("\n".join(lines))

    async def build_rta_board(self, scope: str = "local", slowest: bool = False, *, guild_id, user_id, user_name):
        """RTA ボードの (embed, png) を組み立てる。

        png は画像ボードのときだけ返し、me スコープ・記録なし・DB 未接続は
        テキスト embed のみ（png=None）。記録が無いスコープでも
        例外にせず空ボード（テキスト）を返す。DB エラーは呼び出し側へ上げる。
        """
        if self.db is None:
            return _white_embed("Supabase未接続のため順位を取得できません。"), None
        if scope == "me":
            return await self._rta_me_embed(
                slowest, guild_id, user_id, user_name), None
        title, data = await self._rta_ranking_rows(scope, slowest, guild_id)
        if not data:
            return _white_embed(f"**{title}**\nまだ記録がありません。"), None
        # ランキングの氏名はメンションではなく通常表記にする（特に全サーバー
        # ランキングはサーバー外ユーザーのメンションが「不明のユーザー」になる）。
        bot = getattr(self, "bot", None)
        names = await resolve_display_names(
            bot, list({r["user_id"] for r in data}))
        board_rows = []
        for r in data:
            # 行は (ユーザー, サービス) エントリ。サービス名は名前脇の
            # 補助テキスト (sub) に併記し、global は従来の試行回数も足す。
            service_label = SERVICE_LABELS.get(
                r.get("event_type"), str(r.get("event_type") or ""))
            sub = service_label
            if scope == "global" and r.get("attempts") is not None:
                sub = (f"{service_label} ・ {r['attempts']}回"
                       if service_label else f"{r['attempts']}回")
            board_rows.append(BoardRow(
                user_id=int(r["user_id"]),
                name=names.get(int(r["user_id"]), ""),
                value=f"{r['elapsed_ms'] / 1000:.2f}秒",
                sub=sub))
        avatars = await fetch_avatar_bytes(
            bot, [row.user_id for row in board_rows])
        png = await asyncio.to_thread(
            render_leaderboard_png,
            title=title, sections=[(None, board_rows)],
            accent=RTA_BOARD_ACCENT,
            avatars=avatars,
            cache_namespace=f"rta-all-{scope}-{'slow' if slowest else 'fast'}")
        embed = discord.Embed(title=title, color=0xFFFFFF)
        embed.set_image(url=f"attachment://{RTA_BOARD_FILENAME}")
        return embed, png

    async def leaderboard(self, interaction: discord.Interaction, scope: str = "local", slowest: bool = False):
        """/leaderboard から呼び出す bump/up RTA ランキング（全サービス統合）。

        slowest=True のときは同じ指標（実行可能になってから実際に実行する
        までの経過時間）を降順に並べた「最遅ランキング」を出す。最速側の
        記録（bump_rta_records）とは別テーブル bump_rta_worst_records を
        読み、最速ボードの意味は変えない。描画は build_rta_board と共通。
        """
        if self.db is None:
            return await interaction.followup.send(
                embed=_white_embed("Supabase未接続のため順位を取得できません。"), ephemeral=True)
        try:
            embed, png = await self.build_rta_board(
                scope, slowest,
                guild_id=interaction.guild_id, user_id=interaction.user.id,
                user_name=interaction.user.display_name)
        except Exception as e:
            logger.exception("bump/up leaderboard query failed: scope=%s", scope)
            return await interaction.followup.send(
                view=as_embed_v2(_white_embed(f"ランキングの取得に失敗しました。\n（{type(e).__name__}: {e}）")))
        if png is None:
            return await interaction.followup.send(
                embed=embed, allowed_mentions=discord.AllowedMentions.none())
        return await interaction.followup.send(
            embed=embed,
            file=discord.File(io.BytesIO(png), filename=RTA_BOARD_FILENAME),
            allowed_mentions=discord.AllowedMentions.none(),
        )


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
