# -*- coding: utf-8 -*-
"""MIQ（引用画像）の中核：フォント解決・絵文字フォールバック・基本描画・設定保存。元 cogs/general.py から分割。"""
from __future__ import annotations
from core.support.emojis import AGO_TICKET, BOOK, DICE, GAME, MUSIC

from ..common import *
from ..exp.levelup import _levelup_font, _levelup_pick_font, _levelup_safe_name

MIQ_W, MIQ_H = 1200, 630
MIQ_NEW_W, MIQ_NEW_H = 1200, 675  # 新フォーマット(漫画風/音楽再生風/LINE風)のサイズ
MIQ_MAX_CHARS = 400
MIQ_COOLDOWN = 3.0
MIQ_GIF_MAX_FRAMES = 24
# LINE風で遡れる件数(対象メッセージを含む)
MIQ_LINE_MAX_MESSAGES = 4
# LINE風で1メッセージに合成する写真の最大枚数
MIQ_LINE_MAX_IMAGES = 2

# format -> (表示名, 絵文字)。quote が従来の引用画像。
# random は保存値としての仮想フォーマットで、生成ごとに MIQ_RANDOM_POOL から
# 実フォーマットを1つ選ぶ。未設定ユーザーの既定も random。
MIQ_FORMATS = {
    "random": ("ランダム", DICE),
    "quote": ("引用 (従来)", "🖼️"),
    "manga": ("漫画風", "💥"),
    "music": ("音楽再生風", MUSIC),
    "line": ("LINE風", "💬"),
    "news": ("ニュース速報風", "📺"),
    "xpost": ("X投稿風", "🐦"),
    "rpg": ("RPG風", GAME),
    "blueprint": ("設計図風", "📐"),
    "pixel": ("レトロゲーム風", "👾"),
    "card": ("トレカ風", "🎴"),
    "neon": ("ネオン風", "🌃"),
    "dark": ("ダーク風", "🎬"),
    "pop": ("ポップ風", "💛"),
    "pastel": ("パステル風", "🌸"),
    "ticket": ("チケット風", AGO_TICKET),
    "note": ("ノート風", "📓"),
    "pair": ("ペアハート風", "💞"),
    "versus": ("VS対決風", "⚔️"),
    "luxury": ("ゴールド縦書き風", "👑"),
    "tate": ("和風縦書き風", "🎋"),
    "novel": ("小説風", BOOK),
    "glass": ("グラスカード風", "💠"),
}

# ランダムで選ばれる単体メッセージ系フォーマット。
# line / pair / versus (返信チェーン前提) と random 自身は絶対に含めない。
MIQ_RANDOM_POOL = (
    "quote", "manga", "music", "news", "xpost", "rpg",
    "blueprint", "pixel", "card", "neon", "dark", "pop", "pastel", "ticket", "note",
    "luxury", "tate", "novel", "glass",
)


def miq_resolve_format(prefs_or_format) -> str:
    """保存値 (prefs dict または format 文字列) を実フォーマットに解決する。

    "random" なら MIQ_RANDOM_POOL から1つ選ぶ (line は選ばれない)。
    それ以外はそのまま返し、不正値は "quote" にフォールバックする。
    生成経路ごとに1回だけ呼ぶこと。
    """
    fmt = prefs_or_format.get("format") if isinstance(prefs_or_format, dict) else prefs_or_format
    if fmt == "random":
        return random.choice(MIQ_RANDOM_POOL)
    if fmt in MIQ_FORMATS and fmt != "random":
        return fmt
    return "quote"

def _miq_repo_root() -> Path:
    """リポジトリルートを返す。

    同梱フォント (font.ttf) と assets/fonts/ の両方を持つ最下位の祖先を
    ルートとみなす。モジュールをサブパッケージへ移しても __file__ 起点の
    相対パスがずれないようにするための解決で、見つからなければ現在の
    配置 (core/general/miq/ から3つ上) を前提にフォールバックする。
    """
    here = Path(__file__).resolve()
    for anc in here.parents:
        if (anc / "font.ttf").is_file() and (anc / "assets" / "fonts").is_dir():
            return anc
    return here.parents[3]


_MIQ_REPO_ROOT = _miq_repo_root()
_MIQ_ASSET_FONTS = _MIQ_REPO_ROOT / "assets" / "fonts"


def _miq_af(name: str) -> str:
    return str(_MIQ_ASSET_FONTS / name)


# (key, 表示名, 探索パス)。見つかったものだけが選択肢に出る。
# assets/fonts/ に置くか、環境変数 MIQ_FONT_<KEY大文字> でパスを指定できる。
# 注意: このPRで assets/fonts/ を新設する。ユーザーが後からフォントを
# assets/fonts/ に入れると、_miq_discover_asset_fonts() がファイル名から
# 自動で選択肢にするため、ここへの追加は必須ではない。
# リポジトリ同梱の font.ttf (Hachi Maru Pop、日本語対応) を最後の選択肢
# として必ず探索する。これにより、OSに日本語フォントが無くても MIQ が
# 欧文フォントにフォールバックして日本語が □ になることがなくなる。
_MIQ_REPO_FONT = str(_MIQ_REPO_ROOT / "font.ttf")
_MIQ_FONT_DEFS = (
    ("mplus", "M PLUS Rounded 1c", (
        os.getenv("MIQ_FONT_MPLUS") or "",
        _miq_af("MPLUSRounded1c-Medium.ttf"), _miq_af("MPLUSRounded1c-Regular.ttf"),
        _miq_af("MPLUSRounded1c-Bold.ttf"), _miq_af("mplus.ttf"),
        "/usr/share/fonts/truetype/mplus/MPLUSRounded1c-Medium.ttf",
        "/usr/share/fonts/truetype/mplus/MPLUSRounded1c-Regular.ttf",
        "/usr/share/fonts/truetype/google-fonts/MPLUSRounded1c-Medium.ttf",
        "C:/Windows/Fonts/MPLUSRounded1c-Medium.ttf",
        os.path.expandvars("%LOCALAPPDATA%/Microsoft/Windows/Fonts/MPLUSRounded1c-Medium.ttf"),
        os.path.expanduser("~/.local/share/fonts/MPLUSRounded1c-Medium.ttf"),
    )),
    ("notosans", "Noto Sans JP", (
        os.getenv("MIQ_FONT_NOTOSANS") or "",
        _miq_af("NotoSansJP-Regular.ttf"), _miq_af("NotoSansJP-Medium.ttf"), _miq_af("NotoSansJP[wght].ttf"),
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/google-noto-cjk/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/opentype/noto/NotoSansCJKjp-Regular.otf",
    )),
    ("notoserif", "Noto Serif JP", (
        os.getenv("MIQ_FONT_NOTOSERIF") or "",
        _miq_af("NotoSerifJP-Regular.ttf"), _miq_af("NotoSerifJP-Medium.ttf"), _miq_af("NotoSerifJP[wght].ttf"),
        "/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc",
        "/usr/share/fonts/opentype/noto/NotoSerifCJK-Bold.ttc",
        "/usr/share/fonts/truetype/noto/NotoSerifCJK-Regular.ttc",
        "/usr/share/fonts/noto-cjk/NotoSerifCJK-Regular.ttc",
        "/usr/share/fonts/opentype/noto/NotoSerifCJKjp-Regular.otf",
    )),
    ("yugothic", "游ゴシック", (
        "C:/Windows/Fonts/YuGothM.ttc", "C:/Windows/Fonts/YuGothR.ttc",
        "/System/Library/Fonts/Supplemental/YuGothic.ttc",
    )),
    ("meiryo", "メイリオ", ("C:/Windows/Fonts/meiryo.ttc",)),
    ("hiragino", "ヒラギノ角ゴ", (
        "/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc",
        "/System/Library/Fonts/ヒラギノ角ゴシック W6.ttc",
    )),
    ("hachi", "Hachi Maru Pop (リポジトリ同梱)", (
        os.getenv("MIQ_FONT_HACHI") or "",
        _MIQ_REPO_FONT,
    )),
)

# key -> (表示名, 絵文字, 背景色, 文字色)
MIQ_THEMES = {
    "bw": ("Black/White (default)", "🖤", (0, 0, 0), (255, 255, 255)),
    "wb": ("White/Black", "🤍", (255, 255, 255), (0, 0, 0)),
    "navy": ("Navy/Ice", "💙", (9, 16, 38), (214, 232, 255)),
    "rose": ("Wine/Rose", "❤️", (46, 8, 20), (255, 224, 232)),
    "forest": ("Forest/Mint", "💚", (8, 30, 22), (212, 255, 232)),
    "sepia": ("Paper/Brown", "🤎", (244, 235, 214), (62, 42, 22)),
}

_MIQ_FONTS_CACHE: list[tuple[str, str, str | None]] | None = None

_MIQ_JP_PROBE = "あア漢字かなカナ、。ー"


def _font_covers_japanese(path: str) -> bool:
    """フォントが日本語の基本字形を持つか。読み込めるだけでは □ にならない。

    fontTools が無い環境では判定できないため True を返し、従来動作を保つ。
    matplotlib 経由などで fontTools が入っている環境では厳密に判定する。
    """
    try:
        from fontTools.ttLib import TTFont
    except Exception:
        return True
    try:
        try:
            font = TTFont(path)
            cmap = font.getBestCmap()
        except Exception:
            from fontTools.ttLib import TTCollection

            cmap = TTCollection(path).fonts[0].getBestCmap()
        return all(ord(ch) in cmap for ch in _MIQ_JP_PROBE)
    except Exception:
        return False


def _miq_discover_asset_fonts() -> list[tuple[str, str, str]]:
    """assets/fonts/ に置かれたフォントを自動で選択肢にする。

    ユーザーが後からフォントファイル (.ttf/.otf/.ttc) を assets/fonts/ に
    入れるだけで、コードを変更しなくても MIQ のフォント選択肢に出る。
    ファイル名がそのまま表示名になり、キーはファイル名から作る。
    日本語非対応のファイルは □ 防止のため除外する。
    """
    from PIL import ImageFont

    if not _MIQ_ASSET_FONTS.is_dir():
        return []
    discovered: list[tuple[str, str, str]] = []
    for entry in sorted(_MIQ_ASSET_FONTS.iterdir(), key=lambda p: p.name.lower()):
        if not entry.is_file() or entry.suffix.lower() not in (".ttf", ".otf", ".ttc"):
            continue
        path = str(entry)
        try:
            ImageFont.truetype(path, 20)
        except Exception:
            logger.debug("MIQ: フォント探索中の読み込みに失敗しました", exc_info=True)
            continue
        if not _font_covers_japanese(path):
            continue
        key = re.sub(r"[^a-z0-9]+", "_", entry.stem.lower()).strip("_") or "asset"
        discovered.append((key, entry.stem, path))
    return discovered


def _miq_available_fonts() -> list[tuple[str, str, str | None]]:
    """利用可能なフォント [(key, label, path)] を返す(初回のみ探索)。常に1件以上返る。

    以前は「Pillowで読み込めるか」だけで選んでいたため、日本語非対応の
    フォントが選ばれて □ になることがあった。今は日本語対応も確認する。
    assets/fonts/ に置かれたフォントは、上の _MIQ_FONT_DEFS に無くても
    自動で選択肢に加わる。
    """
    global _MIQ_FONTS_CACHE
    if _MIQ_FONTS_CACHE is not None:
        return _MIQ_FONTS_CACHE
    from PIL import ImageFont

    found: list[tuple[str, str, str | None]] = []
    for key, label, paths in _MIQ_FONT_DEFS:
        for path in paths:
            if not path or not os.path.exists(path):
                continue
            try:
                ImageFont.truetype(path, 20)
            except Exception:
                logger.debug("MIQ: フォント候補の読み込みに失敗しました", exc_info=True)
                continue
            if not _font_covers_japanese(path):
                continue
            found.append((key, label, path))
            break
    # assets/fonts/ に後から入れられたフォントを自動で追加する。
    # 既存の選択肢とパスが重複するものは二重に出さない。
    _seen_paths = {path for _k, _l, path in found if path}
    _seen_keys = {key for key, _l, _p in found}
    for key, label, path in _miq_discover_asset_fonts():
        if path in _seen_paths or key in _seen_keys:
            continue
        found.append((key, label, path))
        _seen_paths.add(path)
        _seen_keys.add(key)
    if not found:
        # 最後の砦はリポジトリ同梱の日本語フォント。欧文フォントへの
        # フォールバックは日本語を □ にするため、ここでは使わない。
        repo = _MIQ_REPO_FONT
        if repo and os.path.exists(repo):
            try:
                ImageFont.truetype(repo, 20)
                if _font_covers_japanese(repo):
                    found.append(("hachi", "Hachi Maru Pop (リポジトリ同梱)", repo))
            except Exception:
                logger.debug("MIQ: フォント情報の読み込みに失敗しました", exc_info=True)
    if not found:
        found.append(("default", "Default", _levelup_pick_font()[0]))
    _MIQ_FONTS_CACHE = found
    return found


def _miq_load_font(path: str | None, size: int):
    from PIL import ImageFont

    if path:
        try:
            return ImageFont.truetype(path, size)
        except Exception:
            logger.debug("MIQ: フォントの読み込みに失敗しました", exc_info=True)
    return _levelup_font(size)


# ---- MIQ: 文字ごとのフォールバック描画（絵文字・記号対応） ----
# 単一フォントで描くと、選択フォントに無い文字（記号・絵文字・珍しい漢字）は
# □ になる。そこで本文・名前は文字ごとに「その文字を持つフォント」を探して描く。
# 絵文字は Noto Color Emoji だけが特殊（Pillow では size=109 でしか読めない
# ビットマップフォント）なので、109px で描いてから文字サイズへ縮小して貼る。
_MIQ_EMOJI_SIZE = 109
_MIQ_EMOJI_PATHS = (
    "assets/fonts/NotoColorEmoji.ttf",
    "assets/fonts/emoji.ttf",
    "/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf",
    "/usr/share/fonts/truetype/noto/NotoColorEmoji-Regular.ttf",
)
_MIQ_SYMBOL_PATHS = (
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/noto/NotoSansSymbols-Regular.ttf",
    "/usr/share/fonts/truetype/noto/NotoSansSymbols2-Regular.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
)
_MIQ_FONT_CMAP_CACHE: dict = {}
_MIQ_FONT_OBJ_CACHE: dict = {}
_MIQ_EMOJI_PATH_CACHE = None


def _miq_emoji_font_path() -> str | None:
    global _MIQ_EMOJI_PATH_CACHE
    if _MIQ_EMOJI_PATH_CACHE is not None:
        return _MIQ_EMOJI_PATH_CACHE
    _MIQ_EMOJI_PATH_CACHE = ""
    root = _MIQ_REPO_ROOT
    for cand in _MIQ_EMOJI_PATHS:
        p = str(root / cand) if not cand.startswith("/") else cand
        if os.path.exists(p):
            try:
                from PIL import ImageFont

                ImageFont.truetype(p, _MIQ_EMOJI_SIZE)
                _MIQ_EMOJI_PATH_CACHE = p
                break
            except Exception:
                logger.debug("MIQ: 絵文字フォントの探索に失敗しました", exc_info=True)
                continue
    return _MIQ_EMOJI_PATH_CACHE or None


def _miq_font_cmap(path: str):
    if path in _MIQ_FONT_CMAP_CACHE:
        return _MIQ_FONT_CMAP_CACHE[path]
    cmap = None
    try:
        from fontTools.ttLib import TTFont

        cmap = TTFont(path).getBestCmap()
    except Exception:
        logger.debug("MIQ: フォントの cmap 取得に失敗しました", exc_info=True)
        cmap = None
    _MIQ_FONT_CMAP_CACHE[path] = cmap
    return cmap


def _miq_font_has_char(path: str, ch: str) -> bool:
    cmap = _miq_font_cmap(path)
    if cmap is None:
        return True  # fontTools が無い環境では従来通り「ある」とみなす
    return ord(ch) in cmap


def _miq_split_units(text: str) -> list[str]:
    """絵文字シーケンス（VS16・肌色・ZWJ・キーキャップ）を1単位にまとめる。"""
    units: list[str] = []
    i = 0
    n = len(text)
    while i < n:
        unit = text[i]
        i += 1
        while i < n:
            o = ord(text[i])
            if o in (0xFE0F, 0xFE0E) or 0x1F3FB <= o <= 0x1F3FF:
                unit += text[i]
                i += 1
                continue
            if o == 0x200D and i + 1 < n:
                unit += text[i] + text[i + 1]
                i += 2
                continue
            if o == 0x20E3:
                unit += text[i]
                i += 1
                break
            break
        units.append(unit)
    return units


def _miq_unit_bases(unit: str) -> str:
    """単位から修飾子（VS・ZWJ・肌色・キーキャップ）を除いた実体文字だけ返す。"""
    return "".join(
        ch
        for ch in unit
        if ord(ch) not in (0xFE0F, 0xFE0E, 0x200D, 0x20E3)
        and not 0x1F3FB <= ord(ch) <= 0x1F3FF
    )


def _miq_is_emoji_unit(unit: str, emoji_path: str | None) -> bool:
    if not emoji_path:
        return False
    bases = _miq_unit_bases(unit)
    if not bases:
        return False
    o = ord(bases[0])
    if o < 0x2000 and bases[0] not in "©®":
        return False
    return _miq_font_has_char(emoji_path, bases[0])


def _miq_fallback_fonts(primary_path: str | None, size: int):
    """本文フォント→他のMIQフォント→ルートfont.ttf→OS記号フォントの順の描画用フォント列。"""
    chain = []
    seen: set = set()

    def _add(path):
        if not path or path in seen or not os.path.exists(path):
            return
        seen.add(path)
        key = (path, size)
        font = _MIQ_FONT_OBJ_CACHE.get(key)
        if font is None:
            try:
                font = _miq_load_font(path, size)
            except Exception:
                logger.debug("MIQ: フォールバックフォントの追加に失敗しました", exc_info=True)
                return
            _MIQ_FONT_OBJ_CACHE[key] = font
        chain.append((path, font))

    _add(primary_path)
    try:
        for _k, _l, path in _miq_available_fonts():
            _add(path)
    except Exception:
        logger.debug("MIQ: フォールバックフォントの収集に失敗しました", exc_info=True)
    _add(_MIQ_REPO_FONT)
    for cand in _MIQ_SYMBOL_PATHS:
        _add(cand)
    return chain


def _miq_unit_font(unit: str, chain, emoji_path: str | None):
    """単位を描けるフォントを返す。('emoji', None) / ('font', font) / (None, None)。"""
    if _miq_is_emoji_unit(unit, emoji_path):
        return ("emoji", None)
    bases = _miq_unit_bases(unit) or unit
    for path, font in chain:
        if all(_miq_font_has_char(path, ch) for ch in bases):
            return ("font", font)
    return (None, None)


def _miq_emoji_width(unit: str, size: int, emoji_path: str) -> float:
    """カラー絵文字の実描画幅（縦横比を保って size 高さで貼ったときの幅）。"""
    try:
        from PIL import Image, ImageDraw, ImageFont

        font = ImageFont.truetype(emoji_path, _MIQ_EMOJI_SIZE)
        tmp = Image.new("RGBA", (160, 160), (0, 0, 0, 0))
        ImageDraw.Draw(tmp).text((10, 10), unit, font=font, embedded_color=True)
        bbox = tmp.getbbox()
        if not bbox:
            return float(size)
        return float(size * (bbox[2] - bbox[0]) / (bbox[3] - bbox[1]))
    except Exception:
        logger.debug("MIQ: 絵文字幅の計測に失敗しました", exc_info=True)
        return float(size)


def _miq_unit_width(unit: str, draw, chain, size: int, emoji_path: str | None) -> float:
    kind, font = _miq_unit_font(unit, chain, emoji_path)
    if kind == "emoji":
        return _miq_emoji_width(unit, size, emoji_path)
    if kind == "font":
        bases = _miq_unit_bases(unit) or unit
        try:
            return float(draw.textlength(bases, font=font))
        except Exception:
            logger.debug("MIQ: 文字幅の計測に失敗しました", exc_info=True)
            return float(size)
    return 0.0


def _miq_render_emoji_unit(layer, draw, x: float, y: float, unit: str, size: int, emoji_path: str) -> float:
    """カラー絵文字1単位を109pxで描いて size へ縮小し、(x, y)へ貼る。幅を返す。"""
    from PIL import Image, ImageDraw, ImageFont

    try:
        font = ImageFont.truetype(emoji_path, _MIQ_EMOJI_SIZE)
        tmp = Image.new("RGBA", (160, 160), (0, 0, 0, 0))
        td = ImageDraw.Draw(tmp)
        td.text((10, 10), unit, font=font, embedded_color=True)
        bbox = tmp.getbbox()
        if not bbox:
            return 0.0
        crop = tmp.crop(bbox)
        # 高さ = 文字サイズ、幅は縦横比を保つ
        w = max(1, int(round(size * crop.width / crop.height)))
        emoji_img = crop.resize((w, size), Image.LANCZOS)
        # 本文は anchor="ma"（ascender上端が y）なので、絵文字の上端を y に合わせる
        layer.paste(emoji_img, (int(round(x)), int(round(y))), emoji_img)
        return float(w)
    except Exception:
        logger.debug("MIQ: 絵文字の描画に失敗", exc_info=True)
        return 0.0


def _miq_draw_centered(layer, draw, cx: float, y: float, text: str, size: int, fill, stroke_width: int, primary_path: str | None):
    """中央揃えで1行描く。文字ごとにフォールバックし、描けない文字は落とす（□にしない）。"""
    if not text:
        return
    chain = _miq_fallback_fonts(primary_path, size)
    emoji_path = _miq_emoji_font_path()
    units = _miq_split_units(text)
    widths = []
    total = 0.0
    for unit in units:
        kind, font = _miq_unit_font(unit, chain, emoji_path)
        if kind == "emoji":
            w = _miq_emoji_width(unit, size, emoji_path)
        elif kind == "font":
            bases = _miq_unit_bases(unit) or unit
            try:
                w = float(draw.textlength(bases, font=font))
            except Exception:
                logger.debug("MIQ: 文字幅の計測に失敗しました", exc_info=True)
                w = float(size)
        else:
            w = 0.0
        widths.append(w)
        total += w
    x = cx - total / 2.0
    for unit, w in zip(units, widths):
        if w <= 0:
            continue
        kind, font = _miq_unit_font(unit, chain, emoji_path)
        if kind == "emoji":
            x += _miq_render_emoji_unit(layer, draw, x, y, unit, size, emoji_path)
        elif kind == "font":
            bases = _miq_unit_bases(unit) or unit
            draw.text((x, y), bases, font=font, fill=fill, anchor="la", stroke_width=stroke_width, stroke_fill=fill)
            x += w
        # kind is None: 描けない文字は落とす（□を出さない）


def _miq_wrap_units(draw, text, primary_path, size: int, max_w: float):
    """本文を単位 (文字/絵文字) ごとに測って max_w で折り返す。

    戻り値は [[(unit, width), ...], ...]。描けない単位 (幅0) は落とす。
    単一フォントで測る _miq_wrap では絵文字の幅を正しく測れないため、
    スタイル別レンダラの本文はこちらを使う。
    """
    chain = _miq_fallback_fonts(primary_path, size)
    emoji_path = _miq_emoji_font_path()
    lines = []
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
            if not line and unit == " ":
                continue
            line.append((unit, w))
            line_w += w
        lines.append(line)
    return [ln for ln in lines if ln]


def _miq_fit_units(draw, text, primary_path, max_w: float, max_h: float, *, max_size: int = 72, min_size: int = 22, lh_factor: float = 1.34):
    """_miq_fit の単位版。(lines, lh, size) を返す。lines は _miq_wrap_units の行列。"""
    size = max_size
    while True:
        lines = _miq_wrap_units(draw, text, primary_path, size, max_w)
        lh = int(size * lh_factor)
        if len(lines) * lh <= max_h or size <= min_size:
            break
        size -= 2
    max_lines = max(1, int(max_h // lh))
    if len(lines) > max_lines:
        lines = lines[:max_lines]
        chain = _miq_fallback_fonts(primary_path, size)
        emoji_path = _miq_emoji_font_path()
        ew = _miq_unit_width("…", draw, chain, size, emoji_path)
        last = lines[-1]
        while last and sum(w for _, w in last) + ew > max_w:
            last.pop()
        if ew > 0:
            last.append(("…", ew))
    return lines, lh, size


def _miq_draw_units_line(layer, draw, x: float, y: float, line, size: int, primary_path, fill, *, stroke_width: int = 0):
    """折り返し済みの1行 (単位列) を左揃えで描く。絵文字はカラーで合成する。"""
    chain = _miq_fallback_fonts(primary_path, size)
    emoji_path = _miq_emoji_font_path()
    cx = float(x)
    for unit, w in line:
        kind, font = _miq_unit_font(unit, chain, emoji_path)
        if kind == "emoji":
            used = _miq_render_emoji_unit(layer, draw, cx, y, unit, size, emoji_path)
            cx += used if used else w
        elif kind == "font":
            draw.text(
                (cx, y), _miq_unit_bases(unit) or unit, font=font, fill=fill,
                anchor="la", stroke_width=stroke_width, stroke_fill=fill,
            )
            cx += w
        else:
            cx += w
    return draw


def _miq_units_width(draw, text, primary_path, size: int) -> float:
    """単位幅の合計。絵文字が無ければ単一フォントの textlength と同一になるよう
    そのまま測る（レイアウト幅が従来と変わらない）。"""
    if not text:
        return 0.0
    chain = _miq_fallback_fonts(primary_path, size)
    emoji_path = _miq_emoji_font_path()
    units = _miq_split_units(text)
    if not any(_miq_is_emoji_unit(u, emoji_path) for u in units):
        try:
            return float(draw.textlength(text, font=_miq_load_font(primary_path, size)))
        except Exception:
            logger.debug("MIQ: 名前幅の計測に失敗しました", exc_info=True)
    return sum(_miq_unit_width(u, draw, chain, size, emoji_path) for u in units)


def _miq_truncate_units(draw, text, primary_path, size: int, max_w: float, *, ellipsis: bool = True) -> str:
    """_miq_truncate の単位版。絵文字の幅を正しく測り、単位単位で切る。
    絵文字が無ければ単一フォント版と同一の結果になる。"""
    if not text:
        return text
    chain = _miq_fallback_fonts(primary_path, size)
    emoji_path = _miq_emoji_font_path()
    units = _miq_split_units(text)
    if not any(_miq_is_emoji_unit(u, emoji_path) for u in units):
        font = _miq_load_font(primary_path, size)
        if draw.textlength(text, font=font) <= max_w:
            return text
        while text and draw.textlength(text + ("…" if ellipsis else ""), font=font) > max_w:
            text = text[:-1]
        return text + ("…" if ellipsis else "")
    ew = _miq_unit_width("…", draw, chain, size, emoji_path) if ellipsis else 0.0
    total = sum(_miq_unit_width(u, draw, chain, size, emoji_path) for u in units)
    if total <= max_w:
        return text
    out = []
    w = 0.0
    for unit in units:
        uw = _miq_unit_width(unit, draw, chain, size, emoji_path)
        if w + uw + ew > max_w:
            break
        out.append(unit)
        w += uw
    return "".join(out) + ("…" if ellipsis else "")


def _miq_draw_name_units(layer, draw, x: float, y: float, text: str, size: int, primary_path, fill, *, anchor="la", stroke_width=0):
    """表示名を単位ベースで描く。anchor は la/ma/mm/lm/ra。

    絵文字が無ければ単一フォント描画と同一になるよう、従来の d.text を
    そのまま使う。絵文字がある場合のみ単位ごとに描く（カラー絵文字を合成）。
    垂直 "m" はフォントボックス (ascent+descent) の中央に合わせる。
    戻り値は draw（_miq_draw_units_line と同じ流儀）。"""
    if not text:
        return draw
    chain = _miq_fallback_fonts(primary_path, size)
    emoji_path = _miq_emoji_font_path()
    units = _miq_split_units(text)
    if not any(_miq_is_emoji_unit(u, emoji_path) for u in units):
        font = _miq_load_font(primary_path, size)
        draw.text((x, y), text, font=font, fill=fill, anchor=anchor,
                  stroke_width=stroke_width, stroke_fill=fill)
        return draw
    widths = [_miq_unit_width(u, draw, chain, size, emoji_path) for u in units]
    total = sum(widths)
    h = anchor[0]
    x0 = x - total if h == "r" else x - total / 2 if h == "m" else x
    if len(anchor) > 1 and anchor[1] == "m":
        asc, desc = _miq_load_font(primary_path, size).getmetrics()
        y_top = y - (asc + desc) // 2
    else:
        y_top = y
    cx = float(x0)
    for unit, w in zip(units, widths):
        if w <= 0:
            continue
        kind, font = _miq_unit_font(unit, chain, emoji_path)
        if kind == "emoji":
            used = _miq_render_emoji_unit(layer, draw, cx, y_top, unit, size, emoji_path)
            cx += used if used else w
        elif kind == "font":
            draw.text((cx, y_top), _miq_unit_bases(unit) or unit, font=font, fill=fill,
                      anchor="la", stroke_width=stroke_width, stroke_fill=fill)
            cx += w
    return draw


def _miq_display_text(text: str | None) -> str:
    """名前・ユーザー名用：制御文字と改行だけ落とし、絵文字・記号は残す。"""
    if not text:
        return ""
    out = []
    for ch in text:
        o = ord(ch)
        if o < 0x20 or o == 0x7F:
            out.append(" ")
        else:
            out.append(ch)
    return "".join(out).strip()


_MIQ_CUSTOM_EMOJI = re.compile(r"<a?:\w+:\d+>")


def _miq_clean_text(text: str | None) -> str:
    """引用テキストを整形する。

    以前は絵文字・記号（U+1F000以上、U+2190〜U+2BFF、ZWJ、VSなど）を
    ここで落としていたため、絵文字が消え、対応フォントが無い文字は
    描画時に □ になっていた。今は落とさない。描画側が文字ごとに
    フォールバックフォント／カラー絵文字を選び、どのフォントにも
    無い文字だけを描画時に落とす（□ にはしない）。
    """
    text = _MIQ_CUSTOM_EMOJI.sub("", text or "")
    try:
        text = discord.utils.remove_markdown(text)
    except Exception:
        logger.debug("MIQ: マークダウン除去に失敗しました", exc_info=True)
    out: list[str] = []
    for ch in text:
        o = ord(ch)
        if ch == "\n":
            out.append(ch)
        elif ch == "\t" or o < 0x20:
            out.append(" ")
        elif o in (0x200B, 0xFEFF):
            continue
        else:
            out.append(ch)
    cleaned = re.sub(r"\n{3,}", "\n\n", "".join(out)).strip()
    if len(cleaned) > MIQ_MAX_CHARS:
        cleaned = cleaned[:MIQ_MAX_CHARS - 1].rstrip() + "…"
    return cleaned


_MIQ_NO_LINE_START = set("。、，．,.!?！？」』）)］]｝}ー々ゝゞぁぃぅぇぉっゃゅょァィゥェォッャュョ…・:;：；")


def _miq_wrap(draw, text: str, font, max_w: float) -> list[str]:
    """文字幅ベースの折り返し(日本語は文字単位、英数字は単語単位を優先、行頭禁則つき)。"""
    lines: list[str] = []
    for para in text.split("\n"):
        line = ""
        for ch in para:
            test = line + ch
            if not line or draw.textlength(test, font=font) <= max_w:
                line = test
                continue
            if ch in _MIQ_NO_LINE_START and len(line) > 1:
                # 行頭禁則: 直前の1文字ごと次の行へ送る(枠からはみ出さないように)
                lines.append(line[:-1].rstrip())
                line = line[-1] + ch
                continue
            prev = line[-1:]
            if ch.isascii() and ch.isalnum() and prev.isascii() and prev.isalnum() and " " in line:
                head, tail = line.rsplit(" ", 1)
                lines.append(head.rstrip())
                line = tail + ch
            else:
                lines.append(line.rstrip())
                line = ch.lstrip()
        lines.append(line.rstrip())
    return lines


def _miq_fit(draw, text: str, font_path: str | None, max_w: int, max_h: int, *, max_size: int = 72, min_size: int = 22):
    size = max_size
    while True:
        font = _miq_load_font(font_path, size)
        lines = _miq_wrap(draw, text, font, max_w)
        lh = int(size * 1.34)
        if len(lines) * lh <= max_h or size <= min_size:
            break
        size -= 2
    max_lines = max(1, max_h // lh)
    if len(lines) > max_lines:
        lines = lines[:max_lines]
        last = lines[-1]
        while last and draw.textlength(last + "…", font=font) > max_w:
            last = last[:-1]
        lines[-1] = last + "…"
    return font, lines, lh, size


def _miq_mix(a, b, t: float):
    """a に b を t の割合で混ぜる。"""
    return tuple(int(round(x * (1 - t) + y * t)) for x, y in zip(a, b))


def _miq_lum(c) -> float:
    return 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]


def _miq_contrast(color, dark_bg: bool):
    """アバター平均色から作った文字色が背景に埋もれないよう明暗を寄せる。"""
    target = (255, 255, 255) if dark_bg else (0, 0, 0)
    c = _miq_mix(color, target, 0.35)
    for _ in range(20):
        lum = _miq_lum(c)
        if (dark_bg and lum >= 170) or (not dark_bg and lum <= 85):
            break
        c = _miq_mix(c, target, 0.12)
    return c


def render_miq_frames(
    frames: list,
    text: str,
    name: str,
    username: str,
    *,
    watermark: str = "",
    grayscale: bool = True,
    color_text: bool = False,
    flip: bool = False,
    bold: bool = False,
    full: bool = False,
    font_path: str | None = None,
    theme: str = "bw",
) -> list:
    """アバターのフレーム(PIL.Image)ごとに引用画像(RGB)を合成して返す。CPU処理なので to_thread で呼ぶこと。"""
    from PIL import Image, ImageDraw, ImageOps

    W, H = MIQ_W, MIQ_H
    _label, _emoji, bg, fg = MIQ_THEMES.get(theme) or MIQ_THEMES["bw"]
    dark_bg = _miq_lum(bg) < 128

    if color_text and frames:
        avg = frames[0].convert("RGB").resize((1, 1), Image.BILINEAR).getpixel((0, 0))
        fg = _miq_contrast(avg, dark_bg)
    sub = _miq_mix(fg, bg, 0.42)

    # ---- 文字レイヤ(全フレーム共通) ----
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    if full:
        cx, text_w = W // 2, 960
    else:
        side = W - H
        cx = side // 2 if flip else H + side // 2
        text_w = side - 80

    # 名前はフォールバック描画するため、絵文字・記号を残す。
    # 描けない文字だけが描画時に落とされる（□にしない）。
    if font_path:
        _miq_can_cjk = _font_covers_japanese(font_path)
    else:
        _miq_can_cjk = _levelup_pick_font()[1]
    shown_name = _miq_display_text(name) or _miq_display_text(username) or "unknown"
    shown_user = _miq_display_text(username)

    font, lines, lh, size = _miq_fit(d, text, font_path, text_w, 350)
    name_size = 34
    name_font = _miq_load_font(font_path, name_size)
    while name_size > 18 and _miq_units_width(d, f"- {shown_name}", font_path, name_size) > text_w:
        name_size -= 2
        name_font = _miq_load_font(font_path, name_size)
    user_font = _miq_load_font(font_path, 22)
    wm_font = _miq_load_font(font_path, 20)

    name_lh, user_lh, gap = int(name_size * 1.4), 32, 26
    block_h = len(lines) * lh + gap + name_lh + (user_lh if shown_user else 0)
    y = max(24, (H - block_h) // 2)

    sw = max(1, size // 36) if bold else 0
    fg4 = tuple(fg) + (255,)
    for line in lines:
        if line:
            _miq_draw_centered(layer, d, cx, y, line, size, fg4, sw, font_path)
        y += lh
    y += gap
    nsw = 1 if bold else 0
    _miq_draw_centered(layer, d, cx, y, f"- {shown_name}", name_size, fg4, nsw, font_path)
    y += name_lh
    if shown_user:
        _miq_draw_centered(layer, d, cx, y, f"@{shown_user}", 22, tuple(sub) + (255,), 0, font_path)
    if watermark:
        wm = _levelup_safe_name(watermark, _miq_can_cjk)
        if flip and not full:
            d.text((24, H - 18), wm, font=wm_font, fill=tuple(sub) + (255,), anchor="ls")
        else:
            d.text((W - 24, H - 18), wm, font=wm_font, fill=tuple(sub) + (255,), anchor="rs")

    # ---- アバターのフェード用マスク(通常レイアウトのみ) ----
    mask = None
    if not full:
        mask = Image.new("L", (H, H), 0)
        md = ImageDraw.Draw(mask)
        for x in range(H):
            t = x / (H - 1)
            a = 255 if t <= 0.32 else int(255 * max(0.0, 1 - (t - 0.32) / 0.68) ** 1.15)
            px = H - 1 - x if flip else x
            md.line([(px, 0), (px, H)], fill=a)

    out = []
    for frame in frames:
        if frame.mode in ("RGBA", "LA", "P"):
            rgba = frame.convert("RGBA")
            av = Image.new("RGB", rgba.size, bg)
            av.paste(rgba, mask=rgba.split()[-1])
        else:
            av = frame.convert("RGB")
        if grayscale:
            av = ImageOps.grayscale(av).convert("RGB")
        if full:
            av = ImageOps.fit(av, (W, H), Image.LANCZOS)
            base = Image.blend(av, Image.new("RGB", (W, H), bg), 0.74)
        else:
            av = ImageOps.fit(av, (H, H), Image.LANCZOS)
            base = Image.new("RGB", (W, H), bg)
            base.paste(av, (W - H if flip else 0, 0), mask)
        base.paste(layer, (0, 0), layer)
        out.append(base)
    return out


def _miq_open_avatar(avatar_bytes: bytes | None):
    from PIL import Image

    if avatar_bytes:
        try:
            return Image.open(io.BytesIO(avatar_bytes))
        except Exception:
            logger.debug("MIQ: アイコンの読み込みに失敗", exc_info=True)
    return Image.new("RGBA", (512, 512), (70, 70, 78, 255))


def render_miq_png(avatar_bytes: bytes | None, text: str, name: str, username: str, **opts) -> bytes:
    src = _miq_open_avatar(avatar_bytes)
    frame = src.convert("RGBA")
    img = render_miq_frames([frame], text, name, username, **opts)[0]
    buf = io.BytesIO()
    img.save(buf, "PNG", optimize=True)
    return buf.getvalue()


def _miq_save_png(img) -> bytes:
    buf = io.BytesIO()
    img.save(buf, "PNG", optimize=True)
    return buf.getvalue()


_MIQ_CUSTOM_EMOJI_TOKEN = re.compile(r"<(a?):(\w+):(\d+)>")


def _miq_sticker_renderable(sticker) -> bool:
    """スタンプが画像として描ける形式か (PNG/APNG/GIF)。Lottie (JSON) は対象外。"""
    ft = getattr(sticker, "format_type", None)
    val = getattr(ft, "value", ft)
    return val in (1, 2, 4)


def _miq_is_image_attachment(att) -> bool:
    ct = (getattr(att, "content_type", None) or "").lower()
    if ct.startswith("image/"):
        return True
    fname = (getattr(att, "filename", "") or "").lower()
    return fname.endswith((".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"))


def _miq_line_message_has_media(message) -> bool:
    """LINE風で「テキストが無くても生成できる」メディア (画像/スタンプ/絵文字) があるか。"""
    for att in getattr(message, "attachments", None) or []:
        if _miq_is_image_attachment(att):
            return True
    for sticker in getattr(message, "stickers", None) or []:
        if _miq_sticker_renderable(sticker):
            return True
    return bool(_MIQ_CUSTOM_EMOJI_TOKEN.search(getattr(message, "content", "") or ""))


MIQ_FILE = Path(
    os.getenv("MIQ_DATA_PATH")
    or (_MIQ_REPO_ROOT / "data" / "miq.json")
)

# サブパッケージ化 (core/general/miq/) の際に保存先がずれていた期間の
# 保存先 (core/data/miq.json)。既定パスにファイルが無い場合の読み取りに
# だけ使い、書き込みは常に MIQ_FILE へ行う (読み取れた時点で移行される)。
_MIQ_STRAY_FILE = Path(__file__).resolve().parents[2] / "data" / "miq.json"

# refuse: True にすると、他の人があなたのメッセージを引用できなくなる(自分の引用は可)。既定はオフ。
MIQ_DEFAULT_PREFS: dict = {
    "grayscale": True,
    "color_text": False,
    "flip": False,
    "bold": False,
    "full": False,
    "gif": False,
    "font": None,
    "theme": "bw",
    "format": "random",
    "refuse": False,
}

_MIQ_DATA: dict | None = None
_MIQ_LOCK: asyncio.Lock | None = None


def _miq_lock() -> asyncio.Lock:
    global _MIQ_LOCK
    if _MIQ_LOCK is None:
        _MIQ_LOCK = asyncio.Lock()
    return _MIQ_LOCK


def _miq_read_file() -> dict:
    try:
        with MIQ_FILE.open("r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except FileNotFoundError:
        # 旧保存先 (パスずれ期間の core/data/miq.json) にだけデータが
        # 残っている場合はそちらを拾う。環境変数で保存先を指定している
        # ときはその指定を優先し、旧保存先は見ない。
        if not os.getenv("MIQ_DATA_PATH") and _MIQ_STRAY_FILE.is_file():
            try:
                with _MIQ_STRAY_FILE.open("r", encoding="utf-8") as f:
                    data = json.load(f)
                return data if isinstance(data, dict) else {}
            except Exception:
                logger.debug("MIQ: 旧保存先の読み込みに失敗しました", exc_info=True)
        return {}
    except Exception:
        logger.exception("MIQ: %s の読み込みに失敗しました。壊れたファイルを退避して続行します", MIQ_FILE)
        try:
            os.replace(MIQ_FILE, MIQ_FILE.with_name(MIQ_FILE.name + f".broken-{int(time.time())}"))
        except OSError:
            logger.debug("MIQ: 壊れたファイルの退避に失敗しました", exc_info=True)
        return {}


def _miq_write_file(payload: str) -> None:
    MIQ_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = MIQ_FILE.with_name(MIQ_FILE.name + ".tmp")
    with tmp.open("w", encoding="utf-8") as f:
        f.write(payload)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, MIQ_FILE)


def _miq_root() -> dict:
    global _MIQ_DATA
    if _MIQ_DATA is None:
        data = _miq_read_file()
        if not isinstance(data.get("users"), dict):
            data["users"] = {}
        _MIQ_DATA = data
    return _MIQ_DATA


def miq_get_prefs(user_id: int) -> dict:
    """ユーザーのMIQ設定を返す(未設定の項目は既定値、壊れた値は無視)。"""
    raw = _miq_root()["users"].get(str(user_id))
    prefs = dict(MIQ_DEFAULT_PREFS)
    if isinstance(raw, dict):
        for key, default in MIQ_DEFAULT_PREFS.items():
            value = raw.get(key)
            if isinstance(default, bool):
                if isinstance(value, bool):
                    prefs[key] = value
            elif key == "theme":
                if value in MIQ_THEMES:
                    prefs[key] = value
            elif key == "format":
                if value in MIQ_FORMATS:
                    prefs[key] = value
            elif key == "font":
                if isinstance(value, str):
                    prefs[key] = value
    return prefs


def miq_is_refusing(user_id: int | None) -> bool:
    """そのユーザーが「自分のメッセージの引用を拒否」しているか。"""
    if user_id is None:
        return False
    return bool(miq_get_prefs(user_id)["refuse"])


async def miq_save_prefs(user_id: int, prefs: dict) -> bool:
    users = _miq_root()["users"]
    clean = {key: prefs.get(key, default) for key, default in MIQ_DEFAULT_PREFS.items()}
    if clean.get("format") not in MIQ_FORMATS:
        clean["format"] = MIQ_DEFAULT_PREFS["format"]
    if clean == MIQ_DEFAULT_PREFS:
        users.pop(str(user_id), None)  # 既定値のままなら保存しない
    else:
        users[str(user_id)] = clean
    async with _miq_lock():
        try:
            payload = json.dumps(_miq_root(), ensure_ascii=False)
            await asyncio.to_thread(_miq_write_file, payload)
            return True
        except Exception:
            logger.exception("MIQ: %s への保存に失敗しました", MIQ_FILE)
            return False


def miq_render_options(prefs: dict, bot_user=None) -> dict:
    """保存済み設定を render_miq_* に渡す引数へ変換する。"""
    fonts = _miq_available_fonts()
    font_path = next((path for key, _label, path in fonts if key == prefs.get("font")), fonts[0][2])
    return {
        "watermark": str(bot_user) if bot_user else "",
        "grayscale": bool(prefs.get("grayscale")),
        "color_text": bool(prefs.get("color_text")),
        "flip": bool(prefs.get("flip")),
        "bold": bool(prefs.get("bold")),
        "full": bool(prefs.get("full")),
        "font_path": font_path,
        "theme": prefs.get("theme") if prefs.get("theme") in MIQ_THEMES else "bw",
        "format": prefs.get("format") if prefs.get("format") in MIQ_FORMATS else "quote",
    }


def is_miq_trigger(message, bot_user) -> bool:
    """「引用したいメッセージに返信して `@BOT miq`」と送られたメッセージか。

    他のcogがBOTメンションに反応して説明などを返している場合は、
    on_message の先頭で `if is_miq_trigger(message, self.bot.user): return` として除外する。
    """
    if bot_user is None or getattr(message, "reference", None) is None:
        return False
    content = message.content or ""
    if f"<@{bot_user.id}>" not in content and f"<@!{bot_user.id}>" not in content:
        return False
    return re.sub(r"<@!?\d+>", "", content).strip().lower() == "miq"


# ------------------------------------------------------------
# MIQ 設定パネル (/general → 引用画像 (MIQ) → MIQ設定)。components v2 で表示する
# ------------------------------------------------------------


class MiqMixin:
    """GeneralCog の一部。cogs/general.py で合成される。"""

    def _miq_cooldown_ok(self, user_id: int) -> bool:
        now = time.monotonic()
        if now - self._miq_last.get(user_id, 0.0) < MIQ_COOLDOWN:
            return False
        self._miq_last[user_id] = now
        if len(self._miq_last) > 500:
            self._miq_last = {k: v for k, v in self._miq_last.items() if now - v < 60}
        return True


    def _miq_pillow_missing(self) -> None:
        if not self._levelup_pillow_warned:
            self._levelup_pillow_warned = True
            logger.warning("MIQ: Pillow が未インストールです (pip install pillow)")


    async def _miq_fetch_avatar_bytes(self, author, *, size: int = 512) -> bytes | None:
        try:
            return await author.display_avatar.replace(size=size, format="png").read()
        except Exception:
            logger.debug("MIQ: アイコンの取得に失敗 (user=%s)", getattr(author, "id", "?"), exc_info=True)
            return None


    def _miq_output_view(self, *, requester_id: int, target, current_format: str):
        """生成メッセージに付ける操作View (削除+フォーマット変更) を作る。"""
        from .miq_ui import MiqOutputView

        channel = getattr(target, "channel", None)
        return MiqOutputView(
            self,
            requester_id=requester_id,
            target_author_id=getattr(getattr(target, "author", None), "id", None),
            channel_id=getattr(channel, "id", None),
            target_message_id=getattr(target, "id", None),
            current_format=current_format,
        )


    async def _miq_regenerate_file(
        self, target, requester_id: int, selected_format: str, size_limit,
    ) -> tuple:
        """フォーマット変更セレクト用の再生成ディスパッチ。

        対象メッセージ target を、requester の現在の保存設定 (フォント等) を
        読み直した上で、フォーマットだけ selected_format に差し替えて作り直す。
        line / pair / versus は対象の返信チェーンを再取得して生成し直す。
        戻り値 (file, resolved_format, error)。error はユーザー向けの失敗理由で、
        None でない場合は生成しておらず、元のメッセージは変更されない。
        """
        author_id = getattr(getattr(target, "author", None), "id", None)
        if author_id is not None and author_id != requester_id and miq_is_refusing(author_id):
            return None, None, "このユーザーは引用画像(MIQ)を拒否しています。"
        prefs = miq_get_prefs(requester_id)
        fmt = miq_resolve_format(selected_format)
        text = _miq_clean_text(getattr(target, "clean_content", "") or "")
        if fmt == "line":
            # LINE風は画像/スタンプ/絵文字だけのメッセージでも再生成できる
            if not text and not _miq_line_message_has_media(target):
                return None, None, "文字・画像・スタンプのあるメッセージではないため、LINE風では再生成できません。"
        elif not text:
            return None, None, "文字のあるメッセージではないため、このフォーマットでは再生成できません。"
        eff_prefs = dict(prefs)
        eff_prefs["format"] = fmt
        refused = False
        if fmt == "line":
            file, refused = await self._miq_line_file_for(target, requester_id, eff_prefs, size_limit)
        elif fmt == "pair":
            file, refused = await self._miq_pair_file_for(target, requester_id, eff_prefs, size_limit)
        elif fmt == "versus":
            file, refused = await self._miq_versus_file_for(target, requester_id, eff_prefs, size_limit)
        else:
            file = await self._miq_build_file(
                target.author, text, eff_prefs, size_limit,
                created_at=getattr(target, "created_at", None),
            )
        if refused:
            return None, None, "このユーザーは引用画像(MIQ)を拒否しています。"
        if file is None:
            return None, None, "引用画像を作れませんでした。時間をおいて再試行してください。"
        return file, fmt, None


    async def _miq_create_done(self, interaction: discord.Interaction, text: str):
        """パネル経由の MIQ 作成 (general:miq_create): 入力テキストを
        投稿者本人の名前/アバターで画像化して返す。

        生成は既存の _miq_build_file（コンテキストメニュー等と同一経路）
        を使い、フォーマット等の設定は本人の保存済み prefs に従う。
        対象メッセージが無い単体生成のため、line / pair / versus は
        _miq_build_file 側の単体レイアウトにフォールバックする。
        生成物に付ける操作 View (MiqOutputView) は対象メッセージを
        前提とするため、ここでは付けない。
        """
        cleaned = _miq_clean_text(text)
        if not cleaned:
            return await interaction.response.send_message(
                "文字のあるテキストを入力してください。", ephemeral=True)
        if not self._miq_cooldown_ok(interaction.user.id):
            return await interaction.response.send_message(
                "少し待ってからもう一度お試しください。", ephemeral=True)
        await interaction.response.defer(thinking=True)
        prefs = miq_get_prefs(interaction.user.id)
        size_limit = getattr(interaction.guild, "filesize_limit", None)
        file = await self._miq_build_file(
            interaction.user, cleaned, prefs, size_limit)
        if file is None:
            return await interaction.followup.send(
                "引用画像を作れませんでした。時間をおいて再試行してください。")
        await interaction.followup.send(file=file)


    async def miq_context(self, interaction: discord.Interaction, message: discord.Message):
        """メッセージの右クリックメニュー「引用画像にする」。"""
        author_id = getattr(message.author, "id", None)
        if author_id != interaction.user.id and miq_is_refusing(author_id):
            return await interaction.response.send_message(
                "このユーザーは引用画像(MIQ)を拒否しています。", ephemeral=True
            )
        prefs = miq_get_prefs(interaction.user.id)
        fmt = miq_resolve_format(prefs)
        text = _miq_clean_text(message.clean_content)
        if fmt == "line":
            # LINE風は画像/スタンプ/絵文字だけのメッセージでも生成できる
            if not text and not _miq_line_message_has_media(message):
                return await interaction.response.send_message(
                    "文字・画像・スタンプのあるメッセージを選んでください。",
                    ephemeral=True,
                )
        elif not text:
            return await interaction.response.send_message(
                "文字のあるメッセージを選んでください(画像や埋め込みだけのメッセージは引用できません)。",
                ephemeral=True,
            )
        if not self._miq_cooldown_ok(interaction.user.id):
            return await interaction.response.send_message("少し待ってからもう一度お試しください。", ephemeral=True)
        await interaction.response.defer(thinking=True)
        eff_prefs = dict(prefs)
        eff_prefs["format"] = fmt
        size_limit = getattr(interaction.guild, "filesize_limit", None)
        if fmt == "line":
            file, refused = await self._miq_line_file_for(message, interaction.user.id, eff_prefs, size_limit)
            if refused:
                return await interaction.followup.send("このユーザーは引用画像(MIQ)を拒否しています。")
        elif fmt == "pair":
            file, refused = await self._miq_pair_file_for(message, interaction.user.id, eff_prefs, size_limit)
            if refused:
                return await interaction.followup.send("このユーザーは引用画像(MIQ)を拒否しています。")
        elif fmt == "versus":
            file, refused = await self._miq_versus_file_for(message, interaction.user.id, eff_prefs, size_limit)
            if refused:
                return await interaction.followup.send("このユーザーは引用画像(MIQ)を拒否しています。")
        else:
            file = await self._miq_build_file(
                message.author, text, eff_prefs, size_limit,
                created_at=getattr(message, "created_at", None),
            )
        if file is None:
            return await interaction.followup.send("引用画像を作れませんでした。")
        view = self._miq_output_view(requester_id=interaction.user.id, target=message, current_format=fmt)
        await interaction.followup.send(file=file, view=view)


    async def _miq_from_reply(self, message: discord.Message):
        """引用したいメッセージに返信して `@BOT miq` と送った時の処理。"""
        try:
            ref = message.reference
            if ref is None or ref.message_id is None:
                return
            can_post, can_attach = self._levelup_can_post(message.channel, message.guild.me)
            if not (can_post and can_attach):
                return
            target = ref.resolved if isinstance(ref.resolved, discord.Message) else None
            if target is None:
                target = await message.channel.fetch_message(ref.message_id)
            author_id = getattr(target.author, "id", None)
            if author_id != message.author.id and miq_is_refusing(author_id):
                await message.reply(
                    "このユーザーは引用画像(MIQ)を拒否しています。", mention_author=False, delete_after=8,
                )
                return
            prefs = miq_get_prefs(message.author.id)
            fmt = miq_resolve_format(prefs)
            text = _miq_clean_text(target.clean_content)
            if fmt == "line":
                # LINE風は画像/スタンプ/絵文字だけのメッセージでも生成できる
                if not text and not _miq_line_message_has_media(target):
                    await message.reply(
                        "文字・画像・スタンプのあるメッセージに返信してください。",
                        mention_author=False, delete_after=8,
                    )
                    return
            elif not text:
                await message.reply("文字のあるメッセージに返信してください。", mention_author=False, delete_after=8)
                return
            if not self._miq_cooldown_ok(message.author.id):
                return
            eff_prefs = dict(prefs)
            eff_prefs["format"] = fmt
            size_limit = getattr(message.guild, "filesize_limit", None)
            async with message.channel.typing():
                if fmt == "line":
                    file, refused = await self._miq_line_file_for(target, message.author.id, eff_prefs, size_limit)
                    if refused:
                        await message.reply(
                            "このユーザーは引用画像(MIQ)を拒否しています。", mention_author=False, delete_after=8,
                        )
                        return
                elif fmt == "pair":
                    file, refused = await self._miq_pair_file_for(target, message.author.id, eff_prefs, size_limit)
                    if refused:
                        await message.reply(
                            "このユーザーは引用画像(MIQ)を拒否しています。", mention_author=False, delete_after=8,
                        )
                        return
                elif fmt == "versus":
                    file, refused = await self._miq_versus_file_for(target, message.author.id, eff_prefs, size_limit)
                    if refused:
                        await message.reply(
                            "このユーザーは引用画像(MIQ)を拒否しています。", mention_author=False, delete_after=8,
                        )
                        return
                else:
                    file = await self._miq_build_file(
                        target.author, text, eff_prefs, size_limit,
                        created_at=getattr(target, "created_at", None),
                    )
            if file is None:
                return
            view = self._miq_output_view(requester_id=message.author.id, target=target, current_format=fmt)
            await message.reply(file=file, view=view, mention_author=False)
        except discord.HTTPException:
            logger.debug("MIQ: 返信での引用生成に失敗しました", exc_info=True)
        except Exception:
            logger.exception("MIQ: 返信での引用生成に失敗しました")
