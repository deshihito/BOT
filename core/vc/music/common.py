import discord
from core.support.panel_v2 import edit_message_v2
from discord import app_commands  # ← 追加
from discord.ext import commands, tasks
import asyncio
import time
import types
import logging
import string
import subprocess
import json
import io
import os
import shlex
import tempfile
import yt_dlp
import struct
import math  # 追加: Timerクラスのサイン波計算で必要
from discord.ext import voice_recv
import threading
import random
import numpy as np
from scipy import signal
import numpy as np
import re
import wave
import discord.opus
from core.vc import voice_restore
from core.vc.voice_session import SHARED_FEATURES, VoiceBusy, get_manager
from core.vc.voice_media import add_audio_source, has_audio_source, remove_audio_source
from core.support.legacy import Responder
from core.support.emojis import FAILED, MUSIC, SUCCESS
from core.vc.music.music_activity import build_music_activity_snapshot

logger = logging.getLogger("cogs.sio_music")
 
# yt-dlpの設定（ストリーミング再生用および検索用）
# 2026年8月時点で android_vr クライアントのCDN URLが403となるケースがあるため、
# 一時的な回避策としてプレーンな音声URLを返すAndroidクライアントを明示する。
YTDL_OPTIONS = {
    'format': 'bestaudio[acodec!=none]/bestaudio/best',
    'noplaylist': True,
    'quiet': True,
    'no_warnings': True,
    'default_search': 'ytsearch',
    'source_address': '0.0.0.0',
    'extractor_args': {
        'youtube': {
            'player_client': ['android'],
        },
    },
}

# CAPTCHA・年齢確認等でYouTubeがCookieを要求する環境では、Botの実行環境に
# Netscape/Mozilla形式のcookies.txtを配置してYTDLP_COOKIE_FILEで指定する。
YTDL_COOKIE_FILE = os.getenv('YTDLP_COOKIE_FILE')
if YTDL_COOKIE_FILE:
    YTDL_OPTIONS['cookiefile'] = YTDL_COOKIE_FILE
# BASE62の定義
BASE62 = string.digits + string.ascii_lowercase + string.ascii_uppercase
MAX_QUEUE_SIZE = 50
MAX_PLAYLIST_ITEMS = 50
SPOTIFY_PLAYLIST_RE = re.compile(
    r"https?://open\.spotify\.com/(?:intl-[^/]+/)?playlist/([A-Za-z0-9]+)",
    re.IGNORECASE,
)
SOUNDCLOUD_URL_RE = re.compile(
    r"https?://(?:[a-z0-9-]+\.)?soundcloud\.com/",
    re.IGNORECASE,
)


def soundcloud_url_kind(value: str) -> str | None:
    """SoundCloudのURLなら 'set'（プレイリスト）か 'track'（単曲）を返す。"""
    text = (value or "").strip()
    if not SOUNDCLOUD_URL_RE.match(text):
        return None
    path = text.split("soundcloud.com", 1)[-1]
    return "set" if "/sets/" in path else "track"


NICOVIDEO_URL_RE = re.compile(
    r"https?://(?:www\.nicovideo\.jp/watch/|nico\.ms/)([a-z]{0,2}\d+)",
    re.IGNORECASE,
)


def niconico_url_kind(value: str) -> str | None:
    """ニコニコ動画の動画URLなら 'track' を返す (yt-dlpのniconico抽出はログイン不要)。"""
    text = (value or "").strip()
    return "track" if NICOVIDEO_URL_RE.match(text) else None
MAX_TTS_CHARS = 300
LOOP_CHOICES = [
    app_commands.Choice(name="OFF", value="off"),
    app_commands.Choice(name="1曲を繰り返す", value="track"),
    app_commands.Choice(name="キュー全体を繰り返す", value="queue"),
]
PLAYLIST_ACTION_CHOICES = [
    app_commands.Choice(name="保存", value="save"),
    app_commands.Choice(name="一覧", value="list"),
    app_commands.Choice(name="再生", value="play"),
    app_commands.Choice(name="削除", value="delete"),
]
PLAYLIST_SCOPE_CHOICES = [
    app_commands.Choice(name="自分", value="me"),
    app_commands.Choice(name="サーバー", value="server"),
]
MIN_PLAYBACK_SPEED = 0.5
MAX_PLAYBACK_SPEED = 64.0
PANEL_TIMEOUT_SECONDS = 900
SNAPSHOT_INTERVAL_SECONDS = 30.0  # 再起動復旧用スナップショットの定期保存間隔（SIGKILL でも最大この分だけ再生位置が巻き戻る）
SAFE_CUSTOM_AUDIO_FILTERS = {
    'acompressor', 'aecho', 'alimiter', 'apulsator', 'bass', 'dynaudnorm',
    'equalizer', 'extrastereo', 'highpass', 'lowpass', 'loudnorm', 'treble',
    'tremolo', 'vibrato', 'volume',
}


#: 音楽操作 (停止・スキップ・速度/音量/EQ 等) を VC 外から拒否するときの文言。
MUSIC_VC_REQUIRED_MESSAGE = "この操作は、Bot が接続しているボイスチャンネルに参加しているメンバーだけが行えます。"


def is_same_voice_channel(user, voice_client) -> bool:
    """操作者がボットの接続中 VC のメンバーかどうかを判定する純関数 (B-3)。

    チャンネルのメンバー一覧が取れる場合はそれを正とし、取れない場合は
    操作者自身の voice 状態 (参加中チャンネル) と VC のチャンネルを比べる。
    ボット未接続・操作者不明・メンバーでない場合はすべて False。
    """
    if user is None or voice_client is None:
        return False
    channel = getattr(voice_client, "channel", None)
    if channel is None:
        return False
    user_id = getattr(user, "id", None)
    if user_id is None:
        return False
    members = getattr(channel, "members", None)
    if members is not None:
        return any(getattr(member, "id", None) == user_id for member in members)
    voice = getattr(user, "voice", None)
    user_channel = getattr(voice, "channel", None) if voice is not None else None
    return user_channel is not None and getattr(user_channel, "id", None) == getattr(channel, "id", None)


def build_atempo_filters(speed: float) -> list[str]:
    """0.5〜2.0のatempoを連結し、FFmpegで最大64倍速を表現する。"""
    remaining = max(MIN_PLAYBACK_SPEED, min(MAX_PLAYBACK_SPEED, float(speed)))
    filters: list[str] = []
    while remaining > 2.0:
        filters.append('atempo=2.0')
        remaining /= 2.0
    filters.append(f'atempo={remaining:.6f}')
    return filters


def is_safe_custom_audio_filter(filter_text: str) -> bool:
    """ファイル・ネットワーク入力を許すFFmpegフィルターを拒否する。"""
    if not filter_text or any(char in filter_text for char in ('\n', '\r', ';', '|')):
        return False
    for part in filter_text.split(','):
        name = part.split('=', 1)[0].strip()
        if name not in SAFE_CUSTOM_AUDIO_FILTERS:
            return False
    return True

# 音響エフェクト（EQ）の設定マップ
# JavaScriptの3帯域立体音響、空気吸収マイルド減衰、頭部陰影、およびFDNリバーブ分離回路をFFmpeg用にシミュレート
# 音響エフェクト（EQ）の設定マップ
EQ_SETTINGS = {
    "flat": None,
    "wfs": "wfs",  # WFS（波面合成）モード用キーを追加
    "bass": "bass=g=10,dynaudnorm",
    "echo": "aecho=0.8:0.8:200:0.4",
    "hall": "extrastereo=m=2.5",
    "vocal": "firequalizer=gain_entry='entry(100, -5); entry(1000, 5); entry(4000, 5); entry(8000, 0)'",
    "superbass": "firequalizer=gain_entry='entry(31, 15); entry(62, 10); entry(125, 5)'",
    "live": "aecho=0.8:0.88:60:0.4,lowpass=f=15000,surround,extrastereo=m=1.5",
    "rotate": "apulsator=hz=0.125:amount=1",
    "reverb": "afir",
    # === YouTube音源からHRIRを自己生成 ＆ 100%タイムアウトしない究極バイノーラル ===
    # === FFmpeg 7.1 ドキュメント仕様完全準拠：100%エラーが出ないガチHRTFバイノーラル ===
    "spatial": (
        # 1. YouTubeのステレオ音源を、再生用(main: 2ch)と、HRIRダミー用(hrir_dummy: 2ch)に2分岐
        "asplit=2[main][hrir_dummy];"
        
        # 2. ダミー用を「最初のストリームのチャンネル数(2)のちょうど2倍である 4ch」に pan で強制展開
        #    これにより、ドキュメントの『hrir=multich の時は追加ストリームが最初の2倍以上のチャンネル数であること』という制約を完全にクリア
        "[hrir_dummy]pan=4c|c0=c0|c1=c1|c2=c0|c3=c1[hrirs];"
        
        # 3. 2chの原音と、条件を満たした4chのHRIRをドッキング。
        #    周波数領域(type=freq)で、Discordの3秒制限をすり抜ける爆速処理で超リアルな立体音響化！
        "[main][hrirs]headphone=map=FL|FR:hrir=multich:type=freq"
    )
}

# 通常EQはFFmpeg側で処理し、Pythonの20msフレーム処理を避ける。
FFMPEG_REALTIME_PRESETS = {
    key: EQ_SETTINGS[key]
    for key in ('bass', 'echo', 'hall', 'vocal', 'superbass', 'live', 'rotate')
}


def build_ffmpeg_headers(headers: dict | None) -> str:
    """yt-dlpがストリーム取得に使った安全なHTTPヘッダーをFFmpegへ引き継ぐ。"""
    if not headers:
        return ""

    lines = []
    for name, value in headers.items():
        if not re.fullmatch(r"[A-Za-z0-9-]+", str(name)):
            continue
        safe_value = str(value).replace("\r", "").replace("\n", "")
        lines.append(f"{name}: {safe_value}")
    return "\r\n".join(lines) + ("\r\n" if lines else "")


class FFmpegPCMAudioDiagnostics(discord.FFmpegPCMAudio):
    """FFmpegの即時終了を再生エラーとして上位へ伝えるPCMソース。"""
    def __init__(self, source, **kwargs):
        self._diagnostic_stderr = tempfile.TemporaryFile(mode="w+b")
        self._ffmpeg_error_raised = False
        self.has_output = False
        super().__init__(source, stderr=self._diagnostic_stderr, **kwargs)

    def read(self):
        # discord.pyのバージョンにより、FFmpeg異常終了の通知方法が
        # 例外・内部属性・無通知で異なる。基底クラスのread()を使わず、
        # PCMの読み取りと終了診断をここで一貫して扱う。
        frame_bytes = 3840  # 48 kHz / 16 bit / stereo / 20 ms
        data = self._stdout.read(frame_bytes)
        if len(data) == frame_bytes:
            self.has_output = True
            return data

        process = getattr(self, "_process", None)
        returncode = process.poll() if process else None
        # stdoutのEOFが先に届き、Popen.returncode の反映がわずかに遅れる場合がある。
        # 短時間だけ再確認して、非ゼロ終了を取りこぼさない。
        if returncode is None and process:
            for _ in range(10):
                time.sleep(0.05)
                returncode = process.poll()
                if returncode is not None:
                    break
        if returncode not in (None, 0) and not self._ffmpeg_error_raised:
            self._ffmpeg_error_raised = True
            # stderrをコピーするバックグラウンド処理が書き終えるのを待つ。
            time.sleep(0.10)
            self._diagnostic_stderr.seek(0)
            diagnostic = self._diagnostic_stderr.read().decode("utf-8", errors="replace")[-2000:].strip()
            message = f"FFmpeg exited with code {returncode}"
            if diagnostic:
                message += f". Stderr: {diagnostic}"
            self._current_error = RuntimeError(message)
            logger.error("FFmpeg playback failure: %s", message)
        return b""

    def cleanup(self):
        try:
            super().cleanup()
        finally:
            self._diagnostic_stderr.close()


def encode_full_id(guild_id: int, channel_id: int, message_id: int) -> str:
    """サーバー・チャンネル・メッセージの3つのIDを1つの62進数に統合"""
    combined = (guild_id << 128) | (channel_id << 64) | message_id
    if combined == 0: return BASE62[0]
    arr = []
    base = len(BASE62)
    while combined:
        combined, rem = divmod(combined, base)
        arr.append(BASE62[rem])
    arr.reverse()
    return ''.join(arr)

def decode_full_id(b62_id: str):
    """62進数からギルドID, チャンネルID, メッセージIDを復元"""
    base = len(BASE62)
    combined = 0
    for idx, char in enumerate(b62_id[::-1]):
        combined += BASE62.index(char) * (base ** idx)
    guild_id = combined >> 128
    channel_id = (combined >> 64) & ((1 << 64) - 1)
    message_id = combined & ((1 << 64) - 1)
    return guild_id, channel_id, message_id

from core.support.embeds import we  # noqa: F401  (共通の白 embed 工場。sio_music への re-export を維持)
