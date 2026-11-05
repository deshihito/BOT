# -*- coding: utf-8 -*-
"""ノノグラム（ピクロス、ソロ）。

ヒント数字を頼りにマスを塗って絵を浮かばせる。5×5 と 8×8。
入力は 行セレクト→列セレクト→操作ボタン（塗る／バツ／消す）。
クリアタイムは core/game_records.py の nonogram にサイズ別で残る。
"""
import random
import time

import discord
from discord.ext import commands

from core import game_records
from core.nonogram import SIZES, NonogramBoard, NonogramPuzzle

GAME_ID = "nonogram"
CELL_LABEL = {0: "未定", 1: "塗り", 2: "バツ"}


def board_embed(board: NonogramBoard, user, status: str = "") -> discord.Embed:
    embed = discord.Embed(title=f"🧩 ノノグラム（{board.puzzle.size_key}）", color=0xFFFFFF)
    desc = f"<@{user.id}> の盤面です。\n```\n{board.text()}\n```"
    desc += "行→列を選んでから、塗る／バツ／消すを押します。"
    if status:
        desc += f"\n{status}"
    embed.description = desc
    return embed


class NonogramView(discord.ui.View):
    def __init__(self, cog, owner, puzzle: NonogramPuzzle):
        super().__init__(timeout=1800)
        self.cog = cog
        self.owner = owner
        self.puzzle = puzzle
        self.board = NonogramBoard(puzzle)
        self.row = None
        self.col = None
        self.started_at = time.monotonic()
        self.finished = False
        self._render()

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        if interaction.user.id != self.owner.id:
            await interaction.response.send_message("これは他の人の盤面です。", ephemeral=True)
            return False
        return True

    def _render(self):
        self.clear_items()
        n = self.puzzle.n
        row_select = discord.ui.Select(
            placeholder="行", row=0,
            options=[discord.SelectOption(label=f"{i+1}行目", value=str(i), default=(i == self.row)) for i in range(n)])
        row_select.callback = self._make_select_callback("row")
        self.add_item(row_select)
        col_select = discord.ui.Select(
            placeholder="列", row=1,
            options=[discord.SelectOption(label=f"{i+1}列目", value=str(i), default=(i == self.col)) for i in range(n)])
        col_select.callback = self._make_select_callback("col")
        self.add_item(col_select)
        for label, value in (("■ 塗る", 1), ("× バツ", 2), ("消す", 0)):
            btn = discord.ui.Button(label=label, style=discord.ButtonStyle.primary, row=2)
            btn.callback = self._make_action_callback(value)
            self.add_item(btn)
        check = discord.ui.Button(label="完成判定", style=discord.ButtonStyle.success, row=3)
        check.callback = self._check_callback
        self.add_item(check)
        give = discord.ui.Button(label="あきらめる", style=discord.ButtonStyle.danger, row=3)
        give.callback = self._giveup_callback
        self.add_item(give)

    def _make_select_callback(self, kind):
        async def callback(interaction: discord.Interaction):
            row_idx = 0 if kind == "row" else 1
            for item in self.children:
                if isinstance(item, discord.ui.Select) and item.row == row_idx and item.values:
                    if kind == "row":
                        self.row = int(item.values[0])
                    else:
                        self.col = int(item.values[0])
            self._render()
            await interaction.response.edit_message(embed=board_embed(self.board, self.owner), view=self)
        return callback

    def _make_action_callback(self, value):
        async def callback(interaction: discord.Interaction):
            if self.row is None or self.col is None:
                return await interaction.response.send_message("先に行と列を選んでください。", ephemeral=True)
            self.board.set_cell(self.row, self.col, value)
            if self.board.cleared():
                return await self._finish(interaction, cleared=True)
            self._render()
            await interaction.response.edit_message(embed=board_embed(self.board, self.owner), view=self)
        return callback

    async def _check_callback(self, interaction: discord.Interaction):
        wrong = self.board.wrong_filled()
        filled = sum(1 for row in self.board.grid for v in row if v == 1)
        answer = sum(sum(row) for row in self.puzzle.solution)
        status = f"判定: 塗ったマス {filled}/{answer}、間違って塗ったマスは {wrong} 個です。"
        self._render()
        await interaction.response.edit_message(embed=board_embed(self.board, self.owner, status), view=self)

    async def _giveup_callback(self, interaction: discord.Interaction):
        await self._finish(interaction, cleared=False)

    async def _finish(self, interaction: discord.Interaction, cleared: bool):
        self.finished = True
        seconds = time.monotonic() - self.started_at
        if cleared:
            status = f"🎉 クリア！絵は「{self.puzzle.name}」でした。タイム: **{seconds:.1f}秒**"
        else:
            # 答えを表示する（正解マスを全部塗った状態にする）
            for r in range(self.puzzle.n):
                for c in range(self.puzzle.n):
                    self.board.grid[r][c] = self.puzzle.solution[r][c]
            status = f"🏳️ あきらめました。絵は「{self.puzzle.name}」でした。"
        entry = game_records.record_nonogram_safely(
            self.owner.id, self.puzzle.size_key, cleared, seconds if cleared else None)
        if cleared and entry is not None:
            status += "\n" + game_records.format_timed_line(entry, self.puzzle.size_key)
        for child in self.children:
            child.disabled = True
        await interaction.response.edit_message(embed=board_embed(self.board, self.owner, status), view=self)
        self.stop()


class SizeView(discord.ui.View):
    def __init__(self, cog, owner):
        super().__init__(timeout=120)
        self.cog = cog
        self.owner = owner
        for key in SIZES:
            btn = discord.ui.Button(label=key, style=discord.ButtonStyle.primary)
            btn.callback = self._make_callback(key)
            self.add_item(btn)

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        return interaction.user.id == self.owner.id

    def _make_callback(self, size_key):
        async def callback(interaction: discord.Interaction):
            puzzle = NonogramPuzzle.pick(size_key, rng=random.Random())
            view = NonogramView(self.cog, self.owner, puzzle)
            await interaction.response.edit_message(embed=board_embed(view.board, self.owner), view=view)
            self.stop()
        return callback


class Nonogram(commands.Cog):
    def __init__(self, bot):
        self.bot = bot

    async def start_recruit(self, interaction: discord.Interaction):
        """/game のハブから呼ぶ。サイズを選ぶと盤面が始まる。"""
        embed = discord.Embed(
            title="🧩 ノノグラム",
            description="サイズを選んでください。お題の絵はランダムです。",
            color=0xFFFFFF)
        await interaction.response.send_message(embed=embed, view=SizeView(self, interaction.user))


async def setup(bot):
    await bot.add_cog(Nonogram(bot))
