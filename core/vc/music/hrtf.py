"""実測 HRTF（頭部伝達関数）の読み込み。

立体音響（spatial.py）が使う HRIR テーブルを、リポジトリ同梱の
KEMAR 実測データ（assets/hrtf/kemar_hrir_48k.npz）から構築する。
読み込みに失敗した場合は None を返し、呼び出し側が簡易モデルへ
フォールバックする（このモジュールは numpy 以外に依存しない）。
"""
from __future__ import annotations

import logging
from pathlib import Path

import numpy as np

logger = logging.getLogger("cogs.sio_music")

_HRTF_PATH = Path(__file__).resolve().parents[3] / "assets" / "hrtf" / "kemar_hrir_48k.npz"
# 計測仰角 → エンジン側の帯域の高さキー（低域=-4 / 中域=0 / 高域=+4）
_ELEVATION_TO_Y = {-30: -4.0, 0: 0.0, 30: 4.0}

_cache = None  # None=未読込 / False=失敗 / tuple=成功


def load_hrtf_tables():
    """(方位数, HRIR長, 左耳テーブル, 右耳テーブル) を返す。読めなければ None。

    テーブルは {(高さキー, 方位index): HRIR(float32)} の dict で、
    spatial.py の従来テーブルと同じ形にそろえてある。
    """
    global _cache
    if _cache is not None:
        return _cache or None
    try:
        with np.load(_HRTF_PATH) as data:
            left = np.array(data["hrir_left"], dtype=np.float32)
            right = np.array(data["hrir_right"], dtype=np.float32)
            elevations = [int(v) for v in data["elevations"]]
            step = int(data["azimuth_step"])
        num_directions = 360 // step
        table_l: dict[tuple[float, int], np.ndarray] = {}
        table_r: dict[tuple[float, int], np.ndarray] = {}
        for row, elevation in enumerate(elevations):
            y = _ELEVATION_TO_Y[elevation]
            for idx in range(num_directions):
                table_l[(y, idx)] = left[row, idx]
                table_r[(y, idx)] = right[row, idx]
        _cache = (num_directions, int(left.shape[2]), table_l, table_r)
        logger.info("実測HRTFを読み込みました: %s", _HRTF_PATH)
    except Exception:
        logger.warning(
            "実測HRTFの読み込みに失敗したため、簡易HRTFへフォールバックします",
            exc_info=True,
        )
        _cache = False
    return _cache or None
