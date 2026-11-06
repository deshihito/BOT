# -*- coding: utf-8 -*-
"""2048（ソロ・スコアアタック）。

4×4 の盤を方向ボタンでスライドさせ、同じ数字を合体させる。
2048 に到達しても続けられ、動けなくなったら終了。スコアと最大タイルは
core/game/game_records.py の g2048 に残る。

盤面画像化タスク（2026-11-06）: 盤面はテキストではなく PIL 画像
（core/game/board_image.render_2048）で表示し、パネルは Components V2
（GamePanelView + MediaGallery）にした。方向ボタンは操作系なので従来
どおりボタンで維持し、ロジック・記録は不変。
"""
import io

import discord
from discord.ext import commands

from core.game import game_records
from core.game.board_image import render_2048, render_cached
from core.game.game2048 import Game2048
from core.game.game_v2 import GamePanelView
from core.panel_v2 import edit_panel_v2

GAME_ID = "game2048"


def game_embed(game: Game2048, user, status: str = "") -> discord.Embed:
    """互換用に残す旧 embed 生成（現在の表示は V2 パネル＋画像）。"""
    embed = discord.Embed(title="🔢 2048", color=0xFFFFFF)
    desc = (f"<@{user.id}> の盤面です。スコア: **{game.score}**／最大タイル: **{game.max_tile}**\n"
            f"```\n{game.text()}\n```")
    if status:
        desc += status
    embed.description = desc
    return embed


def board_png(game: Game2048) -> bytes:
    key = ("2048", tuple(tuple(row) for row in game.board))
    return render_cached(key, lambda: render_2048(game.board))


def board_file(game: Game2048) -> discord.File:
    return discord.File(io.BytesIO(board_png(game)), "board.png")


class Board2048View(GamePanelView):
    def __init__(self, cog, owner):
        super().__init__(timeout=900)
        self.cog = cog
        self.owner = owner
        self.game = Game2048()
        self.finished = False
        self.status = "方向ボタンでタイルをスライドさせてください。"
        self.add_extra(discord.ui.MediaGallery(discord.MediaGalleryItem("attachment://board.png")))
        self._render()

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        if interaction.user.id != self.owner.id:
            await interaction.response.send_message("これは他の人の盤面です。", ephemeral=True)
            return False
        # 盤面再描画の連打制限 (E-16, GamePanelView の共通クールダウン)。
        return await super().interaction_check(interaction)

    def _render(self):
        game = self.game
        body = (f"<@{self.owner.id}> の盤面です。スコア: **{game.score}**／最大タイル: **{game.max_tile}**")
        if self.status:
            body += f"\n{self.status}"
        self.set_content("🔢 2048", body)
        self.clear_rows()
        if self.finished:
            return
        def dir_button(label, direction):
            btn = discord.ui.Button(label=label, style=discord.ButtonStyle.primary)

            async def on_click(inter: discord.Interaction, _dir=direction):
                await self._move(inter, _dir)

            btn.callback = on_click
            return btn

        self.add_row(dir_button("⬆", "up"))
        self.add_row(dir_button("⬅", "left"), dir_button("⬇", "down"), dir_button("➡", "right"))
        quit_btn = discord.ui.Button(label="終了する", style=discord.ButtonStyle.secondary)
        quit_btn.callback = self._quit_callback
        self.add_row(quit_btn)

    async def _quit_callback(self, interaction: discord.Interaction):
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
        self.status = status
        if self.game.game_over():
            return await self._finish(interaction, "もう動かせません。ゲームオーバーです。")
        self._render()
        await edit_panel_v2(interaction, self, files=[board_file(self.game)])

    async def _finish(self, interaction: discord.Interaction, status: str):
        self.finished = True
        self.status = status
        entry = game_records.record_2048_safely(self.owner.id, self.game.score, self.game.max_tile)
        if entry is not None:
            self.status += "\n" + game_records.format_2048_line(entry, self.game.score, self.game.max_tile)
        self._render()
        await edit_panel_v2(interaction, self, files=[board_file(self.game)])
        self.stop()


class Game2048Cog(commands.Cog):
    def __init__(self, bot):
        self.bot = bot

    async def start_recruit(self, interaction: discord.Interaction):
        """/game のハブから呼ぶ。その場で盤面が始まる。"""
        view = Board2048View(self, interaction.user)
        await interaction.response.send_message(view=view, file=board_file(view.game))


async def setup(bot):
    await bot.add_cog(Game2048Cog(bot))
