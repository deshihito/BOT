"""core/action_usage（利用履歴: よく使う／最近使った）のテスト。

集計はギルド×ユーザの個人単位のみ（仕様書 D-2）。保存先は guild_settings
ストアの "action_usage" セクションを模した MemoryStore を使う。
"""
import copy
import unittest

from core import action_registry, action_usage


class MemoryStore:
    def __init__(self):
        self.data = {}

    def get(self, guild_id, section):
        return copy.deepcopy(self.data.get((guild_id, section), {}))

    async def update(self, guild_id, section, **values):
        self.data[(guild_id, section)] = copy.deepcopy(values)

    async def ensure_loaded(self):
        return None


GUILD = 111
USER = 222


class RecordTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.store = MemoryStore()

    async def test_recent_is_newest_first_without_duplicates(self):
        await action_usage.record(self.store, GUILD, USER, "general:status")
        await action_usage.record(self.store, GUILD, USER, "general:pay")
        await action_usage.record(self.store, GUILD, USER, "general:status")
        self.assertEqual(
            action_usage.recent_for(self.store, GUILD, USER),
            ["general:status", "general:pay"],
        )

    async def test_counts_accumulate(self):
        await action_usage.record(self.store, GUILD, USER, "general:status")
        await action_usage.record(self.store, GUILD, USER, "general:status")
        await action_usage.record(self.store, GUILD, USER, "general:pay")
        frequent = dict(action_usage.frequent_for(self.store, GUILD, USER))
        self.assertEqual(frequent, {"general:status": 2, "general:pay": 1})

    async def test_recent_is_capped_at_max(self):
        general_ids = [
            spec.id for spec in action_registry.default_registry().by_root("general")
        ]
        self.assertGreaterEqual(len(general_ids), action_usage.MAX_RECENT + 2)
        for action_id in general_ids[: action_usage.MAX_RECENT + 2]:
            await action_usage.record(self.store, GUILD, USER, action_id)
        recent = action_usage.recent_for(self.store, GUILD, USER)
        self.assertEqual(len(recent), action_usage.MAX_RECENT)
        self.assertEqual(recent[0], general_ids[action_usage.MAX_RECENT + 1])

    async def test_unregistered_action_is_not_recorded(self):
        await action_usage.record(self.store, GUILD, USER, "general:no_such_action")
        await action_usage.record(self.store, GUILD, USER, "bogus:thing")
        self.assertEqual(action_usage.recent_for(self.store, GUILD, USER), [])
        self.assertEqual(action_usage.frequent_for(self.store, GUILD, USER), [])

    async def test_history_is_per_user_and_per_guild(self):
        await action_usage.record(self.store, GUILD, USER, "general:status")
        self.assertEqual(action_usage.recent_for(self.store, GUILD, 999), [])
        self.assertEqual(action_usage.recent_for(self.store, 999, USER), [])

    async def test_frequent_orders_by_count_then_id(self):
        for _ in range(3):
            await action_usage.record(self.store, GUILD, USER, "general:exp_status")
        await action_usage.record(self.store, GUILD, USER, "general:status")
        await action_usage.record(self.store, GUILD, USER, "general:pay")
        ordered = [aid for aid, _ in action_usage.frequent_for(self.store, GUILD, USER)]
        self.assertEqual(ordered[0], "general:exp_status")
        self.assertEqual(set(ordered[1:]), {"general:status", "general:pay"})

    async def test_record_safely_swallows_store_errors(self):
        class BrokenStore(MemoryStore):
            async def update(self, *args, **kwargs):
                raise RuntimeError("store is down")

        # 例外が外に出ないこと（dispatch を壊さない）。
        await action_usage.record_safely(GUILD, USER, "general:status", store=BrokenStore())
        await action_usage.record_safely(None, USER, "general:status", store=self.store)
        await action_usage.record_safely(GUILD, None, "general:status", store=self.store)


class HistoryPanelSpecsTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.store = MemoryStore()

    async def test_empty_history_returns_nothing(self):
        self.assertEqual(
            action_usage.history_panel_specs(self.store, GUILD, USER, "general"), [])

    async def test_frequent_first_then_recent_and_root_filtered(self):
        for _ in range(3):
            await action_usage.record(self.store, GUILD, USER, "general:exp_status")
        await action_usage.record(self.store, GUILD, USER, "support:muted")
        await action_usage.record(self.store, GUILD, USER, "general:status")

        specs = action_usage.history_panel_specs(self.store, GUILD, USER, "general")
        ids = [spec.id for spec in specs]
        # frequent（3回の exp_status）が先、recent の status が続き、support は混ざらない。
        self.assertEqual(ids, ["general:exp_status", "general:status"])

        support_specs = action_usage.history_panel_specs(self.store, GUILD, USER, "support")
        self.assertEqual([s.id for s in support_specs], ["support:muted"])

    async def test_limit_is_respected(self):
        general_ids = [
            spec.id for spec in action_registry.default_registry().by_root("general")
            if "panel" in spec.surfaces
        ]
        for action_id in general_ids:
            await action_usage.record(self.store, GUILD, USER, action_id)
        specs = action_usage.history_panel_specs(self.store, GUILD, USER, "general", limit=5)
        self.assertEqual(len(specs), 5)


class PanelHistorySelectTest(unittest.TestCase):
    """パネル側: 履歴があるときだけ最上段に ⭐ セレクトが出ること。"""

    def _specs(self, *action_ids):
        registry = action_registry.default_registry()
        return [registry.by_id(action_id) for action_id in action_ids]

    def test_general_panel_without_history_is_unchanged(self):
        from cogs.general import GeneralGenreSelect, GeneralPanel
        from core.general.shortcuts import RegisterShortcutButton

        panel = GeneralPanel(None)
        # 導線最適化 M9: 通常パネルにはショートカット登録ボタンが常駐する
        self.assertEqual(len(panel.children), 2)
        self.assertIsInstance(panel.children[0], GeneralGenreSelect)
        self.assertIsInstance(panel.children[1], RegisterShortcutButton)

    def test_general_panel_with_history_shows_star_select_on_top(self):
        from cogs.general import GeneralGenreSelect, GeneralHistorySelect, GeneralPanel

        specs = self._specs("general:status", "general:pay")
        panel = GeneralPanel(None, history_specs=specs)
        self.assertIsInstance(panel.children[0], GeneralHistorySelect)
        self.assertIsInstance(panel.children[1], GeneralGenreSelect)
        options = panel.children[0].options
        self.assertEqual([o.value for o in options], ["status", "pay"])
        self.assertTrue(all(o.label.startswith("⭐ ") for o in options))

    def test_support_panel_with_history_shows_star_select_on_top(self):
        from cogs.support import SupportGenreSelect, SupportHistorySelect, SupportPanelView

        panel = SupportPanelView(None)
        self.assertIsInstance(panel.children[0], SupportGenreSelect)

        specs = self._specs("support:muted")
        panel = SupportPanelView(None, history_specs=specs)
        self.assertIsInstance(panel.children[0], SupportHistorySelect)
        self.assertIsInstance(panel.children[1], SupportGenreSelect)
        self.assertEqual(panel.children[0].options[0].value, "muted")


if __name__ == "__main__":
    unittest.main()
