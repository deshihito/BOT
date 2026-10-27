import discord
from core.panel_v2 import edit_message_v2
from discord import app_commands  # ← 追加
from discord.ext import commands
import asyncio
import time
import logging
import configparser
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
from core.voice_session import SHARED_FEATURES, VoiceBusy, get_manager
from core.voice_media import add_audio_source, has_audio_source, remove_audio_source
from core.legacy import Responder
from core.music_activity import build_music_activity_snapshot

logger = logging.getLogger(__name__)
 
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
SAFE_CUSTOM_AUDIO_FILTERS = {
    'acompressor', 'aecho', 'alimiter', 'apulsator', 'bass', 'dynaudnorm',
    'equalizer', 'extrastereo', 'highpass', 'lowpass', 'loudnorm', 'treble',
    'tremolo', 'vibrato', 'volume',
}


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

def we(description: str = None, title: str = None) -> discord.Embed:
    """白色embedを生成するヘルパー"""
    return discord.Embed(title=title, description=description, color=0xFFFFFF)

class PythonSpatialAudioSource(discord.AudioSource):
    """
    可変自動音量引き上げ（AGC）搭載：3帯域独立回転 × スピーカー特性切り替え × 壁面吸音リバーブ統合エンジン
    """
    def __init__(self, source, state):
        self.source = source
        self.state = state
        self.count = 0
        self.has_output = False
        self.sr = 48000
        # --- 既存の初期化処理の中に追加・修正 ---
        # サンプリングレートの保持（未定義の場合は 48000 など適切な値を設定）
        if not hasattr(self, 'sr'):
            self.sr = 48000

        # FDNディレイラインと壁面反射フィルタ用 zi の初期化 (shape: (1, 2))
        self.fdn_delay_lens = [1117, 1357, 1597, 1861]
        self.fdn_delay_bufs = [np.zeros(l, dtype=np.float32) for l in self.fdn_delay_lens]
        self.fdn_lp_zi = [np.zeros((1, 2), dtype=np.float32) for _ in range(4)]
        # --- [1] HRTF (頭部伝達関数) テーブル構築 ---
        self.num_directions = 36  # 10度刻み
        self.hrir_len = 96
        self.hrir_table_l = {}
        self.hrir_table_r = {}
        
        head_radius = 0.0875
        vsound = 340.0
        max_delay = (head_radius / vsound) * self.sr

        for y_pos in [-4.0, 0.0, 4.0]:
            elevation_factor = 1.0 + (y_pos * 0.05)
            for idx in range(self.num_directions):
                angle_rad = (idx * (360.0 / self.num_directions)) * np.pi / 180.0
                
                itd_l = int(max_delay * (1.0 - np.sin(angle_rad)))
                itd_r = int(max_delay * (1.0 + np.sin(angle_rad)))
                
                atten_l = 0.4 + 0.6 * np.clip(0.5 * (1.0 + np.cos(angle_rad - np.pi / 2.0)), 0.0, 1.0)
                atten_r = 0.4 + 0.6 * np.clip(0.5 * (1.0 + np.cos(angle_rad - 3.0 * np.pi / 2.0)), 0.0, 1.0)
                
                ir_l = np.zeros(self.hrir_len, dtype=np.float32)
                ir_r = np.zeros(self.hrir_len, dtype=np.float32)
                
                if 0 <= itd_l < self.hrir_len - 20:
                    ir_l[itd_l] = atten_l
                    ir_l[itd_l + int(6 * elevation_factor)] = -0.25 * atten_l
                if 0 <= itd_r < self.hrir_len - 20:
                    ir_r[itd_r] = atten_r
                    ir_r[itd_r + int(6 * elevation_factor)] = -0.25 * atten_r
                    
                self.hrir_table_l[(y_pos, idx)] = ir_l
                self.hrir_table_r[(y_pos, idx)] = ir_r

        # --- [2] 帯域分割フィルター ---
        self.sos_low = signal.iirfilter(2, 320 / (self.sr / 2), btype='lowpass', ftype='butter', output='sos')
        self.zi_low = np.zeros((self.sos_low.shape[0], 2), dtype=np.float32)

        bw = 1500.0 / 1.0
        low_f, high_f = max(20.0, 1500.0 - bw / 2.0), min(self.sr / 2.0 - 100, 1500.0 + bw / 2.0)
        self.sos_mid = signal.iirfilter(2, [low_f / (self.sr / 2), high_f / (self.sr / 2)], btype='bandpass', ftype='butter', output='sos')
        self.zi_mid = np.zeros((self.sos_mid.shape[0], 2), dtype=np.float32)

        self.sos_high = signal.iirfilter(2, 5000 / (self.sr / 2), btype='highpass', ftype='butter', output='sos')
        self.zi_high = np.zeros((self.sos_high.shape[0], 2), dtype=np.float32)

        self.band_configs = [
            {'type': 'low',  'y': -4.0, 'speed': 0.5, 'angle': 0.0},
            {'type': 'mid',  'y':  0.0, 'speed': 1.0, 'angle': 0.0},
            {'type': 'high', 'y':  4.0, 'speed': 2.5, 'angle': 0.0},
        ]

        self.conv_overlap_l = np.zeros(self.hrir_len - 1, dtype=np.float32)
        self.conv_overlap_r = np.zeros(self.hrir_len - 1, dtype=np.float32)

        # --- [3] スピーカー特性プリセット ---
        self.speaker_presets = {
            'studio': {'gains': [1.0, 1.0, 1.1], 'directivity': [1.0, 2.0, 3.5], 'wall_absorption': 0.35},
            'theater': {'gains': [1.4, 0.9, 0.9], 'directivity': [0.5, 1.2, 2.0], 'wall_absorption': 0.20},
            'pa':      {'gains': [1.1, 1.2, 1.3], 'directivity': [2.0, 3.5, 6.0], 'wall_absorption': 0.45},
            'small':   {'gains': [0.4, 1.1, 1.0], 'directivity': [1.0, 1.5, 2.0], 'wall_absorption': 0.30}
        }

        # --- [4] リバーブ回路 ---
        self.delay_len_l = int(0.06 * self.sr)
        self.delay_len_r = int(0.075 * self.sr)
        self.delay_buf_l = np.zeros(self.delay_len_l, dtype=np.float32)
        self.delay_buf_r = np.zeros(self.delay_len_r, dtype=np.float32)
        self.delay_idx_l = 0
        self.delay_idx_r = 0

        self.wall_lp_l = 0.0
        self.wall_lp_r = 0.0

        # --- [5] 自動音量引き上げ（AGC）用状態変数 ---
        self.agc_gain = 1.0         # 現在のブースト倍率
        self.target_peak = 0.85      # 目標ピーク値 (85%)

        # --- [6] 従来エフェクト（Bass / Echo / Vocal / Live / Reverb）用状態変数の初期化 ---
        self.bass_lp_l = 0.0
        self.bass_lp_r = 0.0

        self.echo_buf_l = np.zeros(9600, dtype=np.float32)
        self.echo_buf_r = np.zeros(9600, dtype=np.float32)
        self.echo_idx = 0

        self.vocal_lp_l = 0.0
        self.vocal_lp_r = 0.0

        self.live_buf_l = np.zeros(2880, dtype=np.float32)
        self.live_buf_r = np.zeros(2880, dtype=np.float32)
        self.live_idx = 0
        self.live_lp_l = 0.0
        self.live_lp_r = 0.0

        self.rev_buf_l = np.zeros(12000, dtype=np.float32)
        self.rev_buf_r = np.zeros(12000, dtype=np.float32)
        self.rev_idx = 0

    def read(self):
        raw_data = self.source.read()
        if not raw_data:
            # AudioPlayerは最外層のAudioSourceだけを確認するため、
            # FFmpegソースで記録されたエラーをこのラッパーへ伝播する。
            source_error = getattr(self.source, "_current_error", None)
            if source_error:
                self._current_error = source_error
            return b""

        self.has_output = True
        num_samples = len(raw_data) // 4
        fmt = f"<{num_samples * 2}h"
        samples = list(struct.unpack(fmt, raw_data))
        
        mode = self.state.get('eq', 'flat')
        self.count += 1

        if mode == 'spatial':
            in_data = np.array(samples, dtype=np.float32) / 32768.0
            mono_in = (in_data[0::2] + in_data[1::2]) * 0.5
            n_samples = len(mono_in)

            global_distance = max(0.1, float(self.state.get('spatial_distance', 2.0)))
            reverb_mix = float(self.state.get('spatial_room_size', 0.3))
            
            # 💡 [機能拡張①] 回転モード ('off', 'standard', '3d')
            rot_mode = self.state.get('spatial_rot_mode', 'standard')
            if 'spatial_rot_mode' not in self.state:
                rot_mode = 'standard' if self.state.get('is_rotating', True) else 'off'

            speaker_type = self.state.get('spatial_speaker', 'studio')
            preset = self.speaker_presets.get(speaker_type, self.speaker_presets['studio'])
            max_boost = max(1.0, float(self.state.get('spatial_agc_max', 4.0)))

            # A. 帯域分割
            band_low, self.zi_low = signal.sosfilt(self.sos_low, mono_in, zi=self.zi_low)
            band_mid, self.zi_mid = signal.sosfilt(self.sos_mid, mono_in, zi=self.zi_mid)
            band_high, self.zi_high = signal.sosfilt(self.sos_high, mono_in, zi=self.zi_high)
            band_signals = [band_low, band_mid, band_high]

            # 💡 [機能拡張②] 距離に応じた空気吸収・高域減衰 (Low-Pass Filter 係数)
            # 距離が遠いほど高音が空気に吸収され、マイルドな音質になります
            air_absorption_coeff = math.exp(-0.08 * global_distance)

            full_out_l = np.zeros(n_samples + self.hrir_len - 1, dtype=np.float32)
            full_out_r = np.zeros(n_samples + self.hrir_len - 1, dtype=np.float32)

            # B. 帯域ごとの回転 ＆ 距離計算 ＆ 畳み込み
            for i, config in enumerate(self.band_configs):
                # 1. 回転位置計算
                if rot_mode == '3d':
                    # 3軸 (Pitch/Yaw/Roll 複合) 回転
                    config['angle'] += 0.015 * config['speed']
                    pitch = math.sin(config['angle'] * 0.7) * 0.45  # 上下角 (Pitch)
                    yaw = config['angle']                         # 水平角 (Yaw)
                    
                    x = math.sin(yaw) * math.cos(pitch) * global_distance
                    z = -math.cos(yaw) * math.cos(pitch) * global_distance
                    angle_deg = math.degrees(math.atan2(x, -z)) % 360
                    
                    # HRTFテーブルは -4.0 / 0.0 / 4.0 の仰角キーで構築している。
                    # 3D回転でも必ず同じ集合から最も近い仰角を選択する。
                    elevation_levels = (-4.0, 0.0, 4.0)
                    target_elevation = (pitch / 0.45) * 4.0
                    y_elevation = min(elevation_levels, key=lambda value: abs(value - target_elevation))
                elif rot_mode == 'standard':
                    # 通常 2D 水平回転
                    config['angle'] += 0.015 * config['speed']
                    x = math.sin(config['angle']) * global_distance
                    z = -math.cos(config['angle']) * global_distance
                    angle_deg = math.degrees(math.atan2(x, -z)) % 360
                    y_elevation = config['y']
                else:
                    # 静止 (OFF)
                    angle_deg = 0.0
                    y_elevation = config['y']

                dir_idx = int((angle_deg / 360.0) * self.num_directions) % self.num_directions
                
                directivity_power = preset['directivity'][i]
                band_gain = preset['gains'][i]

                cos_theta = math.cos(math.radians(angle_deg))
                speaker_gain = math.pow(max(0.0, 0.5 * (1.0 + cos_theta)), directivity_power) * band_gain

                hrir_l = self.hrir_table_l[(y_elevation, dir_idx)]
                hrir_r = self.hrir_table_r[(y_elevation, dir_idx)]

                # 距離減衰 ＋ 指向性ゲイン
                dist_atten = (1.0 / max(0.5, global_distance)) * speaker_gain
                band_sig = band_signals[i] * dist_atten

                # 空気吸収（高域減衰）の適用
                if hasattr(self, 'air_lp_zi'):
                    band_sig, self.air_lp_zi[i] = signal.sosfilt(
                        signal.butter(1, air_absorption_coeff, 'low', output='sos'), 
                        band_sig, zi=self.air_lp_zi[i]
                    )

                full_out_l += signal.oaconvolve(band_sig, hrir_l, mode='full')
                full_out_r += signal.oaconvolve(band_sig, hrir_r, mode='full')

            # Overlap-Add 処理
            full_out_l[:self.hrir_len - 1] += self.conv_overlap_l
            full_out_r[:self.hrir_len - 1] += self.conv_overlap_r

            self.conv_overlap_l = full_out_l[n_samples:].copy()
            self.conv_overlap_r = full_out_r[n_samples:].copy()

            spatial_out_l = full_out_l[:n_samples]
            spatial_out_r = full_out_r[:n_samples]

            # 💡 [機能拡張③] 4×4 FDN (Feedback Delay Network) による高音質室内残響
            rev_out_l = np.zeros(n_samples, dtype=np.float32)
            rev_out_r = np.zeros(n_samples, dtype=np.float32)
            
            # FDN用のフィードバック・反射ゲイン計算（距離に応じて初期反射の遅延と壁吸収率が可変）
            wall_absorption = preset['wall_absorption'] * math.pow(0.9, global_distance)
            fb_matrix = 0.5 * np.array([
                [ 1,  1,  1,  1],
                [ 1, -1,  1, -1],
                [ 1,  1, -1, -1],
                [ 1, -1, -1,  1]
            ], dtype=np.float32)  # Hadamard 行列によるエネルギー保存拡散

            # C. FDN 室内残響（プツプツ音ノイズ対策・平滑化版）
            res_mode = self.state.get('fdn_resolution', 4)
            n_ch = 8 if res_mode == 8 else 4

            # 1. バッファ等の動的初期化
            if (not hasattr(self, 'fdn_delay_bufs') or 
                len(self.fdn_delay_bufs) != n_ch or 
                not hasattr(self, 'fdn_prev_fb') or 
                len(self.fdn_prev_fb) != n_ch):
                
                if n_ch == 8:
                    self.fdn_delay_lens = [1117, 1357, 1597, 1861, 2111, 2399, 2671, 2999]
                else:
                    self.fdn_delay_lens = [1117, 1357, 1597, 1861]
                
                self.fdn_delay_bufs = [np.zeros(l, dtype=np.float32) for l in self.fdn_delay_lens]
                self.fdn_lp_zi = [np.zeros((1, 2), dtype=np.float32) for _ in range(n_ch)]
                self.fdn_prev_fb = np.zeros(n_ch, dtype=np.float32)

            # 2. コマンド値の取得（発振によるノイズを防ぐため fb_val を安全値に上限ガード）
            fb_val = np.clip(float(self.state.get('fdn_feedback', 0.5)), 0.0, 0.85)
            wet_val = float(self.state.get('fdn_wet', reverb_mix * 1.2))

            # 3. 壁面吸音（ローパスフィルタ）
            wall_abs = np.clip(preset['wall_absorption'], 0.1, 0.8)
            cutoff_freq = max(1000.0, 12000.0 * (1.0 - wall_abs))
            sos_wall = signal.butter(1, cutoff_freq / (self.sr / 2), 'low', output='sos')

            # 4. 拡散行列の構築
            if n_ch == 8:
                u = np.ones((8, 1), dtype=np.float32)
                matrix_base = np.eye(8, dtype=np.float32) - (2.0 / 8.0) * np.dot(u, u.T)
                dry_in = [
                    spatial_out_l, spatial_out_r, 
                    spatial_out_l * 0.7, spatial_out_r * 0.7,
                    spatial_out_l * 0.5, spatial_out_r * 0.5,
                    spatial_out_l * 0.3, spatial_out_r * 0.3
                ]
            else:
                matrix_base = 0.5 * np.array([
                    [ 1,  1,  1,  1],
                    [ 1, -1,  1, -1],
                    [ 1, -1, -1,  1],
                    [-1,  1, -1,  1]
                ], dtype=np.float32)
                dry_in = [spatial_out_l, spatial_out_r, spatial_out_l * 0.7, spatial_out_r * 0.7]

            fb_matrix = fb_val * matrix_base

            # 5. 各チャンネルのループ・ディレイ処理（クリックノイズ解消処理）
            rev_channels = []
            for ch in range(n_ch):
                buf = self.fdn_delay_bufs[ch]
                
                # 入力信号に前回のフィードバック(単一値ではなく滑らかにフェード接続)を加算
                fb_smooth = np.linspace(self.fdn_prev_fb[ch], 0.0, n_samples, dtype=np.float32)
                in_sig = dry_in[ch] + fb_smooth
                
                # ディレイバッファと入力をスムーズに結合
                concatenated = np.concatenate([buf, in_sig])
                delay_out = concatenated[:n_samples]
                
                # 次回用バッファの更新
                self.fdn_delay_bufs[ch] = concatenated[n_samples:]

                # 壁面吸音フィルタを通す
                lp_out, self.fdn_lp_zi[ch] = signal.sosfilt(
                    sos_wall,
                    delay_out, 
                    zi=self.fdn_lp_zi[ch]
                )
                rev_channels.append(lp_out)

            # 6. 行列演算とフィードバック保持
            rev_stacked = np.vstack(rev_channels)
            fb_out = np.dot(fb_matrix, rev_stacked)
            
            # フレーム間の境界ノイズを防ぐため、末尾のフィードバック音を滑らかに更新
            self.fdn_prev_fb = fb_out[:, -1]

            if n_ch == 8:
                rev_out_l = (fb_out[0] + fb_out[2] + fb_out[4] + fb_out[6]) * 0.25
                rev_out_r = (fb_out[1] + fb_out[3] + fb_out[5] + fb_out[7]) * 0.25
            else:
                rev_out_l = (fb_out[0] + fb_out[2]) * 0.5
                rev_out_r = (fb_out[1] + fb_out[3]) * 0.5

            # D. ミックス処理
            mix_l = spatial_out_l + rev_out_l * wet_val
            mix_r = spatial_out_r + rev_out_r * wet_val

            # E. 可変自動音量引き上げ（AGC）処理
            current_peak = max(np.max(np.abs(mix_l)), np.max(np.abs(mix_r)), 1e-5)
            desired_gain = np.clip(self.target_peak / current_peak, 0.8, max_boost)

            if desired_gain < self.agc_gain:
                self.agc_gain = self.agc_gain * 0.8 + desired_gain * 0.2
            else:
                self.agc_gain = self.agc_gain * 0.98 + desired_gain * 0.02

            volume = float(np.clip(self.state.get('volume', 1.0), 0.0, 2.0))
            final_l = np.clip(mix_l * self.agc_gain * volume, -1.0, 1.0)
            final_r = np.clip(mix_r * self.agc_gain * volume, -1.0, 1.0)

            out_samples = np.empty(len(samples), dtype=np.int16)
            out_samples[0::2] = (final_l * 32767).astype(np.int16)
            out_samples[1::2] = (final_r * 32767).astype(np.int16)

            return struct.pack(fmt, *out_samples.tolist())
            
        # ==================================================
        # それ以外のモード（従来のサンプル単位処理）
        # ==================================================
        out_samples = []

        # rotate用の事前計算
        rot_angle = (self.count / 400.0) * 2.0 * math.pi
        rot_l = 0.5 + 0.5 * math.sin(rot_angle)
        rot_r = 1.0 - rot_l

        for i in range(num_samples):
            in_l = samples[i * 2] / 32768.0
            in_r = samples[i * 2 + 1] / 32768.0

            if mode == 'flat':
                out_l, out_r = in_l, in_r

            elif mode in ('bass', 'superbass'):
                boost = 2.8 if mode == 'superbass' else 1.8
                self.bass_lp_l = self.bass_lp_l + 0.06 * (in_l - self.bass_lp_l)
                self.bass_lp_r = self.bass_lp_r + 0.06 * (in_r - self.bass_lp_r)
                out_l = in_l + self.bass_lp_l * boost
                out_r = in_r + self.bass_lp_r * boost
                out_l = out_l / (1.0 + abs(out_l) * 0.2)
                out_r = out_r / (1.0 + abs(out_r) * 0.2)

            elif mode == 'echo':
                el = self.echo_buf_l[self.echo_idx]
                er = self.echo_buf_r[self.echo_idx]
                out_l = in_l + el * 0.4
                out_r = in_r + er * 0.4
                self.echo_buf_l[self.echo_idx] = in_l
                self.echo_buf_r[self.echo_idx] = in_r
                self.echo_idx = (self.echo_idx + 1) % 9600

            elif mode == 'hall':
                diff = in_l - in_r
                out_l = in_l + diff * 0.75
                out_r = in_r - diff * 0.75

            elif mode == 'vocal':
                self.vocal_lp_l = self.vocal_lp_l + 0.35 * (in_l - self.vocal_lp_l)
                self.vocal_lp_r = self.vocal_lp_r + 0.35 * (in_r - self.vocal_lp_r)
                out_l = self.vocal_lp_l * 1.4
                out_r = self.vocal_lp_r * 1.4

            elif mode == 'live':
                ll = self.live_buf_l[self.live_idx]
                lr = self.live_buf_r[self.live_idx]
                mix_l = in_l + ll * 0.4
                mix_r = in_r + lr * 0.4
                self.live_buf_l[self.live_idx] = in_l
                self.live_buf_r[self.live_idx] = in_r
                self.live_idx = (self.live_idx + 1) % 2880
                
                self.live_lp_l = self.live_lp_l + 0.85 * (mix_l - self.live_lp_l)
                self.live_lp_r = self.live_lp_r + 0.85 * (mix_r - self.live_lp_r)
                
                diff = self.live_lp_l - self.live_lp_r
                out_l = self.live_lp_l + diff * 0.3
                out_r = self.live_lp_r - diff * 0.3

            elif mode == 'rotate':
                out_l = in_l * rot_l
                out_r = in_r * rot_r

            elif mode == 'reverb':
                r1 = self.rev_buf_l[(self.rev_idx - 5771) % 12000]
                r2 = self.rev_buf_l[(self.rev_idx - 8641) % 12000]
                r3 = self.rev_buf_r[(self.rev_idx - 11549) % 12000]
                
                out_l = in_l + (r1 * 0.25 + r2 * 0.15)
                out_r = in_r + (r3 * 0.25 + r2 * 0.15)
                
                self.rev_buf_l[self.rev_idx] = in_l + r3 * 0.3
                self.rev_buf_r[self.rev_idx] = in_r + r1 * 0.3
                self.rev_idx = (self.rev_idx + 1) % 12000
            else:
                out_l, out_r = in_l, in_r

            volume = float(np.clip(self.state.get('volume', 1.0), 0.0, 2.0))
            out_l = max(-1.0, min(1.0, out_l * volume))
            out_r = max(-1.0, min(1.0, out_r * volume))
            
            out_samples.append(int(out_l * 32767))
            out_samples.append(int(out_r * 32767))
            
        return struct.pack(fmt, *out_samples)

    def cleanup(self):
        self.source.cleanup()


# ==================================================
# UI: 立体音響（Spatial）設定パネル・コントロール View
# ==================================================
class SpatialControlView(discord.ui.View):
    def __init__(self, cog, guild_id: int):
        super().__init__(timeout=PANEL_TIMEOUT_SECONDS)
        self.cog = cog
        self.guild_id = guild_id

        state = cog.get_state(guild_id)
        
        # 💡 [修正点] 参照するボタン名を実際のメソッド名 (toggle_rot_mode または toggle_rotate) に合わせます
        rot_mode = state.get('spatial_rot_mode', 'standard')
        rot_labels = {
            'off': '<:Pause:1561700510447312916> 回転: OFF',
            'standard': '🌀 回転: 通常',
            '3d': '🪐 回転: 3D'
        }
        # toggle_rot_mode ボタンのラベルを更新する場合：
        if hasattr(self, 'toggle_rot_mode'):
            self.toggle_rot_mode.label = rot_labels.get(rot_mode, '🌀 回転')
        # もし toggle_rotate のまま使用している場合：
        elif hasattr(self, 'toggle_rotate'):
            is_rotating = state.get('is_rotating', True)
            self.toggle_rotate.label = "🌀 回転: ON" if is_rotating else "<:Pause:1561700510447312916> 回転: OFF"

    # 💡 ボタンの定義（デコレータで定義されたメソッド）
    @discord.ui.button(label="🔄 回転モード切替", style=discord.ButtonStyle.primary, row=0)
    async def toggle_rot_mode(self, interaction: discord.Interaction, button: discord.ui.Button):
        state = self.cog.get_state(self.guild_id)
        current = state.get('spatial_rot_mode', 'standard')
        
        # モードの順繰り切替: standard -> 3d -> off -> standard
        next_mode = {'standard': '3d', '3d': 'off', 'off': 'standard'}[current]
        state['spatial_rot_mode'] = next_mode
        state['is_rotating'] = (next_mode != 'off')
        
        await self.update_panel(interaction)

    async def update_panel(self, interaction: discord.Interaction):
        """パネルのEmbed表示を最新状態に更新"""
        state = self.cog.get_state(self.guild_id)
        current_eq = state.get('eq', 'flat')
        dist = state.get('spatial_distance', 2.0)
        room = state.get('spatial_room_size', 0.3)
        speaker = state.get('spatial_speaker', 'studio')
        agc_max = state.get('spatial_agc_max', 4.0)
        is_rotating = "ON" if state.get('is_rotating', True) else "OFF"

        speaker_names = {
            'studio': '🎙️ スタジオモニター (高解像度・フラット)',
            'theater': '🎬 シアター (重低音・サラウンド)',
            'pa': '🔊 PAスピーカー (高音圧・指向性強)',
            'small': '📻 小型スピーカー (コンパクト)'
        }

        embed = discord.Embed(
            title="🎧 立体音響 (3D Spatial Audio) 設定パネル",
            description=(
                "リアルタイムHRTFおよび空間音響パラメータを個別設定できます。\n"
                "下のメニュー操作は再生中の音声へ即座に反映されます。\n\n"
                f"現在のモード: **{current_eq}**\n"
                f"音像の距離 (Distance): **{dist}x**\n"
                f"部屋のリバーブ (Reverb Mix): **{room}**\n"
                f"スピーカー特性: **{speaker_names.get(speaker, speaker)}**\n"
                f"最大音量引き上げ幅 (AGC): **{agc_max}x** (+{round(20*math.log10(agc_max), 1)}dB)\n"
                f"3帯域立体回転: **{is_rotating}**"
            ),
            color=0x3498DB
        )
        await interaction.response.edit_message(embed=embed, view=self)

    # 1. Spatialモード ON ボタン
    @discord.ui.button(label="🎧 Spatial ON", style=discord.ButtonStyle.primary, row=0)
    async def toggle_spatial(self, interaction: discord.Interaction, button: discord.ui.Button):
        state = self.cog.get_state(self.guild_id)
        state['eq'] = 'spatial'
        await self.update_panel(interaction)



    # 3. 部屋のリバーブ量 (Reverb Mix) 選択メニュー
    @discord.ui.select(
        placeholder="🏠 部屋のリバーブ (残響量) を選択...",
        options=[
            discord.SelectOption(label="リバーブ OFF (0.0)", value="0.0", description="残響なし・ドライな音"),
            discord.SelectOption(label="控えめ (0.15)", value="0.15", description="小さな防音室程度の響き"),
            discord.SelectOption(label="標準 (0.3)", value="0.3", default=True, description="一般的なリスニングルーム"),
            discord.SelectOption(label="深い残響 (0.5)", value="0.5", description="ライブハウス・スタジオ感"),
            discord.SelectOption(label="大空間ホール (0.75)", value="0.75", description="コンサートホール級の豊かな残響"),
        ],
        row=1
    )
    async def select_reverb(self, interaction: discord.Interaction, select: discord.ui.Select):
        state = self.cog.get_state(self.guild_id)
        state['spatial_room_size'] = float(select.values[0])
        await self.update_panel(interaction)

    # 4. 音量引き上げ幅 (AGC) 選択メニュー
    @discord.ui.select(
        placeholder="🔊 自動音量引き上げ幅 (AGC) を選択...",
        options=[
            discord.SelectOption(label="引き上げなし (1.0x / 0dB)", value="1.0"),
            discord.SelectOption(label="控えめ (2.0x / +6dB)", value="2.0"),
            discord.SelectOption(label="標準 (4.0x / +12dB)", value="4.0", default=True),
            discord.SelectOption(label="強力 (6.0x / +15.5dB)", value="6.0"),
        ],
        row=2
    )
    async def select_agc(self, interaction: discord.Interaction, select: discord.ui.Select):
        state = self.cog.get_state(self.guild_id)
        state['spatial_agc_max'] = float(select.values[0])
        await self.update_panel(interaction)

    # 5. 音像の距離 ＆ スピーカー特性 (ドロップダウン)
    @discord.ui.select(
        placeholder="📻 スピーカー特性を選択...",
        options=[
            discord.SelectOption(label="スタジオモニター (高解像度・フラット)", value="studio", default=True),
            discord.SelectOption(label="シアター用 (重低音・サラウンド)", value="theater"),
            discord.SelectOption(label="PAスピーカー (ライブハウス風)", value="pa"),
            discord.SelectOption(label="小型スピーカー (スモール)", value="small"),
        ],
        row=3
    )
    async def select_speaker(self, interaction: discord.Interaction, select: discord.ui.Select):
        state = self.cog.get_state(self.guild_id)
        state['spatial_speaker'] = select.values[0]
        await self.update_panel(interaction)
# =====================
# UI Panel Component
# =====================
# ==========================================
# ⚡ 動的にコンポーネントが組み替わる統合パネルView
# ==========================================
# =====================
# Search & Custom EQ Modals
# =====================
class SearchModal(discord.ui.Modal, title="YouTube 楽曲検索"):
    """パネルから直接呼び出せるキーワード検索用モーダル窓"""
    keyword_input = discord.ui.TextInput(
        label="検索キーワードまたはURL",
        placeholder="例: 米津玄師 地球儀 / https://...",
        required=True,
        max_length=200,
        style=discord.TextStyle.short
    )

    def __init__(self, cog, guild_id: int):
        super().__init__()
        self.cog = cog
        self.guild_id = guild_id

    async def on_submit(self, interaction: discord.Interaction):
        await interaction.response.defer(ephemeral=True)
        keyword = self.keyword_input.value.strip()
        state = self.cog.get_state(self.guild_id)
        
        try:
            is_yt = False
            url, filename = None, None

            if self.cog._spotify_playlist_id(keyword):
                await self.cog.start_spotify_playlist_load(interaction, keyword)
                return

            if "youtube.com" in keyword or "youtu.be" in keyword:
                info = await self.cog.get_yt_info(keyword)
                url, filename, is_yt = keyword, info['title'], True
            else:
                info = await self.cog.get_yt_info(f"ytsearch:{keyword}")
                # キューには再取得可能な動画ページURLを保存する。
                # 一時的なvideoplayback URLを保存すると、再解析時に403となる。
                url, filename, is_yt = info['webpage_url'], info['title'], True

            state['current_ctx'] = interaction
            if not await self.cog.enqueue_track(self.guild_id, (url, filename, None, is_yt)):
                await interaction.followup.send(
                    embed=we(f"<:failed:1490986584676368535> キューの上限（{MAX_QUEUE_SIZE}件）に達しています。"),
                    ephemeral=True,
                )
                return
            await interaction.followup.send(embed=we(f"<:success:1490985168100659322> **{filename}** をキューに追加しました！"), ephemeral=True)

            # バグ修正: interaction.guild から voice_client を取得するように修正
            vc = interaction.guild.voice_client if interaction.guild else None
            if vc and not has_audio_source(vc, "music") and not state['is_processing_queue'] and not state['is_paused']:
                await self.cog.check_queue(self.guild_id)
            else:
                await self.cog.update_panel(self.guild_id)

        except Exception as e:
            await interaction.followup.send(embed=we(f"<:failed:1490986584676368535> 検索中にエラーが発生しました: {e}"), ephemeral=True)


class CustomEQModal(discord.ui.Modal, title="カスタムEQ (FFmpegフィルター入力)"):
    """パネルから呼び出される、FFmpegオーディオフィルターの直接入力用モーダル窓"""
    filter_input = discord.ui.TextInput(
        label="FFmpegオーディオフィルター文字列",
        placeholder="例: vibrato=f=4,tremolo=f=5 (空欄でフラットに戻す)",
        required=False,
        max_length=400,
        style=discord.TextStyle.paragraph
    )

    def __init__(self, cog, guild_id: int):
        super().__init__()
        self.cog = cog
        self.guild_id = guild_id

    async def on_submit(self, interaction: discord.Interaction):
        state = self.cog.get_state(self.guild_id)
        user_filter = self.filter_input.value.strip()

        if not user_filter:
            state['eq'] = "flat"
            state['custom_eq_filter'] = None
            await interaction.response.send_message(embed=we("⚙️ カスタムEQを解除しました（Flatに戻します）。"), ephemeral=True)
        else:
            if not is_safe_custom_audio_filter(user_filter):
                await interaction.response.send_message(
                    embed=we("<:failed:1490986584676368535> 使用できないフィルターです。equalizer、bass、treble、volume、vibrato、tremoloなどの"
                              "音声フィルターだけをカンマ区切りで指定してください。"),
                    ephemeral=True,
                )
                return
            state['eq'] = "custom"
            state['custom_eq_filter'] = user_filter
            await interaction.response.send_message(embed=we(f"⚙️ カスタムEQを設定しました:\n`{user_filter}`\n即時反映します。"), ephemeral=True)

        ctx = state['current_ctx'] or interaction
        await self.cog.apply_immediate_setting(ctx)
        await self.cog.update_panel(self.guild_id)


# =====================
# UI Panel Component
# =====================
class VoiceControlView(discord.ui.View):
    """音量・倍速・EQ・再生コントロールをまとめた常時同期型インタラクティブメニューUI"""
    def __init__(self, cog, guild_id: int):
        super().__init__(timeout=PANEL_TIMEOUT_SECONDS)
        self.cog = cog
        self.guild_id = guild_id
        
        self.add_item(self.SpeedSelect(cog, guild_id))
        self.add_item(self.VolumeSelect(cog, guild_id))
        self.add_item(self.EQSelect(cog, guild_id))

    class SpeedSelect(discord.ui.Select):
        def __init__(self, cog, guild_id):
            self.cog = cog
            self.guild_id = guild_id
            state = cog.get_state(guild_id)
            options = [
                discord.SelectOption(label="0.5x (遅め)", value="0.5"),
                discord.SelectOption(label="0.8x", value="0.8"),
                discord.SelectOption(label="1.0x (標準)", value="1.0"),
                discord.SelectOption(label="1.2x", value="1.2"),
                discord.SelectOption(label="1.5x", value="1.5"),
                discord.SelectOption(label="2.0x", value="2.0"),
                discord.SelectOption(label="4.0x", value="4.0"),
                discord.SelectOption(label="8.0x", value="8.0"),
                discord.SelectOption(label="16.0x", value="16.0"),
                discord.SelectOption(label="32.0x", value="32.0"),
                discord.SelectOption(label="64.0x", value="64.0"),
            ]
            super().__init__(placeholder=f"⚡ 速度変更 (現在: {state['speed']}x)", min_values=1, max_values=1, options=options, row=0)

        async def callback(self, interaction: discord.Interaction):
            state = self.cog.get_state(self.guild_id)
            previous_speed = state.get('speed', 1.0)
            state['speed'] = float(self.values[0])
            await interaction.response.send_message(embed=we(f"⚡ 再生速度を `{state['speed']}` 倍に設定しました（現在位置から即時反映）。"), ephemeral=True)
            # ★ 古い current_ctx ではなく、いま操作した interaction を渡す
            await self.cog.apply_immediate_setting(interaction, elapsed_speed=previous_speed)

    class VolumeSelect(discord.ui.Select):
        def __init__(self, cog, guild_id):
            self.cog = cog
            self.guild_id = guild_id
            state = cog.get_state(guild_id)
            options = [
                discord.SelectOption(label="10%", value="0.1"),
                discord.SelectOption(label="50%", value="0.5"),
                discord.SelectOption(label="80%", value="0.8"),
                discord.SelectOption(label="100% (標準)", value="1.0"),
                discord.SelectOption(label="150%", value="1.5"),
                discord.SelectOption(label="200% (最大)", value="2.0"),
            ]
            super().__init__(placeholder=f"🔊 音量変更 (現在: {int(state['volume']*100)}%)", min_values=1, max_values=1, options=options, row=1)

        async def callback(self, interaction: discord.Interaction):
            state = self.cog.get_state(self.guild_id)
            state['volume'] = float(self.values[0])
            await interaction.response.send_message(embed=we(f"🔊 音量を `{int(state['volume']*100)}%` に設定しました（即時反映）。"), ephemeral=True)
            # ★ 古い current_ctx ではなく、いま操作した interaction を渡す
            await self.cog.apply_immediate_setting(interaction)

    class EQSelect(discord.ui.Select):
        def __init__(self, cog, guild_id):
            self.cog = cog
            self.guild_id = guild_id
            state = cog.get_state(guild_id)
            options = [
                discord.SelectOption(label="Flat (標準)", value="flat"),
                discord.SelectOption(label="Spatial (3D立体音響)", value="spatial"), # 追加
                discord.SelectOption(label="Bass (低音強調)", value="bass"),
                discord.SelectOption(label="SuperBass (超重低音)", value="superbass"),
                discord.SelectOption(label="Vocal (ボーカル強調)", value="vocal"),
                discord.SelectOption(label="Echo (エコー)", value="echo"),
                discord.SelectOption(label="Hall (ホール感)", value="hall"),
                discord.SelectOption(label="Live (ライブ風)", value="live"),
                discord.SelectOption(label="Rotate (回転音響)", value="rotate"),
            ]
            current_eq = state['eq'] if state['eq'] != "custom" else "custom (自由指定)"
            super().__init__(placeholder=f"🎬 プリセットEQ選択 (現在: {current_eq})", min_values=1, max_values=1, options=options, row=2)

        async def callback(self, interaction: discord.Interaction):
            state = self.cog.get_state(self.guild_id)
            state['eq'] = self.values[0]
            state['custom_eq_filter'] = None
            await interaction.response.send_message(embed=we(f"🎬 エフェクトを `{state['eq']}` に変更しました（即時反映）。"), ephemeral=True)
            # ★ current_ctx ではなく interaction を渡す。これが「次の曲に飛ぶ」バグの修正点。
            await self.cog.apply_immediate_setting(interaction)

    @discord.ui.button(label="🔎", style=discord.ButtonStyle.success, row=3)
    async def search_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        modal = SearchModal(self.cog, self.guild_id)
        await interaction.response.send_modal(modal)

    @discord.ui.button(label="⚙️", style=discord.ButtonStyle.secondary, row=3)
    async def custom_eq_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        modal = CustomEQModal(self.cog, self.guild_id)
        await interaction.response.send_modal(modal)

    @discord.ui.button(label="", emoji="<:Pause:1561700510447312916>", style=discord.ButtonStyle.primary, row=3)
    async def pause_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        vc = interaction.guild.voice_client
        state = self.cog.get_state(self.guild_id)
        if vc and has_audio_source(vc, "music"):
            actual_played = (time.time() - state['start_time']) * state.get('speed', 1.0)
            state['elapsed_offset'] += actual_played
            state['is_paused'] = True
            remove_audio_source(vc, "music", notify=True)
            await interaction.response.send_message(embed=we(f"<:Pause:1561700510447312916> 再生を一時停止しました。(`{int(state['elapsed_offset'])}秒` 時点)"), ephemeral=True)
            await self.cog.update_panel(self.guild_id)
        else:
            await interaction.response.send_message(embed=we("<:failed:1490986584676368535> 現在再生中ではないか、既に一時停止されています。"), ephemeral=True)

    @discord.ui.button(label="再開", emoji="<:music:1561710964238450809>", style=discord.ButtonStyle.success, row=4)
    async def resume_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        vc = interaction.guild.voice_client
        state = self.cog.get_state(self.guild_id)
        if vc and state['is_paused'] and state['current_track']:
            state['is_paused'] = False
            await interaction.response.send_message(embed=we("▶️ 再生を再開します。"), ephemeral=True)
            await self.cog.check_queue(self.guild_id)
        else:
            await interaction.response.send_message(embed=we("<:failed:1490986584676368535> 再開できる一時停止中のトラックがありません。"), ephemeral=True)

    @discord.ui.button(label="⏭️", style=discord.ButtonStyle.secondary, row=4)
    async def skip_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        vc = interaction.guild.voice_client
        state = self.cog.get_state(self.guild_id)
        if vc and (has_audio_source(vc, "music") or state['is_paused']):
            state['current_track'] = None
            state['elapsed_offset'] = 0
            state['is_paused'] = False
            remove_audio_source(vc, "music", notify=True)
            await interaction.response.send_message(embed=we("⏭️ トラックをスキップしました。"), ephemeral=True)
        else:
            await interaction.response.send_message(embed=we("<:failed:1490986584676368535> 現在再生中の楽曲がありません。"), ephemeral=True)

    @discord.ui.button(label="🔀", style=discord.ButtonStyle.secondary, row=3)
    async def shuffle_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        state = self.cog.get_state(self.guild_id)
        state['shuffle_enabled'] = not state.get('shuffle_enabled', False)
        label = 'ON' if state['shuffle_enabled'] else 'OFF'
        await interaction.response.send_message(embed=we(f"🔀 シャッフルを `{label}` に設定しました。"), ephemeral=True)
        await self.cog.update_panel(self.guild_id)

    @discord.ui.button(label="🔁", style=discord.ButtonStyle.secondary, row=3)
    async def loop_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        state = self.cog.get_state(self.guild_id)
        next_mode = {'off': 'track', 'track': 'queue', 'queue': 'off'}[state.get('loop_mode', 'off')]
        state['loop_mode'] = next_mode
        labels = {'off': 'OFF', 'track': '1曲', 'queue': 'キュー'}
        await interaction.response.send_message(embed=we(f"🔁 ループを `{labels[next_mode]}` に設定しました。"), ephemeral=True)
        await self.cog.update_panel(self.guild_id)

    @discord.ui.button(label="📋", style=discord.ButtonStyle.secondary, row=4)
    async def queue_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.send_message(embed=self.cog.build_queue_embed(self.guild_id), ephemeral=True)

    @discord.ui.button(label="📚", style=discord.ButtonStyle.secondary, row=4)
    async def library_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        embed = discord.Embed(
            title="📚 ライブラリ",
            description="プレイリストを保存・一覧表示・再生できます。対象範囲を選択してください。",
            color=0x9B59B6,
        )
        await interaction.response.send_message(
            embed=embed,
            view=PlaylistLibraryView(self.cog),
            ephemeral=True,
        )

    @discord.ui.button(label="⏹️", style=discord.ButtonStyle.danger, row=4)
    async def stop_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        vc = interaction.guild.voice_client
        state = self.cog.get_state(self.guild_id)
        if vc:
            state['current_track'] = None
            state['elapsed_offset'] = 0
            state['is_paused'] = False
            while not state['queue'].empty():
                state['queue'].get_nowait()
            remove_audio_source(vc, "music", notify=True)
            await interaction.response.send_message(embed=we("⏹️ 再生を完全に停止し、キューをクリアしました。"), ephemeral=True)
            await self.cog.update_panel(self.guild_id)
        else:
            await interaction.response.send_message(embed=we("<:failed:1490986584676368535> ボイスチャンネルに接続していません。"), ephemeral=True)


def build_music_panel_layout(cog, guild_id: int, panel_text: str) -> discord.ui.LayoutView:
    """操作部品とステータスをComponents V2コンテナにまとめる。"""
    controls = VoiceControlView(cog, guild_id)
    rows: dict[int, list[discord.ui.Item]] = {}
    for item in controls.children:
        row = getattr(item, "row", None)
        if row is None:
            row = 0 if isinstance(item, discord.ui.Select) else 3
        rows.setdefault(row, []).append(item)
    container = discord.ui.Container(
        discord.ui.TextDisplay(panel_text[:4000]),
        *[discord.ui.ActionRow(*items) for _, items in sorted(rows.items())],
        accent_colour=0xFFFFFF,
    )
    layout = discord.ui.LayoutView(timeout=PANEL_TIMEOUT_SECONDS)
    layout.add_item(container)
    return layout


# 録音経路は開始・停止・保存のコマンドが未実装のため、誤って有効化しない。
# 受信音声を保存する機能を実装する際は、同意・保持期間・アクセス制御を含めて
# 専用Cogとして設計し直すこと。
class PlaylistNameModal(discord.ui.Modal, title="プレイリスト名"):
    name = discord.ui.TextInput(label="プレイリスト名", placeholder="保存名または再生名", max_length=100)

    def __init__(self, cog, action: str, scope: str):
        super().__init__()
        self.cog = cog
        self.action = action
        self.scope = scope

    async def on_submit(self, interaction: discord.Interaction):
        await self.cog._playlist_impl(
            Responder(interaction), self.action, self.name.value.strip(), self.scope
        )


class PlaylistLibraryView(discord.ui.View):
    """ライブラリボタンからプレイリスト操作を実行するUI。"""

    def __init__(self, cog):
        super().__init__(timeout=PANEL_TIMEOUT_SECONDS)
        self.cog = cog
        self.scope = "me"
        self.add_item(self.ScopeSelect(self))

    class ScopeSelect(discord.ui.Select):
        def __init__(self, view):
            self.library_view = view
            super().__init__(
                placeholder="📁 保存先・参照先を選択",
                options=[
                    discord.SelectOption(label="個人", value="me", emoji="👤", default=True),
                    discord.SelectOption(label="サーバー共有", value="server", emoji="🌐"),
                ],
            )

        async def callback(self, interaction: discord.Interaction):
            self.library_view.scope = self.values[0]
            await interaction.response.send_message(
                f"対象を **{'個人' if self.values[0] == 'me' else 'サーバー共有'}** に変更しました。",
                ephemeral=True,
            )

    @discord.ui.button(label="💾", style=discord.ButtonStyle.success)
    async def save_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.send_modal(PlaylistNameModal(self.cog, "save", self.scope))

    @discord.ui.button(label="📋", style=discord.ButtonStyle.secondary)
    async def list_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self.cog._playlist_impl(Responder(interaction), "list", scope=self.scope)

    @discord.ui.button(label="再生", emoji="<:music:1561710964238450809>", style=discord.ButtonStyle.primary)
    async def play_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.send_modal(PlaylistNameModal(self.cog, "play", self.scope))

    @discord.ui.button(label="削除", style=discord.ButtonStyle.danger)
    async def delete_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.send_modal(PlaylistNameModal(self.cog, "delete", self.scope))


RECORDING_ENABLED = False
BYTES_PER_SECOND = 48_000 * 2 * 2
FRAME_SIZE = 960 * 2 * 2
MAX_GAP_SECONDS = 5.0

class AudioSink(voice_recv.AudioSink):
    def __init__(self, bot, vc, update_callback=None):
        super().__init__()
        self.disabled = not RECORDING_ENABLED
        self.buffers = {}
        self.user_start_time = {}
        self.decoders = {}
        if self.disabled:
            logger.warning("AudioSink was created while recording is disabled; ignoring all incoming audio.")
            return
        self.bot = bot
        self.vc = vc  # DAVE復号のためVoiceRecvClientへの参照を保持
        self.buffers = {}
        self.user_start_time = {}  # ユーザーごとの録音開始時刻(壁時計基準)
        # Opusはステートフル(フレーム間の予測)なコーデックのため、
        # ユーザー(SSRC)ごとにデコーダーインスタンスを使い回して継続性を保つ
        self.decoders = {}
        self.packet_count = 0
        self.update_callback = update_callback
        self.last_update_time = 0
 
        # --- 診断用カウンタ ---
        self.write_call_count = 0
        self.dave_error_count = 0
        self.opus_error_count = 0
        self.total_frame_count = 0
 
    def wants_opus(self) -> bool:
        # voice_recv標準のPCMデコード経路(DAVE非対応)は使わず、
        # 生のOpusフレームを受け取って自前で DAVE復号 → Opusデコードする
        return True
 
    def write(self, user, data: voice_recv.VoiceData):
        if self.disabled:
            return
        try:
            self._write_inner(user, data)
        except Exception as e:
            # ここに来る例外は DAVE復号/Opusデコード以外の想定外のバグ。
            # voice_recv 側が write() の例外を握りつぶすことがあるため、
            # 必ず自分でログに出して見えるようにしておく。
            logger.error(f"[REC] AudioSink.write() で予期せぬエラー: {e!r}", exc_info=True)
 
    def _write_inner(self, user, data: voice_recv.VoiceData):
        # write() が実際に呼ばれているかどうかを独立してカウント
        # (opusデータの有無に関わらず、呼び出された時点でカウントする)
        self.write_call_count += 1
 
        raw_opus = getattr(data, 'opus', None)
        if not raw_opus:
            return
 
        if user is not None:
            user_key = f"{user.name}_{user.id}"
            user_id = user.id
        elif hasattr(data, 'ssrc') and data.ssrc:
            user_key = f"Speaker_{data.ssrc}"
            user_id = data.ssrc
        else:
            user_key = "Unknown_Speaker"
            user_id = 0
 
        self.total_frame_count += 1
 
        # --- 1. DAVE(E2EE)復号 ---
        try:
            payload = self.vc.dave_decrypt(user_id, bytes(raw_opus))
        except Exception as e:
            self.dave_error_count += 1
            if self.dave_error_count <= 3:  # ログが埋め尽くされないよう最初の数回だけ詳細を出す
                logger.error(f"[REC] DAVE decrypt failed for {user_key}: {e!r}", exc_info=True)
            return
 
        # --- 2. Opusデコード(ユーザーごとにデコーダーを使い回す) ---
        if user_key not in self.decoders:
            self.decoders[user_key] = discord.opus.Decoder()
        try:
            pcm = self.decoders[user_key].decode(payload, fec=False)
        except discord.opus.OpusError as e:
            self.opus_error_count += 1
            logger.debug(f"Opus decode skipped corrupted packet: {e}")
            return
 
        if not pcm:
            return
 
        now = time.time()
        if user_key not in self.buffers:
            self.buffers[user_key] = bytearray()
            self.user_start_time[user_key] = now
 
        # --- 3. 無音区間のゼロ埋め補正 ---
        # Discordは無音区間(VAD/DTX)ではパケットを送信しないため、
        # 受信したPCMをただ連結するだけだと発話同士が押し詰められて
        # しまう。壁時計を基準に本来あるべきバッファ長を計算し、
        # 不足分を無音(ゼロ)で埋めてから新しいPCMを追加する。
        elapsed = now - self.user_start_time[user_key]
        expected_len = int(elapsed * BYTES_PER_SECOND)
        expected_len -= expected_len % FRAME_SIZE
 
        current_len = len(self.buffers[user_key])
        if expected_len > current_len:
            gap = expected_len - current_len
            max_gap_bytes = int(MAX_GAP_SECONDS * BYTES_PER_SECOND)
            if gap > max_gap_bytes:
                gap = max_gap_bytes
                self.user_start_time[user_key] = now - (current_len + gap) / BYTES_PER_SECOND
            self.buffers[user_key].extend(b'\x00' * gap)
 
        self.buffers[user_key].extend(pcm)
        self.packet_count += 1
 
        # 3秒以上経過した場合のみメッセージ編集を呼び出す（レートリミット回避）
        if now - self.last_update_time >= 3.0 and self.update_callback:
            self.last_update_time = now
            asyncio.run_coroutine_threadsafe(
                self.update_callback(self.packet_count),
                self.bot.loop
            )
 
    def cleanup(self):
        # 注意: voice_recv は listen 終了時にこの cleanup() を
        # ファイナライザとして自動的に呼び出す(AudioSource.cleanup()と同様の仕様)。
        # そのため stop_listening() を呼んだ後では buffers はすでに空になっている。
        self.buffers.clear()
        self.user_start_time.clear()
        self.decoders.clear()


# =====================
# Main Voice Cog (Updated)
# =====================
class VoiceCog(commands.Cog):

    def __init__(self, bot):
        self.bot = bot
        self.reaction_enabled = {}
        self.emoji_sounds = {}
        self.states = {} 
        self.ir_l_id = "d424KTRkAlaetACCuFZOCjUtFNjho1t5" 
        self.ir_r_id = "d424KTRkAlaetACCuFZOCjUtFO0p0TMN"
        self.default_volume = 1.0
        self.default_speed = 1.0
        self.default_eq = "flat"
        self.recorders = {}
        # VC の持ち主管理と、誰もいないときの自動退出は core/voice_session.py に集約した。
        self.voice_sessions = get_manager(bot)
    def cog_unload(self):
        for state in self.states.values():
            for task_name in ('playlist_load_task', 'progress_task'):
                task = state.get(task_name)
                if task and not task.done():
                    task.cancel()

    def get_state(self, guild_id: int):
        if guild_id not in self.states:
            self.states[guild_id] = {
                'queue': asyncio.Queue(maxsize=MAX_QUEUE_SIZE),
                'current_ctx': None,
                'is_processing_queue': False,
                'current_track': None,
                'start_time': 0,
                'elapsed_offset': 0,
                'retry_count': 0,
                'volume': self.default_volume,
                'speed': self.default_speed,
                'eq': self.default_eq,
                'custom_eq_filter': None,
                'is_paused': False,
                'is_changing_setting': False,
                'panel_message': None,
                # --- 録音用ステート ---
                'is_recording': False,
                'rec_start_time': 0,
                'sink': None,
                # YouTubeは再生用URLが短時間で失効するため、再取得用のページURLを別途保持する。
                'current_yt_page_url': None,
                # yt-dlpが取得したストリーム用HTTPヘッダーをFFmpegにも渡す。
                'current_yt_headers': {},
                'loop_mode': 'off',
                'shuffle_enabled': False,
                'playlist_load_task': None,
                'progress_task': None,
            }
        return self.states[guild_id]

    def activity_snapshot(self, guild_id: int, *, is_playing: bool, now: float | None = None) -> dict:
        """Return only the safe, read-only fields needed by the Music Activity."""
        return build_music_activity_snapshot(
            self.get_state(guild_id), is_playing=is_playing, now=now
        )

    def _reset_playback(self, guild_id: int):
        """キューと再生中の曲を空にし、裏で動いているタスクを止める（退出時の後片付け）。"""
        state = self.get_state(guild_id)
        for task_name in ('playlist_load_task', 'progress_task'):
            task = state.get(task_name)
            if task and not task.done():
                task.cancel()
        while not state['queue'].empty():
            state['queue'].get_nowait()
        state['current_track'] = None
        state['current_yt_page_url'] = None
        state['elapsed_offset'] = 0
        state['is_paused'] = False
        state['is_processing_queue'] = False

    def _music_cleanup(self, guild_id: int):
        def cleanup(reason: str):
            self._reset_playback(guild_id)
        return cleanup

    def _busy_message(self, guild) -> str | None:
        """音楽以外の機能が VC を使っているときの案内文。音楽が使える状態なら None。"""
        session = self.voice_sessions.get(guild.id) if guild else None
        if session is not None and session.feature not in SHARED_FEATURES:
            return self.voice_sessions.busy_message(session)
        return None

    async def _acquire_music(self, guild, channel, user, text_channel):
        """音楽として VC に入る（入っていれば移動）。別機能が使用中なら VoiceBusy。"""
        return await self.voice_sessions.acquire(
            guild, channel, 'music', user,
            cleanup=self._music_cleanup(guild.id), text_channel=text_channel, force=True,
        )

    def _start_progress_task(self, guild_id: int):
        state = self.get_state(guild_id)
        task = state.get('progress_task')
        if task and not task.done():
            return
        state['progress_task'] = asyncio.create_task(self._progress_loop(guild_id))

    async def _progress_loop(self, guild_id: int):
        try:
            while True:
                await asyncio.sleep(15)
                guild = self.bot.get_guild(guild_id)
                vc = guild.voice_client if guild else None
                state = self.get_state(guild_id)
                if not vc or not vc.is_connected() or not has_audio_source(vc, "music") or not state.get('current_track'):
                    return
                await self.update_panel(guild_id)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Progress update task failed for guild %s", guild_id)
        finally:
            self.get_state(guild_id)['progress_task'] = None

    async def _load_playlist_in_background(self, ctx, tracks, label: str, status_message):
        """大規模プレイリストを応答期限に縛られず、キュー空き枠へ順次追加する。"""
        guild_id = ctx.guild.id
        state = self.get_state(guild_id)
        total = len(tracks)
        added = skipped = 0
        last_status_update = 0.0
        try:
            for index, item in enumerate(tracks, start=1):
                guild = self.bot.get_guild(guild_id)
                vc = guild.voice_client if guild else None
                if not vc or not vc.is_connected():
                    break
                while state['queue'].full():
                    await asyncio.sleep(1)
                    if not vc.is_connected():
                        return

                if isinstance(item, str):
                    item = {'input': item, 'attachment_id': item, 'is_youtube': False}
                is_yt = bool(item.get('is_youtube'))
                source_input = item.get('input')
                title = item.get('title') or '不明なタイトル'
                b62_id = item.get('attachment_id')
                if is_yt:
                    if not source_input:
                        skipped += 1
                        continue
                    track = (source_input, title, b62_id, True)
                else:
                    token = b62_id or source_input
                    url, filename = await self.get_attachment_info(token, guild_id)
                    if not url:
                        skipped += 1
                        continue
                    track = (url, filename, token, False)

                if await self.enqueue_track(guild_id, track):
                    added += 1
                    if not has_audio_source(vc, "music") and not state['is_processing_queue'] and not state['is_paused']:
                        await self.check_queue(guild_id)
                else:
                    skipped += 1

                now = time.monotonic()
                if now - last_status_update >= 5:
                    last_status_update = now
                    try:
                        await status_message.edit(
                            content=f"プレイリスト `{label}` を読込中: {index}/{total} 件（追加 {added} / スキップ {skipped}）"
                        )
                    except discord.HTTPException:
                        pass
                await asyncio.sleep(0)

            try:
                await status_message.edit(
                    content=f"プレイリスト `{label}` の読込完了: {total} 件中 {added} 件を追加、{skipped} 件をスキップしました。"
                )
            except discord.HTTPException:
                pass
        except asyncio.CancelledError:
            try:
                await status_message.edit(content=f"プレイリスト `{label}` の読込を中止しました（追加済み: {added} 件）。")
            except discord.HTTPException:
                pass
            raise
        except Exception:
            logger.exception("Playlist background load failed")
            try:
                await status_message.edit(content=f"プレイリスト `{label}` の読込中にエラーが発生しました（追加済み: {added} 件）。")
            except discord.HTTPException:
                pass
        finally:
            state['playlist_load_task'] = None

    async def start_playlist_load(self, ctx, tracks, label: str):
        """ctx / interaction のどちらからでも呼べる。"""
        r = Responder(ctx)
        if not tracks:
            return await r.send(embed=we("有効な曲が見つかりませんでした。"))
        state = self.get_state(r.guild.id)
        state['current_ctx'] = ctx
        task = state.get('playlist_load_task')
        if task and not task.done():
            task.cancel()
        status_message = await r.send(f"プレイリスト `{label}` の読込を開始します（全 {len(tracks)} 件）。", want_message=True)
        state['playlist_load_task'] = asyncio.create_task(
            self._load_playlist_in_background(ctx, tracks, label, status_message)
        )

    async def get_duration(self, url):
        try:
            cmd = [
                'ffprobe', '-v', 'quiet', '-print_format', 'json',
                '-show_format', '-show_streams', url
            ]
            proc = await asyncio.create_subprocess_exec(
                *cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE
            )
            try:
                stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=20)
            except asyncio.TimeoutError:
                proc.kill()
                await proc.communicate()
                logger.warning("ffprobe timed out after 20 seconds")
                return 0
            data = json.loads(stdout)
            return float(data['format']['duration'])
        except Exception:
            return 0
            
    async def get_attachment_info(self, b62_id: str, requesting_guild_id: int | None = None):
        if isinstance(b62_id, str) and b62_id.startswith(('http://', 'https://')):
            filename = b62_id.rsplit('/', 1)[-1].split('?', 1)[0] or 'audio'
            return b62_id, filename
        try:
            guild_id, channel_id, message_id = decode_full_id(b62_id)
            if requesting_guild_id is not None and guild_id != requesting_guild_id:
                logger.warning("Cross-guild attachment access blocked: request=%s source=%s", requesting_guild_id, guild_id)
                return None, None
            guild = self.bot.get_guild(guild_id) or await self.bot.fetch_guild(guild_id)
            if not guild: return None, None
            channel = guild.get_channel(channel_id) or await guild.fetch_channel(channel_id)
            if not channel: return None, None
            msg = await channel.fetch_message(message_id)
            if msg.attachments:
                return msg.attachments[0].url, msg.attachments[0].filename
        except Exception as e:
            logging.debug(f"Universal ID format match but lookup failed ({b62_id}): {e}")
        return None, None

    async def enqueue_track(self, guild_id: int, track: tuple) -> bool:
        """ギルドごとのキュー上限を守ってトラックを追加する。"""
        queue = self.get_state(guild_id)['queue']
        if queue.full():
            return False
        await queue.put(track)
        return True

    # --------------------------------------------------
    # 実装（/voice のパネルからVC参加・/voice のパネルからVC退出）
    # --------------------------------------------------
    async def _join_impl(self, r: Responder):
        voice = getattr(r.user, "voice", None)
        if not voice or not voice.channel:
            return await r.send(embed=we("先にボイスチャンネルに入ってください。"), ephemeral=True)

        # 接続処理が長引く可能性があるため defer（応答保留）を実行
        await r.defer()
        channel = voice.channel
        TIMEOUT_SECONDS = 45.0

        try:
            # 別の機能（録音など）が使用中なら追い出さずに断る。移動・新規接続ともにタイムアウトで保護する。
            await asyncio.wait_for(
                self._acquire_music(r.guild, channel, r.user, r.channel),
                timeout=TIMEOUT_SECONDS,
            )
            await r.send(embed=we(f"🔊 **{channel.name}** に参加しました。"))
        except VoiceBusy as busy:
            await r.send(embed=we(str(busy)), ephemeral=True)
        except asyncio.TimeoutError:
            await r.send(embed=we("⏱️ タイムアウト: ボイスチャンネルへの接続応答時間が超過しました。Botの権限やネットワーク状態をご確認ください。"))
        except Exception as e:
            await r.send(embed=we(f"<:failed:1490986584676368535> 接続失敗: {e}"))

    async def _leave_impl(self, r: Responder):
        guild_id = r.guild_id
        session = self.voice_sessions.get(guild_id)
        voice_client = r.voice_client
        if session is not None:
            # 音楽は今までどおり誰でも止められる。録音などは開始した人・管理者（または開始した人が不在）のみ。
            if not self.voice_sessions.can_leave(session, r.user):
                return await r.send(
                    embed=we(f"⚠️ いまは **{session.label}**（{session.user_name} さんが開始）で使用中です。"
                              f"止められるのは開始した人か管理者だけです（`{self._stop_hint(session.feature)}`）。"),
                    ephemeral=True,
                )
            await r.defer()
            await self.voice_sessions.release(
                guild_id, reason='stop' if session.feature == 'music' else 'leave', by=r.user,
            )
            await r.send(embed=we("👋 退出しました。"))
        elif voice_client:
            # 持ち主の記録がない古い接続
            self._reset_playback(guild_id)
            await voice_client.disconnect(force=True)
            await r.send(embed=we("👋 退出しました。"))
        else:
            await r.send(embed=we("ボットはボイスチャンネルに参加していません。"), ephemeral=True)

    @staticmethod
    def _stop_hint(feature: str) -> str:
        from core.voice_session import stop_hint
        return stop_hint(feature)


    @commands.command()
    async def ffversion(self, ctx):
        """FFmpegのバージョン情報を取得して表示します"""
        try:
            # 非同期プロセスで 'ffmpeg -version' を実行
            proc = await asyncio.create_subprocess_exec(
                'ffmpeg', '-version',
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE
            )
            stdout, _ = await proc.communicate()
            
            if stdout:
                # 出力の最初の一行（通常ここにバージョンが記載されています）を取得
                first_line = stdout.decode('utf-8', errors='ignore').split('\n')[0]
                await ctx.send(embed=we(title="FFmpeg Version Info", description=f"```\n{first_line}\n```"))
            else:
                await ctx.send(embed=we("<:failed:1490986584676368535> FFmpegのバージョン情報を取得できませんでした。"))
                
        except FileNotFoundError:
            await ctx.send(embed=we("<:failed:1490986584676368535> システムに `ffmpeg` コマンドが見つかりません。パスが通っているか確認してください。"))
        except Exception as e:
            await ctx.send(embed=we(f"<:failed:1490986584676368535> エラーが発生しました: {e}"))

    
    async def update_panel(self, guild_id: int):
        """現在の内部ステータスを読み取り、コントロールパネルをリアルタイム更新する"""
        state = self.get_state(guild_id)
        msg = state['panel_message']
        if not msg: return

        if state['is_paused']: status_icon = "<:Pause:1561700510447312916> 一時停止中"
        elif state['current_track']: status_icon = "▶️ 再生中"
        else: status_icon = "⏹️ 停止中"

        if state['current_track']:
            _, filename, duration, _, _ = state['current_track']
            m, s = divmod(int(duration), 60)
            duration_str = f"{m}:{s:02d}" if duration else "不明"
            elapsed = state.get('elapsed_offset', 0.0)
            if not state.get('is_paused'):
                elapsed += max(0.0, time.time() - state.get('start_time', time.time())) * state.get('speed', 1.0)
            elapsed = min(elapsed, duration) if duration else elapsed
            elapsed_m, elapsed_s = divmod(int(elapsed), 60)
            if duration:
                ratio = min(1.0, elapsed / duration)
                filled = round(ratio * 16)
                progress_bar = '█' * filled + '░' * (16 - filled)
                progress_info = f"`{elapsed_m}:{elapsed_s:02d}` {progress_bar} `{duration_str}`"
            else:
                progress_info = f"`{elapsed_m}:{elapsed_s:02d}` 再生位置を取得中"
            track_info = f"**{filename}** `[{duration_str}]`"
        else:
            track_info = "*楽曲が再生されていません*"
            progress_info = "*進捗は再生開始後に表示されます*"

        queue_size = state['queue'].qsize()
        queue_info = f"`{queue_size} 件` の楽曲が待機中" if queue_size > 0 else "待機中の楽曲はありません"

        current_eq = state['eq']
        eq_label = f"Custom (`{state['custom_eq_filter']}`)" if current_eq == "custom" else current_eq.capitalize()

        panel_text = (
            "# <:music:1561710964238450809> ボイスコントロールパネル\n"
            f"**状態:** {status_icon}\n"
            f"**オーディオ:** 🔊 `{int(state['volume']*100)}%`　⚡ `{state['speed']}x`　🎬 `{eq_label}`\n"
            f"**再生中:** {track_info}\n"
            f"**進捗:** {progress_info}\n"
        )
        loop_label = {'off': 'OFF', 'track': '1曲', 'queue': 'キュー'}.get(state.get('loop_mode'), 'OFF')
        shuffle_label = 'ON' if state.get('shuffle_enabled') else 'OFF'
        panel_text += (
            f"**再生モード:** ループ `{loop_label}` / シャッフル `{shuffle_label}`\n"
            f"**予約キュー:** {queue_info}\n\n"
            "速度・音量・EQの選択と再生操作は、このパネル内の各コントロールから行えます。"
        )

        try:
            await edit_message_v2(msg, build_music_panel_layout(self, guild_id, panel_text))
        except Exception as e:
            logging.error(f"Panel update failed: {e}")

    async def apply_immediate_setting(self, ctx_or_interaction, elapsed_speed: float | None = None):
        guild = getattr(ctx_or_interaction, 'guild', None)
        if not guild:
            return

        vc = guild.voice_client
        state = self.get_state(guild.id)

        if vc and has_audio_source(vc, "music") and state['current_track']:
            playback_speed = elapsed_speed if elapsed_speed is not None else state.get('speed', 1.0)
            actual_played = (time.time() - state['start_time']) * playback_speed
            state['elapsed_offset'] += actual_played

            # ★ 先にフラグを立てる。remove_audio_source の after コールバック
            #   (play_next) が current_track を破棄しないようにする。
            state['is_changing_setting'] = True
            remove_audio_source(vc, "music", notify=True)

            # afterコールバックが状態を解放する前に再生を開始すると、
            # VoiceClient.play() が "Already playing audio" を送出する。
            for _ in range(40):
                if not has_audio_source(vc, "music"):
                    break
                await asyncio.sleep(0.05)
            else:
                logging.error("設定変更後の音声停止がタイムアウトしました。")
                state['is_changing_setting'] = False
                return

            # ★ current_track と elapsed_offset は保持したまま check_queue で再開。
            #   play_next は is_changing_setting 中なので return している。
            state['is_changing_setting'] = False
            state['is_processing_queue'] = False
            await self.check_queue(guild.id)
        else:
            await self.update_panel(guild.id)

    async def _eq_impl(self, interaction: discord.Interaction, mode: str = "flat"):
        state = self.get_state(interaction.guild_id)
        
        if mode in EQ_SETTINGS:
            state['eq'] = mode
            state['custom_eq_filter'] = None
            msg = f"🎬 エフェクトをプリセット `{mode}` に変更しました。"
        else:
            state['eq'] = "custom"
            state['custom_eq_filter'] = mode
            msg = f"⚙️ カスタムEQフィルターを設定しました:\n`{mode}`"

        await interaction.response.send_message(embed=we(msg))
        # 曲を止めずにパネルだけ更新
        await self.update_panel(interaction.guild_id)

    @staticmethod
    def _eq_choices(current: str) -> list[app_commands.Choice[str]]:
        """EQ_SETTINGS の全プリセットを候補にし、入力途中の文字で絞り込む（最大25件）。"""
        choices = [
            app_commands.Choice(name=f"プリセット: {key}", value=key)
            for key in EQ_SETTINGS.keys()
        ]
        return [
            choice for choice in choices 
            if current.lower() in choice.name.lower() or current.lower() in choice.value.lower()
        ][:25]

    async def _volume_impl(self, r: Responder, value: float):
        if not 0.1 <= value <= 2.0:
            return await r.send(embed=we("音量は 0.1 から 2.0 の間で指定してください。"), ephemeral=True)
        state = self.get_state(r.guild.id)
        state['volume'] = value
        await r.send(embed=we(f"🔊 音量を `{value}` に設定しました。"))
        await self.apply_immediate_setting(r.source)

    async def _speed_impl(self, r: Responder, value: float):
        if not MIN_PLAYBACK_SPEED <= value <= MAX_PLAYBACK_SPEED:
            return await r.send(embed=we(f"速度は {MIN_PLAYBACK_SPEED} から {MAX_PLAYBACK_SPEED:g} の間で指定してください。"), ephemeral=True)
        state = self.get_state(r.guild.id)
        previous_speed = state.get('speed', 1.0)
        state['speed'] = value
        await r.send(embed=we(f"⚡ 再生速度を `{value}` 倍に設定しました（現在位置から反映）。"))
        await self.apply_immediate_setting(r.source, elapsed_speed=previous_speed)

    async def get_yt_info(self, url_or_search):
        loop = asyncio.get_running_loop()
        
        # 検索キーワードかURLかを判定（すでに ytsearch: 等がついている場合も考慮）
        if not url_or_search.startswith(('http://', 'https://', 'ytsearch:')) and not url_or_search.startswith('ytsearch1:'):
            target = f"ytsearch1:{url_or_search}"  # 最初の1件だけ取得するように明示
        else:
            target = url_or_search

        def _extract():
            with yt_dlp.YoutubeDL(YTDL_OPTIONS) as ydl:
                return ydl.extract_info(target, download=False)

        try:
            data = await loop.run_in_executor(None, _extract)
        except Exception as e:
            logging.error(f"yt-dlp extract error: {e}")
            raise Exception(f"YouTubeからの情報取得に失敗しました: {e}")

        if not data:
            raise Exception("データを得られませんでした。")

        # 検索結果（entries）の場合
        if 'entries' in data:
            entries = [e for e in data['entries'] if e is not None]
            if not entries:
                raise Exception("検索結果が見つかりませんでした。")
            data = entries[0]

        # 💡 [重要] 直接再生に使用する音声ストリームURL（stream_url / url）を優先取得
        play_url = data.get('url') or data.get('webpage_url')
        webpage_url = data.get('webpage_url') or data.get('url')

        return {
            'url': play_url,             # 再生で使うストリームURL
            'stream_url': play_url,      # 互換用
            'webpage_url': webpage_url,  # YouTube動画ページのURL
            'http_headers': data.get('http_headers') or {},
            'title': data.get('title', 'Unknown Title'),
            'duration': data.get('duration', 0)
        }

    @staticmethod
    def _spotify_playlist_id(value: str) -> str | None:
        """Spotifyの通常URLおよびintl付きURLからプレイリストIDを取得する。"""
        match = SPOTIFY_PLAYLIST_RE.search(value.strip())
        return match.group(1) if match else None

    async def get_spotify_playlist_entries(self, playlist_url: str):
        """公開プレイリストを認証不要のスクレイパーでYouTubeキュー形式へ変換する。"""
        if not self._spotify_playlist_id(playlist_url):
            raise ValueError('有効なSpotifyプレイリストURLを指定してください。')

        try:
            # 外部依存の未インストールで音楽Cog全体が読み込めなくならないよう、
            # Spotify URLを実際に処理する時だけ読み込む。
            from spotify_scraper import AsyncSpotifyClient

            async with AsyncSpotifyClient(locale='ja-JP') as client:
                playlist = await client.get_playlist(playlist_url, max_tracks=MAX_PLAYLIST_ITEMS)
        except ModuleNotFoundError as exc:
            raise RuntimeError(
                'Spotifyスクレイパーが未インストールです。requirements.txtを再インストールしてください。'
            ) from exc
        except Exception as exc:
            raise RuntimeError(
                'Spotifyプレイリストを読み込めませんでした。公開されているプレイリストURLを指定してください。'
            ) from exc

        tracks = []
        for playlist_track in playlist.tracks[:MAX_PLAYLIST_ITEMS]:
            track = playlist_track.track
            if not track.name:
                continue
            artists = ', '.join(artist.name for artist in track.artists if artist.name)
            query = f'{track.name} {artists}'.strip()
            tracks.append({
                'input': f'ytsearch1:{query}',
                'title': f'{track.name} — {artists}' if artists else track.name,
                'is_youtube': True,
            })
        return playlist.name or 'Spotifyプレイリスト', tracks

    async def _load_spotify_playlist_in_background(self, interaction, playlist_url: str, status_message):
        state = self.get_state(interaction.guild_id)
        try:
            await status_message.edit(content='Spotifyプレイリストの曲一覧を取得しています…')
            title, tracks = await self.get_spotify_playlist_entries(playlist_url)
            if not tracks:
                await status_message.edit(content='Spotifyプレイリストから再生可能な曲を取得できませんでした。')
                return
            await status_message.edit(content=f'Spotifyプレイリスト `{title}` を取得しました（全 {len(tracks)} 件）。キューへ追加します…')
            await self._load_playlist_in_background(interaction, tracks, title, status_message)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.exception('Spotify playlist extraction failed')
            try:
                await status_message.edit(content=f'Spotifyプレイリストの取得に失敗しました: {exc}')
            except discord.HTTPException:
                pass
        finally:
            state['playlist_load_task'] = None

    async def start_spotify_playlist_load(self, interaction, playlist_url: str):
        state = self.get_state(interaction.guild_id)
        state['current_ctx'] = interaction
        existing = state.get('playlist_load_task')
        if existing and not existing.done():
            existing.cancel()
        status_message = await interaction.followup.send(
            'Spotifyプレイリストの読込を受け付けました。バックグラウンドで曲一覧を取得します。',
            wait=True,
        )
        state['playlist_load_task'] = asyncio.create_task(
            self._load_spotify_playlist_in_background(interaction, playlist_url, status_message)
        )

    async def get_youtube_playlist_entries(self, playlist_url: str):
        """個別の音声URLを解決せず、YouTubeプレイリストの曲ページURLだけを取得する。"""
        loop = asyncio.get_running_loop()
        options = YTDL_OPTIONS.copy()
        options.update({
            'noplaylist': False,
            'extract_flat': 'in_playlist',
            'lazy_playlist': True,
            'skip_download': True,
        })

        def _extract():
            with yt_dlp.YoutubeDL(options) as ydl:
                data = ydl.extract_info(playlist_url, download=False)
                entries = []
                for entry in data.get('entries') or []:
                    if not entry:
                        continue
                    webpage_url = entry.get('webpage_url') or entry.get('url')
                    if not webpage_url:
                        continue
                    entries.append({
                        'input': webpage_url,
                        'title': entry.get('title') or '不明なタイトル',
                        'is_youtube': True,
                    })
                return data.get('title') or 'YouTubeプレイリスト', entries

        return await loop.run_in_executor(None, _extract)

    async def _load_youtube_playlist_in_background(self, interaction, playlist_url: str, status_message):
        state = self.get_state(interaction.guild_id)
        try:
            await status_message.edit(content='YouTubeプレイリストの曲一覧を取得しています…')
            title, tracks = await self.get_youtube_playlist_entries(playlist_url)
            if not tracks:
                await status_message.edit(content='YouTubeプレイリストから再生可能な曲を取得できませんでした。')
                return
            await status_message.edit(content=f'プレイリスト `{title}` を取得しました（全 {len(tracks)} 件）。キューへ順次追加します…')
            await self._load_playlist_in_background(interaction, tracks, title, status_message)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.exception('YouTube playlist extraction failed')
            try:
                await status_message.edit(content=f'YouTubeプレイリストの取得に失敗しました: {exc}')
            except discord.HTTPException:
                pass
        finally:
            state['playlist_load_task'] = None

    async def start_youtube_playlist_load(self, interaction, playlist_url: str):
        state = self.get_state(interaction.guild_id)
        state['current_ctx'] = interaction
        existing = state.get('playlist_load_task')
        if existing and not existing.done():
            existing.cancel()
        status_message = await interaction.followup.send(
            'YouTubeプレイリストの読込を受け付けました。バックグラウンドで曲一覧を取得します。',
            wait=True,
        )
        state['playlist_load_task'] = asyncio.create_task(
            self._load_youtube_playlist_in_background(interaction, playlist_url, status_message)
        )

    class SearchView(discord.ui.View):
        def __init__(self, cog, guild_id, ctx, tracks):
            super().__init__(timeout=60.0)
            self.cog = cog
            self.guild_id = guild_id
            self.ctx = ctx
            self.tracks = tracks
            self.message = None

            options = []
            for idx, track in enumerate(self.tracks):
                label = f"{idx + 1}. {track['title']}"
                if len(label) > 100: label = label[:97] + "..."
                options.append(discord.SelectOption(label=label, value=str(idx), description="この楽曲を再生・キューに追加します"))

            self.select_menu = discord.ui.Select(placeholder="再生したい楽曲を選んでください...", min_values=1, max_values=1, options=options)
            self.select_menu.callback = self.select_callback
            self.add_item(self.select_menu)

        async def select_callback(self, interaction: discord.Interaction):
            owner = Responder(self.ctx).user
            if interaction.user.id != getattr(owner, 'id', None): return await interaction.response.send_message(embed=we("<:failed:1490986584676368535> この検索結果は他のユーザーのものです。"), ephemeral=True)
            idx = int(self.select_menu.values[0])
            selected_track = self.tracks[idx]
            state = self.cog.get_state(self.guild_id)
            state['current_ctx'] = self.ctx
            if not await self.cog.enqueue_track(self.guild_id, (selected_track['url'], selected_track['title'], None, True)):
                return await interaction.response.send_message(
                    embed=we(f"<:failed:1490986584676368535> キューの上限（{MAX_QUEUE_SIZE}件）に達しています。"),
                    ephemeral=True,
                )

            vc = Responder(self.ctx).voice_client
            if vc and not has_audio_source(vc, "music") and not state['is_processing_queue'] and not state['is_paused']:
                await self.cog.check_queue(self.guild_id)
                await interaction.response.send_message(embed=we(f"<:music:1561710964238450809> **{selected_track['title']}** を再生します！"))
            else:
                await interaction.response.send_message(embed=we(f"<:success:1490985168100659322> キューに追加しました: **{selected_track['title']}**"))
                await self.cog.update_panel(self.guild_id)
            await self.disable_all_items()

        async def on_timeout(self): await self.disable_all_items()
        async def disable_all_items(self):
            for item in self.children: item.disabled = True
            if self.message:
                try: await self.message.edit(view=self)
                except Exception: pass
            self.stop()

    async def _search_impl(self, r: Responder, keyword: str | None):
        """YouTube の上位10件を表示し、選んだ曲を再生・キューに追加する。"""
        if not keyword:
            return await r.send(embed=we("検索キーワードを入力してください。"), ephemeral=True)
        await r.defer()
        if error := await self._ensure_music_connection(r):
            return await r.send(embed=we(error), ephemeral=True)
        if self._spotify_playlist_id(keyword.strip()):
            try:
                title, tracks = await self.get_spotify_playlist_entries(keyword.strip())
                return await self.start_playlist_load(r.source, tracks, title)
            except Exception as exc:
                return await r.send(embed=we(f"Spotifyプレイリストの取得に失敗しました: {exc}"))
        await r.send(f"🔎 YouTubeで「{keyword}」の上位10件を検索中...")
        search_options = YTDL_OPTIONS.copy()
        search_options['default_search'] = 'ytsearch10'
        loop = asyncio.get_event_loop()
        try:
            with yt_dlp.YoutubeDL(search_options) as ydl:
                data = await loop.run_in_executor(None, lambda: ydl.extract_info(keyword, download=False))
                if 'entries' not in data or not data['entries']: return await r.send(embed=we("<:failed:1490986584676368535> 検索結果が見つかりませんでした。"))
                tracks, description_lines = [], []
                for idx, entry in enumerate(data['entries'][:10]):
                    title = entry.get('title', '不明なタイトル')
                    url = entry.get('webpage_url') or entry.get('url')
                    duration_sec = entry.get('duration', 0)
                    m, s = divmod(duration_sec, 60)
                    duration_str = f"{m}:{s:02d}" if duration_sec else "不明"
                    tracks.append({'title': title, 'url': url})
                    description_lines.append(f"**{idx + 1}.** {title} `[{duration_str}]`")
                embed = we(title=f"「{keyword}」の検索結果 (上位10件)", description="\n".join(description_lines) + "\n\n下のメニューから曲を選択してください。")
                view = self.SearchView(self, r.guild.id, r.source, tracks)
                view.message = await r.send(embed=embed, view=view, want_message=True)
        except Exception as e:
            logging.error(f"Search command error: {e}")
            await r.send(embed=we(f"<:failed:1490986584676368535> 検索中にエラーが発生しました: {e}"))

    async def _panel_impl(self, r: Responder):
        """操作パネルを出す。Bot が VC にいなければ、実行した人の VC に入る。"""
        await r.defer()
        if error := await self._ensure_music_connection(r):
            return await r.send(embed=we(error), ephemeral=True)
        state = self.get_state(r.guild.id)
        state['current_ctx'] = r.source
        view = build_music_panel_layout(self, r.guild.id, "# <:music:1561710964238450809> ボイスコントロールパネル\nステータスを同期中...")
        state['panel_message'] = await r.send(view=view, want_message=True)
        await self.update_panel(r.guild.id)

    async def check_queue(self, guild_id: int):
        state = self.get_state(guild_id)
        
        # 💡 [修正点1] ctx または interaction のどちらかが入っていれば通過させる
        ctx_or_interaction = state.get('current_ctx') or state.get('current_interaction')

        if state.get('is_processing_queue') or ctx_or_interaction is None:
            return
        
        # ボイスクライアントの取得（Guild経由で取得するのが一番安全）
        guild = self.bot.get_guild(guild_id)
        vc = guild.voice_client if guild else None

        if vc is None or not vc.is_connected():
            state['is_processing_queue'] = False
            return

        # 録音など共有対象外の機能が VC を使っているときは、その音声を上書きしない。
        if self._busy_message(guild):
            return

        # 同一ギルドで既に再生中・一時停止中なら、別経路からの二重開始を防ぐ。
        if has_audio_source(vc, "music") or state.get('is_paused'):
            return

        # yt-dlp取得などのawaitより前にフラグを確保する。
        # これにより同時に到達したcheck_queue()が同じ曲でvc.play()を呼ばない。
        state['is_processing_queue'] = True

        if state.get('current_track') is None:
            if state['queue'].empty():
                state['is_processing_queue'] = False
                await self.update_panel(guild_id)
                return
            
            queue = state['queue']
            if state.get('shuffle_enabled') and queue.qsize() > 1:
                queue_items = queue._queue
                selected_index = random.randrange(len(queue_items))
                target_input, filename, b62_id, is_yt = queue_items[selected_index]
                del queue_items[selected_index]
            else:
                target_input, filename, b62_id, is_yt = await queue.get()
            
            if is_yt:
                try:
                    info = await self.get_yt_info(target_input)
                    # /music のパネルから再生 では先に取得済みの動画タイトルをキューへ保存している。
                    # ストリームURLを再解析すると、汎用エクストラクタのファイル名
                    # （例: "videoplayback"）になる場合があるため、保存済みのタイトルを優先する。
                    video_title = filename or info['title']
                    state['current_yt_page_url'] = info['webpage_url']
                    state['current_yt_headers'] = info['http_headers']
                    state['current_track'] = (info['stream_url'], video_title, info['duration'], b62_id, is_yt)
                except Exception as e:
                    logging.error(f"YouTube解析失敗: {e}")
                    # 💡 安全なメッセージ送信ハンドラ
                    await self._send_message(ctx_or_interaction, embed=we(f"<:failed:1490986584676368535> 解析失敗: {e}"))
                    state['is_processing_queue'] = False
                    return await self.check_queue(guild_id)
            else:
                duration = await self.get_duration(target_input)
                state['current_yt_page_url'] = None
                state['current_yt_headers'] = {}
                state['current_track'] = (target_input, filename, duration, b62_id, is_yt) 

        url, filename, duration, b62_id, is_yt = state['current_track']
        
        if state.get('elapsed_offset', 0) > 0 and is_yt:
            try:
                # videoplayback URLではなく、保持済みの動画ページURLから再取得する。
                page_url = state.get('current_yt_page_url')
                if not page_url:
                    raise RuntimeError("YouTube動画ページURLが見つかりません。")
                info = await self.get_yt_info(page_url)
                url = info['stream_url']
                state['current_yt_headers'] = info['http_headers']
            except Exception:
                pass

        # --- 【FFmpeg基本設定】 ---
        before_options = '-reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 5'
        stream_headers = state.get('current_yt_headers') or {}
        if b62_id and not stream_headers:
            stream_headers = {'User-Agent': 'Mozilla/5.0'}
        ffmpeg_headers = build_ffmpeg_headers(stream_headers)
        if ffmpeg_headers:
            before_options += f' -headers {shlex.quote(ffmpeg_headers)}'
        
        if state.get('elapsed_offset', 0) > 0:
            before_options += f" -ss {state['elapsed_offset']}"

        speed = float(np.clip(state.get('speed', 1.0), MIN_PLAYBACK_SPEED, MAX_PLAYBACK_SPEED))
        eq_mode = state.get('eq', 'flat')
        audio_filters = build_atempo_filters(speed)
        if eq_mode != 'spatial':
            volume = float(np.clip(state.get('volume', 1.0), 0.0, 2.0))
            audio_filters.append(f"volume={volume:.3f}")
            if eq_mode == 'custom':
                custom_filter = state.get('custom_eq_filter')
                if custom_filter and is_safe_custom_audio_filter(custom_filter):
                    audio_filters.append(custom_filter)
            elif eq_mode in FFMPEG_REALTIME_PRESETS:
                audio_filters.append(FFMPEG_REALTIME_PRESETS[eq_mode])
        options = f"-vn -ar 48000 -ac 2 -af {shlex.quote(','.join(audio_filters))}"

        try:
            # yt-dlpと同じHTTPヘッダーでFFmpegを起動する。Spatial以外は
            # そのPCMを直接Discordへ渡し、Pythonのサンプル単位処理を回避する。
            raw_source = FFmpegPCMAudioDiagnostics(url, before_options=before_options, options=options)
            source = PythonSpatialAudioSource(raw_source, state) if eq_mode == 'spatial' else raw_source
            
            # 開始直前にも状態を確認し、外部イベントとの競合を吸収する。
            if has_audio_source(vc, "music") or state.get('is_paused'):
                state['is_processing_queue'] = False
                return

            state['start_time'] = time.time()
            add_audio_source(
                vc, "music", source,
                after=lambda e: self.bot.loop.call_soon_threadsafe(self.play_next, guild_id, e),
            )
            self._start_progress_task(guild_id)
            await self.update_panel(guild_id)

            # FFmpegが少なくとも1フレームのPCMを出力するまで待つ。vc.play()直後の
            # 表示では、URLの403やデコーダー失敗でも「再生中」と誤表示されるため。
            for _ in range(20):
                if source.has_output and has_audio_source(vc, "music"):
                    break
                if not has_audio_source(vc, "music"):
                    break
                await asyncio.sleep(0.1)

            if source.has_output and has_audio_source(vc, "music") and state.get('elapsed_offset', 0) < 1:
                current_eq_mode = state.get('eq', 'flat')
                eq_label = "custom" if current_eq_mode == "custom" else current_eq_mode
                status = f"Speed: {state.get('speed', 1.0)}x / Vol: {state.get('volume', 1.0)} / EQ: {eq_label}"
                await self._send_message(ctx_or_interaction, embed=we(f"<:music:1561710964238450809> 再生中: **{filename}**\n`{status}`"))
        
        except Exception as e:
            logging.error(f"Playback error: {e}")
            state['is_processing_queue'] = False
            if "Already playing audio" in str(e):
                # 既存の再生を壊したりキューを消費したりせず、競合が解消されるのを待つ。
                await self.update_panel(guild_id)
                return
            state['current_track'] = None
            await self.check_queue(guild_id)

    # 💡 ContextとInteractionのどちらからでも送信できる補助メソッド
    async def _send_message(self, ctx_or_interaction, text=None, embed=None):
        try:
            if isinstance(ctx_or_interaction, discord.Interaction):
                if ctx_or_interaction.response.is_done():
                    await ctx_or_interaction.followup.send(content=text, embed=embed)
                else:
                    await ctx_or_interaction.response.send_message(content=text, embed=embed)
            elif hasattr(ctx_or_interaction, 'send'):
                await ctx_or_interaction.send(content=text, embed=embed)
        except Exception as e:
            logging.error(f"送信エラー: {e}")
            
    def _make_loop_track(self, state):
        """失効しやすいYouTubeストリームURLではなく、再解析可能な入力を再投入する。"""
        track = state.get('current_track')
        if not track:
            return None
        stream_url, filename, _duration, b62_id, is_yt = track
        source_input = state.get('current_yt_page_url') if is_yt else stream_url
        if not source_input:
            return None
        return (source_input, filename, b62_id, is_yt)

    def play_next(self, guild_id: int, error=None):
        state = self.get_state(guild_id)

        # ★ 設定変更中は何もしない（current_track / elapsed_offset を保持）。
        #   apply_immediate_setting() が remove_audio_source() で止めた際に
        #   呼ばれる after コールバックが、キューを次へ進めてしまうのを防ぐ。
        if state.get('is_changing_setting'):
            return

        if error:
            logger.error("Player error: %r", error)
            failed_track = state.get('current_track')
            failed_title = failed_track[1] if failed_track else '不明なトラック'
            ctx_or_interaction = state.get('current_ctx') or state.get('current_interaction')
            state['is_processing_queue'] = False
            state['current_track'] = None
            state['current_yt_page_url'] = None
            state['current_yt_headers'] = {}
            state['elapsed_offset'] = 0
            state['retry_count'] = 0

            async def report_failure_and_continue():
                await self._send_message(
                    ctx_or_interaction,
                    embed=we(f"<:failed:1490986584676368535> **{failed_title}** の音声デコードに失敗しました。次のキューを確認します。")
                )
                await self.check_queue(guild_id)

            loop = self.bot.loop if hasattr(self.bot, 'loop') else asyncio.get_event_loop()
            loop.create_task(report_failure_and_continue())
            return

        if state['is_paused'] or state['is_changing_setting']:
            state['is_processing_queue'] = False
            return

        actual_played = (time.time() - state['start_time']) * state.get('speed', 1.0)
        state['elapsed_offset'] += actual_played
        
        track = state['current_track']
        duration = track[2] if track else 0
        is_interrupted = (duration - state['elapsed_offset']) > 5
        
        state['is_processing_queue'] = False

        # 安全なイベントループ取得
        loop = self.bot.loop if hasattr(self.bot, 'loop') else asyncio.get_event_loop()

        if is_interrupted and state['retry_count'] < 3 and state['current_track']:
            state['retry_count'] += 1
            asyncio.run_coroutine_threadsafe(self.check_queue(guild_id), loop)
            return

        loop_track = self._make_loop_track(state)
        loop_mode = state.get('loop_mode', 'off')
        if loop_track and loop_mode == 'track':
            state['queue']._queue.appendleft(loop_track)
        elif loop_track and loop_mode == 'queue':
            state['queue']._queue.append(loop_track)

        state['current_track'] = None
        state['current_yt_page_url'] = None
        state['current_yt_headers'] = {}
        state['elapsed_offset'] = 0
        state['retry_count'] = 0
        asyncio.run_coroutine_threadsafe(self.check_queue(guild_id), loop)
            
    async def _ensure_music_connection(self, r: Responder) -> str | None:
        """音楽を流せる状態にする。だめなときは理由（そのまま返信できる文）を返す。

        - 共有対象外の機能（録音など）が VC を使っているときは断る
        - Bot が VC にいなければ、実行した人の VC に「音楽」として入る（VoiceSessionManager 経由）
        """
        guild = r.guild
        if guild is None:
            return "サーバーの中で実行してください。"
        if busy := self._busy_message(guild):
            return busy
        vc = guild.voice_client
        if vc is not None and vc.is_connected():
            session = self.voice_sessions.get(guild.id)
            if session is not None and session.feature != "music" and "music" not in session.shared_leases:
                try:
                    await self._acquire_music(guild, vc.channel, r.user, r.channel)
                except VoiceBusy as busy:
                    return str(busy)
                except Exception as exc:
                    logger.exception("Failed to join shared music session")
                    return f"共有ボイスセッションに参加できませんでした: {exc}"
            return None
        voice = getattr(r.user, 'voice', None)
        channel = getattr(voice, 'channel', None)
        if channel is None:
            return "先にボイスチャンネルに参加してください。"
        try:
            await asyncio.wait_for(self._acquire_music(guild, channel, r.user, r.channel), timeout=45.0)
        except VoiceBusy as busy:
            return str(busy)
        except asyncio.TimeoutError:
            return "⏱️ タイムアウト: ボイスチャンネルへの接続応答時間が超過しました。Botの権限やネットワーク状態をご確認ください。"
        except Exception as exc:
            logger.exception("Failed to connect for music")
            return f"ボイスチャンネルへ接続できませんでした: {exc}"
        return None

    async def _play_impl(
        self,
        interaction: discord.Interaction,
        query: str = None,
        file: discord.Attachment = None,
        start_at: float | None = None,
    ):
        # 💡 1. 処理に時間がかかる可能性があるので、一番最初に defer() を実行
        await interaction.response.defer()

        # 💡 2. ボイスチャンネル接続（入っていなければ自動で参加。別機能が使用中なら断る）
        if error := await self._ensure_music_connection(Responder(interaction)):
            return await interaction.followup.send(embed=we(error), ephemeral=True)

        state = self.get_state(interaction.guild_id)
        state['current_interaction'] = interaction
        if start_at is not None and start_at < 0:
            return await interaction.followup.send(embed=we("開始位置は0秒以上で指定してください。"), ephemeral=True)
        can_apply_start_at = not state.get('current_track') and state['queue'].empty() and not state.get('is_processing_queue')
        if start_at is not None and not can_apply_start_at:
            return await interaction.followup.send(embed=we("開始位置の指定は、再生中の曲と待機キューがない場合のみ使えます。再生中の曲は `/music` の操作パネルから操作してください。"), ephemeral=True)

        is_yt = False
        url, filename, final_id = None, None, None

        # query が None の場合に備えて安全に strip 処理
        input_str = query.strip() if query else ""

        # ⏱️ タイムアウト秒数の設定 (15秒)
        TIMEOUT_SECONDS = 45.0

        # YouTube関連ドメイン判定
        yt_pattern = re.compile(r'https?://(?:www\.|m\.|music\.)?(?:youtube\.com|youtu\.be)/', re.IGNORECASE)

        # 1. Spotifyプレイリストは曲一覧の取得が長時間化するため、即時受付してバックグラウンド処理へ渡す。
        if input_str and self._spotify_playlist_id(input_str):
            await self.start_spotify_playlist_load(interaction, input_str)
            return

        # 2. YouTubeプレイリストは曲一覧の取得が長時間化するため、即時受付してバックグラウンド処理へ渡す。
        if input_str and yt_pattern.search(input_str) and re.search(r'[?&]list=[^&]+', input_str):
            await self.start_youtube_playlist_load(interaction, input_str)
            return

        # 3. YouTube単曲URLが直接指定された場合
        if input_str and yt_pattern.search(input_str):
            await interaction.followup.send("<:crock:1561710960387956757> YouTubeを解析中...")
            try:
                # ⏱️ タイムアウト付きで解析実行
                info = await asyncio.wait_for(self.get_yt_info(input_str), timeout=TIMEOUT_SECONDS)
                # キューには一時ストリームURLではなく動画ページURLを保存する。
                url, filename, is_yt = info['webpage_url'], info['title'], True
            except asyncio.TimeoutError:
                return await interaction.followup.send("⏱️ タイムアウト: YouTube情報の解析に時間がかかりすぎたため中断しました。")
            except Exception as e:
                return await interaction.followup.send(embed=we(f"<:failed:1490986584676368535> 解析失敗: {e}"))

        # 2. ファイルが添付されている場合
        elif file:
            url, filename = file.url, file.filename
            # Interaction IDは添付ファイルを持つメッセージIDではないため、後から
            # get_attachment_info()で再取得できない。Discordの添付URLを保存する。
            final_id = url

        # 3. BASE62 のユニバーサルID指定（または検索へのフォールバック）
        elif input_str and len(input_str.split()) == 1 and all(c in BASE62 for c in input_str):
            try:
                url, filename = await asyncio.wait_for(self.get_attachment_info(input_str, interaction.guild_id), timeout=TIMEOUT_SECONDS)
            except asyncio.TimeoutError:
                return await interaction.followup.send("⏱️ タイムアウト: ID情報の取得に時間がかかりすぎました。")
            except Exception:
                url, filename = None, None
            
            final_id = input_str
            
            if not url:
                await interaction.followup.send(f"🔎 YouTubeで「{input_str}」を検索中...")
                try:
                    info = await asyncio.wait_for(self.get_yt_info(f"ytsearch:{input_str}"), timeout=TIMEOUT_SECONDS)
                    url, filename, is_yt = info['webpage_url'], info['title'], True
                    final_id = None
                except asyncio.TimeoutError:
                    return await interaction.followup.send("⏱️ タイムアウト: YouTube検索応答時間が超過しました。")
                except Exception as e:
                    return await interaction.followup.send(embed=we(f"<:failed:1490986584676368535> 検索失敗: {e}"))

        # 4. 検索キーワード指定
        elif input_str:
            await interaction.followup.send(f"🔎 YouTubeで「{input_str}」を検索中...")
            try:
                info = await asyncio.wait_for(self.get_yt_info(f"ytsearch:{input_str}"), timeout=TIMEOUT_SECONDS)
                url, filename, is_yt = info['webpage_url'], info['title'], True
            except asyncio.TimeoutError:
                return await interaction.followup.send("⏱️ タイムアウト: YouTube検索応答時間が超過しました。")
            except Exception as e:
                return await interaction.followup.send(embed=we(f"<:failed:1490986584676368535> 検索失敗: {e}"))

        # 5. 引数が何もない場合
        else:
            msg = "ファイル添付、ID、YouTube URL、または検索キーワードを指定してください。"
            embed = we(msg) if hasattr(self, 'we') else (we(msg) if 'we' in globals() else discord.Embed(description=msg, color=0xFF0000))
            return await interaction.followup.send(embed=embed)

        if not url:
            msg = "情報の取得に失敗しました。"
            embed = we(msg) if hasattr(self, 'we') else (we(msg) if 'we' in globals() else discord.Embed(description=msg, color=0xFF0000))
            return await interaction.followup.send(embed=embed)

        # キューに追加（ギルド単位の上限を超える場合は受け付けない）
        if start_at is not None:
            state['elapsed_offset'] = start_at
        if not await self.enqueue_track(interaction.guild_id, (url, filename, final_id, is_yt)):
            return await interaction.followup.send(
                embed=we(f"<:failed:1490986584676368535> キューの上限（{MAX_QUEUE_SIZE}件）に達しています。再生完了または停止後に追加してください。"),
                ephemeral=True,
            )

        # 再生状態の安全確認
        vc = interaction.guild.voice_client
        is_playing = has_audio_source(vc, "music") if vc else False
        is_processing = state.get('is_processing_queue', False)
        is_paused = state.get('is_paused', False)

        # 💡 再生処理呼び出しとレスポンスの明確化
        try:
            if not is_playing and not is_processing and not is_paused:
                await interaction.followup.send(embed=we(f"▶️ 再生を開始します: **{filename}**"))
                await self.check_queue(interaction.guild_id)
            else:
                await interaction.followup.send(embed=we(f"<:success:1490985168100659322> キューに追加: **{filename}**"))
                await self.update_panel(interaction.guild_id)
        except Exception as e:
            await interaction.followup.send(embed=we(f"<:failed:1490986584676368535> 再生開始処理でエラーが発生しました: `{e}`"))
            
    async def _stop_impl(self, r: Responder):
        """今流れている音楽をすべて停止しキューをクリアする（VC には残る）。"""
        vc = r.voice_client
        if not vc:
            return await r.send(embed=we("ボットがボイスチャンネルに入っていません。"), ephemeral=True)
        state = self.get_state(r.guild.id)
        state['current_track'] = None
        state['elapsed_offset'] = 0
        state['is_paused'] = False
        while not state['queue'].empty(): 
            state['queue'].get_nowait()
        remove_audio_source(vc, "music", notify=True)
        await r.send(embed=we("完全に停止し、キューをクリアしました。"))
        await self.update_panel(r.guild.id)

    async def _seek_impl(self, interaction: discord.Interaction, seconds: float):
        if seconds < 0:
            return await interaction.response.send_message(embed=we("移動先は0秒以上で指定してください。"), ephemeral=True)
        state = self.get_state(interaction.guild_id)
        vc = interaction.guild.voice_client
        if not vc or not state.get('current_track'):
            return await interaction.response.send_message(embed=we("現在再生中の曲がありません。"), ephemeral=True)
        duration = state['current_track'][2] or 0
        if duration and seconds >= duration:
            return await interaction.response.send_message(embed=we(f"移動先は曲の長さ（{int(duration)}秒）未満にしてください。"), ephemeral=True)
        state['elapsed_offset'] = seconds
        state['is_changing_setting'] = True
        remove_audio_source(vc, "music", notify=True)
        for _ in range(40):
            if not has_audio_source(vc, "music") and not state.get('is_paused'):
                break
            await asyncio.sleep(0.05)
        state['is_changing_setting'] = False
        await self.check_queue(interaction.guild_id)
        await interaction.response.send_message(embed=we(f"再生位置を `{int(seconds)}秒` に移動しました。"), ephemeral=True)

    async def _pause_impl(self, interaction: discord.Interaction):
        vc = interaction.guild.voice_client
        state = self.get_state(interaction.guild_id)

        if not vc:
            return await interaction.response.send_message(embed=we("ボットがボイスチャンネルに入っていません。"), ephemeral=True)

        # 1. 再生中の場合 -> 一時停止処理
        if has_audio_source(vc, "music"):
            actual_played = (time.time() - state['start_time']) * state.get('speed', 1.0)
            state['elapsed_offset'] += actual_played
            state['is_paused'] = True
            remove_audio_source(vc, "music", notify=True)
            
            await interaction.response.send_message(
                embed=we(f"<:Pause:1561700510447312916> 再生を一時停止しました。(`{int(state['elapsed_offset'])}秒` 時点)\nもう一度 `/music` の操作パネルから再開できます。")
            )
            await self.update_panel(interaction.guild_id)

        # 2. 一時停止中の場合 -> 再生再開処理
        elif state['is_paused'] and state['current_track']:
            state['is_paused'] = False
            await self.check_queue(interaction.guild_id)
            await interaction.response.send_message(embed=we("▶️ 一時停止位置から再生を再開しました。"))

        # 3. どちらでもない場合
        else:
            await interaction.response.send_message(embed=we("現在再生中・一時停止中のトラックがありません。"), ephemeral=True)


    async def _skip_impl(self, interaction: discord.Interaction):
        vc = interaction.guild.voice_client
        state = self.get_state(interaction.guild_id)

        if vc and (has_audio_source(vc, "music") or state['is_paused']):
            state['current_track'] = None
            state['elapsed_offset'] = 0
            state['is_paused'] = False
            remove_audio_source(vc, "music", notify=True)
            await interaction.response.send_message(embed=we("スキップしました。"))
        else:
            await interaction.response.send_message(embed=we("現在再生中の楽曲がありません。"))

    async def _loop_impl(self, interaction: discord.Interaction, mode: str):
        state = self.get_state(interaction.guild_id)
        state['loop_mode'] = mode
        labels = {'off': 'OFF', 'track': '1曲ループ', 'queue': 'キューループ'}
        await interaction.response.send_message(embed=we(f"ループ設定を **{labels[mode]}** に変更しました。"))
        await self.update_panel(interaction.guild_id)

    async def _shuffle_impl(self, interaction: discord.Interaction):
        state = self.get_state(interaction.guild_id)
        state['shuffle_enabled'] = not state.get('shuffle_enabled', False)
        label = 'ON' if state['shuffle_enabled'] else 'OFF'
        await interaction.response.send_message(embed=we(f"シャッフル再生を **{label}** に変更しました。"))
        await self.update_panel(interaction.guild_id)

    async def _files_impl(self, r: Responder, limit: int = 20):
        """このチャンネルにアップロードされた音声の ID を表示する。"""
        limit = max(1, min(int(limit or 20), 100))
        await r.defer()
        embed = we(title="チャンネル内音声リスト")
        lines = []
        async for msg in r.channel.history(limit=limit):
            if msg.attachments:
                b62 = encode_full_id(r.guild.id, r.channel.id, msg.id)
                lines.append(f"`{b62}` : **{msg.attachments[0].filename}**")
        desc = "このサーバー内で再生可能な音声ID（`/music` の操作パネルから再生できます）\n" + "─" * 20 + "\n"
        desc += "\n".join(lines) if lines else "音声ファイルは見つかりませんでした。"
        embed.description = desc[:4000]
        await r.send(embed=embed)

    def _serialize_personal_playlist(self, guild_id: int):
        """現在曲と待機キューを、再解析可能な入力だけで保存する。"""
        state = self.get_state(guild_id)
        tracks = []
        current = state.get('current_track')
        if current:
            stream_url, title, _duration, b62_id, is_yt = current
            source_input = state.get('current_yt_page_url') if is_yt else (b62_id or stream_url)
            if source_input:
                tracks.append({
                    'input': source_input,
                    'title': title,
                    'attachment_id': b62_id,
                    'is_youtube': bool(is_yt),
                })
        for source_input, title, b62_id, is_yt in list(state['queue']._queue):
            tracks.append({
                'input': source_input if is_yt else (b62_id or source_input),
                'title': title,
                'attachment_id': b62_id,
                'is_youtube': bool(is_yt),
            })
        return tracks

    @staticmethod
    def _server_playlist_key(guild_id: int, name: str) -> str:
        return f"{guild_id}:{name}"

    def _server_playlist_ids(self, guild_id: int):
        """サーバー共有プレイリスト用に、現在曲とキューを再生可能な形で集める。

        旧形式の添付IDは文字列のまま保持し、YouTubeや直接添付URLなどIDを
        持たないトラックは辞書で保存する。既存の ``playlists.ids`` JSON列を
        そのまま利用しながら、通常の音楽プレイリストも共有できる。
        """
        state = self.get_state(guild_id)
        entries = []

        def add(track):
            if not track:
                return
            source_input, title, _duration, reference, is_yt = track
            source = state.get('current_yt_page_url') if is_yt and track is state.get('current_track') else source_input
            source = source or reference
            if not source:
                return
            if not is_yt and reference and not str(reference).startswith(('http://', 'https://')):
                entries.append(reference)
            else:
                entries.append({
                    'input': source,
                    'title': title,
                    'attachment_id': reference,
                    'is_youtube': bool(is_yt),
                })

        add(state.get('current_track'))
        for item in list(state['queue']._queue):
            add(item)
        return entries

    async def _playlist_impl(self, r: Responder, action: str, name: str | None = None, scope: str = 'me',
                             file: discord.Attachment | None = None):
        """プレイリストの保存・一覧・再生。

        scope='me'     : 自分専用（テーブル user_music_playlists。旧 /playlist・!plsave・!pllist・!plplay）
        scope='server' : サーバー共有（テーブル playlists。旧 !save_current・!plist。再生では ID の並びや JSON も受け付ける）
        """
        name = (name or '').strip()
        db = self.bot.supabase
        if action == 'play':
            await r.defer()
            if error := await self._ensure_music_connection(r):
                return await r.send(embed=we(error), ephemeral=True)
            if scope == 'server':
                return await self._play_server_playlist(r, name, file)
            if not db:
                return await r.send(embed=we("個人プレイリストを使うにはSupabaseを設定してください。"), ephemeral=True)
            if not name:
                return await r.send(embed=we("再生するプレイリスト名を指定してください。"), ephemeral=True)
            try:
                result = db.table('user_music_playlists').select('tracks').eq('guild_id', r.guild.id).eq(
                    'owner_user_id', r.user.id
                ).eq('name', name).limit(1).execute()
                rows = result.data or []
                if not rows:
                    return await r.send(embed=we(f"個人プレイリスト `{name}` が見つかりません。"), ephemeral=True)
                await self.start_playlist_load(r.source, rows[0].get('tracks') or [], name)
            except Exception:
                logger.exception("Failed to play personal playlist")
                await r.send(embed=we("個人プレイリストの読込に失敗しました。"), ephemeral=True)
            return

        if action == 'delete':
            if not name:
                return await r.send(embed=we("削除するプレイリスト名を指定してください。"), ephemeral=True)
            try:
                if scope == 'server':
                    result = db.table("playlists").delete().eq(
                        "name", self._server_playlist_key(r.guild.id, name)
                    ).execute()
                else:
                    result = db.table('user_music_playlists').delete().eq(
                        'guild_id', r.guild.id
                    ).eq('owner_user_id', r.user.id).eq('name', name).execute()
                if not result.data:
                    label = '共有' if scope == 'server' else '個人'
                    return await r.send(embed=we(f"{label}プレイリスト `{name}` が見つかりません。"), ephemeral=True)
                return await r.send(embed=we(f"プレイリスト `{name}` を削除しました。"), ephemeral=True)
            except Exception:
                logger.exception("Failed to delete playlist")
                return await r.send(embed=we("プレイリストの削除に失敗しました。"), ephemeral=True)

        if not db:
            return await r.send(embed=we("プレイリストを使うにはSupabaseを設定してください。"), ephemeral=True)

        if action == 'save':
            if not name:
                return await r.send(embed=we("保存するプレイリスト名を指定してください。"), ephemeral=True)
            if scope == 'server':
                ids = self._server_playlist_ids(r.guild.id)
                if not ids:
                    return await r.send(embed=we("保存できる曲がありません（サーバー共有に保存できるのは、アップロードした音声だけです）。"), ephemeral=True)
                try:
                    db.table("playlists").upsert({"name": self._server_playlist_key(r.guild.id, name), "ids": ids}).execute()
                    return await r.send(embed=we(f"<:success:1490985168100659322> このサーバー内のキューを `{name}` として保存しました（{len(ids)} 曲・サーバー共有）。"))
                except Exception as exc:
                    logger.exception("Failed to save server playlist")
                    return await r.send(embed=we(f"保存に失敗しました。({type(exc).__name__})"), ephemeral=True)
            tracks = self._serialize_personal_playlist(r.guild.id)
            if not tracks:
                return await r.send(embed=we("保存できる曲がありません。"), ephemeral=True)
            try:
                db.table('user_music_playlists').upsert(
                    {'guild_id': r.guild.id, 'owner_user_id': r.user.id, 'name': name, 'tracks': tracks},
                    on_conflict='guild_id,owner_user_id,name',
                ).execute()
                return await r.send(embed=we(f"個人プレイリスト `{name}` に {len(tracks)} 曲を保存しました。"), ephemeral=True)
            except Exception as exc:
                logger.exception("Failed to save personal playlist")
                detail = str(exc).lower()
                if 'row-level security' in detail or 'permission denied' in detail or '42501' in detail:
                    message = '保存権限がありません。SupabaseのRLSポリシーと、Botに設定したSupabaseキー（SUPABASE_SERVICE_ROLE_KEY / SUPABASE_KEY）の権限を確認してください。'
                else:
                    message = f'保存に失敗しました。Botログを確認してください。({type(exc).__name__})'
                return await r.send(embed=we(message), ephemeral=True)

        # 一覧
        try:
            if scope == 'server':
                prefix = f"{r.guild.id}:"
                result = db.table("playlists").select("name,ids").like("name", f"{prefix}%").execute()
                rows = [row for row in (result.data or []) if str(row.get('name', '')).startswith(prefix)]
                description = '\n'.join(
                    f"• **{row['name'][len(prefix):]}** — {len(row.get('ids') or [])} 曲" for row in rows[:25]
                ) or '登録されていません。'
                return await r.send(embed=we(title='このサーバーの共有プレイリスト', description=description), ephemeral=True)
            result = db.table('user_music_playlists').select('name,tracks,updated_at').eq(
                'guild_id', r.guild.id
            ).eq('owner_user_id', r.user.id).order('updated_at', desc=True).execute()
            rows = result.data or []
            description = '\n'.join(f"• **{row['name']}** — {len(row.get('tracks') or [])} 曲" for row in rows[:25]) or '登録されていません。'
            return await r.send(embed=we(title='あなたの個人プレイリスト', description=description), ephemeral=True)
        except Exception:
            logger.exception("Failed to list playlists")
            return await r.send(embed=we("一覧取得に失敗しました。"), ephemeral=True)

    async def _play_server_playlist(self, r: Responder, name: str, file: discord.Attachment | None):
        """サーバー共有プレイリスト名、ID の並び（空白・カンマ区切り）、または JSON ファイルを再生する。"""
        state = self.get_state(r.guild.id)
        state['current_ctx'] = r.source
        tokens = []
        attachment = file or (r.attachments[0] if r.attachments else None)
        if attachment is not None:
            try:
                content = await attachment.read()
                tokens = json.loads(content.decode('utf-8'))
                if not isinstance(tokens, list):
                    tokens = [str(tokens)]
            except Exception as e:
                return await r.send(embed=we(f"JSON解析エラー: {e}"))
        elif name:
            tokens = name.replace(',', ' ').split()
            if self.bot.supabase:
                try:
                    res = self.bot.supabase.table("playlists").select("ids").eq(
                        "name", self._server_playlist_key(r.guild.id, name)).execute()
                    if res.data:
                        tokens = res.data[0]["ids"]
                except Exception:
                    pass
        else:
            return await r.send(embed=we("プレイリスト名、ID、またはJSONファイルを指定してください。"), ephemeral=True)

        tracks = []
        for token in tokens:
            if isinstance(token, dict):
                tracks.append(token)
            elif isinstance(token, str) and token:
                tracks.append({'input': token, 'attachment_id': token, 'is_youtube': False})
        await self.start_playlist_load(r.source, tracks, name or 'JSONプレイリスト')

    async def _spatial_impl(self, r: Responder, *, feedback: float | None = None, wet: float | None = None,
                            resolution: int | None = None):
        """オプションなしなら立体音響パネルを出し、指定があればリバーブの値を変える。"""
        guild_id = r.guild.id
        if feedback is None and wet is None and resolution is None:
            return await self._spatial_panel(r, guild_id)
        if feedback is not None and not 0.0 <= feedback <= 0.95:
            return await r.send(embed=we("フィードバック値（残響の長さ）は 0.0 〜 0.95 の間で指定してください。"), ephemeral=True)
        if wet is not None and not 0.0 <= wet <= 1.0:
            return await r.send(embed=we("ウェット量（残響の音量）は 0.0 〜 1.0 の間で指定してください。"), ephemeral=True)
        if resolution is not None and resolution not in (4, 8):
            return await r.send(embed=we("解像度は `4` (通常) または `8` (高解像度・滑らか) のどちらかを指定してください。"), ephemeral=True)

        state = self.get_state(guild_id)
        lines = []
        if feedback is not None:
            state['fdn_feedback'] = feedback
            lines.append(f"<:crock:1561710960387956757> リバーブのフィードバック（長さ）を `{feedback}` に設定しました。")
        if wet is not None:
            state['fdn_wet'] = wet
            lines.append(f"💧 残響のミックス（ウェット量）を `{wet}` に設定しました。")
        if resolution is not None:
            state['fdn_resolution'] = resolution
            mode_str = "8次元ハウスホルダー（高密度・シルキー）" if resolution == 8 else "4次元ハウスホルダー（軽量・クリア）"
            lines.append(f"⚙️ リバーブ解像度を `{resolution}` に切り替えました。\n現在のモード: **{mode_str}**")
        await r.send(embed=we("\n".join(lines)))
        # コントロールパネルの表示を更新
        await self.update_panel(guild_id)

    async def _spatial_panel(self, r: Responder, guild_id: int):
        state = self.get_state(guild_id)
        current_eq = state.get('eq', 'flat')
        dist = state.get('spatial_distance', 2.0)
        room = state.get('spatial_room_size', 0.3)
        speaker = state.get('spatial_speaker', 'studio')
        agc_max = state.get('spatial_agc_max', 4.0)
        
        # 💡 モード判定（3軸回転 / 通常回転 / 回転OFF）
        rot_mode = state.get('spatial_rot_mode', 'standard')  # 'off', 'standard', '3d'
        rot_labels = {
            'off': '<:Pause:1561700510447312916> 静止 (OFF)',
            'standard': '🌀 通常水平回転 (Azimuth)',
            '3d': '🪐 3軸立体回転 (3D Pitch/Yaw/Roll)'
        }

        speaker_names = {
            'studio': '🎙️ スタジオモニター',
            'theater': '🎬 シアター',
            'pa': '🔊 PAスピーカー',
            'small': '📻 小型スピーカー'
        }

        embed = discord.Embed(
            title="🎧 立体音響 (3D Spatial Audio) 設定パネル",
            description=(
                "リアルタイムHRTFおよびFDN空間音響パラメータを個別設定できます。\n"
                "下のメニュー操作は再生中の音声へ即座に反映されます。\n\n"
                f"現在のモード: **{current_eq}**\n"
                f"音像の距離 (Distance): **{dist}x**\n"
                f"部屋のリバーブ (FDN Mix): **{room}**\n"
                f"スピーカー特性: **{speaker_names.get(speaker, speaker)}**\n"
                f"最大音量引き上げ幅 (AGC): **{agc_max}x** (+{round(20*math.log10(agc_max), 1)}dB)\n"
                f"回転モード: **{rot_labels.get(rot_mode, rot_mode)}**"
            ),
            color=0x3498DB
        )
        view = SpatialControlView(self, guild_id)
        await r.send(embed=embed, view=view)

    def build_queue_embed(self, guild_id: int):
        state = self.get_state(guild_id)
        current_track = state.get('current_track')
        queue_items = list(state['queue']._queue)
        embed = discord.Embed(title="<:music:1561710964238450809> 再生キュー", color=0xFFFFFF)
        embed.add_field(
            name="再生中",
            value=f"**{current_track[1]}**" if current_track else "なし",
            inline=False,
        )
        if queue_items:
            q_desc = "\n".join(f"{i + 1}. {item[1]}" for i, item in enumerate(queue_items[:10]))
            if len(queue_items) > 10:
                q_desc += f"\n…ほか {len(queue_items) - 10} 曲"
            embed.add_field(name="待機中", value=q_desc, inline=False)
        else:
            embed.add_field(name="待機中", value="キューは空です", inline=False)
        return embed

    async def _queue_impl(self, interaction: discord.Interaction):
        await interaction.response.send_message(embed=self.build_queue_embed(interaction.guild_id), ephemeral=True)

    # ==================================================================
    # /music は引数なしで操作パネルを表示する。
    # ==================================================================
    MUSIC_ACTIONS = [
        app_commands.Choice(name="再生", value="play"),
        app_commands.Choice(name="操作パネル", value="panel"),
        app_commands.Choice(name="一時停止/再開", value="pause"),
        app_commands.Choice(name="スキップ", value="skip"),
        app_commands.Choice(name="停止", value="stop"),
        app_commands.Choice(name="シーク", value="seek"),
        app_commands.Choice(name="キュー表示", value="queue"),
        app_commands.Choice(name="ループ", value="loop"),
        app_commands.Choice(name="シャッフル切替", value="shuffle"),
        app_commands.Choice(name="音量", value="volume"),
        app_commands.Choice(name="再生速度", value="speed"),
        app_commands.Choice(name="EQ", value="eq"),
        app_commands.Choice(name="立体音響", value="spatial"),
        app_commands.Choice(name="検索", value="search"),
        app_commands.Choice(name="プレイリスト", value="playlist"),
        app_commands.Choice(name="音声ファイルID一覧", value="files"),
    ]


#↓落ちた原因これね
async def setup(bot):
    await bot.add_cog(VoiceCog(bot))
