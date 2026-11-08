# -*- coding: utf-8 -*-
"""グローバルVCの言語（ルームの言語・表示フィルタ・言語設定）とテーマなし指定のテスト。

Discord には接続しない。対象:
- rooms.py: language の永続化
- lang.py: room_visible / effective_filter_lang
- manage.py: 作成時の言語記録、テーマ「なし」の解釈、_lang_setting_impl
- ui.py: 一覧の言語フィルタ
"""

import os
import sys
import tempfile
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

for _name, _value in {'BOT_API_BASE_URL': 'http://127.0.0.1:8787', 'BOT_API_KEY': 'dummy-key'}.items():
    os.environ.setdefault(_name, _value)

from core.vc import voice_restore  # noqa: E402
from core.vc.globalvc import lang as lang_mod  # noqa: E402
from core.vc.globalvc import rooms as rooms_mod  # noqa: E402
from core.vc.globalvc.rooms import RoomConfig  # noqa: E402

ADMIN_ID = 424242


class FakeBot:
    def __init__(self, admin_ids):
        self._admin_ids = set(admin_ids)

    async def is_owner(self, user):
        return user.id in self._admin_ids


class FakeResponder:
    def __init__(self, user_id, guild_id=10, manage_guild=True):
        self.user = types.SimpleNamespace(
            id=user_id, voice=None,
            guild_permissions=types.SimpleNamespace(manage_guild=manage_guild))
        self.guild = types.SimpleNamespace(id=guild_id)
        self.channel = None
        self.sent = []

    async def defer(self):
        pass

    async def send(self, content=None, **kwargs):
        self.sent.append(content if content is not None else kwargs.get("embed"))


class StoreResetCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = voice_restore.reset_store(Path(self.tmp.name) / "voice_restore.json")
        self._rooms = dict(rooms_mod.ROOMS)
        rooms_mod.ROOMS.clear()

    def tearDown(self):
        rooms_mod.ROOMS.clear()
        rooms_mod.ROOMS.update(self._rooms)
        self.tmp.cleanup()


class LanguagePersistenceTest(StoreResetCase):
    def test_round_trip(self):
        rooms_mod.ROOMS["r"] = RoomConfig(
            name="r", owner_id=1, owner_guild_id=10, language="en")
        rooms_mod._persist_rooms()
        rooms_mod.ROOMS.clear()
        rooms_mod._load_rooms()
        self.assertEqual(rooms_mod.ROOMS["r"].language, "en")

    def test_old_format_defaults_unset(self):
        room = rooms_mod._room_from_dict({"name": "old", "owner_id": 1, "owner_guild_id": 10})
        self.assertEqual(room.language, "")


class RoomVisibleTest(unittest.TestCase):
    def test_rules(self):
        self.assertTrue(lang_mod.room_visible("ja", None))     # フィルタなし
        self.assertTrue(lang_mod.room_visible("", "en"))       # 未設定ルームは常に出す
        self.assertTrue(lang_mod.room_visible("en", "en"))
        self.assertFalse(lang_mod.room_visible("ja", "en"))


class FakeGuildStore:
    def __init__(self, data=None):
        self.data = data or {}
        self.updates = []

    def get(self, guild_id, section):
        return dict(self.data.get((guild_id, section), {}))

    async def update(self, guild_id, section, **values):
        self.updates.append((guild_id, section, values))
        current = self.data.setdefault((guild_id, section), {})
        for key, value in values.items():
            if value is None:
                current.pop(key, None)
            else:
                current[key] = value
        return dict(current)


class EffectiveFilterTest(unittest.TestCase):
    def setUp(self):
        self.store = FakeGuildStore()
        self._orig_store = lang_mod._store
        self._orig_locale = lang_mod.server_locale
        lang_mod._store = lambda: self.store
        lang_mod.server_locale = lambda guild_id: "en"

    def tearDown(self):
        lang_mod._store = self._orig_store
        lang_mod.server_locale = self._orig_locale

    def test_default_follows_server_locale(self):
        self.assertEqual(lang_mod.effective_filter_lang(10), "en")

    def test_override_code(self):
        self.store.data[(10, "gvc")] = {"lang_filter": "ko"}
        self.assertEqual(lang_mod.effective_filter_lang(10), "ko")

    def test_override_all_means_no_filter(self):
        self.store.data[(10, "gvc")] = {"lang_filter": "all"}
        self.assertIsNone(lang_mod.effective_filter_lang(10))

    def test_no_guild_means_no_filter(self):
        self.assertIsNone(lang_mod.effective_filter_lang(None))


class LangSettingImplTest(StoreResetCase, unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        StoreResetCase.setUp(self)
        self.addCleanup(self.tmp.cleanup)
        import core.vc.globalvc.manage as manage_mod

        self.manage_mod = manage_mod
        self.store = FakeGuildStore()
        self._orig = manage_mod.guild_settings
        manage_mod.guild_settings = types.SimpleNamespace(
            get_store=lambda: self.store)

    def tearDown(self):
        self.manage_mod.guild_settings = self._orig

    def make_cog(self):
        from core.vc.globalvc.entry import GlobalVCCog

        cog = GlobalVCCog.__new__(GlobalVCCog)
        cog.bot = FakeBot({ADMIN_ID})
        return cog

    async def test_admin_sets_language(self):
        r = FakeResponder(111)
        await self.make_cog()._lang_setting_impl(r, "en")
        self.assertEqual(self.store.data[(10, "gvc")]["lang_filter"], "en")
        self.assertIn("English", str(r.sent[-1]))

    async def test_admin_sets_all_and_follow(self):
        cog = self.make_cog()
        await cog._lang_setting_impl(FakeResponder(111), "all")
        self.assertEqual(self.store.data[(10, "gvc")]["lang_filter"], "all")
        await cog._lang_setting_impl(FakeResponder(111), "")
        self.assertNotIn("lang_filter", self.store.data.get((10, "gvc"), {}))

    async def test_invalid_language_rejected(self):
        r = FakeResponder(111)
        await self.make_cog()._lang_setting_impl(r, "xx")
        self.assertEqual(self.store.updates, [])
        self.assertIn("いずれか", str(r.sent[-1]))

    async def test_non_admin_rejected(self):
        r = FakeResponder(111, manage_guild=False)
        await self.make_cog()._lang_setting_impl(r, "en")
        self.assertEqual(self.store.updates, [])


class CreateLanguageAndThemeTest(StoreResetCase, unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        StoreResetCase.setUp(self)
        self.addCleanup(self.tmp.cleanup)
        import core.vc.globalvc.manage as manage_mod

        self._orig_locale = manage_mod.server_locale
        manage_mod.server_locale = lambda guild_id: "en"
        self.addCleanup(setattr, manage_mod, "server_locale", self._orig_locale)

    def make_cog(self):
        from core.vc.globalvc.entry import GlobalVCCog

        cog = GlobalVCCog.__new__(GlobalVCCog)
        cog.bot = FakeBot({ADMIN_ID})
        return cog

    async def test_create_stamps_server_language(self):
        r = FakeResponder(111)
        await self.make_cog()._room_create_impl(r, "部屋", 0, "", "")
        self.assertEqual(rooms_mod.ROOMS["部屋"].language, "en")

    async def test_permanent_theme_none(self):
        r = FakeResponder(ADMIN_ID)
        await self.make_cog()._room_create_impl(
            r, "常設なし", 0, "", "", theme="なし", permanent=True)
        room = rooms_mod.ROOMS["常設なし"]
        self.assertEqual((room.theme, room.theme_auto), ("", False))

    async def test_permanent_theme_auto_word(self):
        r = FakeResponder(ADMIN_ID)
        await self.make_cog()._room_create_impl(
            r, "常設自動", 0, "", "", theme="自動", permanent=True)
        room = rooms_mod.ROOMS["常設自動"]
        self.assertTrue(room.theme_auto)
        self.assertTrue(room.theme)

    async def test_permanent_theme_default_is_auto(self):
        r = FakeResponder(ADMIN_ID)
        await self.make_cog()._room_create_impl(
            r, "常設省略", 0, "", "", permanent=True)
        self.assertTrue(rooms_mod.ROOMS["常設省略"].theme_auto)

    async def test_normal_room_theme_none_word(self):
        r = FakeResponder(111)
        await self.make_cog()._room_create_impl(r, "通常なし", 0, "", "", theme="なし")
        room = rooms_mod.ROOMS["通常なし"]
        self.assertEqual((room.theme, room.theme_auto), ("", False))


def collect_texts(item, out):
    content = getattr(item, "content", None)
    if isinstance(content, str):
        out.append(content)
    for child in getattr(item, "children", None) or []:
        collect_texts(child, out)


class ListFilterViewTest(StoreResetCase):
    def setUp(self):
        StoreResetCase.setUp(self)
        self.addCleanup(self.tmp.cleanup)
        import core.vc.globalvc.ui as ui_mod

        self._orig = ui_mod.effective_filter_lang
        self.addCleanup(setattr, ui_mod, "effective_filter_lang", self._orig)
        ui_mod.effective_filter_lang = lambda guild_id: "en"
        rooms_mod.ROOMS["日本語ルーム"] = RoomConfig(
            name="日本語ルーム", owner_id=1, owner_guild_id=10, language="ja")
        rooms_mod.ROOMS["English room"] = RoomConfig(
            name="English room", owner_id=1, owner_guild_id=10, language="en")
        rooms_mod.ROOMS["無指定ルーム"] = RoomConfig(
            name="無指定ルーム", owner_id=1, owner_guild_id=10)

    def test_list_shows_only_matching_and_unset(self):
        from core.vc.globalvc.ui import GlobalRoomListView

        view = GlobalRoomListView(types.SimpleNamespace(), 10)
        texts = []
        for item in view.children:
            collect_texts(item, texts)
        joined = "\n".join(texts)
        self.assertIn("English room", joined)
        self.assertIn("無指定ルーム", joined)
        self.assertNotIn("日本語ルーム", joined)


if __name__ == "__main__":
    unittest.main()
