# -*- coding: utf-8 -*-
"""チケット（core/support/ticket/cog.py）の中核ロジックのテスト（監査 #9）。

Discord には接続せず、設定の正規化・権限判定・custom_id の振り分けなど
「壊れると静かにチケットが作れない／権限が漏れる」部分を固定する。
"""
import types
import unittest
from unittest.mock import AsyncMock

import discord

from cogs.support import (
    TICKET_DELETE_OPTIONS,
    TicketCog,
    TicketPanelView,
    TicketRoomView,
    _int_list,
    _ticket_embed,
    get_ticket_settings,
)


class _FakeStore:
    def __init__(self, raw):
        self.raw = raw

    def get(self, guild_id, section):
        return self.raw


def _settings(raw):
    return get_ticket_settings(_FakeStore(raw), 123)


class IntListTests(unittest.TestCase):
    def test_non_list_returns_empty(self):
        self.assertEqual(_int_list(None), [])
        self.assertEqual(_int_list("123"), [])
        self.assertEqual(_int_list(5), [])

    def test_filters_invalid_and_dedupes(self):
        self.assertEqual(
            _int_list([3, 1, 3, 0, -2, True, "5", 2.5, 7]),
            [3, 1, 7],
        )

    def test_limit(self):
        self.assertEqual(_int_list(list(range(1, 40)), limit=25), list(range(1, 26)))


class GetTicketSettingsTests(unittest.TestCase):
    def test_defaults_when_empty(self):
        s = _settings({})
        self.assertFalse(s["enabled"])
        self.assertIsNone(s["panel_channel_id"])
        self.assertIsNone(s["category_id"])
        self.assertEqual(s["mode"], "thread")
        self.assertEqual(s["delete_after"], 0)
        self.assertFalse(s["user_manage"])
        self.assertEqual(s["viewer_role_ids"], [])

    def test_non_dict_raw_falls_back_to_defaults(self):
        s = _settings("garbage")
        self.assertEqual(s["mode"], "thread")
        self.assertFalse(s["enabled"])

    def test_invalid_mode_falls_back_to_thread(self):
        self.assertEqual(_settings({"mode": "bogus"})["mode"], "thread")
        self.assertEqual(_settings({"mode": "channel"})["mode"], "channel")

    def test_invalid_ids_become_none(self):
        s = _settings({"panel_channel_id": -5, "category_id": "abc"})
        self.assertIsNone(s["panel_channel_id"])
        self.assertIsNone(s["category_id"])
        s = _settings({"panel_channel_id": True, "category_id": 42})
        self.assertIsNone(s["panel_channel_id"])
        self.assertEqual(s["category_id"], 42)

    def test_delete_after_must_be_a_known_option(self):
        self.assertEqual(_settings({"delete_after": 12345})["delete_after"], 0)
        for opt in TICKET_DELETE_OPTIONS:
            self.assertEqual(_settings({"delete_after": opt})["delete_after"], opt)

    def test_panel_message_id_must_be_int(self):
        self.assertIsNone(_settings({"panel_message_id": "999"})["panel_message_id"])
        self.assertEqual(_settings({"panel_message_id": 999})["panel_message_id"], 999)


class TicketEmbedTests(unittest.TestCase):
    def test_thread_mode_hides_category(self):
        s = _settings({"mode": "thread", "category_id": 555})
        desc = _ticket_embed(s).description
        self.assertIn("プライベートスレッド", desc)
        self.assertIn("チャンネルカテゴリ: 不要", desc)

    def test_channel_mode_shows_category_and_delete_label(self):
        s = _settings({"mode": "channel", "category_id": 555, "delete_after": 86400, "enabled": True})
        desc = _ticket_embed(s).description
        self.assertIn("専用チャンネル", desc)
        self.assertIn("<#555>", desc)
        self.assertIn("自動削除: **1日**", desc)
        self.assertIn("状態: **オン**", desc)

    def test_notice_is_prepended(self):
        s = _settings({})
        self.assertTrue(_ticket_embed(s, "更新しました").description.startswith("更新しました"))


class RoomOwnerTests(unittest.IsolatedAsyncioTestCase):
    def _cog(self):
        return TicketCog.__new__(TicketCog)

    async def test_owner_parsed_from_topic(self):
        room = types.SimpleNamespace(topic="support-ticket-owner:424242")
        self.assertEqual(await self._cog()._room_owner_id(room), 424242)

    async def test_unrelated_topic_returns_none(self):
        self.assertIsNone(await self._cog()._room_owner_id(types.SimpleNamespace(topic="hello")))
        self.assertIsNone(await self._cog()._room_owner_id(types.SimpleNamespace(topic="support-ticket-owner:abc")))
        self.assertIsNone(await self._cog()._room_owner_id(types.SimpleNamespace(topic=None)))


class CanOperateTests(unittest.IsolatedAsyncioTestCase):
    def _cog(self):
        return TicketCog.__new__(TicketCog)

    def _interaction(self, user_id=1, role_ids=(), admin=False, manage=False):
        perms = types.SimpleNamespace(administrator=admin, manage_guild=manage)
        user = types.SimpleNamespace(
            id=user_id,
            guild_permissions=perms,
            roles=[types.SimpleNamespace(id=r) for r in role_ids],
        )
        return types.SimpleNamespace(user=user)

    def _settings(self, **overrides):
        base = {
            "operator_role_ids": [10],
            "operator_user_ids": [99],
            "user_manage": False,
        }
        base.update(overrides)
        return base

    def _room(self, topic="support-ticket-owner:7"):
        return types.SimpleNamespace(topic=topic)

    async def test_admin_always_allowed(self):
        ok = await self._cog()._can_operate(self._interaction(admin=True), self._room(), self._settings())
        self.assertTrue(ok)

    async def test_operator_role_and_user_allowed(self):
        cog = self._cog()
        self.assertTrue(await cog._can_operate(self._interaction(role_ids=[10]), self._room(), self._settings()))
        self.assertTrue(await cog._can_operate(self._interaction(user_id=99), self._room(), self._settings()))

    async def test_stranger_denied(self):
        ok = await self._cog()._can_operate(self._interaction(user_id=5), self._room(), self._settings())
        self.assertFalse(ok)

    async def test_owner_allowed_only_when_user_manage_on(self):
        cog = self._cog()
        interaction = self._interaction(user_id=7)
        self.assertFalse(await cog._can_operate(interaction, self._room(), self._settings(user_manage=False)))
        self.assertTrue(await cog._can_operate(interaction, self._room(), self._settings(user_manage=True)))


class ViewShapeTests(unittest.TestCase):
    def test_panel_view_has_create_button(self):
        view = TicketPanelView()
        ids = [child.custom_id for child in view.children]
        self.assertEqual(ids, ["support_ticket:create"])

    def test_room_view_open_and_closed(self):
        open_ids = [child.custom_id for child in TicketRoomView(42).children]
        self.assertEqual(open_ids, ["support_ticket:close:42", "support_ticket:delete:42"])
        closed_ids = [child.custom_id for child in TicketRoomView(42, closed=True).children]
        self.assertEqual(closed_ids, ["support_ticket:reopen:42", "support_ticket:delete:42"])


class InteractionDispatchTests(unittest.IsolatedAsyncioTestCase):
    def _cog(self):
        cog = TicketCog.__new__(TicketCog)
        cog.create_ticket = AsyncMock()
        cog.close_room = AsyncMock()
        cog.reopen_room = AsyncMock()
        cog.delete_room = AsyncMock()
        cog.handle_advanced = AsyncMock()
        return cog

    def _interaction(self, custom_id, itype=discord.InteractionType.component):
        return types.SimpleNamespace(type=itype, data={"custom_id": custom_id})

    async def test_create_dispatch(self):
        cog = self._cog()
        await cog.on_interaction(self._interaction("support_ticket:create"))
        cog.create_ticket.assert_awaited_once()

    async def test_room_action_dispatch(self):
        cog = self._cog()
        interaction = self._interaction("support_ticket:close:123")
        await cog.on_interaction(interaction)
        cog.close_room.assert_awaited_once_with(interaction, 123)

    async def test_malformed_room_id_ignored(self):
        cog = self._cog()
        await cog.on_interaction(self._interaction("support_ticket:close:abc"))
        cog.close_room.assert_not_awaited()
        cog.delete_room.assert_not_awaited()

    async def test_advanced_dispatch(self):
        cog = self._cog()
        interaction = self._interaction("ticket_adv:back")
        await cog.on_interaction(interaction)
        cog.handle_advanced.assert_awaited_once_with(interaction, "back")

    async def test_non_component_ignored(self):
        cog = self._cog()
        await cog.on_interaction(self._interaction("support_ticket:create", discord.InteractionType.application_command))
        cog.create_ticket.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
