# -*- coding: utf-8 -*-
"""導線最適化ラウンド2（概念分散の表示整理・マネーパネル作法・/support公開化）の固定テスト。"""
import asyncio
import unittest
from types import SimpleNamespace


class GlobalVcGenreTest(unittest.TestCase):
    """R2-1: グローバルVCの開始/終了はルーム管理と同じジャンルに置く。"""

    def test_global_actions_moved_to_gvc_rooms(self):
        from core.voice.common import VOICE_ACTIONS_BY_GENRE, VOICE_GENRES

        community = [v for _l, v in VOICE_ACTIONS_BY_GENRE["community"]]
        rooms = [v for _l, v in VOICE_ACTIONS_BY_GENRE["gvc_rooms"]]
        self.assertEqual(community, ["match_start", "match_stop"])
        self.assertIn("global_start", rooms)
        self.assertIn("global_stop", rooms)
        self.assertEqual(VOICE_GENRES["community"][0], "ランダム通話")
        # 機能は減らない（/vc パネル総数 35 のまま）
        total = sum(len(items) for items in VOICE_ACTIONS_BY_GENRE.values())
        self.assertEqual(total, 35)


class SupportScopeLabelTest(unittest.TestCase):
    """R2-2: /support の RTA ジャンルは「設定」側であることをラベルで示す。"""

    def test_rta_genre_label(self):
        from cogs.support import SUPPORT_GENRES

        self.assertEqual(SUPPORT_GENRES["rta"][0], "RTA設定")



if __name__ == "__main__":
    unittest.main()
