# -*- coding: utf-8 -*-
"""個人オプトアウト設定（される側の拒否）のテスト。

- ストア: 既定は全て対象、ユーザー単位の保存/復元、全て戻すと記録削除
- パネル: 3トグルの状態表示と、MIQ分が既存 prefs と同じ値を読み書きすること
- 執行: コメントガチャの候補除外、今北産業の要約材料除外
Discord には接続しない。
"""
import os
import sys
import types
import unittest
from pathlib import Path
from unittest import mock
from unittest.mock import AsyncMock

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

for _name, _value in {"BOT_API_BASE_URL": "http://127.0.0.1:8787", "BOT_API_KEY": "dummy-key"}.items():
    os.environ.setdefault(_name, _value)

from core.general import optout  # noqa: E402


class FakeStore:
    """KVStore の最小互換（load_local / set / delete）。"""

    def __init__(self):
        self.data = {}
        self.deleted = []

    def load_local(self):
        return self.data

    async def set(self, key, value):
        self.data[key] = value

    async def delete(self, key):
        self.deleted.append(key)
        self.data.pop(key, None)


class StoreTest(unittest.IsolatedAsyncioTestCase):
    def test_defaults_are_all_false(self):
        store = FakeStore()
        self.assertEqual(optout.get_optouts(42, store),
                         {"commentgacha": False, "imakita": False})
        self.assertFalse(optout.is_opted_out(42, "commentgacha", store))
        self.assertFalse(optout.is_opted_out(None, "commentgacha", store))
        self.assertFalse(optout.is_opted_out(42, "unknown", store))

    async def test_set_and_read_back_per_user(self):
        store = FakeStore()
        await optout.set_optout(42, "commentgacha", True, store)
        self.assertTrue(optout.is_opted_out(42, "commentgacha", store))
        self.assertFalse(optout.is_opted_out(42, "imakita", store))
        # 他のユーザーには効かない
        self.assertFalse(optout.is_opted_out(43, "commentgacha", store))

    async def test_clearing_all_removes_record(self):
        store = FakeStore()
        await optout.set_optout(42, "imakita", True, store)
        await optout.set_optout(42, "imakita", False, store)
        self.assertEqual(store.deleted, ["42"])
        self.assertNotIn("42", store.data)

    async def test_unknown_feature_rejected(self):
        with self.assertRaises(ValueError):
            await optout.set_optout(42, "omikuji", True, FakeStore())


class PanelTest(unittest.IsolatedAsyncioTestCase):
    USER_ID = 987654321

    def make_view(self):
        from core.general.optout_ui import OptOutSettingsView

        return OptOutSettingsView(types.SimpleNamespace(), self.USER_ID)

    def test_view_builds_with_three_toggles(self):
        view = self.make_view()
        self.assertEqual(view.state,
                         {"commentgacha": False, "imakita": False, "miq": False})
        self.assertEqual(len(view.children), 3)
        self.assertIn("オプトアウト設定", view.embed().title)

    async def test_toggle_commentgacha_writes_store(self):
        view = self.make_view()
        interaction = types.SimpleNamespace(
            user=types.SimpleNamespace(id=self.USER_ID),
            followup=types.SimpleNamespace(send=AsyncMock()),
        )
        with mock.patch.object(optout, "set_optout", new=AsyncMock()) as setter, \
                mock.patch("core.general.optout_ui.edit_panel_v2", new=AsyncMock()):
            await view.toggle(interaction, "commentgacha")
        setter.assert_awaited_once_with(self.USER_ID, "commentgacha", True)

    async def test_toggle_miq_writes_existing_prefs(self):
        view = self.make_view()
        interaction = types.SimpleNamespace(
            user=types.SimpleNamespace(id=self.USER_ID),
            followup=types.SimpleNamespace(send=AsyncMock()),
        )
        saved = {}

        async def fake_save(user_id, prefs):
            saved.update(prefs)
            return True

        with mock.patch("core.general.optout_ui.miq_get_prefs",
                        return_value={"refuse": False, "theme": "bw"}), \
                mock.patch("core.general.optout_ui.miq_save_prefs", side_effect=fake_save), \
                mock.patch("core.general.optout_ui.edit_panel_v2", new=AsyncMock()):
            await view.toggle(interaction, "miq")
        # refuse だけが反転し、他の MIQ 設定には触れない
        self.assertTrue(saved["refuse"])
        self.assertEqual(saved["theme"], "bw")


class RegistryTest(unittest.TestCase):
    def test_optout_settings_registered_and_ai_shortcut_excluded(self):
        from core.general import action_registry

        registry = action_registry.default_registry()
        spec = registry.get("general:optout_settings")
        self.assertIsNotNone(spec)
        self.assertEqual(spec.label, "オプトアウト設定")
        self.assertNotIn("aitools", spec.surfaces)
        self.assertNotIn("shortcut", spec.surfaces)
        self.assertIn("panel", spec.surfaces)


class CommentGachaEnforcementTest(unittest.TestCase):
    def test_opted_out_author_is_not_eligible(self):
        from core.general.commentgacha.cog import _eligible

        message = types.SimpleNamespace(
            id=5, content="昔の発言", webhook_id=None, type=None, attachments=[],
            author=types.SimpleNamespace(id=42, bot=False),
        )
        with mock.patch("core.general.commentgacha.cog.optout.is_opted_out",
                        return_value=True):
            self.assertFalse(_eligible(message, exclude_id=999))
        with mock.patch("core.general.commentgacha.cog.optout.is_opted_out",
                        return_value=False):
            self.assertTrue(_eligible(message, exclude_id=999))


class ImakitaEnforcementTest(unittest.IsolatedAsyncioTestCase):
    async def test_opted_out_author_excluded_from_summary_material(self):
        from cogs.general import ImakitaSummaryCog

        def fake_message(message_id, content, name, user_id):
            return types.SimpleNamespace(
                id=message_id, content=content,
                author=types.SimpleNamespace(
                    id=user_id, display_name=name, name=name, bot=False),
                reply=AsyncMock(),
            )

        trigger = fake_message(3, "今北産業", "asker", 1)
        kept = fake_message(2, "残る話題", "alice", 2)
        dropped = fake_message(1, "消える話題", "bob", 3)

        class FakeChannel:
            id = 10

            async def history(self, *, limit):
                for item in (trigger, kept, dropped):
                    yield item

        trigger.channel = FakeChannel()
        create = AsyncMock(return_value=types.SimpleNamespace(
            choices=[types.SimpleNamespace(
                message=types.SimpleNamespace(content="要約"))]))
        client = types.SimpleNamespace(
            chat=types.SimpleNamespace(
                completions=types.SimpleNamespace(create=create)))
        cog = ImakitaSummaryCog(
            types.SimpleNamespace(command_prefix="!"), client=client, clock=lambda: 100)
        with mock.patch("core.general.imakita.cog.optout.is_opted_out",
                        side_effect=lambda user_id, feature: user_id == 3):
            await cog.on_message(trigger)
        prompt = create.await_args.kwargs["messages"][1]["content"]
        self.assertIn("残る話題", prompt)
        self.assertNotIn("消える話題", prompt)


if __name__ == "__main__":
    unittest.main()
