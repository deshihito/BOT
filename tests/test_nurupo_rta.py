# -*- coding: utf-8 -*-
"""ぬるぽRTAのテスト（2026-11-10）。Discord には接続しない。

- ｶﾞｯ/ぬるぽ の検知（NFKC 正規化・5文字制限・60秒窓）
- ペアリング（FIFO・自演防止・チャンネル分離・失効）
- ペア単位の最速/最遅集計と local/global/me ボード
- 記録時の公開 embed（プレーン名・順位・新記録）
"""

import os
import sys
import types
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock
from unittest.mock import AsyncMock

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

for _name, _value in {'BOT_API_BASE_URL': 'http://127.0.0.1:8787', 'BOT_API_KEY': 'dummy-key'}.items():
    os.environ.setdefault(_name, _value)

import discord  # noqa: E402

from core.game.nurupo_rta import cog as nurupo_mod  # noqa: E402
from core.game.nurupo_rta.cog import (  # noqa: E402
    NurupoBoardView, NurupoRta, PendingNurupo, _fmt_time, _global_pair_records,
    _pair_records, _rank_of, is_ga, is_nurupo,
)

SECTION = nurupo_mod.SECTION
BASE = datetime(2026, 11, 10, 12, 0, 0, tzinfo=timezone.utc)


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
    old = nurupo_mod.guild_settings.get_store
    nurupo_mod.guild_settings.get_store = lambda: store
    case.addCleanup(setattr, nurupo_mod.guild_settings, "get_store", old)
    return store


class DetectionTest(unittest.TestCase):
    def test_ga_variants(self):
        for content in ["ｶﾞｯ", "ガッ", "がっ", "カッ", "ガッ！", "ガ", "か",
                        "ｶﾞｯｶﾞｯ", "あガあガあ"]:
            self.assertTrue(is_ga(content), content)

    def test_ga_exactly_five_chars_ok_six_ng(self):
        self.assertTrue(is_ga("ガガガガガ"))       # 5文字ちょうど
        self.assertFalse(is_ga("ガガガガガガ"))    # 6文字
        self.assertFalse(is_ga("あああああガ"))   # ガを含んでも6文字は不可
        self.assertFalse(is_ga("ｶﾞｯｶﾞｯｶﾞｯ"))  # NFKC後は「ガッガッガッ」6文字

    def test_ga_requires_ga_char(self):
        self.assertFalse(is_ga("あっ"))
        self.assertFalse(is_ga("ぬるぽ"))
        self.assertFalse(is_ga(""))
        self.assertFalse(is_ga("   "))
        self.assertFalse(is_ga(None))

    def test_nurupo_variants(self):
        self.assertTrue(is_nurupo("ぬるぽ"))
        self.assertTrue(is_nurupo("ヌルポ"))
        self.assertTrue(is_nurupo("ﾇﾙﾎﾟ"))
        self.assertTrue(is_nurupo("あのさ、ぬるぽって言ったらｶﾞｯて返すやつ"))
        self.assertFalse(is_nurupo("ガッ"))
        self.assertFalse(is_nurupo("ぬるぽっぽくない何か"[3:]))

    def test_fmt_time_matches_bump_board_format(self):
        self.assertEqual(_fmt_time(1500), "1.50秒")
        self.assertEqual(_fmt_time(500), "0.50秒")
        self.assertEqual(_fmt_time(60000), "60.00秒")


class PairingTest(unittest.TestCase):
    def setUp(self):
        self.pending = PendingNurupo()

    def test_basic_pair_elapsed_ms(self):
        self.pending.add(10, 2, BASE)
        matched = self.pending.match(10, 3, BASE + timedelta(seconds=1.5))
        self.assertEqual(matched, (2, 1500))

    def test_fifo_oldest_first(self):
        self.pending.add(10, 2, BASE)
        self.pending.add(10, 3, BASE + timedelta(seconds=1))
        self.assertEqual(
            self.pending.match(10, 4, BASE + timedelta(seconds=2)), (2, 2000))
        self.assertEqual(
            self.pending.match(10, 4, BASE + timedelta(seconds=3)), (3, 2000))

    def test_self_ga_skips_own_nurupo(self):
        self.pending.add(10, 2, BASE)
        self.pending.add(10, 3, BASE + timedelta(seconds=1))
        # 自分のぬるぽは飛ばして相手のぬるぽと付く
        self.assertEqual(
            self.pending.match(10, 2, BASE + timedelta(seconds=2)), (3, 1000))
        # 自分のぬるぽは残っているので、別の人の ｶﾞｯ で付く
        self.assertEqual(
            self.pending.match(10, 4, BASE + timedelta(seconds=3)), (2, 3000))

    def test_self_only_never_pairs(self):
        self.pending.add(10, 2, BASE)
        self.assertIsNone(self.pending.match(10, 2, BASE + timedelta(seconds=1)))

    def test_window_boundary(self):
        self.pending.add(10, 2, BASE)
        self.assertEqual(
            self.pending.match(10, 3, BASE + timedelta(seconds=60)), (2, 60000))
        self.pending.add(10, 2, BASE)
        self.assertIsNone(
            self.pending.match(10, 3, BASE + timedelta(seconds=61)))

    def test_channels_are_separate(self):
        self.pending.add(10, 2, BASE)
        self.assertIsNone(self.pending.match(20, 3, BASE + timedelta(seconds=1)))
        self.assertEqual(
            self.pending.match(10, 3, BASE + timedelta(seconds=1)), (2, 1000))

    def test_matched_nurupo_is_consumed(self):
        self.pending.add(10, 2, BASE)
        self.pending.match(10, 3, BASE + timedelta(seconds=1))
        self.assertIsNone(self.pending.match(10, 4, BASE + timedelta(seconds=2)))


class PairAggregationTest(unittest.TestCase):
    RUNS = [
        {"nurupo_user_id": "2", "ga_user_id": "3", "elapsed_ms": 3000},
        {"nurupo_user_id": "2", "ga_user_id": "3", "elapsed_ms": 1500},
        {"nurupo_user_id": "3", "ga_user_id": "2", "elapsed_ms": 2000},
        {"nurupo_user_id": "2", "ga_user_id": "3", "elapsed_ms": 9000},
        {"nurupo_user_id": "2", "elapsed_ms": 100},   # 壊れた行
        "junk",
        {"nurupo_user_id": "4", "ga_user_id": "5", "elapsed_ms": "abc"},
    ]

    def test_pair_best_and_reverse_pair_is_another_combo(self):
        rows = _pair_records(self.RUNS)
        self.assertEqual(
            [(r["nurupo_user_id"], r["ga_user_id"], r["elapsed_ms"]) for r in rows],
            [("2", "3", 1500), ("3", "2", 2000)])

    def test_pair_worst(self):
        rows = _pair_records(self.RUNS, slowest=True)
        self.assertEqual(
            [(r["nurupo_user_id"], r["ga_user_id"], r["elapsed_ms"]) for r in rows],
            [("2", "3", 9000), ("3", "2", 2000)])

    def test_global_merges_guilds(self):
        all_settings = {
            "1": {"records": [
                {"nurupo_user_id": "2", "ga_user_id": "3", "elapsed_ms": 3000}]},
            "9": {"records": [
                {"nurupo_user_id": "2", "ga_user_id": "3", "elapsed_ms": 1200},
                {"nurupo_user_id": "6", "ga_user_id": "7", "elapsed_ms": 800}]},
            "x": "not-a-dict",
        }
        rows = _global_pair_records(all_settings)
        self.assertEqual(
            [(r["nurupo_user_id"], r["ga_user_id"], r["elapsed_ms"]) for r in rows],
            [("6", "7", 800), ("2", "3", 1200)])

    def test_rank_of(self):
        rows = [{"elapsed_ms": 1500}, {"elapsed_ms": 2000}]
        self.assertEqual(_rank_of(1000, rows), 1)
        self.assertEqual(_rank_of(1500, rows), 1)   # 同タイムは同じ順位
        self.assertEqual(_rank_of(1800, rows), 2)
        self.assertEqual(_rank_of(3000, rows), 3)


def make_channel(channel_id=10):
    return types.SimpleNamespace(id=channel_id, send=AsyncMock())


def make_message(user_id, content, at, *, channel=None, guild_id=1,
                 bot=False, webhook_id=None):
    return types.SimpleNamespace(
        guild=types.SimpleNamespace(id=guild_id) if guild_id is not None else None,
        author=types.SimpleNamespace(id=user_id, bot=bot),
        webhook_id=webhook_id,
        content=content,
        channel=channel or make_channel(),
        created_at=at)


class OnMessageTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.store = use_store(self, FakeStore())
        self.channel = make_channel()
        patcher = mock.patch.object(nurupo_mod, "guild_locale", return_value="ja")
        patcher.start()
        self.addCleanup(patcher.stop)
        self.cog = NurupoRta(types.SimpleNamespace())

    async def say(self, user_id, content, seconds, **kwargs):
        kwargs.setdefault("channel", self.channel)
        message = make_message(
            user_id, content, BASE + timedelta(seconds=seconds), **kwargs)
        await self.cog.on_message(message)
        return message

    def records(self):
        return self.store.section(1).get("records", [])

    async def test_record_and_announce(self):
        await self.say(2, "ぬるぽ", 0)
        await self.say(3, "ｶﾞｯ", 1.5)
        records = self.records()
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["nurupo_user_id"], "2")
        self.assertEqual(records[0]["ga_user_id"], "3")
        self.assertEqual(records[0]["elapsed_ms"], 1500)
        self.channel.send.assert_awaited_once()
        kwargs = self.channel.send.await_args.kwargs
        embed = kwargs["embed"]
        self.assertEqual(embed.title, "ぬるぽRTA")
        self.assertIn("1.50秒", embed.description)
        self.assertIn("このサーバー **1位**", embed.description)
        self.assertIn("全サーバー **1位**", embed.description)
        self.assertNotIn("<@", embed.description)   # メンションしない
        self.assertIsNotNone(kwargs["allowed_mentions"])

    async def test_self_ga_does_not_record(self):
        await self.say(2, "ぬるぽ", 0)
        await self.say(2, "ガッ", 1)
        self.assertEqual(self.records(), [])
        self.channel.send.assert_not_awaited()
        # 自分のぬるぽは残っていて、別人の ｶﾞｯ で成立する
        await self.say(3, "ガッ", 2)
        self.assertEqual(len(self.records()), 1)
        self.assertEqual(self.records()[0]["elapsed_ms"], 2000)

    async def test_expired_nurupo_does_not_record(self):
        await self.say(2, "ぬるぽ", 0)
        await self.say(3, "ガッ", 61)
        self.assertEqual(self.records(), [])

    async def test_six_char_ga_does_not_trigger(self):
        await self.say(2, "ぬるぽ", 0)
        await self.say(3, "ガガガガガガ", 1)
        self.assertEqual(self.records(), [])
        await self.say(3, "ガッ", 2)
        self.assertEqual(len(self.records()), 1)

    async def test_fifo_through_messages(self):
        await self.say(2, "ぬるぽ", 0)
        await self.say(3, "ぬるぽ", 1)
        await self.say(4, "ガッ", 2)
        await self.say(4, "ガッ", 3)
        records = self.records()
        self.assertEqual(
            [(r["nurupo_user_id"], r["ga_user_id"], r["elapsed_ms"]) for r in records],
            [("2", "4", 2000), ("3", "4", 2000)])

    async def test_other_channel_does_not_pair(self):
        other = make_channel(20)
        await self.say(2, "ぬるぽ", 0)
        await self.say(3, "ガッ", 1, channel=other)
        self.assertEqual(self.records(), [])

    async def test_bot_and_webhook_ignored(self):
        # bot のぬるぽは計測開始しない（チャンネルを分けて干渉を避ける）
        ch_a = make_channel(20)
        await self.say(9, "ぬるぽ", 0, bot=True, channel=ch_a)
        await self.say(3, "ガッ", 1, channel=ch_a)
        self.assertEqual(self.records(), [])
        # bot の ｶﾞｯ は成立させない（人間のぬるぽは消費もされない）
        ch_b = make_channel(30)
        await self.say(2, "ぬるぽ", 10, channel=ch_b)
        await self.say(9, "ガッ", 11, bot=True, channel=ch_b)
        self.assertEqual(self.records(), [])
        # webhook のぬるぽも計測開始しない
        ch_c = make_channel(40)
        await self.say(2, "ぬるぽ", 20, webhook_id=999, channel=ch_c)
        await self.say(3, "ガッ", 21, channel=ch_c)
        self.assertEqual(self.records(), [])
        # ch_b の人間のぬるぽは残っていて、人間の ｶﾞｯ で成立する
        await self.say(3, "ガッ", 12, channel=ch_b)
        self.assertEqual(len(self.records()), 1)
        self.assertEqual(self.records()[0]["elapsed_ms"], 2000)

    async def test_dm_ignored(self):
        message = make_message(2, "ぬるぽ", BASE, guild_id=None)
        await self.cog.on_message(message)
        message = make_message(3, "ガッ", BASE + timedelta(seconds=1), guild_id=None)
        await self.cog.on_message(message)
        self.assertEqual(self.records(), [])

    async def test_non_ja_guild_ignored(self):
        with mock.patch.object(nurupo_mod, "guild_locale", return_value="en"):
            await self.say(2, "ぬるぽ", 0)
            await self.say(3, "ガッ", 1)
        self.assertEqual(self.records(), [])

    async def test_new_record_flag_only_when_beating_pair_best(self):
        await self.say(2, "ぬるぽ", 0)
        await self.say(3, "ガッ", 3)          # 初記録 3.00秒（新記録表示なし）
        await self.say(2, "ぬるぽ", 10)
        await self.say(3, "ガッ", 11)         # 1.00秒 = コンビ新記録
        await self.say(2, "ぬるぽ", 20)
        await self.say(3, "ガッ", 22)         # 2.00秒 = 更新ではない
        descriptions = [
            call.kwargs["embed"].description
            for call in self.channel.send.await_args_list]
        self.assertEqual(len(descriptions), 3)
        self.assertNotIn("新記録", descriptions[0])
        self.assertIn("コンビ新記録！", descriptions[1])
        self.assertIn("1.00秒", descriptions[1])
        self.assertNotIn("新記録", descriptions[2])
        # 順位はペアベスト基準なので、3回目もコンビは1位のまま
        self.assertIn("このサーバー **1位**", descriptions[2])


class BoardTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.store = use_store(self, FakeStore({
            "1": {SECTION: {"records": [
                {"nurupo_user_id": "2", "ga_user_id": "3", "elapsed_ms": 1500},
                {"nurupo_user_id": "2", "ga_user_id": "3", "elapsed_ms": 9000},
                {"nurupo_user_id": "3", "ga_user_id": "2", "elapsed_ms": 2000},
                {"nurupo_user_id": "4", "ga_user_id": "5", "elapsed_ms": 500},
            ]}},
            "9": {SECTION: {"records": [
                {"nurupo_user_id": "2", "ga_user_id": "3", "elapsed_ms": 1200},
                {"nurupo_user_id": "6", "ga_user_id": "7", "elapsed_ms": 800},
            ]}},
        }))
        self.cog = NurupoRta(types.SimpleNamespace())

    async def test_local_fastest_board(self):
        embed, png = await self.cog.build_board(1, 2, scope="local")
        self.assertIsNotNone(png)
        self.assertEqual(embed.title, "ぬるぽRTAランキング（このサーバー）")

    async def test_local_slowest_board(self):
        embed, png = await self.cog.build_board(1, 2, scope="local", slowest=True)
        self.assertIsNotNone(png)
        self.assertEqual(embed.title, "ぬるぽRTA最遅ランキング（このサーバー）")

    async def test_global_board(self):
        embed, png = await self.cog.build_board(1, 2, scope="global")
        self.assertIsNotNone(png)
        self.assertEqual(embed.title, "ぬるぽRTAランキング（全サーバー）")

    async def test_me_board_lists_pairs_involving_user(self):
        embed, png = await self.cog.build_board(1, 3, scope="me")
        self.assertIsNone(png)
        self.assertEqual(embed.title, "ぬるぽRTAランキング（自分）")
        # user3 が入るペアは (2,3)=1.50秒 と (3,2)=2.00秒（速い順）
        self.assertLess(embed.description.index("1.50秒"),
                        embed.description.index("2.00秒"))
        self.assertIn("×", embed.description)
        self.assertNotIn("<@", embed.description)

    async def test_me_board_slowest_uses_pair_worst(self):
        embed, png = await self.cog.build_board(1, 3, scope="me", slowest=True)
        self.assertIsNone(png)
        # (2,3) の最遅 9.00秒 が先に来る
        self.assertLess(embed.description.index("9.00秒"),
                        embed.description.index("2.00秒"))

    async def test_me_board_empty(self):
        embed, png = await self.cog.build_board(1, 42, scope="me")
        self.assertIsNone(png)
        self.assertEqual(embed.description, "まだ記録がありません。")

    async def test_empty_local_board_is_text(self):
        use_store(self, FakeStore())
        embed, png = await self.cog.build_board(1, 2, scope="local")
        self.assertIsNone(png)
        self.assertEqual(embed.description, "まだ記録がありません。")


class BoardViewTest(unittest.IsolatedAsyncioTestCase):
    def make_view(self, **kwargs):
        embed = discord.Embed(title="ボード", description="x", color=0xFFFFFF)
        cog = types.SimpleNamespace(
            build_board=AsyncMock(return_value=(embed, None)))
        view = NurupoBoardView(cog, 1, 2, **kwargs)
        return view, cog

    def test_buttons_match_sokunuke_board_layout(self):
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


class RegistrationTest(unittest.TestCase):
    def test_action_registered_in_boardnotify_rta_genre(self):
        from core.general import action_registry

        spec = action_registry.default_registry().get("general:nurupo_board")
        self.assertIsNotNone(spec)
        self.assertEqual(spec.genre, "boardnotify_rta")
        self.assertEqual(spec.label, "ぬるぽRTA")

    def test_rankings_hub_has_nurupo_next_to_sokunuke(self):
        from core.general.entry import RankingsView

        values = [value for _label, value in RankingsView.TARGETS]
        self.assertEqual(values.index("nurupo_board"),
                         values.index("sokunuke_board") + 1)


class NurupoBoardDispatchTest(unittest.IsolatedAsyncioTestCase):
    """/general の nurupo_board 導線（ランキング一覧ハブと同じ値）。"""

    async def test_dispatch_opens_board_view(self):
        # GeneralCog の実体は core.general.entry（cogs.general 経由の import は
        # 既存の import 順アーティファクトで壊れる場合があるため直接引く）。
        from core.general.entry import GeneralCog
        from core.general import action_usage
        from core.support import command_control

        embed = discord.Embed(title="ぬるぽRTAランキング（このサーバー）",
                              color=0xFFFFFF)
        nurupo = types.SimpleNamespace(
            build_board=AsyncMock(return_value=(embed, None)))
        cog = GeneralCog.__new__(GeneralCog)
        cog.bot = types.SimpleNamespace(
            get_cog=lambda name: nurupo if name == "NurupoRta" else None)
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
            await cog.dispatch_general(interaction, "nurupo_board")
        # 先にACK（defer）してからボードを送る（rta_board と同じ順序）
        interaction.response.defer.assert_awaited_once()
        kwargs = interaction.followup.send.await_args.kwargs
        view = kwargs["view"].panel
        self.assertIsInstance(view, NurupoBoardView)
        self.assertEqual(view.scope, "local")
        self.assertFalse(view.slowest)
        args, bkwargs = nurupo.build_board.await_args
        self.assertEqual(args, (123, 456))
        self.assertEqual(bkwargs, {"scope": "local", "slowest": False})


if __name__ == "__main__":
    unittest.main()
