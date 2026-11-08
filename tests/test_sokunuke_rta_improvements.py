# -*- coding: utf-8 -*-
"""即抜けRTA改善のテスト（2026-11-08）。Discord には接続しない。

- 記録時の embed 通知（名前・記録・順位、プレーン名、システムチャンネル宛）
- 状態確認から VC自動参加 の項目が消えていること
- ボードの最速/最遅切替（build_board / SokunukeBoardView）
"""

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

import discord  # noqa: E402
from discord import app_commands  # noqa: E402

from core.game.sokunuke_rta import cog as sokunuke_mod  # noqa: E402
from core.game.sokunuke_rta.cog import (  # noqa: E402
    SokuNukeRta, SokunukeBoardView, _global_worst_records, _rank_of,
)

SECTION = sokunuke_mod.SECTION


class FakeStore:
    """GuildSettings の最小再現（get / all_sections / update）。"""

    def __init__(self, by_guild=None):
        self._by_guild = {str(k): dict(v) for k, v in (by_guild or {}).items()}

    async def ensure_loaded(self):
        return None

    def get(self, guild_id, section):
        return self._by_guild.get(str(guild_id), {}).get(section, {})

    def all_sections(self, section):
        return {gid: sections[section]
                for gid, sections in self._by_guild.items()
                if isinstance(sections.get(section), dict)}

    async def update(self, guild_id, section, **values):
        guild = self._by_guild.setdefault(str(guild_id), {})
        current = guild.setdefault(section, {})
        current.update(values)
        return current

    def section(self, guild_id):
        return self._by_guild.get(str(guild_id), {}).get(SECTION, {})


def use_store(case, store):
    old = sokunuke_mod.guild_settings.get_store
    sokunuke_mod.guild_settings.get_store = lambda: store
    case.addCleanup(setattr, sokunuke_mod.guild_settings, "get_store", old)
    return store


class RankHelpersTest(unittest.TestCase):
    def test_rank_of_fastest(self):
        rows = [{"elapsed": 10.0}, {"elapsed": 30.0}, {"elapsed": 60.0}]
        self.assertEqual(_rank_of(5.0, rows), 1)
        self.assertEqual(_rank_of(10.0, rows), 1)   # 同タイムは同じ順位
        self.assertEqual(_rank_of(30.0, rows), 2)
        self.assertEqual(_rank_of(90.0, rows), 4)
        self.assertEqual(_rank_of(1.0, []), 1)

    def test_rank_of_slowest(self):
        rows = [{"elapsed": 10.0}, {"elapsed": 30.0}, {"elapsed": 60.0}]
        self.assertEqual(_rank_of(90.0, rows, slowest=True), 1)
        self.assertEqual(_rank_of(60.0, rows, slowest=True), 1)
        self.assertEqual(_rank_of(30.0, rows, slowest=True), 2)
        self.assertEqual(_rank_of(5.0, rows, slowest=True), 4)

    def test_rank_of_skips_broken_rows(self):
        rows = [{"elapsed": "abc"}, {"elapsed": 10.0}, "junk", {}]
        self.assertEqual(_rank_of(20.0, rows), 2)

    def test_global_worst_records(self):
        all_settings = {
            "10": {"records": [
                {"user_id": "2", "elapsed": 30.0},
                {"user_id": "2", "elapsed": 300.0},
                {"user_id": "3", "elapsed": 10.0},
            ]},
            "20": {"records": [
                {"user_id": "2", "elapsed": 5.0},
                {"user_id": "4", "elapsed": 200.0},
                {"user_id": "5", "elapsed": "abc"},
                "junk",
            ]},
            "30": "not-a-dict",
        }
        rows = _global_worst_records(all_settings)
        self.assertEqual([(r["user_id"], r["elapsed"]) for r in rows],
                         [("2", 300.0), ("4", 200.0), ("3", 10.0)])
        self.assertEqual(_global_worst_records({}), [])
        self.assertEqual(_global_worst_records(None), [])


class AnnounceRecordTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        joined = (datetime.now(timezone.utc) - timedelta(seconds=300)).isoformat()
        self.store = use_store(self, FakeStore({
            "1": {SECTION: {
                "joins": {"2": joined},
                "records": [{"user_id": "3", "elapsed": 100.0},
                            {"user_id": "4", "elapsed": 900.0}],
            }},
            "9": {SECTION: {
                "records": [{"user_id": "5", "elapsed": 60.0}],
            }},
        }))
        self.channel = types.SimpleNamespace(send=AsyncMock())
        guild = types.SimpleNamespace(id=1, system_channel=self.channel)
        self.member = types.SimpleNamespace(
            id=2, bot=False, guild=guild, display_name="ぬけお", name="nukeo")

    async def test_record_announces_embed_with_ranks(self):
        cog = SokuNukeRta(types.SimpleNamespace())
        await cog.on_member_remove(self.member)
        # 記録が保存されている
        records = self.store.section(1)["records"]
        self.assertEqual(len(records), 3)
        self.assertEqual(records[-1]["user_id"], "2")
        # システムチャンネルへ embed が1件送られた
        self.channel.send.assert_awaited_once()
        kwargs = self.channel.send.await_args.kwargs
        embed = kwargs["embed"]
        self.assertIn("ぬけお", embed.description)
        self.assertIn("即抜け", embed.description)
        self.assertIn("0時間5分0秒", embed.description)
        # ローカル: 100秒の記録より後ろで2位 / 全体: 各ユーザーの最速
        # （60秒・100秒）より後ろに割り込む位置で3位
        self.assertIn("このサーバー **2位**", embed.description)
        self.assertIn("全サーバー **3位**", embed.description)
        # メンションは使わない（プレーン名＋AllowedMentions.none）
        self.assertNotIn("<@", embed.description)
        self.assertFalse(kwargs["allowed_mentions"].users)

    async def test_no_system_channel_still_records(self):
        self.member.guild.system_channel = None
        cog = SokuNukeRta(types.SimpleNamespace())
        await cog.on_member_remove(self.member)
        records = self.store.section(1)["records"]
        self.assertEqual(len(records), 3)
        self.channel.send.assert_not_awaited()

    async def test_measurement_disabled_records_nothing(self):
        self.store.section(1)["measurement_enabled"] = False
        cog = SokuNukeRta(types.SimpleNamespace())
        await cog.on_member_remove(self.member)
        self.assertEqual(len(self.store.section(1)["records"]), 2)
        self.channel.send.assert_not_awaited()


class StatusPanelTest(unittest.IsolatedAsyncioTestCase):
    async def test_status_shows_measurement_only(self):
        use_store(self, FakeStore({"1": {SECTION: {"vc_auto_join_enabled": True}}}))
        cog = SokuNukeRta(types.SimpleNamespace())
        interaction = types.SimpleNamespace(
            guild_id=1,
            response=types.SimpleNamespace(send_message=AsyncMock()))
        await cog.sokunuke_command(
            interaction, app_commands.Choice(name="状態", value="status"))
        kwargs = interaction.response.send_message.await_args.kwargs
        body = kwargs["view"]._body
        self.assertIn("計測: オン", body)
        self.assertNotIn("VC自動参加", body)


class SlowestBoardTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.store = use_store(self, FakeStore({
            "1": {SECTION: {"records": [
                {"user_id": "2", "elapsed": 30.0},
                {"user_id": "3", "elapsed": 300.0},
                {"user_id": "2", "elapsed": 120.0},
            ]}},
            "9": {SECTION: {"records": [
                {"user_id": "2", "elapsed": 600.0},
                {"user_id": "4", "elapsed": 45.0},
            ]}},
        }))
        self.cog = SokuNukeRta(types.SimpleNamespace())

    async def test_local_slowest_board(self):
        embed, png = await self.cog.build_board(1, 2, scope="local", slowest=True)
        self.assertIsNotNone(png)
        self.assertEqual(embed.title, "即抜けRTA最遅ランキング（このサーバー）")

    async def test_local_fastest_board_title_unchanged(self):
        embed, png = await self.cog.build_board(1, 2, scope="local")
        self.assertIsNotNone(png)
        self.assertEqual(embed.title, "即抜けRTAランキング（このサーバー）")

    async def test_global_slowest_uses_per_user_max(self):
        # _global_worst_records 経由: user2 の最遅は他サーバーの600秒
        embed, png = await self.cog.build_board(1, 2, scope="global", slowest=True)
        self.assertIsNotNone(png)
        self.assertEqual(embed.title, "即抜けRTA最遅ランキング（全サーバー）")

    async def test_me_slowest_lists_own_records_desc(self):
        embed, png = await self.cog.build_board(1, 2, scope="me", slowest=True)
        self.assertIsNone(png)
        self.assertEqual(embed.title, "即抜けRTA最遅ランキング（自分）")
        # 自分の記録は 120秒 → 30秒 の順（遅い順）
        self.assertLess(embed.description.index("2分0秒"),
                        embed.description.index("0分30秒"))

    async def test_me_fastest_lists_own_records_asc(self):
        embed, png = await self.cog.build_board(1, 2, scope="me")
        self.assertIsNone(png)
        self.assertLess(embed.description.index("0分30秒"),
                        embed.description.index("2分0秒"))


class BoardViewTest(unittest.IsolatedAsyncioTestCase):
    def make_view(self, **kwargs):
        embed = discord.Embed(title="ボード", description="x", color=0xFFFFFF)
        cog = types.SimpleNamespace(
            build_board=AsyncMock(return_value=(embed, None)))
        view = SokunukeBoardView(cog, 1, 2, **kwargs)
        return view, cog

    def test_buttons_match_unified_board_layout(self):
        view, _cog = self.make_view()
        labels = [child.label for child in view.children]
        self.assertEqual(labels, ["最速", "最遅", "このサーバー", "全サーバー", "自分"])
        styles = [child.style for child in view.children]
        self.assertEqual(styles[0], discord.ButtonStyle.primary)   # 最速が選択中
        self.assertEqual(styles[1], discord.ButtonStyle.secondary)
        self.assertEqual(styles[2], discord.ButtonStyle.primary)   # このサーバー

    async def test_scope_switch_reloads_as_pressing_user(self):
        view, cog = self.make_view()
        await view.load()
        interaction = types.SimpleNamespace(
            user=types.SimpleNamespace(id=9),
            response=types.SimpleNamespace(is_done=lambda: True),
            edit_original_response=AsyncMock())
        await view._make_scope("me")(interaction)
        self.assertEqual(view.scope, "me")
        self.assertEqual(view.user_id, 9)  # 押した人の記録に切り替わる
        kwargs = cog.build_board.await_args
        self.assertEqual(kwargs.args[1], 9)
        self.assertEqual(kwargs.kwargs["scope"], "me")

    async def test_speed_switch(self):
        view, cog = self.make_view()
        interaction = types.SimpleNamespace(
            user=types.SimpleNamespace(id=2),
            response=types.SimpleNamespace(is_done=lambda: True),
            edit_original_response=AsyncMock())
        await view._make_speed(True)(interaction)
        self.assertTrue(view.slowest)
        self.assertTrue(cog.build_board.await_args.kwargs["slowest"])


class SokunukeBoardDispatchTest(unittest.IsolatedAsyncioTestCase):
    """/general の sokunuke_board 導線（ランキング一覧ハブと同じ値）。"""

    async def test_dispatch_opens_board_view(self):
        from unittest import mock

        from cogs.general import GeneralCog
        from core.general import action_usage
        from core.support import command_control

        embed = discord.Embed(title="即抜けRTAランキング（このサーバー）",
                              color=0xFFFFFF)
        sokunuke = types.SimpleNamespace(
            build_board=AsyncMock(return_value=(embed, None)))
        cog = GeneralCog.__new__(GeneralCog)
        cog.bot = types.SimpleNamespace(
            get_cog=lambda name: sokunuke if name == "SokuNukeRta" else None)
        interaction = types.SimpleNamespace(
            guild_id=123, guild=None,
            user=types.SimpleNamespace(id=456, display_name="自分"),
            response=types.SimpleNamespace(
                is_done=lambda: False,
                send_message=AsyncMock(),
                defer=AsyncMock()),
            followup=types.SimpleNamespace(send=AsyncMock()))
        with mock.patch.object(command_control, "guard",
                               new=AsyncMock(return_value=True)), \
                mock.patch.object(action_usage, "record_safely_in_background",
                                  lambda *a: None):
            await cog.dispatch_general(interaction, "sokunuke_board")
        # 先にACK（defer）してからボードを送る（rta_board と同じ順序）
        interaction.response.defer.assert_awaited_once()
        kwargs = interaction.followup.send.await_args.kwargs
        view = kwargs["view"].panel
        self.assertIsInstance(view, SokunukeBoardView)
        self.assertEqual(view.scope, "local")
        self.assertFalse(view.slowest)
        args, bkwargs = sokunuke.build_board.await_args
        self.assertEqual(args, (123, 456))
        self.assertEqual(bkwargs, {"scope": "local", "slowest": False})


if __name__ == "__main__":
    unittest.main()
