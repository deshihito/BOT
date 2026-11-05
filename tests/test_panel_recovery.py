"""PR-B: 操作パネルの固定 custom_id と、死んだパネルの再表示フォールバックのテスト。

- 各パネルの部品に ``panel:<root>:<part>`` 形式の固定 custom_id が付いていること
- cogs/panel_recovery.py の判定: 未応答なら正しい root のパネルを開き直す /
  応答済みなら何もしない / 対象外 custom_id には干渉しない
通信はしない (応答は Fake で記録するだけ)。
"""

import importlib
import types
import unittest
from unittest.mock import patch

import discord

from cogs import panel_recovery
from cogs.game import GameDetailView, GameHubView
from cogs.help import BackView, CommandView, HelpView
from cogs.sio_voice import VoicePanelView
from core.general.panel import GeneralPanel
from core.general.shortcuts import ShortcutCommitButton
from core.panel_v2 import PanelLayoutView
from core.support.panel import SUPPORT_GENRES, SupportPanelView


def child_ids(view):
    return {item.custom_id for item in view.children if getattr(item, "custom_id", None)}


def make_catalog():
    entry = {
        "kind": "slash", "name": "general", "category": "general",
        "summary": "一般機能のパネル", "usage": "/general", "guide": "ガイド本文",
        "permissions": [], "options": [], "aliases": [], "guild_only": False,
        "hidden": False,
    }
    return {
        "categories": [{"id": "general", "label": "一般", "description": "説明", "guide": ""}],
        "commands": [entry],
    }


class CustomIdTest(unittest.TestCase):
    def test_general_panel(self):
        # 導線最適化 M9: 通常パネルには登録ボタン（panel:general:register）が常駐
        self.assertEqual(child_ids(GeneralPanel(None)), {"panel:general:genre", "panel:general:register"})
        self.assertEqual(
            child_ids(GeneralPanel(None, genre="money")),
            {"panel:general:genre", "panel:general:action", "panel:general:register"},
        )
        specs = [types.SimpleNamespace(label="プレイヤー状況", value="status")]
        self.assertIn("panel:general:history", child_ids(GeneralPanel(None, history_specs=specs)))
        self.assertIn("panel:general:commit", child_ids(GeneralPanel(None, shortcut_mode=True)))

    def test_support_panel(self):
        genre = next(iter(SUPPORT_GENRES))
        self.assertEqual(child_ids(SupportPanelView(None)), {"panel:support:genre", "panel:support:register"})
        self.assertEqual(
            child_ids(SupportPanelView(None, genre=genre)),
            {"panel:support:genre", "panel:support:action", "panel:support:register"},
        )
        specs = [types.SimpleNamespace(label="プレイヤー状況", value="status")]
        self.assertIn("panel:support:history", child_ids(SupportPanelView(None, history_specs=specs)))
        self.assertIn("panel:support:commit", child_ids(SupportPanelView(None, shortcut_mode=True)))

    def test_voice_panel(self):
        self.assertEqual(child_ids(VoicePanelView(None)), {"panel:vc:genre", "panel:vc:register"})
        self.assertEqual(
            child_ids(VoicePanelView(None, genre="connection")),
            {"panel:vc:genre", "panel:vc:action", "panel:vc:register"},
        )
        self.assertIn("panel:vc:commit", child_ids(VoicePanelView(None, shortcut_mode=True)))

    def test_game_hub(self):
        # 導線最適化 M3: 初期表示から全ゲームセレクト（panel:game:select）も出す。
        # ラウンド2 R5: 月次ランキングボタン（panel:game:monthly）も追加。
        # ラウンド3: 全34ゲームが上限25件を超えたため、2ページ目のセレクト
        # （panel:game:select:2）が増える。1ページ目の固定 id は不変。
        self.assertEqual(child_ids(GameHubView(None)),
                         {"panel:game:genre", "panel:game:select", "panel:game:select:2", "panel:game:monthly"})
        view = GameHubView(None)
        view.genre = "party"
        view.refresh()
        self.assertIn("panel:game:select", child_ids(view))
        self.assertIn("panel:game:commit", child_ids(GameHubView(None, shortcut_mode=True)))

    def test_game_detail(self):
        expected = {
            "janken": {"panel:game:janken_wager"},
            "wordle": {"panel:game:wordle_mode"},
            "ngword": {"panel:game:ng_time", "panel:game:ng_mode"},
            "wordwolf": {"panel:game:wordlist"},
            "jinrou": {"panel:game:jinrou_mode", "panel:game:rating", "panel:game:end"},
            "chess": {"panel:game:chess_mode", "panel:game:chess_difficulty"},
        }
        for game_id, ids in expected.items():
            with self.subTest(game_id=game_id):
                view = GameDetailView(None, game_id)
                self.assertTrue(ids <= child_ids(view), child_ids(view))
                self.assertIn("panel:game:select", child_ids(view))
                self.assertIn("panel:game:rules", child_ids(view))
                self.assertIn("panel:game:recruit", child_ids(view))
                self.assertIn("panel:game:back", child_ids(view))
        self.assertIn("panel:game:commit", child_ids(GameDetailView(None, "janken", shortcut_mode=True)))

    def test_help_views(self):
        catalog = make_catalog()
        self.assertEqual(child_ids(HelpView(catalog)), {"panel:help:category"})
        ids = child_ids(HelpView(catalog, "general"))
        self.assertTrue(
            {"panel:help:category", "panel:help:function", "panel:help:guide",
             "panel:help:prev", "panel:help:next", "panel:help:top"} <= ids, ids)
        self.assertIn("panel:help:commit", child_ids(HelpView(catalog, shortcut_mode=True)))
        self.assertEqual(child_ids(BackView(catalog, "general")), {"panel:help:back"})
        entry = catalog["commands"][0]
        self.assertEqual(
            child_ids(CommandView(catalog, entry)),
            {"panel:help:read_guide", "panel:help:open_category"},
        )
        no_guide = dict(entry, guide="")
        self.assertEqual(child_ids(CommandView(catalog, no_guide)), {"panel:help:open_category"})

    def test_commit_button_root(self):
        self.assertEqual(ShortcutCommitButton().custom_id, "panel:general:commit")
        self.assertEqual(ShortcutCommitButton("vc").custom_id, "panel:vc:commit")
        self.assertEqual(ShortcutCommitButton("support").custom_id, "panel:support:commit")
        self.assertEqual(ShortcutCommitButton("game").custom_id, "panel:game:commit")
        self.assertEqual(ShortcutCommitButton("help").custom_id, "panel:help:commit")


class FakeResponse:
    def __init__(self, done=False):
        self._done = done
        self.calls = []

    def is_done(self):
        return self._done

    async def send_message(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        self._done = True


class FakeBot:
    def __init__(self, cogs=None):
        self._cogs = cogs or {}

    def get_cog(self, name):
        return self._cogs.get(name)


class FakeHelpCog:
    def __init__(self, catalog):
        self._catalog = catalog

    def catalog(self):
        return self._catalog


def make_interaction(custom_id, *, done=False, type_=discord.InteractionType.component):
    return types.SimpleNamespace(
        type=type_,
        data={"custom_id": custom_id} if custom_id is not None else {},
        response=FakeResponse(done),
        guild_id=123,
        user=types.SimpleNamespace(id=42),
    )


class FallbackTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.cogs = {
            "GeneralCog": object(),
            "VoiceHub": object(),
            "SupportCog": object(),
            "GameHub": object(),
            "HelpCog": FakeHelpCog(make_catalog()),
        }
        self.recovery = panel_recovery.PanelRecoveryCog(FakeBot(self.cogs))

    async def dispatch(self, interaction):
        with patch.object(panel_recovery, "RECOVERY_WAIT_SECONDS", 0):
            await self.recovery.on_interaction(interaction)
        return interaction.response.calls

    def reopened_panel(self, calls):
        self.assertEqual(len(calls), 1)
        _args, kwargs = calls[0]
        self.assertTrue(kwargs.get("ephemeral"))
        view = kwargs.get("view")
        self.assertIsInstance(view, PanelLayoutView)
        return view.panel

    async def test_dead_panels_reopen(self):
        # 期待クラスは実行時に import し直す。他のテストが cogs モジュールを
        # 再ロードしていると、収集時の import ではクラス同一性がずれるため。
        cases = [
            ("panel:general:genre", "core.general.panel", "GeneralPanel"),
            ("panel:general:action", "core.general.panel", "GeneralPanel"),
            ("panel:vc:genre", "cogs.sio_voice", "VoicePanelView"),
            ("panel:vc:commit", "cogs.sio_voice", "VoicePanelView"),
            ("panel:support:action", "core.support.panel", "SupportPanelView"),
            ("panel:game:back", "cogs.game", "GameHubView"),
            ("panel:help:next", "cogs.help", "HelpView"),
        ]
        for custom_id, module_name, class_name in cases:
            with self.subTest(custom_id=custom_id):
                panel_type = getattr(importlib.import_module(module_name), class_name)
                calls = await self.dispatch(make_interaction(custom_id))
                self.assertIsInstance(self.reopened_panel(calls), panel_type)

    async def test_responded_interaction_is_left_alone(self):
        calls = await self.dispatch(make_interaction("panel:general:genre", done=True))
        self.assertEqual(calls, [])

    async def test_other_custom_ids_are_ignored(self):
        for custom_id in ("assist:poll:vote", "support_ticket:create", "giveaway:join:1",
                          "verify_button:123", "panel:unknown:genre", "panel:"):
            with self.subTest(custom_id=custom_id):
                calls = await self.dispatch(make_interaction(custom_id))
                self.assertEqual(calls, [])

    async def test_non_component_is_ignored(self):
        interaction = make_interaction(
            "panel:general:genre", type_=discord.InteractionType.application_command)
        calls = await self.dispatch(interaction)
        self.assertEqual(calls, [])

    async def test_missing_cog_sends_fallback_message(self):
        self.recovery = panel_recovery.PanelRecoveryCog(FakeBot({}))
        calls = await self.dispatch(make_interaction("panel:general:genre"))
        self.assertEqual(len(calls), 1)
        args, kwargs = calls[0]
        self.assertEqual(args[0] if args else kwargs.get("content"), panel_recovery.FALLBACK_MESSAGE)
        self.assertTrue(kwargs.get("ephemeral"))
        self.assertNotIn("view", kwargs)

    def test_build_panel_unknown_root(self):
        self.assertIsNone(panel_recovery.build_panel(FakeBot(self.cogs), "unknown"))


if __name__ == "__main__":
    unittest.main()
