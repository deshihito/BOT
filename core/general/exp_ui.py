# -*- coding: utf-8 -*-
"""EXP ステータス/ランキングの UI。元 cogs/general.py から分割。"""
from __future__ import annotations

from .common import *
from .exp import (
    _as_int, _exp_ensure, _exp_load, _exp_root, general_level, level_from_exp,
)

class ExpStatusView(discord.ui.View):
    def __init__(self, author_id: int, guild_id: int):
        super().__init__(timeout=300)
        self.author_id, self.guild_id = author_id, guild_id
        self._user_cache = _exp_ensure(_exp_root(), self.guild_id, self.author_id)

    async def _load_latest(self):
        data = await _exp_load()
        self._user_cache = _exp_ensure(data, self.guild_id, self.author_id)

    @staticmethod
    def _bar(cur: int, need: int, width: int = 12) -> str:
        if need <= 0:
            return "█" * width
        filled = min(width, int(width * cur / need))
        return "█" * filled + "░" * (width - filled)

    def embed(self) -> discord.Embed:
        chat_exp = _as_int(self._user_cache.get("chat_exp"))
        vc_exp = _as_int(self._user_cache.get("vc_exp"))
        cl, ccur, cneed = level_from_exp(chat_exp, CHAT_EXP_BASE, CHAT_EXP_RATIO)
        vl, vcur, vneed = level_from_exp(vc_exp, VC_EXP_BASE, VC_EXP_RATIO)
        gl = general_level(chat_exp, vc_exp)
        return discord.Embed(
            title="EXP状況",
            description=(
                f"**general Lv.{gl}**\n\n"
                f"**チャット** Lv.{cl} — {ccur}/{cneed} EXP\n"
                f"`{self._bar(ccur, cneed)}`\n\n"
                f"**VC** Lv.{vl} — {vcur}/{vneed} EXP\n"
                f"`{self._bar(vcur, vneed)}`"
            ),
            color=0x3498DB,
        )


class ExpRankingView(discord.ui.View):
    def __init__(self, guild_id: int):
        super().__init__(timeout=300)
        self.guild_id = guild_id
        self._data_cache = _exp_root()

    async def _load_latest(self):
        self._data_cache = await _exp_load()

    def embed(self) -> discord.Embed:
        guild = self._data_cache.get(str(self.guild_id), {})
        rows = []
        for uid, u in guild.items():
            chat_exp = _as_int(u.get("chat_exp"))
            vc_exp = _as_int(u.get("vc_exp"))
            gl = general_level(chat_exp, vc_exp)
            rows.append((gl, chat_exp, vc_exp, uid))
        rows.sort(key=lambda x: (x[0], x[1] + x[2]), reverse=True)
        lines = []
        for i, (gl, ce, ve, uid) in enumerate(rows[:20], start=1):
            lines.append(f"`{i:>2}.` <@{uid}> — general Lv.{gl}（chat {ce} / vc {ve}）")
        return discord.Embed(
            title="EXPランキング（general順）",
            description="\n".join(lines) or "まだEXPデータがありません。",
            color=0x9B59B6,
        )

    @discord.ui.button(label="更新", style=discord.ButtonStyle.secondary, row=0)
    async def refresh_btn(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self._load_latest()
        await edit_panel_v2(interaction, as_panel_v2(self))
