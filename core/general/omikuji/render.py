# -*- coding: utf-8 -*-
"""おみくじの札画像（PIL、縦型）。

実物の札に寄せた体裁：和紙風背景、二重枠、上部に「第○番」（漢数字）、
大きな運勢、その右から左へ読む縦書きの和歌と総合、段組みの項目別
運勢、フッターに AGO 表記。背景には AGO BOT のアイコン
（web/public/img/nomal.png）を透かしとして大きく淡く敷く。
フォントは story54 と同じ ZenOldMincho を使う。

札の見た目はフォーマット（通常/豪華/辛口/ゲーミング）ごとのテーマで
切り替わる。レイアウト・寸法は全フォーマット共通で、テーマは紙色・
文字色・差し色・透かしの色・上部の見出し・枠の太さだけを持つ。
ゲーミングだけは例外で、枠まわりの差し色が虹色に遷移する
アニメーション GIF になる（本文の配色は通常系で可読性を保つ）。

描画は「墨色の土台」と「差し色の透明レイヤー」に分けてあり、
差し色は合成時に付ける。これにより GIF では土台を1回だけ描き、
フレームごとに差し色だけを差し替える。
"""
from __future__ import annotations

import colorsys
import io
import logging
from dataclasses import dataclass

from core.general.miq.miq import _MIQ_ASSET_FONTS, _miq_load_font
from core.support import data_paths

from .fortunes import Fortune

logger = logging.getLogger(__name__)

CANVAS_W = 920
CANVAS_H = 1980


@dataclass(frozen=True)
class _Theme:
    paper: tuple[int, int, int]          # 紙の地色
    ink: tuple[int, int, int]            # 本文の文字色
    accent: tuple[int, int, int]         # 枠・見出し・フッターの差し色
    watermark_tint: tuple[int, int, int]  # 透かしシルエットの色
    header: str                          # 上部の小見出し
    frame_outer_w: int
    frame_inner_w: int


def _rainbow_color(phase: float) -> tuple[int, int, int]:
    """色相環上の色（ゲーミングの枠色）。phase 0.0 が赤。"""
    r, g, b = colorsys.hsv_to_rgb(phase % 1.0, 0.78, 0.88)
    return (int(r * 255), int(g * 255), int(b * 255))


#: フォーマット別のテーマ。
#: normal は従来デザインそのまま（生成り紙×朱）。
#: luxury は深い茶の紙に金の枠と文字。文字の金は暗い紙の上でも
#: 読めるよう明るめにし、枠・見出しの金は一段落とす。
#: spicy は白紙×墨色のみの簡素な体裁で、差し色を使わない。
#: gaming の紙と文字は normal と同じ通常系。accent は静止画（PNG）
#: 用の虹色の開始色で、GIF ではフレームごとに色相を回す。
_THEMES: dict[str, _Theme] = {
    "normal": _Theme(
        paper=(247, 242, 231), ink=(43, 39, 34), accent=(176, 54, 42),
        watermark_tint=(208, 196, 175), header="おみくじ",
        frame_outer_w=7, frame_inner_w=2),
    "luxury": _Theme(
        paper=(36, 28, 20), ink=(238, 210, 140), accent=(205, 164, 74),
        watermark_tint=(96, 79, 50), header="黄金おみくじ",
        frame_outer_w=9, frame_inner_w=2),
    "spicy": _Theme(
        paper=(252, 252, 250), ink=(38, 36, 33), accent=(38, 36, 33),
        watermark_tint=(229, 229, 225), header="おみくじ",
        frame_outer_w=4, frame_inner_w=1),
    "gaming": _Theme(
        paper=(247, 242, 231), ink=(43, 39, 34), accent=_rainbow_color(0.0),
        watermark_tint=(208, 196, 175), header="ゲーミングおみくじ",
        frame_outer_w=7, frame_inner_w=2),
}

#: ゲーミング GIF のフレーム数と1フレームの表示時間（ms）。1周 1.6 秒。
GAMING_FRAMES = 16
GAMING_FRAME_MS = 100

#: GIF 化時のパレット色数。フレームを事前に FASTOCTREE で量子化すると
#: エンコードが速くなり、ファイルも小さくなる（実測：約4.0秒→約1.7秒、
#: 約1.3MB→約0.5MB）。平たんなデザインのため 128 色で劣化は見えない。
_GIF_COLORS = 128

# 背景の透かし（AGO アイコン）。アイコンは白いキャラ＋黒背景のため、
# 輝度をアルファとして使い、キャラのシルエットだけをテーマ色で
# 淡く浮かせる（黒背景部分は透明になる）。
_WATERMARK_SIZE = 680
_WATERMARK_OPACITY = 0.15

_FRAME_OUTER = 26
_FRAME_INNER = 46

# 縦書きでマスの右上に寄せる句読点と、小書き仮名（story54 の体裁に倣う）
_PUNCT = ("、", "。", "，", "．")
_SMALL_KANA = "ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮ"

_KANJI_DIGITS = "一二三四五六七八九"


def _font_path() -> str | None:
    path = _MIQ_ASSET_FONTS / "ZenOldMincho-Regular.ttf"
    return str(path) if path.exists() else None


def kanji_number(number: int) -> str:
    """1〜100 を漢数字にする（十一・二十三・百）。札の「第○番」用。"""
    if number == 100:
        return "百"
    tens, ones = divmod(number, 10)
    out = ""
    if tens:
        out += (_KANJI_DIGITS[tens - 1] if tens > 1 else "") + "十"
    if ones:
        out += _KANJI_DIGITS[ones - 1]
    return out


def _draw_vertical(draw, cx: int, y_top: int, text: str, font, fill, pitch: int) -> None:
    """1列の縦書きを描く。句読点は右上に寄せ、小書き仮名は少し寄せる。

    空白は区切りとして読み飛ばす（スロットを消費しない）。
    """
    chars = [ch for ch in text if ch not in (" ", "　")]
    for i, ch in enumerate(chars):
        x = float(cx)
        y = y_top + i * pitch + pitch / 2
        if ch in _PUNCT:
            x += pitch * 0.30
            y -= pitch * 0.30
        elif ch in _SMALL_KANA:
            x += pitch * 0.14
            y -= pitch * 0.14
        draw.text((x, y), ch, font=font, fill=fill, anchor="mm")


def _split_columns(text: str, max_columns: int) -> list[str]:
    """縦書き用に文字列を最大 max_columns 列へ均等に分割する。"""
    text = text.replace(" ", "").replace("　", "")
    if not text:
        return []
    chunk = -(-len(text) // max_columns)
    return [text[i:i + chunk] for i in range(0, len(text), chunk)]


def _apply_watermark(img, tint_color) -> None:
    """背景中央に AGO アイコンの透かしを敷く（素材が無ければ何もしない）。"""
    from PIL import Image

    path = data_paths.repo_root() / "web" / "public" / "img" / "nomal.png"
    try:
        icon = Image.open(path).convert("L")
    except Exception:
        logger.warning("omikuji: 透かし用アイコンを読めませんでした path=%s", path)
        return
    icon = icon.resize((_WATERMARK_SIZE, _WATERMARK_SIZE), Image.LANCZOS)
    alpha = icon.point(lambda v: int(v * _WATERMARK_OPACITY))
    tint = Image.new("RGB", (_WATERMARK_SIZE, _WATERMARK_SIZE), tint_color)
    x = CANVAS_W // 2 - _WATERMARK_SIZE // 2
    y = CANVAS_H // 2 - _WATERMARK_SIZE // 2
    img.paste(tint, (x, y), alpha)


def _font_loader():
    font_path = _font_path()

    def font(size: int):
        return _miq_load_font(font_path, size)

    return font


def _draw_base(fortune: Fortune, theme: _Theme):
    """紙・透かしと、テーマ ink 色の要素（番号・運勢・和歌・総合・
    項目本文）だけを描いた土台画像。"""
    from PIL import Image, ImageDraw

    img = Image.new("RGB", (CANVAS_W, CANVAS_H), theme.paper)
    _apply_watermark(img, theme.watermark_tint)
    draw = ImageDraw.Draw(img)
    font = _font_loader()

    # 上部：第○番
    draw.text((CANVAS_W // 2, 148), f"第{kanji_number(fortune.number)}番",
              font=font(62), fill=theme.ink, anchor="mm")

    # 運勢（大きく）
    rank_font = font(168 if len(fortune.rank) <= 2 else 148)
    draw.text((CANVAS_W // 2, 308), fortune.rank, font=rank_font,
              fill=theme.ink, anchor="mm")

    # 和歌（右2列）と総合（その左に最大3列）を縦書きで
    body_top = 452
    kami, shimo = fortune.waka
    waka_font = font(40)
    _draw_vertical(draw, 796, body_top, kami, waka_font, theme.ink, 46)
    _draw_vertical(draw, 704, body_top, shimo, waka_font, theme.ink, 46)
    summary_font = font(31)
    for i, column in enumerate(_split_columns(fortune.summary, 3)):
        _draw_vertical(draw, 566 - i * 68, body_top, column,
                       summary_font, theme.ink, 38)

    # 項目別運勢の本文（右から左へ10列）
    items_top = 1276
    text_font = font(29)
    for i, (_name, text) in enumerate(fortune.items):
        cx = 828 - i * 80
        # 最長文面（15字）でも末尾がフッター（AGO）に届かないピッチにする
        _draw_vertical(draw, cx, items_top + 100, text, text_font, theme.ink, 34)
    return img


def _accent_layer(fortune: Fortune, theme: _Theme):
    """差し色の要素（二重枠・見出し・区切り線・項目見出し・フッター）を
    透明レイヤーに白で描く。実際の色は _compose で付ける。"""
    from PIL import Image, ImageDraw

    layer = Image.new("RGBA", (CANVAS_W, CANVAS_H), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    font = _font_loader()
    white = (255, 255, 255, 255)

    # 二重枠
    draw.rectangle(
        [_FRAME_OUTER, _FRAME_OUTER, CANVAS_W - _FRAME_OUTER, CANVAS_H - _FRAME_OUTER],
        outline=white, width=theme.frame_outer_w)
    draw.rectangle(
        [_FRAME_INNER, _FRAME_INNER, CANVAS_W - _FRAME_INNER, CANVAS_H - _FRAME_INNER],
        outline=white, width=theme.frame_inner_w)

    def divider(y: int) -> None:
        draw.line([(_FRAME_INNER + 24, y), (CANVAS_W - _FRAME_INNER - 24, y)],
                  fill=white, width=3)
        draw.line([(_FRAME_INNER + 24, y + 8), (CANVAS_W - _FRAME_INNER - 24, y + 8)],
                  fill=white, width=1)

    # 上部の小見出し
    draw.text((CANVAS_W // 2, 84), theme.header, font=font(30),
              fill=white, anchor="mm")
    divider(196)
    divider(412)
    divider(1236)

    # 項目別運勢の見出し（右から左へ10列）
    items_top = 1276
    label_font = font(36)
    for i, (name, _text) in enumerate(fortune.items):
        cx = 828 - i * 80
        _draw_vertical(draw, cx, items_top, name, label_font, white, 45)

    # フッター（内枠の内側・左下に小さく）
    draw.text((_FRAME_INNER + 12, CANVAS_H - _FRAME_INNER - 22), "AGO",
              font=font(26), fill=white, anchor="lm")
    return layer


def _compose(base, layer, accent):
    """土台に差し色レイヤーを accent 色で合成する。"""
    from PIL import Image

    img = base.copy()
    overlay = Image.new("RGB", base.size, accent)
    img.paste(overlay, (0, 0), layer.split()[3])
    return img


def render_omikuji_png(fortune: Fortune) -> bytes:
    """おみくじの結果を縦型の札画像 (PNG) にして返す。

    見た目は fortune.format のテーマで切り替わる（未知の値は通常）。
    ゲーミングも静止画としてはこの関数で描ける（開始色の枠）。
    """
    theme = _THEMES.get(fortune.format, _THEMES["normal"])
    img = _compose(_draw_base(fortune, theme),
                   _accent_layer(fortune, theme), theme.accent)
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


def render_omikuji_gif(fortune: Fortune) -> bytes:
    """ゲーミング用：枠まわりの差し色が虹色に遷移するアニメーション GIF。

    土台と差し色レイヤーは1回だけ描き、フレームごとに差し色の
    色相を回して合成する。本文の配色は通常系のまま変えない。
    """
    from PIL import Image

    theme = _THEMES["gaming"]
    base = _draw_base(fortune, theme)
    layer = _accent_layer(fortune, theme)
    frames = [
        _compose(base, layer, _rainbow_color(i / GAMING_FRAMES))
        .quantize(colors=_GIF_COLORS, method=Image.FASTOCTREE)
        for i in range(GAMING_FRAMES)
    ]
    buf = io.BytesIO()
    frames[0].save(buf, "GIF", save_all=True, append_images=frames[1:],
                   duration=GAMING_FRAME_MS, loop=0, optimize=True)
    return buf.getvalue()


def render_omikuji_image(fortune: Fortune) -> tuple[bytes, str]:
    """投稿用に (画像バイト列, ファイル名) を返す。ゲーミングだけ GIF。"""
    if fortune.format == "gaming":
        return render_omikuji_gif(fortune), "omikuji.gif"
    return render_omikuji_png(fortune), "omikuji.png"
