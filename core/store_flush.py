# -*- coding: utf-8 -*-
"""JSON ストア共通の dirty / flush 制御（一斉監査 K-1 で集約）。

状態をメモリに持ち、変更のたびに数えて、一定件数または一定時間で
まとめて保存する「バッチフラッシュ」方式の判定部分だけを共通化する。
保存本体（何をどう書くか）はストアごとに異なるため、この mixin には置かない。

利用側の前提:
- ``__init__`` で ``_dirty`` / ``_last_flush`` / ``_flush_every`` /
  ``_flush_interval`` を初期化する（従来どおり各ストアに残す）
- 保存本体 ``flush()`` を自前で定義する
"""
from __future__ import annotations

import time


class DirtyFlushMixin:
    """_mark_dirty / maybe_flush の共通実装。flush() は利用側が定義する。"""

    _dirty: int
    _last_flush: float
    _flush_every: int
    _flush_interval: float

    def _mark_dirty(self) -> None:
        self._dirty += 1
        if self._dirty >= self._flush_every or (
            time.monotonic() - self._last_flush >= self._flush_interval
        ):
            self.flush()

    def maybe_flush(self) -> None:
        if self._dirty and time.monotonic() - self._last_flush >= self._flush_interval:
            self.flush()
