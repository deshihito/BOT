# -*- coding: utf-8 -*-
"""EXP・レベルの計算と永続化。元 cogs/general.py から分割。"""
from __future__ import annotations

from .common import *

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
    or (Path(__file__).resolve().parent.parent.parent / "data" / "exp.json")
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
    """旧ストアに残っているEXPを取り込むための読み取り専用ヘルパ。

    対応する旧ストアの形:
    - GuildSettings: 内部データ _data にトップレベルキー key のエントリ
      ({gid: {uid: record}}) が残っている場合と、各ギルドの section=key に
      ({uid: record}) 保存されている場合の両方を取り込む。
    - 汎用キーで引ける dict-like ストア: get(key) を従来どおり使う。
    GuildSettings.get のように引数が合わない get しか持たないストアは
    「旧データなし」と等価なので、警告を出さず None を返す。
    """
    data = getattr(store, "_data", None)
    if isinstance(data, dict):
        found: dict = {}
        top = data.get(key)
        if isinstance(top, dict) and top:
            found.update(top)
        for gid, sections in data.items():
            if not isinstance(sections, dict):
                continue
            section = sections.get(key)
            if isinstance(section, dict) and section:
                found[str(gid)] = section
        if found:
            return found
    getter = getattr(store, "get", None)
    if not callable(getter):
        return None
    try:
        return getter(key)
    except TypeError:
        # get(guild_id, section) のように1引数で呼べないストアは旧データなし
        return None
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
