"""アクションレジストリ（core/action_registry）の整合性テスト。

- 全アクション id が一意で、既存の正リスト（GENERAL_ACTIONS / SUPPORT_ACTIONS /
  GAME_ORDER）と一致すること
- SHORTCUT_ROOTS がレジストリから生成され、従来 SHORTCUT_ROOTS に欠落していた
  /support の15件がショートカット候補に含まれること
- AI tools 候補で BLOCKED 相当が除外され、従来許可分が残ること
- ParamSpec / ActionSpec の整合性検証が効くこと
を確かめる。
"""

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from core.general import action_registry  # noqa: E402
from core.general.action_registry import ActionRegistry, ActionSpec, ParamSpec  # noqa: E402

# 従来 SHORTCUT_ROOTS の support に無かった15件（仕様書 §2.2）。
MISSING_SUPPORT_VALUES = {
    "sticky", "giveaway", "auth_panel", "role_panel", "language", "auto_react",
    "sns_notify", "quest_notify", "levelup_notify", "voice_trigger",
    "sokunuke_status", "sokunuke_on", "sokunuke_off", "sokunuke_vc_on", "sokunuke_vc_off",
}


class RegistryConsistencyTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.registry = action_registry.default_registry()

    def test_ids_are_unique_and_well_formed(self):
        specs = self.registry.all()
        ids = [spec.id for spec in specs]
        self.assertEqual(len(ids), len(set(ids)))
        for spec in specs:
            self.assertEqual(spec.id, f"{spec.root}:{spec.value}")
            self.assertIn(spec.root, action_registry.ROOT_LABELS)

    def test_support_registration_matches_support_actions(self):
        from cogs.support import SUPPORT_ACTIONS
        from core.support.server_assist import discover_features

        registered = {spec.value for spec in self.registry.by_root("support")}
        expected = {choice.value for choice in SUPPORT_ACTIONS}
        # 導線最適化 M2: サーバーアシスト機能が assist_<key> として加わる
        expected |= {f"assist_{feature.key}" for feature in discover_features()}
        self.assertEqual(registered, expected)
        self.assertEqual(len(registered), 33 + len(discover_features()))

    def test_general_registration_matches_general_actions(self):
        from cogs.general import GENERAL_ACTIONS

        registered = {spec.value for spec in self.registry.by_root("general")}
        expected = {
            value
            for items in GENERAL_ACTIONS.values()
            for _label, value in items
        }
        self.assertEqual(registered, expected)

    def test_game_registration_matches_game_order(self):
        from core.game.game.game_guides import GAME_ORDER

        registered = {spec.value for spec in self.registry.by_root("game")}
        self.assertEqual(registered, {f"game:{game}" for game in GAME_ORDER})

    def test_vc_includes_changer_start(self):
        # changer_start は dispatch_voice_action が引数なしで実行できるため候補に含める。
        vc_values = {spec.value for spec in self.registry.by_root("vc")}
        self.assertIn("changer_start", vc_values)
        # 導線最適化 M4: フォーム系9件（gvc/tts/trigger/echo_delay）を追加し 27→36
        # テーマ変更の追加で 36→37（常設ルーム作成は !gvcperm コマンドだけ）
        self.assertEqual(len(vc_values), 37)


class ShortcutRootsGenerationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from cogs.general import SHORTCUT_ROOTS

        cls.roots = SHORTCUT_ROOTS

    def test_shape_and_root_order(self):
        self.assertEqual(list(self.roots), ["general", "vc", "game", "support", "help"])
        for root, (label, items) in self.roots.items():
            self.assertEqual(label, f"/{root}")
            for item_label, value in items:
                self.assertIsInstance(item_label, str)
                self.assertIsInstance(value, str)

    def test_support_candidates_cover_all_33_including_missing_15(self):
        from core.support.server_assist import discover_features

        values = {value for _label, value in self.roots["support"][1]}
        # 導線最適化 M2: 従来30件＋グローバルチャット＋vc_auto_start＋bot_fixer で33件＋アシスト機能（assist_<key>）が候補に入る
        self.assertEqual(len(values), 33 + len(discover_features()))
        self.assertTrue(MISSING_SUPPORT_VALUES <= values)
        self.assertTrue(
            {f"assist_{feature.key}" for feature in discover_features()} <= values)

    def test_general_candidates_match_legacy_derivation(self):
        from cogs.general import GENERAL_ACTIONS

        blocked_values = {
            action_id.split(":", 1)[1]
            for action_id in action_registry.MESSAGE_SHORTCUT_BLOCKED_IDS
            if action_id.startswith("general:")
        }
        expected = {
            value
            for items in GENERAL_ACTIONS.values()
            for _label, value in items
            if value != "shortcut_manage" and value not in blocked_values
        }
        values = {value for _label, value in self.roots["general"][1]}
        self.assertEqual(values, expected)

    def test_game_and_help_candidates_unchanged(self):
        from core.game.game.game_guides import GAME_ORDER

        game_values = [value for _label, value in self.roots["game"][1]]
        self.assertEqual(game_values, [f"game:{game}" for game in GAME_ORDER])
        self.assertEqual(self.roots["help"][1], [("ヘルプを表示", "overview")])

    def test_generated_roots_equal_registry_generation(self):
        generated = action_registry.build_shortcut_roots()
        self.assertEqual(
            {root: (label, list(items)) for root, (label, items) in generated.items()},
            {root: (label, list(items)) for root, (label, items) in self.roots.items()},
        )


class AICandidatesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from core.general.ai_tools import ai_tools_router
        cls.router = ai_tools_router
        cls.candidates = ai_tools_router.action_candidates()

    def test_blocked_actions_are_excluded(self):
        for key in self.router.BLOCKED_ACTIONS:
            self.assertNotIn(key, self.candidates)
        for key in ("support:clear", "general:pay",
                    "vc:record_start", "vc:transcribe_start", "general:miq_settings"):
            self.assertNotIn(key, self.candidates)

    def test_previously_allowed_actions_remain(self):
        # E-9: general:status / general:exp_status は表示系ショートカットで
        # AI 経由では実行できないため候補から除外された（別テストで担保）。
        for key in ("vc:join", "vc:leave",
                    "support:bumprta_status", "support:vc_log", "support:server_assist",
                    "vc:record_status", "vc:record_pitch", "vc:echo_status",
                    "vc:karaoke_score", "vc:changer_stop", "vc:changer_status",
                    "vc:gvc_room_list", "vc:gvc_chat_disconnect", "vc:tts_stop",
                    "vc:trigger_panel", "help:overview"):
            self.assertIn(key, self.candidates)

    def test_new_support_candidates_are_limited_to_sokunuke_status(self):
        # 今回増える support 15件のうち、AI 候補に入るのは読み取り専用の状態確認だけ。
        self.assertIn("support:sokunuke_status", self.candidates)
        for value in MISSING_SUPPORT_VALUES - {"sokunuke_status"}:
            self.assertNotIn(f"support:{value}", self.candidates)

    def test_candidate_shape(self):
        for key, item in self.candidates.items():
            # PR 4 で候補に params スキーマと risk が加わった。
            self.assertEqual(set(item), {"root", "value", "label", "genre", "risk", "params"})
            self.assertEqual(key, f"{item['root']}:{item['value']}".lower())
            self.assertEqual(item["genre"], f"/{item['root']}")


class ConfirmTierTest(unittest.TestCase):
    """D-3 決定: 7件を risk="confirm" に格上げし、残り22件は blocked 維持。"""

    CONFIRM_IDS = {
        "support:bumprta_on", "support:bumprta_off",
        "vc:echo_start", "vc:karaoke_start", "vc:global_start", "vc:match_start",
        "vc:changer_start",
    }
    BLOCKED_IDS = {
        "general:pay", "general:fujo_register", "general:fujo_freeze",
        "general:fujo_panic_disable", "general:shortcut_manage", "general:aitools",
        "general:ai_default", "general:image_default", "general:reasoning_default",
        "general:miq_settings", "general:meme_create", "general:story54",
        "general:token_buy", "general:token_sell",
        "general:item_buy", "general:item_use", "general:box_open",
        "general:machine_buy", "general:workshop_claim", "general:craft",
        "general:mining", "general:lottery_buy", "general:steal",
        "general:slot", "general:double", "general:blackjack", "general:dice",
        "general:bj_duel",
        "general:daily_report", "general:gacha",
        "support:clear", "support:role_bulk", "support:muted", "support:ticket",
        "support:honeypot", "support:whisper", "support:binjou",
        "support:message_log", "support:moderation_log",
        "vc:record_start", "vc:transcribe_start",
    }

    @classmethod
    def setUpClass(cls):
        from core.general.ai_tools import ai_tools_router
        cls.registry = action_registry.default_registry()
        cls.candidates = ai_tools_router.action_candidates()

    def test_id_sets_match_the_decision(self):
        self.assertEqual(set(action_registry.AI_CONFIRM_IDS), self.CONFIRM_IDS)
        self.assertEqual(set(action_registry.AI_BLOCKED_IDS), self.BLOCKED_IDS)
        self.assertFalse(action_registry.AI_CONFIRM_IDS & action_registry.AI_BLOCKED_IDS)

    def test_confirm_specs_keep_aitools_surface(self):
        for action_id in self.CONFIRM_IDS:
            spec = self.registry.by_id(action_id)
            self.assertEqual(spec.risk, "confirm", action_id)
            self.assertIn("aitools", spec.surfaces, action_id)

    def test_blocked_specs_stay_blocked(self):
        for action_id in self.BLOCKED_IDS:
            spec = self.registry.by_id(action_id)
            self.assertEqual(spec.risk, "blocked", action_id)
            self.assertNotIn("aitools", spec.surfaces, action_id)

    def test_candidates_include_confirm_and_exclude_blocked(self):
        for action_id in self.CONFIRM_IDS:
            self.assertIn(action_id, self.candidates)
            self.assertEqual(self.candidates[action_id]["risk"], "confirm")
        for action_id in self.BLOCKED_IDS:
            self.assertNotIn(action_id, self.candidates)


class SpecValidationTest(unittest.TestCase):
    def test_duplicate_registration_is_an_error(self):
        registry = ActionRegistry()
        spec = action_registry.make_action("general", "status", "状態", "economy", "経済")
        registry.register(spec)
        with self.assertRaises(ValueError):
            registry.register(spec)

    def test_action_id_must_match_root_and_value(self):
        with self.assertRaises(ValueError):
            ActionSpec(id="general:wrong", root="general", value="status",
                       label="状態", genre="economy", genre_label="経済")

    def test_unknown_risk_and_surface_are_errors(self):
        base = dict(id="general:status", root="general", value="status",
                    label="状態", genre="economy", genre_label="経済")
        with self.assertRaises(ValueError):
            ActionSpec(**base, risk="unknown")
        with self.assertRaises(ValueError):
            ActionSpec(**base, surfaces=frozenset({"panel", "unknown"}))

    def test_param_choice_default_must_be_a_choice(self):
        with self.assertRaises(ValueError):
            ParamSpec(name="mode", label="モード", type="choice",
                      choices=(("A", "a"), ("B", "b")), default="z")

    def test_param_duplicate_choices_are_an_error(self):
        with self.assertRaises(ValueError):
            ParamSpec(name="mode", label="モード", type="choice",
                      choices=(("A", "a"), ("B", "a")))

    def test_param_range_contradiction_is_an_error(self):
        with self.assertRaises(ValueError):
            ParamSpec(name="delay", label="遅延", type="number", min_value=10, max_value=1)
        with self.assertRaises(ValueError):
            ParamSpec(name="delay", label="遅延", type="int",
                      min_value=1, max_value=10, default=99)

    def test_param_unknown_type_is_an_error(self):
        with self.assertRaises(ValueError):
            ParamSpec(name="x", label="x", type="unknown")

    def test_valid_param_and_action_pass(self):
        param = ParamSpec(name="delay", label="遅延", type="number",
                          min_value=0.1, max_value=30.0, default=1.0)
        spec = action_registry.make_action(
            "vc", "echo_delay", "やまびこ遅延", "vc", "/vc", params=(param,))
        self.assertEqual(spec.params, (param,))


if __name__ == "__main__":
    unittest.main()
