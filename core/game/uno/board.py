# -*- coding: utf-8 -*-
"""UNO の盤面と手札を PIL で描く純関数群。

方針は core/game/game/board_image.py と同じ（テキスト再現だと安っぽく
なる盤面は画像化する）。Discord オブジェクトには触れず、カード文字列と
プレイヤー情報だけを受け取って PNG の bytes を返すので単体テストできる。

カード文字列の形式は core/game/uno/cog.py の UnoGame と同じ:
    "赤の5" / "青のSkip" / "黄のReverse" / "緑の+2" / "Wild" / "Wild+4"
"""
from __future__ import annotations

import io
from functools import lru_cache
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

_ROOT = Path(__file__).resolve().parents[3]
_FONT_PATH = _ROOT / "font.ttf"  # Hachi Maru Pop (日本語)
_DISPLAY_FONT_PATH = _ROOT / "assets" / "fonts" / "DelaGothicOne-Regular.ttf"

_SS = 2  # 内部は2倍解像度で描いて縮小 (ジャギー防止)

BG = (24, 26, 32)
FG = (245, 245, 245)
MUTE = (168, 175, 188)
TABLE = (17, 84, 57)
TABLE_EDGE = (11, 58, 40)
ACCENT = (250, 204, 21)  # 手番ハイライト (黄)
DANGER = (220, 38, 38)

CARD_COLORS = {
    "赤": (214, 40, 49),
    "青": (30, 100, 200),
    "黄": (238, 178, 17),
    "緑": (24, 158, 76),
}
WILD_BASE = (28, 28, 32)

BOARD_W, BOARD_H = 1000, 600
BOARD_FILENAME = "uno_board.png"
HAND_FILENAME = "uno_hand.png"


@lru_cache(maxsize=64)
def _font(size: int, display: bool = False):
    path = _DISPLAY_FONT_PATH if display else _FONT_PATH
    try:
        return ImageFont.truetype(str(path), size)
    except Exception:
        if display:
            try:
                return ImageFont.truetype(str(_FONT_PATH), size)
            except Exception:
                pass
        return ImageFont.load_default()


def _s(v: float) -> int:
    """デザイン座標 (最終サイズ基準) を内部解像度へ変換する。"""
    return int(round(v * _SS))


def _safe_name(name: str) -> str:
    """フォントで描けない文字 (絵文字・記号) を落とす。"""
    out = []
    for ch in str(name or ""):
        o = ord(ch)
        if o >= 0x1F000 or 0x2190 <= o <= 0x2BFF or o in (0x200D, 0xFE0F, 0xFE0E) or o < 0x20:
            continue
        out.append(ch)
    return "".join(out).strip() or "プレイヤー"


def _fit_text(draw: ImageDraw.ImageDraw, text: str, font, max_w: int) -> str:
    if draw.textlength(text, font=font) <= max_w:
        return text
    while len(text) > 1 and draw.textlength(text + "…", font=font) > max_w:
        text = text[:-1]
    return text + "…"


def _centered(draw: ImageDraw.ImageDraw, cx: float, cy: float, text: str, font, fill):
    bbox = draw.textbbox((0, 0), text, font=font)
    draw.text(
        (cx - (bbox[2] - bbox[0]) / 2 - bbox[0], cy - (bbox[3] - bbox[1]) / 2 - bbox[1]),
        text, fill=fill, font=font,
    )


def parse_card(card: str) -> tuple[str | None, str]:
    """カード文字列 → (色, 値)。ワイルド系は色 None。"""
    if card in ("Wild", "Wild+4"):
        return None, card
    if "の" in str(card):
        color, value = str(card).split("の", 1)
        return color, value
    return None, str(card)


# ---------------------------------------------------------------------------
# カード1枚の描画
# ---------------------------------------------------------------------------

def _draw_glyph(draw: ImageDraw.ImageDraw, cx: float, cy: float, unit: float,
                value: str, color: tuple[int, int, int]):
    """カード中央 (および隅) に値のシンボルを描く。unit はカード幅基準の大きさ。"""
    if value in ("Wild", "Wild+4"):
        return  # ワイルドは楕円内の4色そのものがシンボル
    if value == "Skip":
        r = unit * 0.30
        w = max(2, int(unit * 0.075))
        draw.ellipse([cx - r, cy - r, cx + r, cy + r], outline=color, width=w)
        d = r * 0.72
        draw.line([cx - d, cy + d, cx + d, cy - d], fill=color, width=w)
        return
    if value == "Reverse":
        aw = unit * 0.62  # 矢印の全幅
        ah = unit * 0.15  # 矢印の太さ/矢じり
        for sign, dy in ((1, -unit * 0.16), (-1, unit * 0.16)):
            y = cy + dy
            x0, x1 = cx - sign * aw / 2, cx + sign * aw / 2
            draw.line([x0, y, x1, y], fill=color, width=max(2, int(ah * 0.55)))
            draw.polygon(
                [(x1, y), (x1 - sign * ah * 1.5, y - ah * 0.85), (x1 - sign * ah * 1.5, y + ah * 0.85)],
                fill=color,
            )
        return
    font = _font(int(unit * (0.95 if len(value) <= 1 else 0.78)), display=True)
    _centered(draw, cx, cy, value, font, color)


def _oval_layer(w: int, h: int, card: str, color: tuple[int, int, int]) -> Image.Image:
    """傾いた白楕円 (ワイルドは内部が4色) を透明レイヤーで作る。"""
    layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    ew, eh = w * 0.80, h * 0.54
    box = [(w - ew) / 2, (h - eh) / 2, (w + ew) / 2, (h + eh) / 2]
    _, value = parse_card(card)
    if value in ("Wild", "Wild+4"):
        mask = Image.new("L", (w, h), 0)
        ImageDraw.Draw(mask).ellipse(box, fill=255)
        quads = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        qd = ImageDraw.Draw(quads)
        cx, cy = w / 2, h / 2
        colors = [CARD_COLORS["赤"], CARD_COLORS["青"], CARD_COLORS["黄"], CARD_COLORS["緑"]]
        boxes = [
            (box[0], box[1], cx, cy), (cx, box[1], box[2], cy),
            (box[0], cy, cx, box[3]), (cx, cy, box[2], box[3]),
        ]
        for quad_box, quad_color in zip(boxes, colors):
            qd.rectangle(quad_box, fill=(*quad_color, 255))
        layer.alpha_composite(Image.composite(quads, layer, mask))
        d = ImageDraw.Draw(layer)
    else:
        d.ellipse(box, fill=(255, 255, 255, 255))
    return layer.rotate(-24, resample=Image.BICUBIC, center=(w / 2, h / 2))


def draw_card(img: Image.Image, x: int, y: int, w: int, h: int, card: str, *,
              back: bool = False, dim: bool = False):
    """(x, y) は最終サイズ基準の左上。w, h も最終サイズ基準。"""
    X, Y, W, H = _s(x), _s(y), _s(w), _s(h)
    color_name, value = parse_card(card)
    base = WILD_BASE if back or color_name is None else CARD_COLORS.get(color_name, WILD_BASE)
    if back:
        base = CARD_COLORS["赤"]

    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    radius = int(W * 0.11)
    d.rounded_rectangle([0, 0, W - 1, H - 1], radius=radius, fill=(255, 255, 255, 255))
    border = max(2, int(W * 0.045))
    d.rounded_rectangle(
        [border, border, W - 1 - border, H - 1 - border],
        radius=max(2, radius - border), fill=(*base, 255),
    )

    # 傾いた楕円 + シンボルは別レイヤーで回してから合成する
    cx, cy = W / 2, H / 2
    if back:
        oval = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        od = ImageDraw.Draw(oval)
        ew, eh = W * 0.80, H * 0.54
        od.ellipse(
            [(W - ew) / 2, (H - eh) / 2, (W + ew) / 2, (H + eh) / 2],
            outline=(255, 213, 79, 255), width=max(3, int(W * 0.05)),
        )
        layer.alpha_composite(oval.rotate(-24, resample=Image.BICUBIC, center=(cx, cy)))
        d = ImageDraw.Draw(layer)
        _centered(d, cx, cy, "UNO", _font(int(W * 0.26), display=True), (255, 213, 79))
    else:
        layer.alpha_composite(_oval_layer(W, H, card, base))
        d = ImageDraw.Draw(layer)
        if value == "Wild+4":
            _centered(d, cx, cy, "+4", _font(int(W * 0.34), display=True), (255, 255, 255))
            # 白文字だけだと4色の上で読みにくいので縁取りを重ねる
            bbox = d.textbbox((0, 0), "+4", font=_font(int(W * 0.34), display=True))
            d.text(
                (cx - (bbox[2] - bbox[0]) / 2 - bbox[0], cy - (bbox[3] - bbox[1]) / 2 - bbox[1]),
                "+4", font=_font(int(W * 0.34), display=True), fill=(255, 255, 255),
                stroke_width=max(2, int(W * 0.02)), stroke_fill=(40, 40, 40),
            )
        elif value != "Wild":
            _draw_glyph(d, cx, cy, W * 0.52, value, base)
        # 隅の小さな値 (左上のみ。右下は反転が必要なため省略)
        if value not in ("Wild",):
            small = "+4" if value == "Wild+4" else value
            if len(small) <= 2:
                _centered(d, W * 0.17, H * 0.115, small, _font(int(W * 0.16), display=True), (255, 255, 255))
            else:
                _draw_glyph(d, W * 0.17, H * 0.115, W * 0.20, value, (255, 255, 255))

    img.alpha_composite(layer, (X, Y))
    if dim:
        overlay = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        ImageDraw.Draw(overlay).rounded_rectangle(
            [0, 0, W - 1, H - 1], radius=radius, fill=(10, 10, 14, 130)
        )
        img.alpha_composite(overlay, (X, Y))


# ---------------------------------------------------------------------------
# 盤面
# ---------------------------------------------------------------------------

def board_height(player_count: int) -> int:
    """プレイヤー帯 (最大6人/行) を含めた盤面の高さ。"""
    rows = max(1, (max(1, player_count) + 5) // 6)
    return 484 + rows * 100 + (rows - 1) * 10 + 16


def render_board(*, top_card: str, active_color: str | None, players: list[dict],
                 current_idx: int, direction: int, deck_count: int,
                 pending_draw: int = 0) -> bytes:
    """UNO の公開盤面を描く。

    players は [{"name": str, "count": int}, ...] (順番どおり)。
    active_color は現在有効な色 (ワイルド指定を含む)。None なら場札の色。
    """
    img = Image.new("RGBA", (_s(BOARD_W), _s(board_height(len(players)))), (*BG, 255))
    d = ImageDraw.Draw(img)

    # テーブル
    d.rounded_rectangle(
        [_s(20), _s(64), _s(BOARD_W - 20), _s(468)],
        radius=_s(28), fill=(*TABLE, 255), outline=(*TABLE_EDGE, 255), width=_s(3),
    )

    # タイトルと進行方向
    d.text((_s(36), _s(14)), "UNO", font=_font(_s(34), display=True), fill=FG)
    _draw_direction(d, _s(196), _s(33), _s(19), direction)

    # 現在の色チップ (右上)
    top_color, _ = parse_card(top_card)
    shown_color = active_color or top_color
    if shown_color in CARD_COLORS:
        chip_w = _s(196)
        d.rounded_rectangle(
            [_s(BOARD_W - 36) - chip_w, _s(12), _s(BOARD_W - 36), _s(52)],
            radius=_s(20), fill=(*CARD_COLORS[shown_color], 255),
        )
        _centered(
            d, _s(BOARD_W - 36) - chip_w / 2, _s(32),
            f"現在の色: {shown_color}", _font(_s(21)), (255, 255, 255),
        )

    # 累積ドローの警告バッジ
    if pending_draw > 0:
        label = f"ドロー累積 +{pending_draw}"
        font = _font(_s(22))
        tw = d.textlength(label, font=font)
        bx = (_s(BOARD_W) - tw) / 2 - _s(16)
        d.rounded_rectangle(
            [bx, _s(76), bx + tw + _s(32), _s(116)],
            radius=_s(20), fill=(*DANGER, 255),
        )
        _centered(d, _s(BOARD_W) / 2, _s(96), label, font, (255, 255, 255))

    # 山札 (左) と場札 (右) — テーブル中央
    card_w, card_h = 168, 235
    deck_x, pile_x = 316, 516
    card_y = 130 if pending_draw <= 0 else 150
    draw_card(img, deck_x, card_y, card_w, card_h, "Wild", back=True)
    d = ImageDraw.Draw(img)
    _centered(d, _s(deck_x + card_w / 2), _s(card_y + card_h + 24), f"山札 残り{deck_count}枚", _font(_s(20)), FG)

    # 場札には現在の色のリングを付ける
    if shown_color in CARD_COLORS:
        ring = Image.new("RGBA", img.size, (0, 0, 0, 0))
        ImageDraw.Draw(ring).rounded_rectangle(
            [_s(pile_x - 9), _s(card_y - 9), _s(pile_x + card_w + 9), _s(card_y + card_h + 9)],
            radius=_s(24), outline=(*CARD_COLORS[shown_color], 255), width=_s(7),
        )
        img.alpha_composite(ring)
    draw_card(img, pile_x, card_y, card_w, card_h, top_card)
    d = ImageDraw.Draw(img)
    _centered(d, _s(pile_x + card_w / 2), _s(card_y + card_h + 24), "場のカード", _font(_s(20)), FG)

    # プレイヤーの帯 (下部)
    _draw_players(d, img, players, current_idx)

    out = img.resize((BOARD_W, board_height(len(players))), Image.LANCZOS).convert("RGB")
    buf = io.BytesIO()
    out.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def _draw_direction(d: ImageDraw.ImageDraw, cx: int, cy: int, r: int, direction: int):
    """進行方向を円弧+矢じりで描く (フォントの矢印グリフに頼らない)。"""
    import math

    start, end = (-40, 230) if direction >= 0 else (220, -50)
    d.arc([cx - r, cy - r, cx + r, cy + r], start=start, end=end, fill=FG, width=max(2, int(r * 0.28)))
    ang = math.radians(end if direction >= 0 else start)
    ex, ey = cx + r * math.cos(ang), cy + r * math.sin(ang)
    tangent = ang + (math.pi / 2 if direction >= 0 else -math.pi / 2)
    size = r * 0.85
    tip = (ex + size * math.cos(tangent), ey + size * math.sin(tangent))
    left = (ex + size * 0.6 * math.cos(tangent + 2.5), ey + size * 0.6 * math.sin(tangent + 2.5))
    right = (ex + size * 0.6 * math.cos(tangent - 2.5), ey + size * 0.6 * math.sin(tangent - 2.5))
    d.polygon([tip, left, right], fill=FG)


def _draw_players(d: ImageDraw.ImageDraw, img: Image.Image, players: list[dict], current_idx: int):
    per_row = 6
    area_x0, area_x1 = 28, BOARD_W - 28
    gap = 10
    chip_h = 100
    name_font = _font(_s(19))
    count_font = _font(_s(18))

    for i, player in enumerate(players):
        row, col = divmod(i, per_row)
        in_row = min(per_row, len(players) - row * per_row)
        chip_w = (area_x1 - area_x0 - gap * (in_row - 1)) / in_row
        x0 = area_x0 + col * (chip_w + gap)
        x1 = x0 + chip_w
        area_y0 = 484 + row * (chip_h + gap)
        area_y1 = area_y0 + chip_h
        is_current = i == current_idx
        fill = (44, 48, 58) if not is_current else (58, 62, 44)
        outline = ACCENT if is_current else (70, 76, 88)
        d.rounded_rectangle(
            [_s(x0), _s(area_y0), _s(x1), _s(area_y1)],
            radius=_s(14), fill=(*fill, 255), outline=(*outline, 255),
            width=_s(3 if is_current else 1),
        )
        cx = _s(x0 + chip_w / 2)
        name = _fit_text(d, _safe_name(player.get("name", "")), name_font, _s(chip_w - 16))
        _centered(d, cx, _s(area_y0 + 24), name, name_font, FG)
        count = int(player.get("count", 0))
        label = f"手札 {count}枚"
        if is_current:
            label = "手番 ・ " + label
        _centered(d, cx, _s(area_y0 + 54), label, count_font, ACCENT if is_current else MUTE)
        if count == 1:
            uw = _s(74)
            d.rounded_rectangle(
                [cx - uw / 2, _s(area_y0 + 68), cx + uw / 2, _s(area_y0 + 92)],
                radius=_s(12), fill=(*DANGER, 255),
            )
            _centered(d, cx, _s(area_y0 + 80), "UNO!", _font(_s(17), display=True), (255, 255, 255))


# ---------------------------------------------------------------------------
# 手札 (本人にだけ見せる)
# ---------------------------------------------------------------------------

def render_hand(cards: list[str], playable: set[str] | None = None) -> bytes:
    """手札をカード画像で描く。出せるカードは明るく、出せないカードは暗くする。"""
    playable = playable or set()
    per_row = 8
    card_w, card_h, gap = 118, 165, 10
    pad = 20
    title_h = 46
    rows = max(1, (len(cards) + per_row - 1) // per_row)
    width = pad * 2 + per_row * card_w + (per_row - 1) * gap
    height = pad * 2 + title_h + rows * card_h + (rows - 1) * gap

    img = Image.new("RGBA", (_s(width), _s(height)), (*BG, 255))
    d = ImageDraw.Draw(img)
    d.text(
        (_s(pad), _s(pad)),
        f"あなたの手札 ({len(cards)}枚) — 明るいカードが出せます",
        font=_font(_s(21)), fill=FG,
    )
    for i, card in enumerate(cards):
        row, col = divmod(i, per_row)
        x = pad + col * (card_w + gap)
        y = pad + title_h + row * (card_h + gap)
        draw_card(img, x, y, card_w, card_h, card, dim=(card not in playable))

    out = img.resize((width, height), Image.LANCZOS).convert("RGB")
    buf = io.BytesIO()
    out.save(buf, format="PNG", optimize=True)
    return buf.getvalue()
