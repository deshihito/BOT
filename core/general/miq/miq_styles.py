# -*- coding: utf-8 -*-
"""MIQ のスタイル別レンダラ（GIF・漫画・音楽・ニュース・X・RPG・設計図・ピクセル）。元 cogs/general.py から分割。"""
from __future__ import annotations

from ..common import *
from .miq import (
    MIQ_GIF_MAX_FRAMES, MIQ_H, MIQ_NEW_H, MIQ_NEW_W, MIQ_W, _MIQ_ASSET_FONTS,
    _miq_display_text, _miq_draw_centered, _miq_draw_units_line,
    _miq_emoji_font_path, _miq_fallback_fonts, _miq_fit, _miq_fit_units,
    _miq_load_font, _miq_mix, _miq_open_avatar, _miq_render_emoji_unit,
    _miq_save_png, _miq_split_units, _miq_unit_bases, _miq_unit_font,
    _miq_wrap, render_miq_frames,
)

def render_miq_gif(avatar_bytes: bytes | None, text: str, name: str, username: str, *, max_bytes: int, **opts) -> bytes:
    """アバターがGIFアニメなら動く引用GIF、静止画なら1フレームのGIFを返す。サイズ超過時は段階的に縮小。"""
    from PIL import Image, ImageSequence

    src = _miq_open_avatar(avatar_bytes)
    raw: list = []
    durs: list[int] = []
    for i, fr in enumerate(ImageSequence.Iterator(src)):
        if i >= 120:
            break
        raw.append(fr.convert("RGBA").copy())
        durs.append(int(fr.info.get("duration", 80) or 80))
    if not raw:
        raw, durs = [src.convert("RGBA")], [100]

    stride = max(1, math.ceil(len(raw) / MIQ_GIF_MAX_FRAMES))
    picked = raw[::stride]
    picked_durs = [max(20, sum(durs[i:i + stride])) for i in range(0, len(raw), stride)]

    frames = render_miq_frames(picked, text, name, username, **opts)
    data = b""
    for width in (800, 600, 420):
        height = int(round(width * MIQ_H / MIQ_W))
        small = [f.resize((width, height), Image.LANCZOS) for f in frames]
        buf = io.BytesIO()
        if len(small) == 1:
            small[0].save(buf, "GIF")
        else:
            small[0].save(
                buf, "GIF", save_all=True, append_images=small[1:],
                duration=picked_durs, loop=0, disposal=2,
            )
        data = buf.getvalue()
        if len(data) <= max_bytes:
            break
    return data


# ------------------------------------------------------------
# MIQ 新フォーマット (漫画風 / 音楽再生風 / LINE風)。いずれも PNG 固定 (1200x675)
# ------------------------------------------------------------


def render_miq_manga_png(avatar_bytes: bytes | None, text: str, name: str, username: str, *, font_path: str | None = None) -> bytes:
    """漫画風: 左に劇画調アバターのコマ、右に集中線+フキダシ。"""
    from PIL import Image, ImageDraw, ImageEnhance, ImageOps

    W, H = MIQ_NEW_W, MIQ_NEW_H
    img = Image.new("RGB", (W, H), (255, 255, 255))
    left_w = int(W * 0.38)

    # 左コマ: アバターをグレースケール+強いコントラストで劇画調に
    src = _miq_open_avatar(avatar_bytes)
    av = ImageOps.fit(src.convert("RGB"), (left_w, H), Image.LANCZOS)
    av = ImageOps.grayscale(av)
    av = ImageOps.autocontrast(av, cutoff=1)
    av = ImageEnhance.Contrast(av).enhance(1.55)
    av = ImageOps.posterize(av, 2).convert("RGB")
    img.paste(av, (0, 0))

    # 右コマ: 集中線 (右コマ範囲でクリップ)
    cx, cy = (left_w + W) // 2, H // 2
    lines_layer = Image.new("RGB", (W, H), (255, 255, 255))
    ld = ImageDraw.Draw(lines_layer)
    for deg in range(0, 360, 3):
        rad = math.radians(deg + (deg % 7))
        x2 = cx + int(900 * math.cos(rad))
        y2 = cy + int(900 * math.sin(rad))
        ld.line([(cx, cy), (x2, y2)], fill=(175, 175, 175), width=2)
    clip = Image.new("L", (W, H), 0)
    ImageDraw.Draw(clip).rectangle([left_w, 0, W, H], fill=255)
    img = Image.composite(lines_layer, img, clip)
    d = ImageDraw.Draw(img)

    # フキダシ (楕円+左コマ方向への尾)
    bubble = [left_w + 72, 104, W - 56, H - 104]
    tail = [(bubble[0] + 26, 428), (bubble[0] + 118, 486), (left_w + 18, 548)]
    d.polygon(tail, fill=(255, 255, 255))
    d.line([tail[0], tail[2]], fill=(0, 0, 0), width=6)
    d.line([tail[1], tail[2]], fill=(0, 0, 0), width=6)
    d.ellipse(bubble, fill=(255, 255, 255), outline=(0, 0, 0), width=6)

    # 本文 (中央揃え)
    shown_text = _miq_display_text(text) or text
    lines, lh, _size = _miq_fit_units(
        d, shown_text, font_path, bubble[2] - bubble[0] - 130, bubble[3] - bubble[1] - 120,
        max_size=64, min_size=20,
    )
    ty = cy - (len(lines) * lh) // 2
    for line in lines:
        if line:
            _miq_draw_centered(img, d, cx, ty, "".join(u for u, _w in line), _size, (0, 0, 0), 0, font_path)
        ty += lh

    # 作者名の札 (右コマ左上)
    shown_name = _miq_display_text(name) or _miq_display_text(username) or "unknown"
    name_font = _miq_load_font(font_path, 26)
    name_w = d.textlength(shown_name, font=name_font)
    tag = [left_w + 26, 24, left_w + 26 + int(name_w) + 24, 24 + 44]
    d.rectangle(tag, fill=(255, 255, 255), outline=(0, 0, 0), width=3)
    d.text((tag[0] + 12, tag[1] + 8), shown_name, font=name_font, fill=(0, 0, 0))

    # コマ枠
    d.rectangle([5, 5, W - 6, H - 6], outline=(0, 0, 0), width=10)
    d.line([(left_w, 0), (left_w, H)], fill=(0, 0, 0), width=8)
    return _miq_save_png(img)


def render_miq_music_png(avatar_bytes: bytes | None, text: str, name: str, username: str, *, font_path: str | None = None) -> bytes:
    """音楽再生風: ぼかしたアバター背景+アートワーク+再生UI。"""
    from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageOps

    W, H = MIQ_NEW_W, MIQ_NEW_H
    src = _miq_open_avatar(avatar_bytes)
    art_src = src.convert("RGB")
    avg = art_src.resize((1, 1), Image.BILINEAR).getpixel((0, 0))

    bg = ImageOps.fit(art_src, (W, H), Image.LANCZOS)
    bg = bg.filter(ImageFilter.GaussianBlur(55))
    bg = ImageEnhance.Brightness(bg).enhance(0.55)
    bg = Image.blend(bg, Image.new("RGB", (W, H), avg), 0.32)
    img = bg
    d = ImageDraw.Draw(img, "RGBA")

    # アートワーク (角丸の正方形)
    art_size = 360
    art = ImageOps.fit(art_src, (art_size, art_size), Image.LANCZOS)
    mask = Image.new("L", (art_size, art_size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, art_size, art_size], radius=28, fill=255)
    art_x, art_y = 70, (H - art_size) // 2
    img.paste(art, (art_x, art_y), mask)
    d = ImageDraw.Draw(img, "RGBA")

    rx = 500  # 右カラム開始位置
    right_edge = W - 60

    # NOW PLAYING / 名前 / @username
    d.text((rx, 64), "N O W  P L A Y I N G", font=_miq_load_font(font_path, 22), fill=(255, 255, 255, 190))
    shown_name = _miq_display_text(name) or _miq_display_text(username) or "unknown"
    name_size = 46
    name_font = _miq_load_font(font_path, name_size)
    while name_size > 22 and d.textlength(shown_name, font=name_font) > right_edge - rx:
        name_size -= 2
        name_font = _miq_load_font(font_path, name_size)
    d.text((rx, 98), shown_name, font=name_font, fill=(255, 255, 255, 255))
    shown_user = _miq_display_text(username)
    if shown_user:
        d.text((rx, 158), f"@{shown_user}", font=_miq_load_font(font_path, 26), fill=(235, 235, 235, 170))

    # 本文
    shown_text = _miq_display_text(text) or text
    lines, lh, _size = _miq_fit_units(d, shown_text, font_path, right_edge - rx, 210, max_size=54, min_size=20)
    ty = 248
    for line in lines:
        if line:
            d = _miq_draw_units_line(img, d, rx, ty, line, _size, font_path, (255, 255, 255, 255))
        ty += lh

    # 再生時間は本文ハッシュから決定的に決める (総 120〜240 秒、経過 52%)
    digest = hashlib.md5((shown_text or "").encode("utf-8")).hexdigest()
    total = 120 + (int(digest[:6], 16) % 121)
    elapsed = int(total * 0.52)

    def _fmt(sec: int) -> str:
        return f"{sec // 60}:{sec % 60:02d}"

    bar_y = 528
    d.line([(rx, bar_y), (right_edge, bar_y)], fill=(255, 255, 255, 110), width=4)
    prog_x = rx + int((right_edge - rx) * (elapsed / total)) if total else rx
    d.line([(rx, bar_y), (prog_x, bar_y)], fill=(255, 255, 255, 255), width=6)
    time_font = _miq_load_font(font_path, 20)
    d.text((rx, bar_y + 12), _fmt(elapsed), font=time_font, fill=(255, 255, 255, 210))
    d.text((right_edge, bar_y + 12), f"-{_fmt(total - elapsed)}", font=time_font, fill=(255, 255, 255, 210), anchor="ra")

    # 再生コントロール (図形のみ)
    ctrl_y = 624
    ccx = (rx + right_edge) // 2
    dark = _miq_mix(avg, (0, 0, 0), 0.55)
    # 前へ: 縦棒+左向き三角
    d.rectangle([ccx - 168, ctrl_y - 16, ccx - 162, ctrl_y + 16], fill=(255, 255, 255, 255))
    d.polygon([(ccx - 160, ctrl_y), (ccx - 128, ctrl_y - 17), (ccx - 128, ctrl_y + 17)], fill=(255, 255, 255, 255))
    # 次へ: 右向き三角+縦棒
    d.polygon([(ccx + 160, ctrl_y), (ccx + 128, ctrl_y - 17), (ccx + 128, ctrl_y + 17)], fill=(255, 255, 255, 255))
    d.rectangle([ccx + 162, ctrl_y - 16, ccx + 168, ctrl_y + 16], fill=(255, 255, 255, 255))
    # 中央: 白丸に一時停止の2本棒
    d.ellipse([ccx - 32, ctrl_y - 32, ccx + 32, ctrl_y + 32], fill=(255, 255, 255, 255))
    d.rectangle([ccx - 11, ctrl_y - 15, ccx - 3, ctrl_y + 15], fill=dark + (255,))
    d.rectangle([ccx + 3, ctrl_y - 15, ccx + 11, ctrl_y + 15], fill=dark + (255,))
    return _miq_save_png(img)


def render_miq_news_png(avatar_bytes: bytes | None, text: str, name: str, username: str, *, font_path: str | None = None) -> bytes:
    """ニュース速報風: ぼかしたアバター背景+「速報」バッジ+下部の見出し帯。"""
    from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageOps

    W, H = MIQ_NEW_W, MIQ_NEW_H
    src = _miq_open_avatar(avatar_bytes)
    art_src = src.convert("RGB")

    bg = ImageOps.fit(art_src, (W, H), Image.LANCZOS)
    bg = bg.filter(ImageFilter.GaussianBlur(42))
    bg = ImageEnhance.Brightness(bg).enhance(0.62)
    bg = Image.blend(bg, Image.new("RGB", (W, H), (10, 22, 52)), 0.45)
    img = bg
    d = ImageDraw.Draw(img, "RGBA")

    shown_name = _miq_display_text(name) or _miq_display_text(username) or "unknown"
    shown_user = _miq_display_text(username)
    shown_text = _miq_display_text(text) or text

    # 左上: 赤い「速報」バッジ
    badge_font = _miq_load_font(font_path, 36)
    d.rounded_rectangle([36, 32, 176, 88], radius=10, fill=(208, 28, 38, 255))
    d.text((106, 60), "速報", font=badge_font, fill=(255, 255, 255, 255), anchor="mm")
    sub_font = _miq_load_font(font_path, 24)
    d.text((196, 62), "MIQ NEWS", font=sub_font, fill=(255, 255, 255, 200), anchor="lm")

    # 下部: 細い青帯 (名前) → 白い見出し帯 → ティッカー帯
    ticker_h = 42
    band_top, band_bottom = 452, H - ticker_h
    blue_top = band_top - 44
    d.rectangle([0, blue_top, W, band_top], fill=(18, 56, 132, 255))
    who = shown_name + (f"  @{shown_user}" if shown_user and shown_user != shown_name else "")
    name_font = _miq_load_font(font_path, 25)
    nw = d.textlength(who, font=name_font)
    while nw > W - 72 and who:
        who = who[:-1]
        nw = d.textlength(who, font=name_font)
    d.text((36, blue_top + 22), who, font=name_font, fill=(255, 255, 255, 255), anchor="lm")

    d.rectangle([0, band_top, W, band_bottom], fill=(255, 255, 255, 255))
    lines, lh, _size = _miq_fit_units(
        d, shown_text, font_path, W - 72, band_bottom - band_top - 28,
        max_size=58, min_size=20,
    )
    ty = band_top + (band_bottom - band_top - len(lines) * lh) // 2
    for line in lines:
        if line:
            d = _miq_draw_units_line(img, d, 36, ty, line, _size, font_path, (16, 20, 28, 255))
        ty += lh

    # ティッカー風の細帯
    d.rectangle([0, band_bottom, W, H], fill=(6, 10, 24, 255))
    tick_font = _miq_load_font(font_path, 21)
    ticker = f"◆ {shown_name} さんの投稿を速報でお伝えしています ◆ MIQ NEWS"
    tw = d.textlength(ticker, font=tick_font)
    while tw > W - 72 and len(ticker) > 4:
        ticker = ticker[:-1]
        tw = d.textlength(ticker, font=tick_font)
    d.text((36, band_bottom + ticker_h // 2), ticker, font=tick_font, fill=(210, 222, 245, 255), anchor="lm")
    return _miq_save_png(img)


def render_miq_xpost_png(avatar_bytes: bytes | None, text: str, name: str, username: str, *, font_path: str | None = None) -> bytes:
    """X投稿風: 白カード+丸アバター+名前/@ID+本文+アクション行。"""
    from PIL import Image, ImageDraw, ImageOps

    W, H = MIQ_NEW_W, MIQ_NEW_H
    img = Image.new("RGB", (W, H), (255, 255, 255))
    d = ImageDraw.Draw(img)
    ink = (15, 20, 25)
    sub = (83, 100, 113)
    line_color = (207, 217, 222)

    shown_name = _miq_display_text(name) or _miq_display_text(username) or "unknown"
    shown_user = _miq_display_text(username)
    shown_text = _miq_display_text(text) or text

    d.rectangle([0, 0, W - 1, H - 1], outline=line_color, width=2)

    # 丸アバター
    av_size = 96
    av = ImageOps.fit(_miq_open_avatar(avatar_bytes).convert("RGB"), (av_size, av_size), Image.LANCZOS)
    circle = Image.new("L", (av_size, av_size), 0)
    ImageDraw.Draw(circle).ellipse([0, 0, av_size, av_size], fill=255)
    img.paste(av, (48, 48), circle)
    d = ImageDraw.Draw(img)

    # 表示名 (太字気味に二度描き) + @username
    name_font = _miq_load_font(font_path, 34)
    nm = shown_name
    while nm and d.textlength(nm, font=name_font) > W - 200:
        nm = nm[:-1]
    d.text((168, 56), nm, font=name_font, fill=ink, stroke_width=1, stroke_fill=ink)
    if shown_user:
        d.text((168, 102), f"@{shown_user}", font=_miq_load_font(font_path, 26), fill=sub)

    # 本文 (左揃え)
    lines, lh, _size = _miq_fit_units(d, shown_text, font_path, W - 96, 268, max_size=46, min_size=20)
    ty = 178
    for line in lines:
        if line:
            d = _miq_draw_units_line(img, d, 48, ty, line, _size, font_path, ink)
        ty += lh

    # アクション行の数字は本文ハッシュから決定的に生成する
    digest = hashlib.md5((shown_text or "").encode("utf-8")).hexdigest()
    nums = [int(digest[i * 4:(i + 1) * 4], 16) for i in range(4)]
    counts = [
        f"{nums[0] % 1000:,}",
        f"{nums[1] % 5000:,}",
        f"{nums[2] % 20000:,}",
        f"{nums[3] % 900 + 1}万" if nums[3] % 3 else f"{nums[3] % 100000:,}",
    ]
    row_y = 566
    d.line([(48, row_y - 34), (W - 48, row_y - 34)], fill=line_color, width=2)
    num_font = _miq_load_font(font_path, 25)
    col_x = [70, 360, 650, 940]
    for i, cx0 in enumerate(col_x):
        cy = row_y
        if i == 0:
            # 返信: フキダシの輪郭
            d.rounded_rectangle([cx0, cy - 13, cx0 + 30, cy + 9], radius=8, outline=sub, width=3)
            d.polygon([(cx0 + 8, cy + 8), (cx0 + 8, cy + 18), (cx0 + 18, cy + 8)], outline=sub)
            d.line([(cx0 + 8, cy + 18), (cx0 + 8, cy + 9)], fill=sub, width=3)
        elif i == 1:
            # リポスト: 右向き矢印 (上) と左向き矢印 (下)
            d.line([(cx0, cy - 8), (cx0 + 26, cy - 8)], fill=sub, width=3)
            d.polygon([(cx0 + 26, cy - 14), (cx0 + 26, cy - 2), (cx0 + 36, cy - 8)], fill=sub)
            d.line([(cx0 + 8, cy + 10), (cx0 + 34, cy + 10)], fill=sub, width=3)
            d.polygon([(cx0 + 8, cy + 4), (cx0 + 8, cy + 16), (cx0 - 2, cy + 10)], fill=sub)
        elif i == 2:
            # いいね: ハート (2円+三角)
            d.ellipse([cx0, cy - 12, cx0 + 15, cy + 3], fill=sub)
            d.ellipse([cx0 + 13, cy - 12, cx0 + 28, cy + 3], fill=sub)
            d.polygon([(cx0 + 1, cy), (cx0 + 27, cy), (cx0 + 14, cy + 18)], fill=sub)
        else:
            # 表示数: 棒グラフ
            for j, bh in enumerate((10, 17, 24)):
                d.rectangle([cx0 + j * 10, cy + 12 - bh, cx0 + j * 10 + 6, cy + 12], fill=sub)
        d.text((cx0 + 46, cy + 1), counts[i], font=num_font, fill=sub, anchor="lm")
    return _miq_save_png(img)


def render_miq_rpg_png(avatar_bytes: bytes | None, text: str, name: str, username: str, *, font_path: str | None = None) -> bytes:
    """RPG風: 暗い背景+画面下の紺グラデーションウィンドウ (二重枠+名前プレート)。"""
    from PIL import Image, ImageDraw, ImageEnhance, ImageOps

    W, H = MIQ_NEW_W, MIQ_NEW_H
    src = _miq_open_avatar(avatar_bytes)
    bg = ImageOps.fit(src.convert("RGB"), (W, H), Image.LANCZOS)
    bg = ImageEnhance.Brightness(bg).enhance(0.5)
    bg = Image.blend(bg, Image.new("RGB", (W, H), (10, 14, 38)), 0.35)
    img = bg
    d = ImageDraw.Draw(img, "RGBA")

    shown_name = _miq_display_text(name) or _miq_display_text(username) or "unknown"
    shown_text = _miq_display_text(text) or text

    # ウィンドウ本体 (下半分、紺グラデーション)
    wx0, wy0, wx1, wy1 = 28, 392, W - 28, H - 28
    win = Image.new("RGB", (wx1 - wx0, wy1 - wy0))
    wd = ImageDraw.Draw(win)
    top_c, bot_c = (24, 36, 84), (8, 12, 36)
    for yy in range(wy1 - wy0):
        wd.line([(0, yy), (wx1 - wx0, yy)], fill=_miq_mix(top_c, bot_c, yy / max(1, wy1 - wy0 - 1)))
    img.paste(win, (wx0, wy0))
    d = ImageDraw.Draw(img, "RGBA")
    # 二重枠
    d.rounded_rectangle([wx0, wy0, wx1, wy1], radius=14, outline=(255, 255, 255, 255), width=4)
    d.rounded_rectangle([wx0 + 9, wy0 + 9, wx1 - 9, wy1 - 9], radius=9, outline=(150, 180, 255, 200), width=2)

    # 名前プレート (ウィンドウ左上に重ねる)
    name_font = _miq_load_font(font_path, 28)
    nm = shown_name
    while nm and d.textlength(nm, font=name_font) > 380:
        nm = nm[:-1]
    plate_w = int(d.textlength(nm, font=name_font)) + 40
    px0, py0 = wx0 + 24, wy0 - 24
    d.rounded_rectangle([px0, py0, px0 + plate_w, py0 + 48], radius=8, fill=(10, 16, 44, 255), outline=(255, 255, 255, 255), width=3)
    d.text((px0 + plate_w // 2, py0 + 24), nm, font=name_font, fill=(255, 255, 255, 255), anchor="mm")

    # 本文 (左揃え、白)
    lines, lh, _size = _miq_fit_units(
        d, shown_text, font_path, (wx1 - wx0) - 72, (wy1 - wy0) - 84,
        max_size=42, min_size=20,
    )
    ty = wy0 + 40
    for line in lines:
        if line:
            d = _miq_draw_units_line(img, d, wx0 + 36, ty, line, _size, font_path, (255, 255, 255, 255))
        ty += lh

    # 右下の送り印 ▼ (図形で描く)
    tx, ty2 = wx1 - 58, wy1 - 44
    d.polygon([(tx - 13, ty2), (tx + 13, ty2), (tx, ty2 + 15)], fill=(255, 255, 255, 235))
    return _miq_save_png(img)


# ------------------------------------------------------------
# MIQ 追加フォーマット (設計図風/レトロゲーム風/トレカ風/ネオン風/ダーク風/
# ポップ風/パステル風/チケット風/ノート風) の共通ヘルパー
# ------------------------------------------------------------
def _miq_date_str(created_at=None) -> str:
    """対象メッセージの作成日を JST で YYYY.MM.DD にする (None や不正値なら今日)。"""
    try:
        from zoneinfo import ZoneInfo

        jst = ZoneInfo("Asia/Tokyo")
    except Exception:
        logger.debug("MIQ: タイムゾーンの解決に失敗しました", exc_info=True)
        jst = timezone(timedelta(hours=9))
    if isinstance(created_at, datetime):
        dt = created_at.astimezone(jst) if created_at.tzinfo is not None else created_at.replace(tzinfo=jst)
    else:
        dt = datetime.now(jst)
    return dt.strftime("%Y.%m.%d")


def _miq_rng(text, salt: str):
    """本文+ソルトから決定的な乱数生成器を作る (星の散布やバーコード用)。"""
    seed = int.from_bytes(hashlib.md5(f"{salt}:{text or ''}".encode("utf-8")).digest()[:8], "big")
    return random.Random(seed)


def _miq_hash_int(text, salt: str) -> int:
    """本文+ソルトから決定的な整数を作る (レアリティや ATK/DEF、座席番号用)。"""
    return int(hashlib.md5(f"{salt}:{text or ''}".encode("utf-8")).hexdigest()[:8], 16)


def _miq_special_font_path(*needles: str) -> str | None:
    """assets/fonts からファイル名に needles のいずれかを含むフォントを探す。

    card の明朝 (ZenOldMincho)、pop の極太ゴシック (DelaGothicOne)、
    note の手書き風 (YuseiMagic) など、特定要素だけ別フォントに差し替える用。
    無ければ None を返し、呼び出し側は通常の font_path にフォールバックする。
    """
    try:
        entries = sorted(_MIQ_ASSET_FONTS.iterdir(), key=lambda p: p.name.lower())
    except Exception:
        logger.debug("MIQ: フォント探索に失敗しました", exc_info=True)
        return None
    for entry in entries:
        if entry.is_file() and entry.suffix.lower() in (".ttf", ".otf", ".ttc"):
            lname = entry.name.lower()
            if any(n.lower() in lname for n in needles):
                return str(entry)
    return None


def _miq_circle_avatar(avatar_bytes, size: int):
    """アバターを正方形に fit し、円形マスク付き (RGBA) で返す。"""
    from PIL import Image, ImageDraw, ImageOps

    av = ImageOps.fit(_miq_open_avatar(avatar_bytes).convert("RGB"), (size, size), Image.LANCZOS).convert("RGBA")
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).ellipse([0, 0, size, size], fill=255)
    av.putalpha(mask)
    return av


def _miq_rounded_avatar(avatar_bytes, size: int, radius: int):
    """アバターを正方形に fit し、角丸マスク付き (RGBA) で返す。"""
    from PIL import Image, ImageDraw, ImageOps

    av = ImageOps.fit(_miq_open_avatar(avatar_bytes).convert("RGB"), (size, size), Image.LANCZOS).convert("RGBA")
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size, size], radius=radius, fill=255)
    av.putalpha(mask)
    return av


def _miq_star4(draw, cx, cy, r, fill, outline=None, width=2):
    """4点星 (キラキラ) を描く。"""
    k = 0.22
    pts = [
        (cx, cy - r), (cx + r * k, cy - r * k), (cx + r, cy), (cx + r * k, cy + r * k),
        (cx, cy + r), (cx - r * k, cy + r * k), (cx - r, cy), (cx - r * k, cy - r * k),
    ]
    draw.polygon(pts, fill=fill)
    if outline:
        draw.line(pts + [pts[0]], fill=outline, width=width, joint="curve")


def _miq_star5(draw, cx, cy, r, fill):
    """5点星を描く (トレカのレアリティ表示用)。"""
    pts = []
    for i in range(10):
        ang = -math.pi / 2 + i * math.pi / 5
        rad = r if i % 2 == 0 else r * 0.45
        pts.append((cx + rad * math.cos(ang), cy + rad * math.sin(ang)))
    draw.polygon(pts, fill=fill)


def _miq_heart(draw, cx, cy, size, fill):
    """ハートを描く (size はおおよその幅)。"""
    w = float(size)
    h = w * 0.92
    x0, y0 = cx - w / 2, cy - h / 2
    draw.ellipse([x0, y0, x0 + w / 2, y0 + h / 2], fill=fill)
    draw.ellipse([x0 + w / 2, y0, x0 + w, y0 + h / 2], fill=fill)
    draw.polygon([(x0 + 2, y0 + h * 0.34), (x0 + w - 2, y0 + h * 0.34), (cx, y0 + h)], fill=fill)


def _miq_glow_lines(img, lines, x, y, lh, font, core, glow, *, blur=9):
    """複数行テキストをグロー (発光) 付きで描いた新しい画像を返す。"""
    from PIL import Image, ImageDraw, ImageFilter

    base = img.convert("RGBA")
    layer = Image.new("RGBA", base.size, (0, 0, 0, 0))
    ld = ImageDraw.Draw(layer)
    ty = y
    for line in lines:
        if line:
            ld.text((x, ty), line, font=font, fill=glow + (255,))
        ty += lh
    blurred = layer.filter(ImageFilter.GaussianBlur(blur))
    base = Image.alpha_composite(base, blurred)
    base = Image.alpha_composite(base, blurred)
    d = ImageDraw.Draw(base)
    ty = y
    for line in lines:
        if line:
            d.text((x, ty), line, font=font, fill=core + (255,))
        ty += lh
    return base.convert("RGB")


def _miq_glow_lines_units(img, lines, x, y, lh, size, primary_path, core, glow, *, blur=9):
    """_miq_glow_lines の単位版。文字を発光させつつ絵文字はカラーで描く。"""
    from PIL import Image, ImageDraw, ImageFilter

    base = img.convert("RGBA")
    layer = Image.new("RGBA", base.size, (0, 0, 0, 0))
    ld = ImageDraw.Draw(layer)
    chain = _miq_fallback_fonts(primary_path, size)
    emoji_path = _miq_emoji_font_path()
    ty = y
    for line in lines:
        cx = float(x)
        for unit, w in line:
            kind, font = _miq_unit_font(unit, chain, emoji_path)
            if kind == "font":
                ld.text((cx, ty), _miq_unit_bases(unit) or unit, font=font, fill=glow + (255,))
            cx += w
        ty += lh
    blurred = layer.filter(ImageFilter.GaussianBlur(blur))
    base = Image.alpha_composite(base, blurred)
    base = Image.alpha_composite(base, blurred)
    d = ImageDraw.Draw(base)
    core_fill = core + (255,) if len(core) == 3 else core
    ty = y
    for line in lines:
        if line:
            d = _miq_draw_units_line(base, d, x, ty, line, size, primary_path, core_fill)
        ty += lh
    return base.convert("RGB")


def _miq_truncate(draw, text: str, font, max_w: float) -> str:
    """text が max_w に収まるよう末尾を切り、… を付ける。"""
    if draw.textlength(text, font=font) <= max_w:
        return text
    while text and draw.textlength(text + "…", font=font) > max_w:
        text = text[:-1]
    return text + "…"


def render_miq_blueprint_png(avatar_bytes: bytes | None, text: str, name: str, username: str, *, font_path: str | None = None, date_str: str | None = None) -> bytes:
    """設計図風: 青地+白グリッド、右に線画アバターと寸法線・諸元表、左に白太字の本文。"""
    from PIL import Image, ImageDraw, ImageFilter, ImageOps

    W, H = MIQ_NEW_W, MIQ_NEW_H
    img = Image.new("RGB", (W, H), (27, 90, 190))

    # グリッド (細・太の2段階)
    grid = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    gd = ImageDraw.Draw(grid)
    for gx in range(0, W + 1, 24):
        gd.line([(gx, 0), (gx, H)], fill=(255, 255, 255, 26), width=1)
    for gy in range(0, H + 1, 24):
        gd.line([(0, gy), (W, gy)], fill=(255, 255, 255, 26), width=1)
    for gx in range(0, W + 1, 120):
        gd.line([(gx, 0), (gx, H)], fill=(255, 255, 255, 64), width=1)
    for gy in range(0, H + 1, 120):
        gd.line([(0, gy), (W, gy)], fill=(255, 255, 255, 64), width=1)
    img = Image.alpha_composite(img.convert("RGBA"), grid).convert("RGB")
    d = ImageDraw.Draw(img)

    shown_name = _miq_display_text(name) or _miq_display_text(username) or "unknown"
    shown_user = _miq_display_text(username)
    shown_text = _miq_display_text(text) or text

    # 右: アバターの線画 (薄い反転塗り + 白いエッジ線)
    src = _miq_open_avatar(avatar_bytes)
    native_w, native_h = src.size
    box = 330
    bx, by = W - 70 - box, 52
    gray = ImageOps.grayscale(ImageOps.fit(src.convert("RGB"), (box, box), Image.LANCZOS))
    faint_mask = Image.new("L", (box, box), 44)
    img.paste(ImageOps.invert(gray).convert("RGB"), (bx, by), faint_mask)
    edges = ImageOps.autocontrast(gray.filter(ImageFilter.FIND_EDGES))
    edge_mask = edges.point(lambda v: min(255, int(v * 1.9)))
    img.paste(Image.new("RGB", (box, box), (255, 255, 255)), (bx, by), edge_mask)
    d = ImageDraw.Draw(img)
    d.rectangle([bx, by, bx + box, by + box], outline=(255, 255, 255), width=3)

    # 寸法線 (枠の下に両端ティック付きの線 + FIG 表記)
    dim_y = by + box + 24
    d.line([(bx, dim_y), (bx + box, dim_y)], fill=(255, 255, 255), width=2)
    d.line([(bx, dim_y - 6), (bx, dim_y + 6)], fill=(255, 255, 255), width=2)
    d.line([(bx + box, dim_y - 6), (bx + box, dim_y + 6)], fill=(255, 255, 255), width=2)
    d.text((bx + box // 2, dim_y + 10), f"FIG.1  {native_w}x{native_h}",
           font=_miq_load_font(font_path, 19), fill=(255, 255, 255), anchor="ma")

    # 諸元表 (NAME / ID / DATE)
    tx0, tx1 = bx, bx + box
    ty0 = dim_y + 48
    row_h = 46
    rows = [
        ("NAME", shown_name),
        ("ID", f"@{shown_user}" if shown_user else "-"),
        ("DATE", date_str or _miq_date_str()),
    ]
    label_font = _miq_load_font(font_path, 15)
    value_font = _miq_load_font(font_path, 21)
    d.rectangle([tx0, ty0, tx1, ty0 + row_h * 3], outline=(255, 255, 255), width=2)
    for i, (label, value) in enumerate(rows):
        ry = ty0 + i * row_h
        if i:
            d.line([(tx0, ry), (tx1, ry)], fill=(255, 255, 255), width=1)
        d.text((tx0 + 10, ry + row_h // 2), label, font=label_font, fill=(210, 228, 255), anchor="lm")
        value = _miq_truncate(d, value, value_font, (tx1 - tx0) - 84)
        d.text((tx0 + 72, ry + row_h // 2), value, font=value_font, fill=(255, 255, 255), anchor="lm")
    d.line([(tx0 + 62, ty0), (tx0 + 62, ty0 + row_h * 3)], fill=(255, 255, 255), width=1)

    # 左: 本文 (白・太字・左揃え、縦中央)
    lines, lh, _size = _miq_fit_units(d, shown_text, font_path, 620, 440, max_size=58, min_size=22)
    ty = (H - len(lines) * lh) // 2
    for line in lines:
        if line:
            d = _miq_draw_units_line(img, d, 56, ty, line, _size, font_path, (255, 255, 255), stroke_width=1)
        ty += lh
    return _miq_save_png(img)


def render_miq_pixel_png(avatar_bytes: bytes | None, text: str, name: str, username: str, *, font_path: str | None = None) -> bytes:
    """レトロゲーム風: 星空+山影、下部の二重枠ウィンドウ内にドット絵ポートレートと本文。"""
    from PIL import Image, ImageDraw, ImageOps

    W, H = MIQ_NEW_W, MIQ_NEW_H
    shown_text = _miq_display_text(text) or text
    shown_name = _miq_display_text(name) or _miq_display_text(username) or "unknown"
    img = Image.new("RGB", (W, H), (10, 10, 34))
    d = ImageDraw.Draw(img, "RGBA")

    # 星空 (本文ハッシュで決定的に散布)
    rng = _miq_rng(shown_text, "pixel-stars")
    for _ in range(110):
        sx, sy = rng.randrange(W), rng.randrange(0, 430)
        s = rng.choice((2, 2, 3))
        shade = rng.choice(((255, 255, 255, 235), (205, 208, 230, 200), (150, 155, 190, 170)))
        d.rectangle([sx, sy, sx + s, sy + s], fill=shade)

    # 山影シルエット (2層、ブロック状の稜線)
    for salt, base_y, span, color in (("pixel-mtn-far", 320, 110, (21, 21, 50, 255)), ("pixel-mtn-near", 396, 84, (15, 15, 40, 255))):
        mrng = _miq_rng(shown_text, salt)
        pts = [(0, H)]
        x = 0
        while x < W:
            pts.append((x, base_y + mrng.randrange(0, span)))
            x += 48
        pts.append((W, base_y + mrng.randrange(0, span)))
        pts.append((W, H))
        d.polygon(pts, fill=color)
    img = img.convert("RGB")
    d = ImageDraw.Draw(img)

    # ウィンドウ (白い二重枠)
    wx0, wy0, wx1, wy1 = 24, 436, W - 24, H - 24
    d.rectangle([wx0, wy0, wx1, wy1], fill=(8, 10, 36))
    d.rectangle([wx0, wy0, wx1, wy1], outline=(255, 255, 255), width=4)
    d.rectangle([wx0 + 9, wy0 + 9, wx1 - 9, wy1 - 9], outline=(255, 255, 255), width=2)

    # 名前タブ (ウィンドウ左上に重なる小箱)
    name_font = _miq_load_font(font_path, 22)
    tab_name = _miq_truncate(d, shown_name, name_font, 320)
    tab_w = int(d.textlength(tab_name, font=name_font)) + 28
    tab = [wx0 + 14, wy0 - 38, wx0 + 14 + tab_w, wy0 + 4]
    d.rectangle(tab, fill=(8, 10, 36), outline=(255, 255, 255), width=3)
    d.text(((tab[0] + tab[2]) // 2, (tab[1] + tab[3]) // 2), tab_name, font=name_font, fill=(255, 255, 255), anchor="mm")

    # ポートレート (ドット絵化したアバター)
    p_size = 148
    px, py = wx0 + 26, wy0 + 24
    av = ImageOps.fit(_miq_open_avatar(avatar_bytes).convert("RGB"), (p_size, p_size), Image.LANCZOS)
    av = av.resize((30, 30), Image.BILINEAR).resize((p_size, p_size), Image.NEAREST)
    img.paste(av, (px, py))
    d = ImageDraw.Draw(img)
    d.rectangle([px, py, px + p_size, py + p_size], outline=(255, 255, 255), width=3)

    # 本文 (ポートレートの右、白字)
    tx = px + p_size + 28
    lines, lh, _size = _miq_fit_units(d, shown_text, font_path, wx1 - tx - 30, wy1 - wy0 - 56, max_size=38, min_size=16)
    ty = wy0 + 30
    for line in lines:
        if line:
            d = _miq_draw_units_line(img, d, tx, ty, line, _size, font_path, (255, 255, 255))
        ty += lh

    # 右下の送り印 ▼
    vx, vy = wx1 - 52, wy1 - 42
    d.polygon([(vx - 12, vy), (vx + 12, vy), (vx, vy + 14)], fill=(255, 255, 255))
    return _miq_save_png(img)


# ------------------------------------------------------------
# 縦書きレイアウト (ゴールド縦書き風 / 和風縦書き風で共用)
# ------------------------------------------------------------
def _miq_vertical_columns(text: str, font, col_h: int):
    """縦書き用に text を列へ割る。(columns, advance) を返す。

    columns[0] が最右列で、各列は上から下へ文字を積む。1列の高さが
    col_h を超えないよう文字数で割り、改行は列を改める。句読点・長音等の
    回転や寄せはせず、そのまま積む簡易対応。
    """
    size = getattr(font, "size", 32) or 32
    adv = max(8, int(size * 1.16))
    max_chars = max(1, col_h // adv)
    columns: list = []
    cur: list = []
    for unit in _miq_split_units(text or ""):
        if unit == "\n":
            columns.append(cur)
            cur = []
            continue
        if len(cur) >= max_chars:
            columns.append(cur)
            cur = []
        cur.append(unit)
    if cur or not columns:
        columns.append(cur)
    return columns, adv


def _miq_fit_vertical(text: str, font_path: str | None, col_h: int, max_w: int, *, max_size: int = 54, min_size: int = 20):
    """縦書き本文を (font, columns, adv_y, adv_x, size) に整える。

    列全体の幅が max_w に収まるまでフォントを縮小し、最小サイズでも
    収まらない場合は列数を制限して最終列の末尾に … を付ける。
    """
    size = max_size
    while True:
        font = _miq_load_font(font_path, size)
        columns, adv_y = _miq_vertical_columns(text, font, col_h)
        adv_x = max(adv_y, int(size * 1.55))
        if len(columns) * adv_x <= max_w or size <= min_size:
            break
        size -= 2
    max_cols = max(1, max_w // adv_x)
    if len(columns) > max_cols:
        columns = columns[:max_cols]
        max_chars = max(1, col_h // adv_y)
        last = columns[-1]
        if len(last) >= max_chars:
            last = last[:max_chars - 1]
        columns[-1] = last + ["…"]
    return font, columns, adv_y, adv_x, size


def _miq_draw_vertical(img, draw, columns, right_cx: int, top: int, adv_y: int, adv_x: int, size: int, primary_path, fill, **kwargs):
    """縦書きの列群を描く。right_cx は最右列の中心 x、列は右から左へ進む。

    列は単位 (文字/絵文字) の列で、絵文字はセル内に正立でカラー合成する。
    """
    chain = _miq_fallback_fonts(primary_path, size)
    emoji_path = _miq_emoji_font_path()
    for i, col in enumerate(columns):
        x = right_cx - i * adv_x
        for j, unit in enumerate(col):
            kind, font = _miq_unit_font(unit, chain, emoji_path)
            if kind == "emoji":
                ey = top + j * adv_y + max(0, (adv_y - size) // 2)
                _miq_render_emoji_unit(img, draw, x - size / 2, ey, unit, size, emoji_path)
            elif kind == "font":
                draw.text((x, top + j * adv_y), _miq_unit_bases(unit) or unit, font=font, fill=fill, anchor="ma", **kwargs)


def render_miq_luxury_png(avatar_bytes: bytes | None, text: str, name: str, username: str, *, font_path: str | None = None) -> bytes:
    """ゴールド縦書き風: 深緑の放射グラデに金の二重枠、金リングのアバター、金の縦書き本文。"""
    from PIL import Image, ImageDraw, ImageFilter

    W, H = MIQ_NEW_W, MIQ_NEW_H
    shown_name = _miq_display_text(name) or _miq_display_text(username) or "unknown"
    shown_user = _miq_display_text(username)
    shown_text = _miq_display_text(text) or text
    gold = (206, 172, 102)
    gold_bright = (232, 201, 128)
    serif = _miq_special_font_path("ZenOldMincho") or font_path

    # 背景: 中央が少し明るい深緑 (放射グラデーション相当をぼかし楕円で作る)
    img = Image.new("RGB", (W, H), (4, 24, 16))
    glow = Image.new("RGB", (W, H), (4, 24, 16))
    ImageDraw.Draw(glow).ellipse([-260, -300, W + 260, H + 180], fill=(18, 66, 46))
    img = Image.blend(img, glow.filter(ImageFilter.GaussianBlur(160)), 0.85)
    d = ImageDraw.Draw(img)

    # 金の二重細枠 + 四隅のダイヤ装飾
    d.rectangle([26, 26, W - 26, H - 26], outline=gold, width=3)
    d.rectangle([38, 38, W - 38, H - 38], outline=gold, width=1)
    for cx, cy in ((26, 26), (W - 26, 26), (26, H - 26), (W - 26, H - 26)):
        r = 9
        d.polygon([(cx, cy - r), (cx + r, cy), (cx, cy + r), (cx - r, cy)], fill=gold_bright)

    # 中央上: 金リング付き丸アバター
    av_size = 148
    ccx, top = W // 2, 64
    d.ellipse([ccx - av_size // 2 - 7, top - 7, ccx + av_size // 2 + 7, top + av_size + 7], outline=gold_bright, width=4)
    d.ellipse([ccx - av_size // 2 - 12, top - 12, ccx + av_size // 2 + 12, top + av_size + 12], outline=gold, width=1)
    av = _miq_circle_avatar(avatar_bytes, av_size)
    img.paste(av, (ccx - av_size // 2, top), av)
    d = ImageDraw.Draw(img)

    # 本文: 金色・明朝の縦書き (アバターの下、名前の上)
    body_top, body_h = 252, 236
    font, columns, adv_y, adv_x, _size = _miq_fit_vertical(
        shown_text, serif, body_h, 880, max_size=56, min_size=22,
    )
    block_w = len(columns) * adv_x
    right_cx = (W + block_w) // 2 - adv_x // 2
    _miq_draw_vertical(img, d, columns, right_cx, body_top, adv_y, adv_x, _size, serif, gold_bright)

    # 下部: 区切り線付きの名前と @ID (金色)
    name_font = _miq_load_font(serif, 29)
    disp_name = _miq_truncate(d, shown_name, name_font, 560)
    nw = d.textlength(disp_name, font=name_font)
    name_y = 540
    line_len = 64
    gap = 26
    total_w = line_len * 2 + gap * 2 + nw
    lx = (W - total_w) / 2
    d.line([(lx, name_y + 18), (lx + line_len, name_y + 18)], fill=gold, width=2)
    d.line([(lx + line_len + gap + nw + gap, name_y + 18), (lx + total_w, name_y + 18)], fill=gold, width=2)
    d.text((lx + line_len + gap, name_y), disp_name, font=name_font, fill=gold_bright)
    if shown_user:
        d.text((W // 2, name_y + 52), f"@{shown_user}", font=_miq_load_font(font_path, 21), fill=gold, anchor="ma")
    return _miq_save_png(img)


def render_miq_tate_png(avatar_bytes: bytes | None, text: str, name: str, username: str, *, font_path: str | None = None) -> bytes:
    """和風縦書き風: クリーム地の便箋。左に正方形アバターと赤いハートスタンプ、右に黒の縦書き本文。"""
    from PIL import Image, ImageDraw

    W, H = MIQ_NEW_W, MIQ_NEW_H
    shown_name = _miq_display_text(name) or _miq_display_text(username) or "unknown"
    shown_user = _miq_display_text(username)
    shown_text = _miq_display_text(text) or text
    ink = (34, 32, 30)
    sub = (110, 104, 96)
    serif = _miq_special_font_path("ZenOldMincho") or font_path

    img = Image.new("RGB", (W, H), (247, 243, 233))
    d = ImageDraw.Draw(img)

    # 左: 正方形アバター
    av_size = 300
    av = _miq_rounded_avatar(avatar_bytes, av_size, 4)
    img.paste(av, (56, 56), av)
    d = ImageDraw.Draw(img)
    d.rectangle([56, 56, 56 + av_size, 56 + av_size], outline=(198, 190, 174), width=2)

    # 名前 (小さな装飾つき) と @ID
    name_font = _miq_load_font(font_path, 27)
    disp_name = _miq_truncate(d, shown_name, name_font, 300)
    nw = d.textlength(disp_name, font=name_font)
    d.text((62, 408), disp_name, font=name_font, fill=ink)
    _miq_heart(d, 62 + nw + 22, 424, 16, (196, 80, 90))
    if shown_user:
        d.text((62, 448), f"@{shown_user}", font=_miq_load_font(font_path, 21), fill=sub)

    # 赤い角丸四角 + 白ハートのスタンプ
    stamp = [56, 512, 128, 584]
    d.rounded_rectangle(stamp, radius=14, fill=(196, 44, 44))
    _miq_heart(d, (stamp[0] + stamp[2]) // 2, (stamp[1] + stamp[3]) // 2 + 2, 40, (255, 255, 255))

    # 細い縦の区切り線
    d.line([(428, 64), (428, H - 64)], fill=(203, 196, 182), width=2)

    # 右: 本文の縦書き (黒・明朝、列は右から左)
    body_top, body_h = 84, 500
    font, columns, adv_y, adv_x, _size = _miq_fit_vertical(
        shown_text, serif, body_h, 620, max_size=50, min_size=20,
    )
    block_w = len(columns) * adv_x
    right_cx = 470 + (680 - block_w) // 2 + block_w - adv_x // 2
    _miq_draw_vertical(img, d, columns, right_cx, body_top, adv_y, adv_x, _size, serif, ink)
    return _miq_save_png(img)


def render_miq_novel_png(avatar_bytes: bytes | None, text: str, name: str, username: str, *, font_path: str | None = None) -> bytes:
    """小説風: オフホワイト地。左に明朝・行間広めの本文、右に影付き正方形アバターと名前。"""
    from PIL import Image, ImageDraw, ImageFilter

    W, H = MIQ_NEW_W, MIQ_NEW_H
    shown_name = _miq_display_text(name) or _miq_display_text(username) or "unknown"
    shown_user = _miq_display_text(username)
    shown_text = _miq_display_text(text) or text
    ink = (28, 28, 28)
    sub = (120, 118, 112)
    serif = _miq_special_font_path("ZenOldMincho") or font_path

    img = Image.new("RGB", (W, H), (250, 249, 246))
    d = ImageDraw.Draw(img)

    # 本文: 左 約62% に上揃え、行間は広め (1.85倍)。収まらなければ縮小/省略
    body_x, body_w, body_top, body_h = 64, 668, 76, 520
    lines, lh, _size = _miq_fit_units(
        d, shown_text, serif, body_w, body_h,
        max_size=40, min_size=20, lh_factor=1.85,
    )
    ty = body_top
    for line in lines:
        if line:
            d = _miq_draw_units_line(img, d, body_x, ty, line, _size, serif, ink)
        ty += lh

    # 右: 正方形アバター (柔らかい影つき)
    av_size = 300
    ax, ay = 816, 84
    shadow = Image.new("RGBA", (av_size + 40, av_size + 40), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rectangle([20, 20, av_size + 20, av_size + 20], fill=(0, 0, 0, 90))
    shadow = shadow.filter(ImageFilter.GaussianBlur(12))
    img.paste(shadow, (ax - 14, ay - 8), shadow)
    av = _miq_rounded_avatar(avatar_bytes, av_size, 6)
    img.paste(av, (ax, ay), av)
    d = ImageDraw.Draw(img)

    # アバターの下: 名前と @ID (グレー)
    name_font = _miq_load_font(font_path, 28)
    d.text((ax, ay + av_size + 26), _miq_truncate(d, shown_name, name_font, 320), font=name_font, fill=ink)
    if shown_user:
        d.text((ax, ay + av_size + 68), f"@{shown_user}", font=_miq_load_font(font_path, 22), fill=sub)
    return _miq_save_png(img)
