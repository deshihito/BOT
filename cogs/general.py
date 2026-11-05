"""/general: コイン・生存確認・EXP・ランキング系機能の操作パネル。"""
from __future__ import annotations

import asyncio
import hashlib
import io
import json
import logging
import math
import os
import random
import re
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import discord
from discord import app_commands
from discord.ext import commands, tasks
from core.panel_v2 import as_panel_v2, edit_panel_v2
from core import action_registry, action_usage, ai_omnirush, ai_preferences, ai_provider_router, guild_settings, logfare, shortcuts, usage_stats
from core.game_guides import GAME_GUIDES, GAME_ORDER
from core import localization, translation
from core.libretranslate import LibreTranslateClient, LibreTranslateError

logger = logging.getLogger(__name__)


# ============================================================
# EXP 設定
# ============================================================
CHAT_EXP_BASE = 50
CHAT_EXP_RATIO = 1.25
VC_EXP_BASE = 50
VC_EXP_RATIO = 1.25

CHAT_EXP_INTERVAL = 5 * 60
VC_EXP_INTERVAL = 5 * 60
CHAT_EXP_PER_GRANT = 5
VC_EXP_PER_GRANT = 5
VC_MAX_GAP_SECONDS = 3 * 60
HISTORY_FUTURE_TOLERANCE = 60

EXP_STORE_KEY = "exp"

# ジャンル説明は、ラベルや配下の機能名から読み取れない情報がある場合だけ書く。
# 機能名の列挙は書かない（空文字 = 説明なし）。
GENERAL_GENRES = {
    "economy": ("コイン・ランキング", ""),
    "exp": ("EXP・レベル", "チャット・VC・generalのEXPとレベル"),
    "survival": ("生存確認", "メンバーの安否・不在の検知"),
    "custom": ("設定・AI", ""),
    "zeta": ("ZetaModoki", "ロールプレイ会話"),
    "translation": ("翻訳", ""),
    "miq": ("引用画像 (MIQ)", "メッセージを引用画像にする"),
    "meme": ("meme作成", "画像に上下テキストを入れてmeme画像を作成する"),
}
GENERAL_ACTIONS = {
    "economy": [
        ("プレイヤー状況", "status"),
        ("コイン送金", "pay"),
        ("コイン保有ランキング", "coin_leaderboard"),
        ("bump RTAランキング", "bump_leaderboard"),
        ("up RTAランキング", "up_leaderboard"),
    ],
    "survival": [
        ("追跡登録・解除", "fujo_register"),
        ("アクティブ頻度", "fujo_hindo"),
        ("生存確認ランキング", "fujo_ranking"),
        ("フリーズ", "fujo_freeze"),
        ("失踪警報解除", "fujo_panic_disable"),
    ],
    "exp": [
        ("自分のEXP状況", "exp_status"),
        ("EXPランキング", "exp_ranking"),
    ],
    "custom": [
        ("ショートカットを管理", "shortcut_manage"),
        ("AI tools稼働状態", "aitools"),
        ("チャットAIモデルを設定", "ai_default"),
        ("画像生成AIモデルを設定", "image_default"),
        ("AI思考強度を設定", "reasoning_default"),
    ],
    "zeta": [
        ("ZetaModokiと会話", "zetamodoki"),
        ("ZetaModoki会話をリセット", "zeta_reset"),
        ("シチュエーション・キャラクターを登録", "zeta_register"),
        ("登録を管理（編集・削除）", "zeta_manage"),
    ],
    "translation": [
        ("自動翻訳を設定", "translation_settings"),
    ],
    "miq": [
        ("MIQ設定（見た目・引用拒否）", "miq_settings"),
        ("使い方", "miq_help"),
    ],
    "meme": [
        ("memeを作成", "meme_create"),
        ("使い方", "meme_help"),
    ],
}

# アクション定義の単一の真実は core/action_registry。SHORTCUT_ROOTS は
# レジストリからの生成物（名前・形状・import 互換は従来どおり維持する）。
SHORTCUT_ROOTS = action_registry.build_shortcut_roots()


# ============================================================
# EXP 計算ユーティリティ
# ============================================================
def exp_for_next(level: int, base: int, ratio: float) -> int:
    if level < 1:
        level = 1
    return max(1, round(base * (ratio ** (level - 1))))


def level_from_exp(total_exp: int, base: int, ratio: float) -> tuple[int, int, int]:
    level = 1
    remaining = max(0, int(total_exp))
    while True:
        need = exp_for_next(level, base, ratio)
        if remaining < need:
            return level, remaining, need
        remaining -= need
        level += 1
        if level > 9999:
            return level, remaining, need


def general_level(chat_exp: int, vc_exp: int) -> int:
    cl, _, _ = level_from_exp(chat_exp, CHAT_EXP_BASE, CHAT_EXP_RATIO)
    vl, _, _ = level_from_exp(vc_exp, VC_EXP_BASE, VC_EXP_RATIO)
    return max(1, (cl + vl) // 2)


def _user_general_level(user: dict) -> int:
    """EXPレコード(dict)から現在のgeneralレベルを求める。レベルアップ検知用。"""
    return general_level(_as_int(user.get("chat_exp")), _as_int(user.get("vc_exp")))


# ============================================================
# EXP 永続化ヘルパ
# ============================================================
def _as_float(value, default: float = 0.0) -> float:
    try:
        f = float(value)
    except (TypeError, ValueError):
        return default
    return f if f == f and abs(f) != float("inf") else default


def _as_int(value, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


# ------------------------------------------------------------
# 保存先
# ------------------------------------------------------------
# guild_settings のストアは store["exp"] = ... のような汎用キー保存を受け付けず
# (登録の4方式すべて失敗)、EXPが永続化されなかった。そのためEXPは
# このcog専用のJSONファイルへ保存する(一時ファイル→置換のアトミック書き込み)。
# 保存先は環境変数 EXP_DATA_PATH で変更可能。既定は <プロジェクト直下>/data/exp.json
EXP_FILE = Path(
    os.getenv("EXP_DATA_PATH")
    or (Path(__file__).resolve().parent.parent / "data" / "exp.json")
)

_EXP_DATA: dict | None = None
_EXP_LOCK: asyncio.Lock | None = None


def _exp_lock() -> asyncio.Lock:
    # Lock はイベントループ上で遅延生成する (import時生成によるループ不一致を避ける)
    global _EXP_LOCK
    if _EXP_LOCK is None:
        _EXP_LOCK = asyncio.Lock()
    return _EXP_LOCK


def _store_fetch(store, key: str):
    """旧ストアに残っているEXPを取り込むための読み取り専用ヘルパ。"""
    getter = getattr(store, "get", None)
    if not callable(getter):
        return None
    try:
        return getter(key)
    except Exception:
        logger.warning("EXP: 旧ストアからの読み取りに失敗しました", exc_info=True)
        return None


def _read_exp_file() -> dict:
    try:
        with EXP_FILE.open("r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except FileNotFoundError:
        return {}
    except Exception:
        logger.exception("EXP: %s の読み込みに失敗しました。壊れたファイルを退避して続行します", EXP_FILE)
        try:
            os.replace(EXP_FILE, EXP_FILE.with_name(EXP_FILE.name + f".broken-{int(time.time())}"))
        except OSError:
            logger.debug("EXP: 壊れたファイルの退避に失敗しました", exc_info=True)
        return {}


def _write_exp_file(payload: str) -> None:
    EXP_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = EXP_FILE.with_name(EXP_FILE.name + ".tmp")
    with tmp.open("w", encoding="utf-8") as f:
        f.write(payload)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, EXP_FILE)


def _exp_root() -> dict:
    """EXPデータ(生の dict)を返す。初回のみファイルから読み込む。

    旧ストア(guild_settings)に 'exp' が残っていれば、最大値でマージして引き継ぐ。
    """
    global _EXP_DATA
    if _EXP_DATA is None:
        data = _read_exp_file()
        try:
            legacy = _store_fetch(guild_settings.get_store(), EXP_STORE_KEY)
            if isinstance(legacy, dict) and legacy:
                _merge_exp(data, legacy)
        except Exception:
            logger.exception("EXP: 旧ストアからの引き継ぎに失敗しました (無視して続行)")
        _EXP_DATA = data
    return _EXP_DATA


async def _exp_load() -> dict:
    return _exp_root()


async def _exp_save() -> bool:
    data = _exp_root()
    async with _exp_lock():
        try:
            # 書き込み順が前後しないよう、ロック内で最新状態をシリアライズする
            payload = json.dumps(data, ensure_ascii=False)
            await asyncio.to_thread(_write_exp_file, payload)
            return True
        except Exception:
            logger.exception("EXP: %s への保存に失敗しました", EXP_FILE)
            return False




def _merge_exp(dst: dict, src: dict):
    for gid, users in src.items():
        if not isinstance(users, dict):
            continue
        dusers = dst.get(gid)
        if not isinstance(dusers, dict):
            dusers = dst[gid] = {}
        for uid, u in users.items():
            if not isinstance(u, dict):
                continue
            du = dusers.get(uid)
            if not isinstance(du, dict):
                dusers[uid] = u
                continue
            for k, v in u.items():
                if k in ("chat_exp", "vc_exp"):
                    du[k] = max(_as_int(du.get(k)), _as_int(v))
                elif k in ("last_chat_grant", "vc_last_tick", "vc_accum_sec"):
                    du[k] = max(_as_float(du.get(k)), _as_float(v))


def _exp_ensure(data: dict, guild_id: int, user_id: int) -> dict:
    g = data.get(str(guild_id))
    if not isinstance(g, dict):
        g = data[str(guild_id)] = {}
    u = g.get(str(user_id))
    if not isinstance(u, dict):
        u = g[str(user_id)] = {}
    u.setdefault("chat_exp", 0)
    u.setdefault("vc_exp", 0)
    u.setdefault("last_chat_grant", 0.0)
    u.setdefault("vc_accum_sec", 0.0)
    u.setdefault("vc_last_tick", 0.0)
    return u


def _grant_chat_exp(user: dict, now: float) -> bool:
    last = _as_float(user.get("last_chat_grant"))
    has_history = 0.0 < last <= now + HISTORY_FUTURE_TOLERANCE
    if has_history and now - last < CHAT_EXP_INTERVAL:
        return False
    user["chat_exp"] = _as_int(user.get("chat_exp")) + CHAT_EXP_PER_GRANT
    user["last_chat_grant"] = now
    return True


def _grant_vc_exp(user: dict, now: float) -> bool:
    last = _as_float(user.get("vc_last_tick"))
    if last <= 0.0 or last > now + HISTORY_FUTURE_TOLERANCE:
        user["vc_last_tick"] = now
        return False
    delta = min(max(0.0, now - last), VC_MAX_GAP_SECONDS)
    accum = _as_float(user.get("vc_accum_sec")) + delta
    user["vc_last_tick"] = now
    granted = False
    while accum >= VC_EXP_INTERVAL:
        accum -= VC_EXP_INTERVAL
        user["vc_exp"] = _as_int(user.get("vc_exp")) + VC_EXP_PER_GRANT
        granted = True
    user["vc_accum_sec"] = accum
    return granted


def _iter_voice_user_ids(guild: discord.Guild):
    """VCに実際にいる(ボイス状態を持つ)人間のユーザーIDを返す。

    channel.members は member キャッシュ(members intent / チャンク)に依存し、
    キャッシュが無いと空になるため、ボイス状態 channel.voice_states を直接見る。
    """
    for channel in (*guild.voice_channels, *guild.stage_channels):
        for uid in list(channel.voice_states.keys()):
            member = guild.get_member(uid)
            if member is not None and member.bot:
                continue
            yield uid


def _iter_voice_user_channels(guild: discord.Guild):
    """_iter_voice_user_ids と同じ対象を (ユーザーID, いるVC) で返す。レベルアップ通知のフォールバック先に使う。"""
    for channel in (*guild.voice_channels, *guild.stage_channels):
        for uid in list(channel.voice_states.keys()):
            member = guild.get_member(uid)
            if member is not None and member.bot:
                continue
            yield uid, channel


# ============================================================
# レベルアップ通知（画像生成）
# ============================================================
# 通知先・オン/オフは /support の「レベルアップ通知」で設定する(guild_settings の LEVELUP_SECTION)。
# 画像生成には Pillow が必要 (pip install pillow)。入っていない/失敗した場合は
# 画像なしのテキスト通知にフォールバックする。
# ユーザー名に日本語を描くには日本語フォントが必要。環境変数 LEVELUP_FONT_PATH か
# <プロジェクト直下>/assets/fonts/levelup.(ttf|otf|ttc) に置くか、OSのフォントを自動検出する。
# Linuxなら `sudo apt install fonts-noto-cjk` でOK。
LEVELUP_SECTION = "levelup_notify"


def get_levelup_settings(store, guild_id: int) -> dict:
    """/support の「レベルアップ通知」の設定(support側のパネルからも使う)。

    未設定時は『オン・EXPが入った場所(発言したチャンネル/いたVC)へ通知』。
    """
    raw = store.get(guild_id, LEVELUP_SECTION)
    if not isinstance(raw, dict):
        raw = {}
    enabled = raw.get("enabled")
    channel_id = raw.get("channel_id")
    return {
        "enabled": enabled if isinstance(enabled, bool) else True,
        "channel_id": channel_id if isinstance(channel_id, int) and not isinstance(channel_id, bool) else None,
    }
LEVELUP_CARD_W, LEVELUP_CARD_H = 1000, 360
_LEVELUP_SS = 2  # 内部は2倍解像度で描いて縮小(ジャギー防止)

_LEVELUP_CJK_FONTS = (
    os.getenv("LEVELUP_FONT_PATH") or "",
    str(Path(__file__).resolve().parent.parent / "assets" / "fonts" / "levelup.ttf"),
    str(Path(__file__).resolve().parent.parent / "assets" / "fonts" / "levelup.otf"),
    str(Path(__file__).resolve().parent.parent / "assets" / "fonts" / "levelup.ttc"),
    # リポジトリ同梱の日本語フォント。assets/fonts はリポジトリに存在しないため、
    # OSフォントが無くてもここで日本語が描ける (Hachi Maru Pop)。
    str(Path(__file__).resolve().parent.parent / "font.ttf"),
    "C:/Windows/Fonts/meiryob.ttc",
    "C:/Windows/Fonts/YuGothB.ttc",
    "C:/Windows/Fonts/msgothic.ttc",
    "/System/Library/Fonts/ヒラギノ角ゴシック W6.ttc",
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJKjp-Bold.otf",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Bold.ttc",
    "/usr/share/fonts/noto-cjk/NotoSansCJK-Bold.ttc",
    "/usr/share/fonts/google-noto-cjk/NotoSansCJK-Bold.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/opentype/ipaexfont-gothic/ipaexg.ttf",
    "/usr/share/fonts/truetype/fonts-japanese-gothic.ttf",
    "/usr/share/fonts/truetype/takao-gothic/TakaoPGothic.ttf",
)
_LEVELUP_LATIN_FONTS = (
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "C:/Windows/Fonts/arialbd.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
)

# 参考画像(Bahnschrift / DIN 系コンデンス)を優先する
_LEVELUP_DISPLAY_FONTS = (
    os.getenv("LEVELUP_DISPLAY_FONT_PATH") or "",
    str(Path(__file__).resolve().parent.parent / "assets" / "fonts" / "levelup-display.ttf"),
    str(Path(__file__).resolve().parent.parent / "assets" / "fonts" / "levelup-display.otf"),
    # ★ 参考画像 (Bahnschrift / DIN 系コンデンス) を優先
    "/usr/share/fonts/truetype/bahnschrift/bahnschrift.ttf",
    "/usr/share/fonts/truetype/oswald/Oswald-Medium.ttf",
    "/usr/share/fonts/truetype/oswald/Oswald-SemiBold.ttf",
    "/usr/share/fonts/truetype/barlow-condensed/BarlowCondensed-SemiBold.ttf",
    "/usr/share/fonts/truetype/barlow-condensed/BarlowCondensed-Bold.ttf",
    "C:/Windows/Fonts/bahnschrift.ttf",
    "C:/Windows/Fonts/BAHNSCHRIFT.TTF",
    # Linux (fontconfig)
    "/usr/share/fonts/truetype/anton/Anton-Regular.ttf",
    "/usr/share/fonts/truetype/bebasneue/BebasNeue-Regular.ttf",
    "/usr/share/fonts/truetype/archivo-black/ArchivoBlack-Regular.ttf",
    "/usr/share/fonts/truetype/barlow-condensed/BarlowCondensed-Bold.ttf",
    "/usr/share/fonts/truetype/oswald/Oswald-Bold.ttf",
    "/usr/share/fonts/truetype/noto/NotoSansDisplay-Black.ttf",
    "/usr/share/fonts/truetype/noto/NotoSansDisplay-CondensedBlack.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSansCondensed-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    # macOS
    "/System/Library/Fonts/Supplemental/Impact.ttf",
    "/System/Library/Fonts/Supplemental/Arial Black.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
    # Windows
    "C:/Windows/Fonts/impact.ttf",
    "C:/Windows/Fonts/ariblk.ttf",
    "C:/Windows/Fonts/arialbd.ttf",
)

_LEVELUP_FONT_PICK: tuple[str | None, bool] | None = None
_LEVELUP_DISPLAY_PICK: str | None | bool = False  # 未探索は False


def _levelup_pick_font() -> tuple[str | None, bool]:
    """本文用フォント(CJK 可なら True)を返す(初回のみ探索)。"""
    global _LEVELUP_FONT_PICK
    if _LEVELUP_FONT_PICK is not None:
        return _LEVELUP_FONT_PICK
    from PIL import ImageFont

    pick: tuple[str | None, bool] = (None, False)
    for cjk, paths in ((True, _LEVELUP_CJK_FONTS), (False, _LEVELUP_LATIN_FONTS)):
        for path in paths:
            if not path or not os.path.exists(path):
                continue
            try:
                ImageFont.truetype(path, 20)
            except Exception:
                logger.debug("レベルアップカード: フォント候補の読み込みに失敗しました", exc_info=True)
                continue
            pick = (path, cjk)
            break
        if pick[0]:
            break
    _LEVELUP_FONT_PICK = pick
    return pick


def _levelup_pick_display_font() -> str | None:
    """「LEVEL UP」などの見出しに使う極太ディスプレイフォントを返す。

    参考画像に寄せるため、まず専用の太字サンセリフ体(Bahnschrift / Oswald / Anton 等)を探し、
    無ければ本文フォントにフォールバックする。
    """
    global _LEVELUP_DISPLAY_PICK
    if _LEVELUP_DISPLAY_PICK is not False:
        return _LEVELUP_DISPLAY_PICK  # type: ignore[return-value]
    from PIL import ImageFont

    chosen: str | None = None
    for path in _LEVELUP_DISPLAY_FONTS:
        if not path or not os.path.exists(path):
            continue
        try:
            ImageFont.truetype(path, 20)
        except Exception:
            logger.debug("レベルアップカード: 表示フォント候補の読み込みに失敗しました", exc_info=True)
            continue
        chosen = path
        break
    if chosen is None:
        chosen = _levelup_pick_font()[0]
    _LEVELUP_DISPLAY_PICK = chosen
    return chosen


def _levelup_font(size: int):
    from PIL import ImageFont

    path, _ = _levelup_pick_font()
    if path:
        try:
            return ImageFont.truetype(path, size)
        except Exception:
            logger.debug("レベルアップカード: フォントの読み込みに失敗しました", exc_info=True)
    try:
        return ImageFont.load_default(size=size)  # Pillow>=10.1
    except TypeError:
        return ImageFont.load_default()


def _levelup_display_font(size: int):
    from PIL import ImageFont

    path = _levelup_pick_display_font()
    if path:
        try:
            return ImageFont.truetype(path, size)
        except Exception:
            logger.debug("レベルアップカード: 表示フォントの読み込みに失敗しました", exc_info=True)
    return _levelup_font(size)


def _levelup_draw_tracked(d, xy, text, font, fill, tracking: float, anchor: str = "ls"):
    """字間(tracking px)を加えてテキストを描く。戻り値は (描画幅, 描画高さ)。"""
    x, y = xy
    total_w = 0.0
    for ch in text:
        total_w += d.textlength(ch, font=font)
    total_w += tracking * max(0, len(text) - 1)

    # アンカー調整: ls(左ベースライン) のみサポート
    if anchor.startswith("m"):
        x -= total_w / 2
    elif anchor.startswith("r"):
        x -= total_w

    for ch in text:
        d.text((x, y), ch, font=font, fill=fill, anchor=anchor)
        x += d.textlength(ch, font=font) + tracking

    bbox = font.getbbox(text)
    return total_w, bbox[3] - bbox[1]


def _levelup_safe_name(name: str, can_cjk: bool) -> str:
    """画像に描けない文字(絵文字など)を落とす。日本語フォントが無ければASCIIのみ。"""
    out = []
    for ch in str(name or ""):
        o = ord(ch)
        if o >= 0x1F000 or 0x2190 <= o <= 0x2BFF or o in (0x200D, 0xFE0F, 0xFE0E) or o < 0x20:
            continue
        if not can_cjk and o > 0x7E:
            continue
        out.append(ch)
    return "".join(out).strip()


def render_levelup_card(
    avatar_bytes: bytes | None,
    name: str,
    before: int,
    after: int,
    seed: int = 0,
    *,
    bot_avatar_bytes: bytes | None = None,
) -> bytes:
    """レベルアップ画像(PNG)を生成して bytes で返す。CPU処理なので to_thread で呼ぶこと。

    白基調・装飾最小。Bahnschrift/DIN 系コンデンスフォントにトラッキングを加えた見出し。
    矢印は軸+三角形の2段構成、レベル数字は視覚的中心でベースラインを揃える。
    """
    from PIL import Image, ImageDraw

    S = _LEVELUP_SS
    W, H = LEVELUP_CARD_W * S, LEVELUP_CARD_H * S
    _, can_cjk = _levelup_pick_font()

    def px(v: float) -> int:
        return int(round(v * S))

    BG = (255, 255, 255, 255)
    INK = (44, 52, 74, 255)       # 濃紺(参考画像の文字色)
    MUTE = (150, 156, 170, 255)
    LINE = (228, 232, 240, 255)
    ACCENT = (59, 91, 255, 255)
    RING = (127, 178, 201, 255)

    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    d.rounded_rectangle(
        [0, 0, W - 1, H - 1], radius=px(28),
        fill=BG, outline=LINE, width=px(2),
    )

    # ============================================================
    # 左: ユーザーアイコン
    # ============================================================
    D = px(196)
    ax, ay = px(56), (H - D) // 2
    ring_w = px(4)
    R = D // 2 + px(8) + ring_w
    acx, acy = ax + D // 2, ay + D // 2
    d.ellipse([acx - R, acy - R, acx + R, acy + R], outline=RING, width=ring_w)

    avatar = None
    if avatar_bytes:
        try:
            avatar = Image.open(io.BytesIO(avatar_bytes)).convert("RGBA").resize((D, D), Image.LANCZOS)
        except Exception:
            logger.debug("レベルアップカード: アバターの取得に失敗しました", exc_info=True)
            avatar = None
    if avatar is None:
        avatar = Image.new("RGBA", (D, D), (235, 238, 245, 255))
        ad = ImageDraw.Draw(avatar)
        ad.ellipse([D * 0.34, D * 0.20, D * 0.66, D * 0.52], fill=(255, 255, 255, 255))
        ad.ellipse([D * 0.18, D * 0.58, D * 0.82, D * 1.15], fill=(255, 255, 255, 255))
    amask = Image.new("L", (D, D), 0)
    ImageDraw.Draw(amask).ellipse([0, 0, D - 1, D - 1], fill=255)
    img.paste(avatar, (ax, ay), amask)

    # ============================================================
    # 右上: BOT バッジ
    # ============================================================
    BOT_D = px(56)
    BOT_MARGIN = px(28)
    bx = W - BOT_MARGIN - BOT_D
    by = BOT_MARGIN

    if bot_avatar_bytes:
        try:
            bot_avatar = (
                Image.open(io.BytesIO(bot_avatar_bytes))
                .convert("RGBA")
                .resize((BOT_D, BOT_D), Image.LANCZOS)
            )
        except Exception:
            logger.debug("レベルアップカード: Botアバターの取得に失敗しました", exc_info=True)
            bot_avatar = None
        if bot_avatar is not None:
            bring_w = px(2)
            bR = BOT_D // 2 + px(4) + bring_w
            bcx, bcy = bx + BOT_D // 2, by + BOT_D // 2
            d.ellipse([bcx - bR, bcy - bR, bcx + bR, bcy + bR], outline=LINE, width=bring_w)
            bmask = Image.new("L", (BOT_D, BOT_D), 0)
            ImageDraw.Draw(bmask).ellipse([0, 0, BOT_D - 1, BOT_D - 1], fill=255)
            img.paste(bot_avatar, (bx, by), bmask)

    # ============================================================
    # 中央: 見出し + レベル
    # ============================================================
    TX = ax + D + px(52)
    right = W - px(56)
    center_y = H // 2

    # --- 見出し「LEVEL UP」(トラッキング付き) ---
    up_text = "LEVEL UP"
    up_size = px(64)
    up_font = _levelup_display_font(up_size)

    # 収まるまで縮める(収まるときは縮めない)
    max_up_w = (right - TX) * 0.58
    while up_size > px(30) and d.textlength(up_text, font=up_font) > max_up_w:
        up_size -= px(2)
        up_font = _levelup_display_font(up_size)

    up_tracking = px(3)  # 参考画像の広めの字間
    up_w, up_bbox_h = _levelup_draw_tracked(
        d, (TX, 0), up_text, up_font, INK, up_tracking, anchor="ls"
    )

    # --- レベル変化「9 → 10」 ---
    prev_text, new_text = str(before), str(after)
    pfont = _levelup_display_font(px(42))
    nfont = _levelup_display_font(px(72))

    p_w = d.textlength(prev_text, font=pfont)
    n_w = d.textlength(new_text, font=nfont)

    # 矢印の寸法
    arrow_w = px(56)
    arrow_h = px(26)
    shaft_h = max(px(4), int(arrow_h * 0.18))

    # 全体幅 = 前 + gap + 矢印 + gap + 後
    gap_before = px(20)
    gap_after = px(16)
    group_w = p_w + gap_before + arrow_w + gap_after + n_w

    # 見出し + 余白 + レベル群 が右端に収まるよう配置
    group_x = TX + up_w + px(56)
    if group_x + group_w > right:
        group_x = max(TX + up_w + px(24), right - group_w)

    # --- ベースラインの計算 ---
    # 見出しの視覚的な中心を、カードの中央よりやや上に置く
    heading_cy = center_y - px(22)

    # 「LEVEL UP」のベースライン: bbox のアセント分を補正
    up_bbox = up_font.getbbox(up_text)
    up_top = heading_cy - (up_bbox[3] - up_bbox[1]) / 2 - up_bbox[1]
    _levelup_draw_tracked(
        d, (TX, up_top), up_text, up_font, INK, up_tracking, anchor="ls"
    )

    # --- レベル変化のベースライン ---
    # 見出しと同じ視覚的中心 heading_cy に揃える
    p_bbox = pfont.getbbox(prev_text)
    n_bbox = nfont.getbbox(new_text)

    p_top = heading_cy - (p_bbox[3] - p_bbox[1]) / 2 - p_bbox[1]
    n_top = heading_cy - (n_bbox[3] - n_bbox[1]) / 2 - n_bbox[1]

    d.text((group_x, p_top), prev_text, font=pfont, fill=MUTE, anchor="ls")

    # --- 矢印(軸 + 三角形) ---
    arrow_x0 = group_x + p_w + gap_before
    arrow_cy = heading_cy

    # 軸
    d.rectangle(
        [
            arrow_x0,
            arrow_cy - shaft_h // 2,
            arrow_x0 + arrow_w - px(16),
            arrow_cy + shaft_h // 2,
        ],
        fill=ACCENT,
    )
    # 矢じり(3点の三角形)
    tip_x = arrow_x0 + arrow_w
    d.polygon(
        [
            (tip_x, arrow_cy),                                    # 頂点
            (arrow_x0 + arrow_w - px(20), arrow_cy - arrow_h // 2),  # 上
            (arrow_x0 + arrow_w - px(20), arrow_cy + arrow_h // 2),  # 下
        ],
        fill=ACCENT,
    )

    d.text((arrow_x0 + arrow_w + gap_after, n_top), new_text, font=nfont, fill=ACCENT, anchor="ls")

    # ============================================================
    # 下部: 区切り線 + ユーザー名
    # ============================================================
    line_y = H - px(58)
    d.line([px(56), line_y, W - px(56), line_y], fill=LINE, width=px(2))

    shown = _levelup_safe_name(name, can_cjk)
    if shown:
        nfont_small = _levelup_font(px(20))
        maxw = W - px(112)
        text = shown
        while len(text) > 1 and d.textlength(text, font=nfont_small) > maxw:
            text = text[:-1]
        if text != shown:
            text = text.rstrip() + ("…" if can_cjk else "...")
        d.text((px(56), H - px(32)), text, font=nfont_small, fill=MUTE, anchor="ls")

    out = img.resize((LEVELUP_CARD_W, LEVELUP_CARD_H), Image.LANCZOS)
    buf = io.BytesIO()
    out.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


# ============================================================
# MIQ (Make it a Quote) 引用画像
# ============================================================
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
    "random": ("ランダム", "🎲"),
    "quote": ("引用 (従来)", "🖼️"),
    "manga": ("漫画風", "💥"),
    "music": ("音楽再生風", "🎵"),
    "line": ("LINE風", "💬"),
    "news": ("ニュース速報風", "📺"),
    "xpost": ("X投稿風", "🐦"),
    "rpg": ("RPG風", "🎮"),
    "blueprint": ("設計図風", "📐"),
    "pixel": ("レトロゲーム風", "👾"),
    "card": ("トレカ風", "🎴"),
    "neon": ("ネオン風", "🌃"),
    "dark": ("ダーク風", "🎬"),
    "pop": ("ポップ風", "💛"),
    "pastel": ("パステル風", "🌸"),
    "ticket": ("チケット風", "🎫"),
    "note": ("ノート風", "📓"),
}

# ランダムで選ばれる単体メッセージ系フォーマット。
# line (返信チェーン前提) と random 自身は絶対に含めない。
MIQ_RANDOM_POOL = (
    "quote", "manga", "music", "news", "xpost", "rpg",
    "blueprint", "pixel", "card", "neon", "dark", "pop", "pastel", "ticket", "note",
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

_MIQ_ASSET_FONTS = Path(__file__).resolve().parent.parent / "assets" / "fonts"


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
_MIQ_REPO_FONT = str(Path(__file__).resolve().parent.parent / "font.ttf")
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
    root = Path(__file__).parent.parent
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
    while name_size > 18 and d.textlength(f"- {shown_name}", font=name_font) > text_w:
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
def _miq_save_png(img) -> bytes:
    buf = io.BytesIO()
    img.save(buf, "PNG", optimize=True)
    return buf.getvalue()


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
    font, wrapped, lh, _size = _miq_fit(
        d, shown_text, font_path, bubble[2] - bubble[0] - 130, bubble[3] - bubble[1] - 120,
        max_size=64, min_size=20,
    )
    ty = cy - (len(wrapped) * lh) // 2
    for line in wrapped:
        if line:
            d.text((cx, ty), line, font=font, fill=(0, 0, 0), anchor="ma")
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
    font, wrapped, lh, _size = _miq_fit(d, shown_text, font_path, right_edge - rx, 210, max_size=54, min_size=20)
    ty = 248
    for line in wrapped:
        if line:
            d.text((rx, ty), line, font=font, fill=(255, 255, 255, 255))
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
    font, wrapped, lh, _size = _miq_fit(
        d, shown_text, font_path, W - 72, band_bottom - band_top - 28,
        max_size=58, min_size=20,
    )
    ty = band_top + (band_bottom - band_top - len(wrapped) * lh) // 2
    for line in wrapped:
        if line:
            d.text((36, ty), line, font=font, fill=(16, 20, 28, 255))
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
    font, wrapped, lh, _size = _miq_fit(d, shown_text, font_path, W - 96, 268, max_size=46, min_size=20)
    ty = 178
    for line in wrapped:
        if line:
            d.text((48, ty), line, font=font, fill=ink)
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
    font, wrapped, lh, _size = _miq_fit(
        d, shown_text, font_path, (wx1 - wx0) - 72, (wy1 - wy0) - 84,
        max_size=42, min_size=20,
    )
    ty = wy0 + 40
    for line in wrapped:
        if line:
            d.text((wx0 + 36, ty), line, font=font, fill=(255, 255, 255, 255))
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
    font, wrapped, lh, _size = _miq_fit(d, shown_text, font_path, 620, 440, max_size=58, min_size=22)
    ty = (H - len(wrapped) * lh) // 2
    for line in wrapped:
        if line:
            d.text((56, ty), line, font=font, fill=(255, 255, 255), stroke_width=1, stroke_fill=(255, 255, 255))
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
    font, wrapped, lh, _size = _miq_fit(d, shown_text, font_path, wx1 - tx - 30, wy1 - wy0 - 56, max_size=38, min_size=16)
    ty = wy0 + 30
    for line in wrapped:
        if line:
            d.text((tx, ty), line, font=font, fill=(255, 255, 255))
        ty += lh

    # 右下の送り印 ▼
    vx, vy = wx1 - 52, wy1 - 42
    d.polygon([(vx - 12, vy), (vx + 12, vy), (vx, vy + 14)], fill=(255, 255, 255))
    return _miq_save_png(img)


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
    font, wrapped, lh, _size = _miq_fit(d, shown_text, serif, W - tx - 50, 300, max_size=56, min_size=22)
    ty = 150
    for line in wrapped:
        if line:
            d.text((tx, ty), line, font=font, fill=(255, 255, 255))
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
    font, wrapped, lh, _size = _miq_fit(d, shown_text, font_path, 540, 360, max_size=58, min_size=22)
    ty = max(90, (470 - len(wrapped) * lh) // 2 + 40)
    img = _miq_glow_lines(img, wrapped, 64, ty, lh, font, (196, 255, 255), (0, 224, 255))
    d = ImageDraw.Draw(img)

    # 左下: 表示名 (ピンクのグロー) + @username
    name_font = _miq_load_font(font_path, 30)
    shown_name = _miq_truncate(d, shown_name, name_font, 540)
    img = _miq_glow_lines(img, [shown_name], 64, 548, 40, name_font, (255, 190, 248), (255, 43, 214), blur=7)
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
    font, wrapped, lh, _size = _miq_fit(d, shown_text, font_path, 830, 290, max_size=64, min_size=24)
    ty = 472 - len(wrapped) * lh
    for line in wrapped:
        if line:
            d.text((56, ty), line, font=font, fill=(255, 255, 255), stroke_width=2, stroke_fill=(255, 255, 255))
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
    font, wrapped, lh, _size = _miq_fit(d, shown_text, dela, 684, 420, max_size=54, min_size=22)
    ty = (card[1] + card[3]) // 2 - (len(wrapped) * lh) // 2
    for line in wrapped:
        if line:
            d.text((74, ty), line, font=font, fill=(10, 10, 10))
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
    font, wrapped, lh, _size = _miq_fit(d, shown_text, font_path, 576, 380, max_size=47, min_size=20)
    ty = (H - len(wrapped) * lh) // 2
    for line in wrapped:
        if line:
            d.text((60, ty), line, font=font, fill=(76, 74, 98))
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
    font, wrapped, lh, _size = _miq_fit(d, shown_text, font_path, 786, 176, max_size=50, min_size=21)
    ty = 226
    for line in wrapped:
        if line:
            d.text((94, ty), line, font=font, fill=ink, stroke_width=1, stroke_fill=ink)
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
    font, wrapped, lh, _size = _miq_fit(d, shown_text, hand, 586, 340, max_size=46, min_size=20)
    ty = (H - len(wrapped) * lh) // 2
    for line in wrapped:
        if line:
            d.text((150, ty), line, font=font, fill=(40, 54, 112))
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
}

# 日付 (対象メッセージの作成日) を date_str として受け取るフォーマット
_MIQ_DATED_FORMATS = frozenset({"blueprint", "card", "ticket"})


# ------------------------------------------------------------
# MIQ 隠し要素: アゴのひょっこり合成 (開発者向け。利用者向け文言には出さない)
# ------------------------------------------------------------
MIQ_AGO_RARE_RATE = 0.02
_MIQ_AGO_DIR = Path(__file__).resolve().parent.parent / "assets" / "miq_ago"
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


# ------------------------------------------------------------
# meme 作成 (画像 + 上下テキスト)。出力は常に PNG
# ------------------------------------------------------------
MEME_MAX_EDGE = 1200          # 生成画像の最大の一辺 (px)
MEME_MAX_TEXT = 100           # 上/下テキストそれぞれの最大文字数
MEME_MAX_IMAGE_BYTES = 8 * 1024 * 1024  # ベース画像の取得上限
MEME_WAIT_TIMEOUT = 120.0     # パネル経由フローで画像投稿を待つ秒数
MEME_IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp")

def _meme_font_path() -> str | None:
    """meme 用に太めのフォントを優先して選ぶ (DelaGothicOne → M PLUS 系 → 既定)。"""
    fonts = _miq_available_fonts()
    bold_file = _MIQ_ASSET_FONTS / "MPLUSRounded1c-Bold.ttf"
    if bold_file.exists():
        return str(bold_file)
    for needle in ("delagothic", "mplus", "rocknroll", "reggae"):
        for _key, _label, path in fonts:
            if path and needle in Path(path).name.lower().replace("_", ""):
                return path
    return fonts[0][2] if fonts else None


def _meme_fit(draw, text: str, font_path: str | None, max_w: int, max_h: int, *, max_size: int, min_size: int = 12):
    """meme の1ブロック (上 or 下) を領域に収めるフォントと折り返しを返す。"""
    size = max_size
    while True:
        font = _miq_load_font(font_path, size)
        lines = _miq_wrap(draw, text, font, max_w)
        lh = int(size * 1.3)
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


def render_meme_png(image_bytes: bytes | None, top_text: str, bottom_text: str, *, font_path: str | None = None) -> bytes:
    """ベース画像に上下テキスト (白文字+黒の太縁取り) を描いた meme 画像 (PNG) を返す。

    GIF アニメは1フレーム目を使う。上下ともテキストが空なら ValueError。
    画像として開けない場合も ValueError (呼び出し側でユーザー向け文面にする)。
    """
    from PIL import Image, ImageDraw

    top = _miq_clean_text(top_text)[:MEME_MAX_TEXT].strip()
    bottom = _miq_clean_text(bottom_text)[:MEME_MAX_TEXT].strip()
    if not top and not bottom:
        raise ValueError("上テキストと下テキストのどちらかは必要です")
    if not image_bytes:
        raise ValueError("ベース画像がありません")
    try:
        src = Image.open(io.BytesIO(image_bytes))
        src.seek(0)  # GIF 等は1フレーム目
        img = src.convert("RGB")
    except Exception as exc:
        raise ValueError("画像として読み込めませんでした") from exc
    if img.width * img.height > 60_000_000:
        raise ValueError("画像のピクセル数が大きすぎます")

    # サイズ調整: 最大 MEME_MAX_EDGE に収め、小さい画像は最大2倍まで拡大
    scale = min(MEME_MAX_EDGE / img.width, MEME_MAX_EDGE / img.height)
    if scale < 1.0:
        img = img.resize((max(1, int(img.width * scale)), max(1, int(img.height * scale))), Image.LANCZOS)
    elif scale > 2.0:
        img = img.resize((img.width * 2, img.height * 2), Image.LANCZOS)
    W, H = img.size

    d = ImageDraw.Draw(img)
    margin_x = max(10, int(W * 0.04))
    margin_y = max(8, int(H * 0.03))
    max_w = W - margin_x * 2
    band_h = int(H * 0.30)
    max_size = max(16, W // 9)

    def draw_block(text: str, *, at_top: bool) -> None:
        font, lines, lh, size = _meme_fit(d, text, font_path, max_w, band_h, max_size=max_size)
        block_h = len(lines) * lh
        y = margin_y if at_top else H - margin_y - block_h
        sw = max(2, size // 9)
        for line in lines:
            if line:
                d.text((W // 2, y), line, font=font, fill=(255, 255, 255),
                       anchor="ma", stroke_width=sw, stroke_fill=(0, 0, 0))
            y += lh

    if top:
        draw_block(top, at_top=True)
    if bottom:
        draw_block(bottom, at_top=False)
    return _miq_save_png(img)


def _meme_image_attachment(message) -> object | None:
    """メッセージの添付から画像らしいものを1つ返す (無ければ None)。"""
    for att in getattr(message, "attachments", None) or []:
        content_type = (getattr(att, "content_type", None) or "").lower()
        if content_type.startswith("image/"):
            return att
        filename = (getattr(att, "filename", "") or "").lower()
        if filename.endswith(MEME_IMAGE_EXTS):
            return att
    return None


# ------------------------------------------------------------
# MIQ ユーザー設定(見た目・引用拒否)の保存
# ------------------------------------------------------------
# ユーザーごと(サーバー共通)の設定を data/miq.json に保存する。
# EXP と同様に、一時ファイル→置換のアトミック書き込み。保存先は環境変数 MIQ_DATA_PATH で変更可能。
MIQ_FILE = Path(
    os.getenv("MIQ_DATA_PATH")
    or (Path(__file__).resolve().parent.parent / "data" / "miq.json")
)

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
MIQ_TOGGLES = (
    ("grayscale", "モノクロ"),
    ("color_text", "文字色連動"),
    ("flip", "左右反転"),
    ("bold", "太字"),
    ("full", "全面レイアウト"),
)


class MiqToggleButton(discord.ui.Button):
    def __init__(self, parent: "MiqSettingsView", field: str, label: str, *, row: int, danger: bool = False):
        self.parent_view, self.field = parent, field
        on = bool(parent.prefs.get(field))
        if on:
            style = discord.ButtonStyle.danger if danger else discord.ButtonStyle.primary
        else:
            style = discord.ButtonStyle.secondary
        super().__init__(label=f"{label}: {'ON' if on else 'OFF'}", style=style, row=row)

    async def callback(self, interaction: discord.Interaction):
        parent = self.parent_view
        if not await parent.check_owner(interaction):
            return
        parent.prefs[self.field] = not parent.prefs.get(self.field)
        await parent.commit(interaction)


class MiqFontSelect(discord.ui.Select):
    def __init__(self, parent: "MiqSettingsView"):
        self.parent_view = parent
        current = parent.current_font_key()
        super().__init__(
            placeholder="フォントを選択",
            options=[discord.SelectOption(label=f"{label} ({key})"[:100], value=key, default=key == current)
                     for key, label, _path in parent.fonts],
            row=1,
        )

    async def callback(self, interaction: discord.Interaction):
        parent = self.parent_view
        if not await parent.check_owner(interaction):
            return
        parent.prefs["font"] = self.values[0]
        await parent.commit(interaction)


class MiqThemeSelect(discord.ui.Select):
    def __init__(self, parent: "MiqSettingsView"):
        self.parent_view = parent
        current = parent.prefs.get("theme")
        super().__init__(
            placeholder="配色を選択",
            options=[discord.SelectOption(label=label, value=key, emoji=emoji, default=key == current)
                     for key, (label, emoji, _bg, _fg) in MIQ_THEMES.items()],
            row=2,
        )

    async def callback(self, interaction: discord.Interaction):
        parent = self.parent_view
        if not await parent.check_owner(interaction):
            return
        parent.prefs["theme"] = self.values[0]
        await parent.commit(interaction)


class MiqFormatSelect(discord.ui.Select):
    def __init__(self, parent: "MiqSettingsView"):
        self.parent_view = parent
        current = parent.prefs.get("format")
        super().__init__(
            placeholder="フォーマットを選択",
            options=[discord.SelectOption(label=label, value=key, emoji=emoji, default=key == current)
                     for key, (label, emoji) in MIQ_FORMATS.items()],
            row=3,
        )

    async def callback(self, interaction: discord.Interaction):
        parent = self.parent_view
        if not await parent.check_owner(interaction):
            return
        parent.prefs["format"] = self.values[0]
        await parent.commit(interaction)


class MiqPreviewButton(discord.ui.Button):
    def __init__(self, parent: "MiqSettingsView"):
        self.parent_view = parent
        super().__init__(label="プレビュー", emoji="🖼️", style=discord.ButtonStyle.success, row=4)

    async def callback(self, interaction: discord.Interaction):
        parent = self.parent_view
        if not await parent.check_owner(interaction):
            return
        await interaction.response.defer(ephemeral=True, thinking=True)
        limit = getattr(interaction.guild, "filesize_limit", None)
        # ランダムは押すたびに1回だけ解決する
        resolved_fmt = miq_resolve_format(parent.prefs)
        if resolved_fmt == "line":
            # LINE風のプレビューはサンプルの2件会話で作る
            now = datetime.now(timezone.utc)
            avatar_bytes = None
            try:
                avatar_bytes = await interaction.user.display_avatar.replace(size=128, format="png").read()
            except Exception:
                logger.debug("MIQ: アバターの取得に失敗しました", exc_info=True)
                avatar_bytes = None
            entries = [
                {"name": "サンプル", "text": "こんにちは！", "created_at": now,
                 "avatar_bytes": None, "author_key": "miq-preview-other"},
                {"name": interaction.user.display_name, "text": "プレビューです。\n見た目の確認ができます。",
                 "created_at": now, "avatar_bytes": avatar_bytes, "author_key": "miq-preview-self"},
            ]
            file = await parent.cog._miq_render_line_file(entries, parent.prefs)
        else:
            eff_prefs = dict(parent.prefs)
            eff_prefs["format"] = resolved_fmt
            file = await parent.cog._miq_build_file(
                interaction.user, "プレビューです。\n見た目の確認ができます。", eff_prefs, limit,
            )
        if file is None:
            return await interaction.followup.send("プレビューを作れませんでした。時間をおいて再試行してください。", ephemeral=True)
        await interaction.followup.send(file=file, ephemeral=True)


class MiqResetButton(discord.ui.Button):
    def __init__(self, parent: "MiqSettingsView"):
        self.parent_view = parent
        super().__init__(label="見た目を初期化", style=discord.ButtonStyle.secondary, row=4)

    async def callback(self, interaction: discord.Interaction):
        parent = self.parent_view
        if not await parent.check_owner(interaction):
            return
        for key, default in MIQ_DEFAULT_PREFS.items():
            if key != "refuse":  # 引用拒否の設定は初期化しない
                parent.prefs[key] = default
        await parent.commit(interaction)


class MiqSettingsView(discord.ui.View):
    """MIQの見た目と引用拒否の設定パネル。設定はユーザーごとに保存され、MIQを作る時に使われる。"""

    def __init__(self, cog: "GeneralCog", user_id: int):
        super().__init__(timeout=300)
        self.cog, self.user_id = cog, user_id
        self.prefs = miq_get_prefs(user_id)
        self.fonts = _miq_available_fonts()
        self.refresh()

    def current_font_key(self) -> str:
        keys = [key for key, _label, _path in self.fonts]
        return self.prefs.get("font") if self.prefs.get("font") in keys else keys[0]

    def refresh(self):
        self.clear_items()
        for field, label in MIQ_TOGGLES:
            self.add_item(MiqToggleButton(self, field, label, row=0))
        self.add_item(MiqFontSelect(self))
        self.add_item(MiqThemeSelect(self))
        self.add_item(MiqFormatSelect(self))
        self.add_item(MiqToggleButton(self, "gif", "GIF出力", row=4))
        self.add_item(MiqToggleButton(self, "refuse", "引用を拒否", row=4, danger=True))
        self.add_item(MiqPreviewButton(self))
        self.add_item(MiqResetButton(self))

    async def check_owner(self, interaction: discord.Interaction) -> bool:
        if interaction.user.id == self.user_id:
            return True
        await interaction.response.send_message("この設定画面を開いたユーザーだけ変更できます。", ephemeral=True)
        return False

    async def commit(self, interaction: discord.Interaction):
        ok = await miq_save_prefs(self.user_id, self.prefs)
        self.refresh()
        await edit_panel_v2(interaction, as_panel_v2(self))
        if not ok:
            try:
                await interaction.followup.send("設定の保存に失敗しました。時間をおいて再試行してください。", ephemeral=True)
            except discord.HTTPException:
                logger.debug("MIQ: 設定保存の失敗通知の送信に失敗しました", exc_info=True)

    def embed(self) -> discord.Embed:
        p = self.prefs

        def onoff(value) -> str:
            return "ON" if value else "OFF"

        font_key = self.current_font_key()
        font_label = next((label for key, label, _path in self.fonts if key == font_key), font_key)
        theme_label = MIQ_THEMES.get(p.get("theme"), MIQ_THEMES["bw"])[0]
        format_label = MIQ_FORMATS.get(p.get("format"), MIQ_FORMATS["random"])[0]
        lines = [
            "**見た目**（あなたがMIQを作る時に使われます）",
            f"フォーマット: `{format_label}`",
            "未設定の既定はランダムです。ランダムでは生成のたびに単体フォーマットから1つ選ばれます（LINE風は選ばれません）。",
            f"モノクロ: `{onoff(p['grayscale'])}`　文字色連動: `{onoff(p['color_text'])}`　左右反転: `{onoff(p['flip'])}`",
            f"太字: `{onoff(p['bold'])}`　全面レイアウト: `{onoff(p['full'])}`　GIF出力: `{onoff(p['gif'])}`",
            f"フォント: `{font_label}`　配色: `{theme_label}`",
            "",
            "**引用の拒否**",
            f"あなたのメッセージの引用を拒否: `{onoff(p['refuse'])}`",
            "ONにすると、他の人はあなたのメッセージをMIQにできません（自分の引用は可能）。",
            "",
            "GIF出力はアイコンがGIFアニメの時だけ有効です（それ以外はPNG）。",
            "引用 (従来) 以外のフォーマットは常にPNGです（モノクロ等の設定は引用 (従来) 専用）。",
            "LINE風は画像・スタンプ・絵文字の合成にも対応し、画像やスタンプだけのメッセージも変換できます。",
        ]
        return discord.Embed(title="MIQ設定", description="\n".join(lines), color=0xFFFFFF)


# ------------------------------------------------------------
# meme 作成 UI (モーダル + 画像待ちキャンセル)
# ------------------------------------------------------------
class MemeTextModal(discord.ui.Modal, title="memeを作成"):
    """上/下テキストを聞くモーダル。送信後の処理は handler に委ねる。

    handler は async callable(interaction, top_text, bottom_text)。
    入口が /general パネル (画像は後から投稿してもらう) と右クリック
    メニュー (画像は対象メッセージから確定済み) で異なるため分離している。
    """

    top_text = discord.ui.TextInput(
        label="上テキスト", required=False, max_length=MEME_MAX_TEXT,
        placeholder="例: テスト前日なのに",
    )
    bottom_text = discord.ui.TextInput(
        label="下テキスト", required=False, max_length=MEME_MAX_TEXT,
        placeholder="例: 全然勉強してない",
    )

    def __init__(self, handler):
        super().__init__()
        self.handler = handler

    async def on_submit(self, interaction: discord.Interaction):
        top = (self.top_text.value or "").strip()
        bottom = (self.bottom_text.value or "").strip()
        if not top and not bottom:
            return await interaction.response.send_message(
                "上テキストと下テキストのどちらかは入力してください。", ephemeral=True
            )
        await self.handler(interaction, top, bottom)


class MemeCancelView(discord.ui.View):
    """パネル経由の meme 作成で、画像待ちをキャンセルするためのボタン。"""

    def __init__(self, cog: "GeneralCog", key: tuple[int, int], user_id: int):
        super().__init__(timeout=MEME_WAIT_TIMEOUT + 30)
        self.cog, self.key, self.user_id = cog, key, user_id

    @discord.ui.button(label="キャンセル", style=discord.ButtonStyle.secondary)
    async def cancel(self, interaction: discord.Interaction, button: discord.ui.Button):
        if interaction.user.id != self.user_id:
            return await interaction.response.send_message(
                "meme作成を開始したユーザーだけキャンセルできます。", ephemeral=True
            )
        event = self.cog._meme_waits.get(self.key)
        if event is not None:
            event.set()
        await interaction.response.edit_message(content="meme作成をキャンセルしました。", view=None)


# ============================================================
# 既存 UI
# ============================================================
class PayModal(discord.ui.Modal, title="コインを送金"):
    receiver_id = discord.ui.TextInput(label="送金先のユーザーID", max_length=20)
    amount = discord.ui.TextInput(label="送金するAGO", max_length=9)

    def __init__(self, cog):
        super().__init__()
        self.cog = cog

    async def on_submit(self, interaction):
        try:
            receiver = await self.cog.bot.fetch_user(int(self.receiver_id.value))
            amount = int(self.amount.value)
        except (ValueError, discord.HTTPException):
            return await interaction.response.send_message("ユーザーIDまたは数量が正しくありません。", ephemeral=True)
        await self.cog.bot.get_cog("WalletCog").pay(interaction, receiver, amount)


class GeneralHistorySelect(discord.ui.Select):
    """「よく使う／最近使った」機能への近道（履歴があるときだけ最上段に出る）。"""

    def __init__(self, cog, specs, row: int = 0):
        self.cog = cog
        super().__init__(
            placeholder="よく使う／最近使った機能",
            options=[
                discord.SelectOption(label=f"⭐ {spec.label}", value=spec.value)
                for spec in specs
            ],
            row=row,
        )

    async def callback(self, interaction):
        await self.cog.dispatch_general(interaction, self.values[0])


class GeneralGenreSelect(discord.ui.Select):
    def __init__(self, cog, selected: str | None = None, row: int = 0):
        self.cog = cog
        super().__init__(
            placeholder="ジャンルを選択してください",
            options=[discord.SelectOption(label=label, description=f"{len(GENERAL_ACTIONS[value])}個の機能", value=value,
                                          default=value == selected)
                     for value, (label, _description) in GENERAL_GENRES.items()],
            row=row,
        )

    async def callback(self, interaction):
        view: GeneralPanel = self.view
        wrapper = view if hasattr(view, "panel") else None
        view = getattr(view, "panel", view)
        view.genre = self.values[0]
        view.action = None
        if wrapper is not None:
            wrapper.refresh()
            return await edit_panel_v2(interaction, wrapper)
        view.refresh()
        return await edit_panel_v2(interaction, as_panel_v2(view))


class GeneralActionSelect(discord.ui.Select):
    def __init__(self, cog, genre: str, row: int = 1):
        self.cog = cog
        self.genre = genre
        super().__init__(
            placeholder="機能を選択してください",
            options=[discord.SelectOption(label=label, value=value) for label, value in GENERAL_ACTIONS[genre]],
            row=row,
        )

    async def callback(self, interaction):
        view: GeneralPanel = self.view
        panel = getattr(view, "panel", view)
        panel.action = self.values[0]
        if panel.shortcut_mode:
            if hasattr(view, "_sync"):
                view._sync()
                return await edit_panel_v2(interaction, view)
            return await edit_panel_v2(interaction, as_panel_v2(panel))
        await self.cog.dispatch_general(interaction, self.values[0])


class TranslationLocaleSelect(discord.ui.Select):
    def __init__(self, parent: "TranslationView", *, source: bool):
        self.parent_view = parent
        self.source = source
        locales = translation.SOURCE_LOCALES if source else localization.SUPPORTED_LOCALES
        current = parent.source_locale if source else parent.target_locale
        labels = translation.SOURCE_LOCALE_LABELS if source else localization.LOCALE_LABELS
        flags = translation.SOURCE_LOCALE_FLAGS if source else localization.LOCALE_FLAGS
        super().__init__(
            placeholder="翻訳前の言語を選択してください" if source else "翻訳後の言語を選択してください",
            options=[
                discord.SelectOption(label=labels[locale], value=locale, emoji=flags[locale], default=locale == current)
                for locale in locales
            ],
            row=0 if source else 1,
        )

    async def callback(self, interaction: discord.Interaction):
        locale = (
            translation.normalize_source_locale(self.values[0])
            if self.source else localization.normalize_locale(self.values[0])
        )
        if self.source:
            self.parent_view.source_locale = locale
            await translation_settings_update(self.parent_view.user_id, source_locale=locale)
        else:
            self.parent_view.target_locale = locale
            await translation_settings_update(self.parent_view.user_id, target_locale=locale)
        await interaction.response.edit_message(embed=self.parent_view.embed(), view=self.parent_view)


class TranslationToggleButton(discord.ui.Button):
    def __init__(self, parent: "TranslationView", enabled: bool):
        self.parent_view = parent
        super().__init__(
            label="自動翻訳をオフにする" if enabled else "自動翻訳をオンにする",
            style=discord.ButtonStyle.danger if enabled else discord.ButtonStyle.success,
            row=2,
        )

    async def callback(self, interaction: discord.Interaction):
        self.parent_view.enabled = not self.parent_view.enabled
        await translation_settings_update(self.parent_view.user_id, enabled=self.parent_view.enabled)
        self.parent_view.refresh()
        await interaction.response.edit_message(embed=self.parent_view.embed(), view=self.parent_view)


async def translation_settings_update(
    user_id: int, *, enabled: bool | None = None,
    source_locale: str | None = None, target_locale: str | None = None,
):
    return await translation.update_translation_settings(
        user_id, enabled=enabled, source_locale=source_locale, target_locale=target_locale
    )


class TranslationView(discord.ui.View):
    def __init__(self, user_id: int, guild_id: int):
        super().__init__(timeout=600)
        self.user_id, self.guild_id = user_id, guild_id
        settings = translation.translation_settings(user_id, guild_id)
        self.enabled = settings["enabled"]
        self.source_locale = settings["source_locale"]
        self.target_locale = settings["target_locale"]
        self.refresh()

    def refresh(self):
        self.clear_items()
        self.add_item(TranslationLocaleSelect(self, source=True))
        self.add_item(TranslationLocaleSelect(self, source=False))
        self.add_item(TranslationToggleButton(self, self.enabled))

    def embed(self):
        status = "オン" if self.enabled else "オフ"
        source = translation.SOURCE_LOCALE_LABELS[self.source_locale]
        target = localization.LOCALE_LABELS[self.target_locale]
        return discord.Embed(
            title="自動翻訳設定",
            description=(
                f"状態: **{status}**\n"
                f"翻訳前: **{source}** → 翻訳後: **{target}**\n\n"
                "オンにすると、あなたのメッセージを削除し、"
                "送信者の名前とアイコンで翻訳結果を再投稿します。"
            ),
            color=0x5865F2,
        )


class GeneralPanel(discord.ui.View):
    def __init__(self, cog, genre: str | None = None, shortcut_mode: bool = False, shortcut_item: dict | None = None,
                 history_specs: list | None = None):
        super().__init__(timeout=300)
        self.cog = cog
        saved = (shortcut_item or {}).get("action", {})
        self.genre = genre or saved.get("genre")
        self.action = saved.get("value")
        self.shortcut_mode = shortcut_mode
        self.shortcut_item = shortcut_item
        # 「よく使う／最近」の対象（core.action_usage.history_panel_specs の結果）。
        # 空ならセクション自体を出さず、従来の見た目と完全同一に保つ。
        self.history_specs = list(history_specs or [])
        self.refresh()

    def refresh(self):
        self.clear_items()
        offset = 0
        if self.history_specs:
            self.add_item(GeneralHistorySelect(self.cog, self.history_specs, row=0))
            offset = 1
        self.add_item(GeneralGenreSelect(self.cog, self.genre, row=offset))
        if self.genre:
            self.add_item(GeneralActionSelect(self.cog, self.genre, row=offset + 1))
        if self.shortcut_mode:
            self.add_item(ShortcutCommitButton())

    def shortcut_action(self):
        if not self.genre or not self.action:
            return None
        return {"root": "general", "genre": self.genre, "value": self.action}

    def embed(self):
        return discord.Embed(title="一般機能", color=0xFFFFFF)


def shortcut_vc_params(value: str, params: dict) -> dict:
    """vc ショートカットの params を ParamSpec で検証し、定義済みキーだけを返す。

    保存データが古い・壊れている場合でも実行自体は止めず、不正なキー・値は
    そのキーだけ落として実行する（落としたことはログに残す）。
    """
    if not params:
        return {}
    spec = action_registry.default_registry().get(f"vc:{value}")
    if spec is None or not spec.params:
        return {}
    cleaned: dict = {}
    for name, raw in params.items():
        try:
            cleaned.update(action_registry.validate_params(spec, {name: raw}))
        except ValueError:
            logger.warning("shortcut vc params dropped: %s.%s=%r", value, name, raw)
    return cleaned


class ShortcutNameModal(discord.ui.Modal, title="ショートカット名"):
    trigger = discord.ui.TextInput(
        label="メッセージで送るトリガー（空白なし）", max_length=80,
        placeholder="例: VC参加", required=True,
    )

    def __init__(self, cog: "GeneralCog", action: dict, item: dict | None = None,
                 params: dict | None = None):
        super().__init__()
        self.cog, self.action, self.item = cog, action, item
        # params はパラメータ設定ステップを経たときだけ渡される（None は変更しない）。
        self.params = params
        if item:
            self.trigger.default = item.get("trigger", "")

    async def on_submit(self, interaction: discord.Interaction):
        try:
            store = guild_settings.get_store()
            if self.item:
                await shortcuts.update(store, interaction.guild_id, interaction.user.id,
                                       self.item["id"], self.trigger.value, self.action,
                                       params=self.params)
                text = "ショートカットを編集しました。"
            else:
                await shortcuts.add(store, interaction.guild_id, interaction.user.id,
                                    self.trigger.value, self.action, params=self.params)
                text = "ショートカットを登録しました。"
        except (ValueError, KeyError) as exc:
            return await interaction.response.send_message(str(exc), ephemeral=True)
        await interaction.response.send_message(
            embed=discord.Embed(title=text, description=f"トリガー: `{self.trigger.value}`", color=0x2ECC71),
            ephemeral=True,
        )


class ShortcutParamSelect(discord.ui.Select):
    """choice / bool 型パラメータ1件の設定セレクト。"""

    def __init__(self, parent: "ShortcutParamsView", param, row: int):
        self.parent_view = parent
        self.param = param
        if param.type == "choice":
            options = [
                discord.SelectOption(label=str(label), value=str(value),
                                     default=parent.params.get(param.name) == value)
                for label, value in param.choices
            ]
        else:  # bool
            options = [
                discord.SelectOption(label="オン", value="true",
                                     default=parent.params.get(param.name) is True),
                discord.SelectOption(label="オフ", value="false",
                                     default=parent.params.get(param.name) is False),
            ]
        super().__init__(placeholder=f"{param.label}を選択", options=options, row=row)

    async def callback(self, interaction: discord.Interaction):
        raw = self.values[0]
        if self.param.type == "bool":
            value: object = raw == "true"
        else:
            value = next((v for _label, v in self.param.choices if str(v) == raw), raw)
        self.parent_view.params[self.param.name] = value
        self.parent_view.refresh()
        await interaction.response.edit_message(embed=self.parent_view.embed(), view=self.parent_view)


class ShortcutParamModal(discord.ui.Modal, title="パラメータ設定"):
    """int / number / text 型パラメータをまとめて入力するモーダル（最大5件）。"""

    def __init__(self, parent: "ShortcutParamsView"):
        super().__init__()
        self.parent_view = parent
        self.inputs: dict[str, discord.ui.TextInput] = {}
        for param in parent.modal_params[:5]:
            current = parent.params.get(param.name)
            item = discord.ui.TextInput(
                label=param.label[:45],
                required=False,
                default="" if current is None else str(current),
                placeholder=param.help or "未入力なら既定値のまま",
                style=(discord.TextStyle.paragraph if param.name == "lyrics"
                       else discord.TextStyle.short),
            )
            self.inputs[param.name] = item
            self.add_item(item)

    async def on_submit(self, interaction: discord.Interaction):
        view = self.parent_view
        by_name = {param.name: param for param in view.spec.params}
        errors: list[str] = []
        for name, item in self.inputs.items():
            param = by_name[name]
            raw = item.value.strip()
            if not raw:
                view.params.pop(name, None)
                continue
            try:
                if param.type == "int":
                    value: object = int(raw)
                elif param.type in {"number", "duration"}:
                    value = float(raw)
                else:
                    value = raw
                action_registry.validate_params(view.spec, {name: value})
            except ValueError as exc:
                errors.append(str(exc))
                continue
            view.params[name] = value
        if errors:
            return await interaction.response.send_message(
                "入力に誤りがあります:\n" + "\n".join(errors), ephemeral=True)
        view.refresh()
        await interaction.response.edit_message(embed=view.embed(), view=view)


class ShortcutParamInputButton(discord.ui.Button):
    def __init__(self, parent: "ShortcutParamsView", row: int):
        self.parent_view = parent
        super().__init__(label="数値・テキストを入力", style=discord.ButtonStyle.primary, row=row)

    async def callback(self, interaction: discord.Interaction):
        await interaction.response.send_modal(ShortcutParamModal(self.parent_view))


class ShortcutParamsCommitButton(discord.ui.Button):
    def __init__(self, parent: "ShortcutParamsView"):
        self.parent_view = parent
        super().__init__(label="この内容で決定", style=discord.ButtonStyle.success, row=4)

    async def callback(self, interaction: discord.Interaction):
        view = self.parent_view
        await interaction.response.send_modal(
            ShortcutNameModal(view.cog, view.action, view.item, params=dict(view.params)))


class ShortcutParamsSkipButton(discord.ui.Button):
    def __init__(self, parent: "ShortcutParamsView"):
        self.parent_view = parent
        super().__init__(label="設定しない（既定値で登録）", style=discord.ButtonStyle.secondary, row=4)

    async def callback(self, interaction: discord.Interaction):
        view = self.parent_view
        # 編集時に既存プリセットを消す意味も含め、空の params で登録へ進む。
        await interaction.response.send_modal(
            ShortcutNameModal(view.cog, view.action, view.item, params={}))


class ShortcutParamsView(discord.ui.View):
    """ショートカット登録時のパラメータ設定ステップ。

    ParamSpec を持つアクションを選んだときだけ、名前モーダルの前に挟む。
    パラメータは登録時のプリセット専用で、メッセージ経由の実行時に追加で
    聞くことはしない（モーダルを出せないため。仕様書 D-4）。
    """

    def __init__(self, cog: "GeneralCog", action: dict, item: dict | None, spec):
        super().__init__(timeout=300)
        self.cog, self.action, self.item, self.spec = cog, action, item, spec
        self.params: dict = {}
        saved = (item or {}).get("action", {})
        if (item and saved.get("root") == action.get("root")
                and saved.get("value") == action.get("value")):
            # 編集時は保存済みプリセットを初期表示する。
            names = {param.name for param in spec.params}
            self.params = {key: value for key, value in shortcuts.effective_params(item).items()
                           if key in names}
        self.select_params = [p for p in spec.params if p.type in {"choice", "bool"}]
        self.modal_params = [p for p in spec.params
                             if p.type in {"text", "int", "number", "duration"}]
        self.refresh()

    def refresh(self):
        self.clear_items()
        for index, param in enumerate(self.select_params[:4]):
            self.add_item(ShortcutParamSelect(self, param, row=index))
        if self.modal_params:
            # セレクトが4行を占める場合は入力ボタンも最終行に同居させる。
            row = len(self.select_params) if len(self.select_params) < 4 else 4
            self.add_item(ShortcutParamInputButton(self, row=row))
        self.add_item(ShortcutParamsCommitButton(self))
        self.add_item(ShortcutParamsSkipButton(self))

    def embed(self):
        lines = []
        for param in self.spec.params:
            value = self.params.get(param.name)
            shown = "（未設定：既定値）" if value is None else f"`{value}`"
            suffix = " ※実行に必要" if param.required else ""
            lines.append(f"**{param.label}**: {shown}{suffix}")
        return discord.Embed(
            title=f"パラメータ設定: {self.spec.label}",
            description=(
                "ショートカットに保存する値（プリセット）を設定してください。\n"
                "未設定の項目は実行時の既定値が使われます。パラメータは登録時の設定専用で、"
                "メッセージで実行するときに追加で聞かれることはありません。\n\n"
                + "\n".join(lines)
            ),
            color=0xFFFFFF,
        )


class ShortcutRootSelect(discord.ui.Select):
    def __init__(self, parent: "ShortcutBuilderView", selected: str | None = None):
        self.parent_view = parent
        super().__init__(placeholder="大区分コマンドを選択", options=[
            discord.SelectOption(label=label, value=root, default=root == selected)
            for root, (label, _) in SHORTCUT_ROOTS.items()
        ], row=0)

    async def callback(self, interaction: discord.Interaction):
        if isinstance(self.parent_view, ShortcutRootPanel):
            return await self.parent_view.open_existing_panel(interaction, self.values[0])
        self.parent_view.root = self.values[0]
        self.parent_view.selected = None
        self.parent_view.refresh()
        if hasattr(self.view, "_sync"):
            self.view._sync()
            return await edit_panel_v2(interaction, self.view)
        return await edit_panel_v2(interaction, as_panel_v2(self.parent_view))


class ShortcutRootPanel(discord.ui.View):
    def __init__(self, item: dict | None = None):
        super().__init__(timeout=300)
        self.item = item
        action = item.get("action", {}) if item else {}
        self.root = action.get("root")
        self.add_item(ShortcutRootSelect(self, self.root))

    def embed(self):
        return discord.Embed(title="ショートカット登録", color=0xFFFFFF)

    async def open_existing_panel(self, interaction, root: str):
        from core.panel_v2 import as_panel_v2, edit_panel_v2
        bot = interaction.client
        if root == "general":
            panel = GeneralPanel(bot.get_cog("GeneralCog"), shortcut_mode=True, shortcut_item=self.item)
        elif root == "vc":
            from cogs.sio_voice import VoicePanelView
            panel = VoicePanelView(bot.get_cog("VoiceHub"), shortcut_mode=True, shortcut_item=self.item)
        elif root == "game":
            from cogs.game import GameHubView
            panel = GameHubView(bot.get_cog("GameHub"), shortcut_mode=True, shortcut_item=self.item)
        elif root == "support":
            from cogs.support import SupportPanelView
            panel = SupportPanelView(bot.get_cog("SupportCog"), shortcut_mode=True, shortcut_item=self.item)
        else:
            from cogs.help import HelpView
            help_cog = bot.get_cog("HelpCog")
            panel = HelpView(help_cog.catalog(), shortcut_mode=True, shortcut_item=self.item)
        if panel is None:
            return await interaction.response.send_message("対象のパネルが読み込まれていません。", ephemeral=True)
        await edit_panel_v2(interaction, as_panel_v2(panel))


class ShortcutCommitButton(discord.ui.Button):
    def __init__(self):
        super().__init__(label="この内容で決定", style=discord.ButtonStyle.success, row=4)

    async def callback(self, interaction: discord.Interaction):
        panel = getattr(self.view, "panel", self.view)
        action = panel.shortcut_action()
        if action is None:
            return await interaction.response.send_message("機能を選択してから決定してください。", ephemeral=True)
        cog = interaction.client.get_cog("GeneralCog")
        item = getattr(panel, "shortcut_item", None)
        spec = action_registry.default_registry().get(
            f"{action.get('root')}:{action.get('value')}")
        if spec is not None and spec.params:
            # ParamSpec を持つアクションだけ、名前モーダルの前にパラメータ設定を挟む。
            view = ShortcutParamsView(cog, action, item, spec)
            return await interaction.response.send_message(embed=view.embed(), view=view, ephemeral=True)
        await interaction.response.send_modal(ShortcutNameModal(cog, action, item))


class ShortcutManageSelect(discord.ui.Select):
    def __init__(self, parent: "ShortcutManagerView", mode: str):
        self.parent_view, self.mode = parent, mode
        rows = shortcuts.for_user(guild_settings.get_store(), parent.guild_id, parent.user_id)
        options = [
            discord.SelectOption(label=str(x.get("trigger", "不明"))[:100], value=str(x["id"])) for x in rows
        ][:25]
        if not options:
            options = [discord.SelectOption(label="登録されていません", value="__none__")]
        super().__init__(placeholder="対象のショートカットを選択", options=options)

    async def callback(self, interaction: discord.Interaction):
        if self.values[0] == "__none__":
            return await interaction.response.send_message("ショートカットが登録されていません。", ephemeral=True)
        rows = shortcuts.for_user(guild_settings.get_store(), interaction.guild_id, interaction.user.id)
        item = next((x for x in rows if x.get("id") == self.values[0]), None)
        if item is None:
            return await interaction.response.send_message("ショートカットが見つかりません。", ephemeral=True)
        if self.mode == "delete":
            await shortcuts.remove(guild_settings.get_store(), interaction.guild_id, interaction.user.id, item["id"])
            wrapper = getattr(self.view, "panel", None)
            if wrapper is not None:
                wrapper._sync()
                return await edit_panel_v2(interaction, self.view)
            return await edit_panel_v2(interaction, as_panel_v2(self.parent_view))
        view = ShortcutRootPanel(item)
        await edit_panel_v2(interaction, as_panel_v2(view))


class ShortcutManagerView(discord.ui.View):
    def __init__(self, cog: "GeneralCog", guild_id: int, user_id: int):
        super().__init__(timeout=300)
        self.cog, self.guild_id, self.user_id = cog, guild_id, user_id

    def embed(self, notice: str | None = None):
        rows = shortcuts.for_user(guild_settings.get_store(), self.guild_id, self.user_id)
        lines = [f"`{x['trigger']}` → {x.get('action', {}).get('root')}/{x.get('action', {}).get('value')}" for x in rows]
        description = (notice + "\n\n" if notice else "") + ("\n".join(lines) or "登録はありません。")
        description += f"\n\n登録数: {len(rows)}/{shortcuts.MAX_SHORTCUTS}"
        return discord.Embed(title="ショートカット管理", description=description, color=0xFFFFFF)

    @discord.ui.button(label="登録", style=discord.ButtonStyle.success, row=0)
    async def register(self, interaction: discord.Interaction, button: discord.ui.Button):
        view = ShortcutRootPanel()
        await edit_panel_v2(interaction, as_panel_v2(view))

    @discord.ui.button(label="編集", style=discord.ButtonStyle.primary, row=0)
    async def edit(self, interaction: discord.Interaction, button: discord.ui.Button):
        view = ShortcutManagerView(self.cog, interaction.guild_id, interaction.user.id)
        view.add_item(ShortcutManageSelect(view, "edit"))
        await edit_panel_v2(interaction, as_panel_v2(view))

    @discord.ui.button(label="削除", style=discord.ButtonStyle.danger, row=0)
    async def delete(self, interaction: discord.Interaction, button: discord.ui.Button):
        view = ShortcutManagerView(self.cog, interaction.guild_id, interaction.user.id)
        view.add_item(ShortcutManageSelect(view, "delete"))
        await edit_panel_v2(interaction, as_panel_v2(view))

    @discord.ui.button(label="一覧更新", style=discord.ButtonStyle.secondary, row=0)
    async def refresh_list(self, interaction: discord.Interaction, button: discord.ui.Button):
        return await edit_panel_v2(interaction, as_panel_v2(self))


# ============================================================
# EXP パネル
# ============================================================
class ExpStatusView(discord.ui.View):
    def __init__(self, author_id: int, guild_id: int):
        super().__init__(timeout=300)
        self.author_id, self.guild_id = author_id, guild_id
        self._user_cache = _exp_ensure(_exp_root(), self.guild_id, self.author_id)

    async def _load_latest(self):
        data = await _exp_load()
        self._user_cache = _exp_ensure(data, self.guild_id, self.author_id)

    @staticmethod
    def _bar(cur: int, need: int, width: int = 12) -> str:
        if need <= 0:
            return "█" * width
        filled = min(width, int(width * cur / need))
        return "█" * filled + "░" * (width - filled)

    def embed(self) -> discord.Embed:
        chat_exp = _as_int(self._user_cache.get("chat_exp"))
        vc_exp = _as_int(self._user_cache.get("vc_exp"))
        cl, ccur, cneed = level_from_exp(chat_exp, CHAT_EXP_BASE, CHAT_EXP_RATIO)
        vl, vcur, vneed = level_from_exp(vc_exp, VC_EXP_BASE, VC_EXP_RATIO)
        gl = general_level(chat_exp, vc_exp)
        return discord.Embed(
            title="EXP状況",
            description=(
                f"**general Lv.{gl}**\n\n"
                f"**チャット** Lv.{cl} — {ccur}/{cneed} EXP\n"
                f"`{self._bar(ccur, cneed)}`\n\n"
                f"**VC** Lv.{vl} — {vcur}/{vneed} EXP\n"
                f"`{self._bar(vcur, vneed)}`"
            ),
            color=0x3498DB,
        )


class ExpRankingView(discord.ui.View):
    def __init__(self, guild_id: int):
        super().__init__(timeout=300)
        self.guild_id = guild_id
        self._data_cache = _exp_root()

    async def _load_latest(self):
        self._data_cache = await _exp_load()

    def embed(self) -> discord.Embed:
        guild = self._data_cache.get(str(self.guild_id), {})
        rows = []
        for uid, u in guild.items():
            chat_exp = _as_int(u.get("chat_exp"))
            vc_exp = _as_int(u.get("vc_exp"))
            gl = general_level(chat_exp, vc_exp)
            rows.append((gl, chat_exp, vc_exp, uid))
        rows.sort(key=lambda x: (x[0], x[1] + x[2]), reverse=True)
        lines = []
        for i, (gl, ce, ve, uid) in enumerate(rows[:20], start=1):
            lines.append(f"`{i:>2}.` <@{uid}> — general Lv.{gl}（chat {ce} / vc {ve}）")
        return discord.Embed(
            title="EXPランキング（general順）",
            description="\n".join(lines) or "まだEXPデータがありません。",
            color=0x9B59B6,
        )

    @discord.ui.button(label="更新", style=discord.ButtonStyle.secondary, row=0)
    async def refresh_btn(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self._load_latest()
        await edit_panel_v2(interaction, as_panel_v2(self))


# ============================================================
# AI 設定 UI
# ============================================================
MODEL_PAGE_SIZE = 25


class AIDefaultSelect(discord.ui.Select):
    def __init__(self, user_id: int, models: list[dict], kind: str = "chat", page: int = 0):
        self.user_id, self.kind = user_id, kind
        self.model_ids = {str(model.get("id")) for model in models if model.get("id")}
        self.page = page
        if kind == "chat":
            current = ai_preferences.get_model(user_id) or logfare.configured_default_model()
        else:
            current = ai_preferences.get_image_model(user_id) or logfare.DEFAULT_IMAGE_MODEL
        start = page * MODEL_PAGE_SIZE
        page_models = models[start:start + MODEL_PAGE_SIZE]
        options = []
        for model in page_models:
            model_id = str(model["id"])
            label = str(model.get("name") or model_id)
            if model.get("requires_training_optin"):
                label += "（同意が必要）"
            options.append(discord.SelectOption(
                label=label[:100], value=model_id, default=model_id == current,
            ))
        if not options:
            options = [discord.SelectOption(label="logfare/auto", value="logfare/auto")]
        super().__init__(placeholder="デフォルトAIを選択", options=options, row=0)

    async def callback(self, interaction: discord.Interaction):
        if interaction.user.id != self.user_id:
            return await interaction.response.send_message(
                "この設定画面を開いたユーザーだけ変更できます。", ephemeral=True
            )
        selected = self.values[0] if self.values else ""
        if selected not in self.model_ids:
            return await interaction.response.send_message(
                "選択したモデルは現在のモデル一覧にありません。設定画面を開き直してください。",
                ephemeral=True,
            )
        try:
            if self.kind == "chat":
                await ai_preferences.set_model(self.user_id, selected)
            else:
                await ai_preferences.set_image_model(self.user_id, selected)
        except Exception:
            logger.exception("AI model preference save failed: user=%s", self.user_id)
            return await interaction.response.send_message(
                "AI設定の保存に失敗しました。しばらくしてから再試行してください。", ephemeral=True
            )
        command = "!ai" if self.kind == "chat" else "!generate"
        await interaction.response.send_message(
            f"デフォルトAIを `{selected}` に設定しました。`{command} プロンプト` で使えます。",
            ephemeral=True,
        )


class AIDefaultPageButton(discord.ui.Button):
    def __init__(self, owner: "AIDefaultView", direction: int):
        self.owner_view, self.direction = owner, direction
        label = "前のページ" if direction < 0 else "次のページ"
        super().__init__(label=label, style=discord.ButtonStyle.secondary, row=1)

    async def callback(self, interaction: discord.Interaction):
        if interaction.user.id != self.owner_view.user_id:
            return await interaction.response.send_message(
                "この設定画面を開いたユーザーだけ操作できます。", ephemeral=True
            )
        next_page = self.owner_view.page + self.direction
        if next_page < 0 or next_page >= self.owner_view.page_count:
            return await interaction.response.send_message(
                "そのページは存在しません。設定画面を開き直してください。", ephemeral=True
            )
        self.owner_view.page = next_page
        self.owner_view.refresh_select()
        if hasattr(self.view, "panel"):
            await self.view.refresh(interaction)
        else:
            await interaction.response.edit_message(
                embed=self.owner_view.embed(), view=self.owner_view
            )


class AIDefaultView(discord.ui.View):
    def __init__(self, user_id: int, models: list[dict], kind: str = "chat", load_error: Exception | None = None):
        super().__init__(timeout=300)
        self.user_id = user_id
        self.kind, self.models, self.load_error = kind, models, load_error
        self.page = 0
        self.page_count = max(1, (len(models) + MODEL_PAGE_SIZE - 1) // MODEL_PAGE_SIZE)
        self.select = AIDefaultSelect(user_id, models, kind, self.page)
        self.add_item(self.select)
        if self.page_count > 1:
            self.add_item(AIDefaultPageButton(self, -1))
            self.add_item(AIDefaultPageButton(self, 1))

    def refresh_select(self):
        self.remove_item(self.select)
        self.select = AIDefaultSelect(self.user_id, self.models, self.kind, self.page)
        self.add_item(self.select)

    @classmethod
    async def create(cls, user_id: int, kind: str = "chat"):
        try:
            await ai_preferences.ensure_loaded()
            if kind == "image":
                models = await logfare.fetch_image_models()
            else:
                models = []
                if ai_provider_router.enabled():
                    name = ai_provider_router.logical_model() or "設定済みモデル"
                    models.append({"id": ai_provider_router.AUTO_MODEL,
                                   "name": f"自動切替: {name}"})
                logfare_error = None
                try:
                    models.extend(await logfare.fetch_free_chat_models())
                except Exception as exc:
                    logfare_error = exc
                try:
                    kios_models = await ai_provider_router.fetch_kiosapi_models()
                    models.extend({
                        **model,
                        "id": f"kiosapi::{model['id']}",
                        "name": f"KiosAPI · {model['id']}",
                    } for model in kios_models)
                except Exception:
                    logger.warning("AI設定: KiosAPI のモデル一覧の取得に失敗しました", exc_info=True)
                try:
                    apinex_models = await ai_provider_router.fetch_apinex_free_models()
                    models.extend({
                        **model,
                        "id": f"apinex::{model['id']}",
                        "name": f"APInex Free · {model['id'].removeprefix('free/')}",
                    } for model in apinex_models)
                except Exception:
                    logger.warning("AI設定: APInex のモデル一覧の取得に失敗しました", exc_info=True)
                models.extend(ai_omnirush.model_choices())
                if not models and logfare_error:
                    raise logfare_error
        except Exception as exc:
            return cls(user_id, [], kind, exc)
        return cls(user_id, models, kind)

    def embed(self):
        if self.kind == "chat":
            current = ai_preferences.get_model(self.user_id) or logfare.configured_default_model()
        else:
            current = ai_preferences.get_image_model(self.user_id) or logfare.DEFAULT_IMAGE_MODEL
        title = "AI設定" if self.kind == "chat" else "画像生成AI設定"
        return discord.Embed(
            title=title,
            description=(
                f"`{'!ai' if self.kind == 'chat' else '!generate'}` で使うデフォルトAIを選択してください。\n"
                f"現在: `{current}`\n\n"
                f"{'Logfare・KiosAPI・APInex Free・OmniRush CLIのチャット' if self.kind == 'chat' else 'Logfareの画像生成'}モデルを選べます。"
                f"{'自動切替を選ぶと設定済みのAPIを順に使います。' if self.kind == 'chat' else ''}"
                f"{'画像入力は対応モデルのみ利用できます。APInexはFreeモデルのみ表示します。OmniRushはBot実行ユーザーのログインと共有日次枠を使い、質問を同サービスへ送信します（[プライバシー](https://omnirush.ai/privacy)）。Logfareの一部モデルはトレーニング利用への同意が必要です。' if self.kind == 'chat' else ''}\n"
                f"モデル一覧 {self.page + 1}/{self.page_count}ページ（全{len(self.models)}件）"
            ),
            color=0xFFFFFF,
        )


class ReasoningSelect(discord.ui.Select):
    def __init__(self, user_id: int, model_id: str, efforts: list[str], current: str | None):
        self.user_id, self.model_id = user_id, model_id
        self.efforts = set(efforts)
        options = [discord.SelectOption(
            label="モデルの既定値", value="__default__", default=current is None,
        )]
        options.extend(
            discord.SelectOption(label=effort, value=effort, default=effort == current)
            for effort in efforts
        )
        super().__init__(placeholder="思考強度を選択", options=options, row=0)

    async def callback(self, interaction: discord.Interaction):
        if interaction.user.id != self.user_id:
            return await interaction.response.send_message(
                "この設定画面を開いたユーザーだけ変更できます。", ephemeral=True
            )
        selected = self.values[0] if self.values else ""
        if selected != "__default__" and selected not in self.efforts:
            return await interaction.response.send_message(
                "選択した思考強度は現在のモデルに対応していません。設定画面を開き直してください。",
                ephemeral=True,
            )
        try:
            if selected == "__default__":
                await ai_preferences.clear_reasoning_effort(self.user_id)
                label = "モデルの既定値"
            else:
                await ai_preferences.set_reasoning_effort(self.user_id, selected)
                label = selected
        except Exception:
            logger.exception("reasoning preference save failed: user=%s", self.user_id)
            return await interaction.response.send_message(
                "思考強度の保存に失敗しました。しばらくしてから再試行してください。", ephemeral=True
            )
        await interaction.response.send_message(
            f"思考強度を `{label}` に設定しました。", ephemeral=True
        )


class ReasoningView(discord.ui.View):
    def __init__(self, user_id: int, model_id: str, efforts: list[str]):
        super().__init__(timeout=300)
        self.user_id, self.model_id, self.efforts = user_id, model_id, efforts
        self.add_item(ReasoningSelect(
            user_id, model_id, efforts, ai_preferences.get_reasoning_effort(user_id)
        ))

    @classmethod
    async def create(cls, user_id: int):
        await ai_preferences.ensure_loaded()
        model_id = ai_preferences.get_model(user_id) or logfare.configured_default_model()
        if model_id == ai_provider_router.AUTO_MODEL:
            return None, "自動切替モデルでは、この思考強度設定を使えません。"
        if model_id.startswith("kiosapi::"):
            return None, f"モデル `{model_id.removeprefix('kiosapi::')}` はこの接続先の思考強度設定に対応していません。"
        if model_id.startswith("apinex::"):
            apinex_model = model_id.removeprefix("apinex::")
            efforts = ai_provider_router.supported_reasoning_efforts("apinex", apinex_model)
            if not efforts:
                return None, f"APInexモデル `{apinex_model}` は思考強度の設定に対応していません。"
            return cls(user_id, model_id, efforts), None
        if model_id.startswith("omnirush::"):
            efforts = ai_omnirush.supports_reasoning_efforts(model_id)
            if not efforts:
                return None, "選択したOmniRushモデルは思考強度を設定できません。"
            return cls(user_id, model_id, efforts), None
        models = await logfare.fetch_free_chat_models()
        model = next((item for item in models if item.get("id") == model_id), None)
        if model is None:
            return None, f"現在のモデル `{model_id}` の情報を取得できませんでした。先にデフォルトAIを設定してください。"
        efforts = logfare.reasoning_efforts(model)
        if not efforts:
            return None, f"現在のモデル `{model_id}` は思考強度の設定に対応していません。"
        return cls(user_id, model_id, efforts), None

    def embed(self):
        current = ai_preferences.get_reasoning_effort(self.user_id) or "モデルの既定値"
        return discord.Embed(
            title="思考強度設定",
            description=(
                f"モデル `{self.model_id}` の思考強度を選択してください。\n"
                f"現在: `{current}`\n対応値: {', '.join(self.efforts)}"
            ),
            color=0xFFFFFF,
        )


# ============================================================
# Cog
# ============================================================
class GeneralCog(commands.Cog):
    def __init__(self, bot):
        self.bot = bot
        self._bg_tasks: set[asyncio.Task] = set()
        self._levelup_sem = asyncio.Semaphore(2)  # 画像生成の同時実行数(低スペック機での詰まり防止)
        self._levelup_pillow_warned = False
        self._miq_last: dict[int, float] = {}
        self._translation_client = LibreTranslateClient()
        self._translation_webhooks: dict[int, discord.Webhook] = {}
        # メッセージの右クリックメニュー(アプリ → Make it a Quote)
        self.miq_menu = app_commands.ContextMenu(name="Make it a Quote", callback=self.miq_context)
        # メッセージの右クリックメニュー(アプリ → Make it a Meme)
        self.meme_menu = app_commands.ContextMenu(name="Make it a Meme", callback=self.meme_context)
        # meme作成のパネル経由フローで画像待ち中のセッション {(channel_id, user_id): Event}
        self._meme_waits: dict[tuple[int, int], asyncio.Event] = {}

    async def cog_load(self):
        await translation.ensure_loaded()
        self.exp_vc_tick.start()
        self.bot.tree.add_command(self.miq_menu, override=True)
        self.bot.tree.add_command(self.meme_menu, override=True)

    def cog_unload(self):
        self.exp_vc_tick.cancel()
        self.bot.tree.remove_command(self.miq_menu.name, type=self.miq_menu.type)
        self.bot.tree.remove_command(self.meme_menu.name, type=self.meme_menu.type)
        for task in list(self._bg_tasks):
            task.cancel()

    @app_commands.command(name="general", description="一般機能の操作パネルを表示します")
    async def general(self, interaction: discord.Interaction):
        # Building the panel may touch lazily loaded settings/models.  Reserve
        # the interaction response before doing any work so Discord's 3-second
        # acknowledgement deadline cannot turn a valid command into 10062.
        await interaction.response.defer(ephemeral=True, thinking=True)
        history_specs = []
        if interaction.guild_id is not None:
            store = guild_settings.get_store()
            await store.ensure_loaded()
            history_specs = action_usage.history_panel_specs(
                store, interaction.guild_id, interaction.user.id, "general")
        view = GeneralPanel(self, history_specs=history_specs)
        await interaction.followup.send(view=as_panel_v2(view), ephemeral=True)

    async def _safe_respond(self, interaction: discord.Interaction, message: str, *, ephemeral: bool = True):
        """interaction の応答状態に応じて安全にメッセージを返す。

        通常の Interaction でも ShortcutMessageInteraction（メッセージアダプタ）でも
        同じように動作する。既に応答済みなら followup に切り替える。
        """
        try:
            if interaction.response.is_done():
                return await interaction.followup.send(message, ephemeral=ephemeral)
            return await interaction.response.send_message(message, ephemeral=ephemeral)
        except discord.HTTPException:
            logger.warning("dispatch_general: error response failed", exc_info=True)
        return None

    async def dispatch_general(self, interaction: discord.Interaction, value: str):
        # 利用履歴（よく使う／最近）は入口ここで記録する。記録の失敗で
        # dispatch を壊さないよう record_safely 側で例外は握る。
        await action_usage.record_safely(
            getattr(interaction, "guild_id", None),
            getattr(getattr(interaction, "user", None), "id", None),
            f"general:{value}",
        )
        # 管理者向け総量統計も同じ入口で数える（個人履歴とは別集計）。
        usage_stats.record_action_safely(f"general:{value}")
        if value in {"zetamodoki", "zeta_reset", "zeta_register", "zeta_manage"}:
            cog = self.bot.get_cog("ZetaModoki")
            if cog is None:
                return await self._safe_respond(interaction, "ZetaModokiが読み込まれていません。")
            if value == "zetamodoki":
                return await cog.start(interaction)
            if value == "zeta_register":
                return await cog.register(interaction)
            if value == "zeta_manage":
                return await cog.manage(interaction)
            return await cog.reset(interaction)

        if value == "miq_settings":
            view = MiqSettingsView(self, interaction.user.id)
            return await interaction.response.send_message(view=as_panel_v2(view), ephemeral=True)

        if value == "miq_help":
            embed = discord.Embed(title="引用画像 (MIQ)", color=0xFFFFFF)
            embed.description = (
                "**作り方**\n"
                "・メッセージを右クリック(スマホは長押し) → アプリ → **Make it a Quote**\n"
                "・引用したいメッセージに返信して、`@BOT miq` と送信\n\n"
                "**設定**\n"
                "`/general` → 引用画像 (MIQ) → **MIQ設定** で、モノクロ・文字色連動・左右反転・太字・"
                "全面レイアウト・GIF出力・フォント・配色を変更できます。設定はあなたがMIQを作る時に使われます。\n\n"
                "**フォーマット**\n"
                "MIQ設定で **ランダム / 引用 (従来) / 漫画風 / 音楽再生風 / LINE風 / ニュース速報風 / X投稿風 / RPG風 / 設計図風 / レトロゲーム風 / トレカ風 / ネオン風 / ダーク風 / ポップ風 / パステル風 / チケット風 / ノート風** を選べます。"
                "未設定の既定はランダムで、生成のたびに単体フォーマットから1つ選ばれます（ランダムでLINE風は選ばれません）。\n"
                "引用 (従来) 以外は常にPNGで出力され、GIF出力やモノクロ・配色などの設定は引用 (従来) 専用です（フォント設定は全フォーマット共通）。\n"
                "LINE風では、対象のメッセージが返信でつながっている場合、対象を含めて最大4件まで遡って会話形式にします"
                "（対象が返信でない場合はその1件だけ）。対象の作者が右側の緑の吹き出しになります。"
                "LINE風は画像・スタンプ・カスタム絵文字・Unicode絵文字の合成にも対応し、画像やスタンプだけのメッセージも変換できます。\n\n"
                "**引用の拒否**\n"
                "MIQ設定の「引用を拒否」をONにすると、他の人があなたのメッセージを引用できなくなります（初期はOFF）。"
            )
            return await interaction.response.send_message(embed=embed, ephemeral=True)

        if value == "meme_create":
            # モーダルを開けない経路 (メッセージ型ショートカット) では
            # _MessageResponse.send_modal が「パネルから実行してください」と
            # 案内する (pay 等の既存モーダル系と同じ扱い)。
            modal = MemeTextModal(self._meme_panel_texts_done)
            return await interaction.response.send_modal(modal)

        if value == "meme_help":
            embed = discord.Embed(title="meme作成", color=0xFFFFFF)
            embed.description = (
                "**作り方**\n"
                "・`/general` → meme作成 → **memeを作成**：上/下テキストを入力したあと、"
                "同じチャンネルにベースにしたい画像を投稿してください（120秒以内）。\n"
                "・画像のあるメッセージを右クリック(スマホは長押し) → アプリ → **Make it a Meme**："
                "その画像（無ければ投稿者のアバター）がベースになります。\n\n"
                "**仕様**\n"
                "・上テキスト/下テキストは各100文字まで。どちらか一方だけでも作れます。\n"
                "・GIFアニメは1フレーム目を使った静止画になります。出力は常にPNGです。\n"
                "・ベース画像は最大8MBまで。生成画像は最大1200x1200に収まります。\n"
                "・アバターをベースにする場合のみ、MIQの引用拒否設定が適用されます。"
            )
            return await interaction.response.send_message(embed=embed, ephemeral=True)

        if value == "translation_settings":
            view = TranslationView(interaction.user.id, interaction.guild_id)
            return await interaction.response.send_message(embed=view.embed(), view=view, ephemeral=True)

        if value == "aitools":
            from core import ai_tools_router
            from cogs.ai_tools import _enabled as ai_tools_enabled
            available = ai_tools_router.action_candidates()
            key_status = "設定済み" if logfare.api_key() else "未設定"
            embed = discord.Embed(title="AI tools", color=0x5865F2)
            embed.description = (
                f"全体有効: `{ai_tools_enabled()}`\n"
                f"Logfare APIキー: `{key_status}`\n"
                f"利用可能な安全ツール: `{len(available)}件`\n\n"
                "BOTにメンションして依頼してください。個人別・機能別の設定はありません。"
            )
            return await interaction.response.send_message(embed=embed, ephemeral=True)

        if value == "reasoning_default":
            await interaction.response.defer(ephemeral=True)
            try:
                view, error = await ReasoningView.create(interaction.user.id)
            except Exception as exc:
                logger.exception("reasoning model metadata unavailable: user=%s", interaction.user.id)
                status = getattr(exc, "status", None)
                detail = f"（HTTP {status}）" if status else ""
                return await interaction.followup.send(
                    f"思考強度の対応状況を取得できませんでした{detail}。時間をおいて再試行してください。",
                    ephemeral=True,
                )
            if error:
                return await interaction.followup.send(error, ephemeral=True)
            return await interaction.followup.send(embed=view.embed(), view=view, ephemeral=True)

        if value in {"ai_default", "image_default"}:
            await interaction.response.defer(ephemeral=True)
            kind = "chat" if value == "ai_default" else "image"
            view = await AIDefaultView.create(interaction.user.id, kind)
            if view.load_error or not view.models:
                logger.error(
                    "Logfare model catalog unavailable: kind=%s user=%s",
                    kind, interaction.user.id, exc_info=view.load_error,
                )
                status = getattr(view.load_error, "status", None)
                detail = f"（HTTP {status}）" if status else ""
                return await interaction.followup.send(
                    f"Logfareのモデル一覧を取得できませんでした{detail}。"
                    "時間をおいて再試行し、`.env` とAPI接続を確認してください。",
                    ephemeral=True,
                )
            return await interaction.followup.send(embed=view.embed(), view=view, ephemeral=True)

        if value == "shortcut_manage":
            view = ShortcutManagerView(self, interaction.guild_id, interaction.user.id)
            return await interaction.response.send_message(view=as_panel_v2(view), ephemeral=True)

        if value == "exp_status":
            view = ExpStatusView(interaction.user.id, interaction.guild_id)
            await view._load_latest()
            return await interaction.response.send_message(
                view=as_panel_v2(view), ephemeral=True
            )

        if value == "exp_ranking":
            view = ExpRankingView(interaction.guild_id)
            await view._load_latest()
            return await interaction.response.send_message(
                view=as_panel_v2(view), ephemeral=True
            )

        wallet = self.bot.get_cog("WalletCog")
        fujo = self.bot.get_cog("FujoSurvival")

        # ===== 経済系 =====
        if value in {"pay", "status", "coin_leaderboard", "bump_leaderboard", "up_leaderboard"}:
            if wallet is None:
                return await self._safe_respond(interaction, "WalletCogが読み込まれていません。")
            if value == "pay":
                return await interaction.response.send_modal(PayModal(self))
            if value == "status":
                return await wallet.user_status(interaction)
            if value == "coin_leaderboard":
                return await wallet.leaderboard(interaction)
            event_type = value.removesuffix("_leaderboard")
            return await wallet.leaderboard(
                interaction, app_commands.Choice(name=event_type, value=event_type)
            )

        # ===== fujo（生存確認）系 =====
        if value.startswith("fujo_"):
            if fujo is None:
                return await self._safe_respond(interaction, "FujoSurvivalが読み込まれていません。")
            action = value.removeprefix("fujo_")
            try:
                return await fujo.fujo(interaction, action, None, "active", None, None)
            except Exception:
                logger.exception(
                    "fujo dispatch failed: action=%s user=%s guild=%s",
                    action, interaction.user.id,
                    getattr(interaction, "guild_id", None),
                )
                return await self._safe_respond(
                    interaction,
                    "生存確認機能の処理中にエラーが発生しました。時間をおいて再試行してください。",
                )

        logger.warning("dispatch_general: unknown action %r", value)
        return await self._safe_respond(interaction, "この機能は現在利用できません。")

    async def _translation_webhook(self, channel):
        """Return the per-channel webhook used for translated messages."""
        parent = channel.parent if isinstance(channel, discord.Thread) else channel
        cached = self._translation_webhooks.get(parent.id)
        if cached is not None:
            return cached
        webhooks = await parent.webhooks()
        webhook = discord.utils.get(webhooks, name="AGOBOT-Translate")
        if webhook is None:
            webhook = await parent.create_webhook(name="AGOBOT-Translate")
        self._translation_webhooks[parent.id] = webhook
        return webhook

    @commands.Cog.listener("on_message")
    async def on_message_translation(self, message: discord.Message):
        """Replace human messages with a webhook-posted translation when enabled."""
        if (
            message.guild is None
            or message.author.bot
            or message.webhook_id is not None
            or (not message.content.strip() and not message.attachments)
        ):
            return

        store = guild_settings.get_store()
        await store.ensure_loaded()
        settings = translation.translation_settings(message.author.id, message.guild.id)
        if not settings["enabled"]:
            return

        me = message.guild.me
        permissions = message.channel.permissions_for(me) if me is not None else None
        if not permissions or not permissions.manage_messages or not permissions.manage_webhooks:
            logger.warning(
                "自動翻訳にはメッセージ管理とWebhook管理権限が必要です (guild=%s channel=%s)",
                message.guild.id, message.channel.id,
            )
            return

        try:
            files = []
            for attachment in message.attachments:
                # Download before deleting the source message.  use_cached=True
                # also keeps Discord CDN URLs usable after the source is removed.
                files.append(await attachment.to_file(use_cached=True))
            translated = await translation.translate_message(
                message.content,
                settings["source_locale"],
                settings["target_locale"],
                client=self._translation_client,
            )
            webhook = await self._translation_webhook(message.channel)
            await message.delete()
            kwargs = {
                "content": translated or None,
                "username": str(message.author.display_name)[:80],
                "avatar_url": str(message.author.display_avatar.url),
                "files": files,
                "allowed_mentions": discord.AllowedMentions.none(),
                "_agobot_skip_localization": True,
            }
            if isinstance(message.channel, discord.Thread):
                kwargs["thread"] = message.channel
            await webhook.send(**kwargs)
        except LibreTranslateError:
            logger.warning("自動翻訳APIの呼び出しに失敗しました (guild=%s)", message.guild.id, exc_info=True)
        except discord.HTTPException:
            logger.warning("自動翻訳メッセージの削除または送信に失敗しました", exc_info=True)
        except Exception:
            logger.exception("自動翻訳で予期しないエラーが発生しました")

    async def execute_shortcut(self, message: discord.Message, item: dict, *, invoker=None):
        # MIQトリガー（引用への返信で「@BOT miq」）からは、どのショートカットも
        # 実行しない。AITools等がこの経路で miq_settings を選ぶと、メッセージ経由の
        # Interaction は ephemeral を使えず、MIQ設定パネルがチャンネルへ公開送信
        # されて引用画像と一緒に出てしまうため。画像生成は on_message の MIQ側が行う。
        if is_miq_trigger(message, self.bot.user if self.bot is not None else None):
            return False
        try:
            owner_id = int(item.get("user_id"))
            author_id = int(message.author.id)
        except (AttributeError, TypeError, ValueError):
            return False
        if author_id != owner_id:
            return False
        action = item.get("action") or {}
        source = ShortcutMessageInteraction(self.bot, message, author_id, invoker=invoker)
        root, value = action.get("root"), action.get("value")
        # v2 のプリセット値（旧形式では action["options"]）。メッセージ経由の
        # 実行ではモーダルを出せないため、params は登録時のプリセット専用で、
        # 実行時に追加で聞くことはしない（仕様書 D-4）。
        params = shortcuts.effective_params(item)
        try:
            if root == "general":
                return await self.dispatch_general(source, value)
            if root == "vc":
                cog = self.bot.get_cog("VoiceHub")
                if cog:
                    return await cog.dispatch_voice_action(
                        source, value, **shortcut_vc_params(value, params))
            if root == "game":
                cog = self.bot.get_cog("GameHub")
                if cog and value.startswith("game:"):
                    return await cog.start_game(source, value.removeprefix("game:"), **params)
            if root == "support":
                cog = self.bot.get_cog("SupportCog")
                if cog:
                    return await cog.dispatch(source, value)
            if root == "help":
                return await message.channel.send("ヘルプは `/help` で確認できます。")
        except Exception:
            logger.exception("shortcut execution failed: %s", item)
            await message.channel.send("ショートカットの実行中にエラーが発生しました。")

    # ============================================================
    # MIQ (Make it a Quote)
    # ============================================================
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

    async def miq_context(self, interaction: discord.Interaction, message: discord.Message):
        """メッセージの右クリックメニュー「Make it a Quote」。"""
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
        else:
            file = await self._miq_build_file(
                message.author, text, eff_prefs, size_limit,
                created_at=getattr(message, "created_at", None),
            )
        if file is None:
            return await interaction.followup.send("引用画像を作れませんでした。")
        await interaction.followup.send(file=file)

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
                else:
                    file = await self._miq_build_file(
                        target.author, text, eff_prefs, size_limit,
                        created_at=getattr(target, "created_at", None),
                    )
            if file is None:
                return
            await message.reply(file=file, mention_author=False)
        except discord.HTTPException:
            logger.debug("MIQ: 返信での引用生成に失敗しました", exc_info=True)
        except Exception:
            logger.exception("MIQ: 返信での引用生成に失敗しました")

    # ============================================================
    # meme 作成
    # ============================================================
    def _meme_font_for(self, user_id: int) -> str | None:
        """ユーザーの MIQ フォント設定があればそれを、無ければ meme 用の太めフォントを返す。"""
        prefs = miq_get_prefs(user_id)
        if prefs.get("font"):
            path = next(
                (p for k, _label, p in _miq_available_fonts() if k == prefs["font"]), None,
            )
            if path:
                return path
        return _meme_font_path()

    @staticmethod
    def _meme_size_limit(guild) -> int:
        limit = getattr(guild, "filesize_limit", None) or MEME_MAX_IMAGE_BYTES
        return min(int(limit), MEME_MAX_IMAGE_BYTES)

    async def _meme_build_file(
        self, image_bytes: bytes | None, top: str, bottom: str, user_id: int,
    ) -> tuple[discord.File | None, str | None]:
        """meme 画像を作る。戻り値 (file, error)。error はユーザーに見せてよい文面。"""
        try:
            async with self._levelup_sem:
                data = await asyncio.to_thread(
                    render_meme_png, image_bytes, top, bottom,
                    font_path=self._meme_font_for(user_id),
                )
            return discord.File(io.BytesIO(data), filename="meme.png"), None
        except ImportError:
            self._miq_pillow_missing()
            return None, "画像生成ライブラリが利用できません。"
        except ValueError as exc:
            return None, str(exc)
        except Exception:
            logger.exception("meme: 画像の生成に失敗しました")
            return None, "meme画像を作れませんでした。"

    async def _meme_panel_texts_done(self, interaction: discord.Interaction, top: str, bottom: str):
        """パネル経由: テキスト確定後、同じチャンネルで画像の投稿を待つ。"""
        channel = interaction.channel
        if channel is None:
            return await interaction.response.send_message(
                "チャンネルが特定できませんでした。", ephemeral=True
            )
        key = (channel.id, interaction.user.id)
        if key in self._meme_waits:
            return await interaction.response.send_message(
                "このチャンネルでは既にmeme作成の画像待ち中です。"
                "画像を投稿するか、先にキャンセルしてください。",
                ephemeral=True,
            )
        event = asyncio.Event()
        self._meme_waits[key] = event
        await interaction.response.send_message(
            "このチャンネルに、ベースにしたい画像を投稿してください（120秒以内）。",
            view=MemeCancelView(self, key, interaction.user.id), ephemeral=True,
        )
        self._spawn(self._meme_wait_for_image(interaction, key, event, top, bottom))

    async def _meme_wait_for_image(self, interaction, key, event, top: str, bottom: str):
        channel_id, user_id = key

        def check(m) -> bool:
            return (
                getattr(m.author, "id", None) == user_id
                and getattr(m.channel, "id", None) == channel_id
                and _meme_image_attachment(m) is not None
            )

        msg_task = asyncio.ensure_future(self.bot.wait_for("message", check=check))
        cancel_task = asyncio.ensure_future(event.wait())
        try:
            done, _pending = await asyncio.wait(
                {msg_task, cancel_task}, timeout=MEME_WAIT_TIMEOUT,
                return_when=asyncio.FIRST_COMPLETED,
            )
            if cancel_task in done:
                return  # キャンセルボタン側で案内済み
            if msg_task not in done:
                try:
                    await interaction.edit_original_response(
                        content="時間切れのためmeme作成を終了しました。", view=None,
                    )
                except discord.HTTPException:
                    logger.debug("meme: 応答メッセージの編集に失敗しました", exc_info=True)
                return
            msg = msg_task.result()
            att = _meme_image_attachment(msg)
            if att is None:
                return
            limit = self._meme_size_limit(getattr(msg, "guild", None))
            if getattr(att, "size", 0) and att.size > limit:
                await msg.reply(
                    f"画像が大きすぎます（上限 {limit // (1024 * 1024)}MB）。"
                    "meme作成を終了しました。",
                    mention_author=False,
                )
                return
            try:
                image_bytes = await att.read()
            except Exception:
                logger.debug("meme: 添付画像の取得に失敗しました", exc_info=True)
                await msg.reply("画像を取得できませんでした。", mention_author=False)
                return
            file, error = await self._meme_build_file(image_bytes, top, bottom, user_id)
            if file is None:
                await msg.reply(error or "meme画像を作れませんでした。", mention_author=False)
                return
            await msg.reply(file=file, mention_author=False)
            try:
                await interaction.edit_original_response(content="memeを作成しました。", view=None)
            except discord.HTTPException:
                logger.debug("meme: 応答メッセージの編集に失敗しました", exc_info=True)
        except Exception:
            logger.exception("meme: 画像待ち処理に失敗しました")
        finally:
            for task in (msg_task, cancel_task):
                task.cancel()
            self._meme_waits.pop(key, None)

    async def _meme_fetch_url_image(self, url: str, limit: int) -> bytes | None:
        """embed 画像などを URL から取得する (上限を超えたら None)。"""
        import aiohttp

        try:
            timeout = aiohttp.ClientTimeout(total=10)
            async with aiohttp.ClientSession(timeout=timeout) as session:
                async with session.get(url) as resp:
                    if resp.status != 200:
                        return None
                    if resp.content_length is not None and resp.content_length > limit:
                        return None
                    data = await resp.content.read(limit + 1)
                    return data if len(data) <= limit else None
        except Exception:
            logger.debug("meme: URLからの画像取得に失敗しました", exc_info=True)
            return None

    async def meme_context(self, interaction: discord.Interaction, message: discord.Message):
        """メッセージの右クリックメニュー「Make it a Meme」。

        ベース画像は 添付画像 → embed 画像 → 投稿者のアバター の順で決める。
        アバターを使う場合のみ MIQ の引用拒否を適用する (添付/embed は
        メッセージ自体に公開されている画像のため対象外)。
        """
        limit = self._meme_size_limit(getattr(interaction, "guild", None))
        image_bytes: bytes | None = None

        att = _meme_image_attachment(message)
        if att is not None:
            if getattr(att, "size", 0) and att.size > limit:
                return await interaction.response.send_message(
                    f"画像が大きすぎます（上限 {limit // (1024 * 1024)}MB）。", ephemeral=True
                )
            try:
                image_bytes = await att.read()
            except Exception:
                logger.debug("meme: 添付画像の取得に失敗しました", exc_info=True)
                return await interaction.response.send_message(
                    "画像を取得できませんでした。", ephemeral=True
                )

        if image_bytes is None:
            for embed in getattr(message, "embeds", None) or []:
                image = getattr(embed, "image", None)
                url = getattr(image, "url", None) if image is not None else None
                if url:
                    image_bytes = await self._meme_fetch_url_image(url, limit)
                    if image_bytes:
                        break

        if image_bytes is None:
            author_id = getattr(message.author, "id", None)
            if author_id != interaction.user.id and miq_is_refusing(author_id):
                return await interaction.response.send_message(
                    "このユーザーは引用画像(MIQ)を拒否しています。", ephemeral=True
                )
            image_bytes = await self._miq_fetch_avatar_bytes(message.author, size=512)
            if image_bytes is None:
                return await interaction.response.send_message(
                    "ベースにできる画像を取得できませんでした。", ephemeral=True
                )

        if not self._miq_cooldown_ok(interaction.user.id):
            return await interaction.response.send_message(
                "少し待ってからもう一度お試しください。", ephemeral=True
            )

        async def handler(modal_interaction: discord.Interaction, top: str, bottom: str):
            await modal_interaction.response.defer(thinking=True)
            file, error = await self._meme_build_file(
                image_bytes, top, bottom, modal_interaction.user.id,
            )
            if file is None:
                return await modal_interaction.followup.send(
                    error or "meme画像を作れませんでした。"
                )
            await modal_interaction.followup.send(file=file)

        return await interaction.response.send_modal(MemeTextModal(handler))

    # ============================================================
    # レベルアップ通知
    # ============================================================
    def _spawn(self, coro) -> None:
        """通知は EXP の保存や他の処理を待たせないよう、バックグラウンドで送る。"""
        task = asyncio.create_task(coro)
        self._bg_tasks.add(task)
        task.add_done_callback(self._bg_tasks.discard)

    async def _levelup_user(self, guild: discord.Guild, user_id: int):
        member = guild.get_member(user_id)
        if member is not None:
            return member
        try:
            return await guild.fetch_member(user_id)
        except discord.HTTPException:
            logger.debug("レベルアップ通知: メンバーの取得に失敗しました", exc_info=True)
        try:
            return await self.bot.fetch_user(user_id)
        except discord.HTTPException:
            logger.debug("レベルアップ通知: ユーザーの取得に失敗しました", exc_info=True)
            return None

    @staticmethod
    def _levelup_can_post(channel, me) -> tuple[bool, bool]:
        """(投稿できるか, 画像を添付できるか)"""
        perms = channel.permissions_for(me)
        if not perms.view_channel:
            return False, False
        can_send = perms.send_messages_in_threads if isinstance(channel, discord.Thread) else perms.send_messages
        return bool(can_send), bool(perms.attach_files)

    async def _fetch_bot_avatar(self) -> bytes | None:
        """レベルアップ画像用の BOT アイコンを取得する(失敗時 None)。"""
        try:
            bot_user = self.bot.user
            if bot_user is None:
                return None
            return await bot_user.display_avatar.replace(size=128, format="png").read()
        except Exception:
            logger.debug("BOTアイコンの取得に失敗しました", exc_info=True)
            return None

    async def render_levelup_image(
        self, user, before: int, after: int, *, bot_avatar_bytes: bytes | None = None
    ) -> bytes | None:
        """レベルアップ画像(PNGのbytes)を作る。Pillowが無い等で作れなければ None。/support のプレビューからも使う。"""
        avatar_bytes = None
        try:
            avatar_bytes = await user.display_avatar.replace(size=256, format="png").read()
        except Exception:
            logger.debug("レベルアップ画像: アイコンの取得に失敗 (user=%s)", getattr(user, "id", "?"), exc_info=True)
        name = getattr(user, "display_name", None) or getattr(user, "name", "") or ""
        if bot_avatar_bytes is None:
            bot_avatar_bytes = await self._fetch_bot_avatar()
        try:
            async with self._levelup_sem:
                return await asyncio.to_thread(
                    render_levelup_card,
                    avatar_bytes, name, before, after, getattr(user, "id", 0),
                    bot_avatar_bytes=bot_avatar_bytes,
                )
        except ImportError:
            if not self._levelup_pillow_warned:
                self._levelup_pillow_warned = True
                logger.warning("レベルアップ画像: Pillow が未インストールです (pip install pillow)。テキスト通知のみ送ります")
            return None
        except Exception:
            logger.exception("レベルアップ画像の生成に失敗しました")
            return None

    async def _notify_levelup(self, guild: discord.Guild, user, before: int, after: int, *, fallback_channel=None):
        """generalレベルが上がった時の通知。user はユーザーオブジェクトかユーザーID。"""
        try:
            store = guild_settings.get_store()
            await store.ensure_loaded()
            cfg = get_levelup_settings(store, guild.id)
            if not cfg["enabled"]:
                return
            me = guild.me
            if me is None:
                return

            # 通知先: /support で指定したチャンネル → 無い/投稿不可なら、EXPが入った場所(発言したチャンネル/いたVC)
            configured = guild.get_channel_or_thread(cfg["channel_id"]) if cfg["channel_id"] else None
            target, can_attach = None, False
            for channel in (configured, fallback_channel):
                if channel is None:
                    continue
                ok, attach = self._levelup_can_post(channel, me)
                if ok:
                    target, can_attach = channel, attach
                    break
            if target is None:
                logger.info("レベルアップ通知: 投稿できるチャンネルがありません (guild=%s)", guild.id)
                return

            if isinstance(user, int):
                user = await self._levelup_user(guild, user)
            if user is None:
                return

            kwargs = {
                "content": f"🎉 {user.mention} がレベルアップしました！ **Lv.{before} → Lv.{after}**",
                "allowed_mentions": discord.AllowedMentions.none(),  # 表示はメンション、通知(ピング)は飛ばさない
            }
            if can_attach:
                bot_avatar_bytes = await self._fetch_bot_avatar()
                png = await self.render_levelup_image(
                    user, before, after, bot_avatar_bytes=bot_avatar_bytes
                )
                if png:
                    kwargs["file"] = discord.File(io.BytesIO(png), filename="levelup.png")
            await target.send(**kwargs)
        except discord.HTTPException:
            logger.warning("レベルアップ通知の送信に失敗しました (guild=%s)", guild.id, exc_info=True)
        except Exception:
            logger.exception("レベルアップ通知で予期しないエラーが発生しました")

    # ============================================================
    # EXP: メッセージ
    # ============================================================
    async def _notify_level_rewards(self, guild, member, old_level: int, new_level: int):
        if new_level <= old_level or self.bot is None:
            return
        cog = self.bot.get_cog("ServerAssistCog")
        handler = getattr(cog, "handle_level_rewards", None)
        if handler is None:
            return
        try:
            await handler(guild, member, old_level, new_level)
        except Exception:
            logger.exception("レベル報酬の連携に失敗しました")

    @commands.Cog.listener()
    async def on_message(self, message: discord.Message):
        if message.author.bot or message.guild is None:
            return

        try:
            data = await _exp_load()
            user = _exp_ensure(data, message.guild.id, message.author.id)
            level_before = _user_general_level(user)
            if _grant_chat_exp(user, time.time()):
                level_after = _user_general_level(user)  # 保存のawaitを挟む前に確定させる
                await _exp_save()
                if level_after > level_before:
                    self._spawn(self._notify_levelup(
                        message.guild, message.author, level_before, level_after,
                        fallback_channel=message.channel,
                    ))
                    await self._notify_level_rewards(
                        message.guild, message.author, level_before, level_after,
                    )
        except Exception:
            logger.exception("EXP: チャットEXPの付与に失敗しました")

        # MIQ: 引用したいメッセージに返信して「@BOT miq」と送ると発動
        # MIQ として処理した場合は、以降のショートカット処理へ進ませない
        # (トリガー「miq」のショートカットが誤爆して設定パネル等が出るのを防ぐ)。
        if is_miq_trigger(message, self.bot.user if self.bot is not None else None):
            self._spawn(self._miq_from_reply(message))
            return

        store = guild_settings.get_store()
        await store.ensure_loaded()
        for item in shortcuts.matching(
            store, message.guild.id, message.content.strip(), user_id=message.author.id
        ):
            await self.execute_shortcut(message, item)

    # ============================================================
    # EXP: VC入退室
    # ============================================================
    @commands.Cog.listener()
    async def on_voice_state_update(self, member, before, after):
        if member.bot or member.guild is None:
            return
        try:
            data = await _exp_load()
            user = _exp_ensure(data, member.guild.id, member.id)
            now = time.time()
            was_in = before.channel is not None
            now_in = after.channel is not None
            levelup = None
            tick_before = _as_float(user.get("vc_last_tick"))
            changed = False
            if not was_in and now_in:
                user["vc_last_tick"] = now
                changed = tick_before != now
            elif was_in and not now_in:
                level_before = _user_general_level(user)
                granted = _grant_vc_exp(user, now)
                level_after = _user_general_level(user)
                if level_after > level_before:
                    levelup = (level_before, level_after)
                user["vc_last_tick"] = 0.0
                # 付与があったか、計測中フラグが実際に下りたときだけ保存する
                changed = granted or tick_before != 0.0
            else:
                return
            if changed:
                await _exp_save()
            if levelup:
                self._spawn(self._notify_levelup(
                    member.guild, member, levelup[0], levelup[1], fallback_channel=before.channel,
                ))
                await self._notify_level_rewards(
                    member.guild, member, levelup[0], levelup[1],
                )
        except Exception:
            logger.exception("EXP: VC入退室の処理に失敗しました")

    # ============================================================
    # EXP: VC定期tick
    # ============================================================
    @tasks.loop(minutes=1)
    async def exp_vc_tick(self):
        try:
            data = await _exp_load()
            now = time.time()
            touched = False
            active: set[tuple[str, str]] = set()
            levelups: list[tuple[discord.Guild, int, int, int, object]] = []
            for guild in list(self.bot.guilds):
                for uid, voice_channel in _iter_voice_user_channels(guild):
                    active.add((str(guild.id), str(uid)))
                    user = _exp_ensure(data, guild.id, uid)
                    level_before = _user_general_level(user)
                    # 保存するのは実際にEXPが付与されたときだけにする。
                    # vc_accum_sec / vc_last_tick の進行はメモリ上で保持され、
                    # 次回の付与時 (または入退室時) の保存でまとめて永続化される。
                    if _grant_vc_exp(user, now):
                        touched = True
                    level_after = _user_general_level(user)
                    if level_after > level_before:
                        levelups.append((guild, uid, level_before, level_after, voice_channel))
            # VCにいないのに計測中のままの人(退室イベント取りこぼし等)は計測を止める
            for gid, users in data.items():
                if not isinstance(users, dict):
                    continue
                for uid, u in users.items():
                    if (gid, uid) in active or not isinstance(u, dict):
                        continue
                    if _as_float(u.get("vc_last_tick")) > 0.0:
                        u["vc_last_tick"] = 0.0
                        touched = True
            if touched:
                await _exp_save()
            for guild, uid, level_before, level_after, voice_channel in levelups:
                member = guild.get_member(uid)
                if member is not None:
                    await self._notify_level_rewards(
                        guild, member, level_before, level_after,
                    )
                self._spawn(self._notify_levelup(
                    guild, uid, level_before, level_after, fallback_channel=voice_channel,
                ))
        except Exception:
            logger.exception("EXP: VC tick に失敗しました (次の周期で再試行します)")

    @exp_vc_tick.before_loop
    async def before_exp_vc_tick(self):
        await self.bot.wait_until_ready()
        try:
            data = await _exp_load()
            now = time.time()
            touched = False
            for guild in list(self.bot.guilds):
                for uid in _iter_voice_user_ids(guild):
                    user = _exp_ensure(data, guild.id, uid)
                    if _as_float(user.get("vc_last_tick")) != now:
                        user["vc_last_tick"] = now
                        touched = True
            if touched:
                await _exp_save()
        except Exception:
            logger.exception("EXP: 起動時のVC計測の初期化に失敗しました")


# ============================================================
# ショートカット用メッセージアダプタ
# ============================================================
class _MessageResponse:
    def __init__(self, source):
        self.source, self.done = source, False

    def is_done(self):
        return self.done

    async def defer(self, **kwargs):
        self.done = True

    async def send_message(self, content=None, **kwargs):
        self.done = True
        kwargs.pop("ephemeral", None)
        kwargs.pop("wait", None)
        return await self.source.channel.send(content=content, **kwargs)

    async def send_modal(self, modal):
        self.done = True
        return await self.source.channel.send("このショートカットは追加入力が必要なため、パネルから実行してください。")


class _MessageFollowup:
    def __init__(self, source):
        self.source = source

    async def send(self, content=None, **kwargs):
        kwargs.pop("ephemeral", None)
        kwargs.pop("wait", None)
        return await self.source.channel.send(content=content, **kwargs)


class ShortcutMessageInteraction:
    def __init__(self, bot, message, user_id: int, *, invoker=None):
        self.client = bot
        self.bot = bot
        self.message = message
        self.channel = message.channel
        self.guild = message.guild
        self.guild_id = message.guild.id
        self.user = invoker or message.author
        self.user_id = self.user.id
        self.response = _MessageResponse(self)
        self.followup = _MessageFollowup(self)


async def setup(bot):
    await bot.add_cog(GeneralCog(bot))
