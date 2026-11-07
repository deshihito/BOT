"""表示モダン化 §4.1-5/6: we() 共通化と shortcuts の ephemeral 消失ガード。"""
import types
import unittest
from unittest.mock import AsyncMock

from core.general import action_registry
from core.support.embeds import we as shared_we


class SharedEmbedFactoryTest(unittest.TestCase):
    def test_shared_we_defaults_to_white(self):
        embed = shared_we("説明", title="題")
        self.assertEqual(embed.description, "説明")
        self.assertEqual(embed.title, "題")
        self.assertEqual(embed.color.value, 0xFFFFFF)

    def test_each_cog_we_matches_its_base_color(self):
        from core.vc.music.common import we as music_we
        from cogs.doubt import we as doubt_we
        from core.vc.karaoke.entry import we as karaoke_we
        from core.vc.rec.entry import we as rec_we
        from core.vc.transcription.entry import we as transcription_we
        from core.vc.voicechanger.entry import we as changer_we

        self.assertEqual(music_we("x").color.value, 0xFFFFFF)
        self.assertEqual(doubt_we("x").color.value, 0xFFFFFF)
        self.assertEqual(rec_we("x").color.value, 0xFFFFFF)
        self.assertEqual(karaoke_we("x").color.value, 0xFF69B4)
        self.assertEqual(transcription_we("x").color.value, 0x2ECC71)
        self.assertEqual(changer_we("x").color.value, 0x3498DB)

    def test_no_local_we_definitions_remain(self):
        import pathlib

        root = pathlib.Path(__file__).resolve().parents[1]
        for rel in ("core/vc/music/common.py", "cogs/doubt.py", "core/vc/karaoke/entry.py",
                    "core/vc/rec/entry.py", "core/vc/transcription/entry.py", "core/vc/voicechanger/entry.py"):
            text = (root / rel).read_text(encoding="utf-8")
            self.assertNotIn("def we(", text, rel)


class MessageShortcutGuardTest(unittest.TestCase):
    def test_blocked_ids_are_personal_general_actions(self):
        for action_id in action_registry.MESSAGE_SHORTCUT_BLOCKED_IDS:
            self.assertTrue(action_id.startswith("general:"), action_id)
        self.assertIn("general:miq_settings", action_registry.MESSAGE_SHORTCUT_BLOCKED_IDS)
        self.assertIn("general:status", action_registry.MESSAGE_SHORTCUT_BLOCKED_IDS)

    def test_blocked_actions_have_no_shortcut_surface(self):
        registry = action_registry.default_registry()
        for action_id in action_registry.MESSAGE_SHORTCUT_BLOCKED_IDS:
            spec = registry.get(action_id)
            self.assertIsNotNone(spec, action_id)
            self.assertNotIn("shortcut", spec.surfaces, action_id)
            self.assertIn("panel", spec.surfaces, action_id)

    def test_shortcut_roots_exclude_blocked_values(self):
        roots = action_registry.build_shortcut_roots()
        values = {value for _label, value in roots["general"][1]}
        for action_id in action_registry.MESSAGE_SHORTCUT_BLOCKED_IDS:
            self.assertNotIn(action_id.split(":", 1)[1], values)


class ExecuteShortcutGuardTest(unittest.IsolatedAsyncioTestCase):
    async def test_execute_shortcut_refuses_blocked_action(self):
        from cogs.general import GeneralCog

        cog = GeneralCog.__new__(GeneralCog)
        cog.bot = types.SimpleNamespace(user=None, get_cog=lambda _name: None)
        cog.dispatch_general = AsyncMock(return_value=True)
        message = types.SimpleNamespace(
            author=types.SimpleNamespace(id=42),
            guild=types.SimpleNamespace(id=7),
            channel=types.SimpleNamespace(id=9, send=AsyncMock()),
            content="status",
        )
        item = {"user_id": 42, "action": {"root": "general", "value": "status"}}
        result = await cog.execute_shortcut(message, item)
        self.assertFalse(result)
        cog.dispatch_general.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
