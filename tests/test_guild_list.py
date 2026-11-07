"""!guild（導入サーバー一覧）のテスト。"""

import sys
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import asyncio  # noqa: E402
from unittest.mock import AsyncMock  # noqa: E402

from cogs.support import ALLOWED_USER_IDS, TerminalCog as Terminal, guild_list_messages  # noqa: E402


def g(i, name, n):
    return types.SimpleNamespace(id=i, name=name, member_count=n)


class GuildListTest(unittest.TestCase):
    def test_sorted_by_members(self):
        out = guild_list_messages([g(1, "小", 3), g(2, "大", 50)])
        self.assertEqual(len(out), 1)
        self.assertIn("2 件", out[0])
        self.assertLess(out[0].index("大"), out[0].index("小"))

    def test_split_under_limit(self):
        out = guild_list_messages([g(i, "サーバー" * 20, 1) for i in range(100)])
        self.assertGreater(len(out), 1)
        self.assertTrue(all(len(c) <= 1900 for c in out))
        self.assertEqual(sum(c.count("ID ") for c in out), 100)


class GuildCommandTest(unittest.TestCase):
    def run_cmd(self, author_id):
        bot = types.SimpleNamespace(guilds=[g(1, "テスト", 5)])
        cog = Terminal.__new__(Terminal)
        cog.bot = bot
        ctx = types.SimpleNamespace(author=types.SimpleNamespace(id=author_id), send=AsyncMock())
        asyncio.run(Terminal.guild_list.callback(cog, ctx))
        return ctx.send

    def test_allowed_user_gets_reply(self):
        send = self.run_cmd(next(iter(ALLOWED_USER_IDS)))
        send.assert_awaited()
        self.assertIn("テスト", send.await_args.args[0])

    def test_other_user_gets_nothing(self):
        send = self.run_cmd(1)
        send.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
