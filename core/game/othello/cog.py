"""/game のオセロ（2人対戦、標準8x8ルール）。"""
import asyncio
import io
import logging
import random
from pathlib import Path

import discord
from discord.ext import commands
from core.game.game import party_ranking
from core.game.game import elo, game_panels, game_restore
from core.game.game.game_v2 import GamePanelView, LobbyView, board_image_panel, text_panel, GAME_MSG_ONLY_CURRENT_PLAYER
from PIL import Image, ImageDraw, ImageFont

logger = logging.getLogger(__name__)

GAME_ID = "othello"
party_ranking.register(GAME_ID)

COLOR = 0xFFFFFF
RECRUIT_SECONDS = 30
TURN_SECONDS = 60
EMPTY, BLACK, WHITE = ".", "●", "○"
DIRECTIONS = [(dr, dc) for dr in (-1, 0, 1) for dc in (-1, 0, 1) if (dr, dc) != (0, 0)]
ASSET_DIR = Path(__file__).resolve().parents[3] / "Assets" / "reversi"
BOARD_SIZE = 800
MOVE_LABELS = tuple("123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ")
SELECT_PAGE_SIZE = 25  # Discord のセレクトメニューの選択肢上限


def labelled_moves(moves):
    if len(moves) > len(MOVE_LABELS):
        raise ValueError(f"合法手がラベル上限{len(MOVE_LABELS)}を超えています")
    return list(zip(MOVE_LABELS, moves))


def render_board_image(board, moves=()):
    """追加素材を使い、盤面・石・合法手ラベルを高解像度PNGに合成する。"""
    source = Image.open(ASSET_DIR / "IMG_4894.png").convert("RGBA")
    board_image = source.crop((72, 45, 529, 505)).resize(
        (BOARD_SIZE, BOARD_SIZE), Image.Resampling.LANCZOS
    )
    pieces = {
        BLACK: Image.open(ASSET_DIR / "IMG_4896.png").convert("RGBA"),
        WHITE: Image.open(ASSET_DIR / "IMG_4895.png").convert("RGBA"),
    }
    pieces = {key: image.crop(image.getchannel("A").getbbox()) for key, image in pieces.items()}
    cell_size = BOARD_SIZE / 8
    piece_size = round(cell_size * 0.78)
    for row in range(8):
        for col in range(8):
            piece = board[row][col]
            if piece not in pieces:
                continue
            stone = pieces[piece].resize((piece_size, piece_size), Image.Resampling.LANCZOS)
            x = round(col * cell_size + (cell_size - piece_size) / 2)
            y = round(row * cell_size + (cell_size - piece_size) / 2)
            board_image.alpha_composite(stone, (x, y))
    draw = ImageDraw.Draw(board_image, "RGBA")
    label_font = ImageFont.truetype(str(ASSET_DIR.parent.parent / "font.ttf"), 34)
    for label, (row, col) in labelled_moves(moves):
        cx, cy = round((col + 0.5) * cell_size), round((row + 0.5) * cell_size)
        radius = 23
        draw.ellipse((cx - radius, cy - radius, cx + radius, cy + radius),
                     fill=(12, 48, 24, 235), outline=(255, 255, 255, 245), width=3)
        draw.text((cx, cy), label, font=label_font, fill=(255, 255, 255, 255), anchor="mm")
    output = io.BytesIO()
    board_image.save(output, format="PNG", optimize=True)
    output.seek(0)
    return output


def board_attachment(board, moves=()):
    filename = "othello_board.png"
    return discord.File(render_board_image(board, moves), filename=filename), f"attachment://{filename}"


def new_board():
    b = [[EMPTY] * 8 for _ in range(8)]
    b[3][3], b[4][4], b[3][4], b[4][3] = WHITE, WHITE, BLACK, BLACK
    return b


def captures(board, player, row, col):
    if not (0 <= row < 8 and 0 <= col < 8) or board[row][col] != EMPTY:
        return []
    other = WHITE if player == BLACK else BLACK
    found = []
    for dr, dc in DIRECTIONS:
        path, r, c = [], row + dr, col + dc
        while 0 <= r < 8 and 0 <= c < 8 and board[r][c] == other:
            path.append((r, c)); r += dr; c += dc
        if path and 0 <= r < 8 and 0 <= c < 8 and board[r][c] == player:
            found.extend(path)
    return found


def legal_moves(board, player):
    return [(r, c) for r in range(8) for c in range(8) if captures(board, player, r, c)]


def play_move(board, player, row, col):
    flipped = captures(board, player, row, col)
    if not flipped:
        return False
    board[row][col] = player
    for r, c in flipped:
        board[r][c] = player
    return True


async def record_result(g) -> str:
    """対人戦の結果をランキングと Elo レートに記録し、レート表示の1行を返す。

    CPU戦は対人戦と混ぜないため記録しない。勝敗は party_ranking の勝数と
    core/game/game/elo.py のレートの両方へ。引き分けは勝数を付けないが、レートは
    標準どおり 0.5 同士で計算する。時間切れの連続で途中終了した場合も、
    その時点の石数で勝敗が付く以上は通常の決着と同じく記録する。
    """
    if g.mode == "cpu":
        return ""
    black, white = g.score()
    black_p = g.players.get(BLACK)
    white_p = g.players.get(WHITE)
    if black_p is None or white_p is None:
        return ""
    if black == white:
        result = elo.record_draw_safely(g.guild_id, GAME_ID, black_p.id, white_p.id)
        if result:
            return elo.format_draw_line(black_p, white_p, result)
        return ""
    winner = black_p if black > white else white_p
    loser = white_p if black > white else black_p
    await party_ranking.shared().record_win(g.guild_id, winner.id, GAME_ID)
    result = elo.record_match_safely(g.guild_id, GAME_ID, winner.id, loser.id)
    return elo.format_match_line(winner, loser, result)


def _copy_board(board):
    return [row[:] for row in board]


def _apply_move_copy(board, player, move):
    result = _copy_board(board)
    play_move(result, player, *move)
    return result


def _ai_score(board, player):
    opponent = WHITE if player == BLACK else BLACK
    corners = {(0, 0), (0, 7), (7, 0), (7, 7)}
    score = sum(cell == player for row in board for cell in row) - sum(cell == opponent for row in board for cell in row)
    score += 18 * sum(board[r][c] == player for r, c in corners)
    score -= 18 * sum(board[r][c] == opponent for r, c in corners)
    score += 3 * (len(legal_moves(board, player)) - len(legal_moves(board, opponent)))
    return score


def _ai_minimax(board, turn, ai_color, depth, alpha, beta):
    moves = legal_moves(board, turn)
    opponent = WHITE if turn == BLACK else BLACK
    if depth == 0 or not moves:
        return _ai_score(board, ai_color), None
    maximizing = turn == ai_color
    best = -float("inf") if maximizing else float("inf")
    best_move = None
    for move in moves:
        score, _ = _ai_minimax(_apply_move_copy(board, turn, move), opponent, ai_color, depth - 1, alpha, beta)
        if (maximizing and score > best) or (not maximizing and score < best):
            best, best_move = score, move
        if maximizing:
            alpha = max(alpha, best)
        else:
            beta = min(beta, best)
        if beta <= alpha:
            break
    return best, best_move


def choose_ai_move(board, player=WHITE, difficulty=5):
    difficulty = max(1, min(10, int(difficulty)))
    moves = legal_moves(board, player)
    if not moves:
        return None
    if difficulty <= 2:
        return random.choice(moves)
    depth = 1 if difficulty <= 4 else 2 if difficulty <= 7 else 3
    _, move = _ai_minimax(board, player, player, depth, -float("inf"), float("inf"))
    return move or random.choice(moves)


def render(board):
    header = "  A B C D E F G H"
    rows = [f"{r+1} " + " ".join(board[r]) for r in range(8)]
    return "```\n" + header + "\n" + "\n".join(rows) + "\n```"


class OthelloGame:
    def __init__(self, channel_id, guild_id, host_id, mode="human", difficulty=5):
        self.channel_id, self.guild_id, self.host_id = channel_id, guild_id, host_id
        self.players = {}
        self.board = new_board()
        self.turn = BLACK
        self.pass_count = 0
        self.acted = False
        self.phase = "recruit"
        self.mode = mode
        self.difficulty = max(1, min(10, int(difficulty)))

    def current_user(self):
        return self.players[BLACK if self.turn == BLACK else WHITE]

    def score(self):
        return sum(cell == BLACK for row in self.board for cell in row), sum(cell == WHITE for row in self.board for cell in row)


def board_panel(title: str, body: str, filename: str = "othello_board.png") -> GamePanelView:
    """盤面画像つきの表示専用パネル（開始・通知・終了表示用）。"""
    return board_image_panel(title, body, filename)


class OthelloMoveSelect(discord.ui.Select):
    def __init__(self, cog, game, moves):
        self.cog, self.game, self.moves = cog, game, moves
        options = [discord.SelectOption(label=f"{label}番", value=label)
                   for label, _ in labelled_moves(moves)[:SELECT_PAGE_SIZE]]
        super().__init__(placeholder="置き場所の番号を選んでください", options=options)

    async def callback(self, interaction):
        current_user = self.game.current_user()
        if (self.game.phase != "playing" or self.game.acted or current_user is None or
                current_user.id != interaction.user.id):
            return await interaction.response.send_message(
                GAME_MSG_ONLY_CURRENT_PLAYER, ephemeral=True
            )
        await interaction.response.defer()
        label = self.values[0]
        move = dict(labelled_moves(self.moves)).get(label)
        if move in legal_moves(self.game.board, self.game.turn):
            self.game.acted = play_move(self.game.board, self.game.turn, *move)


class OthelloMovePanel(GamePanelView):
    """番号セレクトつきの手番パネル（V2）。合法手が多いときはセレクトを分ける。"""

    def __init__(self, cog, game, moves, body: str = ""):
        super().__init__("", body, timeout=TURN_SECONDS)
        gallery = discord.ui.MediaGallery()
        gallery.add_item(media="attachment://othello_board.png")
        self.add_extra(gallery)
        self.selects = []
        for start in range(0, len(moves), SELECT_PAGE_SIZE):
            select = OthelloMoveSelect(cog, game, moves[start:start + SELECT_PAGE_SIZE])
            self.selects.append(select)
            self.add_row(select)


OthelloMoveView = OthelloMovePanel  # 互換名


class Othello(commands.Cog):
    def __init__(self, bot):
        self.bot, self.games = bot, {}

    @staticmethod
    def player_label(game, color):
        """プレイヤーまたはCPUの表示名を返す。"""
        player = game.players[color]
        return "CPU" if player is None else player.mention

    async def start_recruit(self, interaction, mode="human", difficulty=5):
        channel = interaction.channel
        if channel.id in self.games:
            return await interaction.response.send_message("このチャンネルでは既にゲーム中です。", ephemeral=True)
        g = OthelloGame(channel.id, interaction.guild_id, interaction.user.id, mode, difficulty)
        if mode == "cpu":
            g.players[BLACK] = interaction.user
            g.players[WHITE] = None
            self.games[channel.id] = g
            await interaction.response.send_message(f"オセロCPU対戦（難易度 {g.difficulty}/10）を開始します。")
            try:
                await self.run_game(channel, g)
            finally:
                g.phase = "done"
                self.games.pop(channel.id, None)
                self._clear_snapshot(channel.id)
            return
        g.players[interaction.user.id] = interaction.user
        self.games[channel.id] = g
        await interaction.response.send_message("オセロの募集を開始しました。")
        try:
            lobby = LobbyView(
                title="オセロ 参加者募集", host=interaction.user,
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
            g.phase = "done"
            self.games.pop(channel.id, None)
            self._clear_snapshot(channel.id)

    async def run_game(self, channel, g):
        if len(g.players) != 2:
            await channel.send("参加者が2人集まらなかったため、オセロを開始できませんでした。")
            return
        g.phase = "playing"
        if g.mode != "cpu":
            g.players[BLACK], g.players[WHITE] = list(g.players.values())
        file, image_url = board_attachment(g.board)
        await channel.send(view=board_panel("", "オセロを開始します。黒（●）が先手です。"), file=file)
        await self._play_loop(channel, g)

    async def _play_loop(self, channel, g):
        idle = 0
        while g.phase == "playing":
            # 手番開始時点をチェックポイントとして保存する（復旧はここから再開する）
            self._save_snapshot(g)
            moves = legal_moves(g.board, g.turn)
            if not moves:
                g.pass_count += 1
                if g.pass_count >= 2 or all(cell != EMPTY for row in g.board for cell in row):
                    break
                g.turn = WHITE if g.turn == BLACK else BLACK
                file, image_url = board_attachment(g.board)
                passed_color = BLACK if g.turn == WHITE else WHITE
                # パス通知は次の手番パネルに置き換わるまでの暫定表示として
                # 追跡パネルに出す（次の replace / 終了時の clear で消える）。
                await game_panels.replace(
                    channel, "party", file=file,
                    view=board_panel("", f"{self.player_label(g, passed_color)} さんは置ける場所がないためパス。"))
                continue
            if g.mode == "cpu" and g.turn == WHITE:
                move = await asyncio.to_thread(choose_ai_move, g.board, WHITE, g.difficulty)
                play_move(g.board, WHITE, *move)
                g.pass_count = 0
                g.turn = BLACK
                continue
            g.acted = False
            color, uid = g.turn, g.current_user().id
            labelled_moves(moves)
            file, image_url = board_attachment(g.board, moves)
            body = (f"{g.players[color].mention} さんの番（{ '黒 ●' if color == BLACK else '白 ○'}）。\n"
                    "盤面画像の番号をセレクトメニューから選んでください。")
            turn_message = await game_panels.replace(channel, "party", file=file,
                                                     view=OthelloMovePanel(self, g, moves, body))
            for _ in range(TURN_SECONDS):
                if g.acted or g.phase != "playing": break
                await asyncio.sleep(1)
            if g.acted:
                idle = 0
                g.pass_count = 0
                g.turn = WHITE if color == BLACK else BLACK
            else:
                idle += 1
                # 時間切れパスも暫定表示として追跡パネルへ（次で置き換わる）。
                await game_panels.replace(
                    channel, "party",
                    view=text_panel("", f"{self.player_label(g, color)} さんは時間切れのためパスしました。"))
                g.pass_count += 1
                g.turn = WHITE if color == BLACK else BLACK
                if idle >= 2: break
        g.phase = "done"
        black, white = g.score()
        winner = BLACK if black > white else WHITE
        outcome = "引き分け" if black == white else f"勝者: {self.player_label(g, winner)}"
        rating_line = await record_result(g)
        if rating_line:
            outcome += f"\n{rating_line}"
        if g.mode == "cpu":
            outcome += "\n（CPU戦はランキングに記録されません）"
        file, image_url = board_attachment(g.board)
        # 役割を終えた手番パネルを片付け、結果（盤面つき）だけを残す。
        await game_panels.clear(channel, "party")
        await channel.send(view=board_panel("オセロ 終了", f"{outcome}\n黒: {black} / 白: {white}"), file=file)

    # ------------------------------------------------------------------
    # 再起動復旧（core/game/game/game_restore.py）
    # ------------------------------------------------------------------
    def _save_snapshot(self, g):
        if g.phase != "playing":
            return
        black = g.players.get(BLACK)
        white = g.players.get(WHITE)
        state = {
            "mode": g.mode,
            "difficulty": g.difficulty,
            "host_id": g.host_id,
            "players": {
                "black": game_restore.member_ref(black) if black is not None else None,
                "white": game_restore.member_ref(white) if white is not None else None,
            },
            "board": ["".join(row) for row in g.board],
            "turn": g.turn,
            "pass_count": g.pass_count,
        }
        game_restore.save_session("othello", g.channel_id, g.guild_id, state)

    def _clear_snapshot(self, channel_id) -> None:
        game_restore.clear_session("othello", channel_id)

    async def restore_after_restart(self) -> None:
        """再起動前に進行中だったオセロを、手番の開始時点から再開する。"""
        entries = game_restore.session_entries("othello")
        for channel_id, entry in entries.items():
            try:
                restored = await self._restore_session(channel_id, entry)
            except Exception:
                logger.exception("channel %s: オセロの復旧に失敗しました", channel_id)
                restored = False
            if not restored:
                game_restore.clear_session("othello", channel_id)
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
        g = OthelloGame(channel_id, guild_id, state.get("host_id"),
                        state.get("mode") or "human", state.get("difficulty") or 5)
        players = state.get("players") or {}
        for key, color in (("black", BLACK), ("white", WHITE)):
            ref = players.get(key)
            if ref is None:
                if g.mode == "cpu":
                    g.players[color] = None
                    continue
                return False
            g.players[color] = game_restore.resolve_member(
                guild, ref.get("id"), ref.get("name"))
        board = state["board"]
        if len(board) != 8 or any(len(row) != 8 for row in board):
            return False
        g.board = [list(row) for row in board]
        if state.get("turn") in (BLACK, WHITE):
            g.turn = state["turn"]
        g.pass_count = int(state.get("pass_count") or 0)
        g.phase = "playing"
        self.games[channel_id] = g
        asyncio.create_task(self._run_restored_session(channel, g))
        return True

    async def _run_restored_session(self, channel, g):
        try:
            await self._play_loop(channel, g)
        except Exception:
            logger.exception("channel %s: 復旧したオセロの進行に失敗しました", g.channel_id)
        finally:
            g.phase = "done"
            if self.games.get(g.channel_id) is g:
                self.games.pop(g.channel_id, None)
            self._clear_snapshot(g.channel_id)


async def setup(bot):
    await bot.add_cog(Othello(bot))
