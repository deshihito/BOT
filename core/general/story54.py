# -*- coding: utf-8 -*-
"""54字の物語（54字ぴったりの文章を原稿用紙風の画像にする）。元は新規追加。

ユーザーが入力した54字ぴったりの文章を、縦書き9行×6列のマス目に
1マス1文字で流し込んだ原稿用紙風画像 (PNG) にして返す。
文字数は、改行と前後の空白を取り除いた上で残りの全文字
（句読点・記号・スペース含む）を各1字として数える。
"""
from __future__ import annotations

from .common import *
from .miq.miq import _MIQ_ASSET_FONTS, _miq_load_font

STORY54_REQUIRED = 54
STORY54_ROWS = 9
STORY54_COLS = 6
STORY54_CANVAS = 1080

_PAPER = (247, 242, 231)      # 生成り色の紙
_INK = (43, 39, 34)           # 濃い墨色
_BROWN = (149, 95, 49)        # 枠・フッターの茶色
_DASH = (178, 158, 124)       # マス目の薄い破線

_FRAME_OUTER = 74             # 外枠（太線）の外周
_FRAME_OUTER_W = 8
_FRAME_INNER = 94             # 内枠（細線）
_FRAME_INNER_W = 3
_GRID_X = 108                 # マス目領域（864 = 144×6列 / 96×9行）
_GRID_Y = 108
_GRID_W = 864
_GRID_H = 864
_CHAR_SIZE = 66
_FOOTER_SIZE = 34
_FOOTER_Y = 1042

# 縦書きでは句読点はマスの右上に置く（参考画像の体裁）
_PUNCT_TOP_RIGHT = ("、", "。")


def _story54_font_path() -> str | None:
    """明朝系の同梱フォント (ZenOldMincho) を優先し、無ければ None。"""
    path = _MIQ_ASSET_FONTS / "ZenOldMincho-Regular.ttf"
    return str(path) if path.exists() else None


def normalize_story54_text(text: str) -> str:
    """改行をすべて取り除き、前後の空白を落とす（中の空白は1字として残す）。"""
    return (text or "").replace("\r", "").replace("\n", "").strip()


def story54_char_count(text: str) -> int:
    """54字判定に使う正規化後の文字数。"""
    return len(normalize_story54_text(text))


def render_story54_png(text: str) -> bytes:
    """54字ぴったりの文章を原稿用紙風画像 (PNG) にして返す。

    54字でなければ ValueError。文字 i は 列 = i // 9（右端が0列目、左へ進む）、
    行 = i % 9（上から下）へ縦書きで配置する。
    """
    from PIL import Image, ImageDraw

    chars = normalize_story54_text(text)
    if len(chars) != STORY54_REQUIRED:
        raise ValueError(f"54字ぴったりではありません（{len(chars)}字）")

    img = Image.new("RGB", (STORY54_CANVAS, STORY54_CANVAS), _PAPER)
    draw = ImageDraw.Draw(img)

    # 茶色の二重枠（外側は太線、内側は細線）
    edge = STORY54_CANVAS - _FRAME_OUTER
    draw.rectangle([_FRAME_OUTER, _FRAME_OUTER, edge, edge],
                   outline=_BROWN, width=_FRAME_OUTER_W)
    edge = STORY54_CANVAS - _FRAME_INNER
    draw.rectangle([_FRAME_INNER, _FRAME_INNER, edge, edge],
                   outline=_BROWN, width=_FRAME_INNER_W)

    # マス目の薄い破線（列区切り・行区切りとも）
    cell_w = _GRID_W // STORY54_COLS
    cell_h = _GRID_H // STORY54_ROWS

    def dashed_v(x: int) -> None:
        for y in range(_GRID_Y, _GRID_Y + _GRID_H, 12):
            draw.line([(x, y), (x, min(y + 6, _GRID_Y + _GRID_H))],
                      fill=_DASH, width=1)

    def dashed_h(y: int) -> None:
        for x in range(_GRID_X, _GRID_X + _GRID_W, 12):
            draw.line([(x, y), (min(x + 6, _GRID_X + _GRID_W), y)],
                      fill=_DASH, width=1)

    for col in range(STORY54_COLS + 1):
        dashed_v(_GRID_X + col * cell_w)
    for row in range(STORY54_ROWS + 1):
        dashed_h(_GRID_Y + row * cell_h)

    font_path = _story54_font_path()
    font = _miq_load_font(font_path, _CHAR_SIZE)
    for i, ch in enumerate(chars):
        col = i // STORY54_ROWS
        row = i % STORY54_ROWS
        cx = _GRID_X + (STORY54_COLS - 1 - col) * cell_w + cell_w // 2
        cy = _GRID_Y + row * cell_h + cell_h // 2
        if ch in _PUNCT_TOP_RIGHT:
            cx += cell_w // 6
            cy -= cell_h // 6
        draw.text((cx, cy), ch, font=font, fill=_INK, anchor="mm")

    footer_font = _miq_load_font(font_path, _FOOTER_SIZE)
    draw.text((_FRAME_OUTER + 2, _FOOTER_Y), "54字の物語",
              font=footer_font, fill=_BROWN, anchor="lm")
    draw.text((STORY54_CANVAS - _FRAME_OUTER - 2, _FOOTER_Y), "9×6",
              font=footer_font, fill=_BROWN, anchor="rm")

    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


class Story54Modal(discord.ui.Modal, title="54字の物語"):
    """54字の文章を聞くモーダル。送信後の処理は handler に委ねる。

    handler は async callable(interaction, normalized_text)。
    54字でない場合は字数を ephemeral で返して終わる（画像は作らない）。
    """

    story = discord.ui.TextInput(
        label="文章（54字ぴったり）",
        style=discord.TextStyle.paragraph,
        max_length=200,
        placeholder="この村では、来訪者一人を神に捧げますが今なら期間限定でもう一人！"
                    "何と手数料は村が負担！詳しくは明日の朝刊で！",
    )

    def __init__(self, handler):
        super().__init__()
        self.handler = handler

    async def on_submit(self, interaction: discord.Interaction):
        text = normalize_story54_text(self.story.value or "")
        count = len(text)
        if count != STORY54_REQUIRED:
            if count < STORY54_REQUIRED:
                message = (f"いま{count}字です。"
                           f"あと{STORY54_REQUIRED - count}字で54字になります。")
            else:
                message = f"いま{count}字です。{count - STORY54_REQUIRED}字多いです。"
            return await interaction.response.send_message(message, ephemeral=True)
        await self.handler(interaction, text)


class Story54Mixin:
    async def _story54_text_done(self, interaction: discord.Interaction, text: str):
        """54字の文章から画像を生成し、チャンネルへ公開で投稿する。"""
        try:
            data = await asyncio.to_thread(render_story54_png, text)
        except ImportError:
            return await interaction.response.send_message(
                "画像生成ライブラリが利用できません。", ephemeral=True)
        except Exception:
            logger.exception("story54: 画像の生成に失敗しました")
            return await interaction.response.send_message(
                "画像を作れませんでした。", ephemeral=True)
        file = discord.File(io.BytesIO(data), filename="story54.png")
        await interaction.response.send_message(file=file)
