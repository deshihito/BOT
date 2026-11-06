"""/game の四目並べ（2人対戦 / CPU、7列×6行）。

列を選んでコマを落とし、先に縦・横・斜めのどれかで4つ並べた方が勝ち。
盤面は PIL の PNG。対人戦は勝数と Elo レートに記録し、対局は
core/game/game_restore.py で再起動復旧する（オセロ・五目と同じ型）。
"""
import asyncio
import io
import logging
import random
from pathlib import Path

import discord
from discord.ext import commands
from PIL import Image, ImageDraw, ImageFont

from core import party_ranking
from core.game import elo, game_panels, game_restore
from core.game.connect4 import COLS, EMPTY, RED, ROWS, YELLOW, choose_ai_move, drop, is_full, legal_moves, new_board, winner

logger = logging.getLogger(__name__)

GAME_ID = "connect4"
party_ranking.register(GAME_ID)

COLOR = 0xFFFFFF
RECRUIT_SECONDS = 30
TURN_SECONDS = 60
CELL = 64
WIDTH, HEIGHT = CELL * COLS + 20, CELL * ROWS + 50


def render_board_image(board, last=None):
    img = Image.new("RGB", (WIDTH, HEIGHT), (40, 80, 180))
    draw = ImageDraw.Draw(img)
    try:
        font = ImageFont.truetype(str(Path(__file__).resolve().parents[3] / "font.ttf"), 20)
    except Exception:
        font = ImageFont.load_default()
    for c in range(COLS):
        draw.text((20 + c * CELL + CELL // 2, 12), str(c + 1), font=font, fill=(255, 255, 255), anchor="mm")
    for r in range(ROWS):
        for c in range(COLS):
            cx, cy = 20 + c * CELL + CELL // 2, 40 + r * CELL + CELL // 2
            v = board[r][c]
            fill = (240, 240, 240) if v == EMPTY else (230, 60, 60) if v == RED else (250, 210, 60)
            draw.ellipse([cx - 26, cy - 26, cx + 26, cy + 26], fill=fill, outline=(20, 40, 100), width=2)
            if last == (r, c):
                draw.ellipse([cx - 6, cy - 6, cx + 6, cy + 6], fill=(30, 30, 30))
    out = io.BytesIO()
    img.save(out, format="PNG", optimize=True)
    out.seek(0)
    return out


def board_attachment(board, last=None):
    name = "connect4_board.png"
    return discord.File(render_board_image(board, last), filename=name), f"attachment://{name}"


async def record_result(g) -> str:
    if g.mode == "cpu":
        return ""
    win = winner(g.board)
    red_p, yellow_p = g.players.get(RED), g.players.get(YELLOW)
    if red_p is None or yellow_p is None:
        return ""
    if win is None:
        result = elo.record_draw_safely(g.guild_id, GAME_ID, red_p.id, yellow_p.id)
        if result:
            return (f"📈 レート（引き分け）: {red_p.mention} {result['a']['rating']:.0f}（{result['a_delta']:+.0f}）"
                    f" / {yellow_p.mention} {result['b']['rating']:.0f}（{result['b_delta']:+.0f}）")
        return ""
    w = red_p if win == RED else yellow_p
    l = yellow_p if win == RED else red_p
    await party_ranking.shared().record_win(g.guild_id, w.id, GAME_ID)
    return elo.format_match_line(w, l, elo.record_match_safely(g.guild_id, GAME_ID, w.id, l.id))


class Connect4Game:
    def __init__(self, channel_id, guild_id, host_id, mode="human", difficulty=5):
        self.channel_id, self.guild_id, self.host_id = channel_id, guild_id, host_id
        self.players = {}
        self.board = new_board()
        self.turn = RED
        self.acted_col = None
        self.phase = "recruit"
        self.mode = mode
        self.difficulty = max(1, min(10, int(difficulty)))
        self.last_move = None

    def current_user(self):
        return self.players.get(self.turn)


class JoinView(discord.ui.View):
    def __init__(self, game):
        super().__init__(timeout=RECRUIT_SECONDS + 30)
        self.game = game

    @discord.ui.button(label="参加（最大2人）", style=discord.ButtonStyle.success)
    async def join(self, interaction, button):
        g = self.game
        if g.phase != "recruit":
            return await interaction.response.send_message("募集は終了しました。", ephemeral=True)
        if interaction.user.id in g.players:
            return await interaction.response.send_message("すでに参加しています。", ephemeral=True)
        if len(g.players) >= 2:
            return await interaction.response.send_message("定員です。", ephemeral=True)
        g.players[interaction.user.id] = interaction.user
        await interaction.response.send_message("参加しました。")


class MoveView(discord.ui.View):
    def __init__(self, cog, game):
        super().__init__(timeout=TURN_SECONDS)
        self.cog = cog
        self.game = game
        options = [discord.SelectOption(label=f"{c+1}列目", value=str(c)) for c in legal_moves(game.board)]
        select = discord.ui.Select(placeholder="落とす列を選んでください", options=options)
        select.callback = self._callback
        self.add_item(select)

    async def _callback(self, interaction):
        g = self.game
        user = g.current_user()
        if g.phase != "playing" or g.acted_col is not None or user is None or user.id != interaction.user.id:
            return await interaction.response.send_message("現在の手番のプレイヤーだけが選択できます。", ephemeral=True)
        for item in self.children:
            if isinstance(item, discord.ui.Select) and item.values:
                g.acted_col = int(item.values[0])
        await interaction.response.defer()


class Connect4(commands.Cog):
    def __init__(self, bot):
        self.bot, self.games = bot, {}

    @staticmethod
    def player_label(game, color):
        player = game.players.get(color)
        return "CPU" if player is None else player.mention

    async def start_recruit(self, interaction, mode="human", difficulty=5):
        channel = interaction.channel
        if channel.id in self.games:
            return await interaction.response.send_message("このチャンネルでは既にゲーム中です。", ephemeral=True)
        g = Connect4Game(channel.id, interaction.guild_id, interaction.user.id, mode, difficulty)
        self.games[channel.id] = g
        if mode == "cpu":
            g.players[RED] = interaction.user
            g.players[YELLOW] = None
            await interaction.response.send_message(f"四目並べCPU対戦（難易度 {g.difficulty}/10）を開始します。")
            try:
                await self.run_game(channel, g)
            finally:
                self._teardown(channel.id, g)
            return
        g.players[interaction.user.id] = interaction.user
        await interaction.response.send_message("四目並べの募集を開始しました。")
        try:
            await game_panels.replace(channel, "party", embed=discord.Embed(
                title="四目並べ 参加者募集",
                description=f"{interaction.user.mention} さんが募集中です。\n{RECRUIT_SECONDS}秒以内に参加してください（2人対戦）。",
                color=COLOR), view=JoinView(g))
            await asyncio.sleep(RECRUIT_SECONDS)
            await self.run_game(channel, g)
        finally:
            self._teardown(channel.id, g)

    def _teardown(self, channel_id, g):
        g.phase = "done"
        if self.games.get(channel_id) is g:
            self.games.pop(channel_id, None)
        self._clear_snapshot(channel_id)

    async def run_game(self, channel, g):
        if len(g.players) != 2:
            await channel.send("参加者が2人集まらなかったため、四目並べを開始できませんでした。")
            return
        g.phase = "playing"
        if g.mode != "cpu":
            g.players[RED], g.players[YELLOW] = list(g.players.values())
        file, url = board_attachment(g.board)
        embed = discord.Embed(description="四目並べを開始します。赤（🔴）が先手です。先に4つ並べた方が勝ちです。", color=COLOR)
        embed.set_image(url=url)
        await channel.send(embed=embed, file=file)
        await self._play_loop(channel, g)

    async def _play_loop(self, channel, g):
        while g.phase == "playing":
            self._save_snapshot(g)
            if winner(g.board) or is_full(g.board):
                break
            if g.mode == "cpu" and g.turn == YELLOW:
                depth = 2 if g.difficulty <= 3 else 4 if g.difficulty <= 7 else 6
                col = await asyncio.to_thread(choose_ai_move, g.board, YELLOW, depth)
                if col is None:
                    break
                from core.game.connect4 import drop_row
                row = drop_row(g.board, col)
                drop(g.board, col, YELLOW)
                g.last_move = (row, col)
                g.turn = RED
                continue
            g.acted_col = None
            user = g.current_user()
            file, url = board_attachment(g.board, g.last_move)
            embed = discord.Embed(
                description=(f"{user.mention} さんの番（{'赤 🔴' if g.turn == RED else '黄 🟡'}）。\n"
                             "落とす列をセレクトで選んでください。"), color=COLOR)
            embed.set_image(url=url)
            await game_panels.replace(channel, "party", embed=embed, file=file, view=MoveView(self, g))
            for _ in range(TURN_SECONDS):
                if g.acted_col is not None or g.phase != "playing":
                    break
                await asyncio.sleep(1)
            from core.game.connect4 import drop_row
            if g.acted_col is None:
                col = random.choice(legal_moves(g.board))
                await channel.send(f"{user.mention} さんは時間切れのため、ランダムな列（{col+1}列目）に落としました。")
            else:
                col = g.acted_col
            row = drop_row(g.board, col)
            drop(g.board, col, g.turn)
            g.last_move = (row, col)
            g.turn = YELLOW if g.turn == RED else RED
        g.phase = "done"
        win = winner(g.board)
        outcome = "引き分けです。" if win is None else f"勝者: {self.player_label(g, win)}（{'赤 🔴' if win == RED else '黄 🟡'}）"
        rating_line = await record_result(g)
        if rating_line:
            outcome += f"\n{rating_line}"
        if g.mode == "cpu":
            outcome += "\n（CPU戦はランキングに記録されません）"
        file, url = board_attachment(g.board, g.last_move)
        embed = discord.Embed(title="四目並べ 終了", description=outcome, color=COLOR)
        embed.set_image(url=url)
        await channel.send(embed=embed, file=file)

    # ------------------------------------------------------------------ 復旧
    def _save_snapshot(self, g):
        if g.phase != "playing":
            return
        red = g.players.get(RED)
        yellow = g.players.get(YELLOW)
        state = {
            "mode": g.mode, "difficulty": g.difficulty, "host_id": g.host_id,
            "players": {
                "red": game_restore.member_ref(red) if red is not None else None,
                "yellow": game_restore.member_ref(yellow) if yellow is not None else None,
            },
            "board": ["".join("R" if cell == RED else "Y" if cell == YELLOW else "." for cell in row) for row in g.board],
            "turn": "red" if g.turn == RED else "yellow",
            "last_move": list(g.last_move) if g.last_move else None,
        }
        game_restore.save_session(GAME_ID, g.channel_id, g.guild_id, state)

    def _clear_snapshot(self, channel_id) -> None:
        game_restore.clear_session(GAME_ID, channel_id)

    async def restore_after_restart(self) -> None:
        entries = game_restore.session_entries(GAME_ID)
        for channel_id, entry in entries.items():
            try:
                restored = await self._restore_session(channel_id, entry)
            except Exception:
                logger.exception("channel %s: 四目並べの復旧に失敗しました", channel_id)
                restored = False
            if not restored:
                game_restore.clear_session(GAME_ID, channel_id)
        game_restore.flush_store()

    async def _restore_session(self, channel_id, entry) -> bool:
        state = entry.get("state")
        if not isinstance(state, dict) or channel_id in self.games:
            return False
        channel = self.bot.get_channel(channel_id)
        if channel is None:
            return False
        guild = getattr(channel, "guild", None)
        guild_id = entry.get("guild_id") or getattr(guild, "id", None)
        g = Connect4Game(channel_id, guild_id, state.get("host_id"),
                         state.get("mode") or "human", state.get("difficulty") or 5)
        players = state.get("players") or {}
        for key, color in (("red", RED), ("yellow", YELLOW)):
            ref = players.get(key)
            if ref is None:
                if g.mode == "cpu":
                    g.players[color] = None
                    continue
                return False
            g.players[color] = game_restore.resolve_member(guild, ref.get("id"), ref.get("name"))
        rows = state["board"]
        if len(rows) != ROWS or any(len(row) != COLS for row in rows):
            return False
        conv = {"R": RED, "Y": YELLOW, ".": EMPTY}
        g.board = [[conv[ch] for ch in row] for row in rows]
        g.turn = RED if state.get("turn") == "red" else YELLOW
        if state.get("last_move"):
            g.last_move = tuple(state["last_move"])
        g.phase = "playing"
        self.games[channel_id] = g
        asyncio.create_task(self._run_restored(channel, g))
        return True

    async def _run_restored(self, channel, g):
        try:
            await self._play_loop(channel, g)
        except Exception:
            logger.exception("channel %s: 復旧した四目並べの進行に失敗しました", g.channel_id)
        finally:
            self._teardown(g.channel_id, g)


async def setup(bot):
    await bot.add_cog(Connect4(bot))
