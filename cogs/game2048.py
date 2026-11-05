# -*- coding: utf-8 -*-
"""2048（ソロ・スコアアタック）。

4×4 の盤を方向ボタンでスライドさせ、同じ数字を合体させる。
2048 に到達しても続けられ、動けなくなったら終了。スコアと最大タイルは
core/game_records.py の g2048 に残る。
"""
import discord
from discord.ext import commands

from core import game_records
from core.game2048 import Game2048

GAME_ID = "game2048"


def game_embed(game: Game2048, user, status: str = "") -> discord.Embed:
    embed = discord.Embed(title="🔢 2048", color=0xFFFFFF)
    desc = (f"<@{user.id}> の盤面です。スコア: **{game.score}**／最大タイル: **{game.max_tile}**\n"
            f"```\n{game.text()}\n```")
    if status:
        desc += status
    embed.description = desc
    return embed


class Board2048View(discord.ui.View):
    def __init__(self, cog, owner):
        super().__init__(timeout=900)
        self.cog = cog
        self.owner = owner
        self.game = Game2048()
        self.finished = False

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        if interaction.user.id != self.owner.id:
            await interaction.response.send_message("これは他の人の盤面です。", ephemeral=True)
            return False
        return True

    @discord.ui.button(label="⬆", style=discord.ButtonStyle.primary, row=0)
    async def up(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self._move(interaction, "up")

    @discord.ui.button(label="⬅", style=discord.ButtonStyle.primary, row=1)
    async def left(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self._move(interaction, "left")

    @discord.ui.button(label="⬇", style=discord.ButtonStyle.primary, row=1)
    async def down(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self._move(interaction, "down")

    @discord.ui.button(label="➡", style=discord.ButtonStyle.primary, row=1)
    async def right(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self._move(interaction, "right")

    @discord.ui.button(label="終了する", style=discord.ButtonStyle.secondary, row=2)
    async def quit(self, interaction: discord.Interaction, button: discord.ui.Button):
        if not self.finished:
            await self._finish(interaction, "ここで終了しました。")

    async def _move(self, interaction: discord.Interaction, direction: str):
        if self.finished:
            return await interaction.response.send_message("この盤面は終わっています。", ephemeral=True)
        moved = self.game.move(direction)
        status = ""
        if not moved:
            status = "その方向には動かせません。"
        if self.game.won and not getattr(self, "_won_announced", False):
            self._won_announced = True
            status += "\n🎉 2048 に到達しました！このまま続けられます。"
        if self.game.game_over():
            return await self._finish(interaction, "もう動かせません。ゲームオーバーです。")
        await interaction.response.edit_message(embed=game_embed(self.game, self.owner, status), view=self)

    async def _finish(self, interaction: discord.Interaction, status: str):
        self.finished = True
        for child in self.children:
            child.disabled = True
        entry = game_records.record_2048_safely(self.owner.id, self.game.score, self.game.max_tile)
        if entry is not None:
            status += "\n" + game_records.format_2048_line(entry, self.game.score, self.game.max_tile)
        await interaction.response.edit_message(embed=game_embed(self.game, self.owner, status), view=self)
        self.stop()


class Game2048Cog(commands.Cog):
    def __init__(self, bot):
        self.bot = bot

    async def start_recruit(self, interaction: discord.Interaction):
        """/game のハブから呼ぶ。その場で盤面が始まる。"""
        view = Board2048View(self, interaction.user)
        await interaction.response.send_message(
            embed=game_embed(view.game, interaction.user, "方向ボタンでタイルをスライドさせてください。"),
            view=view)


async def setup(bot):
    await bot.add_cog(Game2048Cog(bot))
