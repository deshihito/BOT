# -*- coding: utf-8 -*-
"""RtaBoardView（boardNotify RTA 統合ボード）のテスト。Discord には接続しない。

- サービス切替は7サービスのセレクト、最速/最遅とスコープはトグルボタン
- 切替で状態が変わり、BumpRta.build_rta_board が新しい状態で呼ばれる
- 「自分」スコープは押した人の記録として読み直す
"""

import os
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import AsyncMock

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

for _name, _value in {'BOT_API_BASE_URL': 'http://127.0.0.1:8787', 'BOT_API_KEY': 'dummy-key'}.items():
    os.environ.setdefault(_name, _value)


def make_view(**state):
    import discord
    from core.game.rta.views import RtaBoardView

    cog = types.SimpleNamespace(
        build_rta_board=AsyncMock(
            return_value=(discord.Embed(title="ボード"), b"\x89PNG-fake")))
    view = RtaBoardView(cog, 123, 456, "自分", **state)
    return cog, view


def make_interaction(user_id=999, name="押した人"):
    return types.SimpleNamespace(
        user=types.SimpleNamespace(id=user_id, display_name=name),
        response=types.SimpleNamespace(
            is_done=lambda: True,
            defer=AsyncMock(),
            edit_message=AsyncMock(),
        ),
        edit_original_response=AsyncMock(),
    )


class RtaBoardStructureTest(unittest.TestCase):
    def test_service_select_has_seven_services(self):
        from core.game.rta.common import RTA_SERVICE_TYPES, SERVICE_LABELS

        _cog, view = make_view()
        select = view._service_select
        self.assertEqual([o.value for o in select.options], list(RTA_SERVICE_TYPES))
        self.assertEqual([o.label for o in select.options],
                         [SERVICE_LABELS[t] for t in RTA_SERVICE_TYPES])
        self.assertNotIn("legacy", [o.value for o in select.options])
        defaults = [o.value for o in select.options if o.default]
        self.assertEqual(defaults, ["bump"])

    def test_toggle_buttons_reflect_state(self):
        _cog, view = make_view(scope="global", slowest=True)
        import discord

        buttons = {item.label: item for item in view.children
                   if isinstance(item, discord.ui.Button)}
        self.assertEqual(
            set(buttons), {"最速", "最遅", "このサーバー", "全サーバー", "自分"})
        self.assertEqual(buttons["最遅"].style, discord.ButtonStyle.primary)
        self.assertEqual(buttons["最速"].style, discord.ButtonStyle.secondary)
        self.assertEqual(buttons["全サーバー"].style, discord.ButtonStyle.primary)
        self.assertEqual(buttons["このサーバー"].style, discord.ButtonStyle.secondary)


class RtaBoardSwitchTest(unittest.IsolatedAsyncioTestCase):
    async def test_scope_switch_reloads_with_new_state(self):
        cog, view = make_view()
        await view._make_scope("global")(make_interaction())
        self.assertEqual(view.scope, "global")
        args, kwargs = cog.build_rta_board.await_args
        self.assertEqual(args, ("bump", "global", False))
        # 「自分」スコープ用に、押した人へ読み替えられる
        self.assertEqual(kwargs["user_id"], 999)
        self.assertEqual(kwargs["user_name"], "押した人")

    async def test_speed_switch_reloads_slowest(self):
        cog, view = make_view()
        await view._make_speed(True)(make_interaction())
        self.assertTrue(view.slowest)
        args, _kwargs = cog.build_rta_board.await_args
        self.assertEqual(args, ("bump", "local", True))

    async def test_service_switch_reloads_service(self):
        cog, view = make_view()
        view._service_select._values = ["dcafe"]
        await view._on_service(make_interaction())
        self.assertEqual(view.event_type, "dcafe")
        args, _kwargs = cog.build_rta_board.await_args
        self.assertEqual(args, ("dcafe", "local", False))

    async def test_load_failure_shows_text_only(self):
        cog, view = make_view()
        cog.build_rta_board = AsyncMock(side_effect=RuntimeError("db down"))
        await view.load()
        self.assertIsNone(view._png)
        self.assertIn("失敗しました", view.embed().description)
        self.assertEqual(view.files(), [])


if __name__ == "__main__":
    unittest.main()
