"""Tests for warning escalation (feature gap #6)."""
from __future__ import annotations

import datetime
import os
import sys
import tempfile
import types
import unittest
from unittest.mock import AsyncMock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from core import guild_settings
from core.storage import KVStore
from core.server_assist.features import warnings
from tests.fake_kv_supabase import FakeKVSupabase


def make_current(**overrides):
    current = {
        "escalation_enabled": True,
        "escalation_threshold": 3,
        "escalation_action": "timeout",
        "escalation_timeout_minutes": 60,
    }
    current.update(overrides)
    return current


class EscalationLogicTest(unittest.TestCase):
    def test_disabled_by_default(self):
        self.assertIsNone(warnings.escalation_action_for(3, {"escalation_enabled": False, "escalation_threshold": 3}))

    def test_triggers_on_multiples_of_threshold(self):
        current = make_current()
        self.assertIsNone(warnings.escalation_action_for(1, current))
        self.assertIsNone(warnings.escalation_action_for(2, current))
        self.assertEqual(warnings.escalation_action_for(3, current), "timeout")
        self.assertIsNone(warnings.escalation_action_for(4, current))
        self.assertEqual(warnings.escalation_action_for(6, current), "timeout")

    def test_kick_action(self):
        self.assertEqual(warnings.escalation_action_for(2, make_current(escalation_threshold=2, escalation_action="kick")), "kick")


class FakeMember:
    def __init__(self):
        self.timeout = AsyncMock()
        self.kick = AsyncMock()


class FakeGuild:
    def __init__(self, member, *, moderate=True, kick=True):
        self.id = 1
        self._member = member
        self.me = types.SimpleNamespace(
            guild_permissions=types.SimpleNamespace(moderate_members=moderate, kick_members=kick)
        )

    def get_member(self, user_id):
        return self._member


class ApplyEscalationTest(unittest.IsolatedAsyncioTestCase):
    async def test_timeout_applied(self):
        member = FakeMember()
        label = await warnings.apply_escalation(FakeGuild(member), 7, 3, make_current())
        self.assertEqual(label, "タイムアウト60分")
        member.timeout.assert_awaited_once()
        args, kwargs = member.timeout.await_args
        self.assertEqual(args[0], datetime.timedelta(minutes=60))

    async def test_kick_applied(self):
        member = FakeMember()
        label = await warnings.apply_escalation(
            FakeGuild(member), 7, 2, make_current(escalation_threshold=2, escalation_action="kick")
        )
        self.assertEqual(label, "キック")
        member.kick.assert_awaited_once()

    async def test_no_permission_no_action(self):
        member = FakeMember()
        label = await warnings.apply_escalation(FakeGuild(member, moderate=False), 7, 3, make_current())
        self.assertIsNone(label)
        member.timeout.assert_not_awaited()

    async def test_below_threshold_no_action(self):
        member = FakeMember()
        label = await warnings.apply_escalation(FakeGuild(member), 7, 2, make_current())
        self.assertIsNone(label)


class EscalationSettingsTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = guild_settings.GuildSettings(
            KVStore("guild_settings", client=FakeKVSupabase(), path=os.path.join(self.tmp.name, "bot_kv.json"))
        )
        guild_settings.set_store(self.store)
        self.addCleanup(guild_settings.set_store, None)

    def test_defaults_disabled(self):
        current = warnings.settings(1)
        self.assertFalse(current["escalation_enabled"])
        self.assertEqual(current["escalation_threshold"], 3)
        self.assertEqual(current["escalation_action"], "timeout")
        self.assertEqual(current["escalation_timeout_minutes"], 60)

    async def test_round_trip_and_validation(self):
        await warnings.update_settings(
            1, warnings.KEY,
            escalation_enabled=True, escalation_threshold=5,
            escalation_action="kick", escalation_timeout_minutes=10,
        )
        current = warnings.settings(1)
        self.assertTrue(current["escalation_enabled"])
        self.assertEqual(current["escalation_threshold"], 5)
        self.assertEqual(current["escalation_action"], "kick")
        await warnings.update_settings(1, warnings.KEY, escalation_threshold=7, escalation_action="ban")
        current = warnings.settings(1)
        self.assertEqual(current["escalation_threshold"], 3)
        self.assertEqual(current["escalation_action"], "timeout")


if __name__ == "__main__":
    unittest.main()
