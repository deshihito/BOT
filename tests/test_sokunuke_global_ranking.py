# -*- coding: utf-8 -*-
"""即抜けRTAの全サーバー（グローバル）ランキングのテスト。Discord には接続しない。

- core/game/sokunuke_rta/cog.py: _global_best_records の集計（全サーバー横断・
  ユーザーごとの最速）と leaderboard(scope="global") の表示
- core/support/guild_settings.py: all_sections（全サーバー分の1セクション取得）
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

from core.game.sokunuke_rta import cog as sokunuke_mod  # noqa: E402
from core.game.sokunuke_rta.cog import SokuNukeRta, _global_best_records  # noqa: E402
from core.support.guild_settings import GuildSettings  # noqa: E402

SECTION = sokunuke_mod.SECTION


class GlobalBestRecordsTest(unittest.TestCase):
    def test_best_per_user_across_guilds(self):
        all_settings = {
            "10": {"records": [
                {"user_id": "2", "elapsed": 30.0},
                {"user_id": "3", "elapsed": 10.0},
            ]},
            "20": {"records": [
                {"user_id": "2", "elapsed": 5.0},
                {"user_id": "4", "elapsed": 20.0},
            ]},
        }
        rows = _global_best_records(all_settings)
        self.assertEqual([(r["user_id"], r["elapsed"]) for r in rows],
                         [("2", 5.0), ("3", 10.0), ("4", 20.0)])

    def test_broken_rows_are_skipped(self):
        all_settings = {
            "10": {"records": [
                {"user_id": "2", "elapsed": "abc"},
                {"elapsed": 1.0},
                "not-a-dict",
                {"user_id": "3", "elapsed": 7.5},
            ]},
            "20": "not-a-dict",
            "30": {},
        }
        rows = _global_best_records(all_settings)
        self.assertEqual([(r["user_id"], r["elapsed"]) for r in rows], [("3", 7.5)])
        self.assertEqual(_global_best_records({}), [])
        self.assertEqual(_global_best_records(None), [])


class AllSectionsTest(unittest.TestCase):
    def test_returns_only_matching_dict_sections_as_copies(self):
        class StubKV:
            def load_local(self):
                return {
                    "10": {SECTION: {"records": [1]}, "other": {"x": 1}},
                    "20": {SECTION: {"records": [2]}},
                    "30": {"other": {}},
                    "40": {SECTION: "not-a-dict"},
                }

        store = GuildSettings(kv=StubKV())
        result = store.all_sections(SECTION)
        self.assertEqual(set(result), {"10", "20"})
        result["10"]["records"].append(99)
        self.assertEqual(store.get(10, SECTION)["records"], [1])


class FakeStore:
    def __init__(self, by_guild):
        self._by_guild = by_guild  # {guild_id_str: section dict}

    async def ensure_loaded(self):
        return None

    def get(self, guild_id, section):
        return self._by_guild.get(str(guild_id), {})

    def all_sections(self, section):
        return dict(self._by_guild)


class GlobalLeaderboardTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.store = FakeStore({
            "1": {"records": [{"user_id": "2", "elapsed": 30.0}]},
            "9": {"records": [{"user_id": "2", "elapsed": 5.0},
                              {"user_id": "3", "elapsed": 12.0}]},
        })
        old = sokunuke_mod.guild_settings.get_store
        sokunuke_mod.guild_settings.get_store = lambda: self.store
        self.addCleanup(setattr, sokunuke_mod.guild_settings, "get_store", old)

    async def test_global_board_uses_all_guilds(self):
        followup = types.SimpleNamespace(send=AsyncMock())
        interaction = types.SimpleNamespace(
            guild_id=1, user=types.SimpleNamespace(id=2), followup=followup)
        await SokuNukeRta(types.SimpleNamespace()).leaderboard(interaction, scope="global")
        kwargs = followup.send.await_args.kwargs
        # ボードは切替View（V2）＋files で送る（boardNotify RTA と同方式）。
        self.assertEqual([f.filename for f in kwargs["files"]],
                         ["sokunuke_leaderboard.png"])
        embed = kwargs["view"].panel.embed()
        self.assertEqual(embed.title, "即抜けRTAランキング（全サーバー）")
        self.assertEqual(embed.image.url, "attachment://sokunuke_leaderboard.png")

    async def test_global_board_empty(self):
        self.store = FakeStore({"1": {"records": []}})
        followup = types.SimpleNamespace(send=AsyncMock())
        interaction = types.SimpleNamespace(
            guild_id=1, user=types.SimpleNamespace(id=2), followup=followup)
        await SokuNukeRta(types.SimpleNamespace()).leaderboard(interaction, scope="global")
        kwargs = followup.send.await_args.kwargs
        self.assertEqual(kwargs["files"], [])
        embed = kwargs["view"].panel.embed()
        self.assertEqual(embed.title, "即抜けRTAランキング（全サーバー）")
        self.assertIn("まだ記録がありません", embed.description)


if __name__ == "__main__":
    unittest.main()
