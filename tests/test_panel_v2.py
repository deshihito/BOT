import types
import unittest
from unittest.mock import AsyncMock

import discord

from discord.interactions import interaction_message_response_params
from cogs.game import GameDetailView
from cogs.sio_voice import VoicePanelView
from cogs.support import SupportPanelView
from core.support.panel_v2 import as_panel_v2, edit_message_v2


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


class PanelV2MediaAndTruncationTest(unittest.IsolatedAsyncioTestCase):
    """§4.2-8/12: 画像の MediaGallery 保持、添付の再供給、切断の明示。"""

    def _panel_with_embed(self, embed):
        panel = discord.ui.View(timeout=300)
        panel.embed = lambda: embed
        return panel

    def test_panel_layout_keeps_embed_image_as_media_gallery(self):
        from core.support.panel_v2 import as_panel_v2

        embed = discord.Embed(title="盤面")
        embed.set_image(url="attachment://board.png")
        embed.set_thumbnail(url="https://example.com/thumb.png")
        wrapped = as_panel_v2(self._panel_with_embed(embed))
        container = wrapped.children[0]
        galleries = [c for c in container.children if isinstance(c, discord.ui.MediaGallery)]
        self.assertEqual(len(galleries), 1)
        urls = [item.media.url for item in galleries[0].items]
        self.assertEqual(urls, ["attachment://board.png", "https://example.com/thumb.png"])

    def test_embed_layout_keeps_image_and_text(self):
        from core.support.panel_v2 import as_embed_v2

        embed = discord.Embed(title="結果", description="本文")
        embed.set_image(url="https://example.com/result.png")
        view = as_embed_v2(embed)
        container = view.children[0]
        kinds = [type(c).__name__ for c in container.children]
        self.assertEqual(kinds, ["TextDisplay", "MediaGallery"])

    def test_no_gallery_without_images(self):
        from core.support.panel_v2 import as_embed_v2

        view = as_embed_v2(discord.Embed(title="題のみ"))
        container = view.children[0]
        self.assertEqual([type(c).__name__ for c in container.children], ["TextDisplay"])

    def test_long_embed_is_truncated_with_marker_and_warning(self):
        from core.support import panel_v2

        embed = discord.Embed(title="長文", description="あ" * 5000)
        with self.assertLogs(panel_v2.logger, level="WARNING"):
            text = panel_v2.embed_text(embed)
        self.assertLessEqual(len(text), panel_v2.TEXT_DISPLAY_LIMIT)
        self.assertTrue(text.endswith(panel_v2.TRUNCATION_MARKER))

    def test_short_embed_has_no_truncation_marker(self):
        from core.support import panel_v2

        text = panel_v2.embed_text(discord.Embed(title="短文", description="本文"))
        self.assertNotIn(panel_v2.TRUNCATION_MARKER, text)

    async def test_edit_panel_v2_passes_files_instead_of_clearing(self):
        import io

        from core.support.panel_v2 import as_panel_v2, edit_panel_v2

        wrapped = as_panel_v2(self._panel_with_embed(discord.Embed(title="x")))
        edit_message = AsyncMock()
        interaction = types.SimpleNamespace(
            response=types.SimpleNamespace(is_done=lambda: False, edit_message=edit_message),
        )
        file = discord.File(io.BytesIO(b"png"), filename="board.png")
        await edit_panel_v2(interaction, wrapped, files=[file])
        kwargs = edit_message.call_args.kwargs
        self.assertEqual(kwargs["attachments"], [file])
        self.assertIs(kwargs["view"], wrapped)

    async def test_edit_message_v2_passes_files(self):
        import io

        from core.support.panel_v2 import edit_message_v2

        message = types.SimpleNamespace(edit=AsyncMock())
        view = discord.ui.LayoutView(timeout=None)
        file = discord.File(io.BytesIO(b"png"), filename="board.png")
        await edit_message_v2(message, view, files=[file])
        self.assertEqual(message.edit.call_args.kwargs["attachments"], [file])


if __name__ == "__main__":
    unittest.main()
