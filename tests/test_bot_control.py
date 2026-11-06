"""BOT fixer ②: 他ボット発言制限（core/bot_control.py）のテスト。

- 設定の保存/読込と既定（未設定では何もしない）
- 判定ロジック（許可チャンネル外／レート窓／許可チャンネル空のエントリは成立しない）
- 執行の分離（AGO自身・Webhook・人間・DM は対象外、削除失敗でも例外を出さない）
Discord には接続しない。
"""
import os
import sys
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

for _name, _value in {"BOT_API_BASE_URL": "http://127.0.0.1:8787", "BOT_API_KEY": "dummy-key"}.items():
    os.environ.setdefault(_name, _value)

from core import bot_control, guild_settings  # noqa: E402
from core.bot_control import (  # noqa: E402
    BOT_CONTROL_SECTION,
    enforce_message,
    get_settings,
    normalize_settings,
    plan,
)
from core.command_control import RateCounter  # noqa: E402

SELF_ID = 1111
TARGET_ID = 2222


class FakeKV:
    def __init__(self):
        self.data = {}

    def load_local(self):
        return {}

    async def load_all(self):
        return self.data

    async def set(self, key, value, wait=True):
        self.data[key] = value

    async def delete(self, key, wait=True):
        self.data.pop(key, None)


def make_store():
    return guild_settings.GuildSettings(FakeKV())


class SettingsTest(unittest.IsolatedAsyncioTestCase):
    async def test_defaults_empty(self):
        store = make_store()
        self.assertEqual(get_settings(store, 42), {})

    async def test_save_and_load_roundtrip(self):
        store = make_store()
        await store.update(42, BOT_CONTROL_SECTION, **{
            str(TARGET_ID): {"allowed_channel_ids": [10, 20],
                             "rate": {"count": 3, "window_seconds": 600}},
        })
        loaded = get_settings(store, 42)
        self.assertEqual(loaded[str(TARGET_ID)]["allowed_channel_ids"], [10, 20])
        self.assertEqual(loaded[str(TARGET_ID)]["rate"],
                         {"count": 3, "window_seconds": 600})

    def test_entry_without_channels_is_dropped(self):
        cleaned = normalize_settings({
            str(TARGET_ID): {"allowed_channel_ids": [], "rate": None},
            "3333": {"allowed_channel_ids": [10], "rate": None},
        })
        self.assertNotIn(str(TARGET_ID), cleaned)
        self.assertIn("3333", cleaned)

    def test_broken_values_dropped(self):
        cleaned = normalize_settings({
            "not-a-number": {"allowed_channel_ids": [10]},
            str(TARGET_ID): {"allowed_channel_ids": ["20", "x", 20],
                             "rate": {"count": 0, "window_seconds": 60}},
        })
        self.assertEqual(list(cleaned), [str(TARGET_ID)])
        self.assertEqual(cleaned[str(TARGET_ID)]["allowed_channel_ids"], [20])
        self.assertIsNone(cleaned[str(TARGET_ID)]["rate"])


class PlanTest(unittest.TestCase):
    def setUp(self):
        self.settings = {str(TARGET_ID): {"allowed_channel_ids": [10],
                                          "rate": {"count": 2, "window_seconds": 60}}}

    def test_unregistered_bot_not_targeted(self):
        self.assertIsNone(plan(self.settings, guild_id=1, bot_id=9999, channel_id=99))

    def test_outside_allowed_channel(self):
        self.assertEqual(
            plan(self.settings, guild_id=1, bot_id=TARGET_ID, channel_id=99), "channel")

    def test_inside_allowed_channel_ok(self):
        counter = RateCounter(clock=lambda: 0.0)
        self.assertIsNone(plan(self.settings, guild_id=1, bot_id=TARGET_ID,
                               channel_id=10, counter=counter, now=0.0))

    def test_rate_window(self):
        counter = RateCounter(clock=lambda: 0.0)
        kw = dict(guild_id=1, bot_id=TARGET_ID, channel_id=10, counter=counter)
        self.assertIsNone(plan(self.settings, now=100.0, **kw))
        self.assertIsNone(plan(self.settings, now=110.0, **kw))
        self.assertEqual(plan(self.settings, now=120.0, **kw), "rate")
        self.assertIsNone(plan(self.settings, now=161.0, **kw))

    def test_channel_violation_does_not_consume_rate(self):
        counter = RateCounter(clock=lambda: 0.0)
        for t in (0.0, 1.0, 2.0):
            self.assertEqual(plan(self.settings, guild_id=1, bot_id=TARGET_ID,
                                  channel_id=99, counter=counter, now=t), "channel")
        self.assertIsNone(plan(self.settings, guild_id=1, bot_id=TARGET_ID,
                               channel_id=10, counter=counter, now=3.0))


class FakeMessage:
    def __init__(self, *, guild_id=42, channel_id=99, author_id=TARGET_ID,
                 author_bot=True, webhook_id=None, fail_delete=False):
        self.guild = types.SimpleNamespace(id=guild_id) if guild_id is not None else None
        self.channel = types.SimpleNamespace(id=channel_id)
        self.author = types.SimpleNamespace(id=author_id, bot=author_bot)
        self.webhook_id = webhook_id
        self.fail_delete = fail_delete
        self.deleted = False

    async def delete(self):
        if self.fail_delete:
            raise RuntimeError("no permission")
        self.deleted = True


class EnforceTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.store = make_store()
        await self.store.update(42, BOT_CONTROL_SECTION, **{
            str(TARGET_ID): {"allowed_channel_ids": [10], "rate": None},
        })

    async def test_deletes_outside_allowed_channel(self):
        message = FakeMessage(channel_id=99)
        self.assertTrue(await enforce_message(SELF_ID, message, store=self.store))
        self.assertTrue(message.deleted)

    async def test_keeps_inside_allowed_channel(self):
        message = FakeMessage(channel_id=10)
        self.assertFalse(await enforce_message(SELF_ID, message, store=self.store))
        self.assertFalse(message.deleted)

    async def test_self_bot_never_targeted(self):
        await self.store.update(42, BOT_CONTROL_SECTION, **{
            str(SELF_ID): {"allowed_channel_ids": [10], "rate": None},
        })
        message = FakeMessage(author_id=SELF_ID, channel_id=99)
        self.assertFalse(await enforce_message(SELF_ID, message, store=self.store))
        self.assertFalse(message.deleted)

    async def test_webhook_excluded(self):
        message = FakeMessage(channel_id=99, webhook_id=555)
        self.assertFalse(await enforce_message(SELF_ID, message, store=self.store))

    async def test_human_author_excluded(self):
        message = FakeMessage(channel_id=99, author_bot=False)
        self.assertFalse(await enforce_message(SELF_ID, message, store=self.store))

    async def test_dm_excluded(self):
        message = FakeMessage(guild_id=None, channel_id=99)
        self.assertFalse(await enforce_message(SELF_ID, message, store=self.store))

    async def test_delete_failure_does_not_raise(self):
        message = FakeMessage(channel_id=99, fail_delete=True)
        self.assertFalse(await enforce_message(SELF_ID, message, store=self.store))

    async def test_unconfigured_guild_untouched(self):
        message = FakeMessage(guild_id=777, channel_id=99)
        self.assertFalse(await enforce_message(SELF_ID, message, store=self.store))
        self.assertFalse(message.deleted)


class PanelTest(unittest.TestCase):
    def test_panel_builds_bot_area(self):
        from core.support.bot_fixer import BotFixerPanel

        bot_settings = {str(TARGET_ID): {"allowed_channel_ids": [10], "rate": None}}
        panel = BotFixerPanel(None, {"mode": "off", "actions": [], "rates": {}}, bot_settings)
        panel.area = "bot"
        panel._build()
        panel.bot_target = TARGET_ID
        panel._build()  # 対象選択後（チャンネル編集つき）も構築できる


if __name__ == "__main__":
    unittest.main()
