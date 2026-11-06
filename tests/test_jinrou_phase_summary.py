"""表示モダン化 §4.2-9 ＋ 人狼 V2 移行: 人狼のフェーズ区切り結果のパネル集約。

追放結果（肩代わり/追放/道連れ）は個別の実況ラインではなく
1枚の「追放結果」V2 パネルで送られ、勝敗確定も V2 パネルになること。
実況ライン（投票なし等）は従来どおりプレーンのまま。
"""
import types
import unittest
from unittest.mock import AsyncMock, patch

import discord

from core.game.jinrou.common import phase_summary_view
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

    def panel_texts(self):
        """送信された V2 パネル（view）の表示テキスト一覧。"""
        texts = []
        for _c, kwargs in self.sent:
            view = kwargs.get("view")
            if view is not None:
                texts.append("\n".join(
                    item.content or "" for item in view.walk_children()
                    if isinstance(item, discord.ui.TextDisplay)))
        return texts


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


class PhaseSummaryViewTest(unittest.TestCase):
    def test_builder_joins_lines(self):
        view = phase_summary_view("追放結果", ["1行目", "2行目"])
        self.assertIsInstance(view, discord.ui.LayoutView)
        text = "\n".join(
            item.content or "" for item in view.walk_children()
            if isinstance(item, discord.ui.TextDisplay))
        self.assertIn("追放結果", text)
        self.assertIn("1行目\n2行目", text)


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

    async def test_simple_exile_is_one_summary_panel(self):
        game, channel = await self.run_exile({1: "一般通過あごむに", 2: "一般通過あごむに", 3: "人狼"})
        self.assertEqual(len(channel.sent), 1)
        self.assertEqual(channel.embeds(), [])
        text = channel.panel_texts()[0]
        self.assertIn("追放結果", text)
        self.assertIn("P2 さんが追放されました。", text)
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
        self.assertEqual(len(channel.panel_texts()), 1)
        description = channel.panel_texts()[0]
        self.assertIn("肩代わりされました", description)
        self.assertIn("奴隷さん さんが追放されました。", description)
        self.assertIn("相方さん も道連れになりました", description)


class VictorySummaryTest(unittest.IsolatedAsyncioTestCase):
    async def test_village_victory_is_panel(self):
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
        self.assertEqual(len(channel.panel_texts()), 1)
        text = channel.panel_texts()[0]
        self.assertIn("勝敗確定", text)
        self.assertIn("村人陣営の勝利", text)


if __name__ == "__main__":
    unittest.main()
