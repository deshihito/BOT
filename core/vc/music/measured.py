"""立体音響の実測データ（部屋IR・スピーカー特性）と空気吸収の読み込み。

部屋の残響は実測インパルス応答、スピーカー特性は無響室実測
（DIRPAT）の軸上特性＋指向性を使う。読み込みに失敗した場合は None を
返し、呼び出し側が従来の簡易モデルへフォールバックする
（このモジュールは numpy 以外に依存しない）。
"""
from __future__ import annotations

import logging
import math
from pathlib import Path

import numpy as np

logger = logging.getLogger("cogs.sio_music")

_ASSETS = Path(__file__).resolve().parents[3] / "assets" / "spatial"
_SPEAKER_KEYS = ("studio", "theater", "pa", "small")

_room_cache = None  # None=未読込 / False=失敗 / dict=成功
_speaker_cache = None


def load_room_irs():
    """{"room": (L, R), "hall": (L, R)}（float32, 48kHz）を返す。読めなければ None。"""
    global _room_cache
    if _room_cache is not None:
        return _room_cache or None
    try:
        with np.load(_ASSETS / "room_ir.npz") as data:
            result = {}
            for key in ("room", "hall"):
                ir = np.array(data[key], dtype=np.float32)
                result[key] = (ir[:, 0].copy(), ir[:, 1].copy())
        _room_cache = result
        logger.info("実測の部屋IRを読み込みました")
    except Exception:
        logger.warning("部屋IRの読み込みに失敗したため、簡易リバーブへフォールバックします", exc_info=True)
        _room_cache = False
    return _room_cache or None


def load_speakers():
    """{プリセット名: {"fir": FIR, "directivity": (3, 72)}} を返す。読めなければ None。"""
    global _speaker_cache
    if _speaker_cache is not None:
        return _speaker_cache or None
    try:
        with np.load(_ASSETS / "speakers.npz") as data:
            result = {
                key: {
                    "fir": np.array(data[f"{key}_fir"], dtype=np.float32),
                    "directivity": np.array(data[f"{key}_directivity"], dtype=np.float32),
                }
                for key in _SPEAKER_KEYS
            }
        _speaker_cache = result
        logger.info("実測スピーカー特性を読み込みました")
    except Exception:
        logger.warning("スピーカー特性の読み込みに失敗したため、簡易プリセットへフォールバックします", exc_info=True)
        _speaker_cache = False
    return _speaker_cache or None


def _iso9613_alpha_db_per_m(freq_hz: float) -> float:
    """ISO 9613-1 の式による空気吸収係数（dB/m）。20°C・湿度70%・1気圧。"""
    T = 293.15          # 20°C
    T0 = 293.15
    pr = 1.0            # 基準気圧比
    # 水蒸気のモル濃度 h（%）: 70%RH at 20°C
    psat = 10.0 ** (-6.8346 * (273.16 / T) ** 1.261 + 4.6151)
    h = 70.0 * psat / pr
    fr_o = pr * (24.0 + 4.04e4 * h * (0.02 + h) / (0.391 + h))
    fr_n = pr * (T / T0) ** -0.5 * (9.0 + 280.0 * h * math.exp(-4.170 * ((T / T0) ** (-1.0 / 3.0) - 1.0)))
    f = float(freq_hz)
    term = (
        1.84e-11 * (1.0 / pr) * (T / T0) ** 0.5
        + (T / T0) ** -2.5 * (
            0.01275 * math.exp(-2239.1 / T) / (fr_o + f * f / fr_o)
            + 0.1068 * math.exp(-3352.0 / T) / (fr_n + f * f / fr_n)
        )
    )
    return 8.686 * f * f * term


# エンジンの3帯域（低 <320Hz / 中 750〜2250Hz / 高 >5kHz）の代表周波数
_BAND_CENTER_HZ = (200.0, 1500.0, 9000.0)
_BAND_ALPHA = tuple(_iso9613_alpha_db_per_m(f) for f in _BAND_CENTER_HZ)


def air_absorption_gains(distance_m: float) -> tuple[float, float, float]:
    """距離に対する帯域別ゲイン（ISO 9613-1 の空気吸収）。"""
    d = max(0.0, float(distance_m))
    return tuple(10.0 ** (-alpha * d / 20.0) for alpha in _BAND_ALPHA)  # type: ignore[return-value]
