"""人狼の Components V2 移行の回帰テスト。

- 人狼の全 View が LayoutView（V2）で、コンポーネント上限内に収まること
- 4つのフェーズ境界スナップショットから復旧すると、再開パネルが
  V2（RoleCheckView）で再描画され、境界どおり再開されること
- 投票パネルは役割を終えたら削除されること（残留クリーンアップ）
"""
import asyncio
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

ROOT = Path(__file__).resolve().parents[1]
for p in (ROOT, ROOT / "tests"):
    if str(p) not in sys.path:
        sys.path.insert(0, str(p))

import discord  # noqa: E402

import game_fakes  # noqa: E402,F401  （環境変数などの準備）
from game_fakes import FakeBot, FakeChannel, FakeGuild, FakeMember, fast_time  # noqa: E402
from cogs import jinrou  # noqa: E402
from core.game import jinrou_review, jinrou_snapshot  # noqa: E402
from core.game.game_v2 import assert_within_limits  # noqa: E402
from core.game.jinrou import gameloop  # noqa: E402
from core.game.jinrou.common import phase_summary_view  # noqa: E402
from core.game.jinrou.game import JinrouGame  # noqa: E402
from core.game.jinrou.views import (  # noqa: E402
    ActionSelectView, AdvancedSetupView, ChairmanVoteView, GlobalJoinView,
    NightActionView, PublicVoteView, RecruitView, ReplayView, RoleCheckView,
    SetupView,
)


def view_text(view):
    return "\n".join(
        item.content or "" for item in view.walk_children()
        if isinstance(item, discord.ui.TextDisplay))


def make_game(guild, channel, n=5):
    game = JinrouGame()
    game.game_channel = channel
    game.players = [FakeMember(i, guild) for i in range(1, n + 1)]
    game.alive_players = list(game.players)
    game.roles = {i: "一般通過あごむに" for i in range(1, n + 1)}
    game.roles[1] = "人狼"
    game.host_id = 1
    game.day_count = 2
    game.is_running = True
    return game


class AllViewsAreV2Test(unittest.TestCase):
    def setUp(self):
        self.guild = FakeGuild()
        self.channel = FakeChannel(300, self.guild)
        self.game = make_game(self.guild, self.channel)
        opts = [discord.SelectOption(label=p.display_name, value=str(p.id))
                for p in self.game.alive_players]

    def test_all_jinrou_views_are_layout_views(self):
        opts = [discord.SelectOption(label=p.display_name, value=str(p.id))
                for p in self.game.alive_players]
        views = [
            SetupView(self.game, cog=None, channel=self.channel),
            AdvancedSetupView(self.game, cog=None, channel=self.channel),
            RecruitView(self.game, cog=None),
            ReplayView(self.game, cog=None, body="P1: 人狼"),
            GlobalJoinView(cog=None, game=self.game),
            RoleCheckView(self.game, cog=None),
            NightActionView(self.game),
            ActionSelectView(self.game, opts, "占い師", actor_id=2),
            PublicVoteView(self.game, opts),
            ChairmanVoteView(self.game, opts),
            phase_summary_view("追放結果", ["P1 さんが追放されました。"]),
            jinrou_review.build_view(self.game),
        ]
        for view in views:
            self.assertIsInstance(view, discord.ui.LayoutView, type(view).__name__)
            assert_within_limits(view)


class RestoreRecoveryTest(unittest.IsolatedAsyncioTestCase):
    async def restore(self, boundary):
        guild = FakeGuild()
        channel = FakeChannel(900, guild)
        src = make_game(guild, channel)
        state = jinrou_snapshot.build_state(src, boundary)
        self.assertIsNotNone(state)

        cog = jinrou.JinrouCog.__new__(jinrou.JinrouCog)
        cog.games = {}
        cog.bot = FakeBot(channel)
        cog.get_game = lambda cid: cog.games.setdefault(cid, JinrouGame())

        with patch.object(gameloop, "resume_game_loop", new=AsyncMock()) as resume:
            ok = await gameloop._restore_jinrou_session(cog, channel.id, {"state": state})
            for _ in range(3):
                await asyncio.sleep(0)
        return ok, resume, channel

    async def test_restore_from_every_boundary_renders_v2_panel(self):
        for boundary in jinrou_snapshot.BOUNDARIES:
            ok, resume, channel = await self.restore(boundary)
            self.assertTrue(ok, boundary)
            # 境界どおりの再開がスケジュールされること
            resume.assert_awaited_once()
            self.assertEqual(resume.await_args.args[3], boundary)
            # 再開パネルは V2 の RoleCheckView で、Embed は付かないこと
            self.assertEqual(len(channel.sent), 1)
            message = channel.sent[0]
            self.assertIsInstance(message.view, RoleCheckView)
            self.assertIsInstance(message.view, discord.ui.LayoutView)
            self.assertEqual(message.embeds, [])
            text = message.text()
            self.assertIn("再開します", text)
            self.assertIn(gameloop._BOUNDARY_LABELS[boundary], text)


class VotePanelCleanupTest(unittest.IsolatedAsyncioTestCase):
    async def test_vote_panel_is_deleted_after_phase(self):
        guild = FakeGuild()
        channel = FakeChannel(901, guild)
        game = make_game(guild, channel)
        cog = jinrou.JinrouCog.__new__(jinrou.JinrouCog)
        cog._autoplay_votes = AsyncMock()
        with fast_time():
            await cog.run_voting_phase(game)
        panel_messages = [m for m in channel.sent if isinstance(m.view, PublicVoteView)]
        self.assertEqual(len(panel_messages), 1)
        self.assertTrue(panel_messages[0].deleted)


if __name__ == "__main__":
    unittest.main()
