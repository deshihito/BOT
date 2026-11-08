"""ショートカット v2（params プリセット）のテスト。

- core/shortcuts の v2 保存と旧形式（action.options）との互換
- params の ParamSpec 検証（正常系・未知キー・型違い・範囲外・choices 外）
- レジストリの vc ParamSpec が dispatch_voice_action の実在引数と一致すること
- GeneralCog.execute_shortcut が vc にはフィルタ済み params を、game には
  params（旧 options と等価）を渡し、general / support は従来どおり呼ぶこと
"""

import inspect
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import AsyncMock

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from cogs.general import GeneralCog  # noqa: E402
from core.general import shortcut_settings as shortcuts
from core.general import action_registry  # noqa: E402
from core.general.action_registry import ParamSpec  # noqa: E402


class MemoryStore:
    def __init__(self):
        self.data = {}

    def get(self, guild_id, section):
        return self.data.get((guild_id, section), {})

    async def update(self, guild_id, section, **values):
        self.data[(guild_id, section)] = values

    async def ensure_loaded(self):
        return None


class ShortcutStorageV2Test(unittest.IsolatedAsyncioTestCase):
    async def test_add_stores_params_separately_from_action(self):
        store = MemoryStore()
        item = await shortcuts.add(store, 1, 2, "エコー3秒",
                                   {"root": "vc", "value": "echo_start"},
                                   params={"delay": 3})
        self.assertEqual(item["action"], {"root": "vc", "value": "echo_start"})
        self.assertEqual(item["params"], {"delay": 3.0})
        rows = shortcuts.for_user(store, 1, 2)
        self.assertEqual(rows[0]["params"], {"delay": 3.0})

    async def test_add_without_params_keeps_legacy_shape(self):
        store = MemoryStore()
        item = await shortcuts.add(store, 1, 2, "状態", {"root": "general", "value": "status"})
        self.assertNotIn("params", item)

    async def test_update_params_replace_clear_and_preserve(self):
        store = MemoryStore()
        item = await shortcuts.add(store, 1, 2, "チェンジャー",
                                   {"root": "vc", "value": "changer_start"},
                                   params={"pitch": 2})
        await shortcuts.update(store, 1, 2, item["id"], params={"pitch": 5, "buffer_ms": 100})
        row = shortcuts.for_user(store, 1, 2)[0]
        self.assertEqual(row["params"], {"pitch": 5.0, "buffer_ms": 100.0})
        # params=None（未指定）は変更しない。
        await shortcuts.update(store, 1, 2, item["id"], trigger="改名")
        row = shortcuts.for_user(store, 1, 2)[0]
        self.assertEqual(row["params"], {"pitch": 5.0, "buffer_ms": 100.0})
        # params={} はプリセットを消す。
        await shortcuts.update(store, 1, 2, item["id"], params={})
        row = shortcuts.for_user(store, 1, 2)[0]
        self.assertNotIn("params", row)

    async def test_add_rejects_invalid_vc_params(self):
        store = MemoryStore()
        with self.assertRaises(ValueError):  # 範囲外
            await shortcuts.add(store, 1, 2, "x", {"root": "vc", "value": "echo_start"},
                                params={"delay": 100})
        with self.assertRaises(ValueError):  # 未知のキー
            await shortcuts.add(store, 1, 2, "x", {"root": "vc", "value": "echo_start"},
                                params={"speed": 1})
        with self.assertRaises(ValueError):  # 型違い
            await shortcuts.add(store, 1, 2, "x", {"root": "vc", "value": "karaoke_start"},
                                params={"lyrics": 123})
        self.assertEqual(shortcuts.for_user(store, 1, 2), [])

    async def test_game_params_are_not_spec_validated(self):
        # game は start_game が **options をそのまま受け取る自由形式（従来動作）。
        store = MemoryStore()
        item = await shortcuts.add(store, 1, 2, "ウノ",
                                   {"root": "game", "value": "game:uno"},
                                   params={"wordlist": "standard", "anything": 1})
        self.assertEqual(item["params"], {"wordlist": "standard", "anything": 1})


class EffectiveParamsTest(unittest.TestCase):
    def test_legacy_options_become_params(self):
        item = {"action": {"root": "game", "value": "game:uno",
                           "options": {"wordlist": "standard"}}}
        self.assertEqual(shortcuts.effective_params(item), {"wordlist": "standard"})

    def test_v2_params_override_options_on_same_key(self):
        item = {"action": {"root": "game", "value": "game:uno",
                           "options": {"wordlist": "standard", "wager": 10}},
                "params": {"wordlist": "hard"}}
        self.assertEqual(shortcuts.effective_params(item),
                         {"wordlist": "hard", "wager": 10})

    def test_missing_or_broken_shapes_yield_empty(self):
        self.assertEqual(shortcuts.effective_params({}), {})
        self.assertEqual(shortcuts.effective_params({"action": {}}), {})
        self.assertEqual(shortcuts.effective_params({"params": "broken"}), {})


class ValidateParamsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.registry = action_registry.default_registry()

    def test_valid_values_are_normalized(self):
        spec = self.registry.get("vc:changer_start")
        cleaned = action_registry.validate_params(
            spec, {"pitch": 3, "buffer_ms": 100.5, "max_ms": 500})
        self.assertEqual(cleaned, {"pitch": 3.0, "buffer_ms": 100.5, "max_ms": 500.0})

    def test_unknown_key_and_wrong_type_and_out_of_range(self):
        spec = self.registry.get("vc:echo_start")
        with self.assertRaises(ValueError):
            action_registry.validate_params(spec, {"speed": 1})
        with self.assertRaises(ValueError):
            action_registry.validate_params(spec, {"delay": "fast"})
        with self.assertRaises(ValueError):
            action_registry.validate_params(spec, {"delay": 0.01})
        with self.assertRaises(ValueError):
            action_registry.validate_params(spec, {"delay": 31})

    def test_choice_outside_choices(self):
        spec = action_registry.make_action(
            "general", "mode", "モード", "economy", "経済",
            params=(ParamSpec(name="mode", label="モード", type="choice",
                              choices=(("A", "a"), ("B", "b"))),))
        self.assertEqual(action_registry.validate_params(spec, {"mode": "a"}), {"mode": "a"})
        with self.assertRaises(ValueError):
            action_registry.validate_params(spec, {"mode": "z"})

    def test_empty_params_pass(self):
        spec = self.registry.get("vc:global_start")
        self.assertEqual(action_registry.validate_params(spec, {}), {})
        self.assertEqual(action_registry.validate_params(spec, None), {})


class VcParamSpecConsistencyTest(unittest.TestCase):
    """レジストリの vc ParamSpec が dispatch の実在引数・分岐と一致すること。"""

    EXPECTED = {
        "echo_start": {"delay"},
        "karaoke_start": {"lyrics"},
        "changer_start": {"pitch", "buffer_ms", "max_ms"},
        "changer_status": {"pitch", "buffer_ms", "max_ms"},
        "global_start": {"room", "password"},
        # 導線最適化 M4 で追加したフォーム系
        "echo_delay": {"delay"},
        "gvc_room_create": {"name", "max_servers", "password", "desc", "theme"},
        "gvc_room_theme": {"name", "theme"},
        "gvc_room_info": {"name"},
        "gvc_room_delete": {"name"},
        "gvc_chat_connect": {"name", "password"},
    }

    @classmethod
    def setUpClass(cls):
        cls.registry = action_registry.default_registry()

    def test_param_names_match_expected_actions(self):
        for spec in self.registry.by_root("vc"):
            names = {param.name for param in spec.params}
            self.assertEqual(names, self.EXPECTED.get(spec.value, set()),
                             f"vc:{spec.value}")

    def test_param_names_exist_in_dispatch_signature(self):
        from cogs.vc import VoiceHub

        signature = inspect.signature(VoiceHub.dispatch_voice_action)
        dispatch_params = set(signature.parameters)
        for spec in self.registry.by_root("vc"):
            for param in spec.params:
                self.assertIn(param.name, dispatch_params)

    def test_ranges_match_dispatch_ranges(self):
        # dispatch_voice_action の app_commands.Range 指定に合わせた範囲。
        delay = self.registry.get("vc:echo_start").params[0]
        self.assertEqual((delay.min_value, delay.max_value), (0.1, 30.0))
        changer = {p.name: p for p in self.registry.get("vc:changer_start").params}
        self.assertEqual((changer["pitch"].min_value, changer["pitch"].max_value), (-24.0, 24.0))
        self.assertEqual((changer["buffer_ms"].min_value, changer["buffer_ms"].max_value),
                         (20.0, 2000.0))
        self.assertEqual((changer["max_ms"].min_value, changer["max_ms"].max_value),
                         (20.0, 4000.0))


def _message(user_id=10):
    return types.SimpleNamespace(
        author=types.SimpleNamespace(id=user_id),
        channel=types.SimpleNamespace(id=55, send=AsyncMock()),
        guild=types.SimpleNamespace(id=1),
        content="トリガー",
        reference=None,
    )


def _cog(cogs_by_name):
    bot = types.SimpleNamespace(
        user=types.SimpleNamespace(id=999),
        get_cog=lambda name: cogs_by_name.get(name),
    )
    return GeneralCog(bot)


class ExecuteShortcutParamsTest(unittest.IsolatedAsyncioTestCase):
    async def test_vc_receives_only_filtered_valid_params(self):
        hub = types.SimpleNamespace(dispatch_voice_action=AsyncMock(return_value="done"))
        cog = _cog({"VoiceHub": hub})
        item = {"user_id": 10, "action": {"root": "vc", "value": "echo_start"},
                "params": {"delay": 5, "pitch": 3, "bogus": 1}}
        result = await cog.execute_shortcut(_message(), item)
        self.assertEqual(result, "done")
        args, kwargs = hub.dispatch_voice_action.call_args
        self.assertEqual(args[1], "echo_start")
        self.assertEqual(kwargs, {"delay": 5.0})

    async def test_vc_invalid_values_are_dropped_not_fatal(self):
        hub = types.SimpleNamespace(dispatch_voice_action=AsyncMock(return_value="done"))
        cog = _cog({"VoiceHub": hub})
        item = {"user_id": 10, "action": {"root": "vc", "value": "echo_start"},
                "params": {"delay": 999}}
        result = await cog.execute_shortcut(_message(), item)
        self.assertEqual(result, "done")
        _args, kwargs = hub.dispatch_voice_action.call_args
        self.assertEqual(kwargs, {})

    async def test_vc_without_params_calls_as_before(self):
        hub = types.SimpleNamespace(dispatch_voice_action=AsyncMock(return_value="done"))
        cog = _cog({"VoiceHub": hub})
        item = {"user_id": 10, "action": {"root": "vc", "value": "join"}}
        await cog.execute_shortcut(_message(), item)
        _args, kwargs = hub.dispatch_voice_action.call_args
        self.assertEqual(kwargs, {})

    async def test_game_legacy_options_are_passed(self):
        hub = types.SimpleNamespace(start_game=AsyncMock(return_value="started"))
        cog = _cog({"GameHub": hub})
        item = {"user_id": 10,
                "action": {"root": "game", "value": "game:uno", "options": {"wordlist": "standard"}}}
        result = await cog.execute_shortcut(_message(), item)
        self.assertEqual(result, "started")
        args, kwargs = hub.start_game.call_args
        self.assertEqual(args[1], "uno")
        self.assertEqual(kwargs, {"wordlist": "standard"})

    async def test_game_v2_params_are_passed(self):
        hub = types.SimpleNamespace(start_game=AsyncMock(return_value="started"))
        cog = _cog({"GameHub": hub})
        item = {"user_id": 10, "action": {"root": "game", "value": "game:uno"},
                "params": {"wordlist": "hard"}}
        await cog.execute_shortcut(_message(), item)
        _args, kwargs = hub.start_game.call_args
        self.assertEqual(kwargs, {"wordlist": "hard"})

    async def test_general_and_support_called_without_params(self):
        support = types.SimpleNamespace(dispatch=AsyncMock(return_value="ok"))
        cog = _cog({"SupportCog": support})
        cog.dispatch_general = AsyncMock(return_value="gen")
        general_item = {"user_id": 10, "action": {"root": "general", "value": "miq_help"},
                        "params": {"delay": 5}}
        self.assertEqual(await cog.execute_shortcut(_message(), general_item), "gen")
        args, kwargs = cog.dispatch_general.call_args
        self.assertEqual(args[1], "miq_help")
        self.assertEqual(kwargs, {})

        support_item = {"user_id": 10, "action": {"root": "support", "value": "ticket"},
                        "params": {"delay": 5}}
        self.assertEqual(await cog.execute_shortcut(_message(), support_item), "ok")
        args, kwargs = support.dispatch.call_args
        self.assertEqual(args[1], "ticket")
        self.assertEqual(kwargs, {})


if __name__ == "__main__":
    unittest.main()
