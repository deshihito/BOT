# -*- coding: utf-8 -*-
"""boardNotify RTA 記録表示の連携広告枠（core/ads.py）のテスト。

- クリエイティブのローテーション（一巡してラップ、空リストでは出ない）
- 広告枠は強制表示：ギルド別 ON/OFF の仕組みは撤去済みで、旧設定値
  （guild_settings の boardnotify.ads_enabled）が残っていても
  bump 記録 embed / 即抜け記録 embed の両方に常時枠が付くこと
- boardNotify 共通設定パネルに広告枠のトグルボタンが無いこと
Discord / DB には接続しない。
"""

import itertools
import os
import sys
import types
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import AsyncMock

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

for _name, _value in {'BOT_API_BASE_URL': 'http://127.0.0.1:8787', 'BOT_API_KEY': 'dummy-key'}.items():
    os.environ.setdefault(_name, _value)

import cogs.support  # noqa: E402,F401  （support 系の import 順を既存テストに合わせる）
from core import ads  # noqa: E402
from core.support import guild_settings as gs_module  # noqa: E402
from core.support.panel import BumpRtaSettingsView  # noqa: E402
from tests.test_bump_rta_record_ranks import (  # noqa: E402
    FakeDb, make_cog, make_message, seed_pending, sent_embed,
)
from tests.test_sokunuke_rta_improvements import FakeStore, use_store  # noqa: E402
from core.game.sokunuke_rta.cog import SokuNukeRta  # noqa: E402

T0 = datetime(2026, 11, 1, 0, 0, 0, tzinfo=timezone.utc)

# 旧仕様の OFF 設定が保存済みの状態を再現するためのセクション／キー名。
LEGACY_SECTION = "boardnotify"
LEGACY_KEY = "ads_enabled"


class AdsFakeStore:
    """GuildSettings の最小再現（旧広告枠設定が残った状態を作る用）。"""

    def __init__(self, by_guild=None):
        self._by_guild = {str(k): dict(v) for k, v in (by_guild or {}).items()}

    async def ensure_loaded(self):
        return None

    def get(self, guild_id, section):
        return self._by_guild.get(str(guild_id), {}).get(section, {})

    async def update(self, guild_id, section, **values):
        guild = self._by_guild.setdefault(str(guild_id), {})
        current = guild.setdefault(section, {})
        current.update(values)
        return current

    def section(self, guild_id, section=LEGACY_SECTION):
        return self._by_guild.get(str(guild_id), {}).get(section, {})


def use_ads_store(case, store):
    old = gs_module.get_store
    gs_module.get_store = lambda: store
    case.addCleanup(setattr, gs_module, "get_store", old)
    return store


def ad_fields(embed):
    return [f for f in (embed.fields or []) if f.name == ads.FIELD_NAME]


class CreativeRotationTest(unittest.TestCase):
    def setUp(self):
        self._old_counter = ads._counter
        ads._counter = itertools.count()
        self.addCleanup(setattr, ads, "_counter", self._old_counter)

    def test_rotation_covers_all_and_wraps(self):
        picks = [ads.pick_creative() for _ in range(len(ads.CREATIVES))]
        self.assertEqual(picks, list(ads.CREATIVES))
        self.assertIs(ads.pick_creative(), ads.CREATIVES[0])

    def test_house_creatives_have_url_and_text(self):
        urls = {c.url for c in ads.CREATIVES}
        self.assertIn("https://oneprompter.agobot.app", urls)
        self.assertIn("https://discord.gg/dCAQzJUaa9", urls)
        self.assertIn("https://agobot.app", urls)
        for creative in ads.CREATIVES:
            self.assertTrue(creative.text)
            self.assertTrue(creative.name)

    def test_empty_creatives_yield_no_field(self):
        old = ads.CREATIVES
        ads.CREATIVES = []
        self.addCleanup(setattr, ads, "CREATIVES", old)
        self.assertIsNone(ads.pick_creative())
        self.assertIsNone(ads.next_ad_field())

    def test_ad_field_is_clickable_link(self):
        field = ads.ad_field(ads.CREATIVES[0])
        self.assertEqual(field[0], "連携")
        self.assertEqual(field[1], f"[{ads.CREATIVES[0].text}]({ads.CREATIVES[0].url})")


class ForcedDisplayApiTest(unittest.TestCase):
    def test_no_per_guild_toggle_api_remains(self):
        # 強制表示：ON/OFF の読み書き API は撤去されている。
        self.assertFalse(hasattr(ads, "ads_enabled"))
        self.assertFalse(hasattr(ads, "set_ads_enabled"))


class BumpRecordAdTest(unittest.IsolatedAsyncioTestCase):
    async def record(self, cog, db):
        seed_pending(db, bump_at=T0, message_id="111", user_id="321")
        await cog._record_rta_event(
            make_message(), "bump", 321, T0 + timedelta(seconds=90))

    async def test_record_embed_has_ad_field_by_default(self):
        use_ads_store(self, AdsFakeStore())
        db = FakeDb()
        cog = make_cog(db)
        await self.record(cog, db)
        fields = ad_fields(sent_embed(cog))
        self.assertEqual(len(fields), 1)
        self.assertIn("](", fields[0].value)
        self.assertIn("http", fields[0].value)

    async def test_record_embed_has_ad_field_even_with_legacy_off_setting(self):
        # 旧仕様の OFF 設定が保存済みでも、強制表示で枠は出る。
        use_ads_store(self, AdsFakeStore(
            {"456": {LEGACY_SECTION: {LEGACY_KEY: False}}}))
        db = FakeDb()
        cog = make_cog(db)
        await self.record(cog, db)
        self.assertEqual(len(ad_fields(sent_embed(cog))), 1)


class SokunukeRecordAdTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        joined = (datetime.now(timezone.utc) - timedelta(seconds=300)).isoformat()
        self.store = use_store(self, FakeStore({
            "1": {"sokunuke_rta": {
                "joins": {"2": joined},
                "records": [{"user_id": "3", "elapsed": 100.0}],
            }},
        }))
        self.channel = types.SimpleNamespace(send=AsyncMock())
        guild = types.SimpleNamespace(id=1, system_channel=self.channel)
        self.member = types.SimpleNamespace(
            id=2, bot=False, guild=guild, display_name="ぬけお", name="nukeo")

    async def test_announce_has_ad_field_by_default(self):
        cog = SokuNukeRta(types.SimpleNamespace())
        await cog.on_member_remove(self.member)
        embed = self.channel.send.await_args.kwargs["embed"]
        self.assertEqual(len(ad_fields(embed)), 1)

    async def test_announce_has_ad_field_even_with_legacy_off_setting(self):
        # 旧仕様の OFF 設定が保存済みでも、強制表示で枠は出る。
        self.store._by_guild.setdefault("1", {})[LEGACY_SECTION] = {LEGACY_KEY: False}
        cog = SokuNukeRta(types.SimpleNamespace())
        await cog.on_member_remove(self.member)
        embed = self.channel.send.await_args.kwargs["embed"]
        self.assertEqual(len(ad_fields(embed)), 1)


class SettingsPanelTest(unittest.TestCase):
    def test_view_has_no_ads_toggle_button(self):
        self.assertFalse(hasattr(BumpRtaSettingsView, "ads_button"))
        view = BumpRtaSettingsView(None)
        custom_ids = [getattr(child, "custom_id", None) for child in view.children]
        self.assertNotIn("support:bumprta_settings:ads", custom_ids)

    def test_view_has_no_ads_state(self):
        view = BumpRtaSettingsView(None)
        self.assertFalse(hasattr(view, "ads_on"))


if __name__ == "__main__":
    unittest.main()
