"""/general: コイン・生存確認・EXP・ランキング系機能の操作パネル。"""
from __future__ import annotations

import asyncio
import io
import json
import logging
import math
import os
import random
import time
from pathlib import Path

import discord
from discord import app_commands
from discord.ext import commands, tasks
from core.panel_v2 import as_panel_v2, edit_panel_v2
from core import ai_omnirush, ai_preferences, ai_provider_router, guild_settings, logfare, shortcuts
from core.game_guides import GAME_GUIDES, GAME_ORDER

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

GENERAL_GENRES = {
    "economy": ("コイン・ランキング", "所持状況、送金、コインや bump/up のランキング"),
    "survival": ("生存確認", "追跡、アクティブ頻度、フリーズ、失踪警報"),
    "exp": ("EXP・レベル", "チャット/VC/generalのEXPとレベルを確認"),
    "custom": ("設定・AI", "ショートカット、AI tools、チャットAI・画像生成AIの設定"),
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
}

SHORTCUT_ROOTS = {
    "general": ("/general", [(label, value) for values in GENERAL_ACTIONS.values() for label, value in values if value != "shortcut_manage"]),
    "vc": ("/vc", [("VC参加", "join"), ("VC退出", "leave"), ("VC状態", "status"),
                    ("音楽操作パネル", "music_panel"), ("録音開始", "record_start"), ("録音停止", "record_stop"),
                    ("やまびこ開始", "echo_start"), ("やまびこ停止", "echo_stop"),
                    ("文字起こし開始", "transcribe_start"), ("文字起こし停止", "transcribe_stop"),
                    ("カラオケ開始", "karaoke_start"), ("カラオケ停止", "karaoke_stop"),
                    ("ランダム通話開始", "match_start"), ("ランダム通話終了", "match_stop"),
                    ("グローバルVC開始", "global_start"), ("グローバルVC終了", "global_stop")]),
    "game": ("/game", [("ゲーム開始: " + GAME_GUIDES[game]["name"], "game:" + game) for game in GAME_ORDER]),
    "support": ("/support", [("Muted設定", "muted"), ("匿名つぶやき", "whisper"), ("メッセージ削除", "clear"),
                              ("一括ロール操作", "role_bulk"), ("bump/up状態", "bumprta_status"),
                              ("bump/upオン", "bumprta_on"), ("bump/upオフ", "bumprta_off"),
                              ("絵文字便乗設定", "binjou"), ("VC入退室履歴", "vc_log"),
                              ("メッセージ編集履歴", "message_log"), ("モデレート履歴", "moderation_log"),
                              ("ハニーポット", "honeypot"), ("チケットツール", "ticket"),
                              ("サーバーアシスト", "server_assist")]),
    "help": ("/help", [("ヘルプを表示", "overview")]),
}


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
            pass
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

# 参考画像に寄せるための「極太サンセリフ体」。見出し(LEVEL UP!)とレベル数字に使う。
_LEVELUP_DISPLAY_FONTS = (
    os.getenv("LEVELUP_DISPLAY_FONT_PATH") or "",
    str(Path(__file__).resolve().parent.parent / "assets" / "fonts" / "levelup-display.ttf"),
    str(Path(__file__).resolve().parent.parent / "assets" / "fonts" / "levelup-display.otf"),
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
    "C:/Windows/Fonts/bahnschrift.ttf",
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
                continue
            pick = (path, cjk)
            break
        if pick[0]:
            break
    _LEVELUP_FONT_PICK = pick
    return pick


def _levelup_pick_display_font() -> str | None:
    """「LEVEL UP!」などの見出しに使う極太ディスプレイフォントを返す。

    参考画像に寄せるため、まず専用の太字サンセリフ体(Anton / Impact / Archivo Black 等)を探し、
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
            pass
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
            pass
    return _levelup_font(size)


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


def render_levelup_card(avatar_bytes: bytes | None, name: str, before: int, after: int, seed: int = 0) -> bytes:
    """レベルアップ画像(PNG)を生成して bytes で返す。CPU処理なので to_thread で呼ぶこと。

    白基調の落ち着いたカード。参考画像の横並び(アイコン | LEVEL UP | 9 > 10)を踏襲しつつ、
    チップ・太い矢印・グラデ・影などの装飾は使わず、細いリング・細い区切り線・
    控えめなラベルだけを残した「足して2で割った」デザイン。
    必ず含める情報: ユーザーのアイコン / 前のレベル / レベルアップ後のレベル。
    seed は互換のため残している(未使用)。
    """
    from PIL import Image, ImageDraw

    S = _LEVELUP_SS
    W, H = LEVELUP_CARD_W * S, LEVELUP_CARD_H * S
    _, can_cjk = _levelup_pick_font()

    def px(v: float) -> int:
        return int(round(v * S))

    BG = (255, 255, 255, 255)     # 白地
    INK = (24, 28, 44, 255)       # 見出し・新しいレベル
    MUTE = (150, 156, 170, 255)   # 前のレベル / ラベル / ユーザー名
    LINE = (228, 232, 240, 255)   # 区切り線・リング
    ACCENT = (59, 91, 255, 255)   # アクセント青(参考画像の赤の代わり)

    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # 角丸の白カード + ごく薄い枠線
    d.rounded_rectangle(
        [0, 0, W - 1, H - 1], radius=px(28),
        fill=BG, outline=LINE, width=px(2),
    )

    # ---- アイコン(薄いリング付き) ----
    D = px(196)
    ax, ay = px(56), (H - D) // 2
    ring_w = px(4)
    R = D // 2 + px(8) + ring_w  # リング外半径(控えめ)
    acx, acy = ax + D // 2, ay + D // 2

    d.ellipse(
        [acx - R, acy - R, acx + R, acy + R],
        outline=LINE, width=ring_w,
    )

    avatar = None
    if avatar_bytes:
        try:
            avatar = Image.open(io.BytesIO(avatar_bytes)).convert("RGBA").resize((D, D), Image.LANCZOS)
        except Exception:
            avatar = None
    if avatar is None:
        avatar = Image.new("RGBA", (D, D), (235, 238, 245, 255))
        ad = ImageDraw.Draw(avatar)
        ad.ellipse([D * 0.34, D * 0.20, D * 0.66, D * 0.52], fill=(255, 255, 255, 255))
        ad.ellipse([D * 0.18, D * 0.58, D * 0.82, D * 1.15], fill=(255, 255, 255, 255))
    amask = Image.new("L", (D, D), 0)
    ImageDraw.Draw(amask).ellipse([0, 0, D - 1, D - 1], fill=255)
    img.paste(avatar, (ax, ay), amask)

    # ---- レイアウト ----
    TX = ax + D + px(52)
    right = W - px(56)
    mid = H // 2

    # 「LEVEL UP」 極太ディスプレイフォント・インク色(「!」は控えめに外す=装飾削減)
    up_text = "LEVEL UP"
    up_size = px(60)
    up_font = _levelup_display_font(up_size)
    while up_size > px(28) and d.textlength(up_text, font=up_font) > (right - TX) * 0.5:
        up_size -= px(2)
        up_font = _levelup_display_font(up_size)

    # 上に小さな控えめラベル
    label = "GENERAL"
    lfont = _levelup_font(px(15))
    d.text((TX + px(2), mid - px(38)), label, font=lfont, fill=MUTE, anchor="ls")

    # 「LEVEL UP」本体
    d.text((TX, mid - px(4)), up_text, font=up_font, fill=INK, anchor="ls")
    up_w = d.textlength(up_text, font=up_font)

    # レベル変化(前:ミュート / > :ミュート / 後:アクセント青)
    prev_text, sep_text, new_text = str(before), ">", str(after)
    pfont = _levelup_display_font(px(42))
    sfont = _levelup_display_font(px(36))
    nfont = _levelup_display_font(px(64))

    p_w = d.textlength(prev_text, font=pfont)
    s_w = d.textlength(sep_text, font=sfont)
    n_w = d.textlength(new_text, font=nfont)
    gap = px(14)
    group_w = p_w + gap + s_w + gap + n_w

    gx = TX + up_w + px(52)
    if gx + group_w > right:
        gx = max(TX + up_w + px(20), right - group_w)

    baseline = mid + px(2)
    d.text((gx, baseline), prev_text, font=pfont, fill=MUTE, anchor="ls")
    d.text((gx + p_w + gap, baseline - px(4)), sep_text, font=sfont, fill=MUTE, anchor="ls")
    d.text((gx + p_w + gap + s_w + gap, baseline + px(2)), new_text, font=nfont, fill=ACCENT, anchor="ls")

    # ---- 下部: 区切り線 + ユーザー名 ----
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


class GeneralGenreSelect(discord.ui.Select):
    def __init__(self, cog, selected: str | None = None):
        self.cog = cog
        super().__init__(
            placeholder="ジャンルを選択してください",
            options=[discord.SelectOption(label=label, description=description, value=value,
                                          default=value == selected)
                     for value, (label, description) in GENERAL_GENRES.items()],
            row=0,
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
    def __init__(self, cog, genre: str):
        self.cog = cog
        self.genre = genre
        super().__init__(
            placeholder="機能を選択してください",
            options=[discord.SelectOption(label=label, value=value) for label, value in GENERAL_ACTIONS[genre]],
            row=1,
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


class GeneralPanel(discord.ui.View):
    def __init__(self, cog, genre: str | None = None, shortcut_mode: bool = False, shortcut_item: dict | None = None):
        super().__init__(timeout=300)
        self.cog = cog
        saved = (shortcut_item or {}).get("action", {})
        self.genre = genre or saved.get("genre")
        self.action = saved.get("value")
        self.shortcut_mode = shortcut_mode
        self.shortcut_item = shortcut_item
        self.refresh()

    def refresh(self):
        self.clear_items()
        self.add_item(GeneralGenreSelect(self.cog, self.genre))
        if self.genre:
            self.add_item(GeneralActionSelect(self.cog, self.genre))
        if self.shortcut_mode:
            self.add_item(ShortcutCommitButton())

    def shortcut_action(self):
        if not self.genre or not self.action:
            return None
        return {"root": "general", "genre": self.genre, "value": self.action}

    def embed(self):
        description = "ジャンルを選ぶと、その中の機能を選択できます。"
        if self.genre:
            description = f"**{GENERAL_GENRES[self.genre][0]}** の機能を選択してください。"
        return discord.Embed(title="一般機能", description=description, color=0xFFFFFF)


class ShortcutNameModal(discord.ui.Modal, title="ショートカット名"):
    trigger = discord.ui.TextInput(
        label="メッセージで送るトリガー（空白なし）", max_length=80,
        placeholder="例: VC参加", required=True,
    )

    def __init__(self, cog: "GeneralCog", action: dict, item: dict | None = None):
        super().__init__()
        self.cog, self.action, self.item = cog, action, item
        if item:
            self.trigger.default = item.get("trigger", "")

    async def on_submit(self, interaction: discord.Interaction):
        try:
            store = guild_settings.get_store()
            if self.item:
                await shortcuts.update(store, interaction.guild_id, interaction.user.id,
                                       self.item["id"], self.trigger.value, self.action)
                text = "ショートカットを編集しました。"
            else:
                await shortcuts.add(store, interaction.guild_id, interaction.user.id,
                                    self.trigger.value, self.action)
                text = "ショートカットを登録しました。"
        except (ValueError, KeyError) as exc:
            return await interaction.response.send_message(str(exc), ephemeral=True)
        await interaction.response.send_message(
            embed=discord.Embed(title=text, description=f"トリガー: `{self.trigger.value}`", color=0x2ECC71),
            ephemeral=True,
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
        return discord.Embed(title="ショートカット登録",
                             description="大区分を選ぶと、そのコマンドの通常パネルで機能・オプションを選択できます。",
                             color=0xFFFFFF)

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
        await interaction.response.send_modal(ShortcutNameModal(cog, action, getattr(panel, "shortcut_item", None)))


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
                    pass
                try:
                    apinex_models = await ai_provider_router.fetch_apinex_free_models()
                    models.extend({
                        **model,
                        "id": f"apinex::{model['id']}",
                        "name": f"APInex Free · {model['id'].removeprefix('free/')}",
                    } for model in apinex_models)
                except Exception:
                    pass
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

    async def cog_load(self):
        self.exp_vc_tick.start()

    def cog_unload(self):
        self.exp_vc_tick.cancel()
        for task in list(self._bg_tasks):
            task.cancel()

    @app_commands.command(name="general", description="Show the general features control panel")
    async def general(self, interaction: discord.Interaction):
        view = GeneralPanel(self)
        await interaction.response.send_message(view=as_panel_v2(view), ephemeral=True)

    async def dispatch_general(self, interaction: discord.Interaction, value: str):
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
            return await interaction.followup.send(
                embed=view.embed(), view=view, ephemeral=True
            )
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
        if value == "pay":
            return await interaction.response.send_modal(PayModal(self))
        if value == "status":
            return await wallet.user_status(interaction)
        if value == "coin_leaderboard":
            return await wallet.leaderboard(interaction)
        if value in {"bump_leaderboard", "up_leaderboard"}:
            event_type = value.removesuffix("_leaderboard")
            return await wallet.leaderboard(interaction, app_commands.Choice(name=event_type, value=event_type))
        action = value.removeprefix("fujo_")
        return await fujo.fujo(interaction, action, None, "active", None, None)

    async def execute_shortcut(self, message: discord.Message, item: dict, *, invoker=None):
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
        try:
            if root == "general":
                return await self.dispatch_general(source, value)
            if root == "vc":
                cog = self.bot.get_cog("VoiceHub")
                if cog:
                    return await cog.dispatch_voice_action(source, value)
            if root == "game":
                cog = self.bot.get_cog("GameHub")
                if cog and value.startswith("game:"):
                    options = action.get("options") or {}
                    return await cog.start_game(source, value.removeprefix("game:"), **options)
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
            pass
        try:
            return await self.bot.fetch_user(user_id)
        except discord.HTTPException:
            return None

    @staticmethod
    def _levelup_can_post(channel, me) -> tuple[bool, bool]:
        """(投稿できるか, 画像を添付できるか)"""
        perms = channel.permissions_for(me)
        if not perms.view_channel:
            return False, False
        can_send = perms.send_messages_in_threads if isinstance(channel, discord.Thread) else perms.send_messages
        return bool(can_send), bool(perms.attach_files)

    async def render_levelup_image(self, user, before: int, after: int) -> bytes | None:
        """レベルアップ画像(PNGのbytes)を作る。Pillowが無い等で作れなければ None。/support のプレビューからも使う。"""
        avatar_bytes = None
        try:
            avatar_bytes = await user.display_avatar.replace(size=256, format="png").read()
        except Exception:
            logger.debug("レベルアップ画像: アイコンの取得に失敗 (user=%s)", getattr(user, "id", "?"), exc_info=True)
        name = getattr(user, "display_name", None) or getattr(user, "name", "") or ""
        try:
            async with self._levelup_sem:
                return await asyncio.to_thread(
                    render_levelup_card, avatar_bytes, name, before, after, getattr(user, "id", 0)
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
                png = await self.render_levelup_image(user, before, after)
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
            if not was_in and now_in:
                user["vc_last_tick"] = now
            elif was_in and not now_in:
                level_before = _user_general_level(user)
                _grant_vc_exp(user, now)
                level_after = _user_general_level(user)
                if level_after > level_before:
                    levelup = (level_before, level_after)
                user["vc_last_tick"] = 0.0
            else:
                return
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
                    _grant_vc_exp(user, now)
                    level_after = _user_general_level(user)
                    if level_after > level_before:
                        levelups.append((guild, uid, level_before, level_after, voice_channel))
                    touched = True
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
                    _exp_ensure(data, guild.id, uid)["vc_last_tick"] = now
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
