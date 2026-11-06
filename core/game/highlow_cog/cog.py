# -*- coding: utf-8 -*-
"""ハイ＆ロー（ソロ・ストリーク型）。

今見えているカードより、次にめくるカードが高いか低いかを当て続ける。
同点は外れ。連続正解数が記録（core/game/game_records.py の highlow）に残る。
賭け要素はない。
"""
import io
import random

import discord
from discord.ext import commands

from core.game import board_image, game_records
from core.game.board_image import render_cached, render_card_hand
from core.game.highlow import HighLowGame, card_label, rank_label

GAME_ID = "highlow"

_SUIT_TO_LETTER = {"♠": "S", "♥": "H", "♦": "D", "♣": "C"}
IMAGE_NAME = "highlow_cards.png"


def card_spec_of(card):
    """(ランク数値, スート記号) を描画基盤の正規形に変換する。"""
    rank, suit = card
    return board_image.card_spec(rank_label(rank), _SUIT_TO_LETTER[suit])


def state_file(game: HighLowGame, prev=None):
    """表示用カード画像の File。今のカード単体、結果表示時は 前→今 の2枚。"""
    specs = [card_spec_of(game.current)]
    if prev is not None and prev != game.current:
        specs = [card_spec_of(prev), card_spec_of(game.current)]
    key = ("highlow-cards", tuple(specs))
    data = render_cached(key, lambda: render_card_hand(specs, card_w=132))
    return discord.File(io.BytesIO(data), filename=IMAGE_NAME)


def game_embed(game: HighLowGame, user, status: str = "") -> discord.Embed:
    embed = discord.Embed(title="🃏 ハイ＆ロー", color=0xFFFFFF)
    desc = (f"<@{user.id}> の挑戦です。\n"
            f"今のカード: **{card_label(game.current)}**\n"
            f"連続正解: **{game.streak}回**／残りの山札: {game.remaining}枚")
    if status:
        desc += f"\n{status}"
    embed.description = desc
    embed.set_image(url=f"attachment://{IMAGE_NAME}")
    return embed


class HighLowView(discord.ui.View):
    def __init__(self, cog, owner, game: HighLowGame):
        super().__init__(timeout=600)
        self.cog = cog
        self.owner = owner
        self.game = game
        self.finished = False

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        if interaction.user.id != self.owner.id:
            await interaction.response.send_message("これは他の人の挑戦です。", ephemeral=True)
            return False
        return True

    @discord.ui.button(label="⬆ 高い", style=discord.ButtonStyle.primary)
    async def high(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self._guess(interaction, "high")

    @discord.ui.button(label="⬇ 低い", style=discord.ButtonStyle.primary)
    async def low(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self._guess(interaction, "low")

    @discord.ui.button(label="やめる", style=discord.ButtonStyle.secondary)
    async def quit(self, interaction: discord.Interaction, button: discord.ui.Button):
        if self.finished:
            return
        status = f"ここでやめました。連続正解は **{self.game.streak}回** でした。"
        await self._finish(interaction, status)

    async def _guess(self, interaction: discord.Interaction, direction: str):
        if self.finished:
            return await interaction.response.send_message("この挑戦は終わっています。", ephemeral=True)
        game = self.game
        prev = game.current
        correct = game.guess(direction)
        drawn = card_label(game.last_drawn)
        if game.cleared:
            status = f"{card_label(prev)} → **{drawn}** … 正解！\n🎉 山札を全部当て切りました！"
            return await self._finish(interaction, status, prev=prev)
        if not correct:
            status = f"{card_label(prev)} → **{drawn}** … 外れ。"
            if game.last_drawn and prev[0] == game.last_drawn[0]:
                status += "（同点は外れです）"
            status += f"\n連続正解 **{game.streak}回** で終了です。"
            return await self._finish(interaction, status, prev=prev)
        status = f"{card_label(prev)} → **{drawn}** … 正解！連続 **{game.streak}回**。次はこのカードより高い？低い？"
        await interaction.response.edit_message(
            embed=game_embed(game, self.owner, status), view=self,
            attachments=[state_file(game, prev)])

    async def _finish(self, interaction: discord.Interaction, status: str, prev=None):
        self.finished = True
        for child in self.children:
            child.disabled = True
        entry = game_records.record_highlow_safely(self.owner.id, self.game.streak)
        if entry is not None:
            status += "\n" + game_records.format_highlow_line(entry, self.game.streak)
        await interaction.response.edit_message(
            embed=game_embed(self.game, self.owner, status), view=self,
            attachments=[state_file(self.game, prev)])
        self.stop()


class HighLow(commands.Cog):
    def __init__(self, bot):
        self.bot = bot

    async def start_recruit(self, interaction: discord.Interaction):
        """/game のハブから呼ぶ。その場で1プレイ始まる。"""
        game = HighLowGame(rng=random.Random())
        embed = game_embed(game, interaction.user, "次のカードはこのカードより高い？低い？")
        await interaction.response.send_message(
            embed=embed, view=HighLowView(self, interaction.user, game),
            file=state_file(game))


async def setup(bot):
    await bot.add_cog(HighLow(bot))
