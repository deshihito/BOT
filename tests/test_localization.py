import types
import unittest
from unittest.mock import AsyncMock, patch

from core import localization
from cogs.localization import LanguageView, LocalizationCog


class LocalizationTest(unittest.IsolatedAsyncioTestCase):
    def test_normalize_locale_uses_supported_base_language_and_english_fallback(self):
        self.assertEqual(localization.normalize_locale("ja-JP"), "ja")
        self.assertEqual(localization.normalize_locale("ar-SA"), "ar")
        self.assertEqual(localization.normalize_locale("fr-FR"), "en")
        self.assertEqual(localization.guild_locale(1, types.SimpleNamespace(get=lambda *_: {})), "en")

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


if __name__ == "__main__":
    unittest.main()
