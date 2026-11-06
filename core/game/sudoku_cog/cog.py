# -*- coding: utf-8 -*-
"""数独（ソロ）。

問題は唯一解になるよう生成する。モードは かんたん／ふつう／むずかしい／
デイリー（日付シードで全員同じ問題・ふつう相当）。入力は
行セレクト→列セレクト→数字セレクト。初期マスは変更できない。
クリアタイムは core/game/game_records.py の sudoku に難易度別で残る。

盤面画像化タスク（2026-11-06）: 盤面表示をテキストから PIL 画像
（core/game/board_image.render_sudoku）に差し替え、パネルは
Components V2（GamePanelView + MediaGallery）にした。操作方式・
ロジック・記録は不変。選択中のマスは画像上でハイライトされる。
"""
import asyncio
import io
import random
import time
from datetime import datetime

import discord
from discord.ext import commands

from core.game import game_records
from core.game.board_image import render_cached, render_sudoku
from core.game.game_v2 import GamePanelView
from core.game.sudoku import DIFFICULTIES, board_text, daily_puzzle, generate, is_complete_and_valid
from core.panel_v2 import edit_panel_v2

GAME_ID = "sudoku"


def sudoku_embed(board, givens, user, label: str, status: str = "") -> discord.Embed:
    """互換用に残す旧 embed 生成（現在の表示は V2 パネル＋画像）。"""
    embed = discord.Embed(title=f"🔢 数独（{label}）", color=0xFFFFFF)
    desc = f"<@{user.id}> の盤面です。\n```\n{board_text(board, givens)}\n```"
    desc += "行→列→数字の順に選んで入力します（0で消えます）。[ ] は最初から埋まっているマスです。"
    if status:
        desc += f"\n{status}"
    embed.description = desc
    return embed


def board_png(board, givens, selected=None) -> bytes:
    key = ("sudoku", tuple(tuple(r) for r in board),
           tuple(tuple(r) for r in givens), selected)
    return render_cached(key, lambda: render_sudoku(board, givens, selected=selected))


def board_file(board, givens, selected=None) -> discord.File:
    return discord.File(io.BytesIO(board_png(board, givens, selected)), "board.png")


class SudokuView(GamePanelView):
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
        self.status = ""
        self.add_extra(discord.ui.MediaGallery(discord.MediaGalleryItem("attachment://board.png")))
        self._render()

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        if interaction.user.id != self.owner.id:
            await interaction.response.send_message("これは他の人の盤面です。", ephemeral=True)
            return False
        return True

    def _selected(self):
        if self.row is None or self.col is None:
            return None
        return (self.row, self.col)

    def _render(self):
        body = (f"<@{self.owner.id}> の盤面です。"
                "行→列→数字の順に選んで入力します（0で消えます）。"
                "濃い数字は最初から埋まっているマスで、変更できません。")
        sel = self._selected()
        if sel is not None:
            body += f"\n選択中: **{sel[0] + 1}行目・{sel[1] + 1}列目**"
        if self.status:
            body += f"\n{self.status}"
        self.set_content(f"🔢 数独（{self.label}）", body)
        self.clear_rows()
        if self.finished:
            return
        row_select = discord.ui.Select(
            placeholder="行（1〜9）",
            options=[discord.SelectOption(label=f"{i + 1}行目", value=str(i), default=(i == self.row)) for i in range(9)])

        async def on_row(inter: discord.Interaction, sel=row_select):
            self.row = int(sel.values[0])
            await self._refresh(inter)

        row_select.callback = on_row
        self.add_row(row_select)
        col_select = discord.ui.Select(
            placeholder="列（1〜9）",
            options=[discord.SelectOption(label=f"{i + 1}列目", value=str(i), default=(i == self.col)) for i in range(9)])

        async def on_col(inter: discord.Interaction, sel=col_select):
            self.col = int(sel.values[0])
            await self._refresh(inter)

        col_select.callback = on_col
        self.add_row(col_select)
        num_select = discord.ui.Select(
            placeholder="数字（0で消す）",
            options=[discord.SelectOption(label="消す", value="0")] +
                    [discord.SelectOption(label=str(i), value=str(i)) for i in range(1, 10)])

        async def on_num(inter: discord.Interaction, sel=num_select):
            await self._num_chosen(inter, int(sel.values[0]))

        num_select.callback = on_num
        self.add_row(num_select)
        check = discord.ui.Button(label="答え合わせ", style=discord.ButtonStyle.primary)
        check.callback = self._check_callback
        give = discord.ui.Button(label="あきらめる", style=discord.ButtonStyle.danger)
        give.callback = self._giveup_callback
        self.add_row(check, give)

    async def _refresh(self, interaction: discord.Interaction):
        self._render()
        await edit_panel_v2(interaction, self,
                            files=[board_file(self.board, self.givens, self._selected())])

    async def _num_chosen(self, interaction: discord.Interaction, value: int):
        if self.row is None or self.col is None:
            return await interaction.response.send_message("先に行と列を選んでください。", ephemeral=True)
        if self.givens[self.row][self.col]:
            return await interaction.response.send_message("そのマスは最初から埋まっていて変更できません。", ephemeral=True)
        self.board[self.row][self.col] = value
        if all(v != 0 for row in self.board for v in row) and is_complete_and_valid(self.board):
            return await self._finish(interaction, cleared=True)
        await self._refresh(interaction)

    async def _check_callback(self, interaction: discord.Interaction):
        empty = sum(1 for row in self.board for v in row if v == 0)
        wrong = sum(1 for r in range(9) for c in range(9)
                    if self.board[r][c] != 0 and self.board[r][c] != self.solution[r][c])
        self.status = f"答え合わせ: 空き {empty} マス／間違い {wrong} マスです。"
        await self._refresh(interaction)

    async def _giveup_callback(self, interaction: discord.Interaction):
        await self._finish(interaction, cleared=False)

    async def _finish(self, interaction: discord.Interaction, cleared: bool):
        self.finished = True
        seconds = time.monotonic() - self.started_at
        board = self.board if cleared else self.solution
        self.status = f"🎉 クリア！タイム: **{seconds:.1f}秒**" if cleared else "🏳️ あきらめました。答えを表示します。"
        entry = game_records.record_sudoku_safely(self.owner.id, self.difficulty, cleared, seconds if cleared else None)
        if cleared and entry is not None:
            self.status += "\n" + game_records.format_timed_line(entry, self.label)
        self._render()
        await edit_panel_v2(interaction, self,
                            files=[board_file(board, self.givens, None)])
        self.stop()


class ModeView(GamePanelView):
    def __init__(self, cog, owner):
        super().__init__("🔢 数独",
                         "難易度を選んでください。デイリーは今日の問題（全員同じ）です。",
                         timeout=120)
        self.cog = cog
        self.owner = owner
        buttons = []
        for key in ("easy", "normal", "hard", "daily"):
            btn = discord.ui.Button(label=DIFFICULTIES[key][0], style=discord.ButtonStyle.primary)
            btn.callback = self._make_callback(key)
            buttons.append(btn)
        self.add_row(*buttons)

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
            await edit_panel_v2(interaction, view,
                                files=[board_file(view.board, view.givens, None)])
            self.stop()
        return callback


class Sudoku(commands.Cog):
    def __init__(self, bot):
        self.bot = bot

    async def start_recruit(self, interaction: discord.Interaction):
        """/game のハブから呼ぶ。難易度を選ぶと盤面が始まる。"""
        await interaction.response.send_message(view=ModeView(self, interaction.user))


async def setup(bot):
    await bot.add_cog(Sudoku(bot))
