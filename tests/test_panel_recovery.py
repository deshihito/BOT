"""PR-B: 操作パネルの固定 custom_id と、死んだパネルの再表示フォールバックのテスト。

- 各パネルの部品に ``panel:<root>:<part>`` 形式の固定 custom_id が付いていること
- cogs/panel_recovery.py の判定: 未応答なら正しい root のパネルを開き直す /
  応答済みなら何もしない / 対象外 custom_id には干渉しない
通信はしない (応答は Fake で記録するだけ)。
"""

import asyncio
import importlib
import re
import time
import types
import unittest
from unittest.mock import patch

import discord

import cogs.support as panel_recovery
from core.support.panel_recovery import cog as recovery_cog
from cogs.game import GameDetailView, GameHubView
from cogs.help import BackView, CommandView, HelpView
from cogs.vc import VoicePanelView
from core.general.panel import GeneralPanel
from core.general.shortcuts import ShortcutCommitButton
from core.support.panel_v2 import PanelLayoutView
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
        # 導線最適化ラウンド4: マネージャンルが25件を超えたためページめくり
        # ボタン（action_prev / action_indicator / action_next）が付く。
        self.assertEqual(
            child_ids(GeneralPanel(None, genre="money")),
            {"panel:general:genre", "panel:general:action", "panel:general:register",
             "panel:general:action_prev", "panel:general:action_indicator",
             "panel:general:action_next",
             # 機能再編: money⇔boardnotify_rta のジャンルワープボタン
             "panel:general:warp_general_boardnotify_rta"},
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
        # 機能再編: VCルート⇔support自動化 のジャンルワープボタンが常駐
        self.assertEqual(child_ids(VoicePanelView(None)),
                         {"panel:vc:genre", "panel:vc:register",
                          "panel:vc:warp_support_automation"})
        self.assertEqual(
            child_ids(VoicePanelView(None, genre="connection")),
            {"panel:vc:genre", "panel:vc:action", "panel:vc:register"},
        )
        self.assertIn("panel:vc:commit", child_ids(VoicePanelView(None, shortcut_mode=True)))

    def test_game_hub(self):
        # 導線最適化 M3: 初期表示から全ゲームセレクト（panel:game:select）も出す。
        # ラウンド2 R5: 月次ランキングボタン（panel:game:monthly）も追加。
        # ページめくり化: セレクトは1つに固定し、代わりにページめくりボタン
        # （page_prev / page_indicator / page_next）を出す（select:2 は廃止）。
        self.assertEqual(child_ids(GameHubView(None)),
                         {"panel:game:genre", "panel:game:select", "panel:game:page_prev",
                          "panel:game:page_indicator", "panel:game:page_next", "panel:game:monthly",
                          # 機能再編: ゲーム王⇔general:boardnotify_rta のジャンルワープボタン
                          "panel:game:warp_general_boardnotify_rta"})
        view = GameHubView(None)
        view.genre = "party"
        view.refresh()
        self.assertIn("panel:game:select", child_ids(view))
        # ラウンド5で party が25件を超えたため、ジャンル絞り込み時も
        # ページめくりが出る（ページングの一般化）。
        self.assertIn("panel:game:page_next", child_ids(view))
        view = GameHubView(None)
        view.genre = "solo"
        view.refresh()
        # 1ページに収まるジャンルではページめくりは出ない。
        self.assertNotIn("panel:game:page_next", child_ids(view))
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
            ("panel:vc:genre", "cogs.vc", "VoicePanelView"),
            ("panel:vc:commit", "cogs.vc", "VoicePanelView"),
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


# ---------------------------------------------------------------------------
# 生存判定 (ViewStore) と待機の回帰テスト (2026-11-08 実機バグ)
#
# 実機症状: 再起動直後に死んだ /general パネルを押すと、recovery が
# 誰も応答しないことが確定しているケースでも一律 1.5 秒待ってから
# 再表示を試み、高負荷と重なって Discord の初回応答期限 (3秒) を超え、
# 10062 Unknown interaction で復旧自体が失敗し続けていた。
# ---------------------------------------------------------------------------

MESSAGE_ID = 999
GENERAL_GENRE_KEY = (3, "panel:general:genre")  # (component_type, custom_id)


class StoreBot(FakeBot):
    """ViewStore の内部 dict を模した bot。"""

    def __init__(self, cogs=None, views=None, dynamic_items=None):
        super().__init__(cogs)
        store = types.SimpleNamespace(
            _views=views if views is not None else {},
            _dynamic_items=dynamic_items or {},
        )
        self._connection = types.SimpleNamespace(_view_store=store)


class RaisingResponse(FakeResponse):
    """send_message が必ず指定の例外を投げる応答。"""

    def __init__(self, error):
        super().__init__(done=False)
        self._error = error

    async def send_message(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        raise self._error


def make_store_interaction(custom_id="panel:general:genre", *, response=None):
    return types.SimpleNamespace(
        type=discord.InteractionType.component,
        data={"custom_id": custom_id, "component_type": 3},
        message=types.SimpleNamespace(id=MESSAGE_ID),
        response=response if response is not None else FakeResponse(),
        guild_id=123,
        user=types.SimpleNamespace(id=42),
    )


def live_view(finished=False):
    return types.SimpleNamespace(is_finished=lambda: finished)


class LiveCallbackExpectedTest(unittest.TestCase):
    def setUp(self):
        from core.support.panel_recovery.cog import _live_callback_expected

        self.expected = _live_callback_expected
        self.cogs = {"GeneralCog": object()}

    def test_no_connection_info_is_conservative(self):
        # store を確認できない bot では「応答する見込みあり」(待つ側) に倒す。
        interaction = make_store_interaction()
        self.assertTrue(self.expected(FakeBot(self.cogs), interaction))

    def test_no_store_entry_means_dead(self):
        interaction = make_store_interaction()
        self.assertFalse(self.expected(StoreBot(self.cogs, views={}), interaction))

    def test_item_with_dead_view_means_dead(self):
        # 本番の "unknown view ... Discarding" 相当: item はあるが view が None。
        views = {MESSAGE_ID: {GENERAL_GENRE_KEY: types.SimpleNamespace(view=None)}}
        interaction = make_store_interaction()
        self.assertFalse(self.expected(StoreBot(self.cogs, views=views), interaction))

    def test_finished_view_means_dead(self):
        views = {MESSAGE_ID: {GENERAL_GENRE_KEY: types.SimpleNamespace(view=live_view(finished=True))}}
        interaction = make_store_interaction()
        self.assertFalse(self.expected(StoreBot(self.cogs, views=views), interaction))

    def test_live_view_means_expected(self):
        views = {MESSAGE_ID: {GENERAL_GENRE_KEY: types.SimpleNamespace(view=live_view())}}
        interaction = make_store_interaction()
        self.assertTrue(self.expected(StoreBot(self.cogs, views=views), interaction))

    def test_persistent_bucket_is_checked(self):
        views = {None: {GENERAL_GENRE_KEY: types.SimpleNamespace(view=live_view())}}
        interaction = make_store_interaction()
        self.assertTrue(self.expected(StoreBot(self.cogs, views=views), interaction))

    def test_dynamic_item_match_means_expected(self):
        bot = StoreBot(self.cogs, views={}, dynamic_items={re.compile(r"panel:.*"): object()})
        interaction = make_store_interaction()
        self.assertTrue(self.expected(bot, interaction))


class RecoveryLivenessFlowTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.cogs = {
            "GeneralCog": object(),
            "VoiceHub": object(),
            "SupportCog": object(),
            "GameHub": object(),
            "HelpCog": FakeHelpCog(make_catalog()),
        }

    def make_recovery(self, **store_kwargs):
        return panel_recovery.PanelRecoveryCog(StoreBot(self.cogs, **store_kwargs))

    async def test_dead_panel_reopens_without_waiting(self):
        # 待機上限が大きくても、死んだパネルは待たずに即応答する。
        # (旧実装では上限まで眠るため wait_for がタイムアウトして落ちる)
        recovery = self.make_recovery(views={})
        interaction = make_store_interaction()
        with patch.object(panel_recovery, "RECOVERY_WAIT_SECONDS", 30):
            await asyncio.wait_for(recovery.on_interaction(interaction), timeout=5)
        self.assertEqual(len(interaction.response.calls), 1)
        _args, kwargs = interaction.response.calls[0]
        self.assertIn("view", kwargs)
        self.assertTrue(kwargs.get("ephemeral"))

    async def test_discarded_view_reopens_without_waiting(self):
        views = {MESSAGE_ID: {GENERAL_GENRE_KEY: types.SimpleNamespace(view=None)}}
        recovery = self.make_recovery(views=views)
        interaction = make_store_interaction()
        with patch.object(panel_recovery, "RECOVERY_WAIT_SECONDS", 30):
            await asyncio.wait_for(recovery.on_interaction(interaction), timeout=5)
        self.assertEqual(len(interaction.response.calls), 1)

    async def test_live_view_response_stands_down_early(self):
        # 生存中 callback が途中で応答したら、上限を待たずに手を引き、
        # 横取り (余計なパネル送信) もしない。
        views = {MESSAGE_ID: {GENERAL_GENRE_KEY: types.SimpleNamespace(view=live_view())}}
        recovery = self.make_recovery(views=views)
        interaction = make_store_interaction()

        async def respond_later():
            await asyncio.sleep(0.15)
            interaction.response._done = True

        flip = asyncio.create_task(respond_later())
        started = time.monotonic()
        with patch.object(panel_recovery, "RECOVERY_WAIT_SECONDS", 5):
            await recovery.on_interaction(interaction)
        elapsed = time.monotonic() - started
        await flip
        self.assertEqual(interaction.response.calls, [])
        self.assertLess(elapsed, 2)

    async def test_live_view_silence_reopens_after_deadline(self):
        # 生存扱いの View が上限まで応答しなければ、従来どおり再表示する。
        views = {MESSAGE_ID: {GENERAL_GENRE_KEY: types.SimpleNamespace(view=live_view())}}
        recovery = self.make_recovery(views=views)
        interaction = make_store_interaction()
        started = time.monotonic()
        with patch.object(panel_recovery, "RECOVERY_WAIT_SECONDS", 0.2):
            await recovery.on_interaction(interaction)
        elapsed = time.monotonic() - started
        self.assertGreaterEqual(elapsed, 0.15)
        self.assertEqual(len(interaction.response.calls), 1)

    async def test_expired_interaction_is_handled_quietly(self):
        # 失効済み interaction (10062) では例外を外に出さず、案内文の
        # 再送 (届きようがない) も試みない。
        error = discord.NotFound(
            types.SimpleNamespace(status=404, reason="Not Found"),
            {"message": "Unknown interaction", "code": 10062},
        )
        recovery = self.make_recovery(views={})
        interaction = make_store_interaction(response=RaisingResponse(error))
        with patch.object(panel_recovery, "RECOVERY_WAIT_SECONDS", 0):
            await recovery.on_interaction(interaction)  # 例外が出ないこと
        self.assertEqual(len(interaction.response.calls), 1)

    async def test_already_acknowledged_is_handled_quietly(self):
        # 応答済み (40060) は「実際には届いている」競合なので、ERROR を
        # 出さず、案内文の再送も試みない。
        error = discord.HTTPException(
            types.SimpleNamespace(status=400, reason="Bad Request"),
            {"message": "Interaction has already been acknowledged.", "code": 40060},
        )
        recovery = self.make_recovery(views={})
        interaction = make_store_interaction(response=RaisingResponse(error))
        with patch.object(panel_recovery, "RECOVERY_WAIT_SECONDS", 0), \
                patch.object(recovery_cog.logger, "exception") as log_exception:
            await recovery.on_interaction(interaction)  # 例外が出ないこと
        self.assertEqual(len(interaction.response.calls), 1)
        log_exception.assert_not_called()

    async def test_other_http_errors_still_log_and_fallback(self):
        # 40060 以外の HTTPException は従来どおり失敗として記録し、
        # 案内文の送信を試みる。
        error = discord.HTTPException(
            types.SimpleNamespace(status=500, reason="Internal Server Error"),
            {"message": "Internal Server Error", "code": 0},
        )
        recovery = self.make_recovery(views={})
        interaction = make_store_interaction(response=RaisingResponse(error))
        with patch.object(panel_recovery, "RECOVERY_WAIT_SECONDS", 0), \
                patch.object(recovery_cog.logger, "exception") as log_exception:
            await recovery.on_interaction(interaction)
        self.assertEqual(len(interaction.response.calls), 2)
        log_exception.assert_called_once()


if __name__ == "__main__":
    unittest.main()
