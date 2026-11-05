# -*- coding: utf-8 -*-
"""監査 #4（ジャンル説明の削減）の固定テスト。

- パネルは説明文なし（タイトルだけ）で構築できること
- ジャンル説明は「機能名の列挙」を書かず、ラベルから読み取れない情報だけを残すこと
"""
import unittest

from cogs.general import GENERAL_ACTIONS, GENERAL_GENRES, GeneralPanel, ShortcutRootPanel
from cogs.help import overview_embed
from cogs.sio_voice import VOICE_ACTIONS_BY_GENRE, VOICE_GENRES, VoicePanelView
from cogs.support import SUPPORT_ACTIONS_BY_GENRE, SUPPORT_GENRES, SupportPanelView
from core import action_registry
from core.panel_v2 import embed_text


class PanelEmbedTest(unittest.TestCase):
    """自明な操作説明を除去したパネルが、説明文なしで構築・描画できること。"""

    def assert_title_only(self, panel, title):
        embed = panel.embed()
        self.assertEqual(embed.title, title)
        self.assertIsNone(embed.description)
        # panel_v2 のテキスト化でもタイトルだけになる（描画が崩れない）
        self.assertEqual(embed_text(embed), f"## {title}")

    def test_general_panel(self):
        self.assert_title_only(GeneralPanel(None), "一般機能")
        self.assert_title_only(GeneralPanel(None, genre="money"), "一般機能")

    def test_voice_panel(self):
        title = "<:vol:1563559476265488414> VC・音楽機能パネル"
        self.assert_title_only(VoicePanelView(None), title)
        self.assert_title_only(VoicePanelView(None, genre="connection"), title)

    def test_support_panel(self):
        self.assert_title_only(SupportPanelView(None), "サポート操作")
        self.assert_title_only(SupportPanelView(None, genre="moderation"), "サポート操作")

    def test_shortcut_root_panel(self):
        self.assert_title_only(ShortcutRootPanel(), "ショートカット登録")

    def test_help_overview_keeps_only_useful_lines(self):
        embed = overview_embed({"categories": []})
        self.assertIn("`/help command:`", embed.description)
        self.assertIn("隠し機能", embed.description)
        self.assertNotIn("下のメニューからカテゴリを選ぶと", embed.description)
        self.assertNotIn("などを利用できます", embed.description)


class GenreDescriptionPolicyTest(unittest.TestCase):
    """ジャンル説明の削減方針: 列挙は空にし、残すのは読み取れない情報だけ。"""

    def test_general_genres(self):
        self.assertEqual(GENERAL_GENRES["money"][1], "")
        self.assertEqual(GENERAL_GENRES["rta"][1], "")
        self.assertEqual(GENERAL_GENRES["custom"][1], "")
        self.assertEqual(GENERAL_GENRES["translation"][1], "")
        self.assertEqual(GENERAL_GENRES["exp"][1], "チャット・VC・generalのEXPとレベル")
        self.assertEqual(GENERAL_GENRES["survival"][1], "メンバーの安否・不在の検知")
        self.assertEqual(GENERAL_GENRES["zeta"][1], "ロールプレイ会話")
        self.assertEqual(GENERAL_GENRES["miq"][1], "メッセージを引用画像にする")
        self.assertEqual(GENERAL_GENRES["meme"][1], "画像に上下テキストを入れてmeme画像を作成する")

    def test_support_genres(self):
        for genre in ("moderation", "roles", "language", "logs", "automation", "event", "rta"):
            self.assertEqual(SUPPORT_GENRES[genre][1], "", genre)
        # assist は HCD監査 quick fix #6 で部分列挙（5/22）をやめ、目的文に置換した
        self.assertEqual(
            SUPPORT_GENRES["assist"][1],
            "サーバー運営の細かな設定をまとめた入口",
        )

    def test_voice_genres(self):
        for genre in ("connection", "music", "studio", "trigger", "community", "gvc_rooms"):
            self.assertEqual(VOICE_GENRES[genre][1], "", genre)
        self.assertEqual(VOICE_GENRES["tts"][1], "VOICEVOXによるテキスト読み上げ")
        self.assertEqual(VOICE_GENRES["effects"][1], "ボイスチェンジャー")

    def test_no_genre_description_enumerates_action_labels(self):
        """説明文が配下の機能名を2つ以上そのまま含んでいないこと（列挙の禁止）。"""
        cases = [
            (GENERAL_GENRES, GENERAL_ACTIONS),
            (SUPPORT_GENRES, SUPPORT_ACTIONS_BY_GENRE),
            (VOICE_GENRES, VOICE_ACTIONS_BY_GENRE),
        ]
        for genres, actions_by_genre in cases:
            for genre, (_label, description) in genres.items():
                if not description:
                    continue
                labels = [label for label, _value in actions_by_genre.get(genre, [])]
                hits = [label for label in labels if label and label in description]
                self.assertLess(len(hits), 2, f"{genre}: {description} enumerates {hits}")

    def test_registry_descriptions_follow_genres(self):
        registry = action_registry.default_registry()
        self.assertEqual(registry.get("general:pay").description, "")
        self.assertEqual(registry.get("general:exp_status").description, "チャット・VC・generalのEXPとレベル")
        self.assertEqual(registry.get("general:fujo_register").description, "メンバーの安否・不在の検知")
        self.assertEqual(registry.get("support:server_assist").description,
                         "サーバー運営の細かな設定をまとめた入口")


if __name__ == "__main__":
    unittest.main()
