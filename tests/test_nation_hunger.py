"""/nation の空腹の減少・オフのサーバー・コイン画像のテスト。Discord・Supabase には接続しない。"""

import asyncio
import sys
import types
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from tests.test_nation import NationFakeDBAPI, NationTest  # noqa: E402

from cogs import nation as nation_module  # noqa: E402


class AdjustFake(NationFakeDBAPI):
    """nation_adjust を、空腹だけ減らす形で再現する。"""

    def rpc(self, name, params=None, **kwargs):
        if name != "nation_adjust":
            return super().rpc(name, params, **kwargs)
        self.rpc_calls.append((name, params))
        rows = [r for r in self.tables.get("nation_players", []) if r["user_id"] == params["p_user_id"]]

        class Q:
            def execute(_self):
                if not rows:
                    raise Exception("player not found")
                r = rows[0]
                if r["hunger"] + params["p_hunger_delta"] < 0:
                    raise Exception("insufficient hunger")
                r["hunger"] += params["p_hunger_delta"]
                return types.SimpleNamespace(data=[{"balance": 0, "hunger": r["hunger"]}])
        return Q()


def msg(user_id=111, guild_id=999, bot=False):
    return types.SimpleNamespace(author=types.SimpleNamespace(id=user_id, bot=bot),
                                 guild=types.SimpleNamespace(id=guild_id))


class HungerTest(unittest.TestCase):
    call = NationTest.call

    def setUp(self):
        NationTest.setUp(self)
        self.db = AdjustFake()
        self.bot.db_api = self.db
        self.cog = nation_module.NationCog(self.bot)
        self.db.tables.setdefault("nation_players", []).append(
            {"user_id": "111", "guild_id": "999", "role": "citizen", "hunger": 2})

    def hunger(self):
        return self.db.tables["nation_players"][0]["hunger"]

    def test_message_drains_once_per_interval(self):
        asyncio.run(self.cog.on_message(msg()))
        asyncio.run(self.cog.on_message(msg()))
        self.assertEqual(self.hunger(), 1)
        with mock.patch.object(nation_module.time, "monotonic", return_value=10**9):
            asyncio.run(self.cog.on_message(msg()))
        self.assertEqual(self.hunger(), 0)

    def test_stops_at_zero_and_ignores_non_players(self):
        self.db.tables["nation_players"][0]["hunger"] = 0
        asyncio.run(self.cog.on_message(msg()))
        asyncio.run(self.cog.on_message(msg(user_id=222)))
        self.assertEqual(self.hunger(), 0)

    def test_bots_and_disabled_servers_skip(self):
        asyncio.run(self.cog.on_message(msg(bot=True)))
        with mock.patch.object(nation_module, "nation_settings", return_value={"enabled": False}):
            asyncio.run(self.cog.on_message(msg()))
        self.assertEqual(self.hunger(), 2)
        self.assertEqual(self.db.rpc_calls, [])

    def test_disabled_server_refuses_found_and_join(self):
        with mock.patch.object(nation_module, "nation_settings", return_value={"enabled": False}):
            for name in ("found", "join"):
                sent = self.call(name)
                self.assertIn("参加しない設定", sent[0]["embed"].description)
        self.assertEqual([c for c in self.db.rpc_calls if c[0] == "nation_found"], [])


if __name__ == "__main__":
    unittest.main()
