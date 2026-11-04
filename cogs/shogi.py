"""/game の将棋（2人対戦、セレクト・座標入力、手駒・二歩対応）。"""
import asyncio
import io
import random
from copy import deepcopy
from pathlib import Path

import discord
from discord.ext import commands
from core import game_panels
from PIL import Image, ImageDraw, ImageFont

from core.shogi_engine import ShogiGame, Color, PieceType, Piece

COLOR = 0x8b4513
RECRUIT_SECONDS = 45
TURN_SECONDS = 90
ASSET_DIR = Path(__file__).resolve().parents[1] / "Assets" / "shogi"
SQUARE_SIZE = 68
MARGIN = 140
BOARD_SIZE = 9 * SQUARE_SIZE
IMG_W = BOARD_SIZE + 2 * MARGIN
IMG_H = BOARD_SIZE + 2 * MARGIN
MOVE_LABELS = tuple("123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ")
REACTION_PAGE_SIZE = 16
NEXT_PAGE = discord.PartialEmoji(name="Right", id=1561698129655373845)
PREV_PAGE = discord.PartialEmoji(name="Left", id=1561698207757500537)
HAND_EMOJI = "✋"
CANCEL_EMOJI = "<:Back:1561700549236097034>"


SHOGI_VALUES = {
    PieceType.PAWN: 100, PieceType.LANCE: 300, PieceType.KNIGHT: 350,
    PieceType.SILVER: 500, PieceType.GOLD: 600, PieceType.BISHOP: 800,
    PieceType.ROOK: 1000, PieceType.KING: 20000,
}


def _is_forced_promotion(piece, to_rank) -> bool:
    """True when moving ``piece`` to ``to_rank`` forces promotion.

    Mirrors the forced-promotion rules applied by the engine in
    ShogiGame._apply_move_unchecked: pawns/lances on the last rank and
    knights on the last two ranks have no non-promoting move.
    """
    if piece is None or piece.promoted:
        return False
    if piece.type in (PieceType.PAWN, PieceType.LANCE):
        return to_rank == 0 if piece.color == Color.SENTE else to_rank == 8
    if piece.type == PieceType.KNIGHT:
        return to_rank <= 1 if piece.color == Color.SENTE else to_rank >= 7
    return False


def _shogi_candidates(game):
    candidates = []
    for source in game.get_legal_selectable_pieces():
        piece = game.board[source[0]][source[1]]
        for dest in game.legal_destinations(*source):
            if game.can_promote(piece, source[0], dest[0]) and not _is_forced_promotion(piece, dest[0]):
                # Optional promotion: offer both variants to the AI.
                candidates.append((source, dest, False, None))
                candidates.append((source, dest, True, None))
            elif game.can_promote(piece, source[0], dest[0]):
                candidates.append((source, dest, True, None))
            else:
                candidates.append((source, dest, False, None))
    for piece_type in game.get_hand_pieces():
        for dest in game.get_drop_squares(piece_type):
            if game._move_is_legal(None, dest, drop_type=piece_type):
                candidates.append((None, dest, False, piece_type))
    return candidates


def _shogi_eval(game, side):
    score = 0
    for row in game.board:
        for piece in row:
            if piece:
                value = SHOGI_VALUES[piece.type] * (1.15 if piece.promoted else 1)
                score += value if piece.color == side else -value
    for color, sign in ((side, 1), (Color.SENTE if side == Color.GOTE else Color.GOTE, -1)):
        score += sign * sum(SHOGI_VALUES[piece_type] * count / 4 for piece_type, count in game.hands[color].items())
    return score


def choose_ai_move(game, difficulty=5):
    """将棋のCPU手。難易度1〜10でランダム性と読みの深さを調整する。"""
    difficulty = max(1, min(10, int(difficulty)))
    candidates = _shogi_candidates(game)
    if not candidates:
        return None
    if difficulty <= 2:
        return random.choice(candidates)
    scored = []
    side = game.turn
    for candidate in candidates:
        trial = deepcopy(game)
        source, dest, promote, drop_type = candidate
        if not trial.make_move(source, dest, promote=promote, drop_type=drop_type):
            continue
        score = _shogi_eval(trial, side)
        # capture and promotion preferences are intentionally stronger at higher levels
        if source is not None and game.board[dest[0]][dest[1]] is not None:
            score += 180 * difficulty
        if promote:
            score += 40 * difficulty
        score += random.uniform(-120, 120) * max(0, 10 - difficulty) / 10
        scored.append((score, candidate))
    if not scored:
        return random.choice(candidates)
    return max(scored, key=lambda item: item[0])[1]

def reaction_emoji(label: str) -> str:
    if label in "123456789" and len(label) == 1:
        return f"{label}\ufe0f\u20e3"
    if label in MOVE_LABELS[9:] and len(label) == 1:
        return chr(0x1F1E6 + ord(label) - ord("A"))
    raise ValueError(label)

class ShogiRenderer:
    def __init__(self):
        self.font_label = ImageFont.truetype(str(ASSET_DIR.parent.parent / "font.ttf"), 16)
        self.font_hand = ImageFont.truetype(str(ASSET_DIR.parent.parent / "font.ttf"), 18)
        self.cache = {}

    def _piece_img(self, piece: Piece) -> Image.Image:
        is_gote = piece.color == Color.GOTE
        base = {
            PieceType.KING: "王.png" if not is_gote else "玉.png",
            PieceType.ROOK: "飛.png",
            PieceType.BISHOP: "角.png",
            PieceType.GOLD: "金.png",
            PieceType.SILVER: "銀.png",
            PieceType.KNIGHT: "桂.png",
            PieceType.LANCE: "香.png",
            PieceType.PAWN: "歩.png",
        }.get(piece.type, "なし.png")
        if piece.promoted:
            if piece.type == PieceType.PAWN:
                base = "と金赤.png" if is_gote else "と金.png"
            elif piece.type == PieceType.ROOK:
                base = "龍赤.png" if is_gote else "龍.png"
            elif piece.type == PieceType.BISHOP:
                base = "馬赤.png" if is_gote else "馬.png"
            elif piece.type == PieceType.SILVER:
                base = "成銀赤.png" if is_gote else "成銀.png"
            elif piece.type == PieceType.KNIGHT:
                base = "成桂赤.png" if is_gote else "成桂.png"
            elif piece.type == PieceType.LANCE:
                base = "成香赤.png" if is_gote else "成香.png"
        path = ASSET_DIR / base
        if not path.exists():
            # 一部素材は別名・片側のみ提供されているため、透明画像ではなく
            # 対応する実在素材を使う。将来的に正式な成駒素材を追加しても、
            # この候補順で自動的にそちらを優先する。
            aliases = {
                "成桂.png": "成桂 .png",
                "成銀赤.png": "成銀.png",
                "成桂赤.png": "成桂赤.png",
                "成香.png": "香.png",
                "成香赤.png": "香.png",
            }
            path = ASSET_DIR / aliases.get(base, {
                "成銀赤.png": "銀.png",
                "成桂赤.png": "桂.png",
                "成香赤.png": "香.png",
            }.get(base, base))
        if not path.exists():
            path = ASSET_DIR / {
                PieceType.PAWN: "歩.png", PieceType.LANCE: "香.png",
                PieceType.KNIGHT: "桂.png", PieceType.SILVER: "銀.png",
                PieceType.GOLD: "金.png", PieceType.BISHOP: "角.png",
                PieceType.ROOK: "飛.png", PieceType.KING: "王.png",
            }[piece.type]
        ck = str(path) + ("g" if is_gote else "") + ("p" if piece.promoted else "")
        if ck not in self.cache:
            try:
                im = Image.open(path).convert("RGBA")
                if is_gote:
                    im = im.rotate(180, expand=False)
                im.thumbnail((SQUARE_SIZE - 6, SQUARE_SIZE - 6), Image.Resampling.LANCZOS)
                self.cache[ck] = im
            except Exception:
                self.cache[ck] = Image.new("RGBA", (40, 40), (0, 0, 0, 0))
        return self.cache[ck]

    def render(self, game: ShogiGame, labels=None, selected=None) -> io.BytesIO:
        img = Image.new("RGB", (IMG_W, IMG_H), "#f4e4c1")
        draw = ImageDraw.Draw(img)
        # Hands
        draw.rectangle([8, 8, MARGIN - 8, IMG_H // 2 - 8], fill="#edd9b0", outline="#654321", width=2)
        draw.rectangle([IMG_W - MARGIN + 8, IMG_H // 2 + 8, IMG_W - 8, IMG_H - 8], fill="#edd9b0", outline="#654321", width=2)
        self._hand(draw, game.hands[Color.GOTE], 16, 16, "後手の手駒")
        self._hand(draw, game.hands[Color.SENTE], IMG_W - MARGIN + 16, IMG_H - MARGIN + 16, "先手の手駒")

        ox = oy = MARGIN
        for i in range(10):
            draw.line([(ox, oy + i * SQUARE_SIZE), (ox + BOARD_SIZE, oy + i * SQUARE_SIZE)], fill="#222", width=1)
            draw.line([(ox + i * SQUARE_SIZE, oy), (ox + i * SQUARE_SIZE, oy + BOARD_SIZE)], fill="#222", width=1)

        if selected:
            r, f = selected
            draw.rectangle([ox + f * SQUARE_SIZE + 2, oy + r * SQUARE_SIZE + 2,
                            ox + (f + 1) * SQUARE_SIZE - 2, oy + (r + 1) * SQUARE_SIZE - 2], outline="#e4572e", width=4)

        for r in range(9):
            for f in range(9):
                p = game.board[r][f]
                if p:
                    pi = self._piece_img(p)
                    img.paste(pi, (ox + f * SQUARE_SIZE + (SQUARE_SIZE - pi.width) // 2,
                                   oy + r * SQUARE_SIZE + (SQUARE_SIZE - pi.height) // 2), pi)

        if labels:
            for label, (r, f) in labels:
                x = ox + f * SQUARE_SIZE + 4
                y = oy + r * SQUARE_SIZE + 2
                draw.rectangle([x - 1, y - 1, x + 18, y + 16], fill="#ffffffee")
                draw.text((x, y), label, fill="#003399", font=self.font_label)

        buf = io.BytesIO()
        img.save(buf, format="PNG", optimize=True)
        buf.seek(0)
        return buf

    def _hand(self, draw, hand, x, y, title):
        draw.text((x, y), title, fill="#333", font=self.font_hand)
        yy = y + 26
        for pt in PieceType:
            if hand[pt] > 0:
                draw.text((x, yy), f"{pt.value}×{hand[pt]}", fill="#222", font=self.font_hand)
                yy += 22

class ShogiSession:
    def __init__(self, channel_id, guild_id, host_id, mode="human", difficulty=5):
        self.channel_id = channel_id
        self.guild_id = guild_id
        self.host_id = host_id
        self.players = {}
        self.game = ShogiGame()
        self.phase = "recruit"
        self.state = "select_piece"
        self.selected = None
        self.selected_drop = None
        self.pending_from = None
        self.pending_to = None
        self.acted = False
        self.renderer = ShogiRenderer()
        self.current_msg = None
        self.mode = mode
        self.difficulty = max(1, min(10, int(difficulty)))

class JoinView(discord.ui.View):
    def __init__(self, session):
        super().__init__(timeout=RECRUIT_SECONDS + 30)
        self.session = session

    @discord.ui.button(label="参加（先手/後手）", style=discord.ButtonStyle.success)
    async def join(self, interaction, button):
        s = self.session
        if s.phase != "recruit":
            return await interaction.response.send_message("募集終了", ephemeral=True)
        if interaction.user.id in s.players:
            return await interaction.response.send_message("既に参加中", ephemeral=True)
        if len(s.players) >= 2:
            return await interaction.response.send_message("定員", ephemeral=True)
        s.players[interaction.user.id] = interaction.user
        await interaction.response.send_message("参加しました", ephemeral=True)

    @discord.ui.button(label="抜ける", style=discord.ButtonStyle.secondary)
    async def leave(self, interaction, button):
        s = self.session
        if s.phase != "recruit" or interaction.user.id not in s.players or interaction.user.id == s.host_id:
            return await interaction.response.send_message("抜けられません", ephemeral=True)
        del s.players[interaction.user.id]
        await interaction.response.send_message("参加を取り消しました", ephemeral=True)


class ShogiMoveSelect(discord.ui.Select):
    def __init__(self, cog, session, labels):
        self.cog, self.session, self.labels = cog, session, dict(labels)
        options = [
            discord.SelectOption(
                label=(f"{label}番" if isinstance(pos, tuple) else f"{label}番: {pos.value}"),
                value=label,
            )
            for label, pos in labels[:25]
        ]
        super().__init__(placeholder="番号を選んでください", options=options)

    async def callback(self, interaction):
        await self.cog.handle_select(interaction, self.session, self.labels, self.values[0])


class ShogiMoveView(discord.ui.View):
    def __init__(self, cog, session, labels):
        super().__init__(timeout=TURN_SECONDS)
        state = getattr(session, "state", "select_piece")
        if labels:
            self.add_item(ShogiMoveSelect(cog, session, labels))
        if state == "select_piece":
            self.add_item(ShogiHandButton(cog, session))
        elif state in ("select_dest", "select_hand", "select_drop_dest"):
            self.add_item(ShogiCancelButton(cog, session))
        if state in ("select_piece", "select_dest", "select_drop_dest"):
            self.add_item(ShogiCoordinateButton(cog, session))


class ShogiPromoteView(discord.ui.View):
    """「成る / 成らない」の2ボタンで任意成りを選ばせるビュー。

    選択されるまで手は実行されない。タイムアウトした場合は何も実行されず、
    手番タイマー側で時間切れとして扱われる。
    """

    def __init__(self, cog, session):
        super().__init__(timeout=TURN_SECONDS)
        self.cog, self.session = cog, session

    @discord.ui.button(label="成る", style=discord.ButtonStyle.success)
    async def promote(self, interaction, button):
        await self.cog.handle_promote_choice(interaction, self.session, True)

    @discord.ui.button(label="成らない", style=discord.ButtonStyle.secondary)
    async def not_promote(self, interaction, button):
        await self.cog.handle_promote_choice(interaction, self.session, False)


class ShogiHandButton(discord.ui.Button):
    def __init__(self, cog, session):
        super().__init__(label="持ち駒を使う", style=discord.ButtonStyle.primary)
        self.cog, self.session = cog, session

    async def callback(self, interaction):
        await self.cog.handle_hand(interaction, self.session)


class ShogiCancelButton(discord.ui.Button):
    def __init__(self, cog, session):
        super().__init__(label="戻る", style=discord.ButtonStyle.secondary)
        self.cog, self.session = cog, session

    async def callback(self, interaction):
        await self.cog.handle_cancel(interaction, self.session)


class ShogiCoordinateModal(discord.ui.Modal, title="盤面の座標を入力"):
    coordinate = discord.ui.TextInput(
        label="行・列（例: 44 / 18）",
        placeholder="1〜9の数字を2桁で入力",
        min_length=2,
        max_length=2,
    )

    def __init__(self, cog, session):
        super().__init__()
        self.cog, self.session = cog, session

    async def on_submit(self, interaction):
        await self.cog.handle_coordinate_input(interaction, self.session, str(self.coordinate.value))


class ShogiCoordinateButton(discord.ui.Button):
    def __init__(self, cog, session):
        super().__init__(label="座標を入力", style=discord.ButtonStyle.secondary)
        self.cog, self.session = cog, session

    async def callback(self, interaction):
        await interaction.response.send_modal(ShogiCoordinateModal(self.cog, self.session))


class Shogi(commands.Cog):
    def __init__(self, bot):
        self.bot = bot
        self.sessions = {}
        self.reaction_sessions = {}

    async def _add_reactions(self, msg, emojis):
        # Parallel-ish for speed
        tasks = [msg.add_reaction(e) for e in emojis]
        await asyncio.gather(*tasks, return_exceptions=True)

    async def _clear_reactions(self, msg):
        try:
            await msg.clear_reactions()
        except Exception:
            pass

    def _needs_promote_choice(self, s, from_pos, to_pos) -> bool:
        """True when the move may optionally promote and the player must choose."""
        piece = s.game.board[from_pos[0]][from_pos[1]]
        if piece is None:
            return False
        return (s.game.can_promote(piece, from_pos[0], to_pos[0])
                and not _is_forced_promotion(piece, to_pos[0]))

    async def _begin_promote_choice(self, s, channel, from_pos, to_pos):
        """Park the move and ask 成る/成らない before executing it."""
        s.pending_from = from_pos
        s.pending_to = to_pos
        s.state = "select_promote"
        await self._update_board_msg(
            s, channel, "この駒を成りますか？「成る」か「成らない」を選んでください。",
            labels=None, selected=from_pos,
        )

    async def handle_promote_choice(self, interaction, s, promote):
        await interaction.response.defer()
        if s.phase != "playing" or s.acted or s.state != "select_promote":
            return
        from_pos, to_pos = s.pending_from, s.pending_to
        if from_pos is None or to_pos is None:
            return
        if s.game.make_move(from_pos, to_pos, promote=promote):
            s.pending_from = s.pending_to = None
            s.acted = True
            return
        await interaction.followup.send("その手は指せません。", ephemeral=True)
        s.pending_from = s.pending_to = None
        s.state = "select_dest"
        dests = s.game.legal_destinations(*from_pos)
        channel = getattr(interaction, "channel", None)
        if channel is not None and dests:
            await self._update_board_msg(
                s, channel, f"移動先の番号を選んでください（{len(dests)}箇所）。",
                labels=list(zip(MOVE_LABELS, dests))[:REACTION_PAGE_SIZE], selected=from_pos,
            )

    async def handle_select(self, interaction, s, labels, label):
        await interaction.response.defer()
        pos = labels.get(label)
        if s.phase != "playing" or s.acted:
            return
        if s.state == "select_piece":
            if not isinstance(pos, tuple):
                return
            s.selected = pos
            dests = s.game.legal_destinations(*pos)
            if not dests:
                return
            s.state = "select_dest"
            dest_labels = list(zip(MOVE_LABELS, dests))[:REACTION_PAGE_SIZE]
            await self._update_board_msg(s, interaction.message.channel,
                                          f"移動先の番号を選んでください（{len(dests)}箇所）。",
                                          labels=dest_labels, selected=pos)
        elif s.state == "select_dest" and s.selected:
            if not isinstance(pos, tuple):
                return
            if self._needs_promote_choice(s, s.selected, pos):
                await self._begin_promote_choice(s, interaction.message.channel, s.selected, pos)
                return
            if s.game.make_move(s.selected, pos, promote=False):
                s.acted = True
            else:
                await interaction.followup.send("その手は指せません。", ephemeral=True)
        elif s.state == "select_hand" and isinstance(pos, PieceType):
            drops = s.game.get_drop_squares(pos)
            if not drops:
                await interaction.followup.send("打てる場所がありません。", delete_after=3)
                return
            s.selected_drop = pos
            s.state = "select_drop_dest"
            await self._update_board_msg(
                s, interaction.channel, "打ち場所を選択してください。",
                labels=list(zip(MOVE_LABELS, drops)), extra_emojis=None,
            )
        elif s.state == "select_drop_dest" and isinstance(pos, tuple):
            if s.game.make_move(None, pos, drop_type=s.selected_drop):
                s.acted = True
            else:
                await interaction.followup.send("その場所には打てません。", ephemeral=True)

    async def handle_coordinate_input(self, interaction, s, text):
        await interaction.response.defer()
        if s.phase != "playing" or s.acted or len(text) != 2 or not text.isdigit():
            return
        row, col = (int(value) - 1 for value in text)
        if not (0 <= row < 9 and 0 <= col < 9):
            return await interaction.followup.send("座標は11〜99の範囲で入力してください。", ephemeral=True)
        pos = (row, col)
        if s.state == "select_piece":
            if not s.game.legal_destinations(*pos):
                return await interaction.followup.send("その座標の駒は選択できません。", ephemeral=True)
            s.selected = pos
            dests = s.game.legal_destinations(*pos)
            s.state = "select_dest"
            await self._update_board_msg(s, interaction.channel, f"移動先を選択してください（{len(dests)}箇所）。", labels=list(zip(MOVE_LABELS, dests)), selected=pos)
        elif s.state == "select_dest" and s.selected:
            if self._needs_promote_choice(s, s.selected, pos):
                await self._begin_promote_choice(s, interaction.channel, s.selected, pos)
                return
            if s.game.make_move(s.selected, pos, promote=False):
                s.acted = True
            else:
                await interaction.followup.send("その手は指せません。", ephemeral=True)
        elif s.state == "select_drop_dest" and s.selected_drop:
            if s.game.make_move(None, pos, drop_type=s.selected_drop):
                s.acted = True
            else:
                await interaction.followup.send("その場所には打てません。", ephemeral=True)

    async def handle_hand(self, interaction, s):
        await interaction.response.defer()
        if s.phase != "playing" or s.acted:
            return
        hand_pieces = s.game.get_hand_pieces()
        if not hand_pieces:
            return await interaction.followup.send("持ち駒がありません。", ephemeral=True)
        s.state = "select_hand"
        hand_labels = [(str(index), piece_type) for index, piece_type in enumerate(hand_pieces, 1)]
        await self._update_board_msg(s, interaction.channel, "持ち駒を選択してください。", labels=hand_labels)

    async def handle_cancel(self, interaction, s):
        await interaction.response.defer()
        if s.phase != "playing" or s.acted:
            return
        s.state = "select_piece"
        s.selected = None
        s.selected_drop = None
        s.pending_from = None
        s.pending_to = None
        selectables = s.game.get_legal_selectable_pieces()
        await self._update_board_msg(s, interaction.channel, "駒を選択してください。", labels=list(zip(MOVE_LABELS, selectables)))

    async def start_recruit(self, interaction, mode="human", difficulty=5):
        ch = interaction.channel
        if ch.id in self.sessions:
            return await interaction.response.send_message("このチャンネルでは既に将棋中です。", ephemeral=True)
        s = ShogiSession(ch.id, interaction.guild_id, interaction.user.id, mode, difficulty)
        if mode == "cpu":
            s.players[Color.SENTE] = interaction.user
            s.players[Color.GOTE] = None
            self.sessions[ch.id] = s
            await interaction.response.send_message(f"将棋CPU対戦（難易度 {s.difficulty}/10）を開始します。", ephemeral=True)
            try:
                await self.run_game(ch, s)
            finally:
                s.phase = "done"
                self.sessions.pop(ch.id, None)
            return
        s.players[interaction.user.id] = interaction.user
        self.sessions[ch.id] = s
        await interaction.response.send_message("将棋の募集を開始しました。", ephemeral=True)
        try:
            msg = await game_panels.replace(ch, "party", embed=discord.Embed(
                title="将棋 参加者募集", description=f"{interaction.user.mention} さんが募集中です。\n{RECRUIT_SECONDS}秒以内に参加してください（2人対戦）。", color=COLOR),
                view=JoinView(s))
            await asyncio.sleep(RECRUIT_SECONDS)
            await self.run_game(ch, s)
        finally:
            s.phase = "done"
            self.sessions.pop(ch.id, None)

    async def _update_board_msg(self, s: ShogiSession, channel, description, labels=None, selected=None, extra_emojis=None):
        buf = s.renderer.render(s.game, labels=labels, selected=selected)
        file = discord.File(buf, "shogi.png")
        embed = discord.Embed(description=description, color=COLOR)
        embed.set_image(url="attachment://shogi.png")
        if labels:
            select_view = ShogiMoveView(self, s, labels)
        elif getattr(s, "state", None) == "select_promote":
            select_view = ShogiPromoteView(self, s)
        else:
            select_view = None
        if s.current_msg is None:
            s.current_msg = await game_panels.replace(channel, "party", embed=embed, file=file,
                                                      view=select_view)
        else:
            try:
                await s.current_msg.edit(embed=embed, attachments=[file], view=select_view)
            except Exception:
                # Fallback if edit fails
                s.current_msg = await game_panels.replace(channel, "party", embed=embed, file=file,
                                                          view=select_view)
        # 将棋の操作はセレクトメニューと座標入力に統一し、リアクションは追加しない。
        self.reaction_sessions.pop(s.current_msg.id, None)

    async def run_game(self, channel, s: ShogiSession):
        if len(s.players) != 2:
            await channel.send("参加者が2人集まらなかったため開始できませんでした。")
            return
        s.phase = "playing"
        if s.mode != "cpu":
            ids = list(s.players.values())
            s.players = {Color.SENTE: ids[0], Color.GOTE: ids[1]}
        if s.mode == "cpu":
            await channel.send(f"将棋CPU対戦開始！ 先手: {s.players[Color.SENTE].mention} / 後手: CPU（難易度 {s.difficulty}/10）")
        else:
            await channel.send(f"将棋開始！ 先手: {ids[0].mention} / 後手: {ids[1].mention}")
        idle = 0
        while s.phase == "playing":
            if s.game.is_checkmate(s.game.turn):
                winner = s.players[Color.GOTE if s.game.turn == Color.SENTE else Color.SENTE]
                await channel.send(f"詰みです。{winner.mention} さんの勝利です。")
                break
            if not s.game.has_legal_move(s.game.turn):
                await channel.send("合法な指し手がないため、対局を終了します。")
                break
            if s.mode == "cpu" and s.game.turn == Color.GOTE:
                move = await asyncio.to_thread(choose_ai_move, s.game, s.difficulty)
                if move is None:
                    break
                source, dest, promote, drop_type = move
                s.game.make_move(source, dest, promote=promote, drop_type=drop_type)
                continue
            turn_user = s.players[s.game.turn]
            s.acted = False
            s.state = "select_piece"
            s.selected = None
            s.selected_drop = None
            s.pending_from = None
            s.pending_to = None
            selectables = s.game.get_legal_selectable_pieces()
            labels = list(zip(MOVE_LABELS, selectables))
            desc = (f"{turn_user.mention} さんの番（{'先手' if s.game.turn == Color.SENTE else '後手'}）。\n"
                    + ("王手を受けています。\n" if s.game.is_in_check(s.game.turn) else "")
                    + "セレクトメニューまたは「座標を入力」から駒を選んでください。")
            await self._update_board_msg(s, channel, desc, labels=labels)
            for _ in range(TURN_SECONDS):
                if s.acted or s.phase != "playing":
                    break
                await asyncio.sleep(1)
            if s.current_msg:
                self.reaction_sessions.pop(s.current_msg.id, None)
            if not s.acted:
                idle += 1
                await channel.send(f"{turn_user.mention} さんは時間切れのためパスしました。")
                if idle >= 2:
                    break
                s.game.turn = Color.GOTE if s.game.turn == Color.SENTE else Color.SENTE
            else:
                idle = 0
        await channel.send("将棋を終了しました。")

    @commands.Cog.listener()
    async def on_reaction_add(self, reaction, user):
        if user.bot:
            return
        session_data = self.reaction_sessions.get(reaction.message.id)
        if not session_data:
            return
        s: ShogiSession = session_data["session"]
        if s.phase != "playing" or s.players.get(s.game.turn, None) is None or s.players[s.game.turn].id != user.id or s.acted:
            return
        emoji = str(reaction.emoji)
        try:
            await reaction.message.remove_reaction(reaction.emoji, user)
        except Exception:
            pass
        labels = session_data.get("labels", {})
        if emoji == HAND_EMOJI and s.state == "select_piece":
            hand_pieces = s.game.get_hand_pieces()
            if not hand_pieces:
                await reaction.message.channel.send("手駒がありません。", delete_after=3)
                return
            # Switch to hand selection
            s.state = "select_hand"
            hand_labels = list(zip(MOVE_LABELS, hand_pieces))[:REACTION_PAGE_SIZE]
            desc = f"{s.players[s.game.turn].mention} さんの手駒選択。打ちたい駒を選んでください。"
            await self._update_board_msg(s, reaction.message.channel, desc, labels=hand_labels, extra_emojis=[CANCEL_EMOJI])
            return
        if emoji == CANCEL_EMOJI and s.state in ("select_hand", "select_drop_dest"):
            s.state = "select_piece"
            s.selected_drop = None
            # Re-show piece selection
            selectables = s.game.get_legal_selectable_pieces()
            labels = list(zip(MOVE_LABELS, selectables))[:REACTION_PAGE_SIZE]
            desc = f"{s.players[s.game.turn].mention} さんの番。駒を選んでください。"
            await self._update_board_msg(s, reaction.message.channel, desc, labels=labels, extra_emojis=[HAND_EMOJI])
            return
        for label, pos in labels.items():
            if reaction_emoji(label) == emoji:
                if s.state == "select_piece":
                    # Select piece, show destinations
                    s.selected = pos
                    dests = s.game.legal_destinations(*pos)
                    if not dests:
                        return
                    s.state = "select_dest"
                    dest_labels = list(zip(MOVE_LABELS, dests))[:REACTION_PAGE_SIZE]
                    desc = f"移動先を選択してください（{len(dests)}箇所）。<:Back:1561700549236097034>でキャンセル。"
                    await self._update_board_msg(s, reaction.message.channel, desc, labels=dest_labels, selected=pos, extra_emojis=[CANCEL_EMOJI])
                elif s.state == "select_dest":
                    # Execute move (optional promotion is chosen via the
                    # select/coordinate flow; forced promotion still applies)
                    success = s.game.make_move(s.selected, pos, promote=False)
                    if success:
                        s.acted = True
                        # Force refresh on next loop
                elif s.state == "select_hand":
                    # pos is PieceType
                    s.selected_drop = pos
                    drops = s.game.get_drop_squares(pos)
                    if not drops:
                        await reaction.message.channel.send("打てる場所がありません。", delete_after=3)
                        return
                    s.state = "select_drop_dest"
                    drop_labels = list(zip(MOVE_LABELS, drops))[:REACTION_PAGE_SIZE]
                    desc = f"打ち場所を選択してください。<:Back:1561700549236097034>でキャンセル。"
                    await self._update_board_msg(s, reaction.message.channel, desc, labels=drop_labels, extra_emojis=[CANCEL_EMOJI])
                elif s.state == "select_drop_dest":
                    success = s.game.make_move(None, pos, drop_type=s.selected_drop)
                    if success:
                        s.acted = True
                break

async def setup(bot):
    await bot.add_cog(Shogi(bot))
