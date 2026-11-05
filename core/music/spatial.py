import discord
from core.panel_v2 import edit_message_v2
from discord import app_commands  # ← 追加
from discord.ext import commands, tasks
import asyncio
import time
import types
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
from core import voice_restore
from core.voice_session import SHARED_FEATURES, VoiceBusy, get_manager
from core.voice_media import add_audio_source, has_audio_source, remove_audio_source
from core.legacy import Responder
from core.emojis import FAILED, MUSIC, SUCCESS
from core.music_activity import build_music_activity_snapshot

from core.music.common import *  # noqa: F401,F403 - shared helpers/constants

logger = logging.getLogger("cogs.sio_music")



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
            'pa': '<:vol:1563559476265488414> PAスピーカー (高音圧・指向性強)',
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
        placeholder="<:vol:1563559476265488414> 自動音量引き上げ幅 (AGC) を選択...",
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
