# -*- coding: utf-8 -*-
"""おみくじのテスト。

Discord に接続せず、次を確認する：
- 運勢の重み（合計100・境界の割り当て）
- 文面プールの網羅（全12ランク×和歌/総合/10項目）と吉凶の矛盾がないこと
- 日次固定（同日は同一結果・日付が変われば再抽選）
- トリガ条件（ja ギルドのみ・Bot/Webhook/DM では発動しない・クールダウン）
- 画像生成（想定サイズで生成できる・空でない）
- /general へのジャンル/アクション登録
"""
import io
import os
import sys
import tempfile
import types
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from PIL import Image

from core.general.omikuji import fortunes as F
from core.general.omikuji import render as R
from core.general.omikuji.store import OmikujiStore


class _FixedRoll:
    """randint の戻り値を固定した pick_rank 用スタブ。"""

    def __init__(self, roll):
        self.roll = roll

    def randint(self, a, b):
        assert (a, b) == (1, 100)
        return self.roll


class RankWeightsTest(unittest.TestCase):
    def test_weights_sum_to_100(self):
        self.assertEqual(sum(F.RANK_WEIGHTS), 100)
        self.assertEqual(len(F.RANKS), 12)
        self.assertEqual(len(F.RANK_WEIGHTS), 12)

    def test_rank_boundaries(self):
        boundaries = [
            (1, "大吉"), (12, "大吉"), (13, "中吉"), (30, "中吉"),
            (31, "小吉"), (46, "小吉"), (47, "吉"), (66, "吉"),
            (67, "半吉"), (72, "半吉"), (73, "末吉"), (81, "末吉"),
            (82, "末小吉"), (84, "末小吉"), (85, "凶"), (92, "凶"),
            (93, "小凶"), (95, "小凶"), (96, "半凶"), (97, "半凶"),
            (98, "末凶"), (99, "末凶"), (100, "大凶"),
        ]
        for roll, expected in boundaries:
            with self.subTest(roll=roll):
                self.assertEqual(F.pick_rank(_FixedRoll(roll)), expected)


class PoolCoverageTest(unittest.TestCase):
    def test_all_ranks_have_full_pools(self):
        for rank in F.RANKS:
            with self.subTest(rank=rank):
                self.assertGreaterEqual(len(F.WAKA[rank]), 3)
                self.assertGreaterEqual(len(F.SUMMARIES[rank]), 3)
                pools = F.ITEM_FORTUNES[rank]
                self.assertEqual(set(pools), set(F.ITEMS))
                for name in F.ITEMS:
                    self.assertGreaterEqual(len(pools[name]), 3)

    def test_text_lengths_fit_the_slip_layout(self):
        for rank in F.RANKS:
            for name, texts in F.ITEM_FORTUNES[rank].items():
                for text in texts:
                    self.assertLessEqual(len(text), 15, (rank, name, text))
            for kami, shimo in F.WAKA[rank]:
                for part in (kami, shimo):
                    visible = part.replace(" ", "").replace("　", "")
                    self.assertLessEqual(len(visible), 16, (rank, part))
            for summary in F.SUMMARIES[rank]:
                self.assertLessEqual(len(summary), 45, (rank, summary))

    def test_bad_ranks_have_no_contradictory_texts(self):
        # 凶系ランクで「叶う」等の肯定的な断定をしていないこと（仕様の担保）。
        bad_ranks = ("凶", "小凶", "半凶", "末凶", "大凶")
        for rank in bad_ranks:
            for name, texts in F.ITEM_FORTUNES[rank].items():
                for text in texts:
                    self.assertNotIn("絶好", text, (rank, name, text))
                    self.assertNotIn("大いに良し", text, (rank, name, text))
                    self.assertNotIn("大いに利", text, (rank, name, text))
            self.assertNotIn("叶う", F.ITEM_FORTUNES[rank]["願望"][0].split("。")[0]
                             .replace("叶わない", "").replace("叶い難い", ""),
                             (rank, "願望"))

    def test_daikichi_has_no_negative_texts(self):
        negatives = ("叶わない", "来ない", "出ない", "控えよ", "諦め")
        for name, texts in F.ITEM_FORTUNES["大吉"].items():
            for text in texts:
                for word in negatives:
                    self.assertNotIn(word, text, (name, text))


class DailyFixTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.store = OmikujiStore(path=os.path.join(self._tmp.name, "omikuji.json"))

    def tearDown(self):
        self._tmp.cleanup()

    def test_same_day_same_result(self):
        first, created1 = self.store.get_or_draw(111, 222, "2026-11-09")
        second, created2 = self.store.get_or_draw(111, 222, "2026-11-09")
        self.assertTrue(created1)
        self.assertFalse(created2)
        self.assertEqual(first, second)

    def test_next_day_redraws(self):
        _first, _ = self.store.get_or_draw(111, 222, "2026-11-09")
        _second, created = self.store.get_or_draw(111, 222, "2026-11-10")
        self.assertTrue(created)

    def test_users_are_independent(self):
        _a, created_a = self.store.get_or_draw(111, 222, "2026-11-09")
        _b, created_b = self.store.get_or_draw(111, 333, "2026-11-09")
        _c, created_c = self.store.get_or_draw(999, 222, "2026-11-09")
        self.assertTrue(created_a and created_b and created_c)

    def test_seeded_draw_is_deterministic(self):
        a = F.draw_fortune(F.seeded_rng(1, 2, "2026-11-09"))
        b = F.draw_fortune(F.seeded_rng(1, 2, "2026-11-09"))
        self.assertEqual(a, b)
        self.assertIn(a.rank, F.RANKS)
        self.assertTrue(1 <= a.number <= 100)
        self.assertEqual([name for name, _ in a.items], list(F.ITEMS))

    def test_store_survives_reload(self):
        first, _ = self.store.get_or_draw(111, 222, "2026-11-09")
        reloaded = OmikujiStore(path=os.path.join(self._tmp.name, "omikuji.json"))
        second, created = reloaded.get_or_draw(111, 222, "2026-11-09")
        self.assertFalse(created)
        self.assertEqual(first, second)


class UnlimitedUserTest(unittest.TestCase):
    """回数制限の対象外ユーザー（ユーザー本人）の例外仕様。"""

    EXEMPT_ID = 1320705325686587408

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.path = os.path.join(self._tmp.name, "omikuji.json")
        self.store = OmikujiStore(path=self.path)

    def tearDown(self):
        self._tmp.cleanup()

    def test_exempt_id_is_registered(self):
        from core.general.omikuji.store import UNLIMITED_USER_IDS, is_unlimited_user

        self.assertIn(self.EXEMPT_ID, UNLIMITED_USER_IDS)
        self.assertTrue(is_unlimited_user(self.EXEMPT_ID))
        self.assertFalse(is_unlimited_user(222))

    def test_exempt_user_is_never_fixed_within_a_day(self):
        for _ in range(3):
            _fortune, created = self.store.get_or_draw(
                111, self.EXEMPT_ID, "2026-11-09")
            self.assertTrue(created)
        # 保存もされない（再読込したストアでも固定結果にならない）
        reloaded = OmikujiStore(path=self.path)
        _fortune, created = reloaded.get_or_draw(
            111, self.EXEMPT_ID, "2026-11-09")
        self.assertTrue(created)

    def test_exempt_draws_vary(self):
        results = set()
        for _ in range(30):
            fortune, _created = self.store.get_or_draw(
                111, self.EXEMPT_ID, "2026-11-09")
            results.add((fortune.rank, fortune.number))
        self.assertGreater(len(results), 1)

    def test_normal_user_stays_fixed_in_same_store(self):
        first, created1 = self.store.get_or_draw(111, 222, "2026-11-09")
        second, created2 = self.store.get_or_draw(111, 222, "2026-11-09")
        self.assertTrue(created1)
        self.assertFalse(created2)
        self.assertEqual(first, second)


class RenderTest(unittest.TestCase):
    def test_kanji_numbers(self):
        cases = {1: "一", 7: "七", 10: "十", 11: "十一", 20: "二十",
                 23: "二十三", 99: "九十九", 100: "百"}
        for number, expected in cases.items():
            with self.subTest(number=number):
                self.assertEqual(R.kanji_number(number), expected)

    def test_render_every_rank(self):
        for rank in F.RANKS:
            pools = F.ITEM_FORTUNES[rank]
            fortune = F.Fortune(
                number=100, rank=rank, waka=F.WAKA[rank][0],
                summary=F.SUMMARIES[rank][0],
                items=tuple((name, pools[name][0]) for name in F.ITEMS),
            )
            data = R.render_omikuji_png(fortune)
            with self.subTest(rank=rank):
                self.assertGreater(len(data), 10_000)
                img = Image.open(io.BytesIO(data))
                self.assertEqual(img.format, "PNG")
                self.assertEqual(img.size, (R.CANVAS_W, R.CANVAS_H))

    def test_longest_items_do_not_reach_footer(self):
        # 最長文面（15字）の列末尾がフッター「AGO」の帯（左下）に
        # 墨色で侵入していないこと（干渉の回帰防止）。
        pools = F.ITEM_FORTUNES["大凶"]
        fortune = F.Fortune(
            number=23, rank="大凶", waka=F.WAKA["大凶"][0],
            summary=F.SUMMARIES["大凶"][0],
            items=tuple((name, max(pools[name], key=len)) for name in F.ITEMS),
        )
        img = Image.open(io.BytesIO(R.render_omikuji_png(fortune))).convert("RGB")

        def is_ink(px):
            return abs(px[0] - 43) < 25 and abs(px[1] - 39) < 25 and abs(px[2] - 34) < 25

        invaded = [(x, y) for y in range(1898, 1932) for x in range(50, 130)
                   if is_ink(img.getpixel((x, y)))]
        self.assertEqual(invaded, [])


def _fake_message(*, guild_id=111, user_id=222, content="おみくじ引きたい",
                  bot=False, webhook_id=None, dm=False):
    replies = []

    async def reply(**kwargs):
        replies.append(kwargs)

    message = types.SimpleNamespace(
        guild=None if dm else types.SimpleNamespace(id=guild_id),
        author=types.SimpleNamespace(id=user_id, bot=bot),
        content=content,
        webhook_id=webhook_id,
        reply=reply,
    )
    return message, replies


class TriggerTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        from core.general.omikuji.cog import OmikujiCog

        self.now = [1000.0]
        self.cog = OmikujiCog(
            bot=types.SimpleNamespace(),
            store=OmikujiStore(path=os.path.join(self._tmp.name, "omikuji.json")),
            clock=lambda: self.now[0],
        )

    def tearDown(self):
        self._tmp.cleanup()

    async def _dispatch(self, message, locale="ja"):
        with mock.patch("core.general.omikuji.cog.guild_locale",
                        return_value=locale):
            await self.cog.on_message(message)

    async def test_ja_guild_trigger_posts_result(self):
        message, replies = _fake_message()
        await self._dispatch(message)
        self.assertEqual(len(replies), 1)
        self.assertIn("file", replies[0])

    async def test_non_ja_guild_does_not_trigger(self):
        message, replies = _fake_message()
        await self._dispatch(message, locale="en")
        self.assertEqual(replies, [])

    async def test_bot_author_does_not_trigger(self):
        message, replies = _fake_message(bot=True)
        await self._dispatch(message)
        self.assertEqual(replies, [])

    async def test_webhook_does_not_trigger(self):
        message, replies = _fake_message(webhook_id=999)
        await self._dispatch(message)
        self.assertEqual(replies, [])

    async def test_dm_does_not_trigger(self):
        message, replies = _fake_message(dm=True)
        await self._dispatch(message)
        self.assertEqual(replies, [])

    async def test_no_trigger_phrase_no_post(self):
        message, replies = _fake_message(content="こんにちは")
        await self._dispatch(message)
        self.assertEqual(replies, [])

    async def test_exempt_user_can_trigger_repeatedly(self):
        message, replies = _fake_message(user_id=1320705325686587408)
        await self._dispatch(message)
        await self._dispatch(message)
        self.assertEqual(len(replies), 2)

    async def test_cooldown_blocks_repeat_and_same_image_after(self):
        message, replies = _fake_message()
        await self._dispatch(message)
        await self._dispatch(message)
        self.assertEqual(len(replies), 1)
        self.now[0] += 31
        await self._dispatch(message)
        self.assertEqual(len(replies), 2)
        first_bytes = replies[0]["file"].fp.getvalue()
        second_bytes = replies[1]["file"].fp.getvalue()
        self.assertEqual(first_bytes, second_bytes)


class PanelTest(unittest.IsolatedAsyncioTestCase):
    async def test_panel_posts_publicly_then_cooldown_is_ephemeral(self):
        from core.general.omikuji.cog import OmikujiCog

        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        cog = OmikujiCog(
            bot=types.SimpleNamespace(),
            store=OmikujiStore(path=os.path.join(tmp.name, "omikuji.json")),
            clock=lambda: 1000.0,
        )
        sent = []

        class _Response:
            async def send_message(self, *args, **kwargs):
                if args:
                    kwargs["content"] = args[0]
                sent.append(kwargs)

        interaction = types.SimpleNamespace(
            guild_id=111,
            user=types.SimpleNamespace(id=222, display_name="テスト"),
            response=_Response(),
        )
        await cog.open_panel(interaction)
        self.assertEqual(len(sent), 1)
        self.assertIn("file", sent[0])
        self.assertFalse(sent[0].get("ephemeral"))
        await cog.open_panel(interaction)
        self.assertEqual(len(sent), 2)
        self.assertTrue(sent[1].get("ephemeral"))

    async def test_exempt_user_panel_is_not_cooldowned(self):
        from core.general.omikuji.cog import OmikujiCog

        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        cog = OmikujiCog(
            bot=types.SimpleNamespace(),
            store=OmikujiStore(path=os.path.join(tmp.name, "omikuji.json")),
            clock=lambda: 1000.0,
        )
        sent = []

        class _Response:
            async def send_message(self, *args, **kwargs):
                if args:
                    kwargs["content"] = args[0]
                sent.append(kwargs)

        interaction = types.SimpleNamespace(
            guild_id=111,
            user=types.SimpleNamespace(
                id=1320705325686587408, display_name="本人"),
            response=_Response(),
        )
        await cog.open_panel(interaction)
        await cog.open_panel(interaction)
        self.assertEqual(len(sent), 2)
        self.assertIn("file", sent[0])
        self.assertIn("file", sent[1])
        self.assertFalse(sent[1].get("ephemeral"))


class RegistryTest(unittest.TestCase):
    def test_omikuji_is_registered_in_fortune_genre(self):
        from core.general import action_registry
        from core.general.common import GENERAL_GENRES

        self.assertEqual(GENERAL_GENRES["fortune"][0], "占い")
        spec = action_registry.default_registry().get("general:omikuji")
        self.assertIsNotNone(spec)
        self.assertEqual(spec.genre, "fortune")
        self.assertEqual(spec.label, "おみくじ")

    def test_cog_module_loads(self):
        from core.general.omikuji.cog import OmikujiCog
        from discord.ext import commands

        self.assertTrue(issubclass(OmikujiCog, commands.Cog))


if __name__ == "__main__":
    unittest.main()
