import types
import unittest
from unittest.mock import patch

import discord

from core import localization


class LocalizationTransportTest(unittest.TestCase):
    def test_localize_kwargs_translates_content_embed_and_view(self):
        embed = discord.Embed(title="日本語タイトル", description="日本語本文")
        embed.add_field(name="項目", value="内容")
        view = discord.ui.View()
        button = discord.ui.Button(label="実行")
        view.add_item(button)
        sender = types.SimpleNamespace(guild=types.SimpleNamespace(id=77))
        store = types.SimpleNamespace(get=lambda guild_id, section: {"locale": "en"})
        with patch.object(localization, "_ENGLISH_PAIRS", [
            ("日本語タイトル", "English title"),
            ("日本語本文", "English body"),
            ("項目", "Field"),
            ("内容", "Content"),
            ("実行", "Run"),
        ]), patch.object(localization, "get_store", return_value=store):
            result = localization.localize_kwargs(
                sender, {"content": "日本語本文", "embed": embed, "view": view}
            )
        self.assertEqual(result["content"], "English body")
        self.assertEqual(embed.title, "English title")
        self.assertEqual(embed.description, "English body")
        self.assertEqual(embed.fields[0].name, "Field")
        self.assertEqual(button.label, "Run")

    def test_japanese_locale_keeps_original_text(self):
        sender = types.SimpleNamespace(guild=types.SimpleNamespace(id=77))
        store = types.SimpleNamespace(get=lambda guild_id, section: {"locale": "ja"})
        with patch.object(localization, "_ENGLISH_PAIRS", [("日本語", "English")]), \
             patch.object(localization, "get_store", return_value=store):
            result = localization.localize_kwargs(sender, {"content": "日本語"})
        self.assertEqual(result["content"], "日本語")

    def test_localization_can_be_skipped_for_transcribed_user_content(self):
        sender = types.SimpleNamespace(guild=types.SimpleNamespace(id=77))
        store = types.SimpleNamespace(get=lambda guild_id, section: {"locale": "en"})
        payload = {"content": "今日は日本語で話します", "_agobot_skip_localization": True}
        with patch.object(localization, "_ENGLISH_PAIRS", [("日本語", "English")]), \
             patch.object(localization, "get_store", return_value=store):
            result = localization.localize_kwargs(sender, payload)
        self.assertEqual(result["content"], "今日は日本語で話します")

    def test_localize_nested_components_v2_panel(self):
        button = discord.ui.Button(label="設定を保存")
        nested_panel = types.SimpleNamespace(
            children=[types.SimpleNamespace(children=[button])],
        )
        sender = types.SimpleNamespace(guild=types.SimpleNamespace(id=77))
        store = types.SimpleNamespace(get=lambda guild_id, section: {"locale": "en"})
        with patch.object(localization, "_ENGLISH_PAIRS", [("設定を保存", "Save settings")]), \
             patch.object(localization, "get_store", return_value=store):
            localization.localize_kwargs(sender, {"view": nested_panel})
        self.assertEqual(button.label, "Save settings")


if __name__ == "__main__":
    unittest.main()
