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
from core.support.panel_v2 import as_embed_v2, as_panel_v2, edit_panel_v2

logger = logging.getLogger("cogs.disboard_rta")


class BumpRtaRoleView(discord.ui.View):
    """bump/up通知のメンションロール設定 (任意)。"""

    def __init__(self, cog, guild_id, current_role_id, embed=None):
        super().__init__(timeout=300)
        self.cog = cog
        self.guild_id = guild_id
        self._embed = embed
        select = discord.ui.RoleSelect(
            placeholder="メンションするロール",
            min_values=0,
            max_values=1,
            default_values=(
                [discord.SelectDefaultValue(id=current_role_id, type=discord.SelectDefaultValueType.role)]
                if current_role_id else []
            ),
        )
        select.callback = self._on_select
        self.add_item(select)

    def embed(self):
        return self._embed

    async def _on_select(self, interaction: discord.Interaction):
        if not getattr(getattr(interaction.user, "guild_permissions", None), "manage_guild", False):
            return await interaction.response.send_message(
                view=as_embed_v2(_white_embed("この操作にはサーバー管理権限が必要です。")), ephemeral=True)
        select = self.children[0]
        role = select.values[0] if select.values else None
        if role is not None and (role.is_default() or role.managed):
            return await interaction.response.send_message(
                view=as_embed_v2(_white_embed("@everyone や連携サービス用のロールは指定できません。")), ephemeral=True)
        await interaction.response.defer(ephemeral=True)
        try:
            await self.cog._set_role_id(self.guild_id, role.id if role else None)
        except Exception:
            logger.exception("bump_rta role update failed: guild=%s", self.guild_id)
            return await interaction.followup.send(
                view=as_embed_v2(_white_embed("設定の保存に失敗しました。時間をおいて再度お試しください。")),
                ephemeral=True)
        text = f"通知メンションロールを <@&{role.id}> にしました。" if role else "通知メンションロールを解除しました。"
        return await interaction.followup.send(view=as_embed_v2(_white_embed(text)), ephemeral=True)


class RtaBoardView(discord.ui.View):
    """boardNotify RTA の統合ボード（公開表示・誰でも切り替えできる）。

    旧 /general の bump/up 個別ボード8件を1枚に統合したもの。サービス
    （7種）× 最速/最遅 × スコープ（このサーバー / 全サーバー / 自分）を
    ボード内で切り替える。取得・描画は BumpRta.build_rta_board に委譲し、
    画像は共有レンダラ（core/leaderboard_image.py）の白基調ボードを使う。
    EXP ランキング（ExpRankingView）と同じ「状態を持って再描画」方式。
    """

    def __init__(self, cog, guild_id, user_id, user_name, *,
                 event_type: str = "bump", scope: str = "local", slowest: bool = False):
        super().__init__(timeout=300)
        self.cog = cog
        self.guild_id = guild_id
        self.user_id = user_id
        self.user_name = user_name
        self.event_type = event_type
        self.scope = scope
        self.slowest = slowest
        self._embed = None
        self._png = None
        self._sync()

    async def load(self):
        """現在の状態でボードを取得する（失敗時は失敗文面のみの embed）。"""
        try:
            self._embed, self._png = await self.cog.build_rta_board(
                self.event_type, self.scope, self.slowest,
                guild_id=self.guild_id, user_id=self.user_id,
                user_name=self.user_name)
        except Exception:
            logger.exception(
                "rta board load failed: type=%s scope=%s slowest=%s",
                self.event_type, self.scope, self.slowest)
            self._embed = _white_embed("ランキングの取得に失敗しました。")
            self._png = None

    def embed(self):
        return self._embed

    def files(self):
        if self._png is None:
            return []
        return [discord.File(io.BytesIO(self._png), filename=RTA_BOARD_FILENAME)]

    # --------------------------------------------------------------
    # 部品（サービス=セレクト、最速/最遅・スコープ=トグルボタン）
    # --------------------------------------------------------------
    def _sync(self):
        self.clear_items()
        select = discord.ui.Select(
            placeholder="サービス",
            options=[
                discord.SelectOption(
                    label=SERVICE_LABELS[event_type], value=event_type,
                    default=event_type == self.event_type)
                for event_type in RTA_SERVICE_TYPES
            ],
            row=0,
        )
        select.callback = self._on_service
        self._service_select = select
        self.add_item(select)

        def add(label, row, active, callback):
            button = discord.ui.Button(
                label=label, row=row,
                style=(discord.ButtonStyle.primary if active
                       else discord.ButtonStyle.secondary))
            button.callback = callback
            self.add_item(button)

        add("最速", 1, not self.slowest, self._make_speed(False))
        add("最遅", 1, self.slowest, self._make_speed(True))
        add("このサーバー", 2, self.scope == "local", self._make_scope("local"))
        add("全サーバー", 2, self.scope == "global", self._make_scope("global"))
        add("自分", 2, self.scope == "me", self._make_scope("me"))

    async def _reload(self, interaction: discord.Interaction):
        # 「自分」スコープは押した人の記録を出す（EXP ボードの自分の順位と同じ）。
        self.user_id = interaction.user.id
        self.user_name = interaction.user.display_name
        if not interaction.response.is_done():
            await interaction.response.defer()
        await self.load()
        self._sync()
        await edit_panel_v2(interaction, as_panel_v2(self), files=self.files())

    async def _on_service(self, interaction: discord.Interaction):
        self.event_type = self._service_select.values[0]
        await self._reload(interaction)

    def _make_speed(self, slowest: bool):
        async def callback(interaction: discord.Interaction):
            self.slowest = slowest
            await self._reload(interaction)
        return callback

    def _make_scope(self, scope: str):
        async def callback(interaction: discord.Interaction):
            self.scope = scope
            await self._reload(interaction)
        return callback
