# -*- coding: utf-8 -*-
"""にょっきゲームのテスト。

ロジック（core/game/nyokki/nyokki.py）は時刻を注入して決定的に検証し、
cog は tests/game_fakes.py の偽部品と仮想時計で通信なしに検証する。
"""
import asyncio
import random
import types
import unittest

import discord

from game_fakes import FakeChannel, FakeChatMessage, FakeGuild, FakeInteraction, FakeMember

from core.game.nyokki.nyokki import (
    GRACE_SECONDS,
    MAX_ROUNDS,
    WINDOW_SECONDS,
    NyokkiSession,
    parse_declaration,
)
from core.game.nyokki import cog as nyokki_cog
from core.game.nyokki.cog import Nyokki, _Match


def types_of(events):
    return [e["type"] for e in events]


def make_session(players=(1, 2, 3), cpus=(), seed=1, start=0.0):
    session = NyokkiSession(list(players), cpu_ids=cpus, rng=random.Random(seed))
    session.start_round(start)
    return session


# ======================================================================
# 宣言パターン
# ======================================================================
class ParseDeclarationTest(unittest.TestCase):
    def test_matches(self):
        cases = {
            "1ニョッキ！": 1,
            "2にょっき": 2,
            "3 ニョッキ": 3,
            "４ニョッキ": 4,
            "12ニョッキ。": 12,
            "1ニョッキ": 1,
            "７にょっき！": 7,
            " 5ニョッキ！ ": 5,
            "8ニョッキ！！": 8,
        }
        for text, expected in cases.items():
            self.assertEqual(parse_declaration(text), expected, text)

    def test_rejects_non_declarations(self):
        cases = [
            "おはよう",
            "1ニョッキだと思う",   # 部分一致では誤爆しない（全文一致のみ）
            "1ニョッキしたい",
            "あ1ニョッキ",
            "ニョッキ",
            "1",
            "",
            "100ニョッキ",          # 3桁は宣言として扱わない
            "ニョッキ1",
            "1 ニョッキ だ",
        ]
        for text in cases:
            self.assertIsNone(parse_declaration(text), text)
        self.assertIsNone(parse_declaration(None))


# ======================================================================
# セッションの解決ロジック
# ======================================================================
class SessionResolutionTest(unittest.TestCase):
    def test_first_declaration_escapes_after_grace(self):
        s = make_session()
        self.assertEqual(types_of(s.declare(1, 1, 0.0)), ["first"])
        self.assertEqual(s.tick(GRACE_SECONDS - 0.1), [])
        self.assertEqual(types_of(s.tick(GRACE_SECONDS)), ["escape"])
        self.assertIn(1, s.escaped)
        self.assertEqual(s.target, 2)

    def test_collision_within_grace(self):
        s = make_session()
        s.declare(1, 1, 0.0)
        events = s.declare(2, 1, GRACE_SECONDS - 0.5)
        self.assertEqual(types_of(events), ["collision", "round_end"])
        self.assertEqual(s.outs[1], 1)
        self.assertEqual(s.outs[2], 1)
        self.assertTrue(s.round_over)
        self.assertFalse(s.finished)  # 3人目は残っているので対戦は続く

    def test_same_number_after_grace_is_wrong_number(self):
        s = make_session()
        s.declare(1, 1, 0.0)
        s.tick(GRACE_SECONDS)  # 1が勝ち抜け、対象は2へ
        events = s.declare(2, 1, GRACE_SECONDS + 0.5)
        # 猶予を過ぎた同番号は「番号違い」。2が退場し、未宣言は3だけになるので
        # 3も最後の1人アウトを取ってラウンドが終わる。
        self.assertEqual(types_of(events), ["wrong_number", "last_one_out", "round_end"])
        self.assertEqual(s.outs[2], 1)
        self.assertIn(2, s.round_out)
        self.assertEqual(s.outs[3], 1)
        self.assertTrue(s.round_over)

    def test_wrong_number_out_and_round_continues(self):
        s = make_session()
        self.assertEqual(types_of(s.declare(1, 9, 0.0)), ["wrong_number"])
        self.assertEqual(s.outs[1], 1)
        self.assertFalse(s.round_over)
        # 残り2人のうち2が抜けると、最後の3がアウトを取ってラウンド終了
        s.declare(2, 1, 0.5)
        events = s.tick(0.5 + GRACE_SECONDS)
        self.assertEqual(types_of(events), ["escape", "last_one_out", "round_end"])
        self.assertEqual(s.outs[3], 1)

    def test_last_one_out_two_players(self):
        s = make_session(players=(1, 2))
        s.declare(1, 1, 0.0)
        events = s.tick(GRACE_SECONDS)
        self.assertEqual(types_of(events), ["escape", "last_one_out", "round_end"])
        self.assertEqual(s.outs[2], 1)
        self.assertTrue(s.round_over)

    def test_window_extends_once_then_forced_end(self):
        s = make_session()
        self.assertEqual(types_of(s.tick(WINDOW_SECONDS)), ["extended"])
        self.assertEqual(s.tick(WINDOW_SECONDS * 2 - 0.1), [])
        events = s.tick(WINDOW_SECONDS * 2)
        self.assertEqual(types_of(events), ["forced_end", "round_end"])
        self.assertTrue(all(v == 0 for v in s.outs.values()))  # アウトは付かない

    def test_extension_resets_for_next_target(self):
        s = make_session()
        s.declare(1, 1, WINDOW_SECONDS - 1)  # ウィンドウ終了間際の宣言
        s.tick(WINDOW_SECONDS - 1 + GRACE_SECONDS)  # 勝ち抜け確定で新しいウィンドウ
        events = s.tick(WINDOW_SECONDS - 1 + GRACE_SECONDS + WINDOW_SECONDS)
        self.assertEqual(types_of(events), ["extended"])  # 強制終了ではなく延長になる

    def test_ignored_declarations(self):
        s = make_session()
        s.declare(1, 1, 0.0)
        s.tick(GRACE_SECONDS)  # 1が勝ち抜け
        self.assertEqual(s.declare(1, 2, 3.0), [])       # 抜け済みの人
        self.assertEqual(s.declare(99, 2, 3.0), [])      # 不参加の人
        s.declare(2, 9, 3.0)                              # 2は番号違いで退場
        self.assertEqual(s.declare(2, 2, 3.5), [])       # 退場済みの人
        s.tick(3.5 + WINDOW_SECONDS * 2)                  # 残りは3だけ…強制終了で締める
        self.assertEqual(s.declare(3, 2, 99.0), [])      # ラウンド終了後

    def test_pending_users_own_declarations_ignored(self):
        s = make_session()
        s.declare(1, 1, 0.0)
        self.assertEqual(s.declare(1, 1, 0.5), [])  # 同じ番号の二重宣言
        self.assertEqual(s.declare(1, 2, 0.5), [])  # 保留中の別番号も無視
        self.assertEqual(s.outs[1], 0)

    def test_wrong_during_grace_then_escape_and_last_one(self):
        s = make_session()
        s.declare(1, 1, 0.0)                       # 最初の宣言（保留）
        events = s.declare(2, 7, 0.5)              # 猶予中の番号違いは有効
        self.assertEqual(types_of(events), ["wrong_number"])
        self.assertIsNotNone(s.pending)            # 保留は維持される
        events = s.tick(GRACE_SECONDS)
        self.assertEqual(types_of(events), ["escape", "last_one_out", "round_end"])
        self.assertEqual(s.outs[2], 1)
        self.assertEqual(s.outs[3], 1)


class MatchOutcomeTest(unittest.TestCase):
    def test_full_match_champion(self):
        s = make_session()
        # R1: 1と2がカブり（両者1アウト）
        s.declare(1, 1, 0.0)
        s.declare(2, 1, 0.5)
        self.assertTrue(s.round_over)
        # R2: また1と2がカブり（両者2アウト）
        s.start_round(100.0)
        s.declare(1, 1, 100.0)
        s.declare(2, 1, 100.5)
        # R3: 1が番号違いで3アウト目（脱落）。2が抜け、3が最後の1人アウト
        s.start_round(200.0)
        s.declare(1, 5, 200.0)
        s.declare(2, 1, 200.5)
        events = s.tick(200.5 + GRACE_SECONDS)
        self.assertIn("round_end", types_of(events))
        self.assertIn(1, s.eliminated)
        self.assertFalse(s.finished)
        # R4: 2が番号違いで3アウト目（脱落）。残った3も最後の1人アウトだが、優勝は3
        s.start_round(300.0)
        events = s.declare(2, 5, 300.0)
        self.assertIn("match_end", types_of(events))
        self.assertTrue(s.finished)
        self.assertEqual(s.champions, [3])
        self.assertFalse(s.draw)

    def test_draw_when_all_reach_three_together(self):
        s = make_session(players=(1, 2))
        # R1: カブり（両者1アウト）
        s.declare(1, 1, 0.0)
        s.declare(2, 1, 0.5)
        # R2: 1が番号違い（2アウト目）、残った2も最後の1人アウト（2アウト目）
        s.start_round(100.0)
        s.declare(1, 9, 100.0)
        self.assertEqual(s.outs, {1: 2, 2: 2})
        # R3: カブりで両者同時に3アウト → 引き分け
        s.start_round(200.0)
        s.declare(1, 1, 200.0)
        events = s.declare(2, 1, 200.5)
        self.assertIn("match_end", types_of(events))
        self.assertTrue(s.finished)
        self.assertTrue(s.draw)
        self.assertEqual(s.champions, [])

    def _silent_round(self, s, t):
        s.start_round(t)
        s.tick(t + WINDOW_SECONDS)
        events = s.tick(t + WINDOW_SECONDS * 2)
        self.assertIn("forced_end", types_of(events))

    def test_round_limit_fewest_outs_wins(self):
        s = make_session()
        # R1: 1が番号違い（1アウト）、2が抜け、3が最後の1人（1アウト）
        s.declare(1, 9, 0.0)
        s.declare(2, 1, 0.5)
        s.tick(0.5 + GRACE_SECONDS)
        # R2〜R10: 全ラウンド無宣言で強制終了
        for r in range(2, MAX_ROUNDS + 1):
            self._silent_round(s, r * 100.0)
        self.assertTrue(s.finished)
        self.assertEqual(s.round_no, MAX_ROUNDS)
        self.assertEqual(s.champions, [2])  # アウト0の2が単独優勝
        self.assertFalse(s.draw)

    def test_round_limit_joint_champions(self):
        s = make_session()
        for r in range(2, MAX_ROUNDS + 1):
            self._silent_round(s, r * 100.0)
        self.assertTrue(s.finished)
        self.assertEqual(sorted(s.champions), [1, 2, 3])  # 全員アウト0で共同優勝


# ======================================================================
# CPU
# ======================================================================
class CpuTest(unittest.TestCase):
    def test_cpu_plans_and_due(self):
        s = make_session(players=(1, 2, 3), cpus={2, 3}, seed=5)
        due = s.due_cpu(1000.0)  # 予定時刻を大きく過ぎれば、計画したCPUは全員due
        self.assertTrue(set(due) <= {2, 3})
        self.assertEqual(s.due_cpu(1000.0), [])  # 消費済み

    def test_cpu_number_mostly_target(self):
        s = make_session(cpus={1}, seed=42)
        wrong = sum(1 for _ in range(200) if s.cpu_number(1) != s.target)
        self.assertLess(wrong, 40)  # 間違えるのは約1割のはず

    def test_cpu_only_match_completes(self):
        s = NyokkiSession([1, 2, 3], cpu_ids={1, 2, 3}, rng=random.Random(3))
        t = 0.0
        s.start_round(t)
        for _ in range(200000):
            if s.finished:
                break
            if s.round_over:
                s.start_round(t)
                continue
            for uid in s.due_cpu(t):
                s.declare(uid, s.cpu_number(uid), t)
            s.tick(t)
            t += 0.5
        self.assertTrue(s.finished)
        self.assertLessEqual(s.round_no, MAX_ROUNDS)
        if not s.draw:
            self.assertTrue(s.champions)
            self.assertTrue(set(s.champions) <= {1, 2, 3})


# ======================================================================
# cog（チャット宣言の受付と進行）
# ======================================================================
class ReactableMessage(FakeChatMessage):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.reactions = []

    async def add_reaction(self, emoji):
        self.reactions.append(emoji)


class VirtualClock:
    def __init__(self):
        self.t = 0.0

    def now(self):
        return self.t

    async def sleep(self, delay):
        self.t += delay
        await asyncio.sleep(0)


class CogMessageTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.guild = FakeGuild()
        self.channel = FakeChannel(400, self.guild)
        self.other_channel = FakeChannel(401, self.guild)
        self.members = {uid: FakeMember(uid, self.guild) for uid in (1, 2, 3)}
        self.cog = Nyokki(types.SimpleNamespace())
        self.clock = [0.0]
        self.cog._now = lambda: self.clock[0]
        session = NyokkiSession([1, 2, 3], rng=random.Random(1))
        session.start_round(0.0)
        self.session = session
        self.match = _Match(self.channel, session)
        self.cog.matches[self.channel.id] = self.match

    async def say(self, uid, text, channel=None):
        message = ReactableMessage(self.members[uid], channel or self.channel, text)
        await self.cog.on_message(message)
        return message

    async def test_first_declaration_reacts_sprout(self):
        message = await self.say(1, "1ニョッキ！")
        self.assertEqual(message.reactions, ["🌱"])
        self.assertIsNotNone(self.session.pending)

    async def test_chat_text_is_not_a_declaration(self):
        message = await self.say(1, "1ニョッキ！って言えばいいの？")
        self.assertEqual(message.reactions, [])
        self.assertIsNone(self.session.pending)

    async def test_non_participant_and_other_channel_ignored(self):
        outsider = FakeMember(99, self.guild)
        message = ReactableMessage(outsider, self.channel, "1ニョッキ！")
        await self.cog.on_message(message)
        self.assertIsNone(self.session.pending)
        message = await self.say(1, "1ニョッキ！", channel=self.other_channel)
        self.assertEqual(message.reactions, [])
        self.assertIsNone(self.session.pending)

    async def test_bot_author_ignored(self):
        bot_member = FakeMember(50, self.guild)
        bot_member.bot = True
        message = ReactableMessage(bot_member, self.channel, "1ニョッキ！")
        await self.cog.on_message(message)
        self.assertIsNone(self.session.pending)

    async def test_collision_reactions_and_announcement(self):
        first = await self.say(1, "1ニョッキ！")
        second = await self.say(2, "1ニョッキ！")
        self.assertEqual(first.reactions, ["🌱", "💥"])
        self.assertEqual(second.reactions, ["💥"])
        self.assertTrue(self.session.round_over)
        self.assertTrue(any("カブり" in t for t in self.channel.texts()))

    async def test_late_same_number_is_wrong_number(self):
        await self.say(1, "1ニョッキ！")
        self.clock[0] = GRACE_SECONDS + 0.5  # 猶予を過ぎてから同じ番号
        message = await self.say(2, "1ニョッキ！")
        self.assertEqual(message.reactions, ["❌"])
        self.assertEqual(self.session.outs[2], 1)
        self.assertIn(1, self.session.escaped)


class CogMatchFlowTest(unittest.IsolatedAsyncioTestCase):
    async def test_match_with_cpus_runs_to_final_result(self):
        guild = FakeGuild()
        channel = FakeChannel(400, guild)
        cog = Nyokki(types.SimpleNamespace())
        clock = VirtualClock()
        cog._now = clock.now
        cog._sleep = clock.sleep
        session = NyokkiSession([1, -1001, -1002], cpu_ids={-1001, -1002},
                                rng=random.Random(7))
        match = _Match(channel, session)
        cog.matches[channel.id] = match
        await cog._run_match(match)
        self.assertTrue(match.over)
        self.assertTrue(session.finished)
        texts = channel.texts()
        self.assertTrue(any("最終結果" in t for t in texts))
        # CPU の宣言が Bot の発言としてチャンネルに出ていること
        self.assertTrue(any("ニョッキ！" in (m.content or "") for m in channel.sent))

    async def test_lobby_to_match_end_to_end(self):
        guild = FakeGuild()
        channel = FakeChannel(400, guild)
        host = FakeMember(1, guild)
        guest = FakeMember(2, guild)
        cog = Nyokki(types.SimpleNamespace())
        clock = VirtualClock()
        cog._now = clock.now
        cog._sleep = clock.sleep

        inter = FakeInteraction(host, channel)
        await cog.start_recruit(inter)
        panel = inter.response.sent[0].view
        buttons = {b.label: b for b in panel.walk_children()
                   if isinstance(b, discord.ui.Button)}
        lobby_msg = inter.response.sent[0]

        async def press(label, user):
            await buttons[label].callback(
                FakeInteraction(user, channel, message=lobby_msg))

        await press("参加する", guest)
        await press("CPUを追加（ホスト）", host)
        await press("開始する（ホスト）", host)
        for _ in range(200000):
            await asyncio.sleep(0)
            if channel.id not in cog.channels:
                break
        self.assertNotIn(channel.id, cog.channels)  # 後片付けまで終わっている
        self.assertTrue(any("最終結果" in t for t in channel.texts()))


if __name__ == "__main__":
    unittest.main()
