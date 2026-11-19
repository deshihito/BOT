# -*- coding: utf-8 -*-
"""導線最適化 U1（/general マネー導線のマネーパネルへの一本化）の固定テスト。

- 通常モードの /general パネルは経済3ジャンル (money / trade_craft /
  play) を「マネー」1ジャンルに統合し、マネーパネルの6カテゴリ入口
  だけを出す。36件の個別アクションはマネーパネル内のボタンから実行する。
- レジストリ (GENERAL_ACTIONS)・dispatch・/help・AI・保存済み
  ショートカットは不変で、36件へは従来どおり直接到達できる。
- ショートカット作成モードではカタログ全体（13ジャンル・75件）を出し、
  個別アクションへの新規登録を残す。
"""
import asyncio
import sys
import tempfile
import types
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import discord  # noqa: E402

from cogs.general import CATEGORIES, MoneyPanelCog  # noqa: E402
from core.general import action_usage  # noqa: E402
from core.general.common import (  # noqa: E402
    GENERAL_ACTIONS,
    GENERAL_GENRES,
    MONEY_PANEL_CATEGORY_VALUES,
)
from core.general.panel import (  # noqa: E402
    MONEY_PANEL_ENTRIES,
    GeneralActionSelect,
    GeneralGenreSelect,
    GeneralPanel,
    general_panel_actions,
    general_panel_genres,
)
from core.general.money_panel import daily_bonus as daily_core  # noqa: E402
from core.general.money_panel import starter as starter_core  # noqa: E402
from core.game.hub import prison as prison_core  # noqa: E402


def _genre_select(panel):
    return next(c for c in panel.children if isinstance(c, GeneralGenreSelect))


def _action_select(panel):
    return next(c for c in panel.children if isinstance(c, GeneralActionSelect))


async def _drain_background_records():
    """dispatch が積んだ利用履歴の記録タスクを完了まで進める。"""
    tasks = list(action_usage._background_tasks)
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)


class MoneyGenreDisplayTest(unittest.TestCase):
    def test_panel_genres_merge_economy(self):
        genres = general_panel_genres()
        self.assertEqual(len(genres), 11)
        self.assertEqual(genres[0], "money")
        self.assertNotIn("trade_craft", genres)
        self.assertNotIn("play", genres)
        self.assertEqual(
            [GENERAL_GENRES[g][0] for g in genres],
            ["マネー", "ランキング", "boardNotify RTA", "EXP・レベル",
             "fujo status", "栽培", "占い", "ユーティリティ", "設定・AI",
             "ZetaModoki", "画像作成"])

    def test_money_genre_lists_only_panel_categories(self):
        panel = GeneralPanel(None, genre="money")
        select = _action_select(panel)
        self.assertEqual(
            [(o.label, o.value) for o in select.options],
            list(MONEY_PANEL_ENTRIES))
        self.assertEqual(len(select.options), 6)

    def test_money_entries_match_money_panel_categories(self):
        # 表示ラベルはマネーパネルの CATEGORIES と一致する
        #（home だけ既存の「マネーパネル」を維持する）。
        self.assertEqual(
            [value for _label, value in MONEY_PANEL_ENTRIES],
            list(MONEY_PANEL_CATEGORY_VALUES))
        self.assertEqual(
            [MONEY_PANEL_CATEGORY_VALUES[value]
             for _label, value in MONEY_PANEL_ENTRIES],
            [value for value, _label in CATEGORIES])
        panel_labels = dict(CATEGORIES)
        for label, value in MONEY_PANEL_ENTRIES:
            category = MONEY_PANEL_CATEGORY_VALUES[value]
            if category == "home":
                self.assertEqual(label, "マネーパネル")
            else:
                self.assertEqual(label, panel_labels[category])

    def test_genre_select_shows_merged_counts(self):
        panel = GeneralPanel(None, genre="money")
        select = _genre_select(panel)
        by_value = {o.value: o for o in select.options}
        self.assertEqual(len(select.options), 11)
        self.assertEqual(by_value["money"].description, "6個の機能")
        self.assertEqual(by_value["exp"].description, "4個の機能")

    def test_old_economy_genres_open_as_money(self):
        for old in ("trade_craft", "play"):
            panel = GeneralPanel(None, genre=old)
            self.assertEqual(panel.genre, "money", old)
            select = _action_select(panel)
            self.assertEqual(
                [o.value for o in select.options],
                [value for _label, value in MONEY_PANEL_ENTRIES])

    def test_registry_keeps_all_36_economy_actions(self):
        # 経済3ジャンルは件数どおり残る（全体はオプトアウト設定追加で76件）。
        self.assertEqual(len(GENERAL_ACTIONS["money"]), 10)
        self.assertEqual(len(GENERAL_ACTIONS["trade_craft"]), 15)
        self.assertEqual(len(GENERAL_ACTIONS["play"]), 11)
        self.assertEqual(
            sum(len(v) for v in GENERAL_ACTIONS.values()), 76)


class ShortcutModeCatalogTest(unittest.TestCase):
    def test_shortcut_mode_keeps_full_genres(self):
        self.assertEqual(len(general_panel_genres(shortcut_mode=True)), 13)
        self.assertIn("trade_craft", general_panel_genres(shortcut_mode=True))
        self.assertIn("play", general_panel_genres(shortcut_mode=True))

    def test_shortcut_mode_keeps_full_actions(self):
        self.assertEqual(
            [v for _l, v in general_panel_actions(
                "trade_craft", shortcut_mode=True)],
            [v for _l, v in GENERAL_ACTIONS["trade_craft"]])
        self.assertEqual(
            len(general_panel_actions("money", shortcut_mode=True)), 10)
        panel = GeneralPanel(
            None, genre="play", shortcut_mode=True,
            shortcut_item={"action": {"genre": "play",
                                      "value": "slot"}})
        self.assertEqual(panel.genre, "play")
        select = _action_select(panel)
        self.assertIn("slot", [o.value for o in select.options])


class MoneyCategoryDispatchTest(unittest.IsolatedAsyncioTestCase):
    def _cog(self, panel_cog):
        from cogs.general import GeneralCog

        cog = GeneralCog.__new__(GeneralCog)
        cog.bot = types.SimpleNamespace(
            get_cog=lambda name: panel_cog if name == "MoneyPanelCog" else None)
        return cog

    def _interaction(self):
        return types.SimpleNamespace(
            guild_id=123, guild=None,
            user=types.SimpleNamespace(id=456),
            response=types.SimpleNamespace(
                is_done=lambda: False,
                send_message=AsyncMock(),
                defer=AsyncMock(),
            ),
            followup=types.SimpleNamespace(send=AsyncMock()),
        )

    async def test_each_category_value_opens_panel_at_category(self):
        for value, category in MONEY_PANEL_CATEGORY_VALUES.items():
            with self.subTest(value=value):
                calls = []

                async def show_panel(interaction, category="home"):
                    calls.append(category)

                panel_cog = SimpleNamespace(show_panel=show_panel)
                cog = self._cog(panel_cog)
                await cog.dispatch_general(self._interaction(), value)
                await _drain_background_records()
                self.assertEqual(calls, [category])


class ShowPanelCategoryTest(unittest.IsolatedAsyncioTestCase):
    def _panel_cog(self, tmp):
        prison_store = prison_core.PrisonStore(Path(tmp) / "prison.json")
        bot = SimpleNamespace(
            get_cog=lambda name: (
                SimpleNamespace(prison_store=prison_store)
                if name == "CirculationCog" else None))
        return MoneyPanelCog(
            bot,
            balance_reader=lambda uid: 100,
            starter_store=starter_core.StarterStore(
                Path(tmp) / "starter.json"),
            daily_store=daily_core.DailyBonusStore(Path(tmp) / "daily.json"))

    def _interaction(self):
        response = SimpleNamespace(sent=[], deferred=False)

        async def send_message(*args, **kwargs):
            response.sent.append((args, kwargs))

        async def original_response():
            return SimpleNamespace()

        interaction = SimpleNamespace(
            user=SimpleNamespace(id=1),
            response=SimpleNamespace(
                send_message=send_message,
                original_response=original_response),
            followup=SimpleNamespace(send=AsyncMock()),
        )
        interaction.response_sent = response.sent
        return interaction

    def _sent_panel(self, interaction):
        _args, kwargs = interaction.response_sent[0]
        view = kwargs["view"]
        return getattr(view, "panel", view)

    async def test_show_panel_opens_at_given_category(self):
        with tempfile.TemporaryDirectory() as tmp:
            cog = self._panel_cog(tmp)
            for category, label in (("market", "買う"), ("play", "スロット"),
                                    ("more", "送金")):
                with self.subTest(category=category):
                    interaction = self._interaction()
                    await cog.show_panel(interaction, category=category)
                    panel = self._sent_panel(interaction)
                    self.assertEqual(panel.category, category)
                    labels = [
                        c.label for c in panel.children
                        if isinstance(c, discord.ui.Button)]
                    self.assertIn(label, labels)

    async def test_show_panel_defaults_to_home(self):
        with tempfile.TemporaryDirectory() as tmp:
            cog = self._panel_cog(tmp)
            interaction = self._interaction()
            await cog.show_panel(interaction)
            self.assertEqual(self._sent_panel(interaction).category, "home")
            interaction = self._interaction()
            await cog.show_panel(interaction, category="bogus")
            self.assertEqual(self._sent_panel(interaction).category, "home")


if __name__ == "__main__":
    unittest.main()
