"""表示モダン化 §4.2-9: 人狼のフェーズ区切り結果の embed 集約。

追放結果（肩代わり/追放/道連れ）は個別の実況ラインではなく
1枚の「追放結果」embed で送られ、勝敗確定も embed になること。
実況ライン（投票なし等）は従来どおりプレーンのまま。
"""
import types
import unittest
from unittest.mock import AsyncMock, patch

import discord

from core.game.jinrou.common import phase_summary_embed
from core.game.jinrou.gameloop import GameLoopMixin
from core.game.jinrou.results import ResultsMixin


def member(uid, name):
    return types.SimpleNamespace(id=uid, display_name=name, mention=f"<@{uid}>")


class FakeChannel:
    def __init__(self, members):
        self.sent = []
        self.guild = types.SimpleNamespace(
            get_member=lambda uid: members.get(uid))

    async def send(self, content=None, **kwargs):
        self.sent.append((content, kwargs))
        return types.SimpleNamespace(delete=AsyncMock())

    def embeds(self):
        return [kwargs["embed"] for _c, kwargs in self.sent if kwargs.get("embed")]


def make_game(channel, players, roles):
    return types.SimpleNamespace(
        is_running=True,
        game_channel=channel,
        players=list(players),
        alive_players=list(players),
        roles=dict(roles),
        kizoku_slave={},
        riacchu_pairs=[],
        silenced_players=set(),
        last_executed=None,
    )


class PhaseSummaryEmbedTest(unittest.TestCase):
    def test_builder_joins_lines(self):
        embed = phase_summary_embed("追放結果", ["1行目", "2行目"])
        self.assertIsInstance(embed, discord.Embed)
        self.assertEqual(embed.title, "追放結果")
        self.assertEqual(embed.description, "1行目\n2行目")


class ExileSummaryTest(unittest.IsolatedAsyncioTestCase):
    async def run_exile(self, roles, target_id=2):
        players = [member(1, "P1"), member(2, "P2"), member(3, "P3")]
        channel = FakeChannel({p.id: p for p in players})
        game = make_game(channel, players, roles)
        mixin = ResultsMixin.__new__(ResultsMixin)
        mixin._notify_reibai = AsyncMock()
        mixin._check_mokumoku_reveal = AsyncMock()
        mixin._record_wins = AsyncMock()
        with patch("core.game.jinrou.results._check_and_reveal_ura_yakushoku", new=AsyncMock()):
            await mixin.apply_forced_execution(game, target_id)
        return game, channel

    async def test_simple_exile_is_one_summary_embed(self):
        game, channel = await self.run_exile({1: "一般通過あごむに", 2: "一般通過あごむに", 3: "人狼"})
        self.assertEqual(len(channel.sent), 1)
        embed = channel.embeds()[0]
        self.assertEqual(embed.title, "追放結果")
        self.assertIn("P2 さんが追放されました。", embed.description)
        self.assertNotIn(game.alive_players and 2, [p.id for p in game.alive_players])

    async def test_slave_substitution_and_partner_are_aggregated(self):
        players = [member(1, "貴族さん"), member(2, "奴隷さん"), member(3, "相方さん")]
        channel = FakeChannel({p.id: p for p in players})
        game = make_game(channel, players, {1: "貴族", 2: "奴隷", 3: "一般通過あごむに"})
        game.kizoku_slave = {1: 2}
        game.riacchu_pairs = [(2, 3)]
        mixin = ResultsMixin.__new__(ResultsMixin)
        mixin._notify_reibai = AsyncMock()
        mixin._check_mokumoku_reveal = AsyncMock()
        mixin._record_wins = AsyncMock()
        with patch("core.game.jinrou.results._check_and_reveal_ura_yakushoku", new=AsyncMock()):
            await mixin.apply_forced_execution(game, 1)
        self.assertEqual(len(channel.embeds()), 1)
        description = channel.embeds()[0].description
        self.assertIn("肩代わりされました", description)
        self.assertIn("奴隷さん さんが追放されました。", description)
        self.assertIn("相方さん も道連れになりました", description)


class VictorySummaryTest(unittest.IsolatedAsyncioTestCase):
    async def test_village_victory_is_embed(self):
        players = [member(1, "P1"), member(2, "P2")]
        channel = FakeChannel({p.id: p for p in players})
        game = make_game(channel, players, {1: "一般通過あごむに", 2: "占い師"})
        game.day_count = 2
        mixin = GameLoopMixin.__new__(GameLoopMixin)
        mixin._check_koumorimuni_win = AsyncMock()
        mixin._record_team_win = AsyncMock()
        mixin._process_elo_ratings = AsyncMock()
        result = await mixin.check_victory(game)
        self.assertTrue(result)
        self.assertEqual(len(channel.embeds()), 1)
        embed = channel.embeds()[0]
        self.assertEqual(embed.title, "勝敗確定")
        self.assertIn("村人陣営の勝利", embed.description)


if __name__ == "__main__":
    unittest.main()
