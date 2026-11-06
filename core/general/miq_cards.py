# -*- coding: utf-8 -*-
"""MIQ のスタイル別レンダラ（トレカ・ネオン・ダーク・ポップ・パステル・チケット・ノート）。元 cogs/general.py から分割。"""
from __future__ import annotations

from .common import *
from .miq import (
    MIQ_NEW_H, MIQ_NEW_W, _miq_display_text, _miq_draw_units_line,
    _miq_emoji_font_path, _miq_fallback_fonts, _miq_fit, _miq_fit_units,
    _miq_load_font, _miq_mix, _miq_open_avatar, _miq_render_emoji_unit,
    _miq_save_png, _miq_split_units, _miq_unit_bases, _miq_unit_font,
    _miq_unit_width, _miq_wrap_units,
)
from .miq_styles import (
    _miq_circle_avatar, _miq_date_str, _miq_glow_lines,
    _miq_glow_lines_units, _miq_hash_int,
    _miq_heart, _miq_rng, _miq_rounded_avatar, _miq_special_font_path,
    _miq_star4, _miq_star5, _miq_truncate,
)

# card のレアリティ段階 (生成ごとに重み付き抽選する隠し要素。設定には出さない)
# (重み, ★数の (下限, 上限), ATK/DEF レンジ補正倍率, 枠キー)
_MIQ_CARD_RARITIES = (
    (70, (1, 3), 1.0, "normal"),
    (20, (3, 4), 1.6, "rare"),
    (7, (4, 5), 2.4, "super"),
    (3, (5, 5), 3.6, "ultra"),
)

# レアリティ段階ごとのカード枠グラデーション (色 stops)
_MIQ_CARD_FRAME_STOPS = {
    "normal": [(255, 80, 120), (255, 170, 40), (250, 235, 90), (90, 220, 120), (70, 170, 255), (170, 100, 255)],
    "rare": [(70, 140, 255), (60, 200, 255), (140, 240, 255), (80, 160, 255), (150, 120, 255), (50, 110, 240)],
    "super": [(255, 216, 92), (255, 178, 40), (255, 242, 175), (232, 164, 32), (255, 205, 80), (214, 144, 24)],
    "ultra": [(255, 40, 110), (255, 150, 0), (255, 255, 40), (40, 255, 110), (0, 190, 255), (190, 60, 255)],
}


def _miq_pick_card_rarity(rng=None):
    r = rng if rng is not None else random
    weights = [p[0] for p in _MIQ_CARD_RARITIES]
    return r.choices(_MIQ_CARD_RARITIES, weights=weights, k=1)[0]


def render_miq_card_png(avatar_bytes: bytes | None, text: str, name: str, username: str, *, font_path: str | None = None, date_str: str | None = None) -> bytes:
    """トレカ風: 左に虹枠カード (レアリティ/ATK/DEF)、右に明朝の本文と署名。"""
    from PIL import Image, ImageDraw, ImageOps

    W, H = MIQ_NEW_W, MIQ_NEW_H
    shown_name = _miq_display_text(name) or _miq_display_text(username) or "unknown"
    shown_user = _miq_display_text(username)
    shown_text = _miq_display_text(text) or text
    _rw, (star_lo, star_hi), stat_mult, frame_key = _miq_pick_card_rarity()

    # 背景: 濃紫グラデーション + 星屑
    img = Image.new("RGB", (W, H), (26, 10, 46))
    bd = ImageDraw.Draw(img)
    for yy in range(H):
        bd.line([(0, yy), (W, yy)], fill=_miq_mix((30, 12, 54), (16, 6, 30), yy / max(1, H - 1)))
    sparkle_layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    sd = ImageDraw.Draw(sparkle_layer)
    srng = _miq_rng(shown_text, "card-bg")
    for _ in range(26):
        sx, sy = srng.randrange(W), srng.randrange(H)
        _miq_star4(sd, sx, sy, srng.choice((4, 6, 8)), (255, 255, 255, srng.choice((90, 140, 190))))
        sd.ellipse([sx - 1, sy - 1, sx + 1, sy + 1], fill=(255, 255, 255, 160))
    img = Image.alpha_composite(img.convert("RGBA"), sparkle_layer).convert("RGB")
    d = ImageDraw.Draw(img)

    # カード枠: 虹色グラデーション (斜め)
    cx0, cy0, cw, ch = 40, 30, 368, 615
    grad = Image.new("RGB", (cw, ch))
    gstops = _MIQ_CARD_FRAME_STOPS[frame_key]
    gdraw = ImageDraw.Draw(grad)
    for gx in range(cw):
        t = gx / max(1, cw - 1)
        pos = t * (len(gstops) - 1)
        i0 = min(len(gstops) - 2, int(pos))
        gdraw.line([(gx, 0), (gx, ch)], fill=_miq_mix(gstops[i0], gstops[i0 + 1], pos - i0))
    cmask = Image.new("L", (cw, ch), 0)
    ImageDraw.Draw(cmask).rounded_rectangle([0, 0, cw, ch], radius=20, fill=255)
    img.paste(grad, (cx0, cy0), cmask)
    d = ImageDraw.Draw(img)
    # 内側: クリーム地
    ix0, iy0, ix1, iy1 = cx0 + 11, cy0 + 11, cx0 + cw - 11, cy0 + ch - 11
    d.rounded_rectangle([ix0, iy0, ix1, iy1], radius=13, fill=(247, 243, 233))

    # 上部黒帯: 名前 + レアリティ ★
    band = [ix0 + 12, iy0 + 12, ix1 - 12, iy0 + 64]
    d.rounded_rectangle(band, radius=8, fill=(17, 17, 26))
    name_font = _miq_load_font(font_path, 23)
    band_name = _miq_truncate(d, shown_name, name_font, 190)
    d.text((band[0] + 14, (band[1] + band[3]) // 2), band_name, font=name_font, fill=(255, 255, 255), anchor="lm", stroke_width=1, stroke_fill=(255, 255, 255))
    star_n = star_lo + _miq_hash_int(shown_text, "card-stars") % (star_hi - star_lo + 1)
    for i in range(star_n):
        _miq_star5(d, band[2] - 18 - i * 27, (band[1] + band[3]) // 2, 11, (245, 197, 66))

    # アバターエリア
    ax0, ay0, ax1, ay1 = ix0 + 12, band[3] + 12, ix1 - 12, band[3] + 334
    av = ImageOps.fit(_miq_open_avatar(avatar_bytes).convert("RGB"), (ax1 - ax0, ay1 - ay0), Image.LANCZOS)
    img.paste(av, (ax0, ay0))
    d = ImageDraw.Draw(img)
    d.rectangle([ax0, ay0, ax1, ay1], outline=(40, 40, 52), width=2)
    if shown_user:
        d.text((ax0, ay1 + 14), f"@{shown_user}", font=_miq_load_font(font_path, 20), fill=(96, 96, 108))
    d.text((ax0, ay1 + 50), date_str or _miq_date_str(), font=_miq_load_font(font_path, 18), fill=(122, 120, 112))
    atk = 100 + _miq_hash_int(shown_text, "card-atk") % 9900
    dfn = 100 + _miq_hash_int(shown_text, "card-def") % 9900
    if stat_mult != 1.0:
        # 上位レアリティでは ATK/DEF のレンジを引き上げる (生成自体は決定的ハッシュのまま)
        atk = min(9999, int(100 + (atk - 100) * stat_mult))
        dfn = min(9999, int(100 + (dfn - 100) * stat_mult))
    stat_font = _miq_load_font(font_path, 24)
    d.text((ax0, iy1 - 42), f"ATK {atk}", font=stat_font, fill=(26, 26, 36))
    d.text((ax1, iy1 - 42), f"DEF {dfn}", font=stat_font, fill=(26, 26, 36), anchor="ra")

    # 上位レアリティの追加演出 (隠し要素): 金のキラキラ追加 / 全面ホログラム光沢
    if frame_key in ("super", "ultra"):
        fx = _miq_rng(shown_text, "card-rare-fx")
        fx_layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        fd = ImageDraw.Draw(fx_layer)
        for _ in range(10):
            fx_x = fx.randrange(cx0 + cw + 30, W - 20)
            fx_y = fx.randrange(30, H - 30)
            _miq_star4(fd, fx_x, fx_y, fx.choice((6, 9, 12)), (245, 197, 66, 200))
        img = Image.alpha_composite(img.convert("RGBA"), fx_layer).convert("RGB")
        d = ImageDraw.Draw(img)
    if frame_key == "ultra":
        sheen = Image.new("RGBA", (cw, ch), (0, 0, 0, 0))
        shd = ImageDraw.Draw(sheen)
        for sx in range(-ch, cw + ch, 54):
            shd.polygon(
                [(sx, 0), (sx + 20, 0), (sx + 20 - int(ch * 0.45), ch), (sx - int(ch * 0.45), ch)],
                fill=(255, 255, 255, 34),
            )
        img.paste(Image.alpha_composite(img.crop((cx0, cy0, cx0 + cw, cy0 + ch)).convert("RGBA"), sheen).convert("RGB"), (cx0, cy0), cmask)
        d = ImageDraw.Draw(img)

    # 右: 本文 (明朝優先) + 署名
    serif = _miq_special_font_path("ZenOldMincho") or font_path
    tx = cx0 + cw + 46
    lines, lh, _size = _miq_fit_units(d, shown_text, serif, W - tx - 50, 300, max_size=56, min_size=22)
    ty = 150
    for line in lines:
        if line:
            d = _miq_draw_units_line(img, d, tx, ty, line, _size, serif, (255, 255, 255))
        ty += lh
    sig_font = _miq_load_font(serif, 27)
    d.text((tx, 528), _miq_truncate(d, f"― {shown_name}", sig_font, W - tx - 50), font=sig_font, fill=(235, 230, 250))
    _miq_star4(d, tx + 6, 586, 9, (255, 255, 255, 255))
    return _miq_save_png(img)


def render_miq_neon_png(avatar_bytes: bytes | None, text: str, name: str, username: str, *, font_path: str | None = None) -> bytes:
    """ネオン風: 黒〜濃紫背景、右にマゼンタのグロー付きリングアバター、左にシアンのグロー文字。"""
    from PIL import Image, ImageDraw, ImageFilter

    W, H = MIQ_NEW_W, MIQ_NEW_H
    shown_name = _miq_display_text(name) or _miq_display_text(username) or "unknown"
    shown_user = _miq_display_text(username)
    shown_text = _miq_display_text(text) or text

    img = Image.new("RGB", (W, H), (8, 4, 16))
    bd = ImageDraw.Draw(img)
    for yy in range(H):
        bd.line([(0, yy), (W, yy)], fill=_miq_mix((10, 5, 20), (30, 7, 42), yy / max(1, H - 1)))
    d = ImageDraw.Draw(img)

    # 右: アバターのグロー付き二重リング
    ccx, ccy, r = 884, 330, 186
    glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse([ccx - r - 16, ccy - r - 16, ccx + r + 16, ccy + r + 16], fill=(255, 43, 214, 255))
    glow = glow.filter(ImageFilter.GaussianBlur(36))
    img = Image.alpha_composite(img.convert("RGBA"), glow)
    img = Image.alpha_composite(img, glow).convert("RGB")
    av = _miq_circle_avatar(avatar_bytes, r * 2)
    img.paste(av, (ccx - r, ccy - r), av)
    d = ImageDraw.Draw(img)
    d.ellipse([ccx - r - 9, ccy - r - 9, ccx + r + 9, ccy + r + 9], outline=(255, 43, 214), width=6)
    d.ellipse([ccx - r + 4, ccy - r + 4, ccx + r - 4, ccy + r - 4], outline=(255, 140, 245), width=3)

    # 左: 本文 (シアンのネオングロー)
    lines, lh, _size = _miq_fit_units(d, shown_text, font_path, 540, 360, max_size=58, min_size=22)
    ty = max(90, (470 - len(lines) * lh) // 2 + 40)
    img = _miq_glow_lines_units(img, lines, 64, ty, lh, _size, font_path, (196, 255, 255), (0, 224, 255))
    d = ImageDraw.Draw(img)

    # 左下: 表示名 (ピンクのグロー) + @username
    name_font = _miq_load_font(font_path, 30)
    shown_name = _miq_truncate(d, shown_name, name_font, 540)
    name_lines = _miq_wrap_units(d, shown_name, font_path, 30, 540)
    img = _miq_glow_lines_units(img, name_lines, 64, 548, 40, 30, font_path, (255, 190, 248), (255, 43, 214), blur=7)
    d = ImageDraw.Draw(img)
    if shown_user:
        d.text((64, 596), f"@{shown_user}", font=_miq_load_font(font_path, 22), fill=(168, 168, 186))
    return _miq_save_png(img)


def render_miq_dark_png(avatar_bytes: bytes | None, text: str, name: str, username: str, *, font_path: str | None = None) -> bytes:
    """ダーク風: アバター全面のモノクロ写真に下部グラデーション、左下に大きな白字。"""
    from PIL import Image, ImageDraw, ImageEnhance, ImageOps

    W, H = MIQ_NEW_W, MIQ_NEW_H
    shown_name = _miq_display_text(name) or _miq_display_text(username) or "unknown"
    shown_user = _miq_display_text(username)
    shown_text = _miq_display_text(text) or text

    src = _miq_open_avatar(avatar_bytes)
    img = ImageOps.fit(src.convert("RGB"), (W, H), Image.LANCZOS)
    img = ImageOps.grayscale(img).convert("RGB")
    img = ImageEnhance.Brightness(img).enhance(0.85)
    img = ImageEnhance.Contrast(img).enhance(1.06)

    # 下部グラデーション (黒)
    shade = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    shd = ImageDraw.Draw(shade)
    for yy in range(H):
        if yy < 260:
            continue
        alpha = int(238 * (yy - 260) / max(1, H - 260))
        shd.line([(0, yy), (W, yy)], fill=(0, 0, 0, alpha))
    img = Image.alpha_composite(img.convert("RGBA"), shade).convert("RGB")
    d = ImageDraw.Draw(img)

    # 本文 (左下、白・太字)
    lines, lh, _size = _miq_fit_units(d, shown_text, font_path, 830, 290, max_size=64, min_size=24)
    ty = 472 - len(lines) * lh
    for line in lines:
        if line:
            d = _miq_draw_units_line(img, d, 56, ty, line, _size, font_path, (255, 255, 255), stroke_width=2)
        ty += lh
    d.line([(56, 496), (172, 496)], fill=(255, 255, 255), width=3)
    name_font = _miq_load_font(font_path, 29)
    d.text((56, 512), _miq_truncate(d, shown_name, name_font, 700), font=name_font,
           fill=(255, 255, 255), stroke_width=1, stroke_fill=(255, 255, 255))
    if shown_user:
        d.text((56, 552), f"@{shown_user}", font=_miq_load_font(font_path, 21), fill=(203, 203, 203))
    return _miq_save_png(img)


def render_miq_pop_png(avatar_bytes: bytes | None, text: str, name: str, username: str, *, font_path: str | None = None) -> bytes:
    """ポップ風: 黄色ドット地に白カード+オフセットシャドウ、右に角丸アバターとピンクのピル。"""
    from PIL import Image, ImageDraw

    W, H = MIQ_NEW_W, MIQ_NEW_H
    shown_name = _miq_display_text(name) or _miq_display_text(username) or "unknown"
    shown_user = _miq_display_text(username)
    shown_text = _miq_display_text(text) or text

    img = Image.new("RGB", (W, H), (255, 208, 40))
    d = ImageDraw.Draw(img)
    for gx in range(14, W, 27):
        for gy in range(14, H, 27):
            d.ellipse([gx - 2, gy - 2, gx + 2, gy + 2], fill=(243, 183, 16))

    # 白カード (黒太枠 + 右下オフセットの黒シャドウ)
    card = [36, 64, 800, 610]
    d.rounded_rectangle([card[0] + 13, card[1] + 13, card[2] + 13, card[3] + 13], radius=16, fill=(0, 0, 0))
    d.rounded_rectangle(card, radius=16, fill=(255, 255, 255), outline=(0, 0, 0), width=5)
    _miq_star4(d, 798, 56, 30, (255, 255, 255), outline=(0, 0, 0), width=3)

    # 本文 (DelaGothicOne があれば優先、黒の極太字)
    dela = _miq_special_font_path("DelaGothicOne") or font_path
    lines, lh, _size = _miq_fit_units(d, shown_text, dela, 684, 420, max_size=54, min_size=22)
    ty = (card[1] + card[3]) // 2 - (len(lines) * lh) // 2
    for line in lines:
        if line:
            d = _miq_draw_units_line(img, d, 74, ty, line, _size, dela, (10, 10, 10))
        ty += lh

    # 右: アバター (角丸四角、黒枠+シャドウ)
    av_box = [848, 88, 1140, 380]
    d.rounded_rectangle([av_box[0] + 10, av_box[1] + 10, av_box[2] + 10, av_box[3] + 10], radius=18, fill=(0, 0, 0))
    av = _miq_rounded_avatar(avatar_bytes, av_box[2] - av_box[0], 18)
    img.paste(av, (av_box[0], av_box[1]), av)
    d = ImageDraw.Draw(img)
    d.rounded_rectangle(av_box, radius=18, outline=(0, 0, 0), width=5)

    # ピンクのピル型バッジ (表示名)
    pill = [848, 420, 1140, 484]
    d.rounded_rectangle([pill[0] + 6, pill[1] + 6, pill[2] + 6, pill[3] + 6], radius=32, fill=(0, 0, 0))
    d.rounded_rectangle(pill, radius=32, fill=(255, 110, 190))
    name_font = _miq_load_font(font_path, 25)
    pill_name = _miq_truncate(d, shown_name, name_font, 252)
    d.text(((pill[0] + pill[2]) // 2, (pill[1] + pill[3]) // 2), pill_name, font=name_font, fill=(10, 10, 10), anchor="mm")
    if shown_user:
        user_font = _miq_load_font(font_path, 23)
        d.text(((pill[0] + pill[2]) // 2, 522), _miq_truncate(d, f"@{shown_user}", user_font, 280),
               font=user_font, fill=(10, 10, 10), anchor="ma", stroke_width=1, stroke_fill=(10, 10, 10))
    return _miq_save_png(img)


def render_miq_pastel_png(avatar_bytes: bytes | None, text: str, name: str, username: str, *, font_path: str | None = None) -> bytes:
    """パステル風: ピンク→水色グラデーションに白ドット、右に白リングの丸アバター。"""
    from PIL import Image, ImageDraw

    W, H = MIQ_NEW_W, MIQ_NEW_H
    shown_name = _miq_display_text(name) or _miq_display_text(username) or "unknown"
    shown_user = _miq_display_text(username)
    shown_text = _miq_display_text(text) or text

    # 横グラデーション (ピンク → ラベンダー → 水色) + 白ドット
    img = Image.new("RGB", (W, H), (253, 216, 233))
    bd = ImageDraw.Draw(img)
    stops = [(253, 216, 233), (216, 206, 245), (188, 226, 250)]
    for gx in range(W):
        t = gx / max(1, W - 1)
        if t < 0.5:
            c = _miq_mix(stops[0], stops[1], t * 2)
        else:
            c = _miq_mix(stops[1], stops[2], (t - 0.5) * 2)
        bd.line([(gx, 0), (gx, H)], fill=c)
    dots = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    dd = ImageDraw.Draw(dots)
    for gx in range(15, W, 30):
        for gy in range(15, H, 30):
            dd.ellipse([gx - 2, gy - 2, gx + 2, gy + 2], fill=(255, 255, 255, 110))
    img = Image.alpha_composite(img.convert("RGBA"), dots).convert("RGB")
    d = ImageDraw.Draw(img)

    # 装飾 (ハートと星)
    _miq_heart(d, 676, 108, 46, (248, 130, 175))
    _miq_heart(d, 796, 74, 26, (250, 205, 80))
    _miq_star4(d, 876, 156, 17, (255, 255, 255))
    _miq_star4(d, 1078, 108, 21, (250, 205, 80))
    _miq_star4(d, 726, 470, 19, (110, 220, 190))
    _miq_star4(d, 1128, 500, 25, (248, 130, 175))

    # 右: アバター (白い太リング + 内側ピンク)
    ccx, ccy = 922, 302
    d.ellipse([ccx - 180, ccy - 180, ccx + 180, ccy + 180], fill=(255, 255, 255))
    d.ellipse([ccx - 169, ccy - 169, ccx + 169, ccy + 169], fill=(251, 131, 175))
    av = _miq_circle_avatar(avatar_bytes, 318)
    img.paste(av, (ccx - 159, ccy - 159), av)
    d = ImageDraw.Draw(img)

    # アバター下: 白ピル (表示名ピンク字) + @username
    name_font = _miq_load_font(font_path, 24)
    pill_name = _miq_truncate(d, shown_name, name_font, 300)
    tw = d.textlength(pill_name, font=name_font)
    pill = [ccx - tw / 2 - 26, 506, ccx + tw / 2 + 26, 552]
    d.rounded_rectangle(pill, radius=23, fill=(255, 255, 255))
    d.text((ccx, 529), pill_name, font=name_font, fill=(238, 108, 160), anchor="mm")
    if shown_user:
        d.text((ccx, 574), f"@{shown_user}", font=_miq_load_font(font_path, 20), fill=(122, 126, 152), anchor="ma")

    # 左: 本文 (濃いグレー、柔らかめ)
    lines, lh, _size = _miq_fit_units(d, shown_text, font_path, 576, 380, max_size=47, min_size=20)
    ty = (H - len(lines) * lh) // 2
    for line in lines:
        if line:
            d = _miq_draw_units_line(img, d, 60, ty, line, _size, font_path, (76, 74, 98))
        ty += lh
    return _miq_save_png(img)


# ticket の配色バリエーション (生成ごとに重み付き抽選する隠し要素。設定には出さない)
# (重み, 背景, 帯, チケット地, アクセント)
_MIQ_TICKET_PALETTES = (
    (52, (37, 41, 17), (96, 104, 44), (246, 242, 230), (84, 90, 38)),     # 標準: クリーム×オリーブ
    (12, (46, 22, 22), (150, 44, 44), (248, 238, 232), (150, 44, 44)),    # 赤系
    (12, (16, 28, 48), (44, 84, 150), (236, 242, 250), (44, 84, 150)),    # 青系
    (12, (34, 20, 52), (106, 62, 160), (242, 238, 250), (106, 62, 160)),  # 紫系
    (7, (16, 16, 16), (24, 24, 24), (240, 234, 214), (148, 114, 40)),     # 黒×金
    (5, (66, 30, 48), (214, 96, 140), (252, 240, 246), (196, 70, 118)),   # ピンク系
)


def _miq_pick_ticket_palette(rng=None):
    r = rng if rng is not None else random
    weights = [p[0] for p in _MIQ_TICKET_PALETTES]
    return r.choices(_MIQ_TICKET_PALETTES, weights=weights, k=1)[0]


def render_miq_ticket_png(avatar_bytes: bytes | None, text: str, name: str, username: str, *, font_path: str | None = None, date_str: str | None = None) -> bytes:
    """チケット風: クリーム色の横長チケット。右スタブに丸アバターとバーコード。"""
    from PIL import Image, ImageDraw

    W, H = MIQ_NEW_W, MIQ_NEW_H
    shown_name = _miq_display_text(name) or _miq_display_text(username) or "unknown"
    shown_user = _miq_display_text(username)
    shown_text = _miq_display_text(text) or text
    _weight, bg_color, band_color, paper_color, accent_color = _miq_pick_ticket_palette()
    ink = (22, 22, 20)

    img = Image.new("RGB", (W, H), bg_color)

    # チケット本体 + 左端の帯。角丸マスクで帯の角も揃える
    tx0, ty0, tx1, ty1 = 52, 150, 1148, 525
    ticket = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    td = ImageDraw.Draw(ticket)
    td.rounded_rectangle([tx0, ty0, tx1, ty1], radius=16, fill=paper_color + (255,))
    td.rectangle([tx0, ty0, tx0 + 18, ty1], fill=band_color + (255,))
    tmask = Image.new("L", (W, H), 0)
    ImageDraw.Draw(tmask).rounded_rectangle([tx0, ty0, tx1, ty1], radius=16, fill=255)
    ticket.putalpha(tmask)
    img.paste(ticket, (0, 0), ticket)
    d = ImageDraw.Draw(img)

    # ミシン目 (縦の破線) + 上下の半円ノッチ
    perf_x = 928
    for yy in range(ty0 + 18, ty1 - 16, 18):
        d.line([(perf_x, yy), (perf_x, yy + 10)], fill=(142, 142, 132), width=2)
    d.ellipse([perf_x - 15, ty0 - 15, perf_x + 15, ty0 + 15], fill=bg_color)
    d.ellipse([perf_x - 15, ty1 - 15, perf_x + 15, ty1 + 15], fill=bg_color)

    # ヘッダ: ADMIT ONE / No.
    head_font = _miq_load_font(font_path, 20)
    d.text((94, 178), "ADMIT ONE", font=head_font, fill=accent_color, stroke_width=1, stroke_fill=accent_color)
    no_str = f"No.{100000 + _miq_hash_int(shown_text, 'ticket-no') % 900000}"
    d.text((896, 178), no_str, font=head_font, fill=(110, 104, 90), anchor="ra")

    # 本文 (黒・太字・左揃え)
    lines, lh, _size = _miq_fit_units(d, shown_text, font_path, 786, 176, max_size=50, min_size=21)
    ty = 226
    for line in lines:
        if line:
            d = _miq_draw_units_line(img, d, 94, ty, line, _size, font_path, ink, stroke_width=1)
        ty += lh
    d.line([(94, 448), (896, 448)], fill=(202, 198, 182), width=2)

    # 下段カラム: GUEST / DATE / SEAT
    label_font = _miq_load_font(font_path, 15)
    value_font = _miq_load_font(font_path, 22)
    seat = f"{chr(ord('A') + _miq_hash_int(shown_text, 'ticket-seat') % 26)}-{1 + _miq_hash_int(shown_text, 'ticket-seat2') % 20}"
    cols = [
        (94, "GUEST", _miq_truncate(d, shown_name, value_font, 240)),
        (380, "DATE", date_str or _miq_date_str()),
        (640, "SEAT", seat),
    ]
    for col_x, label, value in cols:
        d.text((col_x, 462), label, font=label_font, fill=(122, 118, 106))
        d.text((col_x, 482), value, font=value_font, fill=ink)

    # スタブ: 丸アバター (黒リング) + @username + バーコード
    scx, scy = 1038, 250
    d.ellipse([scx - 69, scy - 69, scx + 69, scy + 69], fill=(15, 15, 15))
    av = _miq_circle_avatar(avatar_bytes, 124)
    img.paste(av, (scx - 62, scy - 62), av)
    d = ImageDraw.Draw(img)
    if shown_user:
        user_font = _miq_load_font(font_path, 20)
        d.text((scx, 338), _miq_truncate(d, f"@{shown_user}", user_font, 190), font=user_font, fill=ink, anchor="ma")
    brng = _miq_rng(shown_text, "ticket-barcode")
    bx = 964
    while bx < 1106:
        bw = brng.choice((2, 3, 4, 6))
        if brng.random() < 0.78:
            d.rectangle([bx, 418, bx + bw, 496], fill=(15, 15, 15))
        bx += bw + brng.choice((2, 3, 4))
    return _miq_save_png(img)


def render_miq_note_png(avatar_bytes: bytes | None, text: str, name: str, username: str, *, font_path: str | None = None) -> bytes:
    """ノート風: 罫線ノート紙に手書き風の本文、右に少し傾けた写真プリント風アバター。"""
    from PIL import Image, ImageDraw, ImageOps

    W, H = MIQ_NEW_W, MIQ_NEW_H
    shown_name = _miq_display_text(name) or _miq_display_text(username) or "unknown"
    shown_user = _miq_display_text(username)
    shown_text = _miq_display_text(text) or text

    img = Image.new("RGB", (W, H), (250, 247, 238))
    d = ImageDraw.Draw(img)
    # 横罫線 + 左の赤マージン線 + パンチ穴
    for yy in range(64, H, 44):
        d.line([(0, yy), (W, yy)], fill=(170, 198, 230), width=1)
    d.line([(104, 0), (104, H)], fill=(243, 158, 158), width=2)
    for hy in (180, 480):
        d.ellipse([40 - 14, hy - 14, 40 + 14, hy + 14], fill=(233, 229, 221), outline=(208, 203, 192), width=2)

    # 本文 (手書き風フォントがあれば優先、紺色)
    hand = _miq_special_font_path("YuseiMagic") or font_path
    lines, lh, _size = _miq_fit_units(d, shown_text, hand, 586, 340, max_size=46, min_size=20)
    ty = (H - len(lines) * lh) // 2
    for line in lines:
        if line:
            d = _miq_draw_units_line(img, d, 150, ty, line, _size, hand, (40, 54, 112))
        ty += lh

    # 右: 写真プリント風アバター (白枠、少し傾け、上部にマスキングテープ)
    src = _miq_open_avatar(avatar_bytes)
    photo = Image.new("RGBA", (332, 366), (0, 0, 0, 0))
    ImageDraw.Draw(photo).rectangle([0, 0, 332, 366], fill=(255, 255, 255, 255))
    photo.paste(ImageOps.fit(src.convert("RGB"), (300, 300), Image.LANCZOS), (16, 16))
    rot = photo.rotate(-4, resample=Image.BICUBIC, expand=True)
    shadow = Image.new("RGBA", rot.size, (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rectangle([0, 0, rot.size[0], rot.size[1]], fill=(0, 0, 0, 0))
    shadow.putalpha(rot.split()[-1].point(lambda v: int(v * 0.28)))
    shadow_rgb = Image.new("RGBA", rot.size, (60, 55, 40, 255))
    shadow_rgb.putalpha(shadow.split()[-1])
    img.paste(shadow_rgb, (796, 76), shadow_rgb)
    img.paste(rot, (788, 66), rot)
    tape = Image.new("RGBA", (150, 40), (250, 231, 150, 190))
    tape = tape.rotate(8, resample=Image.BICUBIC, expand=True)
    img.paste(tape, (872, 48), tape)
    d = ImageDraw.Draw(img, "RGBA")

    # 写真の下: 星 + 表示名 (黄色マーカーハイライト) + @username
    _miq_star4(d, 758, 452, 14, (40, 54, 112))
    name_font = _miq_load_font(hand, 26)
    disp_name = _miq_truncate(d, shown_name, name_font, 330)
    tw = d.textlength(disp_name, font=name_font)
    d.rectangle([800, 470, 800 + tw + 16, 506], fill=(255, 236, 130, 150))
    d.text((808, 474), disp_name, font=name_font, fill=(32, 36, 60))
    if shown_user:
        d.text((808, 516), f"@{shown_user}", font=_miq_load_font(font_path, 19), fill=(115, 115, 125))
    return _miq_save_png(img.convert("RGB") if img.mode == "RGBA" else img)


# 単体メッセージ系フォーマットのレンダラ表。_miq_build_file がここで分岐する。


# ------------------------------------------------------------
# グラスカード風: 本文中の Unicode 絵文字をカラーで描くための
# 単位ベース折り返し/描画 (miq.py の単位機構を再利用する)
# ------------------------------------------------------------
def _miq_glass_wrap(draw, text, chain, size: int, emoji_path, max_w: float) -> list:
    """本文を単位 (文字/絵文字) ごとに測って max_w で折り返す。

    戻り値は [[(unit, width), ...], ...]。描けない単位 (幅0) は落とす。
    """
    lines: list = []
    for para in (text or "").split("\n"):
        line: list = []
        line_w = 0.0
        for unit in _miq_split_units(para):
            w = _miq_unit_width(unit, draw, chain, size, emoji_path)
            if w <= 0:
                continue
            if line and line_w + w > max_w:
                lines.append(line)
                line, line_w = [], 0.0
            line.append((unit, w))
            line_w += w
        lines.append(line)
    return [ln for ln in lines if ln]


def _miq_glass_draw_line(img, draw, x: float, y: float, line, size: int, chain, emoji_path, fill):
    """折り返し済みの1行を描く。絵文字はカラーで合成する。貼り付け後の Draw を返す。"""
    from PIL import ImageDraw

    cx = x
    for unit, w in line:
        kind, font = _miq_unit_font(unit, chain, emoji_path)
        if kind == "emoji":
            used = _miq_render_emoji_unit(img, draw, cx, y, unit, size, emoji_path)
            draw = ImageDraw.Draw(img)
            cx += used if used else w
        elif kind == "font":
            draw.text((cx, y), _miq_unit_bases(unit) or unit, font=font, fill=fill,
                      stroke_width=1, stroke_fill=fill)
            cx += w
        else:
            cx += w
    return draw


def render_miq_glass_png(avatar_bytes: bytes | None, text: str, name: str, username: str, *, font_path: str | None = None) -> bytes:
    """グラスカード風: 鮮やかなメッシュグラデに半透明のすりガラスカード、白の太字本文。

    本文中 の Unicode 絵文字は LINE風と同じ単位機構でカラー表示する
    (対応しない環境ではその単位を落とす)。
    """
    from PIL import Image, ImageDraw, ImageFilter

    W, H = MIQ_NEW_W, MIQ_NEW_H
    shown_name = _miq_display_text(name) or _miq_display_text(username) or "unknown"
    shown_user = _miq_display_text(username)
    shown_text = _miq_display_text(text) or text

    # 背景: 4隅の色を補間したメッシュグラデーション
    mesh = Image.new("RGB", (2, 2))
    mesh.putpixel((0, 0), (18, 186, 168))    # 左上 ティール
    mesh.putpixel((1, 0), (96, 58, 208))     # 右上 紫
    mesh.putpixel((0, 1), (219, 66, 138))    # 左下 ピンク
    mesh.putpixel((1, 1), (52, 84, 196))     # 右下 青
    img = mesh.resize((W, H), Image.BICUBIC)

    # すりガラスカード: 背景をぼかして白を薄く重ね、明るい細枠を付ける
    card = [64, 104, W - 64, H - 104]
    region = img.crop(tuple(card)).filter(ImageFilter.GaussianBlur(22)).convert("RGBA")
    region = Image.alpha_composite(region, Image.new("RGBA", region.size, (255, 255, 255, 58)))
    mask = Image.new("L", region.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, region.size[0], region.size[1]], radius=38, fill=255)
    img.paste(region.convert("RGB"), (card[0], card[1]), mask)
    frame = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(frame).rounded_rectangle(card, radius=38, outline=(255, 255, 255, 190), width=2)
    img = Image.alpha_composite(img.convert("RGBA"), frame).convert("RGB")
    d = ImageDraw.Draw(img)

    # カード内左上: 丸アバター + 名前 (白・太字) + @ID (淡色)
    av_size = 92
    ax, ay = card[0] + 52, card[1] + 46
    av = _miq_circle_avatar(avatar_bytes, av_size)
    img.paste(av, (ax, ay), av)
    d = ImageDraw.Draw(img)
    name_font = _miq_load_font(font_path, 34)
    disp_name = _miq_truncate(d, shown_name, name_font, 760)
    d.text((ax + av_size + 26, ay + 4), disp_name, font=name_font, fill=(255, 255, 255),
           stroke_width=1, stroke_fill=(255, 255, 255))
    if shown_user:
        d.text((ax + av_size + 26, ay + 52), f"@{shown_user}", font=_miq_load_font(font_path, 23), fill=(235, 238, 250))

    # 本文: 白・太字。Unicode絵文字はカラーでインライン合成する
    emoji_path = None
    try:
        from .miq_line import _miq_unicode_emoji_supported

        if _miq_unicode_emoji_supported():
            emoji_path = _miq_emoji_font_path()
    except Exception:
        logger.debug("MIQ: Unicode絵文字対応の判定に失敗しました", exc_info=True)
        emoji_path = None
    body_x, body_w = card[0] + 52, (card[2] - card[0]) - 104
    body_top, body_h = card[1] + 196, (card[3] - card[1]) - 196 - 44
    size = 54
    while True:
        chain = _miq_fallback_fonts(font_path, size)
        lines = _miq_glass_wrap(d, shown_text, chain, size, emoji_path, body_w)
        lh = int(size * 1.42)
        if len(lines) * lh <= body_h or size <= 24:
            break
        size -= 2
    max_lines = max(1, body_h // lh)
    if len(lines) > max_lines:
        lines = lines[:max_lines]
    ty = body_top
    for line in lines:
        d = _miq_glass_draw_line(img, d, body_x, ty, line, size, chain, emoji_path, (255, 255, 255))
        ty += lh
    return _miq_save_png(img)
