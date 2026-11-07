"""/game の五目並べ（2人対戦 / CPU、15×15）。

盤面は PIL で描く PNG、移動はX（横）→Y（縦）のセレクト（座標表記は
X/Y 統一、レビュー対応 2026-11-06）。対人戦は
core/game/game/party_ranking.py の勝数と core/game/game/elo.py のレートに記録し、
対局は core/game/game/game_restore.py で再起動復旧する（オセロと同じ型）。
"""
import asyncio
import io
import logging
import random
from pathlib import Path

import discord
from discord.ext import commands
from PIL import Image, ImageDraw, ImageFont

from core.game.game import party_ranking
from core.game.game import elo, game_panels, game_restore
from core.game.game.game_v2 import GamePanelView, LobbyView
from core.game.gomoku.gomoku import BLACK, EMPTY, SIZE, WHITE, choose_ai_move, is_full, is_win_at, legal_moves, new_board, winner

logger = logging.getLogger(__name__)

GAME_ID = "gomoku"
party_ranking.register(GAME_ID)

COLOR = 0xFFFFFF
RECRUIT_SECONDS = 30
TURN_SECONDS = 60
IMG_SIZE = 640
MARGIN = 40


_BASE_CACHE = None


def _wood_base():
    """木目風の盤背景（決定的に生成し、プロセス内で1回だけ作って使い回す）。

    盤面画像化タスク（2026-11-06）のリッチ化: ベタ塗りだった盤に
    横木目＋板の継ぎ目を与え、碁石には影とハイライトで立体感を出す。
    座標系・出力サイズは従来どおり（復旧や操作に影響しない）。
    """
    global _BASE_CACHE
    if _BASE_CACHE is not None:
        return _BASE_CACHE.copy()
    img = Image.new("RGB", (IMG_SIZE, IMG_SIZE), (238, 198, 130))
    overlay = Image.new("RGBA", (IMG_SIZE, IMG_SIZE), (0, 0, 0, 0))
    odraw = ImageDraw.Draw(overlay)
    rng = random.Random(20261106)
    import math
    for y in range(IMG_SIZE):
        alpha = int(7 + 5 * math.sin(y / 23.0) + rng.randint(0, 4))
        odraw.line([(0, y), (IMG_SIZE, y)], fill=(122, 82, 30, alpha))
    for seam in range(160, IMG_SIZE, 160):
        odraw.line([(0, seam), (IMG_SIZE, seam)], fill=(110, 72, 24, 60), width=2)
    img = Image.alpha_composite(img.convert("RGBA"), overlay).convert("RGB")
    draw = ImageDraw.Draw(img)
    draw.rectangle([4, 4, IMG_SIZE - 5, IMG_SIZE - 5], outline=(96, 62, 20), width=3)
    _BASE_CACHE = img
    return img.copy()


def render_board_image(board, last=None):
    img = _wood_base()
    draw = ImageDraw.Draw(img)
    step = (IMG_SIZE - MARGIN * 2) / (SIZE - 1)
    for i in range(SIZE):
        p = MARGIN + i * step
        draw.line([(MARGIN, p), (IMG_SIZE - MARGIN, p)], fill=(90, 60, 20), width=1)
        draw.line([(p, MARGIN), (p, IMG_SIZE - MARGIN)], fill=(90, 60, 20), width=1)
    # 星（ほし）の位置に小点を打つ（15x15 の定位置）
    for hr, hc in ((3, 3), (3, 11), (11, 3), (11, 11), (7, 7)):
        cx, cy = MARGIN + hc * step, MARGIN + hr * step
        draw.ellipse([cx - 3.5, cy - 3.5, cx + 3.5, cy + 3.5], fill=(90, 60, 20))
    try:
        font = ImageFont.truetype(str(Path(__file__).resolve().parents[3] / "font.ttf"), 16)
    except Exception:
        font = ImageFont.load_default()
    for i in range(SIZE):
        draw.text((MARGIN + i * step, 12), str(i + 1), font=font, fill=(60, 40, 10), anchor="mm")
        draw.text((12, MARGIN + i * step), str(i + 1), font=font, fill=(60, 40, 10), anchor="mm")
    # 軸ラベル（上端= X（横）、左端= Y（縦）。座標表記の X/Y 統一対応）
    draw.text((IMG_SIZE - 14, 12), "X", font=font, fill=(60, 40, 10), anchor="mm")
    draw.text((12, IMG_SIZE - 14), "Y", font=font, fill=(60, 40, 10), anchor="mm")
    radius = step * 0.42
    for r in range(SIZE):
        for c in range(SIZE):
            v = board[r][c]
            if v == EMPTY:
                continue
            cx, cy = MARGIN + c * step, MARGIN + r * step
            # 影 → 本体 → ハイライトの3層で碁石の立体感を出す
            draw.ellipse([cx - radius + 2, cy - radius + 3, cx + radius + 2, cy + radius + 3],
                         fill=(150, 108, 55))
            if v == BLACK:
                draw.ellipse([cx - radius, cy - radius, cx + radius, cy + radius],
                             fill=(24, 24, 28), outline=(8, 8, 10))
                draw.ellipse([cx - radius * 0.55, cy - radius * 0.62,
                              cx - radius * 0.08, cy - radius * 0.18], fill=(96, 96, 110))
            else:
                draw.ellipse([cx - radius, cy - radius, cx + radius, cy + radius],
                             fill=(248, 248, 246), outline=(120, 120, 120))
                draw.ellipse([cx - radius * 0.55, cy - radius * 0.62,
                              cx - radius * 0.08, cy - radius * 0.18], fill=(255, 255, 255))
            if last == (r, c):
                draw.ellipse([cx - 4, cy - 4, cx + 4, cy + 4], fill=(230, 50, 50))
    out = io.BytesIO()
    img.save(out, format="PNG", optimize=True)
    out.seek(0)
    return out


def board_attachment(board, last=None):
    name = "gomoku_board.png"
    return discord.File(render_board_image(board, last), filename=name), f"attachment://{name}"


async def record_result(g) -> str:
    if g.mode == "cpu":
        return ""
    win = winner(g.board)
    black_p, white_p = g.players.get(BLACK), g.players.get(WHITE)
    if black_p is None or white_p is None:
        return ""
    if win is None:
        result = elo.record_draw_safely(g.guild_id, GAME_ID, black_p.id, white_p.id)
        if result:
            return (f"📈 レート（引き分け）: {black_p.mention} {result['a']['rating']:.0f}（{result['a_delta']:+.0f}）"
                    f" / {white_p.mention} {result['b']['rating']:.0f}（{result['b_delta']:+.0f}）")
        return ""
    w = black_p if win == BLACK else white_p
    l = white_p if win == BLACK else black_p
    await party_ranking.shared().record_win(g.guild_id, w.id, GAME_ID)
    return elo.format_match_line(w, l, elo.record_match_safely(g.guild_id, GAME_ID, w.id, l.id))


class GomokuGame:
    def __init__(self, channel_id, guild_id, host_id, mode="human", difficulty=5):
        self.channel_id, self.guild_id, self.host_id = channel_id, guild_id, host_id
        self.players = {}
        self.board = new_board()
        self.turn = BLACK
        self.acted = False
        self.phase = "recruit"
        self.mode = mode
        self.difficulty = max(1, min(10, int(difficulty)))
        self.last_move = None

    def current_user(self):
        return self.players.get(self.turn)


class MovePanel(GamePanelView):
    """X（横）→Y（縦）の2段セレクト。両方選ぶと着手する（V2）。"""

    def __init__(self, cog, game, body: str = ""):
        super().__init__("", body, timeout=TURN_SECONDS)
        self.cog = cog
        self.game = game
        self.row = None
        self.col = None
        gallery = discord.ui.MediaGallery()
        gallery.add_item(media="attachment://gomoku_board.png")
        self.add_extra(gallery)
        self.col_select = discord.ui.Select(
            placeholder="X（横）: 列（1〜15）",
            options=[discord.SelectOption(label=f"X={i+1}", value=str(i)) for i in range(SIZE)])
        self.col_select.callback = self._col_callback
        self.add_row(self.col_select)
        self.row_select = discord.ui.Select(
            placeholder="Y（縦）: 行（1〜15）",
            options=[discord.SelectOption(label=f"Y={i+1}", value=str(i)) for i in range(SIZE)])
        self.row_select.callback = self._row_callback
        self.add_row(self.row_select)

    async def _col_callback(self, interaction):
        if not self._check_turn(interaction):
            return await interaction.response.send_message("現在の手番のプレイヤーだけが選択できます。", ephemeral=True)
        if self.col_select.values:
            self.col = int(self.col_select.values[0])
        await interaction.response.defer()
        await self._try_apply(interaction)

    async def _row_callback(self, interaction):
        if not self._check_turn(interaction):
            return await interaction.response.send_message("現在の手番のプレイヤーだけが選択できます。", ephemeral=True)
        if self.row_select.values:
            self.row = int(self.row_select.values[0])
        await interaction.response.defer()
        await self._try_apply(interaction)

    def _check_turn(self, interaction) -> bool:
        g = self.game
        user = g.current_user()
        return g.phase == "playing" and not g.acted and user is not None and user.id == interaction.user.id

    async def _try_apply(self, interaction):
        g = self.game
        if self.row is None or self.col is None:
            return
        if g.board[self.row][self.col] != EMPTY:
            await interaction.followup.send("そのマスには既に石があります。別のマスを選んでください。", ephemeral=True)
            return
        g.board[self.row][self.col] = g.turn
        g.last_move = (self.row, self.col)
        g.acted = True


MoveView = MovePanel  # 互換名


def board_panel(title: str, body: str) -> GamePanelView:
    """盤面画像つきの表示専用パネル（開始・終了表示用）。"""
    panel = GamePanelView(title, body, timeout=None)
    gallery = discord.ui.MediaGallery()
    gallery.add_item(media="attachment://gomoku_board.png")
    panel.add_extra(gallery)
    return panel


class Gomoku(commands.Cog):
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
        g = GomokuGame(channel.id, interaction.guild_id, interaction.user.id, mode, difficulty)
        self.games[channel.id] = g
        if mode == "cpu":
            g.players[BLACK] = interaction.user
            g.players[WHITE] = None
            await interaction.response.send_message(f"五目並べCPU対戦（難易度 {g.difficulty}/10）を開始します。")
            try:
                await self.run_game(channel, g)
            finally:
                self._teardown(channel.id, g)
            return
        g.players[interaction.user.id] = interaction.user
        await interaction.response.send_message("五目並べの募集を開始しました。")
        try:
            lobby = LobbyView(
                title="五目並べ 参加者募集", host=interaction.user,
                min_players=2, max_players=2,
                note=f"{interaction.user.mention} さんが募集中です。\n{RECRUIT_SECONDS}秒以内に参加してください（2人対戦）。",
                timeout=RECRUIT_SECONDS + 30)
            await game_panels.replace(channel, "party", view=lobby)
            for _ in range(RECRUIT_SECONDS * 2):
                if lobby.started or lobby.cancelled:
                    break
                await asyncio.sleep(0.5)
            lobby.stop()
            if lobby.cancelled:
                return
            g.players = dict(lobby.members)
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
            await channel.send("参加者が2人集まらなかったため、五目並べを開始できませんでした。")
            return
        g.phase = "playing"
        if g.mode != "cpu":
            g.players[BLACK], g.players[WHITE] = list(g.players.values())
        file, url = board_attachment(g.board)
        await channel.send(view=board_panel(
            "", "五目並べを開始します。黒（●）が先手です。先に5つ並べた方が勝ちです。"), file=file)
        await self._play_loop(channel, g)

    def _cpu_move(self, g):
        if g.difficulty <= 3 and random.random() < 0.4:
            from core.game.gomoku.gomoku import candidates
            return random.choice(candidates(g.board))
        return choose_ai_move(g.board, g.turn)

    async def _play_loop(self, channel, g):
        while g.phase == "playing":
            self._save_snapshot(g)
            if winner(g.board) or is_full(g.board):
                break
            if g.mode == "cpu" and g.turn == WHITE:
                move = await asyncio.to_thread(self._cpu_move, g)
                if move is None:
                    break
                g.board[move[0]][move[1]] = WHITE
                g.last_move = move
                g.turn = BLACK
                continue
            g.acted = False
            user = g.current_user()
            file, url = board_attachment(g.board, g.last_move)
            body = (f"{user.mention} さんの番（{'黒 ●' if g.turn == BLACK else '白 ○'}）。\n"
                    "X（横）→Y（縦）の順にセレクトで選んでください。")
            await game_panels.replace(channel, "party", file=file, view=MovePanel(self, g, body))
            for _ in range(TURN_SECONDS):
                if g.acted or g.phase != "playing":
                    break
                await asyncio.sleep(1)
            if not g.acted:
                move = random.choice(legal_moves(g.board))
                g.board[move[0]][move[1]] = g.turn
                g.last_move = move
                await channel.send(f"{user.mention} さんは時間切れのため、ランダムなマス（X={move[1]+1}, Y={move[0]+1}）に置きました。")
            g.turn = WHITE if g.turn == BLACK else BLACK
        g.phase = "done"
        win = winner(g.board)
        if win is None:
            outcome = "引き分けです。"
        else:
            outcome = f"勝者: {self.player_label(g, win)}（{'黒 ●' if win == BLACK else '白 ○'}）"
        rating_line = await record_result(g)
        if rating_line:
            outcome += f"\n{rating_line}"
        if g.mode == "cpu":
            outcome += "\n（CPU戦はランキングに記録されません）"
        file, url = board_attachment(g.board, g.last_move)
        # 役割を終えた手番パネルを片付け、結果（盤面つき）だけを残す。
        await game_panels.clear(channel, "party")
        await channel.send(view=board_panel("五目並べ 終了", outcome), file=file)

    # ------------------------------------------------------------------ 復旧
    def _save_snapshot(self, g):
        if g.phase != "playing":
            return
        black = g.players.get(BLACK)
        white = g.players.get(WHITE)
        state = {
            "mode": g.mode, "difficulty": g.difficulty, "host_id": g.host_id,
            "players": {
                "black": game_restore.member_ref(black) if black is not None else None,
                "white": game_restore.member_ref(white) if white is not None else None,
            },
            "board": ["".join(row) for row in g.board],
            "turn": g.turn,
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
                logger.exception("channel %s: 五目並べの復旧に失敗しました", channel_id)
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
        g = GomokuGame(channel_id, guild_id, state.get("host_id"),
                       state.get("mode") or "human", state.get("difficulty") or 5)
        players = state.get("players") or {}
        for key, color in (("black", BLACK), ("white", WHITE)):
            ref = players.get(key)
            if ref is None:
                if g.mode == "cpu":
                    g.players[color] = None
                    continue
                return False
            g.players[color] = game_restore.resolve_member(guild, ref.get("id"), ref.get("name"))
        board = state["board"]
        if len(board) != SIZE or any(len(row) != SIZE for row in board):
            return False
        g.board = [list(row) for row in board]
        if state.get("turn") in (BLACK, WHITE):
            g.turn = state["turn"]
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
            logger.exception("channel %s: 復旧した五目並べの進行に失敗しました", g.channel_id)
        finally:
            self._teardown(g.channel_id, g)


async def setup(bot):
    await bot.add_cog(Gomoku(bot))
