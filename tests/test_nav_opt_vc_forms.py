# -*- coding: utf-8 -*-
"""導線最適化 M4（vcフォーム系のレジストリ登録）/ M5（履歴セレクト横展開）の固定テスト。"""
import unittest


class VcFormRegistryTest(unittest.TestCase):
    def setUp(self):
        from core.general.action_registry import build_vc_actions

        self.specs = {spec.value: spec for spec in build_vc_actions()}

    def test_form_actions_registered(self):
        for value in ("gvc_room_create", "gvc_room_theme", "gvc_room_info",
                      "gvc_room_delete", "gvc_chat_connect", "tts_start", "tts_say", "tts_config",
                      "trigger_register", "echo_delay"):
            self.assertIn(value, self.specs, value)

    def test_start_stop_symmetry(self):
        # 停止があるものは開始も /quick から辿れる
        self.assertIn("tts_stop", self.specs)
        self.assertIn("tts_start", self.specs)
        self.assertIn("gvc_room_list", self.specs)
        self.assertIn("gvc_room_create", self.specs)
        self.assertIn("trigger_panel", self.specs)
        self.assertIn("trigger_register", self.specs)

    def test_form_actions_not_for_ai(self):
        for value in ("gvc_room_create", "gvc_room_theme", "gvc_room_delete",
                      "tts_start", "trigger_register", "echo_delay"):
            spec = self.specs[value]
            self.assertNotIn("aitools", spec.surfaces, value)
            self.assertIn("palette", spec.surfaces, value)
            self.assertIn("shortcut", spec.surfaces, value)

    def test_params_defined(self):
        create = self.specs["gvc_room_create"]
        names = {p.name: p for p in create.params}
        self.assertTrue(names["name"].required)
        self.assertIn("max_servers", names)
        self.assertIn("password", names)
        self.assertIn("desc", names)
        self.assertIn("theme", names)
        theme_change = {p.name for p in self.specs["gvc_room_theme"].params}
        self.assertEqual(theme_change, {"name", "theme"})
        # 常設ルームの作成はレジストリに無い（!gvcperm コマンドだけ）
        self.assertNotIn("gvc_room_create_perm", self.specs)
        delay = self.specs["echo_delay"].params
        self.assertEqual([p.name for p in delay], ["delay"])
        self.assertTrue(delay[0].required)
        connect = {p.name for p in self.specs["gvc_chat_connect"].params}
        self.assertEqual(connect, {"name", "password"})

    def test_total_vc_actions(self):
        self.assertEqual(len(self.specs), 38)  # 27 + M4の9件 + テーマ変更 + メンバー確認（常設作成は ! コマンド化）


class HistoryExpansionTest(unittest.TestCase):
    def test_voice_panel_with_history(self):
        from core.vc.hub import VoiceHistorySelect, VoicePanelView

        specs = [type("S", (), {"label": "VC参加", "value": "join"})()]
        view = VoicePanelView(None, history_specs=specs)
        history = [c for c in view.children if isinstance(c, VoiceHistorySelect)]
        self.assertEqual(len(history), 1)
        self.assertEqual(history[0].custom_id, "panel:vc:history")

    def test_voice_panel_without_history_unchanged(self):
        from core.vc.hub import VoiceHistorySelect, VoicePanelView

        view = VoicePanelView(None)
        self.assertFalse(any(isinstance(c, VoiceHistorySelect) for c in view.children))

    def test_game_hub_with_history(self):
        from cogs.game import GameHistorySelect, GameHubView

        specs = [type("S", (), {"label": "ゲーム開始: 人狼", "value": "game:jinrou"})()]
        view = GameHubView(None, history_specs=specs)
        history = [c for c in view.children if isinstance(c, GameHistorySelect)]
        self.assertEqual(len(history), 1)
        self.assertEqual(history[0].options[0].value, "jinrou")
        self.assertEqual(history[0].custom_id, "panel:game:history")


if __name__ == "__main__":
    unittest.main()
