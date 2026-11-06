# -*- coding: utf-8 -*-
"""タイル盤面の PIL 画像描画（ラウンド4の画像盤面経路）。

方針（ユーザー指示 2026-11-06）: 格子/タイル状の盤面をテキストで再現すると
安っぽくなるため、bot 既存の PIL 描画（将棋/チェスと同じ font.ttf 基盤）で
画像化し、Components V2 では ui.File + MediaGallery で送る。

- ``render_tiles``: (ラベル, 背景色) のタイルを行列で描く汎用描画。
- ``render_gauge``: 価値観ゲージの目盛り帯（中心帯・予想マーカー付き）。
- ``render_card`` / ``render_card_hand`` / ``render_card_rows`` /
  ``render_card_pile``: 共通トランプ描画（標準52枚＋ジョーカー、裏面）。
  スートは同梱フォントに ♠♦♣ のグリフが無いためベクタ描画する。
どちらも PNG の bytes を返す純関数で、単体テストで検証できる。
"""
import io
from collections import OrderedDict
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

# このファイルは core/game/ 配下にあるため、リポジトリ直下の font.ttf は parents[2]。
# （core/ 直下にあった時代の parent.parent のままだと core/font.ttf を指して
#  存在せず、全描画が PIL 既定フォントに silently フォールバックしていた。）
FONT_PATH = Path(__file__).resolve().parents[2] / "font.ttf"
TILE = 64
GAP = 6
PAD = 12
BG = (24, 26, 32)
FG = (245, 245, 245)


def _font(size: int):
    try:
        return ImageFont.truetype(str(FONT_PATH), size)
    except Exception:
        return ImageFont.load_default()


# ---------------------------------------------------------------------------
# 盤面画像キャッシュ（盤面画像化タスク 2026-11-06）
#
# 1手ごとの再描画は Pi 負荷になるため、同一状態の盤面は再生成しない。
# 状態をキー化できる呼び出し側が render_cached 経由で描く。プロセス全体で
# 最大 _CACHE_MAX 件の LRU（盤面は大きくても数百KBなので 32 件でも安全）。
_CACHE_MAX = 32
_render_cache: "OrderedDict[object, bytes]" = OrderedDict()


def render_cached(key, producer) -> bytes:
    """key がキャッシュにあればそれを返し、無ければ producer() で生成して保持する。"""
    if key in _render_cache:
        _render_cache.move_to_end(key)
        return _render_cache[key]
    data = producer()
    _render_cache[key] = data
    while len(_render_cache) > _CACHE_MAX:
        _render_cache.popitem(last=False)
    return data


def _centered(draw, cx, cy, text, font, fill):
    bbox = draw.textbbox((0, 0), text, font=font)
    draw.text((cx - (bbox[2] - bbox[0]) / 2 - bbox[0], cy - (bbox[3] - bbox[1]) / 2 - bbox[1]),
              text, fill=fill, font=font)


def render_tiles(rows: list[list[tuple[str, tuple[int, int, int]]]],
                 *, tile: int = TILE, title: str | None = None) -> bytes:
    """タイル行列を描く。rows は [[(ラベル, RGB), ...], ...]。"""
    cols = max((len(r) for r in rows), default=0)
    title_h = 34 if title else 0
    width = PAD * 2 + cols * tile + max(0, cols - 1) * GAP
    height = PAD * 2 + title_h + len(rows) * tile + max(0, len(rows) - 1) * GAP
    img = Image.new("RGB", (max(width, 120), max(height, 80)), BG)
    draw = ImageDraw.Draw(img)
    y = PAD
    if title:
        draw.text((PAD, y), title, fill=FG, font=_font(20))
        y += title_h
    font = _font(22)
    for row in rows:
        x = PAD
        for label, color in row:
            draw.rounded_rectangle([x, y, x + tile, y + tile], radius=10, fill=color)
            if label:
                bbox = draw.textbbox((0, 0), label, font=font)
                tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
                draw.text((x + (tile - tw) / 2 - bbox[0], y + (tile - th) / 2 - bbox[1]),
                          label, fill=(20, 20, 20), font=font)
            x += tile + GAP
        y += tile + GAP
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def render_gauge(center: int | None, guess: int | None = None, *,
                 scale: int = 10, left: str = "", right: str = "") -> bytes:
    """0..scale の帯を描く。center があれば得点帯（±2/±1/中心）を色分けし、
    guess があればマーカーを立てる。center=None のときは帯を均一色にする。"""
    cell = 52
    width = PAD * 2 + (scale + 1) * cell
    height = 150
    img = Image.new("RGB", (width, height), BG)
    draw = ImageDraw.Draw(img)
    font = _font(18)
    y0, y1 = 44, 96
    for pos in range(scale + 1):
        x = PAD + pos * cell
        if center is None:
            color = (70, 76, 90)
        else:
            d = abs(pos - center)
            color = {0: (255, 193, 7), 1: (255, 152, 0), 2: (255, 213, 79)}.get(d, (70, 76, 90))
        draw.rounded_rectangle([x + 2, y0, x + cell - 2, y1], radius=8, fill=color)
        label = str(pos)
        bbox = draw.textbbox((0, 0), label, font=font)
        draw.text((x + (cell - (bbox[2] - bbox[0])) / 2 - bbox[0], y0 + 16 - bbox[1]),
                  label, fill=(20, 20, 20), font=font)
    if guess is not None:
        x = PAD + guess * cell + cell // 2
        draw.polygon([(x, y1 + 6), (x - 9, y1 + 24), (x + 9, y1 + 24)], fill=(66, 165, 245))
        draw.text((x - 12, y1 + 26), "予想", fill=(66, 165, 245), font=font)
    if center is not None:
        x = PAD + center * cell + cell // 2
        draw.polygon([(x, y0 - 6), (x - 9, y0 - 24), (x + 9, y0 - 24)], fill=(255, 193, 7))
    if left:
        draw.text((PAD, 4), f"◀ {left}", fill=FG, font=font)
    if right:
        bbox = draw.textbbox((0, 0), f"{right} ▶", font=font)
        draw.text((width - PAD - (bbox[2] - bbox[0]), 4), f"{right} ▶", fill=FG, font=font)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


# ---------------------------------------------------------------------------
# 個別ゲームの盤面描画（盤面画像化タスク 2026-11-06）
#
# 盤面は画像、操作はボタン/セレクトに分離する。ここにあるのは描画だけの
# 純関数で、状態の持ち方・進行ロジックは各 core/game/<game>.py と cog 側。
# 座標ラベル（行・列の見出し）は全て画像側に含める。

# --- マインスイーパー -------------------------------------------------------
# states の各マスは (kind, value):
#   ("hidden", None) 未開 / ("flag", None) 旗 / ("open", n) 開封（周辺地雷数 n）
#   ("mine", None) 地雷（終了時の公開用） / ("exploded", None) 踏んだ地雷
MS_NUMBER_COLORS = {
    1: (37, 99, 235), 2: (22, 163, 74), 3: (220, 38, 38), 4: (30, 58, 138),
    5: (154, 52, 18), 6: (13, 148, 136), 7: (30, 30, 30), 8: (107, 114, 128),
}
MS_HIDDEN = (172, 182, 198)
MS_HIDDEN_LIGHT = (226, 232, 240)
MS_HIDDEN_DARK = (100, 110, 128)
MS_OPEN_BG = (224, 227, 232)


def _ms_flag(draw, x, y, tile):
    """旗をベクタ描画する（絵文字フォントに依存しない）。"""
    cx = x + tile // 2
    top = y + tile // 5
    bottom = y + tile - tile // 6
    draw.line([(cx, top), (cx, bottom)], fill=(60, 60, 60), width=max(2, tile // 16))
    draw.polygon([(cx, top), (cx + tile // 3, top + tile // 5), (cx, top + tile // 3)],
                 fill=(220, 38, 38))
    draw.line([(cx - tile // 4, bottom), (cx + tile // 4, bottom)],
              fill=(60, 60, 60), width=max(2, tile // 16))


def _ms_mine(draw, x, y, tile):
    cx, cy = x + tile // 2, y + tile // 2
    r = tile // 4
    for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)):
        draw.line([(cx, cy), (cx + dx * (r + tile // 8), cy + dy * (r + tile // 8))],
                  fill=(25, 25, 25), width=max(2, tile // 14))
    draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(25, 25, 25))
    draw.ellipse([cx - r // 2, cy - r // 2, cx - r // 4, cy - r // 4], fill=(200, 200, 200))


def render_minesweeper(states, *, selected=None, tile: int = 40) -> bytes:
    """マインスイーパー盤面。列見出しは A,B,C...、行見出しは 1,2,...。"""
    rows = len(states)
    cols = max((len(r) for r in states), default=0)
    head = tile  # 見出しの帯（上・左）
    width = head + cols * tile + PAD
    height = head + rows * tile + PAD
    img = Image.new("RGB", (width, height), BG)
    draw = ImageDraw.Draw(img)
    head_font = _font(max(13, tile // 3))
    num_font = _font(int(tile * 0.52))
    for c in range(cols):
        _centered(draw, head + c * tile + tile // 2, head // 2,
                  chr(ord("A") + c) if c < 26 else str(c + 1), head_font, (170, 178, 195))
    for r in range(rows):
        _centered(draw, head // 2, head + r * tile + tile // 2, str(r + 1), head_font, (170, 178, 195))
    # 軸ラベル（左上の隅に X=横 / Y=縦 を対角配置。座標表記の X/Y 統一対応）
    axis_font = _font(max(11, tile // 3))
    _centered(draw, int(head * 0.68), int(head * 0.30), "X", axis_font, (250, 204, 21))
    _centered(draw, int(head * 0.32), int(head * 0.70), "Y", axis_font, (250, 204, 21))
    for r in range(rows):
        for c in range(cols):
            kind, value = states[r][c]
            x, y = head + c * tile, head + r * tile
            if kind == "open":
                draw.rectangle([x, y, x + tile - 1, y + tile - 1], fill=MS_OPEN_BG)
                draw.rectangle([x, y, x + tile - 1, y + tile - 1], outline=(178, 182, 190))
                if value:
                    _centered(draw, x + tile // 2, y + tile // 2, str(value),
                              num_font, MS_NUMBER_COLORS.get(value, (30, 30, 30)))
            elif kind in ("mine", "exploded"):
                bg = (248, 113, 113) if kind == "exploded" else MS_OPEN_BG
                draw.rectangle([x, y, x + tile - 1, y + tile - 1], fill=bg)
                draw.rectangle([x, y, x + tile - 1, y + tile - 1], outline=(178, 182, 190))
                _ms_mine(draw, x, y, tile)
            else:  # hidden / flag: 浮き出たタイル（ベベル）
                draw.rectangle([x, y, x + tile - 1, y + tile - 1], fill=MS_HIDDEN)
                draw.line([(x, y), (x + tile - 1, y)], fill=MS_HIDDEN_LIGHT, width=3)
                draw.line([(x, y), (x, y + tile - 1)], fill=MS_HIDDEN_LIGHT, width=3)
                draw.line([(x, y + tile - 1), (x + tile - 1, y + tile - 1)], fill=MS_HIDDEN_DARK, width=3)
                draw.line([(x + tile - 1, y), (x + tile - 1, y + tile - 1)], fill=MS_HIDDEN_DARK, width=3)
                if kind == "flag":
                    _ms_flag(draw, x, y, tile)
            if selected is not None and tuple(selected) == (r, c):
                draw.rectangle([x + 1, y + 1, x + tile - 2, y + tile - 2],
                               outline=(250, 204, 21), width=3)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


# --- 2048 -------------------------------------------------------------------
TILE2048_COLORS = {
    0: (205, 193, 180), 2: (238, 228, 218), 4: (237, 224, 200),
    8: (242, 177, 121), 16: (245, 149, 99), 32: (246, 124, 95),
    64: (246, 94, 59), 128: (237, 207, 114), 256: (237, 204, 97),
    512: (237, 200, 80), 1024: (237, 197, 63), 2048: (237, 194, 46),
}
TILE2048_SUPER = (62, 58, 50)


def render_2048(board, *, tile: int = 96, gap: int = 10, pad: int = 10) -> bytes:
    """2048 の 4x4 盤面。値ごとの色分けと角丸タイルで描く。"""
    n = len(board)
    size = pad * 2 + n * tile + (n - 1) * gap
    img = Image.new("RGB", (size, size), (187, 173, 160))
    draw = ImageDraw.Draw(img)
    draw.rounded_rectangle([0, 0, size - 1, size - 1], radius=12, fill=(187, 173, 160))
    for r in range(n):
        for c in range(n):
            v = board[r][c]
            x, y = pad + c * (tile + gap), pad + r * (tile + gap)
            color = TILE2048_COLORS.get(v, TILE2048_SUPER)
            draw.rounded_rectangle([x, y, x + tile, y + tile], radius=8, fill=color)
            if v:
                digits = len(str(v))
                font = _font(44 if digits <= 2 else 36 if digits == 3 else 29 if digits == 4 else 24)
                fill = (119, 110, 101) if v <= 4 else (249, 246, 242)
                _centered(draw, x + tile // 2, y + tile // 2, str(v), font, fill)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


# --- 数独 -------------------------------------------------------------------
def render_sudoku(board, givens, *, selected=None, tile: int = 52) -> bytes:
    """数独 9x9。初期数字は濃色、入力数字は青。3x3 ブロックは太線。"""
    head = 30
    size = head + 9 * tile + PAD
    img = Image.new("RGB", (size, size), BG)
    draw = ImageDraw.Draw(img)
    head_font = _font(15)
    given_font = _font(30)
    user_font = _font(30)
    for i in range(9):
        _centered(draw, head + i * tile + tile // 2, head // 2, str(i + 1), head_font, (170, 178, 195))
        _centered(draw, head // 2, head + i * tile + tile // 2, str(i + 1), head_font, (170, 178, 195))
    # 軸ラベル（左上の隅に X=横 / Y=縦 を対角配置。座標表記の X/Y 統一対応）
    axis_font = _font(13)
    _centered(draw, int(head * 0.68), int(head * 0.30), "X", axis_font, (37, 99, 235))
    _centered(draw, int(head * 0.32), int(head * 0.70), "Y", axis_font, (37, 99, 235))
    sel = tuple(selected) if selected is not None else None
    for r in range(9):
        for c in range(9):
            x, y = head + c * tile, head + r * tile
            bg = (250, 250, 247)
            if sel is not None and (r == sel[0] or c == sel[1]
                                    or (r // 3, c // 3) == (sel[0] // 3, sel[1] // 3)):
                bg = (254, 243, 199)
            if sel == (r, c):
                bg = (253, 224, 71)
            draw.rectangle([x, y, x + tile - 1, y + tile - 1], fill=bg)
            v = board[r][c]
            if v:
                if givens[r][c]:
                    _centered(draw, x + tile // 2, y + tile // 2, str(v), given_font, (31, 41, 55))
                else:
                    _centered(draw, x + tile // 2, y + tile // 2, str(v), user_font, (37, 99, 235))
    for i in range(10):
        w = 4 if i % 3 == 0 else 1
        color = (51, 65, 85) if i % 3 == 0 else (203, 213, 225)
        p = head + i * tile
        draw.line([(p, head), (p, head + 9 * tile)], fill=color, width=w)
        draw.line([(head, p), (head + 9 * tile, p)], fill=color, width=w)
    if sel is not None:
        x, y = head + sel[1] * tile, head + sel[0] * tile
        draw.rectangle([x + 1, y + 1, x + tile - 2, y + tile - 2], outline=(37, 99, 235), width=3)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


# --- ノノグラム ---------------------------------------------------------------
def render_nonogram(row_clues, col_clues, grid, *, selected=None, cell: int = 44) -> bytes:
    """ノノグラム盤面。行列ヒントを画像側に描き、塗り/バツ/未定を描き分ける。"""
    n = len(grid)
    max_row = max((len(c) for c in row_clues), default=1)
    max_col = max((len(c) for c in col_clues), default=1)
    clue_w = 24
    clue_h = 22
    left = max_row * clue_w + 10
    top = max_col * clue_h + 10
    width = left + n * cell + PAD
    height = top + n * cell + PAD
    img = Image.new("RGB", (width, height), BG)
    draw = ImageDraw.Draw(img)
    clue_font = _font(16)
    sel = tuple(selected) if selected is not None else None
    # 列ヒント（下詰め）
    for c in range(n):
        clues = col_clues[c]
        for i, v in enumerate(clues):
            y = top - (len(clues) - i) * clue_h - clue_h // 2 - 4
            fill = (250, 204, 21) if sel is not None and sel[1] == c else (203, 213, 225)
            _centered(draw, left + c * cell + cell // 2, y, str(v), clue_font, fill)
    # 行ヒント（右詰め）
    for r in range(n):
        clues = row_clues[r]
        for i, v in enumerate(clues):
            x = left - (len(clues) - i) * clue_w - clue_w // 2 - 4
            fill = (250, 204, 21) if sel is not None and sel[0] == r else (203, 213, 225)
            _centered(draw, x, top + r * cell + cell // 2, str(v), clue_font, fill)
    for r in range(n):
        for c in range(n):
            x, y = left + c * cell, top + r * cell
            v = grid[r][c]
            if v == 1:
                draw.rounded_rectangle([x + 2, y + 2, x + cell - 2, y + cell - 2],
                                       radius=6, fill=(51, 65, 85))
            else:
                draw.rectangle([x, y, x + cell - 1, y + cell - 1], fill=(241, 245, 249))
                if v == 2:
                    m = cell // 4
                    draw.line([(x + m, y + m), (x + cell - m, y + cell - m)],
                              fill=(220, 38, 38), width=3)
                    draw.line([(x + cell - m, y + m), (x + m, y + cell - m)],
                              fill=(220, 38, 38), width=3)
            draw.rectangle([x, y, x + cell - 1, y + cell - 1], outline=(148, 163, 184))
            if sel == (r, c):
                draw.rectangle([x + 1, y + 1, x + cell - 2, y + cell - 2],
                               outline=(37, 99, 235), width=3)
    draw.rectangle([left, top, left + n * cell - 1, top + n * cell - 1],
                   outline=(71, 85, 105), width=3)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


# --- 爆弾処理班 -------------------------------------------------------------
# slots の各タイルは公開情報だけを表すタプル:
#   ("cut", number)                      カット済み（数字は公開済み）
#   ("hidden", parity, not_numbers)      未カット。parity は None/"even"/"odd"/"red"、
#                                        not_numbers は「その数字ではない」と判明した数字の組。
# 未カットタイルの本当の数字はこの関数に渡らない（秘匿の担保は呼び出し側の
# データ構築とテストで検証する）。
WIRE_HIDDEN = (96, 110, 130)
WIRE_CUT = (129, 199, 132)
WIRE_RED = (183, 28, 28)


def render_wirecut_board(players, *, remaining: int, fuse_left: int, fuse_max: int) -> bytes:
    """爆弾処理班の共有盤面。各プレイヤーのラックを位置番号つきスロットで描く。

    players は [{"label": 表示名（情報トークン数など）, "slots": [slot, ...]}]。
    """
    max_tiles = max((len(p["slots"]) for p in players), default=0)
    tile = 56 if max_tiles <= 12 else 46 if max_tiles <= 18 else 38
    label_h = 28
    row_gap = 16
    title_h = 38
    width = PAD * 2 + max_tiles * tile + max(0, max_tiles - 1) * GAP
    height = PAD + title_h + len(players) * (label_h + tile) \
        + max(0, len(players) - 1) * row_gap + PAD
    img = Image.new("RGB", (max(width, 200), max(height, 120)), BG)
    draw = ImageDraw.Draw(img)
    title_font = _font(21)
    draw.text((PAD, PAD), f"残り数字ワイヤー {remaining}本 ／ ヒューズ {fuse_left}/{fuse_max}",
              fill=FG, font=title_font)
    label_font = _font(19)
    pos_font = _font(max(11, tile // 4))
    main_font = _font(int(tile * 0.44))
    sub_font = _font(max(11, tile // 4))
    y = PAD + title_h
    for player in players:
        draw.text((PAD, y), str(player["label"]), fill=FG, font=label_font)
        y += label_h
        x = PAD
        for i, slot in enumerate(player["slots"]):
            if slot[0] == "cut":
                color, main, main_fill = WIRE_CUT, str(slot[1]), (20, 20, 20)
            else:
                parity = slot[1] if len(slot) > 1 else None
                if parity == "red":
                    color, main, main_fill = WIRE_RED, "赤", (255, 255, 255)
                elif parity == "even":
                    color, main, main_fill = WIRE_HIDDEN, "偶", FG
                elif parity == "odd":
                    color, main, main_fill = WIRE_HIDDEN, "奇", FG
                else:
                    color, main, main_fill = WIRE_HIDDEN, "？", FG
            draw.rounded_rectangle([x, y, x + tile, y + tile], radius=8, fill=color)
            draw.text((x + 4, y + 2), str(i + 1), fill=(215, 220, 230), font=pos_font)
            _centered(draw, x + tile // 2, y + tile // 2 + 3, main, main_font, main_fill)
            if slot[0] == "hidden" and len(slot) > 2 and slot[2]:
                note = "≠" + ",".join(str(n) for n in slot[2])
                _centered(draw, x + tile // 2, y + tile - 9, note, sub_font, (255, 213, 79))
            x += tile + GAP
        y += tile + row_gap
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


# --- ビンゴカード -----------------------------------------------------------
BINGO_LETTERS = "BINGO"
BINGO_MARKED = (255, 152, 0)
BINGO_FREE = (255, 193, 7)
BINGO_UNMARKED = (236, 239, 241)


def render_bingo_card(grid, marked, *, tile: int = 56) -> bytes:
    """ビンゴカード（5×5）を描く。当選マスは橙、中央フリーは黄＋★。

    列見出しは古典的な B/I/N/G/O。数字そのものが座標ではないため
    X/Y 軸ラベルは付けない（座標系ゲームではない）。
    """
    head = 30
    width = PAD * 2 + 5 * tile + 4 * GAP
    height = PAD + head + 5 * tile + 4 * GAP + PAD
    img = Image.new("RGB", (width, height), BG)
    draw = ImageDraw.Draw(img)
    head_font = _font(20)
    num_font = _font(24)
    for c in range(5):
        x = PAD + c * (tile + GAP)
        _centered(draw, x + tile // 2, PAD + head // 2, BINGO_LETTERS[c], head_font, (170, 178, 195))
    for r in range(5):
        for c in range(5):
            x = PAD + c * (tile + GAP)
            y = PAD + head + r * (tile + GAP)
            value = grid[r][c]
            if value is None:
                color, label = BINGO_FREE, "★"
            elif marked[r][c]:
                color, label = BINGO_MARKED, str(value)
            else:
                color, label = BINGO_UNMARKED, str(value)
            draw.rounded_rectangle([x, y, x + tile, y + tile], radius=10, fill=color)
            _centered(draw, x + tile // 2, y + tile // 2, label, num_font, (20, 20, 20))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


# --- トランプ（共通カード描画基盤、カード画像化タスク 2026-11-06） -----------
# カードの正規形（spec）は (ランク, スート) のタプル:
#   ランク: "A","2",...,"10","J","Q","K" ／ スート: "S","H","D","C"
#   ジョーカーは CARD_JOKER、裏面は None。
# スートはベクタ描画する。同梱の主フォント（font.ttf）には ♥ と ★ しか
# トランプ記号が無く（♠♦♣ はグリフ無しを確認済み）、フォントに頼ると
# スートが豆腐/欠落になるため、図形で描く（地雷・旗と同じ方針）。
CARD_RANKS = ("A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K")
CARD_SUITS = ("S", "H", "D", "C")
CARD_JOKER = ("JOKER", "")
CARD_RED = (198, 34, 44)
CARD_BLACK = (28, 30, 38)
CARD_FACE_BG = (250, 249, 245)
CARD_FACE_EDGE = (110, 114, 128)
CARD_BACK_BG = (33, 47, 112)
CARD_BACK_INNER = (55, 75, 148)
CARD_BACK_LINE = (205, 216, 245)
CARD_W = 104
CARD_H = 146


def card_spec(rank, suit):
    """(ランク, スート) を検証して正規形タプルで返す。スートは "SHDC"。"""
    rank = str(rank)
    suit = str(suit).upper()
    if rank not in CARD_RANKS or suit not in CARD_SUITS:
        raise ValueError(f"不正なカード: rank={rank!r} suit={suit!r}")
    return (rank, suit)


def _draw_suit(draw, suit, cx, cy, size, color):
    """スートをベクタ描画する。size はスート全体の高さ（px）。中心は (cx, cy)。"""
    h = size / 2.0
    if suit == "D":
        draw.polygon([(cx, cy - h), (cx + h * 0.68, cy), (cx, cy + h), (cx - h * 0.68, cy)],
                     fill=color)
        return
    if suit in ("H", "S"):
        # ハートは「2円＋下向き三角」、スペードはその上下反転＋茎。
        flip = 1 if suit == "H" else -1
        r = size * 0.235
        dy = -flip * size * 0.13
        draw.ellipse([cx - size * 0.235 - r, cy + dy - r, cx - size * 0.235 + r, cy + dy + r],
                     fill=color)
        draw.ellipse([cx + size * 0.235 - r, cy + dy - r, cx + size * 0.235 + r, cy + dy + r],
                     fill=color)
        draw.polygon([(cx - size * 0.46, cy - flip * size * 0.02),
                      (cx + size * 0.46, cy - flip * size * 0.02),
                      (cx, cy + flip * h)], fill=color)
        if suit == "S":
            _card_stem(draw, cx, cy, size, color)
        return
    if suit == "C":
        r = size * 0.225
        for dx, dy in ((0, -size * 0.21), (-size * 0.225, size * 0.075),
                       (size * 0.225, size * 0.075)):
            draw.ellipse([cx + dx - r, cy + dy - r, cx + dx + r, cy + dy + r], fill=color)
        _card_stem(draw, cx, cy, size, color)
        return
    raise ValueError(f"未知のスート: {suit!r}")


def _card_stem(draw, cx, cy, size, color):
    """スペード/クラブの茎（下部の台形）。"""
    top = cy + size * 0.08
    bottom = cy + size * 0.5
    draw.polygon([(cx, top), (cx - size * 0.07, bottom), (cx - size * 0.19, bottom),
                  (cx - size * 0.05, top)], fill=color)
    draw.polygon([(cx, top), (cx + size * 0.05, top), (cx + size * 0.19, bottom),
                  (cx + size * 0.07, bottom)], fill=color)


def _draw_star(draw, cx, cy, r, color):
    """5芒星をベクタ描画する（ジョーカー用。★ グリフに依存しない）。"""
    import math
    pts = []
    for i in range(10):
        ang = -math.pi / 2 + i * math.pi / 5
        rad = r if i % 2 == 0 else r * 0.45
        pts.append((cx + rad * math.cos(ang), cy + rad * math.sin(ang)))
    draw.polygon(pts, fill=color)


def _card_corner(spec, w, h):
    """カード左上の隅表示（ランク＋小スート）を RGBA 小画像で作る。

    右下の隅はこれを 180° 回転させて使い、実物のカードらしくする。
    """
    rank, suit = spec
    color = CARD_RED if suit in ("H", "D") else CARD_BLACK
    cw = int(w * 0.34)
    ch = int(h * 0.36)
    img = Image.new("RGBA", (cw, ch), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    font = _font(int(w * (0.20 if len(rank) > 1 else 0.24)))
    bbox = draw.textbbox((0, 0), rank, font=font)
    draw.text(((cw - (bbox[2] - bbox[0])) / 2 - bbox[0], -bbox[1] + 1),
              rank, fill=color + (255,), font=font)
    _draw_suit(draw, suit, cw / 2, ch * 0.68, w * 0.17, color)
    return img


def _paint_card(canvas, x, y, w, h, spec):
    """canvas の (x, y) に w×h のカードを1枚描く。spec=None は裏面。"""
    draw = ImageDraw.Draw(canvas)
    radius = max(6, int(w * 0.09))
    if spec is None:
        draw.rounded_rectangle([x, y, x + w, y + h], radius=radius, fill=CARD_BACK_BG)
        m = max(4, int(w * 0.07))
        draw.rounded_rectangle([x + m, y + m, x + w - m, y + h - m], radius=radius - 2,
                               outline=CARD_BACK_LINE, width=max(2, w // 36))
        # 菱形の格子模様（手続き描画のパターン）
        step = max(12, w // 5)
        lattice = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        ld = ImageDraw.Draw(lattice)
        for gy in range(-h, h * 2, step):
            ld.line([(0, gy), (w, gy + w)], fill=CARD_BACK_INNER + (255,), width=2)
            ld.line([(0, gy), (w, gy - w)], fill=CARD_BACK_INNER + (255,), width=2)
        mask = Image.new("L", (w, h), 0)
        ImageDraw.Draw(mask).rounded_rectangle(
            [m + 2, m + 2, w - m - 2, h - m - 2], radius=radius - 2, fill=255)
        canvas.paste(Image.alpha_composite(
            Image.new("RGBA", (w, h), (0, 0, 0, 0)), lattice).crop((0, 0, w, h)),
            (x, y), mask)
        draw = ImageDraw.Draw(canvas)
        ring = w * 0.20
        draw.ellipse([x + w / 2 - ring, y + h / 2 - ring, x + w / 2 + ring, y + h / 2 + ring],
                     outline=(245, 197, 66), width=max(2, w // 30))
        _draw_star(draw, x + w / 2, y + h / 2, w * 0.10, (245, 197, 66))
        draw.rounded_rectangle([x, y, x + w, y + h], radius=radius,
                               outline=CARD_FACE_EDGE, width=2)
        return
    rank, suit = spec
    draw.rounded_rectangle([x, y, x + w, y + h], radius=radius, fill=CARD_FACE_BG)
    draw.rounded_rectangle([x, y, x + w, y + h], radius=radius,
                           outline=CARD_FACE_EDGE, width=2)
    if spec == CARD_JOKER:
        _draw_star(draw, x + w / 2, y + h * 0.13, w * 0.11, CARD_RED)
        font = _font(int(w * 0.19))
        for i, ch in enumerate("JOKER"):
            _centered(draw, x + w / 2, y + h * (0.315 + i * 0.118), ch, font,
                      CARD_RED if i % 2 == 0 else CARD_BLACK)
        _draw_star(draw, x + w / 2, y + h * 0.93, w * 0.08, CARD_BLACK)
        return
    color = CARD_RED if suit in ("H", "D") else CARD_BLACK
    corner = _card_corner(spec, w, h)
    canvas.paste(corner, (int(x + w * 0.045), int(y + h * 0.03)), corner)
    flipped = corner.rotate(180)
    canvas.paste(flipped, (int(x + w - corner.width - w * 0.045),
                           int(y + h - corner.height - h * 0.03)), flipped)
    draw = ImageDraw.Draw(canvas)
    _draw_suit(draw, suit, x + w / 2, y + h / 2, w * 0.52, color)


def render_card(spec, *, card_w: int = 168) -> bytes:
    """カード1枚だけの画像（ダウトの開示、ハイ＆ローの単体表示など）。"""
    w = card_w
    h = int(w * CARD_H / CARD_W)
    img = Image.new("RGB", (w + PAD * 2, h + PAD * 2), BG)
    _paint_card(img, PAD, PAD, w, h, spec)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def render_card_hand(cards, *, title: str | None = None,
                     card_w: int = CARD_W, max_width: int = 1024) -> bytes:
    """カードの並びを描く。cards の各要素は spec（None は裏面）。

    枚数が多いときは左上隅が見える幅で重ね（扇形）、それでも横幅に
    収まらない場合は複数行に折り返す。手札・場のカード列の共用。
    """
    cards = list(cards)
    w = card_w
    h = int(w * CARD_H / CARD_W)
    title_h = 30 if title else 0
    # 1行に入る最大枚数（重ねても隅表示が読める最小ステップ 34px を確保）
    min_step = 34
    per_row = max(1, (max_width - PAD * 2 - w) // min_step + 1)
    rows = [cards[i:i + per_row] for i in range(0, len(cards), per_row)] or [[]]
    width = max_width if len(cards) > 1 else PAD * 2 + w
    height = PAD + title_h + len(rows) * h + (len(rows) - 1) * GAP + PAD
    img = Image.new("RGB", (max(width, 120), max(height, 80)), BG)
    draw = ImageDraw.Draw(img)
    if title:
        draw.text((PAD, PAD), title, fill=FG, font=_font(20))
    y = PAD + title_h
    for row in rows:
        n = len(row)
        if n <= 1:
            step = w + GAP
        else:
            step = min(w + GAP, (max_width - PAD * 2 - w) // (n - 1))
            step = max(min_step, step)
        row_w = w + step * (n - 1)
        x = PAD + max(0, (max_width - PAD * 2 - row_w) // 2) if n > 1 else PAD
        for spec in row:
            _paint_card(img, x, y, w, h, spec)
            x += step
        y += h + GAP
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def render_card_rows(rows, *, title: str | None = None,
                     card_w: int = 96, max_width: int = 1024) -> bytes:
    """(ラベル, カード列) の組を縦に並べる（ポーカーのショーダウン等）。

    rows は [(label, [spec, ...]), ...]。ラベルは各行の上に描く。
    ここに渡すカードは全て公開情報である前提（秘匿は呼び出し側の責務）。
    """
    w = card_w
    h = int(w * CARD_H / CARD_W)
    label_h = 26
    title_h = 32 if title else 0
    min_step = 32
    height = PAD + title_h + len(rows) * (label_h + h) \
        + max(0, len(rows) - 1) * GAP + PAD
    img = Image.new("RGB", (max(max_width, 200), max(height, 100)), BG)
    draw = ImageDraw.Draw(img)
    if title:
        draw.text((PAD, PAD), title, fill=FG, font=_font(21))
    label_font = _font(19)
    y = PAD + title_h
    for label, cards in rows:
        draw.text((PAD, y), str(label), fill=FG, font=label_font)
        y += label_h
        n = len(cards)
        if n <= 1:
            step = w + GAP
        else:
            step = max(min_step, min(w + GAP, (max_width - PAD * 2 - w) // (n - 1)))
        x = PAD
        for spec in cards:
            _paint_card(img, x, y, w, h, spec)
            x += step
        y += h + GAP
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def render_card_pile(count: int, *, label: str | None = None,
                     card_w: int = CARD_W) -> bytes:
    """伏せたカードの山を描く（ダウトの場など、中身は公開しない表示）。

    受けるのは枚数だけ。カードの中身は引数に存在しないので、共有画像に
    秘匿情報が混入する余地が構造的に無い。
    """
    w = card_w
    h = int(w * CARD_H / CARD_W)
    fan = 14
    width = w + fan * 2 + 190 + PAD * 2
    height = h + fan + PAD * 2
    img = Image.new("RGB", (width, max(height, 120)), BG)
    for i in range(3):
        _paint_card(img, PAD + i * fan, PAD + (2 - i) * (fan // 2), w, h, None)
    draw = ImageDraw.Draw(img)
    tx = PAD + w + fan * 2 + 22
    _centered(draw, tx + 80, PAD + h // 2 - 18, f"{count}枚", _font(40), FG)
    if label:
        _centered(draw, tx + 80, PAD + h // 2 + 26, label, _font(19), (170, 178, 195))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def render_yotsuba(words, hints=None, *, title: str | None = None) -> bytes:
    """よつば合わせのヒント盤を描く。

    words は辺の順（上/右/下/左）の4単語（None は未配置で「？」）。
    hints は角の順（右上/右下/左下/左上）の4ヒント（None は空欄）。
    中央の緑の盤の四辺に単語、四隅にヒントチップを置く。
    """
    size = 480
    title_h = 36 if title else 0
    img = Image.new("RGB", (size, size + title_h), BG)
    draw = ImageDraw.Draw(img)
    if title:
        draw.text((PAD, 6), title, fill=FG, font=_font(20))
    oy = title_h
    # 盤本体
    draw.rounded_rectangle([88, oy + 88, 392, oy + 392], radius=28, fill=(46, 125, 50))
    draw.rounded_rectangle([88, oy + 88, 392, oy + 392], radius=28, outline=(129, 199, 132), width=3)
    cx, cy = 240, oy + 240
    draw.ellipse([cx - 30, cy - 30, cx + 30, cy + 30], fill=(27, 94, 32))
    word_font = _font(27)
    positions = [(240, oy + 118), (352, oy + 240), (240, oy + 362), (128, oy + 240)]
    for (x, y), word in zip(positions, words):
        _centered(draw, x, y, str(word) if word else "？", word_font, (255, 255, 255))
    hint_font = _font(20)
    corners = [(398, oy + 42), (398, oy + 438), (82, oy + 438), (82, oy + 42)]
    pair_labels = ["右上", "右下", "左下", "左上"]
    for i, (x, y) in enumerate(corners):
        hint = (hints[i] if hints and i < len(hints) else None)
        text = f"{pair_labels[i]}: {hint}" if hint else f"{pair_labels[i]}: ─"
        bbox = draw.textbbox((0, 0), text, font=hint_font)
        w = bbox[2] - bbox[0] + 20
        draw.rounded_rectangle([x - w / 2, y - 18, x + w / 2, y + 18], radius=10, fill=(255, 193, 7))
        _centered(draw, x, y, text, hint_font, (20, 20, 20))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()
