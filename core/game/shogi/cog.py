"""/game の将棋（2人対戦、セレクト・座標入力、手駒・二歩対応）。"""
import asyncio
import io
import logging
import random
from copy import deepcopy
from pathlib import Path
from core.emojis import LEFT, RIGHT

import discord
from discord.ext import commands
from core import party_ranking
from core.game import elo, game_panels, game_restore
from PIL import Image, ImageDraw, ImageFont

from core.game.shogi_engine import ShogiGame, Color, PieceType, Piece

logger = logging.getLogger(__name__)

GAME_ID = "shogi"
party_ranking.register(GAME_ID)


async def record_win(s, winner) -> str:
    """対人戦の勝者をランキングと Elo レートに記録し、レート表示の1行を返す。

    CPU戦は対人戦と混ぜないため記録しない。詰み以外の終了（合法手なし・
    時間切れの連続）は勝者を宣言していないので、どちらにも付けない。
    """
    if s.mode == "cpu" or winner is None:
        return ""
    await party_ranking.shared().record_win(s.guild_id, winner.id, GAME_ID)
    loser = next((m for m in getattr(s, "players", {}).values() if m is not None and getattr(m, "id", None) != winner.id), None)
    if loser is None:
        return ""
    result = elo.record_match_safely(s.guild_id, GAME_ID, winner.id, loser.id)
    return elo.format_match_line(winner, loser, result)

COLOR = 0x8b4513
RECRUIT_SECONDS = 45
TURN_SECONDS = 90
ASSET_DIR = Path(__file__).resolve().parents[3] / "Assets" / "shogi"
SQUARE_SIZE = 68
MARGIN = 140
BOARD_SIZE = 9 * SQUARE_SIZE
IMG_W = BOARD_SIZE + 2 * MARGIN
IMG_H = BOARD_SIZE + 2 * MARGIN
MOVE_LABELS = tuple("123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ")
# Discord の Select は最大25択。候補は1ページ24件までとし、残りの枠を
# ページ移動用の疑似選択肢に使う（前後両方の移動が要る中間ページは23件）。
# ラベルはページ内でのみ一意であればよいので、ページごとに付け直す。
SELECT_PAGE_SIZE = 24
PAGE_NEXT_VALUE = "__next_page__"
PAGE_PREV_VALUE = "__prev_page__"


def _page_starts(total):
    """ページ先頭インデックスの列（容量は先頭ページ24件、中間ページ23件）。"""
    starts = [0]
    while total - starts[-1] > SELECT_PAGE_SIZE:
        capacity = SELECT_PAGE_SIZE if len(starts) == 1 else SELECT_PAGE_SIZE - 1
        starts.append(starts[-1] + capacity)
    return starts


def paginate_labels(labels, page=0):
    """(そのページの (label, pos) 列, ページ番号, 総ページ数) を返す。"""
    labels = list(labels)
    starts = _page_starts(len(labels))
    page = max(0, min(page, len(starts) - 1))
    start = starts[page]
    end = starts[page + 1] if page + 1 < len(starts) else len(labels)
    return labels[start:end], page, len(starts)


def make_labels(positions):
    """候補列にページローカルなラベルを付けた (label, pos) 列を返す。

    打ち駒の移動先のように候補がラベル総数を超える場合でも、ページ単位で
    ラベルを付け直すことで全候補に到達できる。
    """
    positions = list(positions)
    starts = _page_starts(len(positions))
    labels = []
    for page_index, start in enumerate(starts):
        end = starts[page_index + 1] if page_index + 1 < len(starts) else len(positions)
        for local, pos in enumerate(positions[start:end]):
            labels.append((MOVE_LABELS[local], pos))
    return labels


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

_SHOGI_BG_CACHE = None


def _shogi_background() -> Image.Image:
    """盤面画像化タスク（2026-11-06）のリッチ化: ベタ塗りだった背景を
    木目風の縦グラデーション＋盤まわりの縁取りにする。座標系（MARGIN /
    SQUARE_SIZE）・駒素材・持駒表示は従来どおりで、背景だけを差し替える。
    生成は決定的で、プロセス内で1回だけ作ってコピーを返す。"""
    global _SHOGI_BG_CACHE
    if _SHOGI_BG_CACHE is None:
        top = (250, 236, 205)
        bottom = (238, 214, 160)
        strip = Image.new("RGB", (1, IMG_H))
        for y in range(IMG_H):
            t = y / max(1, IMG_H - 1)
            strip.putpixel((0, y), tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3)))
        img = strip.resize((IMG_W, IMG_H))
        draw = ImageDraw.Draw(img, "RGBA")
        rng = random.Random(20261106)
        import math
        for y in range(0, IMG_H, 3):
            alpha = int(5 + 4 * math.sin(y / 29.0) + rng.randint(0, 3))
            draw.line([(0, y), (IMG_W, y)], fill=(150, 108, 48, alpha))
        # 盤の外周に縁取り（盤の内側の座標は変えない）
        draw.rectangle([MARGIN - 6, MARGIN - 6, MARGIN + BOARD_SIZE + 5, MARGIN + BOARD_SIZE + 5],
                       outline=(101, 67, 33), width=3)
        _SHOGI_BG_CACHE = img
    return _SHOGI_BG_CACHE.copy()


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
        img = _shogi_background()
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

def serialize_shogi_game(game: ShogiGame) -> dict:
    """対局状態（盤面・手駒・手番）を JSON 化できる形にする。"""
    board = [
        [
            [piece.type.name, piece.color.name, bool(piece.promoted)] if piece else None
            for piece in row
        ]
        for row in game.board
    ]
    hands = {
        color.name: {pt.name: int(game.hands[color][pt]) for pt in PieceType}
        for color in (Color.SENTE, Color.GOTE)
    }
    return {"board": board, "hands": hands, "turn": game.turn.name}


def deserialize_shogi_game(data: dict) -> ShogiGame:
    """serialize_shogi_game の逆変換。形が壊れていれば ValueError。"""
    board_data = data["board"]
    if len(board_data) != 9 or any(len(row) != 9 for row in board_data):
        raise ValueError("shogi board must be 9x9")
    game = ShogiGame()
    board = []
    for row in board_data:
        new_row = []
        for cell in row:
            if cell is None:
                new_row.append(None)
                continue
            type_name, color_name, promoted = cell
            new_row.append(Piece(PieceType[type_name], Color[color_name], bool(promoted)))
        board.append(new_row)
    game.board = board
    for color in (Color.SENTE, Color.GOTE):
        hand = {pt: 0 for pt in PieceType}
        for type_name, count in (data["hands"].get(color.name) or {}).items():
            hand[PieceType[type_name]] = int(count)
        game.hands[color] = hand
    game.turn = Color[data["turn"]]
    return game


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
        await interaction.response.send_message("参加しました")

    @discord.ui.button(label="抜ける", style=discord.ButtonStyle.secondary)
    async def leave(self, interaction, button):
        s = self.session
        if s.phase != "recruit" or interaction.user.id not in s.players or interaction.user.id == s.host_id:
            return await interaction.response.send_message("抜けられません", ephemeral=True)
        del s.players[interaction.user.id]
        await interaction.response.send_message("参加を取り消しました")


class ShogiMoveSelect(discord.ui.Select):
    def __init__(self, cog, session, labels, page=0):
        self.cog, self.session = cog, session
        self.all_labels = list(labels.items()) if isinstance(labels, dict) else list(labels)
        page_labels, self.page, total_pages = paginate_labels(self.all_labels, page)
        self.labels = dict(page_labels)
        options = [
            discord.SelectOption(
                label=(f"{label}番" if isinstance(pos, tuple) else f"{label}番: {pos.value}"),
                value=label,
            )
            for label, pos in page_labels
        ]
        if total_pages > 1:
            if self.page > 0:
                options.append(discord.SelectOption(label="前のページ", value=PAGE_PREV_VALUE, emoji=LEFT))
            if self.page < total_pages - 1:
                options.append(discord.SelectOption(label="次のページ", value=PAGE_NEXT_VALUE, emoji=RIGHT))
        super().__init__(placeholder="番号を選んでください", options=options)

    async def callback(self, interaction):
        await self.cog.handle_select(interaction, self.session, self.all_labels,
                                     self.values[0], page=self.page)


class ShogiMoveView(discord.ui.View):
    def __init__(self, cog, session, labels, page=0):
        super().__init__(timeout=TURN_SECONDS)
        state = getattr(session, "state", "select_piece")
        if labels:
            self.add_item(ShogiMoveSelect(cog, session, labels, page))
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
                labels=make_labels(dests), selected=from_pos,
            )

    async def _redraw_page(self, interaction, s, items, page):
        """ページ移動時に、現在の状態のまま盤面とセレクトを描き直す（着手しない）。"""
        if s.state == "select_dest":
            desc, selected = f"移動先の番号を選んでください（{len(items)}箇所）。", s.selected
        elif s.state == "select_drop_dest":
            desc, selected = "打ち場所を選択してください。", None
        elif s.state == "select_hand":
            desc, selected = "持ち駒を選択してください。", None
        else:
            desc, selected = "駒を選択してください。", None
        channel = getattr(getattr(interaction, "message", None), "channel", None)
        if channel is None:
            channel = getattr(interaction, "channel", None)
        await self._update_board_msg(s, channel, desc, labels=items, selected=selected, page=page)

    async def handle_select(self, interaction, s, labels, label, page=0):
        await interaction.response.defer()
        items = list(labels.items()) if isinstance(labels, dict) else list(labels)
        if s.phase != "playing" or s.acted:
            return
        if label == PAGE_NEXT_VALUE:
            return await self._redraw_page(interaction, s, items, page + 1)
        if label == PAGE_PREV_VALUE:
            return await self._redraw_page(interaction, s, items, page - 1)
        page_items, _, _ = paginate_labels(items, page)
        pos = dict(page_items).get(label)
        if pos is None:
            return
        if s.state == "select_piece":
            if not isinstance(pos, tuple):
                return
            s.selected = pos
            dests = s.game.legal_destinations(*pos)
            if not dests:
                return
            s.state = "select_dest"
            dest_labels = make_labels(dests)
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
                labels=make_labels(drops),
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
            await self._update_board_msg(s, interaction.channel, f"移動先を選択してください（{len(dests)}箇所）。", labels=make_labels(dests), selected=pos)
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
        await self._update_board_msg(s, interaction.channel, "駒を選択してください。", labels=make_labels(selectables))

    async def start_recruit(self, interaction, mode="human", difficulty=5):
        ch = interaction.channel
        if ch.id in self.sessions:
            return await interaction.response.send_message("このチャンネルでは既に将棋中です。", ephemeral=True)
        s = ShogiSession(ch.id, interaction.guild_id, interaction.user.id, mode, difficulty)
        if mode == "cpu":
            s.players[Color.SENTE] = interaction.user
            s.players[Color.GOTE] = None
            self.sessions[ch.id] = s
            await interaction.response.send_message(f"将棋CPU対戦（難易度 {s.difficulty}/10）を開始します。")
            try:
                await self.run_game(ch, s)
            finally:
                s.phase = "done"
                self.sessions.pop(ch.id, None)
                self._clear_snapshot(ch.id)
            return
        s.players[interaction.user.id] = interaction.user
        self.sessions[ch.id] = s
        await interaction.response.send_message("将棋の募集を開始しました。")
        try:
            msg = await game_panels.replace(ch, "party", embed=discord.Embed(
                title="将棋 参加者募集", description=f"{interaction.user.mention} さんが募集中です。\n{RECRUIT_SECONDS}秒以内に参加してください（2人対戦）。", color=COLOR),
                view=JoinView(s))
            await asyncio.sleep(RECRUIT_SECONDS)
            await self.run_game(ch, s)
        finally:
            s.phase = "done"
            self.sessions.pop(ch.id, None)
            self._clear_snapshot(ch.id)

    async def _update_board_msg(self, s: ShogiSession, channel, description, labels=None, selected=None, page=0):
        # 盤面画像の番号ラベルは、表示中のページの候補だけに付ける。
        render_labels = paginate_labels(labels, page)[0] if labels else labels
        buf = s.renderer.render(s.game, labels=render_labels, selected=selected)
        file = discord.File(buf, "shogi.png")
        embed = discord.Embed(description=description, color=COLOR)
        embed.set_image(url="attachment://shogi.png")
        if labels:
            select_view = ShogiMoveView(self, s, labels, page=page)
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
        await self._play_loop(channel, s)
        await channel.send("将棋を終了しました。")

    async def _play_loop(self, channel, s: ShogiSession):
        idle = 0
        while s.phase == "playing":
            if s.game.is_checkmate(s.game.turn):
                winner = s.players[Color.GOTE if s.game.turn == Color.SENTE else Color.SENTE]
                rating_line = await record_win(s, winner)
                suffix = f"\n{rating_line}" if rating_line else ""
                await channel.send(f"詰みです。{winner.mention} さんの勝利です。{suffix}")
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
            # 手番開始時点をチェックポイントとして保存する（復旧はここから再開する）
            self._save_snapshot(s)
            selectables = s.game.get_legal_selectable_pieces()
            labels = make_labels(selectables)
            desc = (f"{turn_user.mention} さんの番（{'先手' if s.game.turn == Color.SENTE else '後手'}）。\n"
                    + ("王手を受けています。\n" if s.game.is_in_check(s.game.turn) else "")
                    + "セレクトメニューまたは「座標を入力」から駒を選んでください。")
            await self._update_board_msg(s, channel, desc, labels=labels)
            for _ in range(TURN_SECONDS):
                if s.acted or s.phase != "playing":
                    break
                await asyncio.sleep(1)
            if not s.acted:
                idle += 1
                await channel.send(f"{turn_user.mention} さんは時間切れのためパスしました。")
                if idle >= 2:
                    break
                s.game.turn = Color.GOTE if s.game.turn == Color.SENTE else Color.SENTE
            else:
                idle = 0

    # ------------------------------------------------------------------
    # 再起動復旧（core/game/game_restore.py）
    # ------------------------------------------------------------------
    def _save_snapshot(self, s: ShogiSession) -> None:
        if s.phase != "playing":
            return
        sente = s.players.get(Color.SENTE)
        gote = s.players.get(Color.GOTE)
        state = {
            "mode": s.mode,
            "difficulty": s.difficulty,
            "host_id": s.host_id,
            "players": {
                "sente": game_restore.member_ref(sente) if sente is not None else None,
                "gote": game_restore.member_ref(gote) if gote is not None else None,
            },
            "game": serialize_shogi_game(s.game),
            "board_message_id": getattr(s.current_msg, "id", None),
        }
        game_restore.save_session("shogi", s.channel_id, s.guild_id, state)

    def _clear_snapshot(self, channel_id) -> None:
        game_restore.clear_session("shogi", channel_id)

    async def restore_after_restart(self) -> None:
        """再起動前に進行中だった将棋を、手番の開始時点から再開する。"""
        entries = game_restore.session_entries("shogi")
        for channel_id, entry in entries.items():
            try:
                restored = await self._restore_session(channel_id, entry)
            except Exception:
                logger.exception("channel %s: 将棋の復旧に失敗しました", channel_id)
                restored = False
            if not restored:
                game_restore.clear_session("shogi", channel_id)
        game_restore.flush_store()

    async def _restore_session(self, channel_id, entry) -> bool:
        state = entry.get("state")
        if not isinstance(state, dict) or channel_id in self.sessions:
            return False
        channel = self.bot.get_channel(channel_id)
        if channel is None:
            return False
        guild = getattr(channel, "guild", None)
        guild_id = entry.get("guild_id") or getattr(guild, "id", None)
        s = ShogiSession(channel_id, guild_id, state.get("host_id"),
                         state.get("mode") or "human", state.get("difficulty") or 5)
        players = state.get("players") or {}
        for key, color in (("sente", Color.SENTE), ("gote", Color.GOTE)):
            ref = players.get(key)
            if ref is None:
                if s.mode == "cpu" and color == Color.GOTE:
                    s.players[color] = None
                    continue
                return False
            s.players[color] = game_restore.resolve_member(guild, ref.get("id"), ref.get("name"))
        s.game = deserialize_shogi_game(state["game"])
        s.phase = "playing"
        message_id = state.get("board_message_id")
        fetch = getattr(channel, "fetch_message", None)
        if message_id and callable(fetch):
            try:
                s.current_msg = await fetch(message_id)
            except Exception:
                s.current_msg = None
        self.sessions[channel_id] = s
        asyncio.create_task(self._run_restored_session(channel, s))
        return True

    async def _run_restored_session(self, channel, s: ShogiSession):
        try:
            await self._play_loop(channel, s)
            await channel.send("将棋を終了しました。")
        except Exception:
            logger.exception("channel %s: 復旧した将棋の進行に失敗しました", s.channel_id)
        finally:
            s.phase = "done"
            if self.sessions.get(s.channel_id) is s:
                self.sessions.pop(s.channel_id, None)
            self._clear_snapshot(s.channel_id)


async def setup(bot):
    await bot.add_cog(Shogi(bot))
