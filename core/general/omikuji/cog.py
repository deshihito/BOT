# -*- coding: utf-8 -*-
"""おみくじの Cog：メッセージ発動と /general パネルの入口。

- メッセージ発動：日本語設定（locale=ja）のサーバーで、通常発言に
  「おみくじ」が含まれていればその人の今日のおみくじを引く。
  Bot・Webhook・DM は対象外（常駐しりとり/今北産業と同じ作法）。
- パネル：/general の dispatch から呼ばれ、言語設定に関係なく引ける。
- 結果は1日1回（ユーザー×ギルド、JST日次）で固定。再表示には短い
  クールダウンを付け、連投による再投稿を抑える。ただし回数制限の
  対象外ユーザー（store.UNLIMITED_USER_IDS）は毎回新規抽選で、
  クールダウンも適用しない。
- 投稿は公開（ephemeral 既定公開ポリシー通り）。経済には接続しない。
"""
from __future__ import annotations

import asyncio
import io
import logging
import time

import discord
from discord.ext import commands

from core.support.localization.localization import guild_locale

from .render import render_omikuji_png
from .store import OmikujiStore, is_unlimited_user

logger = logging.getLogger("cogs.omikuji")

TRIGGER_PHRASE = "おみくじ"
COOLDOWN_SECONDS = 30


class OmikujiCog(commands.Cog):
    def __init__(self, bot: commands.Bot, store: OmikujiStore | None = None,
                 clock=time.monotonic):
        self.bot = bot
        self.store = store or OmikujiStore()
        self.clock = clock
        self._last_posted: dict[tuple[int, int], float] = {}
        self._locks: dict[tuple[int, int], asyncio.Lock] = {}

    # --------------------------------------------------------------
    # 共通処理
    # --------------------------------------------------------------
    def _cooldown_left(self, guild_id: int, user_id: int) -> float:
        last = self._last_posted.get((guild_id, user_id))
        if last is None:
            return 0.0
        return COOLDOWN_SECONDS - (self.clock() - last)

    async def _build_file(self, guild_id: int, user_id: int) -> discord.File:
        fortune, _created = self.store.get_or_draw(guild_id, user_id)
        data = render_omikuji_png(fortune)
        return discord.File(io.BytesIO(data), filename="omikuji.png")

    # --------------------------------------------------------------
    # メッセージ発動
    # --------------------------------------------------------------
    @commands.Cog.listener()
    async def on_message(self, message: discord.Message):
        if getattr(message, "guild", None) is None:
            return
        author = getattr(message, "author", None)
        if getattr(author, "bot", False):
            return
        if getattr(message, "webhook_id", None) is not None:
            return
        if TRIGGER_PHRASE not in (getattr(message, "content", "") or ""):
            return
        # おみくじの文面と画像は日本語固定のため、日本語設定のサーバー
        # でのみ発動する（今北産業と同じ判定）。
        if guild_locale(message.guild.id) != "ja":
            return

        key = (message.guild.id, author.id)
        lock = self._locks.setdefault(key, asyncio.Lock())
        if lock.locked():
            return
        # 回数制限の対象外ユーザーはクールダウンも対象外（毎回新規抽選）。
        unlimited = is_unlimited_user(author.id)
        async with lock:
            if not unlimited and self._cooldown_left(*key) > 0:
                return
            if not unlimited:
                self._last_posted[key] = self.clock()
            try:
                file = await self._build_file(*key)
            except ImportError:
                logger.warning("omikuji: 画像生成ライブラリが利用できません")
                return
            except Exception:
                logger.exception("omikuji: 画像の生成に失敗しました")
                return
            try:
                await message.reply(file=file, mention_author=False)
            except discord.HTTPException:
                logger.exception("omikuji: 結果を投稿できませんでした")

    # --------------------------------------------------------------
    # /general パネル
    # --------------------------------------------------------------
    async def open_panel(self, interaction: discord.Interaction):
        """パネルから引く（言語設定に関係なく引ける）。結果は公開投稿。"""
        guild_id = interaction.guild_id
        user = interaction.user
        if guild_id is None:
            return await interaction.response.send_message(
                "サーバー内でのみ使えます。", ephemeral=True)
        key = (guild_id, user.id)
        lock = self._locks.setdefault(key, asyncio.Lock())
        if lock.locked():
            return await interaction.response.send_message(
                "今日のおみくじを表示しています。", ephemeral=True)
        # 回数制限の対象外ユーザーはクールダウンも対象外（毎回新規抽選）。
        unlimited = is_unlimited_user(user.id)
        async with lock:
            if not unlimited and self._cooldown_left(*key) > 0:
                return await interaction.response.send_message(
                    "今日のおみくじは表示済みです（結果は一日同じです）。",
                    ephemeral=True)
            if not unlimited:
                self._last_posted[key] = self.clock()
            try:
                file = await self._build_file(*key)
            except ImportError:
                return await interaction.response.send_message(
                    "画像生成ライブラリが利用できません。", ephemeral=True)
            except Exception:
                logger.exception("omikuji: 画像の生成に失敗しました")
                return await interaction.response.send_message(
                    "画像を作れませんでした。", ephemeral=True)
            await interaction.response.send_message(
                content=f"{user.display_name} のおみくじ", file=file)


async def setup(bot: commands.Bot):
    await bot.add_cog(OmikujiCog(bot))
