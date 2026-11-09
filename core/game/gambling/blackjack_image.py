# -*- coding: utf-8 -*-
"""ブラックジャックの盤面画像（PIL）レンダラ。

対局状態を「フェルト＋実物カード絵＋アバター＋合計バッジ」の1枚画像で
見せるための純関数群。ゲームの判定・確率・配当は一切持たず、表示専用
（ロジックは core/game/gambling/gambling.py が正）。

情報開示規則（現行テキスト表示と厳密に一致させる）:
- ディーラーの伏せ札は裏面で描く。隠れている間は dealer_hand の
  先頭1枚しか描画に使わず、2枚目以降の値には一切触れない
  （画像から隠し情報が漏れないことをテストで担保する）。
- ディーラーの合計バッジは、伏せ札がある間は「見えている分の合計 + ?」
  とし、オープン後にだけ実合計を出す。

AGO 側の作り替えポイント（競合UIの模倣にしない）:
- フェルトは紺→ティールのグラデーション＋金細線のテーブルアーク。
- カード裏面は紺地にティールのダイヤ格子＋金円に「AGO」の独自デザイン。
- 手札の値は gambling.py の値モデル（1〜10、A は 1）そのまま。
  スートは値と位置から決まる演出専用の飾りで、判定には無関係。
"""
from __future__ import annotations

import io

from PIL import Image, ImageDraw

from core.game.gambling.gambling import calc_total
from core.leaderboard_image import _font, circle_avatar

#: 盤面画像のファイル名（attachment:// 参照で使う）。
FILENAME = "blackjack_board.png"

BOARD_W = 1000
BOARD_H = 600
CARD_W = 118
CARD_H = 164
_CARD_GAP = 14
_HAND_MAX_W = BOARD_W - 80

# AGO 配色（紺〜ティール基調。競合の緑フェルトとは別系統）。
FELT_TOP = (15, 23, 52)
FELT_BOTTOM = (7, 55, 62)
FELT_ARC = (52, 168, 158)
GOLD = (240, 200, 92)
PAPER = (250, 250, 247)
CARD_BORDER = (196, 202, 214)
INK = (24, 28, 40)
SUIT_RED = (198, 42, 60)
BADGE_BG = (10, 14, 28)
BADGE_INK = (240, 244, 252)
LABEL_INK = (214, 226, 238)
WIN_INK = (92, 224, 148)
LOSE_INK = (255, 110, 110)
PUSH_INK = (200, 208, 224)

_BACK_BASE = (18, 26, 58)
_BACK_LINE = (46, 140, 132)

_SUITS = ("spade", "heart", "diamond", "club")
_RED_SUITS = frozenset(("heart", "diamond"))

_OUTCOME_TEXT = {
    "win": "勝ち",
    "lose": "負け",
    "push": "引き分け",
    "bust": "バースト",
}
_OUTCOME_INK = {
    "win": WIN_INK,
    "lose": LOSE_INK,
    "push": PUSH_INK,
    "bust": LOSE_INK,
}


def card_rank_label(value: int) -> str:
    """値モデル（1〜10）からカードのランク表記を作る。1 は A。"""
    value = int(value)
    if value == 1:
        return "A"
    return str(value)


def card_suit(value: int, index: int) -> str:
    """演出専用スート。値と手札内の位置から決定的に決まる。

    手札は末尾への追加しか起きないため、既存カードの (値, 位置) は
    不変で、再描画のたびに同じスートになる（判定には無関係）。
    """
    return _SUITS[(int(value) * 5 + int(index) * 3) % len(_SUITS)]


def dealer_visible_total(dealer_hand: list[int]) -> int:
    """伏せ札がある間に開示できるディーラー合計（先頭1枚分のみ）。

    現行テキスト表示（先頭の値だけを見せる）と同じ規則。
    """
    if not dealer_hand:
        return 0
    return calc_total(list(dealer_hand[:1]))


def dealer_badge_text(dealer_hand: list[int], *, dealer_hidden: bool) -> str:
    """ディーラーの合計バッジ文字列。"""
    if dealer_hidden:
        return f"{dealer_visible_total(dealer_hand)} + ?"
    return str(calc_total(list(dealer_hand)))


def player_badge_text(player_hand: list[int]) -> str:
    """プレイヤーの合計バッジ文字列（calc_total と一致）。"""
    return str(calc_total(list(player_hand)))


def format_delta(delta: int) -> str:
    """精算時の増減表示。通貨表記は現行の経済表示（AGO）に統一。"""
    delta = int(delta)
    if delta == 0:
        return "±0 AGO"
    return f"{delta:+,} AGO"


# ---------------------------------------------------------------------------
# 描画部品
# ---------------------------------------------------------------------------

def _draw_suit(draw: ImageDraw.ImageDraw, suit: str, cx: float, cy: float,
               s: float, color) -> None:
    """スートを図形だけで描く（フォントのグリフ有無に依存しない）。"""
    if suit == "diamond":
        draw.polygon([(cx, cy - s), (cx + s * 0.68, cy),
                      (cx, cy + s), (cx - s * 0.68, cy)], fill=color)
        return
    if suit == "heart":
        r = s * 0.46
        draw.ellipse((cx - s * 0.88, cy - s * 0.62, cx - s * 0.88 + 2 * r,
                      cy - s * 0.62 + 2 * r), fill=color)
        draw.ellipse((cx + s * 0.88 - 2 * r, cy - s * 0.62,
                      cx + s * 0.88, cy - s * 0.62 + 2 * r), fill=color)
        draw.polygon([(cx - s * 0.92, cy - s * 0.18),
                      (cx + s * 0.92, cy - s * 0.18),
                      (cx, cy + s)], fill=color)
        return
    if suit == "spade":
        r = s * 0.46
        draw.polygon([(cx, cy - s), (cx - s * 0.92, cy + s * 0.42),
                      (cx + s * 0.92, cy + s * 0.42)], fill=color)
        draw.ellipse((cx - s * 0.88, cy - s * 0.05, cx - s * 0.88 + 2 * r,
                      cy - s * 0.05 + 2 * r), fill=color)
        draw.ellipse((cx + s * 0.88 - 2 * r, cy - s * 0.05,
                      cx + s * 0.88, cy - s * 0.05 + 2 * r), fill=color)
        draw.polygon([(cx - s * 0.16, cy + s * 0.35),
                      (cx + s * 0.16, cy + s * 0.35),
                      (cx + s * 0.34, cy + s), (cx - s * 0.34, cy + s)],
                     fill=color)
        return
    # club
    r = s * 0.5
    draw.ellipse((cx - r, cy - s * 0.95, cx + r, cy - s * 0.95 + 2 * r),
                 fill=color)
    draw.ellipse((cx - s * 1.0, cy - s * 0.28, cx - s * 1.0 + 2 * r,
                  cy - s * 0.28 + 2 * r), fill=color)
    draw.ellipse((cx + s * 1.0 - 2 * r, cy - s * 0.28, cx + s * 1.0,
                  cy - s * 0.28 + 2 * r), fill=color)
    draw.polygon([(cx - s * 0.16, cy + s * 0.1),
                  (cx + s * 0.16, cy + s * 0.1),
                  (cx + s * 0.34, cy + s), (cx - s * 0.34, cy + s)],
                 fill=color)


def _draw_card_face(draw: ImageDraw.ImageDraw, x: int, y: int,
                    value: int, index: int) -> None:
    draw.rounded_rectangle((x, y, x + CARD_W, y + CARD_H), radius=12,
                           fill=PAPER, outline=CARD_BORDER, width=2)
    suit = card_suit(value, index)
    color = SUIT_RED if suit in _RED_SUITS else INK
    label = card_rank_label(value)
    rank_font = _font(34)
    bbox = draw.textbbox((0, 0), label, font=rank_font)
    draw.text((x + 12 - bbox[0], y + 8 - bbox[1]), label,
              font=rank_font, fill=color)
    _draw_suit(draw, suit, x + 23, y + 62, 12, color)
    _draw_suit(draw, suit, x + CARD_W / 2, y + CARD_H / 2 + 16, 34, color)


def _card_back_tile() -> Image.Image:
    """カード裏面（紺地＋ティールのダイヤ格子＋金円に AGO）。"""
    tile = Image.new("RGB", (CARD_W, CARD_H), _BACK_BASE)
    draw = ImageDraw.Draw(tile)
    step = 22
    for gx in range(-CARD_H, CARD_W + CARD_H, step):
        draw.line((gx, 0, gx + CARD_H, CARD_H), fill=_BACK_LINE, width=2)
        draw.line((gx, 0, gx - CARD_H, CARD_H), fill=_BACK_LINE, width=2)
    mask = Image.new("L", (CARD_W, CARD_H), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, CARD_W, CARD_H), radius=12, fill=255)
    base = Image.new("RGB", (CARD_W, CARD_H), PAPER)
    base.paste(tile, (0, 0), mask)
    draw = ImageDraw.Draw(base)
    draw.rounded_rectangle((0, 0, CARD_W, CARD_H), radius=12,
                           outline=CARD_BORDER, width=2)
    cx, cy, r = CARD_W // 2, CARD_H // 2, 30
    draw.ellipse((cx - r, cy - r, cx + r, cy + r), outline=GOLD, width=3)
    font = _font(24)
    text = "AGO"
    bbox = draw.textbbox((0, 0), text, font=font)
    draw.text((cx - (bbox[2] - bbox[0]) / 2 - bbox[0],
               cy - (bbox[3] - bbox[1]) / 2 - bbox[1]),
              text, font=font, fill=GOLD)
    return base


def _draw_badge(draw: ImageDraw.ImageDraw, cx: int, cy: int, text: str,
                *, fill=BADGE_BG, ink=BADGE_INK, font_size: int = 30) -> None:
    font = _font(font_size)
    bbox = draw.textbbox((0, 0), text, font=font)
    w = (bbox[2] - bbox[0]) + 36
    h = (bbox[3] - bbox[1]) + 20
    draw.rounded_rectangle((cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2),
                           radius=h // 2, fill=fill, outline=FELT_ARC, width=2)
    draw.text((cx - (bbox[2] - bbox[0]) / 2 - bbox[0],
               cy - (bbox[3] - bbox[1]) / 2 - bbox[1]),
              text, font=font, fill=ink)


def _hand_xs(count: int) -> list[int]:
    """手札カードの左端 x 列。多いときは重ねて盤面幅に収める。"""
    if count <= 0:
        return []
    if count == 1:
        return [(BOARD_W - CARD_W) // 2]
    step = CARD_W + _CARD_GAP
    total_w = CARD_W + step * (count - 1)
    if total_w > _HAND_MAX_W:
        step = (_HAND_MAX_W - CARD_W) // (count - 1)
        total_w = CARD_W + step * (count - 1)
    start = (BOARD_W - total_w) // 2
    return [start + step * i for i in range(count)]


def _felt_background() -> Image.Image:
    img = Image.new("RGB", (BOARD_W, BOARD_H), FELT_TOP)
    draw = ImageDraw.Draw(img)
    for y in range(BOARD_H):
        t = y / max(1, BOARD_H - 1)
        draw.line((0, y, BOARD_W, y), fill=tuple(
            int(FELT_TOP[i] + (FELT_BOTTOM[i] - FELT_TOP[i]) * t)
            for i in range(3)))
    # テーブルアーク（金細線）と内側のティール線。主役のカードより
    # 目立たないよう、半透明で敷く。
    overlay = Image.new("RGBA", (BOARD_W, BOARD_H), (0, 0, 0, 0))
    odraw = ImageDraw.Draw(overlay)
    odraw.ellipse((84, 158, BOARD_W - 84, 512),
                  outline=GOLD + (150,), width=3)
    odraw.ellipse((100, 170, BOARD_W - 100, 500),
                  outline=FELT_ARC + (110,), width=2)
    img.paste(Image.alpha_composite(img.convert("RGBA"), overlay)
              .convert("RGB"), (0, 0))
    return img


# ---------------------------------------------------------------------------
# 本体
# ---------------------------------------------------------------------------

def render_blackjack_png(*, player_hand: list[int], dealer_hand: list[int],
                         dealer_hidden: bool, bet: int,
                         player_name: str = "あなた",
                         user_id: int | None = None,
                         avatar_bytes: bytes | None = None,
                         outcome: str | None = None,
                         delta: int | None = None) -> bytes:
    """盤面1枚を PNG バイト列で返す（純関数・例外は呼び出し側で受ける）。

    dealer_hidden=True の間は dealer_hand の先頭1枚だけを表向きにし、
    2枚目は常に裏面で描く（2枚目以降の値は参照しない）。
    outcome は None（対局中）/ "win" / "lose" / "push" / "bust"。
    delta は精算時の増減（AGO）。outcome があるときだけ表示する。
    """
    player = [int(v) for v in player_hand]
    dealer = [int(v) for v in dealer_hand]
    img = _felt_background()
    draw = ImageDraw.Draw(img)

    # ヘッダー: タイトルとベット額。
    title_font = _font(36)
    draw.text((36, 26), "ブラックジャック", font=title_font, fill=BADGE_INK)
    bet_text = f"BET {int(bet):,} AGO"
    bet_font = _font(28)
    bbox = draw.textbbox((0, 0), bet_text, font=bet_font)
    bw = (bbox[2] - bbox[0]) + 36
    draw.rounded_rectangle((BOARD_W - 36 - bw, 24, BOARD_W - 36, 68),
                           radius=22, fill=BADGE_BG, outline=GOLD, width=2)
    draw.text((BOARD_W - 36 - bw / 2 - (bbox[2] - bbox[0]) / 2 - bbox[0],
               46 - (bbox[3] - bbox[1]) / 2 - bbox[1]),
              bet_text, font=bet_font, fill=GOLD)

    # ディーラー行。
    label_font = _font(26)
    draw.text((36, 92), "ディーラー", font=label_font, fill=LABEL_INK)
    _draw_badge(draw, BOARD_W - 110, 105,
                dealer_badge_text(dealer, dealer_hidden=dealer_hidden),
                font_size=28)
    dealer_y = 128
    if dealer_hidden:
        visible = dealer[:1]
        xs = _hand_xs(len(visible) + 1) if visible else _hand_xs(1)
        for i, value in enumerate(visible):
            _draw_card_face(draw, xs[i], dealer_y, value, i)
        back = _card_back_tile()
        img.paste(back, (xs[len(visible)], dealer_y))
        draw = ImageDraw.Draw(img)
    else:
        xs = _hand_xs(len(dealer))
        for i, value in enumerate(dealer):
            _draw_card_face(draw, xs[i], dealer_y, value, i)

    # 中央: 結果バナー（精算時のみ）。
    if outcome in _OUTCOME_TEXT:
        text = _OUTCOME_TEXT[outcome]
        if delta is not None:
            text = f"{text}  {format_delta(delta)}"
        font = _font(40)
        bbox = draw.textbbox((0, 0), text, font=font)
        draw.text(((BOARD_W - (bbox[2] - bbox[0])) / 2 - bbox[0],
                   316 - bbox[1]),
                  text, font=font, fill=_OUTCOME_INK[outcome])

    # プレイヤー行。
    player_y = 356
    xs = _hand_xs(len(player))
    for i, value in enumerate(player):
        _draw_card_face(draw, xs[i], player_y, value, i)

    # 下部: アバター＋名前＋合計バッジ。
    avatar = circle_avatar(user_id, player_name or "あなた",
                           avatar_bytes, 52)
    img.paste(avatar, (36, BOARD_H - 66), avatar)
    draw = ImageDraw.Draw(img)
    name_font = _font(26)
    name = str(player_name or "あなた")
    bbox = draw.textbbox((0, 0), name, font=name_font)
    if bbox[2] - bbox[0] > 380:
        while name and (bbox[2] - bbox[0]) > 380:
            name = name[:-1]
            bbox = draw.textbbox((0, 0), name + "…", font=name_font)
        name = name + "…"
    draw.text((102, BOARD_H - 62), name, font=name_font, fill=BADGE_INK)
    _draw_badge(draw, BOARD_W - 110, BOARD_H - 40,
                player_badge_text(player), font_size=28)

    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()
