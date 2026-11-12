# -*- coding: utf-8 -*-
"""応答の意味色（単一の定義場所）。

色は装飾ではなく状態で決める: 成功・通常応答は緑、エラーは赤、
警告（未登録・該当なし等）は黄。機能ごとの固有色（テーマや盤面の
軸色など）はここでは扱わない。
値は discord.js の Colors と同じ 16 進数に揃える。
"""
from __future__ import annotations

SUCCESS = 0x57F287
ERROR = 0xED4245
WARNING = 0xFEE75C
