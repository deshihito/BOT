# -*- coding: utf-8 -*-
"""チケット高度化（種別振分・アサイン・トランスクリプト）のテスト。"""
import types
import unittest
from datetime import datetime, timezone
from unittest.mock import AsyncMock

import discord

from cogs.support import (
    TicketCog,
    TicketPanelView,
    TicketRoomView,
    build_transcript,
    format_ticket_types,
    get_ticket_settings,
    parse_ticket_types,
)


class _FakeStore:
    def __init__(self, raw):
        self.raw = raw

    def get(self, guild_id, section):
        return self.raw


def _settings(raw):
    return get_ticket_settings(_FakeStore(raw), 123)


class TicketTypesTests(unittest.TestCase):
    def test_parse_lines(self):
        parsed = parse_ticket_types("質問 | 555 | 10,20\n不具合報告\n質問 | 777")
        self.assertEqual([item["name"] for item in parsed], ["質問", "不具合報告"])
        self.assertEqual(parsed[0]["category_id"], 555)
        self.assertEqual(parsed[0]["operator_role_ids"], [10, 20])
        self.assertIsNone(parsed[1]["category_id"])
        self.assertTrue(all(item["id"] for item in parsed))

    def test_parse_empty(self):
        self.assertEqual(parse_ticket_types(""), [])
        self.assertEqual(parse_ticket_types("\n  \n"), [])

    def test_format_roundtrip_names(self):
        parsed = parse_ticket_types("質問 | 555 | 10,20")
        text = format_ticket_types(parsed)
        self.assertIn("質問", text)
        self.assertIn("555", text)
        self.assertIn("10,20", text)

    def test_settings_normalizes_types_and_caps(self):
        raw = {"types": [
            {"id": "a", "name": "質問", "category_id": 5, "operator_role_ids": [1, "x", 2]},
            {"id": "b", "name": "質問", "category_id": None, "operator_role_ids": []},
            {"id": "c", "name": "", "category_id": None, "operator_role_ids": []},
        ]}
        types_list = _settings(raw)["types"]
        self.assertEqual(len(types_list), 1)
        self.assertEqual(types_list[0]["operator_role_ids"], [1, 2])

    def test_settings_transcript_and_assignments(self):
        s = _settings({
            "transcript_channel_id": 42,
            "assignments": {"100": 7, "bad": 8, "101": "x", "102": -1},
        })
        self.assertEqual(s["transcript_channel_id"], 42)
        self.assertEqual(s["assignments"], {"100": 7})
        self.assertIsNone(_settings({"transcript_channel_id": -3})["transcript_channel_id"])
        self.assertEqual(_settings({})["assignments"], {})


class TranscriptTests(unittest.TestCase):
    def _message(self, name, content, attachments=()):
        return types.SimpleNamespace(
            created_at=datetime(2026, 10, 30, 11, 0, tzinfo=timezone.utc),
            author=types.SimpleNamespace(display_name=name, name=name, id=1),
            content=content,
            attachments=[types.SimpleNamespace(url=url) for url in attachments],
        )

    def test_build_transcript_lines(self):
        text = build_transcript([
            self._message("あおい", "助けてください"),
            self._message("運営", "確認します", ["https://example.com/a.png"]),
        ], 12345)
        self.assertIn("チケット 12345", text)
        self.assertIn("[2026-10-30 11:00 UTC] あおい: 助けてください", text)
        self.assertIn("[添付: https://example.com/a.png]", text)


class UpgradeViewShapeTests(unittest.TestCase):
    def test_panel_view_with_types(self):
        view = TicketPanelView([{"id": "t1", "name": "質問"}, {"id": "t2", "name": "不具合"}])
        ids = [child.custom_id for child in view.children]
        self.assertEqual(ids, ["support_ticket:create_type:t1", "support_ticket:create_type:t2"])

    def test_room_view_assignable(self):
        ids = [child.custom_id for child in TicketRoomView(42, assignable=True).children]
        self.assertEqual(
            ids,
            ["support_ticket:close:42", "support_ticket:assign:42", "support_ticket:delete:42"],
        )
        closed_ids = [child.custom_id for child in TicketRoomView(42, closed=True, assignable=True).children]
        self.assertNotIn("support_ticket:assign:42", closed_ids)


class UpgradeDispatchTests(unittest.IsolatedAsyncioTestCase):
    def _cog(self):
        cog = TicketCog.__new__(TicketCog)
        cog.create_ticket = AsyncMock()
        cog.assign_room = AsyncMock()
        cog.close_room = AsyncMock()
        cog.reopen_room = AsyncMock()
        cog.delete_room = AsyncMock()
        cog.handle_advanced = AsyncMock()
        return cog

    def _interaction(self, custom_id):
        return types.SimpleNamespace(
            type=discord.InteractionType.component, data={"custom_id": custom_id})

    async def test_create_type_dispatch(self):
        cog = self._cog()
        interaction = self._interaction("support_ticket:create_type:abc123")
        await cog.on_interaction(interaction)
        cog.create_ticket.assert_awaited_once_with(interaction, "abc123")

    async def test_assign_dispatch(self):
        cog = self._cog()
        interaction = self._interaction("support_ticket:assign:123")
        await cog.on_interaction(interaction)
        cog.assign_room.assert_awaited_once_with(interaction, 123)


if __name__ == "__main__":
    unittest.main()
