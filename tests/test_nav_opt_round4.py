# -*- coding: utf-8 -*-
"""導線最適化ラウンド4（文章削減・状態統一）の回帰テスト。

R4-2: マネーパネル逮捕時の二重表示解消。
R4-3: 経済パネルの更新ボタン削除、盗むのルール隔離、残り時間形式の統一。
"""
import unittest


class MoneyPanelPrisonDedupTest(unittest.TestCase):
    """R4-2 改訂 (B-2): 逮捕情報は公開パネルに出さない。

    旧仕様は「状態」フィールドのみで二重表示を解消したが、セーフティ監査
    B-2 と S4 の線引き（逮捕は非公開側）に合わせ、公開 embed からは
    逮捕中であることも残り時間も出さない。本人への通知は ephemeral 経路。
    """

    def test_prison_shows_state_field_only(self):
        from cogs.money_panel import status_embed

        embed = status_embed({"balance": 100, "prison_remaining": 600.0})
        self.assertIsNone(embed.description)
        fields = {f.name: f.value for f in embed.fields}
        self.assertNotIn("状態", fields)
        for value in fields.values():
            self.assertNotIn("逮捕中", value)

    def test_next_step_still_shows_for_starter(self):
        from cogs.money_panel import status_embed

        embed = status_embed({"balance": 100, "starter_claimed": False})
        self.assertIn("スターター", embed.description)


class EconomyPanelTrimTest(unittest.TestCase):
    """R4-3: 更新ボタンの削除・フッター削除・残り時間形式の統一。"""

    def test_mining_embed_has_no_footer_and_view_has_no_refresh(self):
        import types

        from core.general.circulation.cog import MiningView, _mining_embed

        cog = types.SimpleNamespace(
            mining_store=types.SimpleNamespace(
                status=lambda uid: {"session_left": 3, "cooldown_remaining": 0.0}),
            economy_store=types.SimpleNamespace(pool_balance=lambda: 1000),
        )
        embed = _mining_embed(cog, 1)
        self.assertIsNone(embed.footer.text)
        labels = [getattr(c, "label", None) for c in MiningView(None, 1).children]
        self.assertNotIn("更新", labels)
        self.assertIn("採掘する", labels)

    def test_steal_rules_moved_behind_button(self):
        import types

        from core.general.circulation.cog import (
            STEAL_RULES,
            StealView,
            _steal_embed,
            _steal_rules_embed,
        )

        cog = types.SimpleNamespace(
            steal_store=types.SimpleNamespace(
                actor_status=lambda uid: {
                    "cooldown_remaining": 0.0, "today_count": 0,
                    "daily_limit": 3}),
        )
        embed = _steal_embed(cog, 1)
        self.assertIsNone(embed.description)
        self.assertIsNone(embed.footer.text)
        self.assertIn("罰金", STEAL_RULES)
        self.assertIn("罰金", _steal_rules_embed().description)
        view = StealView(cog, 1)
        labels = [getattr(c, "label", None) for c in view.children]
        self.assertIn("ルール", labels)

    def test_items_and_workshop_views_have_no_refresh(self):
        from cogs.workshop import WorkshopView
        from core.general.items.cog import ItemsView

        for view in (ItemsView(None, 1), WorkshopView(None, 1)):
            labels = [getattr(c, "label", None) for c in view.children]
            self.assertNotIn("更新", labels, type(view).__name__)

    def test_items_effect_remaining_uses_shared_format(self):
        import types
        from datetime import datetime, timedelta

        import config
        from core.general.items.cog import _items_embed

        now = datetime.now(config.JST)
        store = types.SimpleNamespace(
            inventory=lambda uid: {},
            active_effects=lambda uid: {
                "mining_boost": now + timedelta(minutes=30)},
        )
        embed = _items_embed(store, 1)
        fields = {f.name: f.value for f in embed.fields}
        # format_remaining 形式（約30分）で、独自の「あと約 X.X 時間」ではない。
        self.assertIn("あと約30分", fields["発動中の効果"])
        self.assertNotIn("時間）", fields["発動中の効果"])



if __name__ == "__main__":
    unittest.main()
