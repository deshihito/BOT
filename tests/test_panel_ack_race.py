"""パネル callback と panel_recovery の応答競合（2026-11-06 実機バグ）の回帰テスト。

実機症状: /general の EXP 系アクションで、生存中 callback の応答が
recovery の生存判定（RECOVERY_WAIT_SECONDS）より遅れると

1. recovery が死んだパネルと誤判定して新しいパネルを余計に出し、
2. callback 側の応答が InteractionResponded (40060) になり、
3. PanelLayoutView.on_error がそれを「⚠️ 内部エラー」として利用者へ見せる。

対策の検証:
- on_error / report_callback_error は InteractionResponded を可視化しない
- EXP 系 dispatch は重い処理（表示名解決など）の前に defer で ACK する
- 利用履歴の記録は dispatch の応答を待たせない（バックグラウンド記録）
- 遅い callback と recovery リスナーを同時に走らせても、結果が1回だけ
  届き、余計なパネルも内部エラーも出ない
"""

import asyncio
import types
import unittest
from unittest.mock import AsyncMock, patch

import discord

from core import action_usage
from core.panel_v2 import PanelLayoutView


# ---------------------------------------------------------------------------
# フェイク
# ---------------------------------------------------------------------------

class MinimalPanel(discord.ui.View):
    def __init__(self):
        super().__init__(timeout=None)

    def embed(self):
        return discord.Embed(title="panel")


def fake_interaction(*, done=False):
    return types.SimpleNamespace(
        response=types.SimpleNamespace(
            is_done=lambda: done,
            send_message=AsyncMock(),
            defer=AsyncMock(),
        ),
        followup=types.SimpleNamespace(send=AsyncMock()),
    )


async def drain_background_records():
    """dispatch が積んだ利用履歴の記録タスクを完了まで進める。"""
    tasks = list(action_usage._background_tasks)
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)


# ---------------------------------------------------------------------------
# A: エラー可視化の修正
# ---------------------------------------------------------------------------

class PanelLayoutViewOnErrorTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.view = PanelLayoutView(MinimalPanel())

    async def test_interaction_responded_is_never_shown(self):
        for done in (True, False):
            with self.subTest(done=done):
                interaction = fake_interaction(done=done)
                error = discord.InteractionResponded(interaction)
                await self.view.on_error(interaction, error)
                interaction.followup.send.assert_not_awaited()
                interaction.response.send_message.assert_not_awaited()

    async def test_normal_error_is_shown_via_followup_when_done(self):
        interaction = fake_interaction(done=True)
        await self.view.on_error(interaction, RuntimeError("boom"))
        interaction.followup.send.assert_awaited_once()
        args, kwargs = interaction.followup.send.call_args
        self.assertIn("内部エラー", args[0])
        self.assertTrue(kwargs.get("ephemeral"))

    async def test_normal_error_is_shown_via_response_when_not_done(self):
        interaction = fake_interaction(done=False)
        await self.view.on_error(interaction, RuntimeError("boom"))
        interaction.response.send_message.assert_awaited_once()
        args, kwargs = interaction.response.send_message.call_args
        self.assertIn("内部エラー", args[0])
        self.assertTrue(kwargs.get("ephemeral"))


class ReportCallbackErrorTest(unittest.IsolatedAsyncioTestCase):
    async def test_interaction_responded_is_never_shown(self):
        from core.support.common import report_callback_error

        for done in (True, False):
            with self.subTest(done=done):
                interaction = fake_interaction(done=done)
                error = discord.InteractionResponded(interaction)
                await report_callback_error(interaction, "テスト用", error=error)
                interaction.followup.send.assert_not_awaited()
                interaction.response.send_message.assert_not_awaited()

    async def test_normal_error_still_notifies(self):
        from core.support.common import report_callback_error

        interaction = fake_interaction(done=True)
        await report_callback_error(interaction, "テスト用", error=RuntimeError("boom"))
        interaction.followup.send.assert_awaited_once()
        args, _kwargs = interaction.followup.send.call_args
        self.assertIn("処理中にエラーが発生しました", args[0])


# ---------------------------------------------------------------------------
# B: 記録のバックグラウンド化
# ---------------------------------------------------------------------------

class BackgroundRecordTest(unittest.IsolatedAsyncioTestCase):
    async def test_background_record_eventually_writes(self):
        from tests.test_action_usage import MemoryStore

        store = MemoryStore()
        task = action_usage.record_safely_in_background(
            111, 222, "general:status", store=store)
        self.assertIsNotNone(task)
        await task
        self.assertEqual(action_usage.recent_for(store, 111, 222), ["general:status"])

    async def test_background_record_swallows_store_errors(self):
        from tests.test_action_usage import MemoryStore

        class BrokenStore(MemoryStore):
            async def update(self, *args, **kwargs):
                raise RuntimeError("store is down")

        task = action_usage.record_safely_in_background(
            111, 222, "general:status", store=BrokenStore())
        self.assertIsNotNone(task)
        await task  # 例外が伝播しないこと

    def test_background_record_without_loop_returns_none(self):
        self.assertIsNone(action_usage.record_safely_in_background(111, 222, "general:status"))


# ---------------------------------------------------------------------------
# B: EXP 系 dispatch の ACK 順序
# ---------------------------------------------------------------------------

class ExpAckOrderTest(unittest.IsolatedAsyncioTestCase):
    def make_cog_and_interaction(self, events):
        from cogs.general import GeneralCog

        cog = GeneralCog.__new__(GeneralCog)
        cog.bot = types.SimpleNamespace(get_cog=lambda _name: None)

        async def defer(**kwargs):
            events.append("defer")

        async def followup_send(**kwargs):
            events.append("followup")

        interaction = types.SimpleNamespace(
            guild_id=123, guild=None,
            user=types.SimpleNamespace(id=456),
            response=types.SimpleNamespace(
                is_done=lambda: False,
                send_message=AsyncMock(),
                defer=AsyncMock(side_effect=defer),
            ),
            followup=types.SimpleNamespace(send=AsyncMock(side_effect=followup_send)),
        )
        return cog, interaction

    async def run_dispatch(self, value, view_class_name):
        import cogs.general as general_module

        events = []

        async def slow_load(self):
            events.append("load")

        cog, interaction = self.make_cog_and_interaction(events)
        view_class = getattr(general_module, view_class_name)
        with patch.object(view_class, "_load_latest", slow_load), \
                patch.object(action_usage, "record_safely", new=AsyncMock()):
            await cog.dispatch_general(interaction, value)
            await drain_background_records()
        # 応答（defer）が重い読み込みより前に始まり、結果は followup で届く。
        self.assertEqual(events, ["defer", "load", "followup"])
        interaction.response.send_message.assert_not_awaited()

    async def test_exp_status_defers_before_loading(self):
        await self.run_dispatch("exp_status", "ExpStatusView")

    async def test_exp_ranking_defers_before_loading(self):
        await self.run_dispatch("exp_ranking", "ExpRankingView")


class LotteryAckOrderTest(unittest.IsolatedAsyncioTestCase):
    async def test_show_lottery_defers_before_settling(self):
        import core.general.circulation.cog as circulation

        events = []
        cog = circulation.CirculationCog.__new__(circulation.CirculationCog)

        async def settle():
            events.append("settle")

        cog.settle_lottery = settle

        async def defer(**kwargs):
            events.append("defer")

        interaction = types.SimpleNamespace(
            guild_id=123, guild=None,
            user=types.SimpleNamespace(id=456),
            response=types.SimpleNamespace(
                is_done=lambda: False,
                defer=AsyncMock(side_effect=defer),
                send_message=AsyncMock(),
            ),
            followup=types.SimpleNamespace(send=AsyncMock()),
        )
        with patch.object(circulation, "_wrap", lambda view: view):
            await cog.show_lottery(interaction)
        self.assertEqual(events, ["defer", "settle"])
        interaction.followup.send.assert_awaited_once()


# ---------------------------------------------------------------------------
# B+A 統合: 遅い callback と recovery の競合再現
# ---------------------------------------------------------------------------

class FakeResponse:
    """discord.py の応答セマンティクス（応答済みなら InteractionResponded）。"""

    def __init__(self, interaction_holder):
        self._holder = interaction_holder
        self.done = False
        self.sent = []

    def is_done(self):
        return self.done

    async def defer(self, **kwargs):
        if self.done:
            raise discord.InteractionResponded(self._holder())
        self.done = True

    async def send_message(self, *args, **kwargs):
        if self.done:
            raise discord.InteractionResponded(self._holder())
        self.done = True
        self.sent.append((args, kwargs))


class FakeFollowup:
    def __init__(self):
        self.sent = []

    async def send(self, *args, **kwargs):
        self.sent.append((args, kwargs))


class SlowCallbackRaceTest(unittest.IsolatedAsyncioTestCase):
    async def test_slow_exp_ranking_beats_recovery_without_error(self):
        import cogs.general as general_module
        from cogs import panel_recovery
        from cogs.general import GeneralCog

        interaction = types.SimpleNamespace(
            type=discord.InteractionType.component,
            data={"custom_id": "panel:general:history"},
            guild_id=123, guild=None,
            user=types.SimpleNamespace(id=456),
        )
        interaction.response = FakeResponse(lambda: interaction)
        interaction.followup = FakeFollowup()

        cog = GeneralCog.__new__(GeneralCog)
        cog.bot = types.SimpleNamespace(get_cog=lambda _name: None)
        layout_view = PanelLayoutView(MinimalPanel())

        async def slow_load(self):
            # 表示名解決（fetch_user 逐次実行）相当の遅延。
            await asyncio.sleep(0.3)

        async def callback():
            # discord.py の View._dispatch と同じく、例外は on_error へ回す。
            try:
                await cog.dispatch_general(interaction, "exp_ranking")
            except Exception as error:
                await layout_view.on_error(interaction, error)

        recovery = panel_recovery.PanelRecoveryCog(
            types.SimpleNamespace(get_cog=lambda _name: None))
        with patch.object(panel_recovery, "RECOVERY_WAIT_SECONDS", 0.05), \
                patch.object(general_module.ExpRankingView, "_load_latest", slow_load), \
                patch.object(action_usage, "record_safely", new=AsyncMock()):
            await asyncio.gather(
                asyncio.create_task(callback()),
                asyncio.create_task(recovery.on_interaction(interaction)),
            )
            await drain_background_records()

        # recovery は新しいパネルも Fallback も出していない。
        self.assertEqual(interaction.response.sent, [])
        # 結果は followup で1回だけ届く。
        self.assertEqual(len(interaction.followup.sent), 1)
        _args, kwargs = interaction.followup.sent[0]
        self.assertIn("view", kwargs)
        # 内部エラーはどこにも出ていない。
        for args, kwargs in interaction.followup.sent:
            self.assertNotIn("内部エラー", str(args) + str(kwargs))


# ---------------------------------------------------------------------------
# C: recovery 待機時間
# ---------------------------------------------------------------------------

class RecoveryWaitTest(unittest.TestCase):
    def test_wait_seconds_covers_api_round_trip(self):
        from cogs import panel_recovery

        # 0.4秒では Pi からの応答 HTTP 往復だけで誤判定し得る。Discord の
        # 初回応答期限（3秒）内に再表示が間に合う 1.5 秒を既定とする。
        self.assertEqual(panel_recovery.RECOVERY_WAIT_SECONDS, 1.5)


if __name__ == "__main__":
    unittest.main()
