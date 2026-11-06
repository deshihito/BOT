# -*- coding: utf-8 -*-
"""MIQ の LINE 風レンダラ・アゴ合成・フォーマット登録表。元 cogs/general.py から分割。"""
from __future__ import annotations

from .common import *
from .miq import (
    MIQ_LINE_MAX_IMAGES, MIQ_LINE_MAX_MESSAGES, MIQ_NEW_H, MIQ_NEW_W,
    _MIQ_CUSTOM_EMOJI_TOKEN, _MIQ_EMOJI_SIZE,
    _miq_clean_text, _miq_display_text, _miq_draw_centered,
    _miq_emoji_font_path, _miq_emoji_width,
    _miq_fallback_fonts, _miq_fit, _miq_fit_units, _miq_is_emoji_unit, _miq_is_image_attachment,
    _miq_load_font, _miq_mix, _miq_open_avatar, _miq_render_emoji_unit,
    _miq_save_png, _miq_split_units, _miq_sticker_renderable, _miq_unit_bases,
    _miq_unit_font, _miq_unit_width, _miq_wrap, miq_is_refusing,
    miq_render_options, miq_resolve_format, render_miq_png,
)
from .meme import MEME_MAX_IMAGE_BYTES
from .miq_styles import (
    _miq_date_str, _miq_heart, _miq_rng, _miq_truncate,
    render_miq_blueprint_png, render_miq_gif, render_miq_luxury_png,
    render_miq_manga_png, render_miq_music_png,
    render_miq_news_png, render_miq_novel_png, render_miq_pixel_png,
    render_miq_rpg_png, render_miq_tate_png, render_miq_xpost_png,
)
from .miq_cards import (
    render_miq_card_png, render_miq_dark_png, render_miq_glass_png,
    render_miq_neon_png, render_miq_note_png, render_miq_pastel_png,
    render_miq_pop_png, render_miq_ticket_png,
)

_MIQ_FORMAT_RENDERERS = {
    "manga": render_miq_manga_png,
    "music": render_miq_music_png,
    "news": render_miq_news_png,
    "xpost": render_miq_xpost_png,
    "rpg": render_miq_rpg_png,
    "blueprint": render_miq_blueprint_png,
    "pixel": render_miq_pixel_png,
    "card": render_miq_card_png,
    "neon": render_miq_neon_png,
    "dark": render_miq_dark_png,
    "pop": render_miq_pop_png,
    "pastel": render_miq_pastel_png,
    "ticket": render_miq_ticket_png,
    "note": render_miq_note_png,
    "luxury": render_miq_luxury_png,
    "tate": render_miq_tate_png,
    "novel": render_miq_novel_png,
    "glass": render_miq_glass_png,
}

# 日付 (対象メッセージの作成日) を date_str として受け取るフォーマット
_MIQ_DATED_FORMATS = frozenset({"blueprint", "card", "ticket"})


# ------------------------------------------------------------
# MIQ 隠し要素: アゴのひょっこり合成 (開発者向け。利用者向け文言には出さない)
# ------------------------------------------------------------
MIQ_AGO_RARE_RATE = 0.02
_MIQ_AGO_DIR = Path(__file__).resolve().parent.parent.parent / "assets" / "miq_ago"
_MIQ_AGO_CACHE: list | None = None


def _miq_ago_images() -> list:
    """assets/miq_ago/ の透過PNGアセットを読み込む (初回のみ、読めない分は除く)。"""
    global _MIQ_AGO_CACHE
    if _MIQ_AGO_CACHE is not None:
        return _MIQ_AGO_CACHE
    from PIL import Image

    found = []
    try:
        paths = sorted(_MIQ_AGO_DIR.glob("ago_*.png"))
    except Exception:
        logger.debug("MIQ: アゴアセットの探索に失敗しました", exc_info=True)
        paths = []
    for path in paths:
        try:
            with Image.open(path) as im:
                found.append(im.convert("RGBA").copy())
        except Exception:
            logger.debug("MIQ: アゴアセットの読み込みに失敗しました", exc_info=True)
    _MIQ_AGO_CACHE = found
    return found


def apply_ago_overlay(png_bytes: bytes, *, force: bool = False, rng=None) -> bytes:
    """生成済みPNGに、確率 MIQ_AGO_RARE_RATE でアゴを隅からひょっこり合成する。

    force=True で抽選を経ず必ず合成する (テスト・確認用)。rng には
    random.Random 互換オブジェクトを渡せる。アセットが無い/読めない場合は
    元のバイト列をそのまま返す。GIF には適用しない (呼び出し側で分岐)。
    """
    r = rng if rng is not None else random
    if not force and r.random() >= MIQ_AGO_RARE_RATE:
        return png_bytes
    images = _miq_ago_images()
    if not images:
        return png_bytes
    try:
        from PIL import Image, ImageOps

        base = Image.open(io.BytesIO(png_bytes)).convert("RGBA")
        ago = r.choice(images)
        scale = r.uniform(0.25, 0.35)
        tw = max(24, int(base.width * scale))
        th = max(1, int(ago.height * tw / ago.width))
        ago_img = ago.resize((tw, th), Image.LANCZOS)
        corner = r.choice(("bl", "br", "tl", "tr"))
        over = r.uniform(0.22, 0.38)
        if corner[1] == "l":
            ago_img = ImageOps.mirror(ago_img)  # 左側の隅では内側を向かせる
            x = -int(tw * over)
        else:
            x = base.width - tw + int(tw * over)
        if corner[0] == "b":
            y = base.height - th + int(th * over)
        else:
            y = -int(th * over)
        base.paste(ago_img, (x, y), ago_img)
        buf = io.BytesIO()
        base.convert("RGB").save(buf, "PNG", optimize=True)
        return buf.getvalue()
    except Exception:
        logger.debug("MIQ: アゴ合成に失敗しました", exc_info=True)
        return png_bytes


class MiqLineEntry:
    """LINE風の1メッセージ分。render_miq_line_png は dict でもこの形でも受け付ける。

    (dataclass にしないのは、モジュールを sys.modules 外で読み込むテスト用ローダで
    dataclass のアノテーション解決が失敗するため)
    """

    def __init__(self, name: str, text: str, created_at=None, avatar_bytes: bytes | None = None,
                 avatar_image=None, author_key=None, segments=None, images=None, stickers=None):
        self.name = name
        self.text = text
        self.created_at = created_at
        self.avatar_bytes = avatar_bytes
        self.avatar_image = avatar_image
        self.author_key = author_key
        # segments: [{"type": "text", "text": str} | {"type": "emoji", "name": str,
        # "image": bytes|Image}] の並び。カスタム絵文字を本文内にインライン合成する。
        self.segments = segments
        # images / stickers: bytes | PIL.Image のリスト (写真 / スタンプ)
        self.images = images
        self.stickers = stickers

    def __repr__(self) -> str:
        return f"MiqLineEntry(name={self.name!r}, text={self.text!r}, author_key={self.author_key!r})"


def _miq_line_field(entry, key, default=None):
    if isinstance(entry, dict):
        return entry.get(key, default)
    return getattr(entry, key, default)


def _miq_line_time_str(created_at) -> str:
    """created_at を JST の HH:MM にする。"""
    if created_at is None:
        return ""
    try:
        from zoneinfo import ZoneInfo

        jst = ZoneInfo("Asia/Tokyo")
    except Exception:
        logger.debug("MIQ: タイムゾーンの解決に失敗しました", exc_info=True)
        jst = timezone(timedelta(hours=9))
    dt = created_at
    if isinstance(dt, datetime) and dt.tzinfo is not None:
        dt = dt.astimezone(jst)
    try:
        return dt.strftime("%H:%M")
    except Exception:
        logger.debug("MIQ: 時刻文字列の生成に失敗しました", exc_info=True)
        return ""


def _miq_line_avatar_image(entry):
    image = _miq_line_field(entry, "avatar_image")
    if image is not None:
        return image
    image = _miq_line_field(entry, "avatar")
    if image is not None and not isinstance(image, (bytes, bytearray)):
        return image
    avatar_bytes = _miq_line_field(entry, "avatar_bytes")
    if avatar_bytes is None and isinstance(image, (bytes, bytearray)):
        avatar_bytes = image
    return _miq_open_avatar(avatar_bytes)


# ---- LINE風: メディア (画像/スタンプ) と絵文字セグメント ----
_MIQ_UNICODE_EMOJI_SUPPORTED = None


def _miq_unicode_emoji_supported() -> bool:
    """Unicode絵文字を Noto Color Emoji の embedded_color で描けるか (初回のみプローブ)。

    描ける環境では本文行内にカラー絵文字を合成し、描けない環境では
    その単位を落とす (従来の除去動作) ための判定。結果はキャッシュする。
    """
    global _MIQ_UNICODE_EMOJI_SUPPORTED
    if _MIQ_UNICODE_EMOJI_SUPPORTED is not None:
        return _MIQ_UNICODE_EMOJI_SUPPORTED
    _MIQ_UNICODE_EMOJI_SUPPORTED = False
    path = _miq_emoji_font_path()
    if path:
        try:
            from PIL import Image, ImageDraw, ImageFont

            font = ImageFont.truetype(path, _MIQ_EMOJI_SIZE)
            tmp = Image.new("RGBA", (160, 160), (0, 0, 0, 0))
            ImageDraw.Draw(tmp).text((10, 10), "\U0001F600", font=font, embedded_color=True)
            if tmp.getbbox():
                _MIQ_UNICODE_EMOJI_SUPPORTED = True
        except Exception:
            logger.debug("MIQ: Unicode絵文字のプローブに失敗しました", exc_info=True)
    return _MIQ_UNICODE_EMOJI_SUPPORTED


def _miq_line_media_image(value):
    """bytes / bytearray / PIL.Image を RGBA 画像にする (GIF等は1フレーム目)。失敗時は None。"""
    from PIL import Image

    if value is None:
        return None
    if isinstance(value, Image.Image):
        img = value
    elif isinstance(value, (bytes, bytearray)):
        try:
            img = Image.open(io.BytesIO(bytes(value)))
        except Exception:
            logger.debug("MIQ: LINEメディア画像の読み込みに失敗しました", exc_info=True)
            return None
    else:
        return None
    try:
        img.seek(0)
    except Exception:
        logger.debug("MIQ: LINEメディア画像のフレーム移動に失敗しました", exc_info=True)
    try:
        return img.convert("RGBA").copy()
    except Exception:
        logger.debug("MIQ: LINEメディア画像の変換に失敗しました", exc_info=True)
        return None


def _miq_line_entry_atoms(entry, emoji_ok: bool) -> list:
    """エントリ本文を原子列にする。

    原子は (kind, payload): "text" (1単位の文字列) / "cemoji" (PIL.Image) /
    "uemoji" (Unicode絵文字の単位文字列) / "newline" (改行)。
    segments があればそれを優先し、無ければ text から作る。
    """
    atoms: list = []
    pieces: list = []
    segments = _miq_line_field(entry, "segments")
    if segments:
        for seg in segments:
            if isinstance(seg, dict):
                if seg.get("type") == "emoji":
                    img = _miq_line_media_image(
                        seg.get("image") if seg.get("image") is not None else seg.get("image_bytes")
                    )
                    if img is not None:
                        pieces.append(("cemoji", img))
                        continue
                    pieces.append(("text", f":{seg.get('name') or 'emoji'}:"))
                else:
                    pieces.append(("text", str(seg.get("text") or "")))
            else:
                pieces.append(("text", str(seg)))
    else:
        pieces.append(("text", str(_miq_line_field(entry, "text") or "")))
    emoji_path = _miq_emoji_font_path() if emoji_ok else None
    for kind, payload in pieces:
        if kind == "cemoji":
            atoms.append(("cemoji", payload))
            continue
        for unit in _miq_split_units(_miq_clean_text(payload)):
            if unit == "\n":
                atoms.append(("newline", None))
            elif emoji_path and _miq_is_emoji_unit(unit, emoji_path):
                atoms.append(("uemoji", unit))
            else:
                atoms.append(("text", unit))
    return atoms


def _miq_line_atom_width(atom, draw, chain, size: int, emoji_path) -> float:
    kind, payload = atom
    if kind == "cemoji":
        return float(size)
    if kind == "uemoji":
        return _miq_emoji_width(payload, size, emoji_path) if emoji_path else float(size)
    if kind == "newline":
        return 0.0
    return _miq_unit_width(payload, draw, chain, size, emoji_path)


def _miq_line_wrap_atoms(atoms, draw, chain, size: int, emoji_path, max_w: float) -> list:
    """原子列を max_w で折り返す。戻り値は [[(atom, width), ...], ...]。"""
    lines: list = []
    line: list = []
    line_w = 0.0
    for atom in atoms:
        if atom[0] == "newline":
            lines.append(line)
            line, line_w = [], 0.0
            continue
        w = _miq_line_atom_width(atom, draw, chain, size, emoji_path)
        if line and line_w + w > max_w:
            lines.append(line)
            line, line_w = [], 0.0
        line.append((atom, w))
        line_w += w
    lines.append(line)
    return lines


def _miq_line_draw_atoms(img, draw, x: float, y: float, line_atoms, size: int, chain, emoji_path, fill):
    """折り返し済みの1行 (原子列) を左揃えで描く。貼り付け後の Draw を返す。"""
    from PIL import Image, ImageDraw

    cx = x
    for atom, w in line_atoms:
        kind, payload = atom
        if w <= 0:
            continue
        if kind == "cemoji":
            sq = payload.resize((size, size), Image.LANCZOS)
            img.paste(sq, (int(round(cx)), int(round(y))), sq)
            draw = ImageDraw.Draw(img)
            cx += w
        elif kind == "uemoji":
            used = _miq_render_emoji_unit(img, draw, cx, y, payload, size, emoji_path)
            draw = ImageDraw.Draw(img)
            cx += used if used else w
        else:
            kind2, font = _miq_unit_font(payload, chain, emoji_path)
            if kind2 == "font":
                bases = _miq_unit_bases(payload) or payload
                draw.text((cx, y), bases, font=font, fill=fill)
            cx += w
    return draw


def _miq_line_fit_media(image, max_w: int, max_h: int, scale: float):
    """メディア画像の表示サイズ (w, h) を上限と全体スケールから決める。"""
    w = min(max_w, image.width)
    h = image.height * w / max(1, image.width)
    if h > max_h:
        w = int(w * max_h / h)
        h = max_h
    return max(1, int(w * scale)), max(1, int(h * scale))


def render_miq_line_png(entries, *, font_path: str | None = None) -> bytes:
    """LINE風: 会話リストを左右バブルで描く。最後の要素の作者が右側 (緑)。

    各エントリは「テキストバブル (カスタム絵文字/Unicode絵文字のインライン
    合成対応)」「写真 (バブルなし、角丸)」「スタンプ (バブルなし)」の
    ブロック列に展開され、ヘッダ (名前/アバター) はエントリに1回だけ、
    時刻は最後のブロックに付く。
    """
    from PIL import Image, ImageDraw, ImageOps

    W, H = MIQ_NEW_W, MIQ_NEW_H
    # 背景: 薄い青灰の縦グラデーション
    top, bottom = (215, 227, 242), (238, 243, 247)
    grad = Image.new("RGB", (1, H))
    for yy in range(H):
        grad.putpixel((0, yy), _miq_mix(top, bottom, yy / max(1, H - 1)))
    img = grad.resize((W, H))
    d = ImageDraw.Draw(img)

    items = list(entries or [])
    if not items:
        return _miq_save_png(img)

    emoji_ok = _miq_unicode_emoji_supported()
    emoji_path = _miq_emoji_font_path() if emoji_ok else None

    last_key = _miq_line_field(items[-1], "author_key")
    last_name = _miq_line_field(items[-1], "name")
    norm = []
    for entry in items:
        key = _miq_line_field(entry, "author_key")
        name = _miq_display_text(_miq_line_field(entry, "name") or "") or "unknown"
        is_right = (key == last_key) if key is not None or last_key is not None else (name == last_name)
        atoms = _miq_line_entry_atoms(entry, emoji_ok)
        has_text_atoms = any(kind != "newline" for kind, _p in atoms)
        images = []
        for value in _miq_line_field(entry, "images") or []:
            media = _miq_line_media_image(value)
            if media is not None:
                images.append(media)
        stickers = []
        for value in _miq_line_field(entry, "stickers") or []:
            media = _miq_line_media_image(value)
            if media is not None:
                stickers.append(media)
        norm.append({
            "name": name,
            "plain": str(_miq_line_field(entry, "text") or ""),
            "atoms": atoms,
            "rich": any(kind in ("cemoji", "uemoji") for kind, _p in atoms),
            "has_text": has_text_atoms,
            "images": images,
            "stickers": stickers,
            "time": _miq_line_time_str(_miq_line_field(entry, "created_at")),
            "avatar": _miq_line_avatar_image(entry),
            "right": bool(is_right),
        })

    green = (131, 226, 79)
    ink = (30, 35, 40)
    sub = (95, 105, 118)
    name_font = _miq_load_font(font_path, 22)
    meta_font = _miq_load_font(font_path, 17)
    max_text_w = 560 - 44
    block_gap = 10

    def layout(font_size: int, img_scale: float):
        """(laid, total_h) を返す。laid は (item, blocks, entry_h)。blocks は描画用 dict の列。"""
        font = _miq_load_font(font_path, font_size)
        chain = _miq_fallback_fonts(font_path, font_size)
        lh = int(font_size * 1.34)
        laid = []
        total_h = 28
        for item in norm:
            blocks = []
            if item["has_text"]:
                if item["rich"]:
                    wrapped = _miq_line_wrap_atoms(item["atoms"], d, chain, font_size, emoji_path, max_text_w)
                    text_w = max(
                        (sum(w for _a, w in line) for line in wrapped), default=0.0,
                    )
                    bubble_w = min(int(text_w) + 44, max_text_w + 44)
                    blocks.append({
                        "kind": "bubble", "rich_lines": wrapped, "str_lines": None,
                        "w": bubble_w, "h": len(wrapped) * lh + 30,
                    })
                else:
                    wrapped = _miq_wrap(d, item["plain"], font, max_text_w) or [""]
                    text_w = max((d.textlength(line, font=font) for line in wrapped), default=0)
                    blocks.append({
                        "kind": "bubble", "rich_lines": None, "str_lines": wrapped,
                        "w": int(text_w) + 44, "h": len(wrapped) * lh + 30,
                    })
            for media in item["images"]:
                w, h = _miq_line_fit_media(media, 420, 420, img_scale)
                blocks.append({"kind": "image", "media": media, "w": w, "h": h})
            for media in item["stickers"]:
                w, h = _miq_line_fit_media(media, 280, 280, img_scale)
                blocks.append({"kind": "sticker", "media": media, "w": w, "h": h})
            if not blocks:
                blocks.append({
                    "kind": "bubble", "rich_lines": None, "str_lines": [""],
                    "w": 44, "h": lh + 30,
                })
            entry_h = 26 + sum(b["h"] for b in blocks) + block_gap * (len(blocks) - 1)
            laid.append((item, blocks, entry_h))
            total_h += entry_h + 16
        return laid, total_h

    # 全要素が収まるフォントサイズと画像スケールの組み合わせを探す
    laid = []
    font_size = 17
    for fs in (36, 32, 28, 24, 20, 17):
        chosen = None
        for img_scale in (1.0, 0.75, 0.55, 0.4):
            cand, total_h = layout(fs, img_scale)
            if total_h <= H - 12:
                chosen = cand
                break
        if chosen is not None:
            laid, font_size = chosen, fs
            break
    if not laid:
        laid, _total = layout(17, 0.4)
        font_size = 17

    avatar_size = 72
    font = _miq_load_font(font_path, font_size)
    chain = _miq_fallback_fonts(font_path, font_size)
    lh = int(font_size * 1.34)
    y = 24
    for item, blocks, entry_h in laid:
        content_top = y + 26
        if item["right"]:
            av_x = W - 36 - avatar_size
            content_right = av_x - 16
            d.text((content_right, y), item["name"], font=name_font, fill=sub, anchor="ra")
        else:
            av_x = 36
            content_left = av_x + avatar_size + 16
            d.text((content_left, y), item["name"], font=name_font, fill=sub)
        # 円形アバター (最初のブロックの上端に合わせる)
        av = ImageOps.fit(item["avatar"].convert("RGB"), (avatar_size, avatar_size), Image.LANCZOS)
        circle = Image.new("L", (avatar_size, avatar_size), 0)
        ImageDraw.Draw(circle).ellipse([0, 0, avatar_size, avatar_size], fill=255)
        img.paste(av, (av_x, content_top), circle)
        d = ImageDraw.Draw(img)

        by = content_top
        last_geo = None
        for block in blocks:
            bw, bh = block["w"], block["h"]
            if item["right"]:
                bx = content_right - bw
            else:
                bx = content_left
            if block["kind"] == "bubble":
                d.rounded_rectangle(
                    [bx, by, bx + bw, by + bh], radius=18,
                    fill=green if item["right"] else (255, 255, 255),
                )
                ty = by + 15
                if block["rich_lines"] is not None:
                    for line_atoms in block["rich_lines"]:
                        if line_atoms:
                            d = _miq_line_draw_atoms(
                                img, d, bx + 22, ty, line_atoms, font_size, chain, emoji_path, ink,
                            )
                        ty += lh
                else:
                    for line in block["str_lines"] or []:
                        if line:
                            d.text((bx + 22, ty), line, font=font, fill=ink)
                        ty += lh
            elif block["kind"] == "image":
                media = block["media"].resize((bw, bh), Image.LANCZOS)
                mask = Image.new("L", (bw, bh), 0)
                ImageDraw.Draw(mask).rounded_rectangle([0, 0, bw, bh], radius=16, fill=255)
                img.paste(media, (bx, by), mask)
                d = ImageDraw.Draw(img)
            else:  # sticker: バブルなしでそのまま貼る
                media = block["media"].resize((bw, bh), Image.LANCZOS)
                img.paste(media, (bx, by), media)
                d = ImageDraw.Draw(img)
            last_geo = (bx, by, bw, bh)
            by += bh + block_gap
        # 時刻は最後のブロックに付ける
        if last_geo is not None:
            bx, byy, bw, bh = last_geo
            if item["right"]:
                meta_y = byy + bh - 40
                d.text((bx - 10, meta_y), "既読", font=meta_font, fill=sub, anchor="ra")
                d.text((bx - 10, meta_y + 20), item["time"], font=meta_font, fill=sub, anchor="ra")
            else:
                d.text((bx + bw + 10, byy + bh - 22), item["time"], font=meta_font, fill=sub)
        y += entry_h + 16
    return _miq_save_png(img)


def render_miq_pair_png(entries, *, font_path: str | None = None) -> bytes:
    """ペアハート風: ピンク地に小ハートを散らし、2人の丸アバターを大きなハートでつなぐ。

    entries は LINE風と同じ dict 形式 (name/username/text/avatar_bytes 等)。
    直近2件を使い、古い方 (返信先) が左、新しい方 (対象) が右。
    1件だけの場合は単独レイアウト (アバター中央+ハート+吹き出し中央) になる。
    テキストが空のエントリは吹き出しを省略し、アバターと名前だけ描く。
    """
    from PIL import Image, ImageDraw, ImageFilter, ImageOps

    W, H = MIQ_NEW_W, MIQ_NEW_H
    items = list(entries or [])[-2:]

    # 背景: ピンクの縦グラデーション
    grad = Image.new("RGB", (1, H))
    for yy in range(H):
        grad.putpixel((0, yy), _miq_mix((253, 221, 234), (247, 178, 205), yy / max(1, H - 1)))
    img = grad.resize((W, H))

    # 小さなハートを散らす (本文から決定的に)
    seed_text = "".join(str(_miq_line_field(e, "text") or "") for e in items)
    hearts = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    hd = ImageDraw.Draw(hearts)
    hrng = _miq_rng(seed_text, "pair-hearts")
    for _ in range(30):
        hx, hy = hrng.randrange(20, W - 20), hrng.randrange(16, H - 16)
        hs = hrng.choice((13, 18, 24, 30))
        hc = hrng.choice(((244, 114, 182, 110), (249, 168, 212, 130), (236, 72, 153, 80), (255, 255, 255, 120)))
        _miq_heart(hd, hx, hy, hs, hc)
    img = Image.alpha_composite(img.convert("RGBA"), hearts).convert("RGB")
    d = ImageDraw.Draw(img)

    pink = (219, 39, 119)
    ink = (74, 34, 54)
    sub = (156, 110, 130)

    def draw_person(cx: int, cy: int, size: int, entry):
        """丸アバター (白リング) + 名前 (ピンク) + @ID を (cx, cy) 中心に描く。"""
        d.ellipse([cx - size // 2 - 8, cy - size // 2 - 8, cx + size // 2 + 8, cy + size // 2 + 8], fill=(255, 255, 255))
        av_img = _miq_line_avatar_image(entry)
        av = ImageOps.fit(av_img.convert("RGB"), (size, size), Image.LANCZOS)
        circle = Image.new("L", (size, size), 0)
        ImageDraw.Draw(circle).ellipse([0, 0, size, size], fill=255)
        img.paste(av, (cx - size // 2, cy - size // 2), circle)
        name_font = _miq_load_font(font_path, 30)
        shown = _miq_display_text(_miq_line_field(entry, "name") or "") or "unknown"
        shown = _miq_truncate(d, shown, name_font, 330)
        d.text((cx, cy + size // 2 + 18), shown, font=name_font, fill=pink, anchor="ma",
               stroke_width=1, stroke_fill=pink)
        user = _miq_display_text(_miq_line_field(entry, "username") or "")
        if user:
            d.text((cx, cy + size // 2 + 58), f"@{user}", font=_miq_load_font(font_path, 21), fill=sub, anchor="ma")

    def draw_heart(cx: int, cy: int, size: int):
        """大きなピンクハート (白ハート内包+白いグロー) を描く。"""
        # ぼかしで縁に黒が混ざらないよう、透過部分も白で塗っておく
        layer = Image.new("RGBA", (W, H), (255, 255, 255, 0))
        _miq_heart(ImageDraw.Draw(layer), cx, cy, int(size * 1.22), (255, 255, 255, 235))
        glow = layer.filter(ImageFilter.GaussianBlur(13))
        base = Image.alpha_composite(img.convert("RGBA"), glow)
        base = Image.alpha_composite(base, glow)
        dd = ImageDraw.Draw(base)
        _miq_heart(dd, cx, cy, size, (236, 64, 122))
        _miq_heart(dd, cx - size * 0.16, cy - size * 0.14, size * 0.38, (255, 255, 255))
        return base.convert("RGB")

    def draw_bubble(box, entry):
        """白いピル型吹き出しに本文を中央揃えで描く。テキストが無ければ描かない。"""
        text = str(_miq_line_field(entry, "text") or "")
        if not text.strip():
            return
        d.rounded_rectangle(box, radius=44, fill=(255, 255, 255))
        lines, lh, _size = _miq_fit_units(
            d, text, font_path, box[2] - box[0] - 76, box[3] - box[1] - 30,
            max_size=34, min_size=16,
        )
        cx = (box[0] + box[2]) // 2
        ty = (box[1] + box[3]) // 2 - (len(lines) * lh) // 2
        for line in lines:
            if line:
                _miq_draw_centered(img, d, cx, ty, "".join(u for u, _w in line), _size, ink, 0, font_path)
            ty += lh

    if len(items) >= 2:
        left, right = items[0], items[1]
        draw_person(300, 196, 190, left)
        draw_person(900, 196, 190, right)
        img = draw_heart(600, 208, 235)
        d = ImageDraw.Draw(img)
        draw_bubble([56, 452, 566, 586], left)
        draw_bubble([634, 452, 1144, 586], right)
    elif items:
        entry = items[0]
        draw_person(600, 190, 200, entry)
        img = draw_heart(806, 118, 118)
        d = ImageDraw.Draw(img)
        draw_bubble([250, 452, 950, 586], entry)
    return _miq_save_png(img)


async def miq_collect_line_chain(message, *, max_messages: int = MIQ_LINE_MAX_MESSAGES, channel_resolver=None) -> list:
    """対象メッセージから reference を辿り、時系列順 (古い→新しい) のチェーンを返す。

    対象を含めて最大 max_messages 件。解決できない参照では静かに打ち切る。
    channel_resolver は channel_id -> channel の callable (無ければ対象と同じチャンネルを使う)。
    """
    chain: list = []
    seen: set = set()
    current = message
    while current is not None and len(chain) < max_messages:
        mid = getattr(current, "id", None)
        if mid is not None:
            if mid in seen:
                break
            seen.add(mid)
        chain.append(current)
        if len(chain) >= max_messages:
            break
        ref = getattr(current, "reference", None)
        if ref is None:
            break
        ref_id = getattr(ref, "message_id", None)
        if ref_id is None or ref_id in seen:
            break
        resolved = getattr(ref, "resolved", None)
        nxt = None
        if resolved is not None and getattr(resolved, "id", None) is not None and (
            isinstance(resolved, discord.Message)
            or (hasattr(resolved, "author") and hasattr(resolved, "content"))
        ):
            nxt = resolved
        else:
            channel = None
            channel_id = getattr(ref, "channel_id", None)
            if channel_resolver is not None and channel_id is not None:
                try:
                    channel = channel_resolver(channel_id)
                except Exception:
                    logger.debug("MIQ: 返信チェーンのチャンネル解決に失敗しました", exc_info=True)
                    channel = None
            if channel is None:
                channel = getattr(current, "channel", None)
            if channel is None or not hasattr(channel, "fetch_message"):
                break
            try:
                nxt = await channel.fetch_message(ref_id)
            except discord.HTTPException:
                logger.debug("MIQ: 返信チェーンの取得に失敗しました", exc_info=True)
                break
        current = nxt
    chain.reverse()
    return chain


# ------------------------------------------------------------
# LINE風: メッセージからメディア/絵文字セグメントを取り出す補助
# ------------------------------------------------------------
_MIQ_CUSTOM_EMOJI_TOKEN = re.compile(r"<(a?):(\w+):(\d+)>")


def _miq_line_split_segments(raw: str, emoji_images: dict) -> list:
    """生の content をテキスト/カスタム絵文字のセグメント列に切り分ける。

    emoji_images は {emoji_id: bytes|None}。取得できなかった絵文字は
    :name: のテキスト表示にフォールバックする。
    """
    raw = raw or ""
    segments: list = []
    pos = 0
    for m in _MIQ_CUSTOM_EMOJI_TOKEN.finditer(raw):
        if m.start() > pos:
            segments.append({"type": "text", "text": raw[pos:m.start()]})
        eid = int(m.group(3))
        img = (emoji_images or {}).get(eid)
        if img:
            segments.append({"type": "emoji", "name": m.group(2), "image": img})
        else:
            segments.append({"type": "text", "text": f":{m.group(2)}:"})
        pos = m.end()
    if pos < len(raw):
        segments.append({"type": "text", "text": raw[pos:]})
    return segments


# ------------------------------------------------------------
# meme 作成 (画像 + 上下テキスト)。出力は常に PNG
# ------------------------------------------------------------


class MiqLineMixin:
    """GeneralCog の一部。cogs/general.py で合成される。"""

    async def _miq_render_line_file(self, entries: list, prefs: dict) -> discord.File | None:
        """LINE風エントリ (dict のリスト) から discord.File を作る。"""
        opts = miq_render_options(prefs, self.bot.user)
        try:
            async with self._levelup_sem:
                data = await asyncio.to_thread(render_miq_line_png, entries, font_path=opts.get("font_path"))
                data = await asyncio.to_thread(apply_ago_overlay, data)
            return discord.File(io.BytesIO(data), filename="quote-line.png")
        except ImportError:
            self._miq_pillow_missing()
        except Exception:
            logger.exception("MIQ: LINE風引用画像の生成に失敗しました")
        return None


    async def _miq_render_pair_file(self, entries: list, prefs: dict) -> discord.File | None:
        """ペアハート風エントリ (dict のリスト) から discord.File を作る。"""
        opts = miq_render_options(prefs, self.bot.user)
        try:
            async with self._levelup_sem:
                data = await asyncio.to_thread(render_miq_pair_png, entries, font_path=opts.get("font_path"))
                data = await asyncio.to_thread(apply_ago_overlay, data)
            return discord.File(io.BytesIO(data), filename="quote-pair.png")
        except ImportError:
            self._miq_pillow_missing()
        except Exception:
            logger.exception("MIQ: ペアハート風引用画像の生成に失敗しました")
        return None


    async def _miq_line_segments_for(self, msg, emoji_cache: dict, limit: int) -> list:
        """メッセージの生 content から LINE風用セグメント列を作る。

        メンションは表示名に置き換え、カスタム絵文字は CDN から取得して
        画像セグメントにする (取得失敗時は :name: 表示)。絵文字の取得は
        emoji_cache でチェーン全体を通して1回だけにする。
        """
        raw = getattr(msg, "content", "") or ""
        for user in getattr(msg, "mentions", None) or []:
            uname = getattr(user, "display_name", None) or getattr(user, "name", "") or ""
            raw = raw.replace(f"<@{user.id}>", f"@{uname}").replace(f"<@!{user.id}>", f"@{uname}")
        raw = re.sub(r"<@&?\d+>", "", raw)
        raw = re.sub(r"<#\d+>", "", raw)
        for m in _MIQ_CUSTOM_EMOJI_TOKEN.finditer(raw):
            eid = int(m.group(3))
            if eid not in emoji_cache:
                ext = "gif" if m.group(1) else "png"
                emoji_cache[eid] = await self._meme_fetch_url_image(
                    f"https://cdn.discordapp.com/emojis/{eid}.{ext}?size=64", limit,
                )
        return _miq_line_split_segments(raw, emoji_cache)


    async def _miq_line_image_bytes_for(self, msg, limit: int) -> list:
        """メッセージの添付画像 (最大 MIQ_LINE_MAX_IMAGES 枚) のバイト列を返す。"""
        out: list = []
        for att in getattr(msg, "attachments", None) or []:
            if len(out) >= MIQ_LINE_MAX_IMAGES:
                break
            if not _miq_is_image_attachment(att):
                continue
            if getattr(att, "size", 0) and att.size > limit:
                continue
            try:
                data = await att.read()
            except Exception:
                logger.debug("MIQ: LINE写真の取得に失敗しました", exc_info=True)
                continue
            if data and len(data) <= limit:
                out.append(data)
        return out


    async def _miq_line_sticker_bytes_for(self, msg, limit: int) -> list:
        """メッセージのスタンプ (画像形式のみ。Lottieは対象外) のバイト列を返す。"""
        out: list = []
        for sticker in getattr(msg, "stickers", None) or []:
            if not _miq_sticker_renderable(sticker):
                continue
            url = getattr(sticker, "url", None)
            if not url:
                continue
            data = await self._meme_fetch_url_image(url, limit)
            if data:
                out.append(data)
        return out


    async def _miq_build_line_file(
        self, chain_messages: list, prefs: dict, size_limit: int | None = None,
    ) -> discord.File | None:
        """返信チェーンのメッセージ群から LINE風の引用画像を作る。

        テキスト・絵文字・写真・スタンプのいずれも無い要素は除外する。
        アバターは作者ごとに1回だけ取得する。
        """
        limit = min(int(size_limit or MEME_MAX_IMAGE_BYTES), MEME_MAX_IMAGE_BYTES)
        entries: list = []
        avatar_cache: dict = {}
        emoji_cache: dict = {}
        for msg in chain_messages:
            segments = await self._miq_line_segments_for(msg, emoji_cache, limit)
            images = await self._miq_line_image_bytes_for(msg, limit)
            stickers = await self._miq_line_sticker_bytes_for(msg, limit)
            text = _miq_clean_text("".join(
                seg.get("text", "") if seg.get("type") == "text" else f":{seg.get('name') or 'emoji'}:"
                for seg in segments
            ))
            has_emoji_image = any(
                seg.get("type") == "emoji" and seg.get("image") for seg in segments
            )
            if not text and not has_emoji_image and not images and not stickers:
                continue
            author = getattr(msg, "author", None)
            author_key = getattr(author, "id", None)
            if author_key not in avatar_cache:
                avatar_cache[author_key] = (
                    await self._miq_fetch_avatar_bytes(author, size=128) if author is not None else None
                )
            entries.append({
                "name": getattr(author, "display_name", None) or getattr(author, "name", "") or "",
                "text": text,
                "created_at": getattr(msg, "created_at", None),
                "avatar_bytes": avatar_cache[author_key],
                "author_key": author_key,
                "segments": segments,
                "images": images,
                "stickers": stickers,
            })
        if not entries:
            return None
        return await self._miq_render_line_file(entries, prefs)


    async def _miq_build_pair_file(
        self, chain_messages: list, prefs: dict, size_limit: int | None = None,
    ) -> discord.File | None:
        """返信チェーンの直近2件からペアハート風の引用画像を作る。

        古い方 (返信先) が左、新しい方 (対象) が右。チェーンが1件だけなら
        単独レイアウトになる。アバターは作者ごとに1回だけ取得する。
        """
        entries: list = []
        avatar_cache: dict = {}
        emoji_cache: dict = {}
        limit = min(int(size_limit or MEME_MAX_IMAGE_BYTES), MEME_MAX_IMAGE_BYTES)
        for msg in chain_messages:
            segments = await self._miq_line_segments_for(msg, emoji_cache, limit)
            text = _miq_clean_text("".join(
                seg.get("text", "") if seg.get("type") == "text" else f":{seg.get('name') or 'emoji'}:"
                for seg in segments
            ))
            author = getattr(msg, "author", None)
            author_key = getattr(author, "id", None)
            if author_key not in avatar_cache:
                avatar_cache[author_key] = (
                    await self._miq_fetch_avatar_bytes(author, size=256) if author is not None else None
                )
            entries.append({
                "name": getattr(author, "display_name", None) or getattr(author, "name", "") or "",
                "username": getattr(author, "name", "") or "",
                "text": text,
                "created_at": getattr(msg, "created_at", None),
                "avatar_bytes": avatar_cache[author_key],
                "author_key": author_key,
            })
        entries = entries[-2:]
        if not entries:
            return None
        return await self._miq_render_pair_file(entries, prefs)


    async def _miq_build_file(
        self, author, text: str, prefs: dict, size_limit: int | None,
        *, created_at=None,
    ) -> discord.File | None:
        """引用画像を作って discord.File にする。prefs は引用を作る人(要求者)の設定。"""
        opts = miq_render_options(prefs, self.bot.user)
        # ランダムはここで生成ごとに1回だけ実フォーマットへ解決する
        fmt = miq_resolve_format(opts.pop("format", "quote"))
        name = getattr(author, "display_name", None) or getattr(author, "name", "") or ""
        username = getattr(author, "name", "") or ""
        avatar_bytes, animated = None, False
        try:
            asset = author.display_avatar
            # 新フォーマットは PNG 固定なので GIF アイコンでも静止画で取得する
            animated = bool(prefs.get("gif") and fmt == "quote" and asset.is_animated())
            if animated:
                avatar_bytes = await asset.replace(size=256, format="gif").read()
            else:
                avatar_bytes = await asset.replace(size=512, format="png").read()
        except Exception:
            animated = False
            logger.debug("MIQ: アイコンの取得に失敗 (user=%s)", getattr(author, "id", "?"), exc_info=True)
        try:
            async with self._levelup_sem:
                if fmt == "line":
                    # チェーンが無い単体呼び出し (プレビュー等) は1件のLINE風にする
                    entries = [{
                        "name": name, "text": text,
                        "created_at": datetime.now(timezone.utc),
                        "avatar_bytes": avatar_bytes,
                        "author_key": getattr(author, "id", None),
                    }]
                    data = await asyncio.to_thread(
                        render_miq_line_png, entries, font_path=opts.get("font_path"),
                    )
                    data = await asyncio.to_thread(apply_ago_overlay, data)
                    return discord.File(io.BytesIO(data), filename="quote-line.png")
                if fmt == "pair":
                    # チェーンが無い単体呼び出し (プレビュー等) は1件の単独レイアウトにする
                    entries = [{
                        "name": name, "username": username, "text": text,
                        "avatar_bytes": avatar_bytes,
                        "author_key": getattr(author, "id", None),
                    }]
                    data = await asyncio.to_thread(
                        render_miq_pair_png, entries, font_path=opts.get("font_path"),
                    )
                    data = await asyncio.to_thread(apply_ago_overlay, data)
                    return discord.File(io.BytesIO(data), filename="quote-pair.png")
                renderer = _MIQ_FORMAT_RENDERERS.get(fmt)
                if renderer is not None:
                    kwargs = {"font_path": opts.get("font_path")}
                    if fmt in _MIQ_DATED_FORMATS:
                        # 日付を使うフォーマットには対象メッセージの作成日 (JST) を渡す
                        kwargs["date_str"] = _miq_date_str(created_at)
                    data = await asyncio.to_thread(
                        renderer, avatar_bytes, text, name, username, **kwargs,
                    )
                    data = await asyncio.to_thread(apply_ago_overlay, data)
                    return discord.File(io.BytesIO(data), filename="quote.png")
                if animated:
                    limit = int((size_limit or 8 * 1024 * 1024) * 0.9)
                    data = await asyncio.to_thread(
                        render_miq_gif, avatar_bytes, text, name, username, max_bytes=limit, **opts,
                    )
                    if len(data) <= limit:
                        return discord.File(io.BytesIO(data), filename="quote.gif")
                    # 上限超過ならPNG(アイコンの1コマ目)にフォールバック
                data = await asyncio.to_thread(render_miq_png, avatar_bytes, text, name, username, **opts)
                data = await asyncio.to_thread(apply_ago_overlay, data)
            return discord.File(io.BytesIO(data), filename="quote.png")
        except ImportError:
            self._miq_pillow_missing()
        except Exception:
            logger.exception("MIQ: 引用画像の生成に失敗しました")
        return None


    def _miq_line_channel_resolver(self, channel_id):
        bot = getattr(self, "bot", None)
        if bot is None:
            return None
        try:
            return bot.get_channel(channel_id)
        except Exception:
            logger.debug("MIQ: チャンネルの解決に失敗しました", exc_info=True)
            return None


    async def _miq_line_file_for(
        self, target, requester_id: int, prefs: dict, size_limit: int | None,
    ) -> tuple[discord.File | None, bool]:
        """LINE風: チェーンを収集し、全作者の引用拒否を確認してから生成する。

        戻り値 (file, refused)。refused=True の時は拒否により中止したことを表す。
        """
        chain = await miq_collect_line_chain(
            target, channel_resolver=self._miq_line_channel_resolver,
        )
        for chained in chain:
            chained_author = getattr(chained, "author", None)
            chained_id = getattr(chained_author, "id", None)
            if chained_id is not None and chained_id != requester_id and miq_is_refusing(chained_id):
                return None, True
        file = await self._miq_build_line_file(chain, prefs, size_limit)
        return file, False


    async def _miq_pair_file_for(
        self, target, requester_id: int, prefs: dict, size_limit: int | None,
    ) -> tuple[discord.File | None, bool]:
        """ペアハート風: LINE風と同じくチェーンを収集し、全作者の引用拒否を確認してから生成する。

        戻り値 (file, refused)。refused=True の時は拒否により中止したことを表す。
        """
        chain = await miq_collect_line_chain(
            target, channel_resolver=self._miq_line_channel_resolver,
        )
        for chained in chain:
            chained_author = getattr(chained, "author", None)
            chained_id = getattr(chained_author, "id", None)
            if chained_id is not None and chained_id != requester_id and miq_is_refusing(chained_id):
                return None, True
        file = await self._miq_build_pair_file(chain, prefs, size_limit)
        return file, False
