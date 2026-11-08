# -*- coding: utf-8 -*-
"""公式の常設ルーム（言語ごとの自動作成）のテスト。Discord には接続しない。

- 起動時の ensure_official_rooms が、対応言語ごとに
  「日替わりテーマ部屋」と「テーマなしフリー部屋」を1つずつ作る
- 既にあるルームは上書きしない（冪等・ユーザー作成ルームを奪わない）
- 自動テーマ部屋だけが日替わり回転の対象になる
"""

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
from core.vc.globalvc.lang import LOCALE_LABELS  # noqa: E402
from core.vc.globalvc.rooms import RoomConfig  # noqa: E402


class EnsureOfficialRoomsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        voice_restore.reset_store(Path(self.tmp.name) / "voice_restore.json")
        rooms_mod.ROOMS.clear()

    def tearDown(self):
        rooms_mod.ROOMS.clear()
        self.tmp.cleanup()

    def test_table_covers_all_locales(self):
        self.assertEqual(set(rooms_mod.OFFICIAL_ROOMS), set(LOCALE_LABELS))

    def test_creates_theme_and_free_room_per_language(self):
        created = rooms_mod.ensure_official_rooms()
        self.assertEqual(len(created), 2 * len(LOCALE_LABELS))
        self.assertEqual(len(rooms_mod.ROOMS), 2 * len(LOCALE_LABELS))
        for code, (theme_name, _td, free_name, _fd) in rooms_mod.OFFICIAL_ROOMS.items():
            theme_room = rooms_mod.ROOMS[theme_name]
            self.assertTrue(theme_room.permanent)
            self.assertTrue(theme_room.theme_auto)       # 日替わり
            self.assertEqual(theme_room.language, code)
            self.assertFalse(theme_room.private)
            self.assertEqual(theme_room.max_servers, 0)  # 無制限
            free_room = rooms_mod.ROOMS[free_name]
            self.assertTrue(free_room.permanent)
            self.assertFalse(free_room.theme_auto)       # テーマなし固定
            self.assertEqual(free_room.theme, "")
            self.assertEqual(free_room.language, code)

    def test_idempotent(self):
        first = rooms_mod.ensure_official_rooms()
        second = rooms_mod.ensure_official_rooms()
        self.assertEqual(second, [])
        self.assertEqual(len(rooms_mod.ROOMS), len(first))

    def test_existing_room_is_not_overwritten(self):
        theme_name = rooms_mod.OFFICIAL_ROOMS["ja"][0]
        custom = RoomConfig(name=theme_name, owner_id=123, owner_guild_id=456,
                            permanent=False, description="ユーザーの部屋")
        rooms_mod.ROOMS[theme_name] = custom
        created = rooms_mod.ensure_official_rooms()
        self.assertNotIn(theme_name, created)
        self.assertIs(rooms_mod.ROOMS[theme_name], custom)
        self.assertEqual(len(rooms_mod.ROOMS), 2 * len(LOCALE_LABELS))

    def test_created_rooms_are_persisted(self):
        rooms_mod.ensure_official_rooms()
        saved = voice_restore.get_store().section("gvc_rooms")
        self.assertEqual(len(saved), 2 * len(LOCALE_LABELS))
        rooms_mod.ROOMS.clear()
        rooms_mod._load_rooms()
        self.assertEqual(len(rooms_mod.ROOMS), 2 * len(LOCALE_LABELS))
        room = rooms_mod.ROOMS[rooms_mod.OFFICIAL_ROOMS["en"][0]]
        self.assertTrue(room.permanent)
        self.assertTrue(room.theme_auto)
        self.assertEqual(room.language, "en")

    def test_rotation_assigns_theme_only_to_auto_rooms(self):
        rooms_mod.ensure_official_rooms()
        rooms_mod.rotate_room_themes()
        for code, (theme_name, _td, free_name, _fd) in rooms_mod.OFFICIAL_ROOMS.items():
            self.assertNotEqual(rooms_mod.ROOMS[theme_name].theme, "", code)
            self.assertEqual(rooms_mod.ROOMS[free_name].theme, "", code)


if __name__ == "__main__":
    unittest.main()
