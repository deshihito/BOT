# -*- coding: utf-8 -*-
"""数独（ソロ）。

問題は唯一解になるよう生成する。モードは かんたん／ふつう／むずかしい／
デイリー（日付シードで全員同じ問題・ふつう相当）。入力は
行セレクト→列セレクト→数字セレクト。初期マスは変更できない。
クリアタイムは core/game_records.py の sudoku に難易度別で残る。
"""
import asyncio
import random
import time
from datetime import datetime

import discord
from discord.ext import commands

from core import game_records
from core.sudoku import DIFFICULTIES, board_text, daily_puzzle, generate, is_complete_and_valid

GAME_ID = "sudoku"


def sudoku_embed(board, givens, user, label: str, status: str = "") -> discord.Embed:
    embed = discord.Embed(title=f"🔢 数独（{label}）", color=0xFFFFFF)
    desc = f"<@{user.id}> の盤面です。\n```\n{board_text(board, givens)}\n```"
    desc += "行→列→数字の順に選んで入力します（0で消えます）。[ ] は最初から埋まっているマスです。"
    if status:
        desc += f"\n{status}"
    embed.description = desc
    return embed


class SudokuView(discord.ui.View):
    def __init__(self, cog, owner, puzzle, solution, difficulty: str):
        super().__init__(timeout=1800)
        self.cog = cog
        self.owner = owner
        self.difficulty = difficulty
        self.label = DIFFICULTIES[difficulty][0]
        self.solution = solution
        self.givens = [[v != 0 for v in row] for row in puzzle]
        self.board = [row[:] for row in puzzle]
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
        row_select = discord.ui.Select(
            placeholder="行（1〜9）", row=0,
            options=[discord.SelectOption(label=f"{i+1}行目", value=str(i), default=(i == self.row)) for i in range(9)])
        row_select.callback = self._row_callback
        self.add_item(row_select)
        col_select = discord.ui.Select(
            placeholder="列（1〜9）", row=1,
            options=[discord.SelectOption(label=f"{i+1}列目", value=str(i), default=(i == self.col)) for i in range(9)])
        col_select.callback = self._col_callback
        self.add_item(col_select)
        num_select = discord.ui.Select(
            placeholder="数字（0で消す）", row=2,
            options=[discord.SelectOption(label="消す", value="0")] +
                    [discord.SelectOption(label=str(i), value=str(i)) for i in range(1, 10)])
        num_select.callback = self._num_callback
        self.add_item(num_select)
        check = discord.ui.Button(label="答え合わせ", style=discord.ButtonStyle.primary, row=3)
        check.callback = self._check_callback
        self.add_item(check)
        give = discord.ui.Button(label="あきらめる", style=discord.ButtonStyle.danger, row=3)
        give.callback = self._giveup_callback
        self.add_item(give)

    async def _row_callback(self, interaction: discord.Interaction):
        for item in self.children:
            if isinstance(item, discord.ui.Select) and item.row == 0:
                self.row = int(item.values[0])
        self._render()
        await interaction.response.edit_message(embed=self._embed(), view=self)

    async def _col_callback(self, interaction: discord.Interaction):
        for item in self.children:
            if isinstance(item, discord.ui.Select) and item.row == 1:
                self.col = int(item.values[0])
        self._render()
        await interaction.response.edit_message(embed=self._embed(), view=self)

    async def _num_callback(self, interaction: discord.Interaction):
        if self.row is None or self.col is None:
            return await interaction.response.send_message("先に行と列を選んでください。", ephemeral=True)
        if self.givens[self.row][self.col]:
            return await interaction.response.send_message("そのマスは最初から埋まっていて変更できません。", ephemeral=True)
        for item in self.children:
            if isinstance(item, discord.ui.Select) and item.row == 2:
                value = int(item.values[0])
        self.board[self.row][self.col] = value
        if all(v != 0 for row in self.board for v in row) and is_complete_and_valid(self.board):
            return await self._finish(interaction, cleared=True)
        self._render()
        await interaction.response.edit_message(embed=self._embed(), view=self)

    async def _check_callback(self, interaction: discord.Interaction):
        empty = sum(1 for row in self.board for v in row if v == 0)
        wrong = sum(1 for r in range(9) for c in range(9)
                    if self.board[r][c] != 0 and self.board[r][c] != self.solution[r][c])
        status = f"答え合わせ: 空き {empty} マス／間違い {wrong} マスです。"
        self._render()
        await interaction.response.edit_message(embed=self._embed(status), view=self)

    async def _giveup_callback(self, interaction: discord.Interaction):
        await self._finish(interaction, cleared=False)

    def _embed(self, status: str = ""):
        return sudoku_embed(self.board, self.givens, self.owner, self.label, status)

    async def _finish(self, interaction: discord.Interaction, cleared: bool):
        self.finished = True
        seconds = time.monotonic() - self.started_at
        board = self.board if cleared else self.solution
        status = f"🎉 クリア！タイム: **{seconds:.1f}秒**" if cleared else "🏳️ あきらめました。答えを表示します。"
        entry = game_records.record_sudoku_safely(self.owner.id, self.difficulty, cleared, seconds if cleared else None)
        if cleared and entry is not None:
            status += "\n" + game_records.format_timed_line(entry, self.label)
        for child in self.children:
            child.disabled = True
        embed = sudoku_embed(board, self.givens, self.owner, self.label, status)
        await interaction.response.edit_message(embed=embed, view=self)
        self.stop()


class ModeView(discord.ui.View):
    def __init__(self, cog, owner):
        super().__init__(timeout=120)
        self.cog = cog
        self.owner = owner
        for key in ("easy", "normal", "hard", "daily"):
            btn = discord.ui.Button(label=DIFFICULTIES[key][0], style=discord.ButtonStyle.primary)
            btn.callback = self._make_callback(key)
            self.add_item(btn)

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        return interaction.user.id == self.owner.id

    def _make_callback(self, difficulty):
        async def callback(interaction: discord.Interaction):
            await interaction.response.defer()
            if difficulty == "daily":
                date_key = datetime.now().strftime("%Y-%m-%d")
                puzzle, solution = await asyncio.to_thread(daily_puzzle, date_key)
            else:
                puzzle, solution = await asyncio.to_thread(generate, random.Random(), difficulty)
            view = SudokuView(self.cog, self.owner, puzzle, solution, difficulty)
            await interaction.edit_original_response(
                embed=sudoku_embed(view.board, view.givens, self.owner, view.label), view=view)
            self.stop()
        return callback


class Sudoku(commands.Cog):
    def __init__(self, bot):
        self.bot = bot

    async def start_recruit(self, interaction: discord.Interaction):
        """/game のハブから呼ぶ。難易度を選ぶと盤面が始まる。"""
        embed = discord.Embed(
            title="🔢 数独",
            description="難易度を選んでください。デイリーは今日の問題（全員同じ）です。",
            color=0xFFFFFF)
        await interaction.response.send_message(embed=embed, view=ModeView(self, interaction.user))


async def setup(bot):
    await bot.add_cog(Sudoku(bot))
