# -*- coding: utf-8 -*-
"""ノノグラム（ピクロス、ソロ）。

ヒント数字を頼りにマスを塗って絵を浮かばせる。5×5 と 8×8。
入力は X（横）セレクト→Y（縦）セレクト→操作ボタン（塗る／バツ／消す）
（座標表記は X/Y 統一、レビュー対応 2026-11-06）。
クリアタイムは core/game/game_records.py の nonogram にサイズ別で残る。

盤面画像化タスク（2026-11-06）: 盤面＋行列ヒントの表示をテキストから
PIL 画像（core/game/board_image.render_nonogram）に差し替え、パネルは
Components V2（GamePanelView + MediaGallery）にした。操作方式・
ロジック・記録は不変。選択中の行・列ヒントとマスは画像上で強調される。
"""
import io
import random
import time

import discord
from discord.ext import commands

from core.game import game_records
from core.game.board_image import render_cached, render_nonogram
from core.game.game_v2 import GamePanelView
from core.game.nonogram import SIZES, NonogramBoard, NonogramPuzzle
from core.support.panel_v2 import edit_panel_v2

GAME_ID = "nonogram"
CELL_LABEL = {0: "未定", 1: "塗り", 2: "バツ"}


def board_embed(board: NonogramBoard, user, status: str = "") -> discord.Embed:
    """互換用に残す旧 embed 生成（現在の表示は V2 パネル＋画像）。"""
    embed = discord.Embed(title=f"🧩 ノノグラム（{board.puzzle.size_key}）", color=0xFFFFFF)
    desc = f"<@{user.id}> の盤面です。\n```\n{board.text()}\n```"
    desc += "X→Yを選んでから、塗る／バツ／消すを押します。"
    if status:
        desc += f"\n{status}"
    embed.description = desc
    return embed


def board_png(board: NonogramBoard, selected=None) -> bytes:
    puzzle = board.puzzle
    key = ("nonogram", puzzle.size_key, puzzle.name,
           tuple(tuple(r) for r in board.grid), selected)
    return render_cached(key, lambda: render_nonogram(
        puzzle.row_clues, puzzle.col_clues, board.grid, selected=selected))


def board_file(board: NonogramBoard, selected=None) -> discord.File:
    return discord.File(io.BytesIO(board_png(board, selected)), "board.png")


class NonogramView(GamePanelView):
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
        self.status = ""
        self.add_extra(discord.ui.MediaGallery(discord.MediaGalleryItem("attachment://board.png")))
        self._render()

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        if interaction.user.id != self.owner.id:
            await interaction.response.send_message("これは他の人の盤面です。", ephemeral=True)
            return False
        # 盤面再描画の連打制限 (E-16, GamePanelView の共通クールダウン)。
        return await super().interaction_check(interaction)

    def _selected(self):
        if self.row is None or self.col is None:
            return None
        return (self.row, self.col)

    def _render(self):
        body = f"<@{self.owner.id}> の盤面です。X（横）→Y（縦）を選んでから、塗る／バツ／消すを押します。"
        sel = self._selected()
        if sel is not None:
            body += (f"\n選択中: **X={sel[1] + 1}, Y={sel[0] + 1}**"
                     f"（現在: {CELL_LABEL[self.board.grid[sel[0]][sel[1]]] }）")
        if self.status:
            body += f"\n{self.status}"
        self.set_content(f"🧩 ノノグラム（{self.puzzle.size_key}）", body)
        self.clear_rows()
        if self.finished:
            return
        n = self.puzzle.n
        # 座標は X（横）→Y（縦）の順に選ぶ（上のセレクトが X、下が Y）
        col_select = discord.ui.Select(
            placeholder="X（横）: 列",
            options=[discord.SelectOption(label=f"X={i + 1}", value=str(i), default=(i == self.col)) for i in range(n)])

        async def on_col(inter: discord.Interaction, sel=col_select):
            self.col = int(sel.values[0])
            await self._refresh(inter)

        col_select.callback = on_col
        self.add_row(col_select)
        row_select = discord.ui.Select(
            placeholder="Y（縦）: 行",
            options=[discord.SelectOption(label=f"Y={i + 1}", value=str(i), default=(i == self.row)) for i in range(n)])

        async def on_row(inter: discord.Interaction, sel=row_select):
            self.row = int(sel.values[0])
            await self._refresh(inter)

        row_select.callback = on_row
        self.add_row(row_select)
        action_btns = []
        for label, value in (("■ 塗る", 1), ("× バツ", 2), ("消す", 0)):
            btn = discord.ui.Button(label=label, style=discord.ButtonStyle.primary)
            btn.callback = self._make_action_callback(value)
            action_btns.append(btn)
        self.add_row(*action_btns)
        check = discord.ui.Button(label="完成判定", style=discord.ButtonStyle.success)
        check.callback = self._check_callback
        give = discord.ui.Button(label="あきらめる", style=discord.ButtonStyle.danger)
        give.callback = self._giveup_callback
        self.add_row(check, give)

    async def _refresh(self, interaction: discord.Interaction):
        self._render()
        await edit_panel_v2(interaction, self,
                            files=[board_file(self.board, self._selected())])

    def _make_action_callback(self, value):
        async def callback(interaction: discord.Interaction):
            if self.row is None or self.col is None:
                return await interaction.response.send_message("先にXとYを選んでください。", ephemeral=True)
            self.board.set_cell(self.row, self.col, value)
            if self.board.cleared():
                return await self._finish(interaction, cleared=True)
            await self._refresh(interaction)
        return callback

    async def _check_callback(self, interaction: discord.Interaction):
        wrong = self.board.wrong_filled()
        filled = sum(1 for row in self.board.grid for v in row if v == 1)
        answer = sum(sum(row) for row in self.puzzle.solution)
        self.status = f"判定: 塗ったマス {filled}/{answer}、間違って塗ったマスは {wrong} 個です。"
        await self._refresh(interaction)

    async def _giveup_callback(self, interaction: discord.Interaction):
        await self._finish(interaction, cleared=False)

    async def _finish(self, interaction: discord.Interaction, cleared: bool):
        self.finished = True
        seconds = time.monotonic() - self.started_at
        if cleared:
            self.status = f"🎉 クリア！絵は「{self.puzzle.name}」でした。タイム: **{seconds:.1f}秒**"
        else:
            # 答えを表示する（正解マスを全部塗った状態にする）
            for r in range(self.puzzle.n):
                for c in range(self.puzzle.n):
                    self.board.grid[r][c] = self.puzzle.solution[r][c]
            self.status = f"🏳️ あきらめました。絵は「{self.puzzle.name}」でした。"
        entry = game_records.record_nonogram_safely(
            self.owner.id, self.puzzle.size_key, cleared, seconds if cleared else None)
        if cleared and entry is not None:
            self.status += "\n" + game_records.format_timed_line(entry, self.puzzle.size_key)
        self._render()
        await edit_panel_v2(interaction, self,
                            files=[board_file(self.board, None)])
        self.stop()


class SizeView(GamePanelView):
    def __init__(self, cog, owner):
        super().__init__("🧩 ノノグラム",
                         "サイズを選んでください。お題の絵はランダムです。",
                         timeout=120)
        self.cog = cog
        self.owner = owner
        buttons = []
        for key in SIZES:
            btn = discord.ui.Button(label=key, style=discord.ButtonStyle.primary)
            btn.callback = self._make_callback(key)
            buttons.append(btn)
        self.add_row(*buttons)

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        if interaction.user.id != self.owner.id:
            return False
        return await super().interaction_check(interaction)

    def _make_callback(self, size_key):
        async def callback(interaction: discord.Interaction):
            puzzle = NonogramPuzzle.pick(size_key, rng=random.Random())
            view = NonogramView(self.cog, self.owner, puzzle)
            await edit_panel_v2(interaction, view, files=[board_file(view.board, None)])
            self.stop()
        return callback


class Nonogram(commands.Cog):
    def __init__(self, bot):
        self.bot = bot

    async def start_recruit(self, interaction: discord.Interaction):
        """/game のハブから呼ぶ。サイズを選ぶと盤面が始まる。"""
        await interaction.response.send_message(view=SizeView(self, interaction.user))


async def setup(bot):
    await bot.add_cog(Nonogram(bot))
