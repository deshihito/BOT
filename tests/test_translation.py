import types
import unittest
from unittest.mock import AsyncMock

from core import localization, translation


class TranslationTest(unittest.IsolatedAsyncioTestCase):
    async def test_settings_share_localization_locale_as_target_by_default(self):
        store = types.SimpleNamespace(
            get=lambda guild_id, section: (
                {"enabled": True} if section == translation.TRANSLATION_SECTION else {"locale": "ja"}
            )
        )
        settings = translation.translation_settings(42, store)
        self.assertEqual(
            settings,
            {"enabled": True, "source_locale": "auto", "target_locale": "ja"},
        )

    async def test_settings_accept_explicit_source_and_target(self):
        store = types.SimpleNamespace(
            get=lambda *_: {"enabled": True, "source_locale": "ja", "target_locale": "en"}
        )
        self.assertEqual(
            translation.translation_settings(42, store),
            {"enabled": True, "source_locale": "ja", "target_locale": "en"},
        )

    async def test_translate_message_uses_source_and_target(self):
        client = types.SimpleNamespace(translate=AsyncMock(return_value="hello"))
        result = await translation.translate_message("こんにちは", "ja", "en", client=client)
        self.assertEqual(result, "hello")
        client.translate.assert_awaited_once_with("こんにちは", source="ja", target="en")

    async def test_same_explicit_source_and_target_skips_api(self):
        client = types.SimpleNamespace(translate=AsyncMock())
        result = await translation.translate_message("hello", "en", "en", client=client)
        self.assertEqual(result, "hello")
        client.translate.assert_not_awaited()

    def test_supported_locales_are_valid_translation_targets(self):
        for locale in localization.SUPPORTED_LOCALES:
            self.assertEqual(localization.normalize_locale(locale), locale)


if __name__ == "__main__":
    unittest.main()
