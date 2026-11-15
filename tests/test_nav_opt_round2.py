# -*- coding: utf-8 -*-
"""導線最適化ラウンド2（概念分散の表示整理・マネーパネル作法・/support公開化）の固定テスト。"""
import asyncio
import unittest
from types import SimpleNamespace


class GlobalVcGenreTest(unittest.TestCase):
    """R2-1: グローバルVCの開始/終了はルーム管理と同じジャンルに置く。"""

    def test_global_actions_moved_to_gvc_rooms(self):
        from core.vc.common import VOICE_ACTIONS_BY_GENRE, VOICE_GENRES

        community = [v for _l, v in VOICE_ACTIONS_BY_GENRE["community"]]
        rooms = [v for _l, v in VOICE_ACTIONS_BY_GENRE["gvc_rooms"]]
        self.assertEqual(community, ["match_start", "match_stop"])
        self.assertIn("global_start", rooms)
        self.assertIn("global_stop", rooms)
        self.assertEqual(VOICE_GENRES["community"][0], "ランダム通話")
        # /vc パネル総数（テーマ変更・メンバー確認の追加で 35 → 37、機能数再編の
        # vc ルート拡張（音楽6件＋グロチャ自動接続1件）で 37 → 44、言語設定で 44 → 45、
        # 音楽の自動再生追加で 45 → 46。常設作成は ! コマンド化）
        total = sum(len(items) for items in VOICE_ACTIONS_BY_GENRE.values())
        self.assertEqual(total, 46)


class SupportScopeLabelTest(unittest.TestCase):
    """R2-2 → 導線最適化 U2: /support の RTA ジャンルは 1件だったため
    boardnotify へ吸収し、ジャンル自体が無くなった。"""

    def test_rta_genre_absorbed_into_boardnotify(self):
        from cogs.support import SUPPORT_ACTIONS_BY_GENRE, SUPPORT_GENRES

        self.assertNotIn("rta", SUPPORT_GENRES)
        boardnotify = [v for _l, v in SUPPORT_ACTIONS_BY_GENRE["boardnotify"]]
        self.assertIn("sokunuke_settings", boardnotify)
        self.assertEqual(SUPPORT_GENRES["boardnotify"][0], "boardNotify")



if __name__ == "__main__":
    unittest.main()
