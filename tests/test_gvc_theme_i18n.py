# -*- coding: utf-8 -*-
"""日替わりテーマの多言語化のテスト。Discord には接続しない。

- 言語ごとのプール（THEME_POOLS）が全言語そろい、並び順が一致する
- theme_for はルームの言語でテーマを返し、同じ話題が言語横断で選ばれる
- rotate_room_themes は各ルームの言語でテーマを割り当てる
"""

import datetime
import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

for _name, _value in {'BOT_API_BASE_URL': 'http://127.0.0.1:8787', 'BOT_API_KEY': 'dummy-key'}.items():
    os.environ.setdefault(_name, _value)

from core.vc import voice_restore  # noqa: E402
from core.vc.globalvc import rooms as rooms_mod  # noqa: E402
from core.vc.globalvc import themes  # noqa: E402
from core.vc.globalvc.lang import LOCALE_LABELS  # noqa: E402
from core.vc.globalvc.rooms import RoomConfig  # noqa: E402

DAY = datetime.date(2026, 11, 8)


class ThemePoolsTest(unittest.TestCase):
    def test_all_locales_have_full_pool(self):
        self.assertEqual(set(themes.THEME_POOLS), set(LOCALE_LABELS))
        for code, pool in themes.THEME_POOLS.items():
            self.assertEqual(len(pool), len(themes.THEME_POOL), code)
            self.assertEqual(len(set(pool)), len(pool), code)  # 重複なし
            self.assertTrue(all(isinstance(t, str) and t for t in pool), code)

    def test_ja_pool_is_legacy_pool(self):
        self.assertIs(themes.THEME_POOLS["ja"], themes.THEME_POOL)
        self.assertIs(themes.pool_for("ja"), themes.THEME_POOL)
        self.assertIs(themes.pool_for(""), themes.THEME_POOL)
        self.assertIs(themes.pool_for("xx"), themes.THEME_POOL)  # 未知は ja に寄せる


class ThemeForLangTest(unittest.TestCase):
    def test_same_topic_index_across_languages(self):
        ja = themes.theme_for("雑談部屋", DAY, "ja")
        index = themes.THEME_POOL.index(ja)
        for code, pool in themes.THEME_POOLS.items():
            self.assertEqual(themes.theme_for("雑談部屋", DAY, code), pool[index], code)

    def test_default_lang_is_ja_compatible(self):
        # 言語指定なしの従来呼び出しは今まで通り日本語プールから選ぶ
        self.assertEqual(themes.theme_for("雑談部屋", DAY),
                         themes.theme_for("雑談部屋", DAY, "ja"))
        self.assertIn(themes.theme_for("雑談部屋", DAY), themes.THEME_POOL)

    def test_rotation_cycles_each_language_pool(self):
        for code, pool in themes.THEME_POOLS.items():
            seen = [themes.theme_for("部屋", DAY + datetime.timedelta(days=i), code)
                    for i in range(len(pool))]
            self.assertEqual(set(seen), set(pool), code)

    def test_explicit_pool_still_wins(self):
        custom = ("A", "B", "C")
        self.assertIn(themes.theme_for("部屋", DAY, "en", pool=custom), custom)


class RotateByRoomLanguageTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        voice_restore.reset_store(Path(self.tmp.name) / "voice_restore.json")
        rooms_mod.ROOMS.clear()

    def tearDown(self):
        rooms_mod.ROOMS.clear()
        self.tmp.cleanup()

    def _add_auto_room(self, name, language):
        rooms_mod.ROOMS[name] = RoomConfig(
            name=name, owner_id=1, owner_guild_id=1,
            permanent=True, theme_auto=True, language=language)

    def test_rotate_uses_room_language(self):
        self._add_auto_room("en-room", "en")
        self._add_auto_room("ko-room", "ko")
        self._add_auto_room("legacy-room", "")
        rooms_mod.rotate_room_themes()
        self.assertIn(rooms_mod.ROOMS["en-room"].theme, themes.THEME_POOLS["en"])
        self.assertIn(rooms_mod.ROOMS["ko-room"].theme, themes.THEME_POOLS["ko"])
        # 言語未設定の旧ルームは日本語（従来どおり）
        self.assertIn(rooms_mod.ROOMS["legacy-room"].theme, themes.THEME_POOL)


if __name__ == "__main__":
    unittest.main()
