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

from core.game.rta.common import *  # noqa: F401,F403 - shared constants/helpers
from core.game.rta.helpers import _white_embed  # noqa: F401

logger = logging.getLogger("cogs.disboard_rta")


class BumpRtaRoleView(discord.ui.View):
    """bump/up通知のメンションロール設定 (任意)。"""

    def __init__(self, cog, guild_id, current_role_id):
        super().__init__(timeout=300)
        self.cog = cog
        self.guild_id = guild_id
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

    async def _on_select(self, interaction: discord.Interaction):
        if not getattr(getattr(interaction.user, "guild_permissions", None), "manage_guild", False):
            return await interaction.response.send_message(
                embed=_white_embed("この操作にはサーバー管理権限が必要です。"), ephemeral=True)
        select = self.children[0]
        role = select.values[0] if select.values else None
        if role is not None and (role.is_default() or role.managed):
            return await interaction.response.send_message(
                embed=_white_embed("@everyone や連携サービス用のロールは指定できません。"), ephemeral=True)
        await interaction.response.defer(ephemeral=True)
        try:
            await self.cog._set_role_id(self.guild_id, role.id if role else None)
        except Exception:
            logger.exception("bump_rta role update failed: guild=%s", self.guild_id)
            return await interaction.followup.send(
                embed=_white_embed("設定の保存に失敗しました。時間をおいて再度お試しください。"),
                ephemeral=True)
        text = f"通知メンションロールを <@&{role.id}> にしました。" if role else "通知メンションロールを解除しました。"
        return await interaction.followup.send(embed=_white_embed(text), ephemeral=True)
