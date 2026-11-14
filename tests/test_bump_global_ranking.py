# -*- coding: utf-8 -*-
"""boardNotify RTA 統合ボードの表示導線のテスト。Discord には接続しない。

- /general の新ジャンル boardnotify_rta に統合ボード（rta_board）がある
  （その後、別機能のボードとして ぬるぽRTA（nurupo_board）が同居した）
- 旧 bump/up 個別ボード8件はジャンルにもレジストリにも無い
- dispatch_general は rta_board で統合ボードを開き、旧8件の ID は互換
  プリセット（スコープ/最速最遅のみ引き継ぎ）として統合ボードに着地する
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

OLD_BOARD_VALUES = (
    "bump_leaderboard", "up_leaderboard",
    "bump_global_leaderboard", "up_global_leaderboard",
    "bump_slowest", "up_slowest",
    "bump_global_slowest", "up_global_slowest",
)


class UnifiedBoardGenreTest(unittest.TestCase):
    def test_boardnotify_rta_genre_actions(self):
        from core.general.common import GENERAL_ACTIONS, GENERAL_GENRES

        self.assertEqual(GENERAL_GENRES["boardnotify_rta"][0], "boardNotify RTA")
        # 統合ボード1件が要（旧 bump/up 個別ボードは置かない）。ぬるぽRTA
        # ボードは別機能のボードとして同ジャンルに並ぶ（2026-11-10）。
        self.assertEqual(
            GENERAL_ACTIONS["boardnotify_rta"],
            [("RTAランキング", "rta_board"), ("ぬるぽRTA", "nurupo_board")])

    def test_old_board_actions_removed_everywhere(self):
        from core.general.common import GENERAL_ACTIONS
        from core.general import action_registry

        all_values = [v for items in GENERAL_ACTIONS.values() for _label, v in items]
        registry = action_registry.default_registry()
        for value in OLD_BOARD_VALUES:
            self.assertNotIn(value, all_values, value)
            self.assertIsNone(registry.get(f"general:{value}"), value)

    def test_rankings_genre_keeps_only_bundle_and_asset(self):
        from core.general.common import GENERAL_ACTIONS

        values = [v for _label, v in GENERAL_ACTIONS["rta"]]
        # 統合の趣旨は「旧 bump/up 個別ボードを rta ジャンルに残さない」こと。
        # 即抜けRTAボードは別機能のボードとして同ジャンルに並ぶ（2026-11-08）。
        self.assertEqual(values, ["rankings", "asset_leaderboard", "sokunuke_board"])

    def test_board_action_registered_in_new_genre(self):
        from core.general import action_registry

        spec = action_registry.default_registry().get("general:rta_board")
        self.assertIsNotNone(spec)
        self.assertEqual(spec.genre, "boardnotify_rta")

    def test_registry_totals_after_unification(self):
        # 旧8件 → 統合1件で general 76→69 / 全体 251→244（実 import での検証値）。
        # Luna AI 追加で全体 244→245、その後、即抜けRTAボード（general:sokunuke_board）追加で
        # general 69→70 / 全体 245→246。人物分析（support:person_analysis）追加で全体 246→247。
        # おみくじ（general:omikuji、新ジャンル「占い」）追加で general 70→71 / 全体 247→248。
        # サーバー分析（support:server_analytics）追加で全体 248→249。
        # DiscordServers.io 入口（support:bumprta_dsio）追加で全体 249→250。
        # DISCOM 入口（support:bumprta_discom）追加で全体 250→251。
        # ぬるぽRTAボード（general:nurupo_board）追加で general 71→72 / 全体 251→252。
        # にょっきゲーム（game:nyokki_started）追加で全体 252→253。
        # 地震情報（support:earthquake）追加で全体 253→254。
        # 天気（general:weather、新ジャンル「ユーティリティ」）追加で general 72→73 / 全体 254→255。
        # gvc_members のショートカット登録漏れ是正で vc 45→46 / 全体 255→256。
        # ニュース通知（support:news_notify）追加で全体 256→257。
        # 即抜けRTA設定の統合（support 5件→設定パネル1件）で全体 257→253。
        # サーバー対抗ランキング（general:server_ranking）追加で general 73→74 / 全体 253→254。
        # 背景透過・絵文字/スタンプ化（general:bg_cutout）追加で general 74→75 / 全体 254→255。
        from core.general import action_registry

        specs = list(action_registry.default_registry()._by_id.values())
        self.assertEqual(len(specs), 255)
        self.assertEqual(len([s for s in specs if s.root == "general"]), 75)


class UnifiedBoardDispatchTest(unittest.IsolatedAsyncioTestCase):
    def make_cog_and_interaction(self, rta):
        from cogs.general import GeneralCog

        cog = GeneralCog.__new__(GeneralCog)
        cog.bot = types.SimpleNamespace(
            get_cog=lambda name: rta if name == "BumpRta" else None)
        interaction = types.SimpleNamespace(
            guild_id=123, guild=None,
            user=types.SimpleNamespace(id=456, display_name="自分"),
            response=types.SimpleNamespace(
                is_done=lambda: False,
                send_message=AsyncMock(),
                defer=AsyncMock(),
            ),
            followup=types.SimpleNamespace(send=AsyncMock()),
        )
        return cog, interaction

    async def dispatch(self, value):
        from core.general import action_usage
        from core.support import command_control
        import discord

        rta = types.SimpleNamespace(
            build_rta_board=AsyncMock(
                return_value=(discord.Embed(title="ボード"), None)))
        cog, interaction = self.make_cog_and_interaction(rta)
        with mock.patch.object(command_control, "guard", new=AsyncMock(return_value=True)), \
                mock.patch.object(action_usage, "record_safely_in_background", lambda *a: None):
            await cog.dispatch_general(interaction, value)
        return rta, interaction

    def board_view(self, interaction):
        kwargs = interaction.followup.send.await_args.kwargs
        return kwargs["view"].panel

    async def test_rta_board_opens_with_defaults(self):
        rta, interaction = await self.dispatch("rta_board")
        view = self.board_view(interaction)
        self.assertEqual(view.scope, "local")
        self.assertFalse(view.slowest)
        args, kwargs = rta.build_rta_board.await_args
        self.assertEqual(args, ("local", False))
        self.assertEqual(kwargs["guild_id"], 123)
        self.assertEqual(kwargs["user_id"], 456)

    async def test_legacy_local_fastest_presets(self):
        # 統合ボードではサービスは引き継がず、スコープと方向だけを引き継ぐ
        for value in ("bump_leaderboard", "up_leaderboard"):
            _rta, interaction = await self.dispatch(value)
            view = self.board_view(interaction)
            self.assertEqual((view.scope, view.slowest),
                             ("local", False), value)

    async def test_legacy_global_fastest_presets(self):
        for value in ("bump_global_leaderboard", "up_global_leaderboard"):
            _rta, interaction = await self.dispatch(value)
            view = self.board_view(interaction)
            self.assertEqual((view.scope, view.slowest),
                             ("global", False), value)

    async def test_legacy_slowest_presets(self):
        for value, scope in (("bump_slowest", "local"),
                             ("up_slowest", "local"),
                             ("bump_global_slowest", "global"),
                             ("up_global_slowest", "global")):
            _rta, interaction = await self.dispatch(value)
            view = self.board_view(interaction)
            self.assertEqual((view.scope, view.slowest),
                             (scope, True), value)


if __name__ == "__main__":
    unittest.main()
