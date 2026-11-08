# -*- coding: utf-8 -*-
"""グローバルVC 常設ルームとテーマ（日替わり自動テーマ）のテスト。Discord には接続しない。

- core/vc/globalvc/themes.py: ルーム名と日付から決まる決定的なテーマ割り当て
- core/vc/globalvc/rooms.py: permanent / theme / theme_auto の永続化（旧形式との互換）
  と rotate_room_themes の対象範囲（自動テーマの常設ルームだけが回る）
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
from core.vc.globalvc.rooms import RoomConfig  # noqa: E402

JST = themes.JST
DAY1 = datetime.datetime(2026, 11, 8, 12, 0, tzinfo=JST)
DAY2 = datetime.datetime(2026, 11, 9, 12, 0, tzinfo=JST)


class ThemeForTest(unittest.TestCase):
    def test_deterministic(self):
        day = DAY1.date()
        self.assertEqual(themes.theme_for("雑談部屋", day), themes.theme_for("雑談部屋", day))
        self.assertIn(themes.theme_for("雑談部屋", day), themes.THEME_POOL)

    def test_rotates_daily_through_pool(self):
        start = DAY1.date()
        seen = [themes.theme_for("雑談部屋", start + datetime.timedelta(days=i))
                for i in range(len(themes.THEME_POOL))]
        # 1日ごとに次の候補へ進み、プール一周で全候補がちょうど1回ずつ出る
        self.assertEqual(len(set(seen)), len(themes.THEME_POOL))
        self.assertNotEqual(seen[0], seen[1])

    def test_theme_day_uses_jst(self):
        # UTC 2026-11-07 20:00 は JST では 2026-11-08 05:00（翌日）
        utc_evening = datetime.datetime(2026, 11, 7, 20, 0, tzinfo=datetime.timezone.utc)
        self.assertEqual(themes.theme_day(utc_evening), datetime.date(2026, 11, 8))


class RoomPersistenceTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = voice_restore.reset_store(Path(self.tmp.name) / "voice_restore.json")
        rooms_mod.ROOMS.clear()

    def tearDown(self):
        rooms_mod.ROOMS.clear()
        self.tmp.cleanup()

    def test_round_trip_with_new_fields(self):
        rooms_mod.ROOMS["常設部屋"] = RoomConfig(
            name="常設部屋", owner_id=110, owner_guild_id=10,
            permanent=True, theme="好きな食べ物", theme_auto=True)
        rooms_mod._persist_rooms()
        rooms_mod.ROOMS.clear()
        rooms_mod._load_rooms()
        room = rooms_mod.ROOMS["常設部屋"]
        self.assertTrue(room.permanent)
        self.assertEqual(room.theme, "好きな食べ物")
        self.assertTrue(room.theme_auto)

    def test_old_format_loads_with_defaults(self):
        room = rooms_mod._room_from_dict({
            "name": "旧ルーム", "owner_id": 110, "owner_guild_id": 10,
            "max_servers": 0, "private": False, "password": "", "description": "",
            "created_at": 1700000000.0,
        })
        self.assertIsNotNone(room)
        self.assertFalse(room.permanent)
        self.assertEqual(room.theme, "")
        self.assertFalse(room.theme_auto)


class RotateRoomThemesTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = voice_restore.reset_store(Path(self.tmp.name) / "voice_restore.json")
        rooms_mod.ROOMS.clear()
        rooms_mod.ROOMS["auto"] = RoomConfig(
            name="auto", owner_id=1, owner_guild_id=10,
            permanent=True, theme="", theme_auto=True)
        rooms_mod.ROOMS["fixed"] = RoomConfig(
            name="fixed", owner_id=1, owner_guild_id=10,
            permanent=True, theme="固定テーマ", theme_auto=False)
        rooms_mod.ROOMS["plain"] = RoomConfig(
            name="plain", owner_id=1, owner_guild_id=10,
            permanent=False, theme="通常テーマ", theme_auto=False)

    def tearDown(self):
        rooms_mod.ROOMS.clear()
        self.tmp.cleanup()

    def test_only_auto_permanent_rooms_rotate(self):
        changed = rooms_mod.rotate_room_themes(DAY1)
        self.assertEqual(changed, ["auto"])
        self.assertEqual(rooms_mod.ROOMS["auto"].theme,
                         themes.theme_for("auto", DAY1.date()))
        self.assertEqual(rooms_mod.ROOMS["fixed"].theme, "固定テーマ")
        self.assertEqual(rooms_mod.ROOMS["plain"].theme, "通常テーマ")

    def test_same_day_is_stable_next_day_rotates(self):
        rooms_mod.rotate_room_themes(DAY1)
        first = rooms_mod.ROOMS["auto"].theme
        self.assertEqual(rooms_mod.rotate_room_themes(DAY1), [])
        self.assertEqual(rooms_mod.ROOMS["auto"].theme, first)
        changed = rooms_mod.rotate_room_themes(DAY2)
        self.assertEqual(changed, ["auto"])
        self.assertNotEqual(rooms_mod.ROOMS["auto"].theme, first)


if __name__ == "__main__":
    unittest.main()
