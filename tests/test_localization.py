import types
import unittest
from unittest.mock import AsyncMock, patch

from core.support import localization
from cogs.localization import LanguageView, LocalizationCog


class LocalizationTest(unittest.IsolatedAsyncioTestCase):
    def test_normalize_locale_uses_supported_base_language_and_japanese_default(self):
        self.assertEqual(localization.normalize_locale("ja-JP"), "ja")
        self.assertEqual(localization.normalize_locale("ar-SA"), "ar")
        self.assertEqual(localization.normalize_locale("fr-FR"), "ja")
        self.assertEqual(localization.guild_locale(1, types.SimpleNamespace(get=lambda *_: {})), "ja")

    def test_all_supported_locales_have_flag_and_label(self):
        for locale in localization.SUPPORTED_LOCALES:
            self.assertIn(locale, localization.LOCALE_LABELS)
            self.assertIn(locale, localization.LOCALE_FLAGS)
            self.assertEqual(localization.FLAG_TO_LOCALE[localization.LOCALE_FLAGS[locale]], locale)

    def test_language_view_contains_every_supported_locale(self):
        view = LanguageView(LocalizationCog(None), "en")
        select = view.children[0]
        self.assertEqual({option.value for option in select.options}, set(localization.SUPPORTED_LOCALES))
        self.assertTrue(next(option for option in select.options if option.value == "en").default)

    async def test_set_locale_saves_and_renders_selected_locale(self):
        store = types.SimpleNamespace(
            ensure_loaded=AsyncMock(),
            update=AsyncMock(),
            get=lambda *_: {},
        )
        cog = LocalizationCog(None)
        with patch("cogs.localization.get_store", return_value=store):
            await cog.set_locale(42, "ja")
        store.update.assert_awaited_once_with(42, localization.LANGUAGE_SECTION, locale="ja")
        self.assertIn("AGOBOT", cog.language_embed("ja").description)


class LocalizationV2ViewTest(unittest.TestCase):
    """Components V2 (LayoutView) でも _translate_view が届くことの実地検証。"""

    def _layout(self):
        import discord

        view = discord.ui.LayoutView(timeout=None)
        container = discord.ui.Container(accent_colour=0xFFFFFF)
        text = discord.ui.TextDisplay("言語設定")
        container.add_item(text)
        row = discord.ui.ActionRow()
        button = discord.ui.Button(label="戻る", custom_id="v2test:back")
        row.add_item(button)
        container.add_item(row)
        view.add_item(container)
        return view, text, button

    def test_text_display_and_action_row_button_are_translated(self):
        view, text, button = self._layout()
        localization.localize_object(view, "en")
        self.assertEqual(text.content, "Language Settings")
        self.assertEqual(button.label, "Back")

    def test_section_accessory_button_is_translated(self):
        import discord

        section = discord.ui.Section(
            discord.ui.TextDisplay("言語設定"),
            accessory=discord.ui.Button(label="閉じる", custom_id="v2test:close"),
        )
        view = discord.ui.LayoutView(timeout=None)
        container = discord.ui.Container()
        container.add_item(section)
        view.add_item(container)
        localization.localize_object(view, "en")
        self.assertEqual(section.children[0].content, "Language Settings")
        self.assertEqual(section.accessory.label, "Close")

    def test_panel_v2_wrapper_text_is_translated(self):
        import discord

        from core.panel_v2 import as_panel_v2

        panel = discord.ui.View(timeout=None)
        panel.embed = lambda: discord.Embed(title="言語設定")
        wrapped = as_panel_v2(panel)
        localization.localize_object(wrapped, "en")
        texts = []

        def collect(item):
            content = getattr(item, "content", None)
            if isinstance(content, str):
                texts.append(content)
            for attribute in ("children", "items", "components"):
                for child in getattr(item, attribute, None) or ():
                    collect(child)

        collect(wrapped)
        self.assertTrue(any("Language Settings" in text for text in texts), texts)

    def test_japanese_locale_leaves_v2_view_untouched(self):
        view, text, button = self._layout()
        localization.localize_object(view, "ja")
        self.assertEqual(text.content, "言語設定")
        self.assertEqual(button.label, "戻る")


if __name__ == "__main__":
    unittest.main()
