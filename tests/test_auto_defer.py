"""自動 defer ウォッチドッグ（core/support/auto_defer.py）の回帰テスト。

実機症状: パネル操作で、callback の読み込み（DB/API 往復・画像生成）だけで
初回応答の制限（約3秒）を超えて「応答しませんでした」になる。

対策の検証:
- 遅い callback は制限前に defer で ACK され、後段の編集が
  edit_original_response で届く（処理が落ちない）
- 速い callback には defer が割り込まない（見た目・挙動不変）
- component 以外（スラッシュコマンド本体）は対象外
- View / callback 単位の opt-out が効く（モーダル起動系など）
- modal_submit は thinking defer で ACK される
- GamePanelView.on_error が InteractionResponded を可視化しない
"""

import asyncio
import types
import unittest
from unittest.mock import patch

import discord

from core.support import auto_defer
from core.support.auto_defer import (
    auto_defer_exempt,
    defer_if_not_done,
    install_auto_defer,
    send_or_followup,
)


# ---------------------------------------------------------------------------
# フェイク（test_panel_ack_race.py と同じ応答セマンティクス）
# ---------------------------------------------------------------------------

class FakeResponse:
    def __init__(self, holder):
        self._holder = holder
        self.done = False
        self.defer_calls = []
        self.sent = []
        self.edited = []

    def is_done(self):
        return self.done

    async def defer(self, **kwargs):
        if self.done:
            raise discord.InteractionResponded(self._holder())
        self.done = True
        self.defer_calls.append(kwargs)

    async def send_message(self, *args, **kwargs):
        if self.done:
            raise discord.InteractionResponded(self._holder())
        self.done = True
        self.sent.append((args, kwargs))

    async def edit_message(self, *args, **kwargs):
        if self.done:
            raise discord.InteractionResponded(self._holder())
        self.done = True
        self.edited.append((args, kwargs))


class FakeFollowup:
    def __init__(self):
        self.sent = []

    async def send(self, *args, **kwargs):
        self.sent.append((args, kwargs))
        return types.SimpleNamespace(id=999)


def fake_interaction(interaction_type=discord.InteractionType.component):
    interaction = types.SimpleNamespace(
        type=interaction_type,
        data={},
        user=types.SimpleNamespace(id=456),
        guild_id=123,
        channel_id=789,
    )
    interaction.response = FakeResponse(lambda: interaction)
    interaction.followup = FakeFollowup()

    async def edit_original_response(**kwargs):
        interaction.edited_original = kwargs

    interaction.edit_original_response = edit_original_response
    interaction.edited_original = None
    return interaction


def make_view(callback, **view_kwargs):
    view = discord.ui.View(timeout=None, **view_kwargs)
    button = discord.ui.Button(label="押す", custom_id="test:auto-defer")
    button.callback = callback
    view.add_item(button)
    return view, button


class ErrorRecordingView(discord.ui.View):
    def __init__(self):
        super().__init__(timeout=None)
        self.errors = []

    async def on_error(self, interaction, error, item=None):
        self.errors.append(error)


# ---------------------------------------------------------------------------
# ウォッチドッグ本体
# ---------------------------------------------------------------------------

class AutoDeferDispatchTest(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        install_auto_defer()

    async def dispatch(self, view, button, interaction, delay=0.05):
        with patch.object(auto_defer, "AUTO_DEFER_DELAY_SECONDS", delay):
            await view._scheduled_task(button, interaction)

    async def test_slow_callback_is_deferred_and_edit_lands(self):
        interaction = fake_interaction()

        async def slow(interaction):
            await asyncio.sleep(0.3)
            # edit_panel_v2 / refresh_panel と同じ is_done 分岐の編集。
            if interaction.response.is_done():
                await interaction.edit_original_response(view=None)
            else:
                await interaction.response.edit_message(view=None)

        view, button = make_view(slow)
        errors = []
        view.on_error = lambda i, e, item=None: errors.append(e)
        await self.dispatch(view, button, interaction)

        self.assertEqual(len(interaction.response.defer_calls), 1)
        # component の defer は無表示（deferred_message_update）が既定。
        self.assertEqual(interaction.response.defer_calls[0], {})
        self.assertIsNotNone(interaction.edited_original)
        self.assertEqual(errors, [])

    async def test_fast_callback_is_not_deferred(self):
        interaction = fake_interaction()

        async def fast(interaction):
            await interaction.response.send_message("ok")

        view, button = make_view(fast)
        await self.dispatch(view, button, interaction, delay=0.3)
        self.assertEqual(interaction.response.defer_calls, [])
        self.assertEqual(len(interaction.response.sent), 1)

    async def test_already_responded_is_not_double_deferred(self):
        interaction = fake_interaction()

        async def respond_then_work(interaction):
            await interaction.response.send_message("先に応答")
            await asyncio.sleep(0.2)

        view, button = make_view(respond_then_work)
        await self.dispatch(view, button, interaction)
        self.assertEqual(interaction.response.defer_calls, [])

    async def test_non_component_interaction_is_not_deferred(self):
        interaction = fake_interaction(discord.InteractionType.application_command)

        async def slow(interaction):
            await asyncio.sleep(0.2)

        view, button = make_view(slow)
        await self.dispatch(view, button, interaction)
        self.assertEqual(interaction.response.defer_calls, [])

    async def test_view_opt_out(self):
        interaction = fake_interaction()

        async def slow(interaction):
            await asyncio.sleep(0.2)

        view, button = make_view(slow)
        view.auto_defer = False
        await self.dispatch(view, button, interaction)
        self.assertEqual(interaction.response.defer_calls, [])

    async def test_callback_opt_out(self):
        interaction = fake_interaction()

        @auto_defer_exempt
        async def slow_modal_opener(interaction):
            await asyncio.sleep(0.2)

        view, button = make_view(slow_modal_opener)
        await self.dispatch(view, button, interaction)
        self.assertEqual(interaction.response.defer_calls, [])

    async def test_install_is_idempotent(self):
        self.assertFalse(install_auto_defer())


class AutoDeferModalTest(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        install_auto_defer()

    async def test_slow_modal_submit_is_thinking_deferred(self):
        class SlowModal(discord.ui.Modal, title="t"):
            async def on_submit(self, interaction):
                await asyncio.sleep(0.3)
                await interaction.followup.send("done", ephemeral=True)

        interaction = fake_interaction(discord.InteractionType.modal_submit)
        modal = SlowModal()
        with patch.object(auto_defer, "AUTO_DEFER_DELAY_SECONDS", 0.05):
            await modal._scheduled_task(interaction, [], {})
        self.assertEqual(interaction.response.defer_calls, [{"thinking": True}])
        self.assertEqual(len(interaction.followup.sent), 1)


# ---------------------------------------------------------------------------
# ヘルパー
# ---------------------------------------------------------------------------

class HelperTest(unittest.IsolatedAsyncioTestCase):
    async def test_defer_if_not_done(self):
        interaction = fake_interaction()
        self.assertTrue(await defer_if_not_done(interaction))
        self.assertFalse(await defer_if_not_done(interaction))
        self.assertEqual(len(interaction.response.defer_calls), 1)

    async def test_send_or_followup_switches_after_response(self):
        interaction = fake_interaction()
        await send_or_followup(interaction, "first")
        self.assertEqual(len(interaction.response.sent), 1)
        await send_or_followup(interaction, "second")
        self.assertEqual(len(interaction.followup.sent), 1)


# ---------------------------------------------------------------------------
# GamePanelView.on_error（自動 defer とセットの誤報抑制）
# ---------------------------------------------------------------------------

class GamePanelViewOnErrorTest(unittest.IsolatedAsyncioTestCase):
    def make_view(self):
        from core.game.hub.game_v2 import GamePanelView

        return GamePanelView("t", "body")

    async def test_interaction_responded_is_never_shown(self):
        view = self.make_view()
        for done in (True, False):
            with self.subTest(done=done):
                interaction = fake_interaction()
                interaction.response.done = done
                error = discord.InteractionResponded(interaction)
                await view.on_error(interaction, error)
                self.assertEqual(interaction.followup.sent, [])
                self.assertEqual(interaction.response.sent, [])

    async def test_normal_error_is_shown_via_followup_when_done(self):
        view = self.make_view()
        interaction = fake_interaction()
        interaction.response.done = True
        await view.on_error(interaction, RuntimeError("boom"))
        self.assertEqual(len(interaction.followup.sent), 1)


if __name__ == "__main__":
    unittest.main()
