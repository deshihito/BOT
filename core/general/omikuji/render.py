# -*- coding: utf-8 -*-
"""おみくじの札画像（PIL、縦型）。

実物の札に寄せた体裁：生成り色の和紙風背景、朱色の二重枠、上部に
「第○番」（漢数字）、大きな運勢、その右から左へ読む縦書きの和歌と
総合、段組みの項目別運勢（見出しは朱色）、フッターに AGO 表記。
フォントは story54 と同じ ZenOldMincho を使う。
"""
from __future__ import annotations

import io

from core.general.miq.miq import _MIQ_ASSET_FONTS, _miq_load_font

from .fortunes import Fortune

CANVAS_W = 920
CANVAS_H = 1980

_PAPER = (247, 242, 231)      # 生成り色の紙
_INK = (43, 39, 34)           # 濃い墨色
_VERMILLION = (176, 54, 42)   # 朱色（枠・見出し）

_FRAME_OUTER = 26
_FRAME_OUTER_W = 7
_FRAME_INNER = 46
_FRAME_INNER_W = 2

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


def render_omikuji_png(fortune: Fortune) -> bytes:
    """おみくじの結果を縦型の札画像 (PNG) にして返す。"""
    from PIL import Image, ImageDraw

    img = Image.new("RGB", (CANVAS_W, CANVAS_H), _PAPER)
    draw = ImageDraw.Draw(img)
    font_path = _font_path()

    def font(size: int):
        return _miq_load_font(font_path, size)

    # 朱色の二重枠
    draw.rectangle(
        [_FRAME_OUTER, _FRAME_OUTER, CANVAS_W - _FRAME_OUTER, CANVAS_H - _FRAME_OUTER],
        outline=_VERMILLION, width=_FRAME_OUTER_W)
    draw.rectangle(
        [_FRAME_INNER, _FRAME_INNER, CANVAS_W - _FRAME_INNER, CANVAS_H - _FRAME_INNER],
        outline=_VERMILLION, width=_FRAME_INNER_W)

    def divider(y: int) -> None:
        draw.line([(_FRAME_INNER + 24, y), (CANVAS_W - _FRAME_INNER - 24, y)],
                  fill=_VERMILLION, width=3)
        draw.line([(_FRAME_INNER + 24, y + 8), (CANVAS_W - _FRAME_INNER - 24, y + 8)],
                  fill=_VERMILLION, width=1)

    # 上部：第○番
    draw.text((CANVAS_W // 2, 84), "おみくじ", font=font(30),
              fill=_VERMILLION, anchor="mm")
    draw.text((CANVAS_W // 2, 148), f"第{kanji_number(fortune.number)}番",
              font=font(62), fill=_INK, anchor="mm")
    divider(196)

    # 運勢（大きく）
    rank_font = font(168 if len(fortune.rank) <= 2 else 148)
    draw.text((CANVAS_W // 2, 308), fortune.rank, font=rank_font,
              fill=_INK, anchor="mm")
    divider(412)

    # 和歌（右2列）と総合（その左に最大3列）を縦書きで
    body_top = 452
    kami, shimo = fortune.waka
    waka_font = font(40)
    _draw_vertical(draw, 796, body_top, kami, waka_font, _INK, 46)
    _draw_vertical(draw, 704, body_top, shimo, waka_font, _INK, 46)
    summary_font = font(31)
    for i, column in enumerate(_split_columns(fortune.summary, 3)):
        _draw_vertical(draw, 566 - i * 68, body_top, column,
                       summary_font, _INK, 38)
    divider(1236)

    # 項目別運勢（右から左へ10列、見出しは朱色）
    items_top = 1276
    label_font = font(36)
    text_font = font(29)
    for i, (name, text) in enumerate(fortune.items):
        cx = 828 - i * 80
        _draw_vertical(draw, cx, items_top, name, label_font, _VERMILLION, 45)
        _draw_vertical(draw, cx, items_top + 104, text, text_font, _INK, 36)

    # フッター（内枠の内側・左下に小さく）
    draw.text((_FRAME_INNER + 12, CANVAS_H - _FRAME_INNER - 22), "AGO",
              font=font(26), fill=_VERMILLION, anchor="lm")

    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()
