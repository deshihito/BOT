import unittest
from unittest.mock import patch

from core import localization


class LocaleCatalogTest(unittest.TestCase):
    def test_tr_reads_checked_in_catalog(self):
        self.assertEqual(localization.tr("language_settings_title", locale="en"), "Language settings")
        self.assertEqual(localization.tr("language_settings_title", locale="ja"), "言語設定")

    def test_tr_falls_back_to_english_for_missing_locale(self):
        with patch.dict(localization._KEY_CATALOGS, {
            "en": {"test.only_english": "English fallback"},
            "ja": {"test.only_english": "日本語の予備"},
        }, clear=False):
            self.assertEqual(localization.tr("test.only_english", locale="zh"), "English fallback")

    def test_tr_formats_values(self):
        self.assertEqual(
            localization.tr("language_saved", locale="en", language="Japanese"),
            "Language changed to Japanese.",
        )

    def test_libretranslate_url_is_configurable(self):
        with patch.dict("os.environ", {"LIBRETRANSLATE_URL": "http://translate.internal:5000"}):
            from core.libretranslate import LibreTranslateClient
            client = LibreTranslateClient()
        self.assertEqual(client.base_url, "http://translate.internal:5000")


if __name__ == "__main__":
    unittest.main()
