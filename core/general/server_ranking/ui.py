# -*- coding: utf-8 -*-
"""サーバー対抗ランキングの Discord パネル。

EXPランキングと同じ対話型ボードの型: 期間切替（今日/7日/30日）と
ページングはボタン、盤面は白基調の画像。下部には自サーバーの順位と
「真上のサーバーまであと N pt」のライバル表示を固定で出す。
データはサーバー分析の日次集計（core/support/server_analytics）から
その場で集計する（収集していないサーバーは載らない）。
"""
from __future__ import annotations

import asyncio
import io
import logging
from datetime import datetime

import discord

from core.support import guild_settings
from core.support.panel_v2 import as_panel_v2, edit_panel_v2
from core.support.server_analytics import store as sa_store

from . import scoring
from .board import render_board_png

logger = logging.getLogger(__name__)

BOARD_FILENAME = "server_ranking_board.png"


async def _fetch_icon(guild) -> bytes | None:
    """サーバーアイコンの画像 bytes（無い・取れない場合は None=頭文字表示）。"""
    icon = getattr(guild, "icon", None)
    if icon is None:
        return None
    try:
        return await icon.read()
    except Exception:
        return None


class ServerRankingView(discord.ui.View):
    """サーバー対抗ランキングボード（公開表示・誰でも操作できる）。"""

    def __init__(self, guild_id: int, bot=None):
        super().__init__(timeout=300)
        self.guild_id = guild_id
        self.bot = bot
        self.period = "today"
        self.page = 0
        self._rows: list[dict] = []
        self._total_pages = 1
        self._names: dict[int, str] = {}
        self._icons: dict[int, bytes | None] = {}
        self._board_png: bytes | None = None
        self._own_text: str = ""
        self._opted_out = False
        self._sync_buttons()

    # --------------------------------------------------------------
    # データ
    # --------------------------------------------------------------
    async def _collect_rows(self) -> list[dict]:
        settings = guild_settings.get_store()
        await settings.ensure_loaded()
        sections = settings.all_sections(sa_store.SERVER_ANALYTICS_SECTION)
        opted_out = set()
        for gid, section in sections.items():
            if not sa_store.section_ranking_opted_out(section):
                continue
            try:
                opted_out.add(int(gid))
            except (TypeError, ValueError):
                continue
        self._opted_out = (
            self.guild_id is not None and int(self.guild_id) in opted_out)
        snapshots = sa_store.get_store().all_guild_snapshots()
        if self.bot is not None:
            # Bot が抜けたサーバーは名前・アイコンを表示できないため落とす
            # （順位の数え直しも含め、表示できるサーバーだけで競う）。
            snapshots = {
                gid: snap for gid, snap in snapshots.items()
                if self.bot.get_guild(gid) is not None
            }
        today = datetime.now(sa_store.JST).date()
        return scoring.build_rows(
            snapshots, period=self.period, today=today, opted_out=opted_out)

    async def _load_latest(self):
        self._rows = await self._collect_rows()
        page_rows, total, page = scoring.paginate(self._rows, self.page)
        self._total_pages = total
        self.page = page
        self._names = {}
        self._icons = {}
        if self.bot is not None:
            for row in page_rows:
                guild = self.bot.get_guild(row["guild_id"])
                if guild is None:
                    continue
                self._names[row["guild_id"]] = guild.name
                self._icons[row["guild_id"]] = await _fetch_icon(guild)
        top_points = self._rows[0]["points"] if self._rows else 0
        self._board_png = await asyncio.to_thread(
            render_board_png, page_rows, period=self.period, page=self.page,
            total_pages=self._total_pages, names=self._names,
            icons=self._icons, highlight_guild_id=self.guild_id,
            top_points=top_points)
        self._own_text = self._build_own_text()
        self._sync_buttons()

    def _build_own_text(self) -> str:
        label = scoring.PERIOD_LABELS.get(self.period, "今日")
        if self._opted_out:
            return (
                "このサーバーはランキングに参加していません。"
                "参加に戻すには、サーバー管理者が /support の「サーバー分析」"
                "から設定を変更してください。")
        info = scoring.rival_info(self._rows, self.guild_id) \
            if self.guild_id is not None else None
        if info is None:
            return (
                f"このサーバーは{label}のランキングにまだ載っていません。"
                "活動データが集まると自動で載ります。")
        if info["above_guild_id"] is None:
            return (f"このサーバー: **{info['rank']}位**"
                    f"（{info['points']:,} pt）— {label}の首位です。")
        above = self._rows[info["rank"] - 2]
        above_name = above.get("guild_id")
        guild = self.bot.get_guild(above_name) if self.bot is not None else None
        above_label = guild.name if guild is not None else "真上のサーバー"
        return (
            f"このサーバー: **{info['rank']}位**（{info['points']:,} pt）。"
            f"真上の {above_label} まであと **{info['gap']:,} pt**。")

    def board_file(self) -> discord.File:
        if self._board_png is None:
            page_rows, total, page = scoring.paginate(self._rows, self.page)
            self._total_pages = total
            self.page = page
            top_points = self._rows[0]["points"] if self._rows else 0
            self._board_png = render_board_png(
                page_rows, period=self.period, page=self.page,
                total_pages=self._total_pages, names=self._names,
                icons=self._icons, highlight_guild_id=self.guild_id,
                top_points=top_points)
            self._sync_buttons()
        return discord.File(io.BytesIO(self._board_png),
                            filename=BOARD_FILENAME)

    # --------------------------------------------------------------
    # 表示
    # --------------------------------------------------------------
    def embed(self) -> discord.Embed:
        label = scoring.PERIOD_LABELS.get(self.period, "今日")
        lines = [f"{label}の活動量で競うサーバー同士のランキング"
                 f"（全{len(self._rows)}サーバー）"]
        if self._own_text:
            lines.append(self._own_text)
        embed = discord.Embed(
            title="サーバー対抗ランキング",
            description="\n".join(lines),
            color=0x2091B2,
        )
        embed.set_image(url=f"attachment://{BOARD_FILENAME}")
        return embed

    # --------------------------------------------------------------
    # ボタン
    # --------------------------------------------------------------
    def _sync_buttons(self):
        self.clear_items()

        def add(label, row, active, callback, disabled=False):
            button = discord.ui.Button(
                label=label, row=row, disabled=disabled,
                style=(discord.ButtonStyle.primary if active
                       else discord.ButtonStyle.secondary))
            button.callback = callback
            self.add_item(button)

        for period, label in (("today", "今日"), ("week", "7日"),
                              ("month", "30日")):
            add(label, 0, self.period == period, self._make_period(period))
        add("更新", 0, False, self._refresh)
        add("◀", 1, False, self._make_page(-1), disabled=self.page <= 0)
        add("▶", 1, False, self._make_page(1),
            disabled=self.page >= self._total_pages - 1)

    async def _edit(self, interaction):
        await edit_panel_v2(interaction, as_panel_v2(self),
                            files=[self.board_file()])

    async def _reload_and_edit(self, interaction):
        if not interaction.response.is_done():
            await interaction.response.defer()
        await self._load_latest()
        await self._edit(interaction)

    def _make_period(self, period):
        async def callback(interaction: discord.Interaction):
            self.period = period
            self.page = 0
            await self._reload_and_edit(interaction)
        return callback

    def _make_page(self, delta):
        async def callback(interaction: discord.Interaction):
            self.page += delta
            await self._reload_and_edit(interaction)
        return callback

    async def _refresh(self, interaction: discord.Interaction):
        await self._reload_and_edit(interaction)
