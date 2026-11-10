# -*- coding: utf-8 -*-
"""自動翻訳設定パネルの V2 編集回帰テスト。

本番障害 (2026-11-10): 翻訳の言語設定を選択すると
「400 Bad Request (error code: 50035): In data.embeds: The 'embeds' field
cannot be used when using MessageFlags.IS_COMPONENTS_V2」が表示された。

原因: パネルは entry.py から as_panel_v2 で送信されるためメッセージには
IS_COMPONENTS_V2 フラグが付く (一度付くと外せない)。ところが言語セレクトと
ON/OFF トグルの callback が旧来の edit_message(embed=..., view=生View) で
編集していたため、V2 メッセージへの編集に embeds が入り Discord に拒否
されていた (設定の保存自体は編集前に完了していた)。

このテストは本番経路 (as_panel_v2 でラップした実 View の実 callback) を
使い、callback が出す編集 kwargs を discord.py 本体のペイロードビルダに
通して、embeds と V2 フラグが同居しないことを固定する。フェイクは実物が
持つ属性だけに限定する (PR #648 の教訓)。
"""
import unittest
from types import SimpleNamespace
from unittest import mock

import discord
from discord.utils import MISSING
from discord.webhook.async_ import interaction_message_response_params

from core.general import translation_settings as settings_mod
from core.general.translation import (
    TranslationLocaleSelect,
    TranslationToggleButton,
    TranslationView,
)
from core.support.panel_v2 import as_panel_v2

V2_FLAG = discord.MessageFlags(components_v2=True).value


class FakeResponse:
    """discord.InteractionResponse のうち、このフローが使う面だけを持つ。"""

    def __init__(self):
        self.calls = []

    def is_done(self):
        return False

    async def edit_message(self, **kwargs):
        self.calls.append(("edit_message", kwargs))

    async def send_message(self, **kwargs):
        self.calls.append(("send_message", kwargs))


def make_interaction(user_id=42, guild_id=999):
    interaction = SimpleNamespace(
        response=FakeResponse(),
        followup=SimpleNamespace(send=mock.AsyncMock()),
        user=SimpleNamespace(id=user_id),
        guild_id=guild_id,
    )

    async def edit_original_response(**kwargs):
        interaction.response.calls.append(("edit_original_response", kwargs))

    interaction.edit_original_response = edit_original_response
    return interaction


def walk(view):
    out = []

    def rec(item):
        out.append(item)
        for child in getattr(item, "children", []) or []:
            rec(child)

    for top in view.children:
        rec(top)
    return out


def payload_data(kwargs):
    """編集 kwargs を discord.py の実ペイロードビルダに通した data 部。"""
    params = interaction_message_response_params(
        type=7,
        content=kwargs.get("content", MISSING),
        embed=kwargs.get("embed", MISSING),
        embeds=kwargs.get("embeds", MISSING),
        view=kwargs.get("view", MISSING),
        attachments=kwargs.get("attachments", MISSING),
    )
    return params.payload["data"]


def rendered_text(wrapper):
    return "\n".join(
        item.content for item in walk(wrapper)
        if isinstance(item, discord.ui.TextDisplay)
    )


class TranslationPanelV2Test(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.settings = {"enabled": False, "source_locale": "auto", "target_locale": "ja"}
        settings_patch = mock.patch.object(
            settings_mod, "translation_settings", return_value=dict(self.settings))
        update_patch = mock.patch(
            "core.general.translation.translation_settings_update",
            new=mock.AsyncMock())
        self.addCleanup(settings_patch.stop)
        self.addCleanup(update_patch.stop)
        self.settings_mock = settings_patch.start()
        self.update_mock = update_patch.start()
        # 本番の送信経路 (core/general/entry.py) と同じく V2 で包む。
        self.view = TranslationView(42, 999)
        self.wrapper = as_panel_v2(self.view)
        items = walk(self.wrapper)
        self.source_select = next(
            i for i in items if isinstance(i, TranslationLocaleSelect) and i.source)
        self.target_select = next(
            i for i in items if isinstance(i, TranslationLocaleSelect) and not i.source)
        self.toggle = next(
            i for i in items if isinstance(i, TranslationToggleButton))

    def assert_edit_is_v2_clean(self, interaction, message_flags):
        """編集ペイロードに「空でない embeds + V2 フラグ」が同居しないこと。"""
        self.assertEqual(len(interaction.response.calls), 1)
        _name, kwargs = interaction.response.calls[0]
        data = payload_data(kwargs)
        effective_flags = data.get("flags", message_flags)  # 省略時は既存フラグ維持
        self.assertFalse(
            bool(data.get("embeds")) and bool(effective_flags & V2_FLAG),
            f"embeds と IS_COMPONENTS_V2 が同居しています: {data!r}")
        return kwargs

    async def test_panel_is_sent_as_components_v2(self):
        data = payload_data({"view": self.wrapper})
        self.assertTrue(data["flags"] & V2_FLAG)

    async def test_target_locale_select_edit_is_v2_clean(self):
        send_flags = payload_data({"view": self.wrapper})["flags"]
        interaction = make_interaction()
        self.target_select._values = ["en"]
        await self.target_select.callback(interaction)

        self.update_mock.assert_awaited_once_with(42, target_locale="en")
        kwargs = self.assert_edit_is_v2_clean(interaction, send_flags)
        edited = kwargs["view"]
        self.assertIsInstance(edited, discord.ui.LayoutView)
        # 再描画後の表示が新しい言語に追随していること。
        self.assertIn("翻訳後: **English**", rendered_text(edited))
        select = next(
            i for i in walk(edited)
            if isinstance(i, TranslationLocaleSelect) and not i.source)
        default = next(o for o in select.options if o.default)
        self.assertEqual(default.value, "en")

    async def test_source_locale_select_edit_is_v2_clean(self):
        send_flags = payload_data({"view": self.wrapper})["flags"]
        interaction = make_interaction()
        self.source_select._values = ["ja"]
        await self.source_select.callback(interaction)

        self.update_mock.assert_awaited_once_with(42, source_locale="ja")
        kwargs = self.assert_edit_is_v2_clean(interaction, send_flags)
        self.assertIn("翻訳前: **日本語**", rendered_text(kwargs["view"]))

    async def test_toggle_edit_is_v2_clean(self):
        send_flags = payload_data({"view": self.wrapper})["flags"]
        interaction = make_interaction()
        await self.toggle.callback(interaction)

        self.update_mock.assert_awaited_once_with(42, enabled=True)
        kwargs = self.assert_edit_is_v2_clean(interaction, send_flags)
        self.assertIn("状態: **オン**", rendered_text(kwargs["view"]))


if __name__ == "__main__":
    unittest.main()
