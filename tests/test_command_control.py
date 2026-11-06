"""BOT fixer ①: AGOコマンド制限（core/command_control.py）のテスト。

- 設定の保存/読込と既定（未設定では制限なし）
- 判定ロジック（deny / allow / 管理者バイパス / 設定アクション自身の除外 / レート窓）
- guard の分離（制限通知を送って止める・既定では何もしない）
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

from core import command_control, guild_settings  # noqa: E402
from core.command_control import (  # noqa: E402
    COMMAND_CONTROL_SECTION,
    RateCounter,
    check,
    get_settings,
    guard,
    is_manager,
    mode_blocks,
    normalize_settings,
)


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


def fake_user(user_id=7, *, administrator=False, manage_guild=False):
    return types.SimpleNamespace(
        id=user_id,
        guild_permissions=types.SimpleNamespace(
            administrator=administrator, manage_guild=manage_guild),
    )


class SettingsTest(unittest.IsolatedAsyncioTestCase):
    async def test_defaults_when_unset(self):
        store = make_store()
        self.assertEqual(get_settings(store, 42),
                         {"mode": "off", "actions": [], "rates": {}})

    async def test_save_and_load_roundtrip(self):
        store = make_store()
        await store.update(42, COMMAND_CONTROL_SECTION, mode="deny",
                           actions=["general:pay"],
                           rates={"vc:join": {"count": 3, "window_seconds": 600}})
        loaded = get_settings(store, 42)
        self.assertEqual(loaded["mode"], "deny")
        self.assertEqual(loaded["actions"], ["general:pay"])
        self.assertEqual(loaded["rates"], {"vc:join": {"count": 3, "window_seconds": 600}})

    def test_normalize_drops_self_and_broken_values(self):
        cleaned = normalize_settings({
            "mode": "weird",
            "actions": ["support:bot_fixer", "general:pay", "general:pay", 12],
            "rates": {"support:bot_fixer": {"count": 1, "window_seconds": 60},
                      "general:pay": {"count": 0, "window_seconds": 60},
                      "vc:join": {"count": 2, "window_seconds": 120}},
        })
        self.assertEqual(cleaned["mode"], "off")
        self.assertEqual(cleaned["actions"], ["general:pay"])
        self.assertEqual(cleaned["rates"], {"vc:join": {"count": 2, "window_seconds": 120}})


class ModeTest(unittest.TestCase):
    def test_deny_blocks_only_listed(self):
        s = {"mode": "deny", "actions": ["general:pay"], "rates": {}}
        self.assertTrue(mode_blocks(s, "general:pay"))
        self.assertFalse(mode_blocks(s, "general:status"))

    def test_allow_blocks_unlisted(self):
        s = {"mode": "allow", "actions": ["general:status"], "rates": {}}
        self.assertFalse(mode_blocks(s, "general:status"))
        self.assertTrue(mode_blocks(s, "general:pay"))

    def test_off_blocks_nothing(self):
        s = {"mode": "off", "actions": ["general:pay"], "rates": {}}
        self.assertFalse(mode_blocks(s, "general:pay"))

    def test_self_action_never_blocked(self):
        for mode in ("deny", "allow"):
            s = {"mode": mode, "actions": [], "rates": {}}
            self.assertFalse(mode_blocks(s, "support:bot_fixer"))


class CheckTest(unittest.TestCase):
    def test_manager_bypasses_everything(self):
        s = {"mode": "allow", "actions": [], "rates": {"general:pay": {"count": 1, "window_seconds": 60}}}
        counter = RateCounter(clock=lambda: 100.0)
        verdict = check(s, "general:pay", guild_id=1, user_id=2, manager=True, counter=counter)
        self.assertTrue(verdict.allowed)
        # 管理者はレートも消費しない
        verdict = check(s, "general:pay", guild_id=1, user_id=2, manager=False, counter=counter)
        self.assertFalse(verdict.allowed)  # allow モードで未登録なので制限（レート以前）

    def test_is_manager(self):
        self.assertTrue(is_manager(fake_user(administrator=True)))
        self.assertTrue(is_manager(fake_user(manage_guild=True)))
        self.assertFalse(is_manager(fake_user()))

    def test_rate_window(self):
        s = {"mode": "off", "actions": [], "rates": {"general:status": {"count": 2, "window_seconds": 60}}}
        counter = RateCounter(clock=lambda: 0.0)
        kw = dict(guild_id=1, user_id=2, manager=False, counter=counter)
        self.assertTrue(check(s, "general:status", now=1000.0, **kw).allowed)
        self.assertTrue(check(s, "general:status", now=1010.0, **kw).allowed)
        verdict = check(s, "general:status", now=1020.0, **kw)
        self.assertFalse(verdict.allowed)
        self.assertEqual(verdict.reason, "rate")
        self.assertAlmostEqual(verdict.retry_after, 40.0)
        # 窓が過ぎればまた通る（超過分は記録されていない）
        self.assertTrue(check(s, "general:status", now=1061.0, **kw).allowed)

    def test_rate_is_per_user_and_action(self):
        s = {"mode": "off", "actions": [], "rates": {"general:status": {"count": 1, "window_seconds": 60}}}
        counter = RateCounter(clock=lambda: 0.0)
        self.assertTrue(check(s, "general:status", guild_id=1, user_id=2,
                              manager=False, counter=counter, now=0.0).allowed)
        self.assertTrue(check(s, "general:status", guild_id=1, user_id=3,
                              manager=False, counter=counter, now=1.0).allowed)
        self.assertTrue(check(s, "general:exp_status", guild_id=1, user_id=2,
                              manager=False, counter=counter, now=1.0).allowed)

    def test_mode_block_does_not_consume_rate(self):
        s = {"mode": "deny", "actions": ["general:pay"],
             "rates": {"general:pay": {"count": 1, "window_seconds": 60}}}
        counter = RateCounter(clock=lambda: 0.0)
        verdict = check(s, "general:pay", guild_id=1, user_id=2,
                        manager=False, counter=counter, now=0.0)
        self.assertEqual(verdict.reason, "restricted")
        # レート側に記録が残っていないこと
        s2 = {"mode": "off", "actions": [], "rates": s["rates"]}
        self.assertTrue(check(s2, "general:pay", guild_id=1, user_id=2,
                              manager=False, counter=counter, now=1.0).allowed)


class FakeResponse:
    def __init__(self):
        self.sent = []

    def is_done(self):
        return False

    async def send_message(self, message, ephemeral=False):
        self.sent.append((message, ephemeral))


class FakeInteraction:
    def __init__(self, guild_id=42, user=None):
        self.guild_id = guild_id
        self.user = user or fake_user()
        self.response = FakeResponse()


class GuardTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.store = make_store()
        guild_settings.set_store(self.store)

    async def asyncTearDown(self):
        guild_settings.set_store(None)

    async def test_default_allows_without_message(self):
        interaction = FakeInteraction()
        self.assertTrue(await guard(interaction, "general:pay"))
        self.assertEqual(interaction.response.sent, [])

    async def test_deny_blocks_with_message(self):
        await self.store.update(42, COMMAND_CONTROL_SECTION, mode="deny",
                                actions=["general:pay"], rates={})
        interaction = FakeInteraction()
        self.assertFalse(await guard(interaction, "general:pay"))
        self.assertEqual(len(interaction.response.sent), 1)
        self.assertIn("制限しています", interaction.response.sent[0][0])
        self.assertTrue(interaction.response.sent[0][1])  # ephemeral

    async def test_manager_not_blocked(self):
        await self.store.update(42, COMMAND_CONTROL_SECTION, mode="deny",
                                actions=["general:pay"], rates={})
        interaction = FakeInteraction(user=fake_user(manage_guild=True))
        self.assertTrue(await guard(interaction, "general:pay"))
        self.assertEqual(interaction.response.sent, [])

    async def test_dm_allows(self):
        interaction = FakeInteraction(guild_id=None)
        self.assertTrue(await guard(interaction, "general:pay"))


class PanelTest(unittest.TestCase):
    def test_panel_builds_and_picker_excludes_self(self):
        from core.support.bot_fixer import BotFixerPanel, _actions_of_root

        panel = BotFixerPanel(None, {"mode": "off", "actions": [], "rates": {}})
        self.assertEqual(panel.area, "command")
        values = [spec.id for spec in _actions_of_root("support")]
        self.assertNotIn("support:bot_fixer", values)
        self.assertIn("support:clear", values)
        # game ルートは25件を超えるのでページング前提の一覧が返る
        self.assertGreater(len(_actions_of_root("game")), 25)


class RegistryTest(unittest.TestCase):
    def test_bot_fixer_registered_in_moderation_and_ai_excluded(self):
        from core import action_registry

        registry = action_registry.default_registry()
        spec = registry.get("support:bot_fixer")
        self.assertIsNotNone(spec)
        self.assertEqual(spec.label, "BOT fixer")
        self.assertEqual(spec.genre, "moderation")
        self.assertNotIn("aitools", spec.surfaces)


if __name__ == "__main__":
    unittest.main()
