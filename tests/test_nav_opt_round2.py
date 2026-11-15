# -*- coding: utf-8 -*-
"""導線最適化ラウンド2（概念分散の表示整理・マネーパネル作法・/support公開化）の固定テスト。"""
import asyncio
import unittest
from types import SimpleNamespace


class GlobalVcGenreTest(unittest.TestCase):
    """R2-1: グローバルVCの開始/終了はルーム管理と同じジャンルに置く。
    導線最適化 U3: ランダム通話の開始/終了も同じジャンルに一本化し、
    community ジャンル自体を廃止した（2件ジャンルの吸収）。"""

    def test_global_actions_moved_to_gvc_rooms(self):
        from core.vc.common import VOICE_ACTIONS_BY_GENRE, VOICE_GENRES

        self.assertNotIn("community", VOICE_GENRES)
        self.assertNotIn("community", VOICE_ACTIONS_BY_GENRE)
        rooms = [v for _l, v in VOICE_ACTIONS_BY_GENRE["gvc_rooms"]]
        self.assertIn("global_start", rooms)
        self.assertIn("global_stop", rooms)
        self.assertIn("match_start", rooms)
        self.assertIn("match_stop", rooms)
        self.assertEqual(VOICE_GENRES["gvc_rooms"][0], "グローバルVC")
        # /vc パネル総数（テーマ変更・メンバー確認の追加で 35 → 37、機能数再編の
        # vc ルート拡張（音楽6件＋グロチャ自動接続1件）で 37 → 44、言語設定で 44 → 45、
        # 音楽の自動再生追加で 45 → 46。常設作成は ! コマンド化）
        # 導線最適化 U3: やまびこ状態 (echo_status) の追加で 46 → 47。
        # community 吸収はジャンル間の移動だけで総数は変わらない。
        total = sum(len(items) for items in VOICE_ACTIONS_BY_GENRE.values())
        self.assertEqual(total, 47)


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
