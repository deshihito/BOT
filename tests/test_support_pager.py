# -*- coding: utf-8 -*-
"""support パネルのページめくりと、ショートカット管理の削除再描画の回帰テスト。

本番障害 (2026-11-08): /support のページめくりボタンが、状態 (action_page)
だけ進んで表示が切り替わらなかった。原因は callback が内側パネルの
refresh() を呼ばずにラッパーの _sync() だけで再描画していたこと。
あわせて同型監査で見つけた ShortcutManageSelect の削除経路
（内側 View への _sync() 呼び出しで AttributeError）も固定する。
"""
import asyncio
import unittest
from types import SimpleNamespace
from unittest import mock

import cogs.support  # noqa: F401  (import 順を本番に合わせる)
from core.support.panel import SupportPanelView, support_action_pages
from core.support.panel_v2 import as_panel_v2


class FakeResponse:
    def __init__(self):
        self.edits = []

    def is_done(self):
        return False

    async def edit_message(self, **kwargs):
        self.edits.append(kwargs)

    async def defer(self, **kwargs):
        pass


def walk(view):
    out = []

    def rec(item):
        out.append(item)
        for child in getattr(item, "children", []) or []:
            rec(child)

    for top in view.children:
        rec(top)
    return out


def find_by_custom_id(view, custom_id):
    for item in walk(view):
        if getattr(item, "custom_id", None) == custom_id:
            return item
    return None


def make_interaction(user_id=1, guild_id=123):
    return SimpleNamespace(
        response=FakeResponse(),
        user=SimpleNamespace(id=user_id),
        guild_id=guild_id,
    )


class SupportPagerTest(unittest.TestCase):
    """本番経路（as_panel_v2 でラップ済み）でのページ遷移を検証する。"""

    GENRE = "automation"  # 33件 → 2ページになるジャンル

    def setUp(self):
        self.pages = support_action_pages(self.GENRE)
        self.assertEqual(len(self.pages), 2)
        self.panel = SupportPanelView(None, genre=self.GENRE)
        self.wrapper = as_panel_v2(self.panel)

    def rendered(self):
        return {
            "select": find_by_custom_id(self.wrapper, "panel:support:action"),
            "indicator": find_by_custom_id(self.wrapper, "panel:support:action_indicator"),
            "prev": find_by_custom_id(self.wrapper, "panel:support:action_prev"),
            "next": find_by_custom_id(self.wrapper, "panel:support:action_next"),
        }

    def assert_page_rendered(self, page_index):
        parts = self.rendered()
        expected_values = [value for _label, value in self.pages[page_index]]
        self.assertEqual([o.value for o in parts["select"].options], expected_values)
        self.assertEqual(
            parts["select"].placeholder,
            f"機能を選択してください（{page_index + 1}/{len(self.pages)}）",
        )
        self.assertEqual(
            parts["indicator"].label, f"{page_index + 1} / {len(self.pages)}ページ")
        self.assertEqual(parts["prev"].disabled, page_index <= 0)
        self.assertEqual(parts["next"].disabled, page_index >= len(self.pages) - 1)
        self.assertEqual(self.panel.action_page, page_index)

    def test_initial_render_is_first_page(self):
        self.assert_page_rendered(0)

    def test_next_button_renders_second_page(self):
        interaction = make_interaction()
        asyncio.run(self.rendered()["next"].callback(interaction))
        self.assert_page_rendered(1)
        # 編集は同じラッパーに対して行われる（メッセージ差し替えではない）
        self.assertEqual(len(interaction.response.edits), 1)
        self.assertIs(interaction.response.edits[0]["view"], self.wrapper)

    def test_prev_button_returns_to_first_page(self):
        asyncio.run(self.rendered()["next"].callback(make_interaction()))
        self.assert_page_rendered(1)
        asyncio.run(self.rendered()["prev"].callback(make_interaction()))
        self.assert_page_rendered(0)

    def test_next_at_last_page_stays(self):
        asyncio.run(self.rendered()["next"].callback(make_interaction()))
        asyncio.run(self.rendered()["next"].callback(make_interaction()))
        self.assert_page_rendered(1)

    def test_prev_at_first_page_stays(self):
        asyncio.run(self.rendered()["prev"].callback(make_interaction()))
        self.assert_page_rendered(0)


class ShortcutManageDeleteTest(unittest.TestCase):
    """ショートカット削除後に、削除済みが選択肢から消えた画面へ切り替わること。"""

    def test_delete_rerenders_without_deleted_option(self):
        from core.general import shortcuts as shortcuts_mod
        from core.general.shortcuts import ShortcutManagerView, ShortcutManageSelect
        from core.support import guild_settings

        rows = [
            {"id": "a1", "trigger": "aaa",
             "action": {"root": "support", "value": "x"}},
            {"id": "b2", "trigger": "bbb",
             "action": {"root": "support", "value": "y"}},
        ]
        state = {"rows": list(rows)}

        async def fake_remove(store, guild_id, user_id, item_id):
            state["rows"] = [r for r in state["rows"] if r["id"] != item_id]

        with mock.patch.object(guild_settings, "get_store", lambda: object()), \
                mock.patch.object(shortcuts_mod.shortcuts, "for_user",
                                  lambda store, gid, uid: list(state["rows"])), \
                mock.patch.object(shortcuts_mod.shortcuts, "remove", fake_remove):
            manager = ShortcutManagerView(None, 123, 999)
            select = ShortcutManageSelect(manager, "delete")
            manager.add_item(select)
            wrapper = as_panel_v2(manager)
            self.assertIs(select.view, wrapper)

            select._values = ["a1"]
            interaction = make_interaction(user_id=999)
            asyncio.run(select.callback(interaction))

        self.assertEqual([r["id"] for r in state["rows"]], ["b2"])
        self.assertEqual(len(interaction.response.edits), 1)
        new_wrapper = interaction.response.edits[0]["view"]
        new_selects = [
            item for item in walk(new_wrapper)
            if isinstance(item, ShortcutManageSelect)
        ]
        self.assertEqual(len(new_selects), 1)
        self.assertEqual([o.value for o in new_selects[0].options], ["b2"])


if __name__ == "__main__":
    unittest.main()
