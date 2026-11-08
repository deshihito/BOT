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
- ``render_hanafuda`` / ``render_hanafuda_hand`` / ``render_hanafuda_rows``:
  花札描画（48枚＋裏面）。月モチーフを幾何図形で手続き描画する。
- ``render_codenames_board`` / ``render_bingo_board`` / ``render_bars`` /
  ``render_mendou_rows`` / ``render_loveletter_cards`` / ``render_hoshi_board``:
  残存ギャップ対応（2026-11-08）で追加した盤面・集計・専用カード描画。
どちらも PNG の bytes を返す純関数で、単体テストで検証できる。
"""
import io
from collections import OrderedDict
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

# このファイルは core/game/ 配下にあるため、リポジトリ直下の font.ttf は parents[2]。
# （core/ 直下にあった時代の parent.parent のままだと core/font.ttf を指して
#  存在せず、全描画が PIL 既定フォントに silently フォールバックしていた。）
FONT_PATH = Path(__file__).resolve().parents[3] / "font.ttf"
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


def suited_card_spec(card: str, joker: str = "JOKER"):
    """内部表記（"S5" / "HK" / ジョーカー）を描画基盤の正規形へ変換する。"""
    if card == joker:
        return CARD_JOKER
    return card_spec(card[1:], card[0])


def card_hand_file(cache_ns: str, specs, filename: str, title: str = "あなたの手札"):
    """手札画像の discord.File を返す共通形（レンダリングキャッシュつき）。"""
    import io

    import discord

    data = render_cached((cache_ns, tuple(specs)),
                         lambda: render_card_hand(list(specs), title=title))
    return discord.File(io.BytesIO(data), filename=filename)


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


# --- 花札（こいこい画像化タスク 2026-11-06） --------------------------------
# 札は core/game/koikoi/koikoi.py の CARDS（id 0..47、month/kind/tag）で引く。
# 構図は全札共通で「上部の月モチーフ帯＋下部の余白」に統一し、モチーフは
# 幾何図形の組み合わせで手続き描画する（トランプのベクタスートと同じ発想で、
# 同梱フォントのグリフには依存しない）。月ごとに色と形を大きく変え、
# Discord の添付表示でも月が識別できることを優先する（様式化された
# アイコン的表現で、写実性は狙わない）。
# 種別の見分け:
#   光    = 赤帯（松・芒・桐）や幕（桜）など大きな赤の要素＋金の内枠で強調
#   種    = 動物・盃などのアイコンを植物モチーフに重ねる
#   短冊  = 左端に短冊帯（赤短=赤、青短=青紫、無地=生成り。tag で切替）
#   カス  = モチーフを上部に小さく淡く描き、大半を余白にする
# 裏面は1種（濃赤地＋金の内枠）。render_hanafuda(None) で描く。
import math as _math

from core.game.koikoi.koikoi import CARDS as _HANAFUDA_CARDS

HANA_W = 88
HANA_H = 140
HANA_FACE = (248, 244, 231)
HANA_EDGE = (96, 74, 52)
HANA_GOLD = (206, 156, 44)
HANA_BAND = (197, 48, 49)
HANA_BACK_BG = (146, 38, 34)
HANA_BACK_EDGE = (70, 22, 20)
HANA_BACK_INNER = (110, 26, 24)
HANA_TAN_COLORS = {"redtan": (203, 44, 44), "bluetan": (72, 82, 178)}
HANA_TAN_PLAIN = (238, 228, 196)


def _hana_fade(color, f):
    """色を地色（生成り）に寄せる。カス札の淡色化に使う。"""
    return tuple(int(a + (b - a) * f) for a, b in zip(color, HANA_FACE))


def _hana_lens(draw, cx, cy, length, width, ang_deg, fill):
    """両端の尖った楕円（葉・花弁・翼の形）を角度つきで描く。"""
    a = _math.radians(ang_deg)
    ca, sa = _math.cos(a), _math.sin(a)
    pts = []
    n = 10
    for i in range(n + 1):
        t = i / n
        off = _math.sin(_math.pi * t) * width / 2
        pts.append((cx + (t - 0.5) * length * ca - off * sa,
                    cy + (t - 0.5) * length * sa + off * ca))
    for i in range(n, -1, -1):
        t = i / n
        off = _math.sin(_math.pi * t) * width / 2
        pts.append((cx + (t - 0.5) * length * ca + off * sa,
                    cy + (t - 0.5) * length * sa - off * ca))
    draw.polygon(pts, fill=fill)


def _hana_blossom(draw, cx, cy, r, petal, center=(252, 220, 110)):
    """5弁の花（梅・桜用）。"""
    for k in range(5):
        ang = -_math.pi / 2 + k * 2 * _math.pi / 5
        px, py = cx + r * 0.60 * _math.cos(ang), cy + r * 0.60 * _math.sin(ang)
        draw.ellipse([px - r * 0.52, py - r * 0.52, px + r * 0.52, py + r * 0.52],
                     fill=petal)
    draw.ellipse([cx - r * 0.22, cy - r * 0.22, cx + r * 0.22, cy + r * 0.22],
                 fill=center)


def _hana_bird(draw, cx, cy, s, body):
    """横向きの簡略な小鳥（鶯・郭公・燕の土台）。s は体長。"""
    draw.polygon([(cx - s * 0.30, cy - s * 0.02), (cx - s * 0.66, cy - s * 0.30),
                  (cx - s * 0.60, cy + s * 0.12)], fill=body)
    draw.ellipse([cx - s * 0.40, cy - s * 0.24, cx + s * 0.28, cy + s * 0.26],
                 fill=body)
    draw.ellipse([cx + s * 0.14, cy - s * 0.44, cx + s * 0.46, cy - s * 0.12],
                 fill=body)
    draw.polygon([(cx + s * 0.46, cy - s * 0.32), (cx + s * 0.64, cy - s * 0.25),
                  (cx + s * 0.46, cy - s * 0.18)], fill=(243, 183, 66))
    draw.ellipse([cx + s * 0.27, cy - s * 0.34, cx + s * 0.34, cy - s * 0.27],
                 fill=(24, 24, 24))
    lw = max(1, int(s * 0.05))
    draw.line([(cx - s * 0.06, cy + s * 0.26), (cx - s * 0.06, cy + s * 0.42)],
              fill=body, width=lw)
    draw.line([(cx + s * 0.12, cy + s * 0.26), (cx + s * 0.12, cy + s * 0.42)],
              fill=body, width=lw)


# --- 月モチーフ -------------------------------------------------------------
# 各関数は (draw, card, x, y, w, h, fade) を受け、(x, y, w, h) の帯に描く。
# tane の場合は植物に加えてアイコン（鳥・蝶・猪・盃・鹿・燕・橋・雁）も描く。

def _motif_pine(d, c, x, y, w, h, f):
    trunk = _hana_fade((122, 84, 50), f)
    d.line([(x + w * 0.26, y + h * 1.02), (x + w * 0.42, y + h * 0.42)],
           fill=trunk, width=max(2, int(w * 0.08)))
    d.line([(x + w * 0.42, y + h * 0.42), (x + w * 0.78, y + h * 0.24)],
           fill=trunk, width=max(2, int(w * 0.05)))
    greens = [(34, 92, 42), (54, 128, 58), (92, 164, 88)]
    clusters = [(0.24, 0.34, 0.30), (0.52, 0.16, 0.36), (0.78, 0.32, 0.28),
                (0.40, 0.50, 0.27)]
    for i, (rx, ry, rr) in enumerate(clusters):
        cx, cy, r = x + w * rx, y + h * ry, w * rr
        col = _hana_fade(greens[i % 3], f)
        d.ellipse([cx - r * 0.66, cy - r * 0.42, cx + r * 0.66, cy + r * 0.42],
                  fill=col)
        dark = _hana_fade(greens[(i + 1) % 3], f)
        for k in range(11):
            ang = _math.radians(125 + 23 * k)
            d.line([(cx, cy), (cx + r * 1.30 * _math.cos(ang),
                               cy - r * 0.72 * _math.sin(ang))],
                   fill=dark, width=max(1, int(w * 0.026)))
    if c["kind"] == "hikari":  # 鶴: 白い体＋長い首＋赤い冠＋黒い尾
        bx, by, s = x + w * 0.62, y + h * 0.82, w * 0.62
        white = _hana_fade((252, 252, 250), f)
        d.line([(bx - s * 0.10, by + s * 0.16), (bx - s * 0.10, by + s * 0.46)],
               fill=(70, 70, 70), width=max(1, int(w * 0.02)))
        d.line([(bx + s * 0.10, by + s * 0.16), (bx + s * 0.10, by + s * 0.46)],
               fill=(70, 70, 70), width=max(1, int(w * 0.02)))
        d.ellipse([bx - s * 0.34, by - s * 0.10, bx + s * 0.30, by + s * 0.20],
                  fill=white)
        for k in range(3):
            d.line([(bx - s * 0.30, by), (bx - s * (0.52 + 0.05 * k),
                                          by - s * (0.10 + 0.10 * k))],
                   fill=(40, 40, 44), width=max(1, int(w * 0.03)))
        d.line([(bx + s * 0.26, by - s * 0.04), (bx + s * 0.40, by - s * 0.38)],
               fill=white, width=max(2, int(w * 0.07)))
        d.ellipse([bx + s * 0.32, by - s * 0.52, bx + s * 0.50, by - s * 0.34],
                  fill=white)
        d.ellipse([bx + s * 0.36, by - s * 0.52, bx + s * 0.46, by - s * 0.43],
                  fill=_hana_fade((214, 40, 44), f))
        d.polygon([(bx + s * 0.50, by - s * 0.42), (bx + s * 0.64, by - s * 0.38),
                   (bx + s * 0.50, by - s * 0.34)], fill=(243, 183, 66))


def _motif_plum(d, c, x, y, w, h, f):
    branch = _hana_fade((74, 52, 44), f)
    d.line([(x + w * 0.06, y + h * 0.92), (x + w * 0.40, y + h * 0.55),
            (x + w * 0.52, y + h * 0.30), (x + w * 0.86, y + h * 0.16)],
           fill=branch, width=max(2, int(w * 0.06)))
    d.line([(x + w * 0.40, y + h * 0.55), (x + w * 0.72, y + h * 0.52)],
           fill=branch, width=max(2, int(w * 0.04)))
    petal = _hana_fade((233, 116, 148), f)
    for rx, ry, rr in [(0.34, 0.42, 0.17), (0.62, 0.24, 0.20), (0.84, 0.44, 0.15),
                       (0.22, 0.70, 0.14), (0.70, 0.66, 0.13)]:
        _hana_blossom(d, x + w * rx, y + h * ry, w * rr,
                      _hana_fade(petal, f * 0.5))
    if c["kind"] == "tane":  # 鶯
        _hana_bird(d, x + w * 0.52, y + h * 0.86, w * 0.42,
                   _hana_fade((122, 140, 62), f))


def _motif_cherry(d, c, x, y, w, h, f):
    petal = _hana_fade((247, 183, 197), f)
    deep = _hana_fade((240, 140, 168), f)
    if c["kind"] == "hikari":  # 幕: 赤い横帯＋房
        band_h = h * 0.40
        d.rectangle([x, y, x + w, y + band_h], fill=_hana_fade(HANA_BAND, f))
        for k in range(1, 5):
            d.line([(x + w * k / 5, y), (x + w * k / 5, y + band_h)],
                   fill=_hana_fade((150, 30, 32), f), width=max(1, int(w * 0.02)))
        for k in range(6):
            fx = x + w * (k + 0.5) / 6
            d.polygon([(fx - w * 0.045, y + band_h), (fx + w * 0.045, y + band_h),
                       (fx, y + band_h + h * 0.09)], fill=_hana_fade(HANA_GOLD, f))
        for rx, ry, rr in [(0.26, 0.68, 0.15), (0.58, 0.80, 0.18),
                           (0.82, 0.62, 0.13)]:
            _hana_blossom(d, x + w * rx, y + h * ry, w * rr, petal)
        return
    for rx, ry, rr in [(0.28, 0.24, 0.17), (0.62, 0.16, 0.20), (0.84, 0.38, 0.15),
                       (0.20, 0.52, 0.14), (0.50, 0.46, 0.16), (0.76, 0.66, 0.14),
                       (0.36, 0.78, 0.13)]:
        _hana_blossom(d, x + w * rx, y + h * ry, w * rr,
                      petal if (rx + ry) % 0.3 < 0.15 else deep)
    for rx, ry in [(0.44, 0.30), (0.68, 0.52), (0.16, 0.36), (0.90, 0.80)]:
        d.ellipse([x + w * rx - w * 0.035, y + h * ry - w * 0.035,
                   x + w * rx + w * 0.035, y + h * ry + w * 0.035], fill=deep)


def _motif_wisteria(d, c, x, y, w, h, f):
    d.line([(x + w * 0.04, y + h * 0.06), (x + w * 0.96, y + h * 0.02)],
           fill=_hana_fade((96, 72, 50), f), width=max(2, int(w * 0.05)))
    shades = [(126, 96, 196), (150, 122, 214), (172, 150, 226)]
    for ci, (rx, ln) in enumerate([(0.24, 0.52), (0.50, 0.72), (0.76, 0.58)]):
        cx = x + w * rx
        rows = int(ln / 0.09)
        for k in range(rows):
            r = w * (0.085 - 0.028 * k / max(1, rows - 1))
            cy = y + h * (0.10 + 0.085 * k)
            col = _hana_fade(shades[(k + ci) % 3], f)
            d.ellipse([cx - r, cy - r * 0.8, cx + r, cy + r * 0.8], fill=col)
    leaf = _hana_fade((86, 148, 84), f)
    for rx, ry, ang in [(0.10, 0.16, -30), (0.90, 0.12, 30), (0.64, 0.08, 10)]:
        _hana_lens(d, x + w * rx, y + h * ry, w * 0.20, w * 0.08, ang, leaf)
    if c["kind"] == "tane":  # 郭公: 濃い小鳥
        _hana_bird(d, x + w * 0.56, y + h * 0.92, w * 0.40,
                   _hana_fade((92, 84, 76), f))


def _motif_iris(d, c, x, y, w, h, f):
    green = _hana_fade((52, 122, 66), f)
    for rx, ln, ang in [(0.22, 0.88, -8), (0.38, 0.98, -3), (0.55, 0.92, 2),
                        (0.70, 1.0, 5), (0.84, 0.86, 10)]:
        _hana_lens(d, x + w * rx, y + h * (1.0 - ln / 2), h * ln, w * 0.075,
                   -90 + ang, green)
    purple = _hana_fade((116, 78, 186), f)
    light = _hana_fade((168, 140, 226), f)
    for rx, ry in [(0.38, 0.14), (0.70, 0.10)]:
        cx, cy = x + w * rx, y + h * ry
        for ang in (-38, 0, 38):
            _hana_lens(d, cx, cy, w * 0.20, w * 0.10, 90 + ang, purple)
        _hana_lens(d, cx - w * 0.07, cy + w * 0.06, w * 0.13, w * 0.07, 150, light)
        _hana_lens(d, cx + w * 0.07, cy + w * 0.06, w * 0.13, w * 0.07, 30, light)
        d.ellipse([cx - w * 0.03, cy - w * 0.03, cx + w * 0.03, cy + w * 0.03],
                  fill=_hana_fade((250, 208, 84), f))
    if c["kind"] == "tane":  # 八橋: ジグザグの板橋
        plank = _hana_fade((150, 104, 58), f)
        edge = _hana_fade((104, 70, 36), f)
        for k in range(4):
            px = x + w * (0.10 + 0.20 * k)
            py = y + h * (0.60 + (0.10 if k % 2 else 0.0))
            d.rectangle([px, py, px + w * 0.24, py + h * 0.055], fill=plank,
                        outline=edge, width=max(1, int(w * 0.015)))
            d.line([(px + w * 0.04, py + h * 0.055), (px + w * 0.04, py + h * 0.13)],
                   fill=edge, width=max(1, int(w * 0.025)))
            d.line([(px + w * 0.20, py + h * 0.055), (px + w * 0.20, py + h * 0.13)],
                   fill=edge, width=max(1, int(w * 0.025)))


def _motif_peony(d, c, x, y, w, h, f):
    leaf = _hana_fade((62, 138, 74), f)
    for rx, ry, ang in [(0.24, 0.82, -24), (0.52, 0.90, 0), (0.78, 0.82, 24)]:
        _hana_lens(d, x + w * rx, y + h * ry, w * 0.34, w * 0.17, ang, leaf)
    cx, cy = x + w * 0.50, y + h * 0.40
    outer = _hana_fade((226, 92, 120), f)
    inner = _hana_fade((240, 140, 160), f)
    for k in range(8):
        ang = k * 45
        _hana_lens(d, cx + w * 0.13 * _math.cos(_math.radians(ang)),
                   cy + w * 0.13 * _math.sin(_math.radians(ang)),
                   w * 0.26, w * 0.20, ang, outer)
    for k in range(6):
        ang = 30 + k * 60
        _hana_lens(d, cx + w * 0.06 * _math.cos(_math.radians(ang)),
                   cy + w * 0.06 * _math.sin(_math.radians(ang)),
                   w * 0.15, w * 0.12, ang, inner)
    d.ellipse([cx - w * 0.055, cy - w * 0.055, cx + w * 0.055, cy + w * 0.055],
              fill=_hana_fade((250, 208, 84), f))
    if c["kind"] == "tane":  # 蝶
        bx, by = x + w * 0.74, y + h * 0.15
        wing = _hana_fade((240, 148, 52), f)
        edge = _hana_fade((60, 52, 48), f)
        for dx, ang in [(-1, -32), (1, 32)]:
            _hana_lens(d, bx + dx * w * 0.105, by, w * 0.21, w * 0.13, ang, wing)
            _hana_lens(d, bx + dx * w * 0.085, by + w * 0.09, w * 0.15, w * 0.10,
                       -ang, wing)
        d.line([(bx, by - w * 0.05), (bx, by + w * 0.10)], fill=edge,
               width=max(1, int(w * 0.025)))


def _motif_hagi(d, c, x, y, w, h, f):
    stem = _hana_fade((86, 128, 70), f)
    for rx in (0.26, 0.50, 0.74):
        d.line([(x + w * rx, y + h * 0.98), (x + w * (rx - 0.05), y + h * 0.30)],
               fill=stem, width=max(1, int(w * 0.025)))
        for k in range(4):
            lx = x + w * (rx - 0.05) + (k % 2) * w * 0.07 - w * 0.035
            ly = y + h * (0.42 + 0.13 * k)
            _hana_lens(d, lx, ly, w * 0.13, w * 0.055, -18 if k % 2 else 18, stem)
    bloom = _hana_fade((206, 92, 158), f)
    bud = _hana_fade((232, 150, 196), f)
    for rx, ry in [(0.21, 0.22), (0.45, 0.16), (0.69, 0.24), (0.30, 0.34),
                   (0.58, 0.30)]:
        for dx, dy, rr in [(0, 0, 0.052), (-0.05, 0.05, 0.042), (0.05, 0.05, 0.042)]:
            d.ellipse([x + w * (rx + dx) - w * rr, y + h * (ry + dy) - w * rr,
                       x + w * (rx + dx) + w * rr, y + h * (ry + dy) + w * rr],
                      fill=bloom if rr > 0.045 else bud)
    if c["kind"] == "tane":  # 猪: 茶色のシルエット＋牙
        bx, by = x + w * 0.50, y + h * 0.76
        body = _hana_fade((104, 74, 48), f)
        d.ellipse([bx - w * 0.26, by - w * 0.13, bx + w * 0.20, by + w * 0.15],
                  fill=body)
        d.ellipse([bx + w * 0.12, by - w * 0.07, bx + w * 0.34, by + w * 0.13],
                  fill=body)
        d.polygon([(bx + w * 0.16, by - w * 0.07), (bx + w * 0.22, by - w * 0.17),
                   (bx + w * 0.26, by - w * 0.05)], fill=body)
        d.polygon([(bx + w * 0.30, by + w * 0.05), (bx + w * 0.40, by + w * 0.09),
                   (bx + w * 0.30, by + w * 0.11)], fill=body)
        d.arc([bx + w * 0.24, by + w * 0.02, bx + w * 0.38, by + w * 0.16],
              start=200, end=320, fill=_hana_fade((250, 246, 230), f),
              width=max(1, int(w * 0.03)))
        for lx in (-0.18, -0.02, 0.10):
            d.line([(bx + w * lx, by + w * 0.13), (bx + w * lx, by + w * 0.26)],
                   fill=body, width=max(2, int(w * 0.035)))
        d.ellipse([bx + w * 0.24, by - w * 0.01, bx + w * 0.28, by + w * 0.03],
                  fill=_hana_fade((30, 26, 24), f))


def _motif_susuki(d, c, x, y, w, h, f):
    if c["kind"] == "hikari":  # 満月
        cx, cy, r = x + w * 0.68, y + h * 0.24, w * 0.27
        d.ellipse([cx - r * 1.18, cy - r * 1.18, cx + r * 1.18, cy + r * 1.18],
                  outline=_hana_fade((250, 226, 150), f), width=max(1, int(w * 0.02)))
        d.ellipse([cx - r, cy - r, cx + r, cy + r],
                  fill=_hana_fade((248, 208, 92), f))
    stem = _hana_fade((150, 138, 92), f)
    plume = _hana_fade((206, 182, 128), f)
    light = _hana_fade((232, 214, 168), f)
    for i, (rx, lean) in enumerate([(0.24, -0.10), (0.42, -0.03), (0.58, 0.04),
                                    (0.76, 0.12)]):
        bx = x + w * rx
        tx = bx + w * lean
        midx = (bx + tx) / 2
        pts = [(bx, y + h * 1.0), (midx, y + h * 0.62), (tx, y + h * 0.30)]
        d.line(pts, fill=stem, width=max(1, int(w * 0.025)))
        for k in range(5):
            t = k / 5
            px = midx + (tx - midx) * t
            py = y + h * (0.62 - 0.30 * t)
            d.line([(px, py), (px + w * 0.05, py - h * 0.10)],
                   fill=plume if k % 2 else light, width=max(1, int(w * 0.03)))
    blade = _hana_fade((140, 150, 88), f)
    for rx in (0.10, 0.30, 0.52, 0.72, 0.90):
        _hana_lens(d, x + w * rx, y + h * 0.95, h * 0.16, w * 0.05,
                   -70 + rx * 40, blade)
    if c["kind"] == "tane":  # 雁: 空をいく小さな雁影
        ink = _hana_fade((70, 70, 78), f)
        for rx, ry, s in [(0.24, 0.16, 0.10), (0.40, 0.24, 0.13), (0.58, 0.33, 0.10)]:
            cx, cy = x + w * rx, y + h * ry
            d.line([(cx - w * s, cy), (cx, cy - w * s * 0.45)], fill=ink,
                   width=max(1, int(w * 0.025)))
            d.line([(cx, cy - w * s * 0.45), (cx + w * s, cy)], fill=ink,
                   width=max(1, int(w * 0.025)))


def _motif_chrysanth(d, c, x, y, w, h, f):
    leaf = _hana_fade((70, 138, 78), f)
    for rx, ry, ang in [(0.26, 0.86, -20), (0.52, 0.92, 0), (0.76, 0.86, 20)]:
        _hana_lens(d, x + w * rx, y + h * ry, w * 0.30, w * 0.15, ang, leaf)

    def flower(cx, cy, r):
        gold = _hana_fade((236, 182, 52), f)
        pink = _hana_fade((236, 156, 168), f)
        for k in range(16):
            ang = k * 22.5
            _hana_lens(d, cx + r * 0.52 * _math.cos(_math.radians(ang)),
                       cy + r * 0.52 * _math.sin(_math.radians(ang)),
                       r * 1.05, r * 0.30, ang, gold if k % 2 else pink)
        d.ellipse([cx - r * 0.20, cy - r * 0.20, cx + r * 0.20, cy + r * 0.20],
                  fill=_hana_fade((240, 140, 52), f))

    flower(x + w * 0.50, y + h * 0.34, w * 0.30)
    flower(x + w * 0.22, y + h * 0.62, w * 0.17)
    if c["kind"] == "tane":  # 盃: 金縁の盃＋台
        cx, cy = x + w * 0.68, y + h * 0.68
        gold = _hana_fade(HANA_GOLD, f)
        d.polygon([(cx - w * 0.07, cy + w * 0.15), (cx + w * 0.07, cy + w * 0.15),
                   (cx + w * 0.03, cy + w * 0.08), (cx - w * 0.03, cy + w * 0.08)],
                  fill=_hana_fade((90, 70, 40), f))
        d.polygon([(cx - w * 0.17, cy - w * 0.10), (cx + w * 0.17, cy - w * 0.10),
                   (cx + w * 0.08, cy + w * 0.09), (cx - w * 0.08, cy + w * 0.09)],
                  fill=_hana_fade((250, 248, 240), f), outline=gold)
        d.line([(cx - w * 0.17, cy - w * 0.10), (cx + w * 0.17, cy - w * 0.10)],
               fill=gold, width=max(2, int(w * 0.03)))
        d.ellipse([cx - w * 0.045, cy - w * 0.01, cx + w * 0.045, cy + w * 0.08],
                  fill=_hana_fade((208, 60, 54), f))


def _motif_maple(d, c, x, y, w, h, f):
    def leaf(cx, cy, r, color):
        pts = []
        for i in range(14):
            ang = -_math.pi / 2 + i * _math.pi / 7
            rad = r if i % 2 == 0 else r * 0.52
            pts.append((cx + rad * _math.cos(ang), cy + rad * _math.sin(ang)))
        d.polygon(pts, fill=_hana_fade(color, f))
        d.line([(cx, cy + r * 0.4), (cx - r * 0.12, cy + r * 1.05)],
               fill=_hana_fade((120, 70, 40), f), width=max(1, int(w * 0.02)))

    leaf(x + w * 0.34, y + h * 0.26, w * 0.21, (208, 64, 40))
    leaf(x + w * 0.70, y + h * 0.16, w * 0.16, (232, 120, 44))
    leaf(x + w * 0.60, y + h * 0.46, w * 0.18, (196, 52, 44))
    leaf(x + w * 0.20, y + h * 0.52, w * 0.13, (226, 96, 38))
    if c["kind"] == "tane":  # 鹿: 茶色のシルエット＋角
        bx, by = x + w * 0.48, y + h * 0.78
        body = _hana_fade((150, 100, 58), f)
        d.ellipse([bx - w * 0.25, by - w * 0.12, bx + w * 0.18, by + w * 0.13],
                  fill=body)
        d.line([(bx - w * 0.18, by - w * 0.06), (bx - w * 0.30, by - w * 0.30)],
               fill=body, width=max(2, int(w * 0.07)))
        d.ellipse([bx - w * 0.40, by - w * 0.40, bx - w * 0.24, by - w * 0.24],
                  fill=body)
        antler = _hana_fade((110, 76, 44), f)
        for sgn in (-1, 1):
            ax = bx - w * 0.34 + sgn * w * 0.03
            d.line([(ax, by - w * 0.38), (ax + sgn * w * 0.02, by - w * 0.58)],
                   fill=antler, width=max(1, int(w * 0.022)))
            d.line([(ax, by - w * 0.48), (ax + sgn * w * 0.09, by - w * 0.56)],
                   fill=antler, width=max(1, int(w * 0.022)))
        for lx in (-0.16, -0.04, 0.08):
            d.line([(bx + w * lx, by + w * 0.11), (bx + w * lx, by + w * 0.27)],
                   fill=body, width=max(2, int(w * 0.032)))
        d.polygon([(bx + w * 0.18, by - w * 0.10), (bx + w * 0.27, by - w * 0.02),
                   (bx + w * 0.17, by + w * 0.02)], fill=body)
        d.ellipse([bx - w * 0.35, by - w * 0.35, bx - w * 0.31, by - w * 0.31],
                  fill=_hana_fade((30, 26, 24), f))


def _motif_rain(d, c, x, y, w, h, f):
    rain = _hana_fade((122, 146, 168), f)
    for k in range(9):
        rx = 0.06 + 0.11 * k
        d.line([(x + w * rx, y + h * 0.02), (x + w * (rx - 0.07), y + h * 0.34)],
               fill=rain, width=max(1, int(w * 0.018)))
    green = _hana_fade((88, 146, 82), f)
    deep = _hana_fade((58, 118, 60), f)
    for i, rx in enumerate((0.30, 0.48, 0.66, 0.84)):
        top = y + h * 0.04
        bot = y + h * (0.78 - 0.10 * (i % 2))
        pts = []
        for k in range(9):
            t = k / 8
            pts.append((x + w * rx + w * 0.03 * _math.sin(t * 5 + i),
                        top + (bot - top) * t))
        d.line(pts, fill=green if i % 2 else deep, width=max(2, int(w * 0.035)))
    if c["kind"] == "hikari":  # 小野道風: 人型の簡略シルエット＋赤い帯
        cx, cy = x + w * 0.32, y + h * 0.52
        d.polygon([(cx - w * 0.055, cy - w * 0.46), (cx + w * 0.055, cy - w * 0.46),
                   (cx + w * 0.085, cy - w * 0.13), (cx - w * 0.085, cy - w * 0.13)],
                  fill=_hana_fade((38, 36, 40), f))
        d.ellipse([cx - w * 0.095, cy - w * 0.15, cx + w * 0.095, cy + w * 0.04],
                  fill=_hana_fade((242, 206, 168), f))
        d.polygon([(cx - w * 0.20, cy + w * 0.03), (cx + w * 0.20, cy + w * 0.03),
                   (cx + w * 0.27, cy + w * 0.46), (cx - w * 0.27, cy + w * 0.46)],
                  fill=_hana_fade((52, 84, 110), f))
        d.rectangle([cx - w * 0.225, cy + w * 0.13, cx + w * 0.225, cy + w * 0.22],
                    fill=_hana_fade(HANA_BAND, f))
    if c["kind"] == "tane":  # 燕: 黒い鳥＋燕尾
        bx, by = x + w * 0.42, y + h * 0.52
        ink = _hana_fade((34, 34, 42), f)
        _hana_lens(d, bx, by, w * 0.30, w * 0.09, -18, ink)
        _hana_lens(d, bx - w * 0.10, by - w * 0.07, w * 0.24, w * 0.07, -52, ink)
        _hana_lens(d, bx + w * 0.02, by + w * 0.08, w * 0.22, w * 0.06, 48, ink)
        d.polygon([(bx + w * 0.14, by + w * 0.02), (bx + w * 0.28, by - w * 0.05),
                   (bx + w * 0.24, by + w * 0.05)], fill=ink)
        d.polygon([(bx + w * 0.14, by + w * 0.02), (bx + w * 0.27, by + w * 0.12),
                   (bx + w * 0.17, by + w * 0.10)], fill=ink)


def _motif_paulownia(d, c, x, y, w, h, f):
    leaf = _hana_fade((74, 132, 74), f)
    deep = _hana_fade((52, 108, 58), f)
    for rx, ry in [(0.30, 0.22), (0.66, 0.16), (0.48, 0.36)]:
        cx, cy = x + w * rx, y + h * ry
        for dx, dy in [(-0.10, 0.03), (0.10, 0.03), (0, -0.06)]:
            d.ellipse([cx + w * dx - w * 0.115, cy + w * dy - w * 0.115,
                       cx + w * dx + w * 0.115, cy + w * dy + w * 0.115],
                      fill=leaf if dy < 0 else deep)
    bud = _hana_fade((146, 112, 192), f)
    for rx, ry in [(0.22, 0.55), (0.78, 0.48), (0.60, 0.62)]:
        for k in range(3):
            d.ellipse([x + w * rx - w * 0.045 + k * w * 0.045,
                       y + h * ry + k * w * 0.05,
                       x + w * rx + w * 0.045 + k * w * 0.045,
                       y + h * ry + w * 0.11 + k * w * 0.05], fill=bud)
    if c["kind"] == "hikari":  # 鳳凰: 体＋冠＋長い尾羽（曲線3本）
        bx, by = x + w * 0.52, y + h * 0.56
        gold = _hana_fade((226, 164, 52), f)
        _hana_lens(d, bx, by, w * 0.46, w * 0.24, -24, gold)  # 体
        _hana_lens(d, bx - w * 0.02, by - w * 0.02, w * 0.30, w * 0.13, -52,
                   _hana_fade((38, 150, 136), f))  # 翼
        d.ellipse([bx + w * 0.15, by - w * 0.26, bx + w * 0.31, by - w * 0.10],
                  fill=gold)  # 頭
        for k in range(3):
            d.line([(bx + w * 0.22, by - w * 0.24),
                    (bx + w * (0.24 + 0.05 * k), by - w * (0.38 + 0.04 * k))],
                   fill=_hana_fade((208, 84, 60), f), width=max(1, int(w * 0.024)))
        d.polygon([(bx + w * 0.31, by - w * 0.20), (bx + w * 0.42, by - w * 0.15),
                   (bx + w * 0.30, by - w * 0.12)], fill=(243, 183, 66))
        d.ellipse([bx + w * 0.23, by - w * 0.21, bx + w * 0.27, by - w * 0.17],
                  fill=_hana_fade((30, 26, 24), f))
        tail = [_hana_fade((38, 150, 136), f), _hana_fade((208, 84, 60), f),
                _hana_fade((226, 164, 52), f)]
        for k, col in enumerate(tail):
            pts = []
            for s in range(10):
                t = s / 9
                pts.append((bx - w * 0.14 - w * 0.30 * t,
                            by + w * 0.04 + h * (0.16 + 0.10 * k) * t
                            + w * 0.12 * _math.sin(t * 2.4 + k * 0.9)))
            d.line(pts, fill=col, width=max(2, int(w * 0.042)))
            ex, ey = pts[-1]
            d.ellipse([ex - w * 0.042, ey - w * 0.042, ex + w * 0.042,
                       ey + w * 0.042], fill=col)


_HANA_MOTIFS = {1: _motif_pine, 2: _motif_plum, 3: _motif_cherry,
                4: _motif_wisteria, 5: _motif_iris, 6: _motif_peony,
                7: _motif_hagi, 8: _motif_susuki, 9: _motif_chrysanth,
                10: _motif_maple, 11: _motif_rain, 12: _motif_paulownia}


def _paint_hanafuda(canvas, x, y, w, h, card_id):
    """canvas の (x, y) に w×h の花札を1枚描く。card_id=None は裏面。"""
    draw = ImageDraw.Draw(canvas)
    radius = max(4, int(w * 0.06))
    if card_id is None:
        draw.rounded_rectangle([x, y, x + w, y + h], radius=radius,
                               fill=HANA_BACK_BG)
        m = max(3, int(w * 0.09))
        draw.rounded_rectangle([x + m, y + m, x + w - m, y + h - m],
                               radius=max(2, radius - 2), outline=HANA_GOLD,
                               width=max(1, w // 40))
        draw.rounded_rectangle([x, y, x + w, y + h], radius=radius,
                               outline=HANA_BACK_EDGE, width=2)
        return
    card = _HANAFUDA_CARDS[card_id]
    kind = card["kind"]
    draw.rounded_rectangle([x, y, x + w, y + h], radius=radius, fill=HANA_FACE)
    band_h = 0.0
    if kind == "hikari":
        draw.rounded_rectangle([x + 4, y + 4, x + w - 4, y + h - 4],
                               radius=radius, outline=HANA_GOLD,
                               width=max(1, w // 36))
        if card["month"] in (1, 8, 12):  # 赤帯＋金線で光を強調
            band_h = h * 0.085
            draw.rectangle([x + 2, y + 2, x + w - 2, y + band_h], fill=HANA_BAND)
            draw.line([(x + 2, y + band_h), (x + w - 2, y + band_h)],
                      fill=HANA_GOLD, width=max(1, w // 36))
    if kind == "tanzaku":  # 左端の短冊帯
        color = HANA_TAN_COLORS.get(card["tag"], HANA_TAN_PLAIN)
        sx0, sx1 = x + w * 0.055, x + w * 0.195
        sy0, sy1 = y + h * 0.05, y + h * 0.60
        draw.rectangle([sx0, sy0, sx1, sy1], fill=color,
                       outline=(120, 100, 70), width=max(1, w // 44))
        tick = (90, 70, 50) if card["tag"] is None else (250, 240, 220)
        for k in range(3):
            ty = sy0 + (sy1 - sy0) * (0.22 + 0.18 * k)
            draw.line([(sx0 + w * 0.03, ty), (sx1 - w * 0.03, ty)],
                      fill=tick, width=max(1, w // 44))
    # モチーフ帯: カスは上部に小さく淡く、それ以外は全面寄りに大きく
    if kind == "kasu":
        mx, my, mw, mh, fade = x + w * 0.17, y + h * 0.08, w * 0.66, h * 0.34, 0.52
    elif kind == "tanzaku":
        mx, my, mw, mh, fade = x + w * 0.25, y + h * 0.05, w * 0.69, h * 0.88, 0.0
    elif kind == "hikari":
        mx, my, mw, mh, fade = (x + w * 0.05, y + band_h + h * 0.03,
                                w * 0.90, h * 0.90 - band_h, 0.0)
    else:
        mx, my, mw, mh, fade = x + w * 0.06, y + h * 0.05, w * 0.88, h * 0.88, 0.0
    draw = ImageDraw.Draw(canvas)
    _HANA_MOTIFS[card["month"]](draw, card, mx, my, mw, mh, fade)
    draw = ImageDraw.Draw(canvas)
    draw.rounded_rectangle([x, y, x + w, y + h], radius=radius,
                           outline=HANA_EDGE, width=2)


def hanafuda_size(card_w: int) -> tuple[int, int]:
    """花札1枚の (幅, 高さ)。花札比の細長（88×140 が基準）。"""
    return card_w, int(card_w * HANA_H / HANA_W)


def render_hanafuda(card_id, *, card_w: int = HANA_W) -> bytes:
    """花札1枚の画像。card_id は 0..47、None は裏面。"""
    if card_id is not None and card_id not in _HANAFUDA_CARDS:
        raise ValueError(f"不正な花札 id: {card_id!r}")
    w, h = hanafuda_size(card_w)
    img = Image.new("RGB", (w + PAD * 2, h + PAD * 2), BG)
    _paint_hanafuda(img, PAD, PAD, w, h, card_id)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def render_hanafuda_hand(cards, *, title: str | None = None,
                         card_w: int = HANA_W, max_width: int = 1024,
                         highlight=frozenset()) -> bytes:
    """花札の並びを描く（手札・場札用）。cards は id の列（None は裏面）。

    highlight は位置インデックスの集合で、該当札に金の枠を付ける
    （手札ビューで「場と合う札」を示す用途）。枚数が多いときは重ねて描き、
    それでも収まらなければ複数行に折り返す。
    """
    cards = list(cards)
    w, h = hanafuda_size(card_w)
    title_h = 30 if title else 0
    min_step = max(20, int(w * 0.52))
    per_row = max(1, (max_width - PAD * 2 - w) // min_step + 1)
    rows = [cards[i:i + per_row] for i in range(0, len(cards), per_row)] or [[]]
    width = max_width if len(cards) > 1 else PAD * 2 + w
    height = PAD + title_h + len(rows) * h + (len(rows) - 1) * GAP + PAD
    img = Image.new("RGB", (max(width, 120), max(height, 80)), BG)
    draw = ImageDraw.Draw(img)
    if title:
        draw.text((PAD, PAD), title, fill=FG, font=_font(20))
    y = PAD + title_h
    base = 0
    for row in rows:
        n = len(row)
        if n <= 1:
            step = w + GAP
        else:
            step = max(min_step, min(w + GAP, (max_width - PAD * 2 - w) // (n - 1)))
        row_w = w + step * (n - 1) if n else 0
        x = PAD + max(0, (max_width - PAD * 2 - row_w) // 2) if n > 1 else PAD
        for j, cid in enumerate(row):
            _paint_hanafuda(img, x, y, w, h, cid)
            if base + j in highlight:
                draw = ImageDraw.Draw(img)
                draw.rounded_rectangle([x + 1, y + 1, x + w - 1, y + h - 1],
                                       radius=max(4, int(w * 0.06)),
                                       outline=(250, 204, 21), width=3)
            x += step
        base += n
        y += h + GAP
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def render_hanafuda_rows(rows, *, title: str | None = None,
                         card_w: int = 60, max_width: int = 1024) -> bytes:
    """(ラベル, 札の列) の組を縦に並べる（こいこいの場＋取り札表示用）。

    rows は [(label, [id, ...]), ...]。札は重ねずに並べ、横幅に収まらない
    行は折り返す。ここに渡す札は全て公開情報である前提（秘匿は呼び出し側
    の責務で、cog 側は場札と取り札だけを渡す）。
    """
    w, h = hanafuda_size(card_w)
    label_h = 26
    title_h = 32 if title else 0
    per_row = max(1, (max_width - PAD * 2 + GAP) // (w + GAP))
    chunks = []
    height = PAD + title_h + PAD
    for label, cards in rows:
        cards = list(cards)
        n_chunks = max(1, -(-len(cards) // per_row))
        chunks.append((label, cards, n_chunks))
        height += label_h + n_chunks * h + (n_chunks - 1) * GAP + GAP
    height -= GAP
    img = Image.new("RGB", (max(max_width, 200), max(height, 100)), BG)
    draw = ImageDraw.Draw(img)
    if title:
        draw.text((PAD, PAD), title, fill=FG, font=_font(21))
    label_font = _font(19)
    y = PAD + title_h
    for label, cards, n_chunks in chunks:
        draw.text((PAD, y), str(label), fill=FG, font=label_font)
        y += label_h
        for ci in range(n_chunks):
            x = PAD
            for cid in cards[ci * per_row:(ci + 1) * per_row]:
                _paint_hanafuda(img, x, y, w, h, cid)
                x += w + GAP
            y += h + GAP
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()

# ---------------------------------------------------------------------------
# 残存ギャップ対応（2026-11-08）: コードネーム盤面 / ビンゴ全体盤 /
# 集計バー / めんどうタイル / ラブレター役職カード / 星か爆弾か盤面
#
# 秘匿の原則は従来どおり: 共有画像の描画関数には「公開してよい情報」だけを
# 渡す。コードネームは未開示セルの種類を cog 側で None に落としてから渡す
# （描画関数は None を「伏せ」としてしか描かない）。
# ---------------------------------------------------------------------------

def _fit_font(draw, text, max_w, start_size, min_size=10):
    """text が max_w に収まるフォントを返す。"""
    size = start_size
    while size > min_size:
        font = _font(size)
        if draw.textlength(str(text), font=font) <= max_w:
            return font
        size -= 2
    return _font(min_size)


CODENAMES_COLORS = {
    "red": (198, 52, 60),
    "blue": (44, 96, 196),
    "neutral": (196, 178, 138),
    "assassin": (38, 38, 46),
}
CODENAMES_FACE = (238, 233, 218)


def render_codenames_board(words, cells, *, tile_w: int = 168, tile_h: int = 84) -> bytes:
    """コードネームの 5×5 盤面。

    cells は25要素の (kind, revealed) の組。kind は "red"/"blue"/"neutral"/
    "assassin" か None。revealed=True のセルは種類色で塗る。revealed=False
    かつ kind が判明しているセル（リーダー用キー表示でのみ渡される）は
    種類色の縁取り＋淡色で示す。共有盤面では未開示セルの kind を必ず
    None にして渡すこと（秘匿は呼び出し側＝cog の責務）。
    """
    assert len(words) == 25 and len(cells) == 25
    width = PAD * 2 + 5 * tile_w + 4 * GAP
    height = PAD * 2 + 5 * tile_h + 4 * GAP
    img = Image.new("RGB", (width, height), BG)
    draw = ImageDraw.Draw(img)
    for i in range(25):
        r, c = divmod(i, 5)
        x = PAD + c * (tile_w + GAP)
        y = PAD + r * (tile_h + GAP)
        kind, revealed = cells[i]
        if revealed and kind is not None:
            draw.rounded_rectangle([x, y, x + tile_w, y + tile_h], radius=10,
                                   fill=CODENAMES_COLORS[kind])
            text_color = (255, 255, 255)
        elif kind is not None:  # キー表示: 伏せだが種類が分かる
            base = CODENAMES_COLORS[kind]
            pale = tuple(int(v + (255 - v) * 0.72) for v in base)
            draw.rounded_rectangle([x, y, x + tile_w, y + tile_h], radius=10, fill=pale,
                                   outline=base, width=4)
            text_color = (43, 45, 56)
        else:
            draw.rounded_rectangle([x, y, x + tile_w, y + tile_h], radius=10,
                                   fill=CODENAMES_FACE)
            text_color = (43, 45, 56)
        font = _fit_font(draw, words[i], tile_w - 16, 25)
        _centered(draw, x + tile_w // 2, y + tile_h // 2, str(words[i]), font, text_color)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def codenames_public_cells(key, revealed):
    """共有盤面用: 未開示セルの種類を落とした cells を作る（秘匿の構造担保）。"""
    return [(key[i] if revealed[i] else None, bool(revealed[i])) for i in range(25)]


def codenames_key_cells(key, revealed):
    """リーダー用: 種類は全て渡し、開示状態と組にする（ephemeral 専用）。"""
    return [(key[i], bool(revealed[i])) for i in range(25)]


# ---------------------------------------------------------------------------
# ビンゴ全体盤（75球の開示状況）
# ---------------------------------------------------------------------------

BINGO_DRAWN = (232, 126, 32)
BINGO_UNDRAWN = (52, 56, 68)


def render_bingo_board(drawn, *, cell: int = 44) -> bytes:
    """引かれた番号の全体盤。列は B(1-15)/I(16-30)/N(31-45)/G(46-60)/O(61-75)。

    drawn は開示済み番号の集合。出た番号を橙、未出を暗色で示す。
    """
    drawn = {int(n) for n in drawn}
    header_h = 34
    width = PAD * 2 + 5 * cell + 4 * GAP
    height = PAD * 2 + header_h + 15 * cell + 14 * GAP
    img = Image.new("RGB", (width, height), BG)
    draw = ImageDraw.Draw(img)
    head_font = _font(24)
    num_font = _font(21)
    for col, letter in enumerate("BINGO"):
        x = PAD + col * (cell + GAP)
        _centered(draw, x + cell // 2, PAD + header_h // 2, letter, head_font, FG)
        for row in range(15):
            n = col * 15 + row + 1
            y = PAD + header_h + row * (cell + GAP)
            if n in drawn:
                draw.rounded_rectangle([x, y, x + cell, y + cell], radius=8, fill=BINGO_DRAWN)
                color = (255, 255, 255)
            else:
                draw.rounded_rectangle([x, y, x + cell, y + cell], radius=8, fill=BINGO_UNDRAWN)
                color = (148, 154, 168)
            _centered(draw, x + cell // 2, y + cell // 2, str(n), num_font, color)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


# ---------------------------------------------------------------------------
# 集計バー（投票・順位などの分布表示、白基調）
# ---------------------------------------------------------------------------

BAR_BG = (246, 247, 250)
BAR_INK = (27, 31, 42)
BAR_TRACK = (231, 234, 241)
BAR_DEFAULT = (66, 110, 210)


def render_bars(rows, *, title: str | None = None, width: int = 880,
                bar_color=BAR_DEFAULT) -> bytes:
    """(ラベル, 値) の横棒グラフ。値の大きい順に並べ替えはしない（呼び出し側の順）。

    ラベルは左列、バーは値の最大値に対する割合で描き、右端に値を出す。
    投票結果や最終順位など「分布・集計」表示用（白基調はリーダーボードと統一）。
    """
    rows = [(str(label), float(value)) for label, value in rows]
    label_w = 300
    value_w = 90
    row_h = 46
    title_h = 44 if title else 0
    height = PAD * 2 + title_h + max(1, len(rows)) * row_h
    img = Image.new("RGB", (width, height), BAR_BG)
    draw = ImageDraw.Draw(img)
    y = PAD
    if title:
        draw.text((PAD, y), title, fill=BAR_INK, font=_font(24))
        y += title_h
    max_v = max((v for _, v in rows), default=0.0) or 1.0
    bar_x = PAD + label_w
    bar_max = width - bar_x - value_w - PAD
    label_font = _font(21)
    value_font = _font(21)
    for label, value in rows:
        font = _fit_font(draw, label, label_w - 12, 21)
        draw.text((PAD, y + row_h // 2), label, fill=BAR_INK, font=font, anchor="lm")
        draw.rounded_rectangle([bar_x, y + 8, bar_x + bar_max, y + row_h - 8],
                               radius=8, fill=BAR_TRACK)
        w = int(bar_max * max(0.0, value) / max_v)
        if w > 0:
            draw.rounded_rectangle([bar_x, y + 8, bar_x + max(w, 16), y + row_h - 8],
                                   radius=8, fill=bar_color)
        text = str(int(value)) if float(value).is_integer() else f"{value:g}"
        draw.text((bar_x + bar_max + 10, y + row_h // 2), text, fill=BAR_INK,
                  font=value_font, anchor="lm")
        y += row_h
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


# ---------------------------------------------------------------------------
# めんどうパス: 用事カードのタイル
# ---------------------------------------------------------------------------

MENDOU_COLORS = {
    "宿題": (64, 110, 190), "残業": (96, 84, 170), "掃除当番": (38, 148, 120),
    "ゴミ出し": (110, 140, 60), "買い出し": (200, 130, 40), "プレゼン": (178, 74, 92),
    "修理": (90, 100, 116), "洗濯": (52, 140, 178),
}
MENDOU_TILE_W, MENDOU_TILE_H = 104, 64


def _mendou_tiles_height(rows, per_row):
    label_h = 26
    height = PAD
    for _label, kinds in rows:
        n = sum(int(cnt) for _k, cnt in kinds)
        chunks = max(1, -(-n // per_row))
        height += label_h + chunks * MENDOU_TILE_H + (chunks - 1) * GAP + GAP
    return height + PAD - GAP


def render_mendou_rows(rows, *, title: str | None = None, max_width: int = 880) -> bytes:
    """(ラベル, [(種類, 枚数), ...]) の行をタイルで描く。

    場のカード（公開情報）や自分の手札の表示用。タイルは種類色＋種類名。
    ここに渡す内容は全て「見せてよい情報」である前提（秘匿は呼び出し側）。
    """
    rows = [(str(label), [(str(k), int(c)) for k, c in kinds if int(c) > 0])
            for label, kinds in rows]
    per_row = max(1, (max_width - PAD * 2 + GAP) // (MENDOU_TILE_W + GAP))
    title_h = 34 if title else 0
    height = _mendou_tiles_height(rows, per_row) + title_h
    img = Image.new("RGB", (max_width, max(height, 80)), BG)
    draw = ImageDraw.Draw(img)
    y = PAD
    if title:
        draw.text((PAD, y), title, fill=FG, font=_font(22))
        y += title_h
    label_font = _font(19)
    tile_font = _font(20)
    for label, kinds in rows:
        draw.text((PAD, y), label, fill=FG, font=label_font)
        y += 26
        x = PAD
        col = 0
        for kind, count in kinds:
            for _ in range(count):
                if col >= per_row:
                    col = 0
                    x = PAD
                    y += MENDOU_TILE_H + GAP
                color = MENDOU_COLORS.get(kind, (100, 104, 118))
                draw.rounded_rectangle([x, y, x + MENDOU_TILE_W, y + MENDOU_TILE_H],
                                       radius=9, fill=color)
                font = _fit_font(draw, kind, MENDOU_TILE_W - 10, 20)
                _centered(draw, x + MENDOU_TILE_W // 2, y + MENDOU_TILE_H // 2,
                          kind, font, (255, 255, 255))
                x += MENDOU_TILE_W + GAP
                col += 1
        y += MENDOU_TILE_H + GAP
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


# ---------------------------------------------------------------------------
# ラブレター（アゴ姫への手紙）: 役職カード
# ---------------------------------------------------------------------------

LOVELETTER_COLORS = {
    1: (96, 104, 118), 2: (64, 110, 190), 3: (178, 74, 92), 4: (64, 158, 120),
    5: (150, 96, 190), 6: (200, 140, 40), 7: (190, 84, 150), 8: (210, 170, 60),
}
LOVELETTER_W, LOVELETTER_H = 132, 184


def render_loveletter_cards(cards, *, title: str | None = None) -> bytes:
    """(ランク, 名前) の役職カードを横に並べる（手札は1〜2枚想定）。

    本人の ephemeral 手札表示専用。公開パネルには使わないこと。
    """
    cards = [(int(rank), str(name)) for rank, name in cards]
    title_h = 34 if title else 0
    width = PAD * 2 + len(cards) * LOVELETTER_W + max(0, len(cards) - 1) * GAP
    height = PAD * 2 + title_h + LOVELETTER_H
    img = Image.new("RGB", (max(width, 120), height), BG)
    draw = ImageDraw.Draw(img)
    y = PAD
    if title:
        draw.text((PAD, y), title, fill=FG, font=_font(21))
        y += title_h
    rank_font = _font(52)
    for i, (rank, name) in enumerate(cards):
        x = PAD + i * (LOVELETTER_W + GAP)
        color = LOVELETTER_COLORS.get(rank, (100, 104, 118))
        draw.rounded_rectangle([x, y, x + LOVELETTER_W, y + LOVELETTER_H], radius=12,
                               fill=(250, 249, 245), outline=color, width=4)
        draw.rounded_rectangle([x, y, x + LOVELETTER_W, y + 44], radius=12, fill=color)
        draw.rectangle([x, y + 30, x + LOVELETTER_W, y + 44], fill=color)
        _centered(draw, x + LOVELETTER_W // 2, y + 22, str(rank), _font(26), (255, 255, 255))
        _centered(draw, x + LOVELETTER_W // 2, y + 96, str(rank), rank_font, color)
        font = _fit_font(draw, name, LOVELETTER_W - 12, 24)
        _centered(draw, x + LOVELETTER_W // 2, y + 148, name, font, (43, 45, 56))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


# ---------------------------------------------------------------------------
# 星か爆弾か: ディスク盤面
# ---------------------------------------------------------------------------

def render_hoshi_board(rows, *, title: str | None = None) -> bytes:
    """各プレイヤーの山（伏せディスク）とめくれたディスクを描く。

    rows は [{label, stack, flipped, active}] の列。stack は伏せディスクの
    「枚数だけ」（中身は渡さない＝秘匿の構造担保）。flipped は公開済みの
    "star"/"bomb" の列（めくれた順）。
    """
    disc = 46
    label_w = 250
    row_h = 62
    title_h = 36 if title else 0
    max_discs = max((int(r.get("stack", 0)) + len(r.get("flipped", [])) for r in rows),
                    default=0)
    width = PAD * 2 + label_w + max(1, max_discs) * (disc + GAP)
    height = PAD * 2 + title_h + max(1, len(rows)) * row_h
    img = Image.new("RGB", (min(width, 1024), max(height, 80)), BG)
    draw = ImageDraw.Draw(img)
    y = PAD
    if title:
        draw.text((PAD, y), title, fill=FG, font=_font(22))
        y += title_h
    label_font = _font(19)
    for row in rows:
        label = str(row.get("label", ""))
        font = _fit_font(draw, label, label_w - 10, 19)
        color = (250, 204, 21) if row.get("active") else FG
        draw.text((PAD, y + row_h // 2), label, fill=color, font=font, anchor="lm")
        x = PAD + label_w
        cy = y + row_h // 2
        for kind in row.get("flipped", []):
            if kind == "star":
                draw.ellipse([x, cy - disc // 2, x + disc, cy + disc // 2],
                             fill=(250, 204, 21), outline=(255, 255, 255), width=2)
                _draw_star(draw, x + disc // 2, cy, disc * 0.30, (120, 84, 8))
            else:
                draw.ellipse([x, cy - disc // 2, x + disc, cy + disc // 2],
                             fill=(30, 30, 38), outline=(255, 255, 255), width=2)
                draw.ellipse([x + disc * 0.38, cy - disc * 0.10, x + disc * 0.62,
                              cy + disc * 0.14], fill=(120, 124, 138))
            x += disc + GAP
        for _ in range(int(row.get("stack", 0))):
            draw.ellipse([x, cy - disc // 2, x + disc, cy + disc // 2],
                         fill=(70, 60, 130), outline=(150, 140, 210), width=2)
            _centered(draw, x + disc // 2, cy, "?", _font(22), (220, 214, 250))
            x += disc + GAP
        y += row_h
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()
