"""人狼まわりのセーフティ修正（監査 A-1/A-3/A-4/B-5/E-11/E-12）の回帰テスト。

対象:
- A-1: game_restore ストアに jinrou が登録され、保存→再読込の往復が成立する
- A-3: 参加上限 24 人（25 人目を断る）
- A-4: 除外役職セレクト分割で全 26 役職が選べる／ADV_ROLES にネット民
- B-5: ActionSelectView の実行者検証
- E-11: 開始後の参加者 force_end は投了として Elo 記録経路を呼ぶ
- E-12: assign_roles がモジュール global random を使わない
"""
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

ROOT = Path(__file__).resolve().parents[1]
for p in (ROOT, ROOT / "tests"):
    if str(p) not in sys.path:
        sys.path.insert(0, str(p))

import game_fakes  # noqa: E402,F401
from game_fakes import FakeBot, FakeChannel, FakeGuild, FakeInteraction, FakeMember, choose, press  # noqa: E402

import discord  # noqa: E402
from cogs import jinrou  # noqa: E402
from core.game import game_restore, jinrou_snapshot  # noqa: E402
from core.game.jinrou.game import JinrouGame  # noqa: E402
from core.game.jinrou.ratings import surrender_winner_is_wolf  # noqa: E402
from core.game.jinrou.views import (  # noqa: E402
    MAX_PLAYERS, ActionSelectView, AdvancedSetupView, RecruitView, SetupView,
)


def _member(uid, guild=None):
    if guild is not None:
        return FakeMember(uid, guild)
    return types.SimpleNamespace(id=uid, display_name=f"user{uid}", name=f"user{uid}",
                                 mention=f"<@{uid}>", bot=False)


class SnapshotRoundtripTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "game_restore.json"
        game_restore.reset_store(self.path)
        self.addCleanup(self._reset_singleton)

    @staticmethod
    def _reset_singleton():
        with game_restore._store_lock:
            game_restore._store = None

    def test_jinrou_in_game_ids(self):
        self.assertIn("jinrou", game_restore.GAME_IDS)

    def test_save_and_reload_roundtrip(self):
        ok = game_restore.save_session("jinrou", 123, 456, {"boundary": "night_start", "day_count": 2})
        self.assertTrue(ok)
        self.assertTrue(game_restore.flush_store())
        # 新規ストアで同じファイルから再読込する
        game_restore.reset_store(self.path)
        entries = game_restore.session_entries("jinrou")
        self.assertIn(123, entries)
        self.assertEqual(entries[123]["state"]["boundary"], "night_start")
        self.assertEqual(entries[123]["state"]["day_count"], 2)
        self.assertEqual(entries[123]["guild_id"], 456)

    def test_save_unknown_game_returns_false(self):
        self.assertFalse(game_restore.save_session("no_such_game", 1, 1, {}))
        self.assertEqual(game_restore.session_entries("jinrou"), {})

    def test_save_boundary_safely_roundtrip_and_failure(self):
        game = JinrouGame()
        game.game_channel = types.SimpleNamespace(id=555, guild=types.SimpleNamespace(id=777))
        game.players = [_member(i) for i in range(1, 6)]
        game.alive_players = list(game.players)
        game.roles = {i: "一般通過あごむに" for i in range(1, 6)}
        game.host_id = 1
        self.assertTrue(jinrou_snapshot.save_boundary_safely(game, "night_start"))
        game_restore.reset_store(self.path)
        entries = game_restore.session_entries("jinrou")
        self.assertIn(555, entries)
        # 保存が失敗する条件（対象外の境界）では True を返さない
        self.assertFalse(jinrou_snapshot.save_boundary_safely(game, "mid_night"))
        # ストア側が失敗した場合も True を返さない
        with patch.object(game_restore, "save_session", return_value=False):
            self.assertFalse(jinrou_snapshot.save_boundary_safely(game, "night_start"))


class RecruitCapTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.guild = FakeGuild()
        self.channel = FakeChannel(300, self.guild)

    def make_game(self, n):
        game = JinrouGame()
        game.players = [FakeMember(i, self.guild) for i in range(1, n + 1)]
        game.host_id = 1
        return game

    async def test_max_players_is_24_for_vote_select(self):
        self.assertEqual(MAX_PLAYERS, 24)
        # 投票セレクト: 生存者 24 + スキップ 1 = 25（Discord 上限ちょうど）
        self.assertEqual(MAX_PLAYERS + 1, 25)

    async def test_25th_join_is_rejected(self):
        game = self.make_game(24)
        view = RecruitView(game, cog=None)
        newcomer = FakeMember(25, self.guild)
        inter = FakeInteraction(newcomer, self.channel)
        await press(view, "join", inter)
        self.assertEqual(len(game.players), 24)
        self.assertNotIn(25, [p.id for p in game.players])
        self.assertIn("定員", inter.texts()[0])

    async def test_24th_join_is_accepted(self):
        game = self.make_game(23)
        view = RecruitView(game, cog=None)
        newcomer = FakeMember(24, self.guild)
        inter = FakeInteraction(newcomer, self.channel)
        await press(view, "join", inter)
        self.assertEqual(len(game.players), 24)


class SetupRolesTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.guild = FakeGuild()
        self.channel = FakeChannel(300, self.guild)
        self.game = JinrouGame()

    def test_all_roles_reachable_in_exclude_selects(self):
        view = SetupView(self.game, cog=None, channel=self.channel)
        selects = [c for c in view.walk_children() if isinstance(c, discord.ui.Select)]
        for sel in selects:
            self.assertLessEqual(len(sel.options), 25)
        exc_selects = [s for s in selects if "除外" in (s.placeholder or "")]
        self.assertEqual(len(exc_selects), 2)
        values = [opt.value for s in exc_selects for opt in s.options]
        self.assertEqual(len(SetupView.ALL_ROLES), 26)
        self.assertEqual(set(values), set(SetupView.ALL_ROLES))
        self.assertEqual(len(values), len(set(values)))
        self.assertIn("ヤンデレ", values)

    async def test_yandere_selectable_via_second_exclude_select(self):
        view = SetupView(self.game, cog=None, channel=self.channel)
        inter = types.SimpleNamespace(
            data={"values": ["ヤンデレ"]},
            response=types.SimpleNamespace(defer=AsyncMock()),
        )
        await view._exc_callback_b(inter)
        self.assertIn("ヤンデレ", self.game.excluded_roles)

    def test_adv_roles_include_netmin_and_fit_select(self):
        self.assertIn("ネット民", AdvancedSetupView.ADV_ROLES)
        self.assertLessEqual(len(AdvancedSetupView.ADV_ROLES), 25)
        self.game.required_roles = []
        view = AdvancedSetupView(self.game, cog=None, channel=self.channel)
        selects = [c for c in view.walk_children() if isinstance(c, discord.ui.Select)]
        self.assertEqual(len(selects), 1)
        self.assertEqual([o.value for o in selects[0].options], AdvancedSetupView.ADV_ROLES)


class NightActionGuardTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.guild = FakeGuild()
        self.channel = FakeChannel(300, self.guild)
        self.players = [FakeMember(i, self.guild) for i in range(1, 6)]

    def make_game(self):
        game = JinrouGame()
        game.game_channel = self.channel
        game.players = list(self.players)
        game.alive_players = list(self.players[:4])  # 5 番は死亡済み
        game.roles = {1: "占い師", 2: "人狼", 3: "騎士", 4: "一般通過あごむに", 5: "占い師"}
        game.started = True
        game.is_running = True
        game.in_night_phase = True
        game.day_count = 1
        return game

    def make_view(self, game, actor_id=1):
        opts = [discord.SelectOption(label=p.display_name, value=str(p.id))
                for p in game.alive_players if p.id != actor_id]
        return ActionSelectView(game, opts, "占い師", actor_id=actor_id)

    async def act(self, game, view, user, target="2"):
        inter = FakeInteraction(user, self.channel)
        await choose(view.select, target, inter)
        return inter

    async def test_valid_seer_action_is_recorded(self):
        game = self.make_game()
        view = self.make_view(game)
        inter = await self.act(game, view, self.players[0])
        self.assertEqual(game.night_actions.get(1), 2)
        self.assertIn("占い結果", inter.texts()[0])

    async def test_dead_player_is_rejected(self):
        game = self.make_game()
        view = self.make_view(game, actor_id=5)
        inter = await self.act(game, view, self.players[4])
        self.assertNotIn(5, game.night_actions)
        self.assertNotIn("占い結果", " ".join(inter.texts()))

    async def test_wrong_role_is_rejected_and_no_divine_leak(self):
        game = self.make_game()
        view = self.make_view(game, actor_id=2)
        inter = await self.act(game, view, self.players[1], target="3")
        self.assertNotIn(2, game.night_actions)
        self.assertNotIn("占い結果", " ".join(inter.texts()))

    async def test_other_users_view_is_rejected(self):
        game = self.make_game()
        view = self.make_view(game, actor_id=1)
        # 占い師と同じ役職ではないが、他人の View を押したケース（actor 不一致）
        inter = await self.act(game, view, self.players[2], target="3")
        self.assertEqual(game.night_actions, {})

    async def test_not_night_phase_is_rejected(self):
        game = self.make_game()
        game.in_night_phase = False
        view = self.make_view(game)
        inter = await self.act(game, view, self.players[0])
        self.assertNotIn(1, game.night_actions)

    async def test_already_acted_is_rejected(self):
        game = self.make_game()
        game.night_actions = {1: 3}
        view = self.make_view(game)
        inter = await self.act(game, view, self.players[0])
        self.assertEqual(game.night_actions, {1: 3})


class ForceEndSurrenderTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.guild = FakeGuild()
        self.channel = FakeChannel(300, self.guild)
        self.players = [FakeMember(i, self.guild) for i in range(1, 6)]
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        game_restore.reset_store(Path(self.tmp.name) / "gr.json")
        self.addCleanup(self._reset_singleton)
        self.cog = jinrou.JinrouCog(FakeBot(self.channel))
        self.cog._process_elo_ratings = AsyncMock()
        self.cog._record_team_win = AsyncMock()

    @staticmethod
    def _reset_singleton():
        with game_restore._store_lock:
            game_restore._store = None

    def started_game(self):
        game = self.cog.get_game(self.channel.id)
        game.is_running = True
        game.started = True
        game.game_channel = self.channel
        game.players = list(self.players)
        game.alive_players = list(self.players)
        game.roles = {1: "人狼", 2: "占い師", 3: "騎士", 4: "一般通過あごむに", 5: "狂人"}
        game.host_id = 1
        return game

    async def test_villager_surrender_records_wolf_win(self):
        game = self.started_game()
        inter = FakeInteraction(self.players[1], self.channel)  # 占い師（村側）
        await self.cog.force_end(inter)
        self.assertFalse(game.is_running)
        self.cog._process_elo_ratings.assert_awaited_once_with(game, winner_is_wolf=True)
        self.cog._record_team_win.assert_awaited_once_with(game, winner_is_wolf=True)
        self.assertIn("投了", inter.texts()[0])

    async def test_wolf_surrender_records_village_win(self):
        game = self.started_game()
        inter = FakeInteraction(self.players[0], self.channel)  # 人狼
        await self.cog.force_end(inter)
        self.cog._process_elo_ratings.assert_awaited_once_with(game, winner_is_wolf=False)
        self.assertIn("投了", inter.texts()[0])

    async def test_surrender_helper(self):
        game = self.started_game()
        self.assertTrue(surrender_winner_is_wolf(game, 2))   # 村側が投了 → 狼の勝ち
        self.assertFalse(surrender_winner_is_wolf(game, 1))  # 狼が投了 → 村の勝ち
        self.assertIsNone(surrender_winner_is_wolf(game, 99))  # 非参加者
        game.started = False
        self.assertIsNone(surrender_winner_is_wolf(game, 2))  # 開始前

    async def test_recruiting_force_end_records_nothing(self):
        game = self.started_game()
        game.started = False
        game.roles = {}
        inter = FakeInteraction(self.players[0], self.channel)
        await self.cog.force_end(inter)
        self.assertFalse(game.is_running)
        self.cog._process_elo_ratings.assert_not_awaited()
        self.cog._record_team_win.assert_not_awaited()
        self.assertNotIn("投了", inter.texts()[0])

    async def test_outsider_cannot_force_end(self):
        game = self.started_game()
        outsider = FakeMember(99, self.guild)
        inter = FakeInteraction(outsider, self.channel)
        await self.cog.force_end(inter)
        self.assertTrue(game.is_running)
        self.cog._process_elo_ratings.assert_not_awaited()


class AssignRolesSystemRandomTest(unittest.TestCase):
    def setUp(self):
        self.guild = FakeGuild()
        self.players = [FakeMember(i, self.guild) for i in range(1, 9)]

    def test_assign_roles_does_not_use_global_random(self):
        import random as global_random
        cog = jinrou.JinrouCog.__new__(jinrou.JinrouCog)
        game = JinrouGame()
        game.players = list(self.players)
        game.game_mode = "プロ"
        with patch.object(global_random, "shuffle", side_effect=AssertionError("global shuffle used")), \
             patch.object(global_random, "choice", side_effect=AssertionError("global choice used")), \
             patch.object(global_random, "sample", side_effect=AssertionError("global sample used")), \
             patch.object(global_random, "random", side_effect=AssertionError("global random used")):
            cog.assign_roles(game)
        self.assertEqual(set(game.roles), {p.id for p in self.players})
        self.assertTrue(all(game.roles.values()))
        wolves = [r for r in game.roles.values() if r in ("人狼", "デカ狼")]
        self.assertGreaterEqual(len(wolves), 1)


if __name__ == "__main__":
    unittest.main()
