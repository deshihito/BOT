"""! に移した持ち主専用コマンド（!d1ping・!check_api）のテスト。"""

import asyncio
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from core.general.d1_test import cog as d1_test  # noqa: E402
from core.support.stat import cog as stat  # noqa: E402
from cogs.support import ALLOWED_USER_IDS  # noqa: E402

OWNER = next(iter(ALLOWED_USER_IDS))


def ctx(author_id):
    return types.SimpleNamespace(author=types.SimpleNamespace(id=author_id), send=AsyncMock())


class AdminPrefixTest(unittest.TestCase):
    def run_cmd(self, command, cog, author_id):
        c = ctx(author_id)
        asyncio.run(command.callback(cog, c))
        return c

    def test_check_api(self):
        cog = stat.SystemInfoCog(None)
        self.assertTrue(self.run_cmd(stat.SystemInfoCog.check_api, cog, OWNER).send.await_count)
        self.assertFalse(self.run_cmd(stat.SystemInfoCog.check_api, cog, 1).send.await_count)

    def test_d1ping(self):
        cog = d1_test.D1TestCog.__new__(d1_test.D1TestCog)
        cog._test_response = AsyncMock(return_value=(True, 1.0))
        self.assertIn('稼働中', self.run_cmd(d1_test.D1TestCog.d1ping, cog, OWNER).send.await_args.args[0])
        other = self.run_cmd(d1_test.D1TestCog.d1ping, cog, 1)
        self.assertFalse(other.send.await_count)



if __name__ == '__main__':
    unittest.main()
