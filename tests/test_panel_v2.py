import types
import unittest
from unittest.mock import AsyncMock

import discord

from discord.interactions import interaction_message_response_params
from cogs.game import GameDetailView
from cogs.sio_voice import VoicePanelView
from cogs.support import SupportPanelView
from core.panel_v2 import as_panel_v2, edit_message_v2


class PanelV2StateTest(unittest.IsolatedAsyncioTestCase):
    async def test_wrapped_refresh_forwards_notice_arguments(self):
        panel = discord.ui.View(timeout=300)
        panel.embed = lambda: discord.Embed(title="test")
        panel.refresh = AsyncMock(return_value=None)
        wrapped = as_panel_v2(panel)
        interaction = types.SimpleNamespace(
            response=types.SimpleNamespace(
                is_done=lambda: False,
                edit_message=AsyncMock(),
            )
        )

        await wrapped.refresh(interaction, "保存しました")

        panel.refresh.assert_awaited_once_with(interaction, "保存しました")

    async def test_v2_edit_payload_is_accepted_by_discord_py_serializer(self):
        wrapped = as_panel_v2(VoicePanelView(None))

        params = interaction_message_response_params(
            type=7,
            content=None,
            embed=None,
            attachments=[],
            view=wrapped,
        )

        self.assertEqual(params.payload["data"]["content"], None)
        self.assertEqual(params.payload["data"]["embeds"], [])
        self.assertEqual(params.payload["data"]["attachments"], [])

    async def test_normal_message_v2_edit_clears_legacy_payloads(self):
        message = types.SimpleNamespace(edit=AsyncMock())
        wrapped = as_panel_v2(VoicePanelView(None))

        await edit_message_v2(message, wrapped)

        payload = message.edit.call_args.kwargs
        self.assertIsNone(payload["content"])
        self.assertIsNone(payload["embed"])
        self.assertEqual(payload["attachments"], [])
        self.assertIs(payload["view"], wrapped)

    async def test_game_selection_writes_through_to_wrapped_panel(self):
        panel = GameDetailView(None, "othello")
        wrapped = as_panel_v2(panel)

        self.assertEqual(panel.chess_mode, "human")
        wrapped.chess_mode = "cpu"
        self.assertEqual(panel.chess_mode, "cpu")

    async def test_voice_genre_dropdown_keeps_v2_wrapper(self):
        panel = VoicePanelView(None)
        wrapped = as_panel_v2(panel)
        select = wrapped.children[0].children[1].children[0]
        select._values = ["connection"]
        interaction = types.SimpleNamespace(
            response=types.SimpleNamespace(edit_message=AsyncMock(), is_done=lambda: False)
        )

        await select.callback(interaction)

        self.assertEqual(panel.genre, "connection")
        payload = interaction.response.edit_message.call_args.kwargs
        self.assertIs(payload["view"], wrapped)
        self.assertEqual(payload["content"], None)
        self.assertEqual(payload["embed"], None)
        self.assertEqual(payload["attachments"], [])

    async def test_voice_genre_dropdown_wraps_legacy_owner_fallback(self):
        panel = VoicePanelView(None)
        wrapped = as_panel_v2(panel)
        select = wrapped.children[0].children[1].children[0]
        select._view = panel
        select._values = ["connection"]
        interaction = types.SimpleNamespace(
            response=types.SimpleNamespace(edit_message=AsyncMock(), is_done=lambda: False)
        )

        await select.callback(interaction)

        next_view = interaction.response.edit_message.call_args.kwargs["view"]
        self.assertIsNot(next_view, panel)
        self.assertIs(next_view.panel, panel)

    async def test_voice_action_dropdown_keeps_shortcut_builder_open(self):
        panel = VoicePanelView(None, genre="connection", shortcut_mode=True)
        wrapped = as_panel_v2(panel)
        select = wrapped.children[0].children[2].children[0]
        select._values = [select.options[0].value]
        interaction = types.SimpleNamespace(
            response=types.SimpleNamespace(edit_message=AsyncMock(), is_done=lambda: False)
        )

        await select.callback(interaction)

        self.assertEqual(panel.action, select.options[0].value)
        self.assertIs(interaction.response.edit_message.call_args.kwargs["view"], wrapped)

    async def test_support_action_dropdown_keeps_shortcut_builder_open(self):
        panel = SupportPanelView(None, genre="moderation", shortcut_mode=True)
        wrapped = as_panel_v2(panel)
        select = wrapped.children[0].children[2].children[0]
        select._values = [select.options[0].value]
        interaction = types.SimpleNamespace(
            response=types.SimpleNamespace(edit_message=AsyncMock(), is_done=lambda: False)
        )

        await select.callback(interaction)

        self.assertEqual(panel.action, select.options[0].value)
        self.assertIs(interaction.response.edit_message.call_args.kwargs["view"], wrapped)


if __name__ == "__main__":
    unittest.main()
