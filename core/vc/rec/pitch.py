from __future__ import annotations
import asyncio
import io
import logging
import re
import subprocess
import threading
import time
import wave
import ctypes.util
import math
import numpy as np
from scipy.signal import find_peaks
import collections
import discord
import discord.opus
from discord.ext import commands
from discord.ext import voice_recv
from core.support.legacy import Responder
from core.vc import vc_feature_restore
from core.vc.voice_session import VoiceBusy, get_manager
from core.vc.voice_recv_patch import patch_voice_recv_client
from core.support.messages import VOICE_NOT_JOINED, voice_connection_failed
from core.support.emojis import CLOCK, FAILED, MUSIC, PAUSE

from core.vc.rec.common import *  # noqa: F401,F403 - shared constants/helpers
from core.vc.rec.common import NOTE_NAMES_FLAT, NOTE_NAMES_SHARP  # noqa: F401
from core.vc.rec.sink import RecordingSink  # noqa: F401
from core.support.panel_v2 import as_embed_v2

logger = logging.getLogger("cogs.sio_rec")


def midi_to_freq(midi_num: int) -> float:
    return 440.0 * (2.0 ** ((midi_num - 69) / 12.0))


def freq_to_notes(freq: float) -> tuple[str, str, int] | None:
    if freq < 27.5 or freq > 4186.0:  # A0 〜 C8
        return None
    midi_num = int(round(69 + 12 * math.log2(freq / 440.0)))
    idx = midi_num % 12
    octave = (midi_num // 12) - 1
    return NOTE_NAMES_SHARP[idx] + str(octave), NOTE_NAMES_FLAT[idx] + str(octave), midi_num


def analyze_pitch_layers(pcm_bytes: bytes, top_k: int = 4) -> list[tuple[str, str, int]]:
    """PCMから複数音階（和音・倍音層）を検出"""
    if len(pcm_bytes) < 3840:
        return []
    audio_data = np.frombuffer(pcm_bytes, dtype=np.int16).astype(np.float32)
    mono = audio_data[::2]
    windowed = mono * np.hamming(len(mono))
    fft_spectrum = np.abs(np.fft.rfft(windowed))
    freqs = np.fft.rfftfreq(len(mono), d=1.0 / 48000)

    max_val = np.max(fft_spectrum)
    if max_val < 500:
        return []

    peaks, _ = find_peaks(fft_spectrum, height=max_val * 0.18, distance=max(1, int(30 / (48000 / len(mono)))))
    if len(peaks) == 0:
        return []

    sorted_peaks = sorted(peaks, key=lambda p: fft_spectrum[p], reverse=True)[:top_k]
    results, seen_midi = [], set()
    for p in sorted_peaks:
        res = freq_to_notes(freqs[p])
        if res and res[2] not in seen_midi:
            seen_midi.add(res[2])
            results.append(res)
    return results


def format_notes(detected: list[tuple[str, str, int]]) -> list[str]:
    """analyze_pitch_layers の結果を「C♯4/D♭4」のような表記にする（同じなら片方だけ）。"""
    return [sharp if sharp == flat else f"{sharp}/{flat}" for sharp, flat, _midi in detected]




class PitchMixin:
    async def pitch_command(self, r: Responder):
        """直近の音声からピアノ音階（単音/和音/声の倍音層）を解析する。"""
        session = self.sessions.get(r.guild.id)
        if not session:
            return await r.send(view=as_embed_v2(we(f"{FAILED} 現在録音中ではありません。")), ephemeral=True)

        sink: RecordingSink = session["sink"]
        audio_snapshot = sink.snapshot()
        if not audio_snapshot:
            return await r.send(view=as_embed_v2(we(MUSIC + ' 音声データがまだ蓄積されていません。話してから実行してください。')), ephemeral=True)

        embed = discord.Embed(title="🎹 リアルタイム音階解析 (Pitch Detection)", color=0x3498DB)
        found_any = False
        for speaker_label, pcm in list(audio_snapshot.items())[:25]:
            # 直近 0.5 秒分のデータ（192000 * 0.5 = 96000 bytes）を取り出して解析
            recent_pcm = pcm[-96000:] if len(pcm) > 96000 else pcm
            detected = analyze_pitch_layers(recent_pcm, top_k=4)
            if detected:
                found_any = True
                notes_str = " / ".join(f"`{n}`" for n in format_notes(detected))
                embed.add_field(name=f"🎙️ {speaker_label}"[:256], value=f"検出音階（層）: {notes_str}"[:1024], inline=False)

        if not found_any:
            embed.description = "現在明確なピッチ（音階）は検出されませんでした。"
        await r.send(view=as_embed_v2(embed))
