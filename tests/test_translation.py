import types
import unittest
from unittest.mock import AsyncMock

from core import localization, translation


class TranslationTest(unittest.IsolatedAsyncioTestCase):
    async def test_settings_share_localization_locale(self):
        store = types.SimpleNamespace(
            get=lambda guild_id, section: (
                {"enabled": True} if section == translation.TRANSLATION_SECTION else {"locale": "ja"}
            )
        )
        settings = translation.translation_settings(42, store)
        self.assertEqual(settings, {"enabled": True, "locale": "ja"})

    async def test_translate_message_uses_selected_locale(self):
        client = types.SimpleNamespace(translate=AsyncMock(return_value="こんにちは"))
        result = await translation.translate_message("hello", "ja", client=client)
        self.assertEqual(result, "こんにちは")
        client.translate.assert_awaited_once_with("hello", source="auto", target="ja")

    def test_supported_locales_are_valid_translation_targets(self):
        for locale in localization.SUPPORTED_LOCALES:
            self.assertEqual(localization.normalize_locale(locale), locale)


if __name__ == "__main__":
    unittest.main()
