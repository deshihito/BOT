# -*- coding: utf-8 -*-
"""グローバルVCの追加機能（参加者数・グロチャ自動接続・メンバー確認）のテスト。

Discord には接続しない。対象:
- rooms.py: text_chat の永続化、_room_members / _room_user_count
- chat.py: _auto_link_text_chat（VC参加に連動するグロチャ自動接続）
- ui.py: _TextChatToggleView（作成直後の ON/OFF 切り替え）
- manage.py: _members_impl（参加者全員の画像表示）
"""

import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import AsyncMock

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

for _name, _value in {'BOT_API_BASE_URL': 'http://127.0.0.1:8787', 'BOT_API_KEY': 'dummy-key'}.items():
    os.environ.setdefault(_name, _value)

from core.vc import voice_restore  # noqa: E402
from core.vc.globalvc import rooms as rooms_mod  # noqa: E402
from core.vc.globalvc import textlink as textlink_mod  # noqa: E402
from core.vc.globalvc.chat import ChatMixin  # noqa: E402
from core.vc.globalvc.rooms import RoomConfig  # noqa: E402
from core.vc.globalvc.ui import _TextChatToggleView  # noqa: E402


def fake_member(user_id, name="user", bot=False):
    return types.SimpleNamespace(id=user_id, display_name=name, name=name, bot=bot)


def fake_client(guild_id, guild_name, members):
    return types.SimpleNamespace(
        guild=types.SimpleNamespace(id=guild_id, name=guild_name),
        channel=types.SimpleNamespace(members=members))


class RoomStateTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = voice_restore.reset_store(Path(self.tmp.name) / "voice_restore.json")
        self._rooms = dict(rooms_mod.ROOMS)
        self._global = dict(rooms_mod.GLOBAL_ROOMS)
        self._links = dict(textlink_mod.ROOM_TEXT_LINKS)
        self._chan = dict(textlink_mod.CHANNEL_TO_ROOM)
        rooms_mod.ROOMS.clear()
        rooms_mod.GLOBAL_ROOMS.clear()
        textlink_mod.ROOM_TEXT_LINKS.clear()
        textlink_mod.CHANNEL_TO_ROOM.clear()

    def tearDown(self):
        rooms_mod.ROOMS.clear()
        rooms_mod.ROOMS.update(self._rooms)
        rooms_mod.GLOBAL_ROOMS.clear()
        rooms_mod.GLOBAL_ROOMS.update(self._global)
        textlink_mod.ROOM_TEXT_LINKS.clear()
        textlink_mod.ROOM_TEXT_LINKS.update(self._links)
        textlink_mod.CHANNEL_TO_ROOM.clear()
        textlink_mod.CHANNEL_TO_ROOM.update(self._chan)
        self.tmp.cleanup()


class TextChatPersistenceTest(RoomStateTestCase):
    def test_round_trip(self):
        rooms_mod.ROOMS["r"] = RoomConfig(
            name="r", owner_id=1, owner_guild_id=10, text_chat=True)
        rooms_mod._persist_rooms()
        rooms_mod.ROOMS.clear()
        rooms_mod._load_rooms()
        self.assertTrue(rooms_mod.ROOMS["r"].text_chat)

    def test_old_format_defaults_off(self):
        room = rooms_mod._room_from_dict({"name": "old", "owner_id": 1, "owner_guild_id": 10})
        self.assertFalse(room.text_chat)


class RoomMembersTest(RoomStateTestCase):
    def test_counts_humans_across_guilds_deduped(self):
        rooms_mod.GLOBAL_ROOMS["r"] = [
            fake_client(10, "A", [fake_member(1), fake_member(2), fake_member(9, bot=True)]),
            fake_client(20, "B", [fake_member(2), fake_member(3)]),  # user 2 は重複
        ]
        members = rooms_mod._room_members("r")
        self.assertEqual([m.id for m, _g in members], [1, 2, 3])
        self.assertEqual(rooms_mod._room_user_count("r"), 3)
        self.assertEqual(rooms_mod._room_user_count("missing"), 0)


class FakeChannel:
    def __init__(self, channel_id, allow_webhook=True):
        self.id = channel_id
        self.allow_webhook = allow_webhook
        self.sent = []
        self.webhook = types.SimpleNamespace(id=777, url="https://example.invalid/wh")

    def permissions_for(self, me):
        return types.SimpleNamespace(manage_webhooks=self.allow_webhook)

    async def create_webhook(self, name=None, reason=None):
        return self.webhook

    async def send(self, content=None, **kwargs):
        self.sent.append(content)


class AutoLinkTest(RoomStateTestCase, unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        RoomStateTestCase.setUp(self)
        self.addCleanup(self.tmp.cleanup)
        self.mixin = ChatMixin()
        self.room = RoomConfig(name="r", owner_id=1, owner_guild_id=10, text_chat=True)
        self.guild = types.SimpleNamespace(id=10, me=types.SimpleNamespace())

    async def test_links_channel_and_notifies(self):
        channel = FakeChannel(555)
        ok = await self.mixin._auto_link_text_chat(self.guild, channel, self.room)
        self.assertTrue(ok)
        self.assertEqual(textlink_mod.CHANNEL_TO_ROOM[555], "r")
        self.assertEqual(len(textlink_mod.ROOM_TEXT_LINKS["r"]), 1)
        self.assertTrue(channel.sent)  # 接続した旨の通知が送られる

    async def test_skips_when_channel_already_linked(self):
        textlink_mod.CHANNEL_TO_ROOM[555] = "other"
        ok = await self.mixin._auto_link_text_chat(self.guild, FakeChannel(555), self.room)
        self.assertFalse(ok)

    async def test_skips_without_webhook_permission(self):
        ok = await self.mixin._auto_link_text_chat(
            self.guild, FakeChannel(555, allow_webhook=False), self.room)
        self.assertFalse(ok)
        self.assertNotIn(555, textlink_mod.CHANNEL_TO_ROOM)


class FakeResponder:
    def __init__(self, guild_id=10, user_id=1):
        self.user = types.SimpleNamespace(id=user_id, voice=None)
        self.guild = types.SimpleNamespace(id=guild_id)
        self.channel = None
        self.sent = []

    async def defer(self):
        pass

    async def send(self, content=None, **kwargs):
        self.sent.append((content, kwargs))


class MembersImplTest(RoomStateTestCase, unittest.IsolatedAsyncioTestCase):
    def make_cog(self):
        from core.vc.globalvc.entry import GlobalVCCog

        cog = GlobalVCCog.__new__(GlobalVCCog)
        cog.bot = types.SimpleNamespace()
        return cog

    async def test_renders_member_image(self):
        rooms_mod.GLOBAL_ROOMS["r"] = [
            fake_client(10, "A", [fake_member(1, "alice"), fake_member(2, "bob")]),
            fake_client(20, "B", [fake_member(3, "carol")]),
        ]
        r = FakeResponder(guild_id=10)
        await self.make_cog()._members_impl(r)
        content, kwargs = r.sent[-1]
        self.assertIn("file", kwargs)
        self.assertEqual(kwargs["file"].filename, "gvc_members.png")
        self.assertIn("3人", kwargs["embed"].title)
        self.assertEqual(kwargs["embed"].image.url, "attachment://gvc_members.png")

    async def test_not_joined_guild_gets_error(self):
        r = FakeResponder(guild_id=99)
        await self.make_cog()._members_impl(r)
        content, kwargs = r.sent[-1]
        self.assertNotIn("file", kwargs)
        self.assertIn("参加していません", content)


class ToggleViewTest(RoomStateTestCase, unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        RoomStateTestCase.setUp(self)
        self.addCleanup(self.tmp.cleanup)
        rooms_mod.ROOMS["r"] = RoomConfig(name="r", owner_id=1, owner_guild_id=10)
        self.view = _TextChatToggleView(types.SimpleNamespace(), "r", user_id=42)

    def make_interaction(self, user_id):
        return types.SimpleNamespace(
            user=types.SimpleNamespace(id=user_id),
            guild=None, channel=None,
            response=types.SimpleNamespace(
                send_message=AsyncMock(), edit_message=AsyncMock()))

    async def test_creator_toggles_on_and_off(self):
        interaction = self.make_interaction(42)
        await self.view._toggle(interaction)
        self.assertTrue(rooms_mod.ROOMS["r"].text_chat)
        self.assertIn("ON", self.view.button.label)
        await self.view._toggle(interaction)
        self.assertFalse(rooms_mod.ROOMS["r"].text_chat)

    async def test_other_user_cannot_toggle(self):
        interaction = self.make_interaction(7)
        await self.view._toggle(interaction)
        self.assertFalse(rooms_mod.ROOMS["r"].text_chat)
        interaction.response.send_message.assert_awaited()


class MembersWiringTest(unittest.TestCase):
    def test_members_action_registered(self):
        from core.general.action_registry import build_vc_actions
        from core.vc.common import GVC_ROOM_ACTIONS, VOICE_ACTIONS_BY_GENRE

        genre_values = [v for _l, v in VOICE_ACTIONS_BY_GENRE["gvc_rooms"]]
        self.assertIn("gvc_members", genre_values)
        self.assertIn("gvc_members", GVC_ROOM_ACTIONS)
        self.assertIn("gvc_members", {s.value for s in build_vc_actions()})


if __name__ == "__main__":
    unittest.main()
