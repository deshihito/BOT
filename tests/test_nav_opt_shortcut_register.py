# -*- coding: utf-8 -*-
"""導線最適化 M9（その場でショートカット登録）の固定テスト。"""
import unittest


class RegisterButtonTest(unittest.TestCase):
    def _panels(self):
        from core.general.panel import GeneralPanel
        from core.support.panel import SupportPanelView
        from core.voice.hub import VoicePanelView

        return GeneralPanel(None), SupportPanelView(None), VoicePanelView(None)

    def test_normal_panels_have_register_button(self):
        from core.general.shortcuts import RegisterShortcutButton

        for panel in self._panels():
            labels = [type(c).__name__ for c in panel.children]
            self.assertIn("RegisterShortcutButton", labels, type(panel).__name__)
            self.assertNotIn("ShortcutCommitButton", labels, type(panel).__name__)

    def test_shortcut_mode_panels_keep_commit_button(self):
        from core.general.panel import GeneralPanel

        panel = GeneralPanel(None, shortcut_mode=True)
        labels = [type(c).__name__ for c in panel.children]
        self.assertIn("ShortcutCommitButton", labels)
        self.assertNotIn("RegisterShortcutButton", labels)


if __name__ == "__main__":
    unittest.main()
