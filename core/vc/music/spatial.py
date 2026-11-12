import discord
from core.support.panel_v2 import edit_message_v2, edit_panel_view
from core.vc.music.ui import _require_same_vc
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
from scipy.fft import irfft as _irfft
from scipy.fft import rfft as _rfft
import numpy as np
import re
import wave
import discord.opus
from core.vc import voice_restore
from core.vc.voice_session import SHARED_FEATURES, VoiceBusy, get_manager
from core.vc.voice_media import add_audio_source, has_audio_source, remove_audio_source
from core.support.legacy import Responder
from core.support.emojis import FAILED, MUSIC, PAUSE, RESTART, SUCCESS, VOL
from core.vc.music.music_activity import build_music_activity_snapshot

from core.vc.music.hrtf import load_hrtf_tables
from core.vc.music.measured import air_absorption_gain, load_room_irs, load_speakers
from core.vc.music.common import *  # noqa: F401,F403 - shared helpers/constants

logger = logging.getLogger("cogs.sio_music")



class _BlockConvolver:
    """長いIR（残響）用のブロック畳み込み。

    20msフレームごとに大きなFFTを行う代わりに、4096サンプル単位で
    まとめて畳み込む。ウェット音は最大でブロック長ぶん（約85ms）遅れるが、
    残響のプリディレイとして聞こえる範囲で、処理量は数分の一になる。
    """

    BLOCK = 4096

    def __init__(self):
        self._key = None
        self.reset()

    def reset(self):
        self._in_l = np.zeros(0, dtype=np.float32)
        self._in_r = np.zeros(0, dtype=np.float32)
        self._out_l = np.zeros(0, dtype=np.float32)
        self._out_r = np.zeros(0, dtype=np.float32)
        self._tail_l = np.zeros(0, dtype=np.float32)
        self._tail_r = np.zeros(0, dtype=np.float32)

    def process(self, in_l, in_r, ir_l, ir_r, key):
        if key != self._key:
            self.reset()
            self._key = key
        self._in_l = np.concatenate([self._in_l, in_l])
        self._in_r = np.concatenate([self._in_r, in_r])
        while len(self._in_l) >= self.BLOCK:
            block_l = self._in_l[:self.BLOCK]
            block_r = self._in_r[:self.BLOCK]
            self._in_l = self._in_l[self.BLOCK:]
            self._in_r = self._in_r[self.BLOCK:]
            full_l = signal.oaconvolve(block_l, ir_l, mode="full")
            full_r = signal.oaconvolve(block_r, ir_r, mode="full")
            full_l[:len(self._tail_l)] += self._tail_l
            full_r[:len(self._tail_r)] += self._tail_r
            self._tail_l = full_l[self.BLOCK:].copy()
            self._tail_r = full_r[self.BLOCK:].copy()
            self._out_l = np.concatenate([self._out_l, full_l[:self.BLOCK]])
            self._out_r = np.concatenate([self._out_r, full_r[:self.BLOCK]])
        n = len(in_l)
        out_l = np.zeros(n, dtype=np.float32)
        out_r = np.zeros(n, dtype=np.float32)
        take = min(n, len(self._out_l))
        if take:
            out_l[:take] = self._out_l[:take]
            out_r[:take] = self._out_r[:take]
            self._out_l = self._out_l[take:]
            self._out_r = self._out_r[take:]
        return out_l, out_r


def _wfs_tap_table(half_aperture_deg: float, step_deg: float):
    """波面合成（WFS）の駆動重みテーブル。

    仮想音源の波面を、聞き手を囲む円周上の二次音源群で合成する考え方。
    重みは開口に対する raised-cosine 窓 × 入射角の余弦（Kirchhoff 積分の
    傾斜因子）で、正規化して返す。
    """
    taps = []
    n = int(round(half_aperture_deg / step_deg))
    for k in range(-n, n + 1):
        off = float(k * step_deg)
        w = (math.cos(math.pi * off / (2.0 * half_aperture_deg)) ** 2) * math.cos(math.radians(off))
        if w > 0.01:
            taps.append((off, w))
    total = sum(w for _, w in taps)
    return tuple((off, w / total) for off, w in taps)


_SINGLE_TAP = ((0.0, 1.0),)
# ライブモードの音像の大きさ（開口幅）は固定値。パラメータでは調整しない。
_LIVE_TAPS_NARROW = _wfs_tap_table(15.0, 7.5)   # 低域: 狭い開口（定位の芯）
_LIVE_TAPS_WIDE = _wfs_tap_table(30.0, 10.0)    # 中高域: 広い開口（ステージの大きさ）


class PythonSpatialAudioSource(discord.AudioSource):
    """
    5帯域連動回転 × スピーカー特性切り替え × 壁面吸音リバーブ統合エンジン
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
        # 実測HRTF (KEMAR) を優先し、読めない環境では従来の簡易モデルを使う。
        real_hrtf = load_hrtf_tables()
        if real_hrtf is not None:
            self.num_directions, self.hrir_len, self.hrir_table_l, self.hrir_table_r = real_hrtf
            self.hrtf_kind = "kemar"
        else:
            self.hrtf_kind = "synthetic"
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

        # --- [2] 帯域分割フィルター（5帯域） ---
        # 周波数を細かく分けて帯域ごとに少しずつ違う角度を与えることで、
        # 音像を保ったまま音の広がりを出す。
        _nyq = self.sr / 2.0
        self.band_sos = [
            signal.iirfilter(2, 150 / _nyq, btype='lowpass', ftype='butter', output='sos'),
            signal.iirfilter(2, [150 / _nyq, 500 / _nyq], btype='bandpass', ftype='butter', output='sos'),
            signal.iirfilter(2, [500 / _nyq, 1800 / _nyq], btype='bandpass', ftype='butter', output='sos'),
            signal.iirfilter(2, [1800 / _nyq, 5000 / _nyq], btype='bandpass', ftype='butter', output='sos'),
            signal.iirfilter(2, 5000 / _nyq, btype='highpass', ftype='butter', output='sos'),
        ]
        self.band_zi = [np.zeros((sos.shape[0], 2), dtype=np.float32) for sos in self.band_sos]
        # 実測スピーカー特性は3帯域ぶんしかないため、5帯域から対応づける
        self._sp_band_map = (0, 1, 1, 2, 2)

        # 回転は「全帯域で共有する主回転＋帯域ごとの小さな揺れ」で構成する。
        # 帯域ごとに独立して回すと音像が帯域ごとにバラバラになり、
        # どの方向から聞こえるのか分かりにくくなるため。
        # 揺れの速度: 低音は主回転より遅れてゆっくり / 中音は主回転そのもの /
        # 高音は主回転より速く細かく揺れる。
        self._rot_theta = 0.0
        self._live_phase = 0.0
        self._wet_balance = 0.0
        self._last_band_angles = [0.0, 0.0, 0.0, 0.0, 0.0]
        self.band_configs = [
            {'type': 'low',     'y': -4.0, 'phase': 0.0, 'wobble_amp': 0.18, 'wobble_rate': -0.003},
            {'type': 'lowmid',  'y': -4.0, 'phase': 1.3, 'wobble_amp': 0.26, 'wobble_rate': -0.0015},
            {'type': 'mid',     'y':  0.0, 'phase': 0.0, 'wobble_amp': 0.0,  'wobble_rate': 0.0},
            {'type': 'highmid', 'y':  4.0, 'phase': 2.6, 'wobble_amp': 0.38, 'wobble_rate': 0.004},
            {'type': 'high',    'y':  4.0, 'phase': 4.2, 'wobble_amp': 0.50, 'wobble_rate': 0.008},
        ]

        self.conv_overlap_l = np.zeros(self.hrir_len - 1, dtype=np.float32)
        self.conv_overlap_r = np.zeros(self.hrir_len - 1, dtype=np.float32)

        # --- [3] スピーカー特性プリセット ---
        # --- 実測データ（部屋IR・スピーカー特性）。読めなければ簡易モデルへ ---
        self.room_irs = load_room_irs()
        self.speakers = load_speakers()
        self._spatial_failed = False
        logger.info(
            "立体音響ソース開始: hrtf=%s room_ir=%s speakers=%s",
            self.hrtf_kind,
            "実測" if self.room_irs is not None else "簡易(FDN)",
            "実測" if self.speakers is not None else "簡易",
        )
        self._sp_fir_key = None
        self._sp_fir = None
        self._sp_fir_overlap = np.zeros(255, dtype=np.float32)
        self._rev_ir_key = None
        self._rev_ir = None
        self._reverb_block = _BlockConvolver()
        self._spec_cache = {}
        self._rev_tail_l = np.zeros(0, dtype=np.float32)
        self._rev_tail_r = np.zeros(0, dtype=np.float32)

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

    def _read_spatial(self, raw_data):
        in_data = np.frombuffer(raw_data, dtype="<i2").astype(np.float32) / 32768.0
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

        # 実測スピーカー特性: 軸上周波数特性をFIRで適用（帯域分割の前段）
        sp_dir = None
        if self.speakers is not None:
            sp = self.speakers.get(speaker_type) or self.speakers['studio']
            sp_dir = sp["directivity"]
            if self._sp_fir_key != speaker_type:
                self._sp_fir_key = speaker_type
                self._sp_fir = sp["fir"]
            if n_samples + len(self._sp_fir) - 1 <= 2048:
                spec = self._spec(("sp", speaker_type), self._sp_fir)
                fir_full = _irfft(_rfft(mono_in, 2048) * spec, 2048)[:n_samples + len(self._sp_fir) - 1]
            else:
                fir_full = signal.oaconvolve(mono_in, self._sp_fir, mode="full")
            fir_full[:len(self._sp_fir_overlap)] += self._sp_fir_overlap
            self._sp_fir_overlap = fir_full[n_samples:].copy()
            mono_in = fir_full[:n_samples]

        # 空気吸収（ISO 9613-1）: 距離で高音ほど減衰する（5帯域の代表周波数で評価）
        air_gains = [air_absorption_gain(global_distance, f)
                     for f in (75.0, 275.0, 950.0, 3000.0, 9000.0)]

        # A. 帯域分割（5帯域）
        band_signals = []
        for _bi, _sos in enumerate(self.band_sos):
            _band_out, self.band_zi[_bi] = signal.sosfilt(_sos, mono_in, zi=self.band_zi[_bi])
            band_signals.append(_band_out)

        # 回転角度: 主回転（全帯域共有）に帯域ごとの揺れを加えたもの
        if rot_mode in ('standard', '3d'):
            self._rot_theta += 0.012
            band_angles = []
            for config in self.band_configs:
                config['phase'] += config['wobble_rate']
                band_angles.append(self._rot_theta + config['wobble_amp'] * math.sin(config['phase']))
        elif rot_mode == 'live':
            # ライブ配置: 低音は正面に固定、その他はステージ上に固定配置。
            # ボーカル帯域（中音）だけが前方の左右をゆっくり往復する。
            self._live_phase += 0.010
            vocal_angle = 0.87 * math.sin(self._live_phase)
            band_angles = [0.0, -0.18, vocal_angle, 0.21, 0.35]
        else:
            band_angles = [0.0] * len(self.band_configs)
        self._last_band_angles = band_angles

        # 距離補正: 遠くすると 1/d で小さくなる分を一部だけ持ち上げる。
        # 内容に追従する AGC とは違い、距離だけに連動する固定カーブ。
        dist_comp = max(1.0, (global_distance / 2.0) ** 0.8)


        full_out_l = np.zeros(n_samples + self.hrir_len - 1, dtype=np.float32)
        full_out_r = np.zeros(n_samples + self.hrir_len - 1, dtype=np.float32)

        # B. 帯域ごとの回転 ＆ 距離計算 ＆ 畳み込み
        for i, config in enumerate(self.band_configs):
            # 1. 回転位置計算（角度はループ前に帯域ぶん一括で決める）
            angle_rad = band_angles[i]
            if rot_mode == '3d':
                # 3軸 (Pitch/Yaw/Roll 複合) 回転
                pitch = math.sin(self._rot_theta * 0.7) * 0.45  # 上下角 (Pitch)
                x = math.sin(angle_rad) * math.cos(pitch) * global_distance
                z = -math.cos(angle_rad) * math.cos(pitch) * global_distance
                angle_deg = math.degrees(math.atan2(x, -z)) % 360

                # HRTFテーブルは -4.0 / 0.0 / 4.0 の仰角キーで構築している。
                # 3D回転でも必ず同じ集合から最も近い仰角を選択する。
                elevation_levels = (-4.0, 0.0, 4.0)
                target_elevation = (pitch / 0.45) * 4.0
                y_elevation = min(elevation_levels, key=lambda value: abs(value - target_elevation))
            elif rot_mode in ('standard', 'live'):
                # 通常 2D 水平回転（ライブ配置も水平面で処理する）
                angle_deg = math.degrees(angle_rad) % 360
                y_elevation = config['y']
            else:
                # 静止 (OFF)
                angle_deg = 0.0
                y_elevation = config['y']

            # ライブモードでは波面合成（WFS）の考え方で、1帯域を円周上の
            # 複数の二次音源から合成し、音像に大きさを持たせる。
            # 通常モードは単一方向（点音源）で定位を優先する。
            if rot_mode == 'live':
                taps = _LIVE_TAPS_WIDE if i >= 2 else _LIVE_TAPS_NARROW
            else:
                taps = _SINGLE_TAP

            sp_i = self._sp_band_map[i]
            for tap_deg, tap_w in taps:
                t_deg = (angle_deg + tap_deg) % 360
                dir_idx = int((t_deg / 360.0) * self.num_directions) % self.num_directions

                if sp_dir is not None:
                    # 実測の指向性（帯域別・方位5度刻み、正面=1）
                    dir_idx72 = int((t_deg / 360.0) * 72) % 72
                    speaker_gain = float(sp_dir[sp_i, dir_idx72])
                else:
                    directivity_power = preset['directivity'][sp_i]
                    band_gain = preset['gains'][sp_i]
                    cos_theta = math.cos(math.radians(t_deg))
                    speaker_gain = math.pow(max(0.0, 0.5 * (1.0 + cos_theta)), directivity_power) * band_gain

                hrir_l = self.hrir_table_l[(y_elevation, dir_idx)]
                hrir_r = self.hrir_table_r[(y_elevation, dir_idx)]

                # 距離減衰 ＋ 距離補正 ＋ 指向性ゲイン
                dist_atten = (1.0 / max(0.5, global_distance)) * dist_comp * speaker_gain
                band_sig = band_signals[i] * dist_atten * air_gains[i] * tap_w

                if n_samples + self.hrir_len - 1 <= 2048:
                    spec_l = self._spec(("hl", y_elevation, dir_idx), hrir_l)
                    spec_r = self._spec(("hr", y_elevation, dir_idx), hrir_r)
                    band_fft = _rfft(band_sig, 2048)
                    full_out_l += _irfft(band_fft * spec_l, 2048)[:n_samples + self.hrir_len - 1]
                    full_out_r += _irfft(band_fft * spec_r, 2048)[:n_samples + self.hrir_len - 1]
                else:
                    full_out_l += signal.oaconvolve(band_sig, hrir_l, mode='full')
                    full_out_r += signal.oaconvolve(band_sig, hrir_r, mode='full')

        # Overlap-Add 処理
        full_out_l[:self.hrir_len - 1] += self.conv_overlap_l
        full_out_r[:self.hrir_len - 1] += self.conv_overlap_r

        self.conv_overlap_l = full_out_l[n_samples:].copy()
        self.conv_overlap_r = full_out_r[n_samples:].copy()

        spatial_out_l = full_out_l[:n_samples]
        spatial_out_r = full_out_r[:n_samples]

        wet_val = float(self.state.get('fdn_wet', reverb_mix * 0.6))
        if self.room_irs is not None:
            rev_out_l, rev_out_r = self._measured_reverb(spatial_out_l, spatial_out_r, reverb_mix, wet_val)
        else:
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

        # 反響も音像の方向へ寄せる: ドライ音の左右バランス（平滑化）に合わせて
        # ウェット音の左右を傾け、残響の雲も音源のいる方向に定位させる
        dry_lvl_l = float(np.sqrt(np.mean(spatial_out_l.astype(np.float64) ** 2))) + 1e-9
        dry_lvl_r = float(np.sqrt(np.mean(spatial_out_r.astype(np.float64) ** 2))) + 1e-9
        balance = (dry_lvl_l - dry_lvl_r) / (dry_lvl_l + dry_lvl_r)
        self._wet_balance = 0.85 * self._wet_balance + 0.15 * balance
        rev_out_l = rev_out_l * (1.0 + 0.6 * self._wet_balance)
        rev_out_r = rev_out_r * (1.0 - 0.6 * self._wet_balance)

        # D. ミックス処理
        mix_l = spatial_out_l + rev_out_l * wet_val
        mix_r = spatial_out_r + rev_out_r * wet_val

        # E. 最終段は音量のみ（自動音量引き上げは廃止）
        volume = float(np.clip(self.state.get('volume', 1.0), 0.0, 2.0))
        final_l = np.clip(mix_l * volume, -1.0, 1.0)
        final_r = np.clip(mix_r * volume, -1.0, 1.0)

        out_samples = np.empty(n_samples * 2, dtype="<i2")
        out_samples[0::2] = (final_l * 32767).astype("<i2")
        out_samples[1::2] = (final_r * 32767).astype("<i2")

        return out_samples.tobytes()

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
        
        mode = self.state.get('eq', 'flat')
        self.count += 1

        if mode == 'spatial' and not self._spatial_failed:
            try:
                return self._read_spatial(raw_data)
            except Exception:
                self._spatial_failed = True
                logger.exception("立体音響の処理でエラーが発生したため、この再生では立体音響を無効化して通常再生を続けます")
        if mode == 'spatial':
            # フォールバック時: 音量だけ適用してそのまま返す
            volume = float(np.clip(self.state.get('volume', 1.0), 0.0, 2.0))
            if volume == 1.0:
                return raw_data
            gained = np.clip(np.frombuffer(raw_data, dtype="<i2").astype(np.float32) * volume, -32768, 32767).astype("<i2")
            return gained.tobytes()
        num_samples = len(raw_data) // 4
        fmt = f"<{num_samples * 2}h"
        samples = list(struct.unpack(fmt, raw_data))

            
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

    def _measured_reverb(self, in_l, in_r, room_size, wet_val=1.0):
        """実測インパルス応答の畳み込みリバーブ。ウェット信号（未スケール）を返す。

        部屋の選択は残響量で切り替える（小さい=スタジオ、大さい=ホール）。
        fdn_feedback は尾の伸縮として解釈する（0.5 で実測どおり）。
        軽量化のためブロック畳み込みを使う（ウェット音は最大で約85ms遅れる）。
        """
        if wet_val <= 0.01:
            return np.zeros_like(in_l), np.zeros_like(in_r)
        key = 'hall' if room_size >= 0.45 else 'room'
        feedback = float(np.clip(self.state.get('fdn_feedback', 0.5), 0.0, 0.95))
        cache_key = (key, round(feedback, 2))
        if self._rev_ir_key != cache_key:
            ir_l, ir_r = self.room_irs[key]
            if abs(feedback - 0.5) > 0.01:
                t = np.arange(len(ir_l), dtype=np.float32) / float(self.sr)
                env = np.exp(-t * (0.5 - feedback) * 4.0)
                env = np.minimum(env, 2.0).astype(np.float32)
                ir_l = ir_l * env
                ir_r = ir_r * env
            self._rev_ir = (ir_l, ir_r)
            self._rev_ir_key = cache_key
        ir_l, ir_r = self._rev_ir
        return self._reverb_block.process(in_l, in_r, ir_l, ir_r, cache_key)

    def _spec(self, key, ir):
        """短いIRのスペクトル（FFT長2048固定）をキャッシュして返す。"""
        spec = self._spec_cache.get(key)
        if spec is None:
            spec = _rfft(ir, 2048)
            self._spec_cache[key] = spec
        return spec

    def cleanup(self):
        self.source.cleanup()


# ==================================================
# UI: 立体音響（Spatial）設定パネル・コントロール View
# ==================================================
def spatial_panel_embed(cog, guild_id: int) -> discord.Embed:
    """立体音響パネルの Embed（表示組み立てはここ1箇所、sweep2 VC-02/16）。"""
    state = cog.get_state(guild_id)
    current_eq = state.get('eq', 'flat')
    dist = state.get('spatial_distance', 2.0)
    room = state.get('spatial_room_size', 0.3)
    speaker = state.get('spatial_speaker', 'studio')
    is_rotating = "ON" if state.get('is_rotating', True) else "OFF"
    speaker_names = {
        'studio': '🎙️ スタジオモニター（Neumann KH120A）',
        'theater': '🎬 シアター（Tannoy System 1200）',
        'pa': VOL + ' PAスピーカー（Yamaha DXR8）',
        'small': '📻 小型スピーカー（Genelec 8020）'
    }
    engine = (
        f"HRTF: **{'実測 (KEMAR)' if load_hrtf_tables() is not None else '簡易'}** / "
        f"リバーブ: **{'実測IR' if load_room_irs() is not None else '簡易'}** / "
        f"スピーカー: **{'実測' if load_speakers() is not None else '簡易'}**"
    )
    return discord.Embed(
        title="🎧 立体音響の設定",
        description=(
            f"現在のモード: **{current_eq}**\n"
            f"音像の距離: **{dist}x**\n"
            f"部屋のリバーブ: **{room}**\n"
            f"スピーカー特性: **{speaker_names.get(speaker, speaker)}**\n"
            f"5帯域立体回転: **{is_rotating}**\n"
            f"エンジン: {engine}"
        ),
        color=0x3498DB
    )

class SpatialControlView(discord.ui.View):
    def __init__(self, cog, guild_id: int):
        super().__init__(timeout=PANEL_TIMEOUT_SECONDS)
        self.cog = cog
        self.guild_id = guild_id

        state = cog.get_state(guild_id)
        
        # 💡 [修正点] 参照するボタン名を実際のメソッド名 (toggle_rot_mode または toggle_rotate) に合わせます
        rot_mode = state.get('spatial_rot_mode', 'standard')
        rot_labels = {
            'off': '回転: OFF',
            'standard': '🌀 回転: 通常',
            '3d': '🪐 回転: 3D',
            'live': '🎤 回転: ライブ'
        }
        # ボタンの label 文字列内ではカスタム絵文字 markup が描画されないため、
        # OFF 時の一時停止アイコンは emoji 引数側で持たせる。
        if hasattr(self, 'toggle_rot_mode'):
            self.toggle_rot_mode.label = rot_labels.get(rot_mode, '🌀 回転')
            self.toggle_rot_mode.emoji = PAUSE if rot_mode == 'off' else None
        # もし toggle_rotate のまま使用している場合：
        elif hasattr(self, 'toggle_rotate'):
            is_rotating = state.get('is_rotating', True)
            self.toggle_rotate.label = "🌀 回転: ON" if is_rotating else '回転: OFF'
            self.toggle_rotate.emoji = None if is_rotating else PAUSE

        self._sync_select_defaults()

    def _sync_select_defaults(self):
        """各セレクトの表示上の既定値を、現在の状態に合わせる。

        選択肢の default はクラス定義時に固定されているため、そのままだと
        値を変えてもドロップダウンの表示だけ標準値のまま残ってしまう。
        """
        state = self.cog.get_state(self.guild_id)
        targets = (
            (self.select_reverb, state.get('spatial_room_size', 0.3)),
            (self.select_distance, state.get('spatial_distance', 2.0)),
            (self.select_speaker, state.get('spatial_speaker', 'studio')),
        )
        for select, current in targets:
            for option in select.options:
                try:
                    option.default = float(option.value) == float(current)
                except (TypeError, ValueError):
                    option.default = option.value == current

    # 💡 ボタンの定義（デコレータで定義されたメソッド）
    @discord.ui.button(label="回転モード切替", style=discord.ButtonStyle.primary, row=0)
    async def toggle_rot_mode(self, interaction: discord.Interaction, button: discord.ui.Button):
        if not await _require_same_vc(interaction):
            return
        state = self.cog.get_state(self.guild_id)
        current = state.get('spatial_rot_mode', 'standard')
        
        # モードの順繰り切替: standard -> 3d -> off -> standard
        next_mode = {'standard': '3d', '3d': 'live', 'live': 'off', 'off': 'standard'}[current]
        state['spatial_rot_mode'] = next_mode
        state['is_rotating'] = (next_mode != 'off')
        
        await self.update_panel(interaction)

    def embed(self) -> discord.Embed:
        return spatial_panel_embed(self.cog, self.guild_id)

    async def update_panel(self, interaction: discord.Interaction):
        """パネルの表示を最新状態に更新（V2 ラッパー経由で再描画）。"""
        self._sync_select_defaults()
        await edit_panel_view(interaction, self)

    # 1. Spatialモード ON ボタン
    @discord.ui.button(label="🎧 Spatial ON", style=discord.ButtonStyle.primary, row=0)
    async def toggle_spatial(self, interaction: discord.Interaction, button: discord.ui.Button):
        if not await _require_same_vc(interaction):
            return
        state = self.cog.get_state(self.guild_id)
        state['eq'] = 'spatial'
        # 先に応答を済ませる。ソースの再作成（URL解決など）は数秒かかることが
        # あり、応答が遅れると Discord に「時間内に応答しませんでした」と
        # 表示されてしまう（状態は変わるのに失敗したように見える）。
        if not interaction.response.is_done():
            await interaction.response.defer()
        # 再生中の曲にも即時反映する（音声ソースを作り直す）。
        # 状態を変えるだけだと、ソースが作り直される次の曲まで立体音響が掛からない。
        await self.cog.apply_immediate_setting(interaction)
        await self.update_panel(interaction)



    # 3. 部屋のリバーブ量 (Reverb Mix) 選択メニュー
    @discord.ui.select(
        placeholder="部屋のリバーブ (残響量) を選択...",
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
        if not await _require_same_vc(interaction):
            return
        state = self.cog.get_state(self.guild_id)
        state['spatial_room_size'] = float(select.values[0])
        await self.update_panel(interaction)

    # 4. 音像の距離 選択メニュー
    @discord.ui.select(
        placeholder="音像の距離を選択...",
        options=[
            discord.SelectOption(label="すぐ近く (0.5x)", value="0.5"),
            discord.SelectOption(label="近い (1.0x)", value="1.0"),
            discord.SelectOption(label="やや近い (1.5x)", value="1.5"),
            discord.SelectOption(label="標準 (2.0x)", value="2.0", default=True),
            discord.SelectOption(label="遠め (3.0x)", value="3.0"),
            discord.SelectOption(label="遠い (5.0x)", value="5.0"),
            discord.SelectOption(label="かなり遠い (8.0x)", value="8.0"),
        ],
        row=2
    )
    async def select_distance(self, interaction: discord.Interaction, select: discord.ui.Select):
        if not await _require_same_vc(interaction):
            return
        state = self.cog.get_state(self.guild_id)
        state['spatial_distance'] = float(select.values[0])
        await self.update_panel(interaction)

    # 5. 音像の距離 ＆ スピーカー特性 (ドロップダウン)
    @discord.ui.select(
        placeholder="スピーカー特性を選択...",
        options=[
            discord.SelectOption(label="スタジオモニター (Neumann KH120A 実測)", value="studio", default=True),
            discord.SelectOption(label="シアター用 (Tannoy System 1200 実測)", value="theater"),
            discord.SelectOption(label="PAスピーカー (Yamaha DXR8 実測)", value="pa"),
            discord.SelectOption(label="小型スピーカー (Genelec 8020 実測)", value="small"),
        ],
        row=3
    )
    async def select_speaker(self, interaction: discord.Interaction, select: discord.ui.Select):
        if not await _require_same_vc(interaction):
            return
        state = self.cog.get_state(self.guild_id)
        state['spatial_speaker'] = select.values[0]
        await self.update_panel(interaction)
