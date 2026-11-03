import types
import unittest
from unittest.mock import AsyncMock, patch

from core import localization, translation


class TranslationTest(unittest.IsolatedAsyncioTestCase):
    def test_settings_are_scoped_to_user_and_use_guild_locale_as_default(self):
        user_store = types.SimpleNamespace(
            get=lambda key, default=None: {"enabled": True} if key == "42" else default
        )
        guild_store = types.SimpleNamespace(get=lambda *_: {"locale": "ja"})
        with patch("core.translation.get_guild_store", return_value=guild_store):
            settings = translation.translation_settings(42, 99, user_store)
        self.assertEqual(
            settings,
            {"enabled": True, "source_locale": "auto", "target_locale": "ja"},
        )

    def test_settings_accept_explicit_source_and_target(self):
        store = types.SimpleNamespace(
            get=lambda key, default=None: {
                "enabled": True, "source_locale": "ja", "target_locale": "en"
            }
        )
        self.assertEqual(
            translation.translation_settings(42, 99, store),
            {"enabled": True, "source_locale": "ja", "target_locale": "en"},
        )

    async def test_update_settings_uses_user_id_as_storage_key(self):
        store = types.SimpleNamespace(
            load_local=lambda: {"42": {"enabled": False}},
            set=AsyncMock(),
        )
        with patch.object(translation, "_store", store):
            await translation.update_translation_settings(42, enabled=True, target_locale="en")
        store.set.assert_awaited_once_with("42", {"enabled": True, "target_locale": "en"})

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
