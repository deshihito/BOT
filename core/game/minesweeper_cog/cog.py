# -*- coding: utf-8 -*-
"""マインスイーパー（ソロ）。

盤面画像化タスク（2026-11-06）で再設計した:
- 盤面はボタン格子ではなく PIL 画像（core/game/board_image.render_minesweeper）
  で表示し、操作は「行セレクト→列セレクト→開くボタン」に分離した。
  マス数に依存しないため、大きな盤面（9×9 / 16×12）も同じ操作で成立する。
- 選択中のマスは画像上で黄色枠ハイライトし、座標（列は A〜、行は 1〜）を
  本文にも併記して押し間違いを防ぐ。代償として1マスの操作は現行の
  1タップから最大3ステップに増える（設計判断としてガイド・ログに明記）。
- パネルは Components V2（core/game/game_v2.GamePanelView）。
最初のクリックは必ず安全。クリアタイムのベストは
core/game/game_records.py に難易度キー別で残る（従来キーは不変、
大盤面は新キー wide/expert）。
"""
import io
import time

import discord
from discord.ext import commands

from core.game import game_records
from core.game.board_image import render_cached, render_minesweeper
from core.game.game_guides import GAME_GUIDES  # noqa: F401  (ガイド登録の確認用に参照される)
from core.game.game_v2 import GamePanelView
from core.game.minesweeper import COLS, ROWS, DIFFICULTIES, MinesweeperBoard
from core.panel_v2 import edit_panel_v2

GAME_ID = "minesweeper"


def tile_for(cols: int) -> int:
    if cols <= 5:
        return 52
    if cols <= 9:
        return 44
    return 34


def coord(col: int, row: int) -> str:
    return f"{chr(ord('A') + col)}{row + 1}"


def board_states(board: MinesweeperBoard, *, reveal: bool = False):
    """レンダラー用の状態行列を作る。reveal=True で地雷を公開する（終了時）。"""
    states = []
    for r in range(board.rows):
        row = []
        for c in range(board.cols):
            cell = (r, c)
            if cell in board.opened:
                row.append(("open", board.count_around(cell)))
            elif reveal and cell in board.mines:
                row.append(("exploded", None) if cell == board.exploded else ("mine", None))
            elif cell in board.flags:
                row.append(("flag", None))
            else:
                row.append(("hidden", None))
        states.append(row)
    return states


def board_png(board: MinesweeperBoard, selected=None, *, reveal: bool = False) -> bytes:
    states = board_states(board, reveal=reveal)
    tile = tile_for(board.cols)
    key = ("minesweeper", tuple(tuple(s) for s in states), selected, tile)
    return render_cached(key, lambda: render_minesweeper(states, selected=selected, tile=tile))


def board_file(board: MinesweeperBoard, selected=None, *, reveal: bool = False) -> discord.File:
    return discord.File(io.BytesIO(board_png(board, selected, reveal=reveal)), "board.png")


class BoardPanel(GamePanelView):
    def __init__(self, cog, owner, board: MinesweeperBoard):
        super().__init__(timeout=600)
        self.cog = cog
        self.owner = owner
        self.board = board
        self.flag_mode = False
        self.sel_row = None
        self.sel_col = None
        self.started_at = None
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

    # ------------------------------------------------------------------ 表示
    def _selected(self):
        if self.sel_row is None or self.sel_col is None:
            return None
        return (self.sel_row, self.sel_col)

    def _body_text(self) -> str:
        board = self.board
        label = DIFFICULTIES[board.difficulty][0]
        lines = [f"<@{self.owner.id}> の盤面（{label}: {board.cols}列×{board.rows}行）です。"
                 f"残りの地雷の目安: **{board.mines_left}**"]
        sel = self._selected()
        if sel is not None:
            lines.append(f"選択中: **{coord(sel[1], sel[0])}**"
                         + ("（旗モード）" if self.flag_mode else ""))
        else:
            lines.append("行と列を選んでから「開く」を押してください。")
        if self.status:
            lines.append(self.status)
        return "\n".join(lines)

    def _render(self):
        board = self.board
        label = DIFFICULTIES[board.difficulty][0]
        self.set_content(f"💣 マインスイーパー（{label}）", self._body_text())
        self.clear_rows()
        if self.finished:
            return
        row_select = discord.ui.Select(
            placeholder="行（1〜%d）" % board.rows,
            options=[discord.SelectOption(label=f"{i + 1}行目", value=str(i),
                                          default=(i == self.sel_row))
                     for i in range(board.rows)])

        async def on_row(inter: discord.Interaction, sel=row_select):
            self.sel_row = int(sel.values[0])
            await self._refresh(inter)

        row_select.callback = on_row
        self.add_row(row_select)
        col_select = discord.ui.Select(
            placeholder="列（A〜%s）" % chr(ord("A") + board.cols - 1),
            options=[discord.SelectOption(label=f"{chr(ord('A') + i)}列", value=str(i),
                                          default=(i == self.sel_col))
                     for i in range(board.cols)])

        async def on_col(inter: discord.Interaction, sel=col_select):
            self.sel_col = int(sel.values[0])
            await self._refresh(inter)

        col_select.callback = on_col
        self.add_row(col_select)
        act = discord.ui.Button(
            label="🚩 旗を立てる/外す" if self.flag_mode else "⛏ 開く",
            style=discord.ButtonStyle.success)
        act.callback = self._act_callback
        flag = discord.ui.Button(
            label="🚩 旗モード: ON" if self.flag_mode else "🚩 旗モード: OFF",
            style=discord.ButtonStyle.primary if self.flag_mode else discord.ButtonStyle.secondary)
        flag.callback = self._flag_callback
        give = discord.ui.Button(label="あきらめる", style=discord.ButtonStyle.danger)
        give.callback = self._giveup_callback
        self.add_row(act, flag, give)

    async def _refresh(self, interaction: discord.Interaction, *, reveal: bool = False):
        self._render()
        await edit_panel_v2(interaction, self,
                            files=[board_file(self.board, self._selected(), reveal=reveal)])

    # ------------------------------------------------------------------ 操作
    async def _act_callback(self, interaction: discord.Interaction):
        sel = self._selected()
        if sel is None:
            return await interaction.response.send_message(
                "先に行と列を選んでください。", ephemeral=True)
        board = self.board
        if self.flag_mode:
            board.toggle_flag(sel)
            await self._refresh(interaction)
            return
        was_started = board.started
        board.open(sel)
        if board.started and not was_started:
            self.started_at = time.monotonic()
        if board.exploded is not None:
            return await self._finish(interaction, cleared=False,
                                      status="💥 地雷を踏んでしまいました…")
        if board.cleared:
            seconds = (time.monotonic() - self.started_at) if self.started_at else None
            status = f"🎉 クリア！タイム: **{seconds:.1f}秒**" if seconds is not None else "🎉 クリア！"
            return await self._finish(interaction, cleared=True, status=status, seconds=seconds)
        await self._refresh(interaction)

    async def _flag_callback(self, interaction: discord.Interaction):
        self.flag_mode = not self.flag_mode
        await self._refresh(interaction)

    async def _giveup_callback(self, interaction: discord.Interaction):
        await self._finish(interaction, cleared=False,
                           status="🏳️ あきらめました。地雷の位置を表示します。")

    async def _finish(self, interaction, *, cleared: bool, status: str, seconds: float = None):
        self.finished = True
        self.status = status
        entry = game_records.record_sweeper_safely(self.owner.id, self.board.difficulty, cleared, seconds)
        if entry is not None:
            self.status += "\n" + game_records.format_sweeper_line(
                entry, DIFFICULTIES[self.board.difficulty][0])
        self._render()
        await edit_panel_v2(interaction, self,
                            files=[board_file(self.board, None, reveal=True)])
        self.stop()


class DifficultyPanel(GamePanelView):
    def __init__(self, cog, owner):
        super().__init__("💣 マインスイーパー",
                         "難易度を選んでください。盤面は画像で表示され、最初のクリックは必ず安全です。\n"
                         "かんたん/ふつう/むずかしい は従来の 5列×4行、ひろびろ・エキスパートは大きな盤面です。",
                         timeout=120)
        self.cog = cog
        self.owner = owner
        buttons = []
        for key, (label, mines, rows, cols) in DIFFICULTIES.items():
            btn = discord.ui.Button(label=f"{label}（{cols}×{rows}・地雷{mines}）",
                                    style=discord.ButtonStyle.primary)
            btn.callback = self._make_callback(key)
            buttons.append(btn)
        self.add_row(*buttons)

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        if interaction.user.id != self.owner.id:
            return False
        return await super().interaction_check(interaction)

    def _make_callback(self, difficulty):
        async def callback(interaction: discord.Interaction):
            board = MinesweeperBoard(difficulty)
            panel = BoardPanel(self.cog, self.owner, board)
            await edit_panel_v2(interaction, panel, files=[board_file(board)])
            self.stop()
        return callback


class Minesweeper(commands.Cog):
    def __init__(self, bot):
        self.bot = bot

    async def start_recruit(self, interaction: discord.Interaction):
        """/game のハブから呼ぶ。難易度を選ぶと画像盤面が始まる。"""
        await interaction.response.send_message(view=DifficultyPanel(self, interaction.user))


async def setup(bot):
    await bot.add_cog(Minesweeper(bot))
