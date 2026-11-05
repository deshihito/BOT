# -*- coding: utf-8 -*-
"""導線最適化ラウンド2（/support公開化）の固定テスト。"""
import asyncio
import unittest
from types import SimpleNamespace


class SupportPublicPanelTest(unittest.TestCase):
    """R2-6: /support ルートは公開化し、操作は呼び出し本人に制限する。"""

    def test_interaction_check(self):
        from core.support.panel import SupportPanelView

        panel = SupportPanelView(None, owner_id=111)
        owner = SimpleNamespace(user=SimpleNamespace(id=111))
        other = SimpleNamespace(user=SimpleNamespace(id=222))
        self.assertTrue(asyncio.run(panel.interaction_check(owner)))
        self.assertFalse(asyncio.run(panel.interaction_check(other)))

    def test_no_owner_means_unrestricted(self):
        from core.support.panel import SupportPanelView

        panel = SupportPanelView(None)
        anyone = SimpleNamespace(user=SimpleNamespace(id=999))
        self.assertTrue(asyncio.run(panel.interaction_check(anyone)))


if __name__ == "__main__":
    unittest.main()
