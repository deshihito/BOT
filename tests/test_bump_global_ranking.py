# -*- coding: utf-8 -*-
"""bump/up RTA 全サーバーランキングの表示導線のテスト。Discord には接続しない。

- core/general/common.py: rta ジャンルに全サーバー系4件が並ぶ
- core/general/entry.py: dispatch_general が wallet.leaderboard へ
  (category, scope, slowest) を正しく渡す（既存の local 系も含む）
"""

import os
import sys
import types
import unittest
from pathlib import Path
from unittest import mock
from unittest.mock import AsyncMock

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

for _name, _value in {'BOT_API_BASE_URL': 'http://127.0.0.1:8787', 'BOT_API_KEY': 'dummy-key'}.items():
    os.environ.setdefault(_name, _value)


class RtaGenreActionsTest(unittest.TestCase):
    def test_global_actions_in_rta_genre(self):
        from core.general.common import GENERAL_ACTIONS

        values = [v for _label, v in GENERAL_ACTIONS["rta"]]
        for value in ("bump_global_leaderboard", "up_global_leaderboard",
                      "bump_global_slowest", "up_global_slowest"):
            self.assertIn(value, values)

    def test_global_actions_registered(self):
        from core.general import action_registry

        registry = action_registry.default_registry()
        for value in ("bump_global_leaderboard", "up_global_leaderboard",
                      "bump_global_slowest", "up_global_slowest"):
            spec = registry.get(f"general:{value}")
            self.assertIsNotNone(spec, value)
            self.assertEqual(spec.genre, "rta", value)


class GlobalDispatchTest(unittest.IsolatedAsyncioTestCase):
    def make_cog_and_interaction(self, wallet):
        from cogs.general import GeneralCog

        cog = GeneralCog.__new__(GeneralCog)
        cog.bot = types.SimpleNamespace(
            get_cog=lambda name: wallet if name == "WalletCog" else None)
        interaction = types.SimpleNamespace(
            guild_id=123, guild=None,
            user=types.SimpleNamespace(id=456),
            response=types.SimpleNamespace(
                is_done=lambda: False,
                send_message=AsyncMock(),
                defer=AsyncMock(),
            ),
            followup=types.SimpleNamespace(send=AsyncMock()),
        )
        return cog, interaction

    async def dispatch(self, value):
        from core.general import action_usage
        from core.support import command_control

        wallet = types.SimpleNamespace(
            leaderboard=AsyncMock(), user_status=AsyncMock())
        cog, interaction = self.make_cog_and_interaction(wallet)
        with mock.patch.object(command_control, "guard", new=AsyncMock(return_value=True)), \
                mock.patch.object(action_usage, "record_safely_in_background", lambda *a: None):
            await cog.dispatch_general(interaction, value)
        return wallet

    async def test_local_fastest_unchanged(self):
        wallet = await self.dispatch("bump_leaderboard")
        args, kwargs = wallet.leaderboard.await_args
        self.assertEqual(args[1].value, "bump")
        self.assertIsNone(args[2])
        self.assertFalse(kwargs["slowest"])

    async def test_local_slowest_unchanged(self):
        wallet = await self.dispatch("up_slowest")
        args, kwargs = wallet.leaderboard.await_args
        self.assertEqual(args[1].value, "up")
        self.assertIsNone(args[2])
        self.assertTrue(kwargs["slowest"])

    async def test_global_fastest(self):
        for value, event in (("bump_global_leaderboard", "bump"),
                             ("up_global_leaderboard", "up")):
            wallet = await self.dispatch(value)
            args, kwargs = wallet.leaderboard.await_args
            self.assertEqual(args[1].value, event, value)
            self.assertEqual(args[2].value, "global", value)
            self.assertFalse(kwargs["slowest"], value)

    async def test_global_slowest(self):
        for value, event in (("bump_global_slowest", "bump"),
                             ("up_global_slowest", "up")):
            wallet = await self.dispatch(value)
            args, kwargs = wallet.leaderboard.await_args
            self.assertEqual(args[1].value, event, value)
            self.assertEqual(args[2].value, "global", value)
            self.assertTrue(kwargs["slowest"], value)


if __name__ == "__main__":
    unittest.main()
