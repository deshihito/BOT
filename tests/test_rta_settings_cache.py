"""bump_rta_settings キャッシュ TTL（Web 書き込みを Bot が拾うための失効）のテスト。"""
from __future__ import annotations

import os
import sys
import time
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from core.game.rta.settings import SettingsMixin


class _Bare(SettingsMixin):
    def __init__(self):
        self._enabled_cache = {}
        self._role_cache = {}


class SettingsCacheTtlTest(unittest.TestCase):
    def test_put_then_get_hits_within_ttl(self):
        bare = _Bare()
        bare._cache_put(bare._enabled_cache, "1", False)
        hit, value = bare._cache_get(bare._enabled_cache, "1")
        self.assertTrue(hit)
        self.assertFalse(value)

    def test_get_misses_after_ttl(self):
        bare = _Bare()
        bare._enabled_cache["1"] = (True, time.monotonic() - SettingsMixin.SETTINGS_CACHE_TTL_SECONDS - 1)
        hit, _ = bare._cache_get(bare._enabled_cache, "1")
        self.assertFalse(hit)

    def test_enabled_cached_returns_last_known_ignoring_ttl(self):
        bare = _Bare()
        bare._enabled_cache["9"] = (False, time.monotonic() - 3600)
        self.assertFalse(bare._enabled_cached(9))
        self.assertTrue(bare._enabled_cached(12345))


if __name__ == "__main__":
    unittest.main()
