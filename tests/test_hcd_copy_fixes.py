"""HCD監査 quick fix（文言系）の回帰テスト。

- #1 「Botのログを確認してください」がユーザ向け文から消えていること
- #2 NOT_LOADED 系に回復手段が入っていること
- #3 /help「コイン」カテゴリが現行マネー機能を案内すること
- #4 サーバーアシスト入口が全機能を一覧に載せ、開発都合の表現を含まないこと
- #5 /game の説明文体と GAME_GENRES の目的文
- #6 サーバーアシストジャンル説明が部分列挙でないこと
- #8 言語設定に実対応範囲の注記が出ること
"""

from __future__ import annotations

import os
import sys
import types
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from core import messages
from core.help import command_meta
from core.support import localization  # noqa: E402


class LogPointerRemovalTest(unittest.TestCase):
    def test_no_user_facing_log_pointer_remains(self):
        offenders = []
        for base in ("cogs", "core"):
            for dirpath, _dirs, files in os.walk(os.path.join(ROOT, base)):
                for name in files:
                    if not name.endswith(".py"):
                        continue
                    path = os.path.join(dirpath, name)
                    text = open(path, encoding="utf-8").read()
                    if "ログを確認してください" in text:
                        offenders.append(os.path.relpath(path, ROOT))
        self.assertEqual(offenders, [])


class NotLoadedRecoveryTest(unittest.TestCase):
    def test_not_loaded_messages_include_recovery(self):
        for value in (
            messages.MARKET_NOT_LOADED,
            messages.ITEMS_NOT_LOADED,
            messages.WORKSHOP_NOT_LOADED,
            messages.CIRCULATION_NOT_LOADED,
        ):
            self.assertIn("再度お試しください", value)
            self.assertIn("Botの運営に連絡してください", value)


class CoinHelpTest(unittest.TestCase):
    def test_coin_category_covers_current_money_features(self):
        category = next(c for c in command_meta.CATEGORIES if c["id"] == "economy")
        guide = category["guide"]
        for keyword in ("市場", "アゴトークン", "アイテム", "宝箱", "工房", "合成", "採掘", "宝くじ", "盗む"):
            self.assertIn(keyword, guide)
        self.assertIn("マネー", category["description"] + guide)


class ServerAssistHomeTest(unittest.TestCase):
    def test_home_embed_lists_every_feature(self):
        # 導線最適化 S3 で仕様変更: 機能一覧は AssistFeatureSelect の option が担い、
        # ホーム embed はタイトル＋説明だけ（同一画面の二重表示をしない）。
        from cogs.server_assist import ServerAssistHomeView, ServerAssistCog

        cog = ServerAssistCog(types.SimpleNamespace())
        self.assertGreater(len(cog.features), 20)
        embed = ServerAssistHomeView(cog).embed()
        self.assertEqual(len(embed.fields), 0)
        self.assertNotIn("ProBot", embed.description)
        self.assertNotIn("下のメニューから機能を選んでください", embed.description)


class GameCopyTest(unittest.TestCase):
    def test_game_genre_descriptions_are_purpose_text(self):
        from cogs.game import GAME_GENRES

        for _key, (_label, description) in GAME_GENRES.items():
            self.assertNotIn("、", description)

    def test_game_command_description_matches_panel_style(self):
        source = open(os.path.join(ROOT, "core", "game", "game", "cog.py"), encoding="utf-8").read()
        self.assertIn('description="ゲームの操作パネルを表示します"', source)


class SupportGenreTest(unittest.TestCase):
    def test_assist_genre_description_is_not_partial_listing(self):
        from core.support.common import SUPPORT_GENRES

        _label, description = SUPPORT_GENRES["assist"]
        self.assertEqual(description, "サーバー運営の細かな設定をまとめた入口")


class LanguageNoteTest(unittest.TestCase):
    def test_support_note_exists_in_both_working_languages(self):
        self.assertIn("準備中", localization.text("language_support_note", "ja"))
        self.assertIn("some screens", localization.text("language_support_note", "en"))

    def test_language_embed_shows_support_note(self):
        from cogs.localization import LocalizationCog

        embed = LocalizationCog(None).language_embed("ja")
        self.assertIn("対応状況", embed.description)


if __name__ == "__main__":
    unittest.main()
