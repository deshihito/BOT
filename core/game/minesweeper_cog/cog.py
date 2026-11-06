# -*- coding: utf-8 -*-
"""マインスイーパー（ボタン式・ソロ）。

盤面は 5列×4行のボタン式で、開いたマス・地雷・クリアをサーバー側で
完全に判定する（スポイラー式の自己申告ではない）。最初のクリックは
必ず安全。クリアタイムのベストは core/game/game_records.py に残る。
"""
import time

import discord
from discord.ext import commands

from core.game import game_records
from core.game.game_guides import GAME_GUIDES  # noqa: F401  (ガイド登録の確認用に参照される)
from core.game.minesweeper import COLS, ROWS, DIFFICULTIES, MinesweeperBoard

GAME_ID = "minesweeper"
NUMBER_LABELS = {0: "·", 1: "1", 2: "2", 3: "3", 4: "4", 5: "5", 6: "6", 7: "7", 8: "8"}


def board_embed(board: MinesweeperBoard, user, status: str = "") -> discord.Embed:
    label = DIFFICULTIES[board.difficulty][0]
    embed = discord.Embed(title=f"💣 マインスイーパー（{label}）", color=0xFFFFFF)
    desc = f"<@{user.id}> の盤面です。残りの地雷の目安: **{board.mines_left}**"
    if status:
        desc += f"\n{status}"
    embed.description = desc
    return embed


class BoardView(discord.ui.View):
    def __init__(self, cog, owner, board: MinesweeperBoard):
        super().__init__(timeout=600)
        self.cog = cog
        self.owner = owner
        self.board = board
        self.flag_mode = False
        self.started_at = None
        self.finished = False
        self._render()

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        if interaction.user.id != self.owner.id:
            await interaction.response.send_message("これは他の人の盤面です。", ephemeral=True)
            return False
        return True

    def _cell_label(self, cell):
        board = self.board
        if board.exploded is not None and cell in board.mines:
            return "💥" if cell == board.exploded else "💣"
        if cell in board.opened:
            return NUMBER_LABELS[board.count_around(cell)]
        if cell in board.flags:
            return "🚩"
        return "⬜"

    def _render(self):
        self.clear_items()
        board = self.board
        for r in range(ROWS):
            for c in range(COLS):
                cell = (r, c)
                btn = discord.ui.Button(label=self._cell_label(cell), row=r,
                                        style=discord.ButtonStyle.secondary,
                                        disabled=self.finished or cell in board.opened)
                btn.callback = self._make_cell_callback(cell)
                self.add_item(btn)
        flag = discord.ui.Button(label="🚩 旗モード: ON" if self.flag_mode else "🚩 旗モード: OFF",
                                 style=discord.ButtonStyle.primary if self.flag_mode else discord.ButtonStyle.secondary,
                                 row=4, disabled=self.finished)
        flag.callback = self._flag_callback
        self.add_item(flag)
        give = discord.ui.Button(label="あきらめる", style=discord.ButtonStyle.danger, row=4, disabled=self.finished)
        give.callback = self._giveup_callback
        self.add_item(give)

    def _make_cell_callback(self, cell):
        async def callback(interaction: discord.Interaction):
            board = self.board
            if self.flag_mode:
                board.toggle_flag(cell)
            else:
                was_started = board.started
                board.open(cell)
                if board.started and not was_started:
                    self.started_at = time.monotonic()
            if board.exploded is not None:
                await self._finish(interaction, cleared=False, status="💥 地雷を踏んでしまいました…")
                return
            if board.cleared:
                seconds = (time.monotonic() - self.started_at) if self.started_at else None
                status = f"🎉 クリア！タイム: **{seconds:.1f}秒**" if seconds is not None else "🎉 クリア！"
                await self._finish(interaction, cleared=True, status=status, seconds=seconds)
                return
            self._render()
            await interaction.response.edit_message(embed=board_embed(board, self.owner), view=self)
        return callback

    async def _flag_callback(self, interaction: discord.Interaction):
        self.flag_mode = not self.flag_mode
        self._render()
        await interaction.response.edit_message(embed=board_embed(self.board, self.owner), view=self)

    async def _giveup_callback(self, interaction: discord.Interaction):
        await self._finish(interaction, cleared=False, status="🏳️ あきらめました。地雷の位置を表示します。")

    async def _finish(self, interaction, *, cleared: bool, status: str, seconds: float = None):
        self.finished = True
        self._render()
        entry = game_records.record_sweeper_safely(self.owner.id, self.board.difficulty, cleared, seconds)
        if entry is not None:
            status += "\n" + game_records.format_sweeper_line(entry, DIFFICULTIES[self.board.difficulty][0])
        await interaction.response.edit_message(embed=board_embed(self.board, self.owner, status), view=self)
        self.stop()


class DifficultyView(discord.ui.View):
    def __init__(self, cog, owner):
        super().__init__(timeout=120)
        self.cog = cog
        self.owner = owner
        for key, (label, mines) in DIFFICULTIES.items():
            btn = discord.ui.Button(label=f"{label}（地雷{mines}個）", style=discord.ButtonStyle.primary)
            btn.callback = self._make_callback(key)
            self.add_item(btn)

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        return interaction.user.id == self.owner.id

    def _make_callback(self, difficulty):
        async def callback(interaction: discord.Interaction):
            board = MinesweeperBoard(difficulty)
            view = BoardView(self.cog, self.owner, board)
            await interaction.response.edit_message(embed=board_embed(board, self.owner), view=view)
            self.stop()
        return callback


class Minesweeper(commands.Cog):
    def __init__(self, bot):
        self.bot = bot

    async def start_recruit(self, interaction: discord.Interaction):
        """/game のハブから呼ぶ。難易度を選ぶとボタン式の盤面が始まる。"""
        embed = discord.Embed(
            title="💣 マインスイーパー",
            description="難易度を選んでください。盤面はボタン式で、最初のクリックは必ず安全です。",
            color=0xFFFFFF,
        )
        await interaction.response.send_message(embed=embed, view=DifficultyView(self, interaction.user))


async def setup(bot):
    await bot.add_cog(Minesweeper(bot))
